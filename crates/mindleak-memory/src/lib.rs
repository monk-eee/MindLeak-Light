mod chains;
mod diagnostics;
mod domain;
mod formation;
mod lifecycle;
mod service;

use std::collections::HashSet;

use anyhow::{ensure, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use chains::{
    ChainCommand, ChainDocument, ChainEvidence, ChainEvidenceRole, ChainEvidenceView, ChainFilter,
    ChainInspection, ChainMatch, ChainQuery, ChainReview, ChainRevision, ChainSearchResponse,
    ChainSnapshot, ChainState, ChainSupport, ChainSupportView, ChainValidation, ChainWriteRequest,
    ChainWriteResult, KnowledgeKind, PreparedChain, ReportedConfidence, MAX_CHAIN_EVIDENCE,
    MAX_CHAIN_RESULTS,
};
pub use diagnostics::{
    record_provider_call, CostDiagnostics, KnowledgeCapabilities, LearningCapabilities,
    ProcessingCapabilities, ProviderCall, ProviderUsage, RetrievalCapabilities, SearchReport,
};
pub use domain::{
    DomainCursor, DomainIdentity, DomainInspection, DomainQuery, DomainRecord, DomainWrite,
    EdgeProvenance,
};
pub use formation::{
    FormationCitation, FormationContext, FormationInput, FormationPreview, FormationProvenance,
    KnowledgeFormation, KnowledgeFormer, MAX_FORMATION_CANDIDATES,
};
pub use lifecycle::{
    EvidenceStatus, FactLifecycle, FactState, MemoryContext, MemoryTier, RecallFilter,
};
pub use service::{
    CompactCounterevidence, CompactKnowledge, CompactKnowledgeResponse, CompactObservation,
    CompactSupport, KnowledgeExport, KnowledgeExportFormat, KnowledgeMatch, KnowledgeQuery,
    KnowledgeReview, KnowledgeReviewPage, KnowledgeSearchOptions, KnowledgeSearchResponse,
    KnowledgeView, KnowledgeViewResponse, MemoryService, MAX_COMPACT_KNOWLEDGE_BYTES,
};

pub const MAX_MEMORY_BYTES: usize = 32_768;
pub const MAX_FRAGMENT_BYTES: usize = 4096;
pub const MAX_FRAGMENTS: usize = 64;
pub const MAX_RECALL_LIMIT: usize = 50;
pub const MAX_FACT_LINKS: usize = 8;
pub const MAX_DOCUMENT_CONTEXT_FRAGMENTS: usize = 8;
pub const MAX_MEMORY_LINKS: usize = 128;
pub const MAX_RELATIONSHIP_SCAN: usize = 128;
pub const MAX_RELATED_CONTEXT_BYTES: usize = 32 * 1024;
pub const MAX_RECALL_RESULT_BYTES: usize = 512 * 1024;

#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum KeywordMatchMode {
    #[default]
    Websearch,
    All,
    Any,
}

