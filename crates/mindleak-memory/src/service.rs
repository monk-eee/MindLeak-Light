#[path = "knowledge.rs"]
mod knowledge;
pub use knowledge::{
    CompactCounterevidence, CompactKnowledge, CompactKnowledgeResponse, CompactObservation,
    CompactSupport, KnowledgeExport, KnowledgeExportFormat, KnowledgeMatch, KnowledgeQuery,
    KnowledgeReview, KnowledgeReviewPage, KnowledgeSearchOptions, KnowledgeSearchResponse,
    KnowledgeView, KnowledgeViewResponse, MAX_COMPACT_KNOWLEDGE_BYTES,
};

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::Result;
use uuid::Uuid;

use crate::{
    normalize_fragments, validate_embeddings, validate_text, ChainFilter, ChainInspection,
    ChainSearchResponse, ChainState, ChainWriteRequest, ChainWriteResult, DomainInspection,
    DomainQuery, EmbeddedFragment, FormationContext, FormationInput, FormationPreview,
    FragmentInspection, InvalidInput, KeywordMatchMode, KnowledgeFormer, KnowledgeKind,
    MemoryDecomposer, MemoryRetriever, MemoryStore, MemoryTier, PreparedChain, PreparedMemory,
    PreparedRelationship, RecallFilter, RecallMatch, RecallResponse, RelationshipCursor,
    TextEmbedder, WriteMemoryResult, WriteOptions, WriteRequest, MAX_CHAIN_RESULTS, MAX_FACT_LINKS,
    MAX_FRAGMENTS, MAX_FRAGMENT_BYTES, MAX_MEMORY_BYTES, MAX_MEMORY_LINKS, MAX_RECALL_LIMIT,
    MAX_RECALL_RESULT_BYTES,
};

#[derive(Clone)]
pub struct MemoryService {
    store: Arc<dyn MemoryStore>,
    decomposer: Arc<dyn MemoryDecomposer>,
    embedder: Option<Arc<dyn TextEmbedder>>,
    retriever: Arc<dyn MemoryRetriever>,
    former: Option<Arc<dyn KnowledgeFormer>>,
}

impl MemoryService {
    pub fn new(
        store: Arc<dyn MemoryStore>,
        decomposer: Arc<dyn MemoryDecomposer>,
        embedder: Option<Arc<dyn TextEmbedder>>,
        retriever: Arc<dyn MemoryRetriever>,
    ) -> Self {
        Self {
            store,
            decomposer,
            embedder,
            retriever,
            former: None,
        }
    }

    pub fn with_knowledge_former(mut self, former: Arc<dyn KnowledgeFormer>) -> Self {
        self.former = Some(former);
        self
    }

    pub async fn form_knowledge(
        &self,
        question: &str,
        input: FormationInput,
    ) -> Result<FormationPreview> {
        validate_text(question, "text", MAX_MEMORY_BYTES)?;
        input.validate()?;
        let former = self.former.as_ref().ok_or_else(|| InvalidInput(
            "model-assisted formation is disabled; configure MINDLEAK_FORMATION=openai, or author an explicit chain document".into()))?;
        let filter = RecallFilter {
            agent_id: input.agent_id.clone(),
            scope: input.scope.clone(),
            include_inactive: true,
            ..Default::default()
        };
        let chain_filter = ChainFilter {
            agent_id: input.agent_id.clone(),
            scope: input.scope.clone(),
            ..Default::default()
        };
        let mut sources = FormationContext {
            kind: input.kind,
            question: question.to_owned(),
            observations: vec![],
            chains: vec![],
        };
        for fragment_id in &input.fragment_ids {
            sources.observations.push(
                self.inspect_fragment(*fragment_id, &filter, None, 1)
                    .await?,
            );
        }
        for source in &input.chains {
            let inspected = self
                .inspect_chain(
                    source.chain_id,
                    Some(source.revision),
                    None,
                    &chain_filter,
                    1,
                )
                .await?;
            if inspected.chain.snapshot.document.kind != KnowledgeKind::Chain
                || !inspected.chain.current
                || inspected.chain.snapshot.state != ChainState::Accepted
                || inspected.requires_review
                || inspected.evidence_details_truncated
            {
                return Err(InvalidInput(
                    "formation requires current accepted chains with complete available evidence"
                        .into(),
                )
                .into());
            }
            sources.chains.push(inspected);
        }
        let scopes: HashSet<_> = sources
            .observations
            .iter()
            .map(|source| &source.context.scope)
            .chain(
                sources
                    .chains
                    .iter()
                    .map(|source| &source.chain.context.scope),
            )
            .collect();
        if scopes.len() > 1 {
            return Err(InvalidInput(
                "formation sources must share the same optional scope".into(),
            )
            .into());
        }
        sources.validate()?;
        let mut proposal = former.form(&sources).await?;
        proposal.validate(&sources)?;
        for document in &mut proposal.documents {
            document.formation = Some(crate::FormationProvenance {
                model: former.model().to_owned(),
                prompt_version: 1,
                source_fragment_ids: input.fragment_ids.clone(),
                source_chains: input.chains.clone(),
            });
            document.validate()?;
        }
        let preview = FormationPreview {
            kind:"formation", status:"candidate", model:former.model().to_owned(),
            validation:"structure, source identities and exact citations checked; conclusions require explicit validation and acceptance",
            proposal, source_fragment_ids:input.fragment_ids, source_chains:input.chains,
        };
        if serde_json::to_vec(&preview)?.len() > MAX_RECALL_RESULT_BYTES {
            return Err(InvalidInput("formation exceeds the response budget".into()).into());
        }
        Ok(preview)
    }

