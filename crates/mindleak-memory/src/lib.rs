mod lifecycle;
mod service;

use std::collections::HashSet;

use anyhow::{ensure, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use lifecycle::{
    EvidenceStatus, FactLifecycle, FactState, MemoryContext, MemoryTier, RecallFilter,
};
pub use service::MemoryService;

pub const MAX_MEMORY_BYTES: usize = 32_768;
pub const MAX_FRAGMENT_BYTES: usize = 4096;
pub const MAX_FRAGMENTS: usize = 64;
pub const MAX_RECALL_LIMIT: usize = 50;
pub const MAX_FACT_LINKS: usize = 8;
pub const MAX_MEMORY_LINKS: usize = 128;
pub const MAX_RELATED_CONTEXT_BYTES: usize = 32 * 1024;
pub const MAX_RECALL_RESULT_BYTES: usize = 512 * 1024;

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
    pub relationships_truncated: bool,
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
    async fn decompose(&self, text: &str) -> Result<Vec<String>>;
}

#[async_trait]
pub trait TextEmbedder: Send + Sync {
    fn dimensions(&self) -> usize;
    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
}

#[async_trait]
pub trait MemoryStore: Send + Sync {
    async fn lookup_write(&self, request: &WriteRequest) -> Result<Option<WriteMemoryResult>>;
    async fn save(&self, memory: &PreparedMemory) -> Result<WriteMemoryResult>;
}

#[async_trait]
pub trait MemoryRetriever: Send + Sync {
    async fn recall(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>>;
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
