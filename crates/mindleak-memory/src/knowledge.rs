use std::{
    collections::{BTreeMap, BTreeSet},
    time::Instant,
};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ChainEvidenceRole, ChainEvidenceView, ChainFilter, ChainInspection, ChainMatch, ChainReview,
    ChainRevision, ChainState, ChainSupportView, EvidenceStatus, FactState, InvalidInput,
    KeywordMatchMode, KnowledgeCapabilities, KnowledgeKind, MemoryService, ProcessingCapabilities,
    RecallFilter, RecallMatch, SearchReport, MAX_RECALL_RESULT_BYTES,
};

pub const MAX_COMPACT_KNOWLEDGE_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeView {
    #[default]
    Full,
    Compact,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct KnowledgeSearchOptions {
    pub view: KnowledgeView,
    pub diagnostics: bool,
    pub cost_diagnostics: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeExportFormat {
    #[default]
    Json,
    Markdown,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KnowledgeQuery {
    Search {
        query: String,
        #[serde(default)]
        include_candidates: bool,
        #[serde(default)]
        #[schemars(
            description = "full (default) preserves the existing response; compact returns complete conclusions, conditions and counterevidence within a 32 KiB JSON budget. Inspect chainId and revision for full evidence/history."
        )]
        view: KnowledgeView,
        #[serde(default)]
        #[schemars(
            description = "Keyword/hybrid only: websearch (default) preserves phrases, OR and exclusions; all/any match literal PostgreSQL English terms. No automatic query broadening. Vector-only supports the default mode only."
        )]
        match_mode: KeywordMatchMode,
        #[serde(default)]
        #[schemars(
            description = "Include the active strategy and PostgreSQL-parsed keyword query/terms. Optional and read-only, not a relevance guarantee."
        )]
        diagnostics: bool,
        #[serde(default)]
        #[schemars(
            description = "Include elapsed retrieval milliseconds, structured response bytes and provider-reported usage. Unknown costs stay null; cache hits incur zero new embedding requests. No monetary estimates or persistent telemetry."
        )]
        cost_diagnostics: bool,
    },
    #[schemars(
        description = "Discover agent-authoring, active retrieval and optional model capabilities without database or provider calls. No search filters or limits."
    )]
    Capabilities,
    Review {
        after: Option<Uuid>,
    },
    Dependents {
        chain_id: Uuid,
        after: Option<Uuid>,
    },
    Export {
        chain_id: Uuid,
        revision: Option<u32>,
        after_revision: Option<u32>,
        #[serde(default)]
        format: KnowledgeExportFormat,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeMatch {
    #[serde(flatten)]
    pub matched: ChainMatch,
    pub evidence: Vec<ChainEvidenceView>,
    pub supporting_chains: Vec<ChainSupportView>,
    pub observation_sources: Vec<Uuid>,
    pub evidence_details_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResponse {
    pub kind: &'static str,
    pub strategy: &'static str,
    pub consistency: &'static str,
    pub principles: Vec<KnowledgeMatch>,
    pub chains: Vec<KnowledgeMatch>,
    pub observations: Vec<RecallMatch>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum KnowledgeViewResponse {
    Full(KnowledgeSearchResponse),
    Compact(CompactKnowledgeResponse),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactKnowledgeResponse {
    pub kind: &'static str,
    pub view: &'static str,
    pub strategy: &'static str,
    pub consistency: &'static str,
    pub principles: Vec<CompactKnowledge>,
    pub chains: Vec<CompactKnowledge>,
    pub observations: Vec<CompactObservation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactKnowledge {
    pub conclusion: String,
    pub applicability: String,
    pub assumptions: Vec<String>,
    pub counterevidence: Vec<CompactCounterevidence>,
    pub chain_id: Uuid,
    pub revision: u32,
    pub kind: KnowledgeKind,
    pub agent_id: String,
    pub scope: Option<String>,
    pub state: ChainState,
    pub review: ChainReview,
    pub requires_review: bool,
    pub review_reasons: Vec<&'static str>,
    pub score: f64,
    pub vector_score: Option<f64>,
    pub keyword_score: Option<f64>,
    pub supporting_chains: Vec<CompactSupport>,
    pub evidence_details_available: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactSupport {
    pub chain_id: Uuid,
    pub revision: u32,
    pub current_revision: Option<u32>,
    pub available: bool,
    pub requires_review: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactCounterevidence {
    pub fragment_id: Uuid,
    pub available: bool,
    pub reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactObservation {
    pub fragment_id: Uuid,
    pub memory_id: Uuid,
    pub agent_id: String,
    pub scope: Option<String>,
    pub text: String,
    pub score: f64,
    pub state: FactState,
    pub evidence: EvidenceStatus,
}

impl From<KnowledgeMatch> for CompactKnowledge {
    fn from(result: KnowledgeMatch) -> Self {
        let mut counters: BTreeMap<Uuid, CompactCounterevidence> = BTreeMap::new();
        let mut review_reasons = BTreeSet::new();
        let mut evidence_details_available = true;
        match result.matched.chain.snapshot.review {
            ChainReview::Unreviewed => {
                review_reasons.insert("unreviewed");
            }
            ChainReview::Challenged => {
                review_reasons.insert("challenged");
            }
            ChainReview::Reviewed => {}
        }
        for support in &result.supporting_chains {
            if !support.available {
                evidence_details_available = false;
                review_reasons.insert("supporting_chain_unavailable");
            }
            if support
                .current_revision
                .is_some_and(|revision| revision != support.reference.revision)
            {
                review_reasons.insert("supporting_revision_changed");
            }
            if support.requires_review {
                review_reasons.insert("supporting_chain_requires_review");
            }
        }
        for evidence in result.evidence.iter().chain(
            result
                .supporting_chains
                .iter()
                .flat_map(|support| &support.evidence),
        ) {
            if !evidence.available {
                evidence_details_available = false;
                review_reasons.insert("observation_unavailable");
            }
            if evidence.reference.role == ChainEvidenceRole::Supports {
                if evidence
                    .lifecycle
                    .as_ref()
                    .is_some_and(|state| state.state != FactState::Active)
                {
                    review_reasons.insert("supporting_observation_inactive");
                }
                if evidence
                    .lifecycle
                    .as_ref()
                    .is_some_and(|state| state.evidence == EvidenceStatus::Disputed)
                {
                    review_reasons.insert("supporting_observation_disputed");
                }
            }
            if evidence.reference.role != ChainEvidenceRole::Counterexample {
                continue;
            }
            let counter = counters
                .entry(evidence.reference.fragment_id)
                .or_insert_with(|| CompactCounterevidence {
                    fragment_id: evidence.reference.fragment_id,
                    available: evidence.available,
                    reasons: vec![],
                });
            counter.available &= evidence.available;
            if !counter.reasons.contains(&evidence.reference.reason) {
                counter.reasons.push(evidence.reference.reason.clone());
            }
        }
        let matched = result.matched;
        let document = matched.chain.snapshot.document;
        Self {
            conclusion: document.conclusion,
            applicability: document.applicability,
            assumptions: document.assumptions,
            counterevidence: counters.into_values().collect(),
            chain_id: matched.chain.chain_id,
            revision: matched.chain.revision,
            kind: document.kind,
            agent_id: matched.chain.agent_id,
            scope: matched.chain.context.scope,
            state: matched.chain.snapshot.state,
            review: matched.chain.snapshot.review,
            requires_review: matched.requires_review,
            review_reasons: review_reasons.into_iter().collect(),
            score: matched.score,
            vector_score: matched.vector_score,
            keyword_score: matched.keyword_score,
            supporting_chains: result
                .supporting_chains
                .into_iter()
                .map(|support| CompactSupport {
                    chain_id: support.reference.chain_id,
                    revision: support.reference.revision,
                    current_revision: support.current_revision,
                    available: support.available,
                    requires_review: support.requires_review,
                })
                .collect(),
            evidence_details_available,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeReview {
    pub chain: ChainRevision,
    pub requires_review: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeReviewPage {
    pub kind: &'static str,
    pub entries: Vec<KnowledgeReview>,
    pub next: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeExport {
    pub kind: &'static str,
    pub version: u32,
    pub format: KnowledgeExportFormat,
    pub snapshot: ChainInspection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}

fn bounded<T: Serialize>(value: T) -> Result<T> {
    if serde_json::to_vec(&value)?.len() > MAX_RECALL_RESULT_BYTES {
        return Err(InvalidInput("knowledge response exceeds 512 KiB; lower limit or use JSON export and exact revision inspection".into()).into());
    }
    Ok(value)
}

fn quote(text: &str) -> String {
    text.lines()
        .map(|line| {
            let mut escaped = String::new();
            for character in line.chars() {
                match character {
                    '&' => escaped.push_str("&amp;"),
                    '<' => escaped.push_str("&lt;"),
                    '>' => escaped.push_str("&gt;"),
                    '\\' | '`' | '*' | '_' | '[' | ']' | '#' | '!' => {
                        escaped.push('\\');
                        escaped.push(character);
                    }
                    _ => escaped.push(character),
                }
            }
            format!("> {escaped}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl MemoryService {
    pub fn knowledge_capabilities(&self) -> KnowledgeCapabilities {
        KnowledgeCapabilities { kind:"knowledge_capabilities", retrieval:self.retriever.capabilities(),
            learning:crate::diagnostics::LearningCapabilities {
                agent_authored_chains:true, agent_authored_principles:true, model_preview_required:false,
                acceptance:"explicit_validation", recall_changes_knowledge:false,
            },
            decomposition:self.decomposer.capabilities(), formation:self.former.as_ref().map_or(
                ProcessingCapabilities { mode:"off", model:None }, |former| former.capabilities()),
            knowledge_views:vec!["full", "compact"], compact_response_bytes:MAX_COMPACT_KNOWLEDGE_BYTES,
            guidance:"Agents can author chains with write_memory.chain from verified observations, stating a reusable conclusion, applicability, assumptions and counterexamples. Propose first; accept only with explicit validation. Principles require 2..8 accepted current chain revisions. Inspect and revise existing knowledge when evidence changes; retain counterexamples. Formation describes an optional model preview, not whether agents can form chains. Extraction and formation do not enable semantic search. Keyword websearch ANDs terms and preserves phrase/identifier punctuation; use short source terms, explicit OR, or opt-in all/any modes. No automatic query broadening. Inspect referenced revisions for full evidence. Capabilities, scope and agent IDs are not authorization.",
        }
    }

    pub async fn search_knowledge(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
        options: KnowledgeSearchOptions,
    ) -> Result<SearchReport<KnowledgeViewResponse>> {
        self.validate_chain_filter(filter, limit)?;
        let started = Instant::now();
        let (response, usage) = crate::diagnostics::capture_usage(
            options.cost_diagnostics,
            self.recall_knowledge(query, filter, limit),
        )
        .await;
        let response = response?;
        let diagnostics = if options.diagnostics {
            Some(
                self.retriever
                    .query_diagnostics(
                        query,
                        &RecallFilter {
                            match_mode: filter.match_mode,
                            scope: filter.scope.clone(),
                            agent_id: filter.agent_id.clone(),
                            ..Default::default()
                        },
                    )
                    .await?,
            )
        } else {
            None
        };
        let response = match options.view {
            KnowledgeView::Full => KnowledgeViewResponse::Full(response),
            KnowledgeView::Compact => KnowledgeViewResponse::Compact(CompactKnowledgeResponse {
                kind: response.kind,
                view: "compact",
                strategy: response.strategy,
                consistency: response.consistency,
                principles: response.principles.into_iter().map(Into::into).collect(),
                chains: response.chains.into_iter().map(Into::into).collect(),
                observations: response
                    .observations
                    .into_iter()
                    .map(|observation| CompactObservation {
                        fragment_id: observation.fragment_id,
                        memory_id: observation.memory_id,
                        agent_id: observation.agent_id,
                        scope: observation.context.scope,
                        text: observation.text,
                        score: observation.score,
                        state: observation.lifecycle.state,
                        evidence: observation.lifecycle.evidence,
                    })
                    .collect(),
            }),
        };
        SearchReport::finish(
            response,
            diagnostics,
            started.elapsed().as_secs_f64() * 1000.0,
            usage,
            options.cost_diagnostics,
            self.retriever.capabilities().provider_calls_instrumented,
            if options.view == KnowledgeView::Compact {
                MAX_COMPACT_KNOWLEDGE_BYTES
            } else {
                MAX_RECALL_RESULT_BYTES
            },
        )
    }

    pub async fn recall_knowledge(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<KnowledgeSearchResponse> {
        self.validate_chain_filter(filter, limit)?;
        let observations = self
            .recall_memory(
                query,
                &RecallFilter {
                    match_mode: filter.match_mode,
                    agent_id: filter.agent_id.clone(),
                    scope: filter.scope.clone(),
                    include_inactive: filter.include_inactive,
                    ..Default::default()
                },
                limit,
            )
            .await?
            .results;
        let mut selected = self
            .retriever
            .recall_chains(
                query,
                &ChainFilter {
                    kind: Some(KnowledgeKind::Principle),
                    ..filter.clone()
                },
                limit,
            )
            .await?;
        if selected.len() < limit {
            selected.extend(
                self.retriever
                    .recall_chains(
                        query,
                        &ChainFilter {
                            kind: Some(KnowledgeKind::Chain),
                            ..filter.clone()
                        },
                        limit - selected.len(),
                    )
                    .await?,
            );
        }
        let hydrated = self.store.hydrate_knowledge(&selected, filter).await?;
        let (principles, chains) = hydrated.into_iter().partition(|result| {
            result.matched.chain.snapshot.document.kind == KnowledgeKind::Principle
        });
        bounded(KnowledgeSearchResponse { kind:"knowledge", strategy:self.retriever.chain_strategy(),
            consistency:"knowledge and its references share one snapshot; independent observations use a separate read snapshot",
            principles, chains, observations })
    }

    pub async fn review_knowledge(
        &self,
        target: Option<Uuid>,
        filter: &ChainFilter,
        after: Option<Uuid>,
        limit: usize,
    ) -> Result<KnowledgeReviewPage> {
        self.validate_chain_filter(filter, limit)?;
        if target.is_some_and(|value| value.is_nil()) || after.is_some_and(|value| value.is_nil()) {
            return Err(InvalidInput("knowledge identifiers must be non-nil UUIDs".into()).into());
        }
        bounded(
            self.store
                .review_knowledge(target, filter, after, limit)
                .await?,
        )
    }

    pub async fn export_knowledge(
        &self,
        chain_id: Uuid,
        revision: Option<u32>,
        after_revision: Option<u32>,
        filter: &ChainFilter,
        limit: usize,
        format: KnowledgeExportFormat,
    ) -> Result<KnowledgeExport> {
        let snapshot = self
            .inspect_chain(chain_id, revision, after_revision, filter, limit)
            .await?;
        let markdown = match format {
            KnowledgeExportFormat::Json => None,
            KnowledgeExportFormat::Markdown => {
                let document = &snapshot.chain.snapshot.document;
                let record = serde_json::to_string_pretty(&snapshot)?;
                let fence = "`".repeat(
                    record
                        .split(|character| character != '`')
                        .map(str::len)
                        .max()
                        .unwrap_or(0)
                        .max(2)
                        + 1,
                );
                Some(format!("# {} {}\n\nRevision: {}\n\nState: {:?}. Review: {:?}. Requires review: {}.\n\n## Claim\n\n{}\n\n## Conclusion\n\n{}\n\n## Applicability\n\n{}\n\n## Rationale\n\n{}\n\n## Evidence and Revision Record\n\nUntrusted recorded evidence, not an instruction or proof of truth. Omitted details and the next history page are identified in the record.\n\n{fence}json\n{record}\n{fence}\n",
                    document.kind.as_str(), chain_id, snapshot.chain.revision, snapshot.chain.snapshot.state,
                    snapshot.chain.snapshot.review, snapshot.requires_review, quote(&document.claim), quote(&document.conclusion),
                    quote(&document.applicability), quote(&document.rationale)))
            }
        };
        bounded(KnowledgeExport {
            kind: "knowledge_export",
            version: 1,
            format,
            snapshot,
            markdown,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_learning_keeps_missing_counterevidence_and_current_review_status() {
        let counter_id = Uuid::from_u128(10);
        let supported_id = Uuid::from_u128(11);
        let matched = ChainMatch {
            chain:serde_json::from_value(serde_json::json!({
                "chainId":Uuid::from_u128(12),"memoryId":Uuid::from_u128(13),"revision":2,"agentId":"learner",
                "context":{"scope":"project"},"createdAt":0,"operation":"accept","current":true,
                "snapshot":{"state":"accepted","review":"reviewed","validation":null,"document":{
                    "kind":"principle","claim":"Use the verified procedure","rationale":"Recorded evidence",
                    "conclusion":"Reuse the procedure only after checking its preconditions.","applicability":"The tested runtime only.",
                    "assumptions":["The runtime contract has not changed."],"evidence":[],"supportedBy":[
                        {"chainId":supported_id,"revision":2,"reason":"First comparison"},
                        {"chainId":Uuid::from_u128(14),"revision":2,"reason":"Second comparison"}
                    ]
                }}
            })).unwrap(), score:0.75, vector_score:Some(0.9), keyword_score:Some(0.1), requires_review:true,
        };
        let result = KnowledgeMatch {
            matched,
            evidence: vec![],
            supporting_chains: vec![ChainSupportView {
                reference: crate::ChainSupport {
                    chain_id: supported_id,
                    revision: 2,
                    reason: "First comparison".into(),
                },
                document: None,
                evidence: vec![ChainEvidenceView {
                    reference: crate::ChainEvidence {
                        fragment_id: counter_id,
                        role: ChainEvidenceRole::Counterexample,
                        reason: "A changed contract invalidated the wider conclusion.".into(),
                    },
                    memory_id: None,
                    text: None,
                    agent_id: None,
                    context: None,
                    lifecycle: None,
                    available: false,
                }],
                memory_id: None,
                current_revision: Some(3),
                state: None,
                review: None,
                observation_sources: vec![],
                available: false,
                requires_review: true,
            }],
            observation_sources: vec![],
            evidence_details_truncated: true,
        };
        let mut unavailable = result.clone();
        unavailable.supporting_chains[0].current_revision = None;
        let compact = CompactKnowledge::from(result);
        assert_eq!(compact.counterevidence[0].fragment_id, counter_id);
        assert!(!compact.counterevidence[0].available);
        assert!(compact.requires_review);
        assert_eq!(compact.supporting_chains[0].current_revision, Some(3));
        assert!(compact
            .review_reasons
            .contains(&"supporting_revision_changed"));
        assert!(compact.review_reasons.contains(&"observation_unavailable"));
        assert_eq!(
            compact.conclusion,
            "Reuse the procedure only after checking its preconditions."
        );
        assert_eq!(
            compact.assumptions,
            ["The runtime contract has not changed."]
        );
        assert!(
            !compact.evidence_details_available,
            "missing sources cannot be advertised as available through inspection"
        );
        let unavailable = CompactKnowledge::from(unavailable);
        assert!(unavailable
            .review_reasons
            .contains(&"supporting_chain_unavailable"));
        assert!(!unavailable
            .review_reasons
            .contains(&"supporting_revision_changed"));
    }

    #[test]
    fn compact_budget_counts_escaped_json_without_truncating_observations() {
        let text = "\"".repeat(crate::MAX_FRAGMENT_BYTES);
        let build = |count| {
            SearchReport::finish(
                CompactKnowledgeResponse {
                    kind: "knowledge",
                    view: "compact",
                    strategy: "keyword",
                    consistency: "test snapshot",
                    principles: vec![],
                    chains: vec![],
                    observations: (0..count)
                        .map(|index| CompactObservation {
                            fragment_id: Uuid::from_u128(index + 1),
                            memory_id: Uuid::from_u128(index + 10),
                            agent_id: "learner".into(),
                            scope: Some("project".into()),
                            text: text.clone(),
                            score: 0.5,
                            state: FactState::Active,
                            evidence: EvidenceStatus::Unconfirmed,
                        })
                        .collect(),
                },
                None,
                1.0,
                Some(vec![]),
                true,
                true,
                MAX_COMPACT_KNOWLEDGE_BYTES,
            )
        };
        let report = build(3).unwrap();
        let bytes = serde_json::to_vec(&report).unwrap().len();
        assert!(bytes <= MAX_COMPACT_KNOWLEDGE_BYTES);
        assert_eq!(report.cost_diagnostics.unwrap().response_bytes, bytes);
        assert_eq!(report.response.observations[2].text, text);
        assert!(
            build(4).is_err(),
            "never silently drop facts to meet the compact budget"
        );
    }
}