    pub async fn write_memory(
        &self,
        agent_id: &str,
        text: &str,
        options: WriteOptions,
    ) -> Result<WriteMemoryResult> {
        validate_text(agent_id, "agentId", 256)?;
        validate_text(text, "text", MAX_MEMORY_BYTES)?;
        options.context.validate()?;
        if let Some(domain) = &options.domain {
            domain.validate()?;
            if options.request_id.is_none() || !options.facts.is_empty() {
                return Err(InvalidInput(
                    "domain writes require requestId and cannot include lifecycle fact directives"
                        .into(),
                )
                .into());
            }
        }
        if options.facts.len() > MAX_FRAGMENTS {
            return Err(InvalidInput("too many fact directives".into()).into());
        }
        let mut directive_texts = HashSet::new();
        let mut link_count = 0;
        for directive in &options.facts {
            validate_text(&directive.text, "fact text", MAX_FRAGMENT_BYTES)?;
            if !directive_texts.insert(&directive.text) {
                return Err(InvalidInput(
                    "fact directives must match distinct decomposed fragment text exactly".into(),
                )
                .into());
            }
            let importance = directive.importance.unwrap_or(0.5);
            if !importance.is_finite() || !(0.0..=1.0).contains(&importance) {
                return Err(
                    InvalidInput("fact importance must be finite and in 0..=1".into()).into(),
                );
            }
            link_count += directive.links.len();
            if directive.links.len() > MAX_FACT_LINKS || link_count > MAX_MEMORY_LINKS {
                return Err(InvalidInput("too many fact relationships".into()).into());
            }
            let mut targets = HashSet::new();
            for link in &directive.links {
                if !targets.insert(link.target_fragment_id) {
                    return Err(InvalidInput(
                        "a fact can declare only one relationship to each target per write".into(),
                    )
                    .into());
                }
                if link.relationship_type.is_feedback() && options.context.session_id.is_none() {
                    return Err(InvalidInput(
                        "reinforces and confirms require context.sessionId".into(),
                    )
                    .into());
                }
            }
        }
        let request = options.request_id.map(|request_id| WriteRequest {
            request_id,
            agent_id: agent_id.to_owned(),
            text: text.to_owned(),
            context: options.context.clone(),
            facts: options.facts.clone(),
            domain: options.domain.clone(),
        });
        if let Some(request) = &request {
            if let Some(result) = self.store.lookup_write(request).await? {
                return Ok(result);
            }
        }
        let fragments = self.decompose_memory(text).await?;
        let mut policies = HashMap::new();
        for (index, directive) in options.facts.into_iter().enumerate() {
            if !fragments.contains(&directive.text) {
                return Err(InvalidInput(format!(
                    "facts[{index}].text must match a decomposed fragment exactly"
                ))
                .into());
            }
            policies.insert(directive.text.clone(), directive);
        }
        let embeddings = self.embed_fragments(&fragments).await?;
        let mut relationships = Vec::new();
        let memory = PreparedMemory {
            id: Uuid::new_v4(),
            agent_id: agent_id.to_owned(),
            raw_text: text.to_owned(),
            context: options.context,
            fragments: fragments
                .into_iter()
                .zip(embeddings)
                .map(|(text, embedding)| {
                    let id = Uuid::new_v4();
                    let policy = policies.remove(&text).unwrap_or_default();
                    for link in policy.links {
                        relationships.push(PreparedRelationship {
                            source_fragment: id,
                            target_fragment: link.target_fragment_id,
                            relationship_type: link.relationship_type,
                        });
                    }
                    EmbeddedFragment {
                        id,
                        text,
                        embedding,
                        importance: policy.importance.unwrap_or(0.5),
                        tier: if policy.pinned {
                            MemoryTier::LongTerm
                        } else {
                            policy.tier
                        },
                        pinned: policy.pinned,
                    }
                })
                .collect(),
            relationships,
            request,
        };
        self.store.save(&memory).await
    }