impl KeywordMatchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Websearch => "websearch",
            Self::All => "all",
            Self::Any => "any",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordQueryDiagnostics {
    pub match_mode: KeywordMatchMode,
    pub parsed_query: String,
    pub terms: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallDiagnostics {
    pub strategy: &'static str,
    pub keyword: Option<KeywordQueryDiagnostics>,
    pub relevance_filter: bool,
}

#[derive(Clone, Debug)]
pub struct RecallResponse {
    pub results: Vec<RecallMatch>,
    pub diagnostics: Option<RecallDiagnostics>,
}

impl Serialize for RecallResponse {
    fn serialize<Serializer>(
        &self,
        serializer: Serializer,
    ) -> Result<Serializer::Ok, Serializer::Error>
    where
        Serializer: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        if let Some(diagnostics) = &self.diagnostics {
            let mut response = serializer.serialize_struct("RecallResponse", 2)?;
            response.serialize_field("results", &self.results)?;
            response.serialize_field("diagnostics", diagnostics)?;
            response.end()
        } else {
            self.results.serialize(serializer)
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct InvalidInput(pub String);

#[derive(Clone, Debug)]
pub struct EmbeddedFragment {
    pub id: Uuid,
    pub text: String,
    pub embedding: Option<Vec<f32>>,
    pub importance: f32,
    pub tier: MemoryTier,
    pub pinned: bool,
}

#[derive(Clone, Debug)]
pub struct PreparedMemory {
    pub id: Uuid,
    pub agent_id: String,
    pub raw_text: String,
    pub context: MemoryContext,
    pub fragments: Vec<EmbeddedFragment>,
    pub relationships: Vec<PreparedRelationship>,
    pub request: Option<WriteRequest>,
}

impl PreparedMemory {
    pub fn write_result(&self) -> WriteMemoryResult {
        WriteMemoryResult {
            memory_id: self.id,
            fragments: self
                .fragments
                .iter()
                .map(|fragment| WrittenFragment {
                    fragment_id: fragment.id,
                    text: fragment.text.clone(),
                    tier: fragment.tier,
                })
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    pub request_id: Uuid,
    pub agent_id: String,
    pub text: String,
    pub context: MemoryContext,
    pub facts: Vec<FactDirective>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<DomainWrite>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMemoryResult {
    pub memory_id: Uuid,
    pub fragments: Vec<WrittenFragment>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenFragment {
    pub fragment_id: Uuid,
    pub text: String,
    pub tier: MemoryTier,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallMatch {
    pub memory_id: Uuid,
    pub fragment_id: Uuid,
    pub agent_id: String,
    pub text: String,
    pub score: f64,
    pub context: MemoryContext,
    pub lifecycle: FactLifecycle,
    pub activation: f64,
    pub ranking_priority: f64,
    pub relationships: Vec<RelatedFact>,
    pub relationship_count: i64,
    pub relationship_count_exact: bool,
    pub relationships_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<DomainWrite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_context: Option<DocumentContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_count: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub duplicate_sources: Vec<RecallSource>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallSource {
    pub memory_id: Uuid,
    pub fragment_id: Uuid,
    pub agent_id: String,
    pub score: f64,
    pub context: MemoryContext,
    pub lifecycle: FactLifecycle,
    pub activation: f64,
    pub ranking_priority: f64,
    pub relationships: Vec<RelatedFact>,
    pub relationship_count: i64,
    pub relationship_count_exact: bool,
    pub relationships_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<DomainWrite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_context: Option<DocumentContext>,
}

impl From<RecallMatch> for RecallSource {
    fn from(fact: RecallMatch) -> Self {
        Self {
            memory_id: fact.memory_id,
            fragment_id: fact.fragment_id,
            agent_id: fact.agent_id,
            score: fact.score,
            context: fact.context,
            lifecycle: fact.lifecycle,
            activation: fact.activation,
            ranking_priority: fact.ranking_priority,
            relationships: fact.relationships,
            relationship_count: fact.relationship_count,
            relationship_count_exact: fact.relationship_count_exact,
            relationships_truncated: fact.relationships_truncated,
            domain: fact.domain,
            fragment_index: fact.fragment_index,
            document_context: fact.document_context,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentContext {
    pub fragments: Vec<DocumentFragment>,
    pub truncated: bool,
    pub order_known: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFragment {
    pub fragment_id: Uuid,
    pub memory_id: Uuid,
    pub agent_id: String,
    pub text: String,
    pub context: MemoryContext,
    pub lifecycle: FactLifecycle,
    pub fragment_index: Option<i32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipDirection {
    Incoming,
    Outgoing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationshipCursor {
    pub fragment_id: Uuid,
    pub relationship_type: RelationshipType,
    pub related_fragment_id: Uuid,
    pub direction: RelationshipDirection,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentInspection {
    pub memory_id: Uuid,
    pub fragment_id: Uuid,
    pub agent_id: String,
    pub text: String,
    pub raw_text: String,
    pub context: MemoryContext,
    pub lifecycle: FactLifecycle,
    pub relationships: Vec<RelatedFact>,
    pub next_cursor: Option<RelationshipCursor>,
    pub scanned_relationships: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<DomainWrite>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedFact {
    pub fragment_id: Uuid,
    pub memory_id: Uuid,
    pub agent_id: String,
    pub text: String,
    pub context: MemoryContext,
    pub relationship_type: RelationshipType,
    pub direction: String,
    pub state: FactState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipType {
    Supports,
    Contradicts,
    Related,
    Reinforces,
    Confirms,
    Supersedes,
    Archives,
    Restores,
}

impl RelationshipType {
    pub fn context_priority(self) -> i32 {
        match self {
            Self::Supersedes => 0,
            Self::Contradicts => 1,
            Self::Archives => 2,
            Self::Restores => 3,
            Self::Supports => 4,
            Self::Confirms => 5,
            Self::Reinforces => 6,
            Self::Related => 7,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supports => "supports",
            Self::Contradicts => "contradicts",
            Self::Related => "related",
            Self::Reinforces => "reinforces",
            Self::Confirms => "confirms",
            Self::Supersedes => "supersedes",
            Self::Archives => "archives",
            Self::Restores => "restores",
        }
    }

    pub fn is_feedback(self) -> bool {
        matches!(self, Self::Confirms | Self::Reinforces)
    }
}

#[derive(Clone, Debug)]
pub struct PreparedRelationship {
    pub source_fragment: Uuid,
    pub target_fragment: Uuid,
    pub relationship_type: RelationshipType,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteOptions {
    pub request_id: Option<Uuid>,
    #[serde(default)]
    pub context: MemoryContext,
    #[serde(default)]
    pub facts: Vec<FactDirective>,
    pub domain: Option<DomainWrite>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactDirective {
    #[schemars(
        description = "Exact decomposed fragment text. A mismatch fails the write rather than attaching policy to a different fact."
    )]
    pub text: String,
    #[serde(default)]
    pub tier: MemoryTier,
    #[serde(default)]
    pub pinned: bool,
    pub importance: Option<f32>,
    #[serde(default)]
    pub links: Vec<FactLink>,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactLink {
    pub target_fragment_id: Uuid,
    pub relationship_type: RelationshipType,
}

#[async_trait]
pub trait MemoryDecomposer: Send + Sync {
    fn capabilities(&self) -> ProcessingCapabilities {
        ProcessingCapabilities {
            mode: "custom",
            model: None,
        }
    }
    async fn decompose(&self, text: &str) -> Result<Vec<String>>;
}

#[async_trait]
pub trait TextEmbedder: Send + Sync {
    fn records_usage(&self) -> bool {
        false
    }
    fn dimensions(&self) -> usize;
    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

#[async_trait]
pub trait MemoryStore: Send + Sync {
    async fn hydrate_knowledge(
        &self,
        _selected: &[ChainMatch],
        _filter: &ChainFilter,
    ) -> Result<Vec<KnowledgeMatch>> {
        Err(InvalidInput("this memory store does not support knowledge retrieval".into()).into())
    }
    async fn review_knowledge(
        &self,
        _target: Option<Uuid>,
        _filter: &ChainFilter,
        _after: Option<Uuid>,
        _limit: usize,
    ) -> Result<KnowledgeReviewPage> {
        Err(InvalidInput("this memory store does not support knowledge review".into()).into())
    }
    async fn lookup_chain_write(
        &self,
        _request: &ChainWriteRequest,
    ) -> Result<Option<ChainWriteResult>> {
        Err(InvalidInput("this memory store does not support chains".into()).into())
    }
    async fn save_chain(&self, _chain: &PreparedChain) -> Result<ChainWriteResult> {
        Err(InvalidInput("this memory store does not support chains".into()).into())
    }
    async fn inspect_chain(
        &self,
        _chain_id: Uuid,
        _revision: Option<u32>,
        _after_revision: Option<u32>,
        _filter: &ChainFilter,
        _limit: usize,
    ) -> Result<Option<ChainInspection>> {
        Err(InvalidInput("this memory store does not support chains".into()).into())
    }
    async fn lookup_write(&self, request: &WriteRequest) -> Result<Option<WriteMemoryResult>>;
    async fn save(&self, memory: &PreparedMemory) -> Result<WriteMemoryResult>;
    async fn inspect_fragment(
        &self,
        fragment_id: Uuid,
        filter: &RecallFilter,
        after: Option<&RelationshipCursor>,
        limit: usize,
    ) -> Result<Option<FragmentInspection>>;

    async fn inspect_domain(
        &self,
        _query: &DomainQuery,
        _filter: &RecallFilter,
        _limit: usize,
    ) -> Result<Option<DomainInspection>> {
        Err(
            InvalidInput("the configured store does not support domain relationships".into())
                .into(),
        )
    }
}

#[async_trait]
pub trait MemoryRetriever: Send + Sync {
    fn capabilities(&self) -> RetrievalCapabilities {
        RetrievalCapabilities::default()
    }
    fn chain_strategy(&self) -> &'static str {
        "keyword"
    }

    async fn recall_chains(
        &self,
        _query: &str,
        _filter: &ChainFilter,
        _limit: usize,
    ) -> Result<Vec<ChainMatch>> {
        Err(InvalidInput("this retriever does not support chain search".into()).into())
    }
    async fn recall(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>>;

    async fn query_diagnostics(
        &self,
        _query: &str,
        _filter: &RecallFilter,
    ) -> Result<RecallDiagnostics> {
        Err(
            InvalidInput("the configured retriever does not provide query diagnostics".into())
                .into(),
        )
    }
}

pub fn validate_text(text: &str, field: &str, max_bytes: usize) -> Result<()> {
    if text.trim().is_empty() || text.len() > max_bytes {
        return Err(InvalidInput(format!(
            "{field} must be nonblank and at most {max_bytes} bytes"
        ))
        .into());
    }
    Ok(())
}

pub fn normalize_fragments(input: Vec<String>) -> Result<Vec<String>> {
    ensure!(
        !input.is_empty() && input.len() <= MAX_FRAGMENTS,
        "decomposition must contain 1..={MAX_FRAGMENTS} fragments"
    );
    let mut seen = HashSet::new();
    let mut fragments = Vec::new();
    for text in input {
        ensure!(
            text.len() <= MAX_FRAGMENT_BYTES,
            "fragment exceeds {MAX_FRAGMENT_BYTES} bytes"
        );
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        ensure!(!text.is_empty(), "decomposition contains a blank fragment");
        if seen.insert(text.clone()) {
            fragments.push(text);
        }
    }
    Ok(fragments)
}

pub fn validate_embeddings(
    embeddings: &[Vec<f32>],
    expected_count: usize,
    dimensions: usize,
) -> Result<()> {
    ensure!(
        (1..=2000).contains(&dimensions),
        "embedding dimensions must be in 1..=2000"
    );
    ensure!(
        embeddings.len() == expected_count,
        "embedding response count does not match the input count"
    );
    for vector in embeddings {
        ensure!(
            vector.len() == dimensions,
            "embedding dimensions do not match the configured dimensions"
        );
        ensure!(
            vector.iter().all(|value| value.is_finite()),
            "embedding contains a non-finite component"
        );
        let norm_squared: f64 = vector.iter().map(|value| f64::from(*value).powi(2)).sum();
        let pgvector_norm_squared: f32 = vector.iter().map(|value| value * value).sum();
        ensure!(
            norm_squared >= f64::from(f32::MIN_POSITIVE)
                && norm_squared <= f64::from(f32::MAX)
                && pgvector_norm_squared.is_normal(),
            "embedding squared norm must be finite and normal in f32"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