    async fn embed_fragments(&self, fragments: &[String]) -> Result<Vec<Option<Vec<f32>>>> {
        if let Some(embedder) = &self.embedder {
            let embeddings = embedder.embed_batch(fragments).await?;
            validate_embeddings(&embeddings, fragments.len(), embedder.dimensions())?;
            Ok(embeddings.into_iter().map(Some).collect())
        } else {
            Ok(vec![None; fragments.len()])
        }
    }

    pub async fn write_chain(&self, request: ChainWriteRequest) -> Result<ChainWriteResult> {
        validate_text(&request.agent_id, "agentId", 256)?;
        validate_text(&request.text, "text", MAX_MEMORY_BYTES)?;
        request.context.validate()?;
        request.chain.validate()?;
        if request.request_id.is_nil()
            || request.context.session_id.is_none()
            || request.context.source.is_none()
        {
            return Err(InvalidInput(
                "chain writes require a non-nil requestId, context.sessionId and context.source"
                    .into(),
            )
            .into());
        }
        if let Some(result) = self.store.lookup_chain_write(&request).await? {
            return Ok(result);
        }
        let embedding = if self.embedder.is_some() {
            let document = match &request.chain {
                crate::ChainCommand::Propose { document, .. }
                | crate::ChainCommand::Revise { document, .. } => document.clone(),
                command => {
                    let previous = self
                        .inspect_chain(
                            command.chain_id(),
                            None,
                            None,
                            &ChainFilter {
                                scope: request.context.scope.clone(),
                                include_inactive: true,
                                ..Default::default()
                            },
                            1,
                        )
                        .await?;
                    if command.expected_revision() != Some(previous.chain.revision) {
                        return Err(InvalidInput(
                            "chain revision changed; inspect the current revision before retrying"
                                .into(),
                        )
                        .into());
                    }
                    command.apply(Some(&previous.chain.snapshot))?.document
                }
            };
            self.embed_fragments(&[document.search_text()])
                .await?
                .pop()
                .flatten()
        } else {
            None
        };
        let fragments = self.decompose_memory(&request.text).await?;
        let embeddings = self.embed_fragments(&fragments).await?;
        let memory = PreparedMemory {
            id: Uuid::new_v4(),
            agent_id: request.agent_id.clone(),
            raw_text: request.text.clone(),
            context: request.context.clone(),
            fragments: fragments
                .into_iter()
                .zip(embeddings)
                .map(|(text, embedding)| EmbeddedFragment {
                    id: Uuid::new_v4(),
                    text,
                    embedding,
                    importance: 0.5,
                    tier: MemoryTier::ShortTerm,
                    pinned: false,
                })
                .collect(),
            relationships: Vec::new(),
            request: None,
        };
        self.store
            .save_chain(&PreparedChain {
                request,
                memory,
                embedding,
            })
            .await
    }

    pub async fn inspect_chain(
        &self,
        chain_id: Uuid,
        revision: Option<u32>,
        after_revision: Option<u32>,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<ChainInspection> {
        self.validate_chain_filter(filter, limit)?;
        if chain_id.is_nil()
            || revision.is_some_and(|value| value == 0 || value > i32::MAX as u32)
            || after_revision.is_some_and(|value| value > i32::MAX as u32)
        {
            return Err(InvalidInput("invalid chain identity or revision".into()).into());
        }
        let inspection = self
            .store
            .inspect_chain(chain_id, revision, after_revision, filter, limit)
            .await?
            .ok_or_else(|| InvalidInput("chain not found or excluded by filters".into()))?;
        if serde_json::to_vec(&inspection)?.len() > MAX_RECALL_RESULT_BYTES {
            return Err(InvalidInput(
                "chain inspection exceeds the response budget; lower limit".into(),
            )
            .into());
        }
        Ok(inspection)
    }

    pub async fn recall_chains(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<ChainSearchResponse> {
        self.validate_chain_filter(filter, limit)?;
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        let selected = self.retriever.recall_chains(query, filter, limit).await?;
        let current = self.store.hydrate_knowledge(&selected, filter).await?;
        let results = ChainSearchResponse {
            kind: "chains",
            strategy: self.retriever.chain_strategy(),
            results: current.into_iter().map(|entry| entry.matched).collect(),
        };
        if serde_json::to_vec(&results)?.len() > MAX_RECALL_RESULT_BYTES {
            return Err(InvalidInput(
                "chain results exceed the response budget; lower limit".into(),
            )
            .into());
        }
        Ok(results)
    }

    pub async fn search_chains(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
        diagnostics: bool,
        costs: bool,
    ) -> Result<crate::SearchReport<ChainSearchResponse>> {
        let started = std::time::Instant::now();
        let (response, usage) =
            crate::diagnostics::capture_usage(costs, self.recall_chains(query, filter, limit))
                .await;
        let response = response?;
        let diagnostics = if diagnostics {
            Some(
                self.retriever
                    .query_diagnostics(
                        query,
                        &RecallFilter {
                            match_mode: filter.match_mode,
                            agent_id: filter.agent_id.clone(),
                            scope: filter.scope.clone(),
                            ..Default::default()
                        },
                    )
                    .await?,
            )
        } else {
            None
        };
        crate::SearchReport::finish(
            response,
            diagnostics,
            started.elapsed().as_secs_f64() * 1000.0,
            usage,
            costs,
            self.retriever.capabilities().provider_calls_instrumented,
            MAX_RECALL_RESULT_BYTES,
        )
    }

    fn validate_chain_filter(&self, filter: &ChainFilter, limit: usize) -> Result<()> {
        if !(1..=MAX_CHAIN_RESULTS).contains(&limit) {
            return Err(InvalidInput("chain limit must be in 1..=10".into()).into());
        }
        for (value, field) in [(&filter.agent_id, "agentId"), (&filter.scope, "scope")] {
            if let Some(value) = value {
                validate_text(value, field, 256)?;
            }
        }
        Ok(())
    }

    pub async fn decompose_memory(&self, text: &str) -> Result<Vec<String>> {
        validate_text(text, "text", MAX_MEMORY_BYTES)?;
        normalize_fragments(self.decomposer.decompose(text).await?)
    }

    pub async fn inspect_domain(
        &self,
        query: &DomainQuery,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<DomainInspection> {
        query.validate(filter, limit)?;
        self.store
            .inspect_domain(query, filter, limit)
            .await?
            .ok_or_else(|| {
                InvalidInput("domain record not found in the requested filters".into()).into()
            })
    }

    pub async fn inspect_fragment(
        &self,
        fragment_id: Uuid,
        filter: &RecallFilter,
        after: Option<&RelationshipCursor>,
        limit: usize,
    ) -> Result<FragmentInspection> {
        filter.validate()?;
        if filter.match_mode != KeywordMatchMode::Websearch
            || filter.diagnostics
            || filter.context_limit != 0
            || filter.group_duplicates
        {
            return Err(InvalidInput(
                "matchMode, diagnostics, contextLimit, and groupDuplicates only apply to search"
                    .into(),
            )
            .into());
        }
        if !(1..=MAX_FACT_LINKS).contains(&limit) {
            return Err(InvalidInput("inspection limit must be in 1..=8".into()).into());
        }
        if after.is_some_and(|cursor| cursor.fragment_id != fragment_id) {
            return Err(
                InvalidInput("inspection cursor belongs to another fragment".into()).into(),
            );
        }
        self.store
            .inspect_fragment(fragment_id, filter, after, limit)
            .await?
            .ok_or_else(|| {
                InvalidInput("fragment not found in the requested filters".into()).into()
            })
    }

    pub async fn recall_memory(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<RecallResponse> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        filter.validate()?;
        if !(1..=MAX_RECALL_LIMIT).contains(&limit) {
            return Err(InvalidInput(format!("limit must be in 1..={MAX_RECALL_LIMIT}")).into());
        }
        let mut results = self.retriever.recall(query, filter, limit).await?;
        if filter.group_duplicates {
            results = group_duplicates(results);
        }
        let diagnostics = if filter.diagnostics {
            Some(self.retriever.query_diagnostics(query, filter).await?)
        } else {
            None
        };
        let response = RecallResponse {
            results,
            diagnostics,
        };
        if serde_json::to_vec(&response)?.len() > MAX_RECALL_RESULT_BYTES {
            return Err(InvalidInput(
                "recall exceeds the 512 KiB response budget; lower limit or disable diagnostics"
                    .into(),
            )
            .into());
        }
        Ok(response)
    }
}

fn group_duplicates(facts: Vec<RecallMatch>) -> Vec<RecallMatch> {
    let mut groups: Vec<RecallMatch> = Vec::new();
    let mut by_text = HashMap::new();
    for mut fact in facts {
        if let Some(&index) = by_text.get(&fact.text) {
            let group: &mut RecallMatch = &mut groups[index];
            let duplicates = std::mem::take(&mut fact.duplicate_sources);
            group.duplicate_sources.push(fact.into());
            group.duplicate_sources.extend(duplicates);
            group.source_count = Some(1 + group.duplicate_sources.len());
        } else {
            by_text.insert(fact.text.clone(), groups.len());
            fact.source_count = Some(1 + fact.duplicate_sources.len());
            groups.push(fact);
        }
    }
    groups
}
