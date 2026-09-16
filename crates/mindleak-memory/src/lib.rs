mod service;

use std::collections::HashSet;

use anyhow::{ensure, Result};
use async_trait::async_trait;
use serde::Serialize;
use uuid::Uuid;

pub use service::MemoryService;

pub const MAX_MEMORY_BYTES: usize = 32_768;
pub const MAX_FRAGMENT_BYTES: usize = 4096;
pub const MAX_FRAGMENTS: usize = 64;
pub const MAX_RECALL_LIMIT: usize = 50;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct InvalidInput(pub String);

#[derive(Clone, Debug)]
pub struct EmbeddedFragment {
    pub id: Uuid,
    pub text: String,
    pub embedding: Option<Vec<f32>>,
    pub importance: f32,
}

#[derive(Clone, Debug)]
pub struct PreparedMemory {
    pub id: Uuid,
    pub agent_id: String,
    pub raw_text: String,
    pub fragments: Vec<EmbeddedFragment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMemoryResult {
    pub memory_id: Uuid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallMatch {
    pub memory_id: Uuid,
    pub fragment_id: Uuid,
    pub agent_id: String,
    pub text: String,
    pub score: f64,
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
    async fn save(&self, memory: &PreparedMemory) -> Result<()>;
}

#[async_trait]
pub trait MemoryRetriever: Send + Sync {
    async fn recall(
        &self,
        query: &str,
        agent_id: Option<&str>,
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
        ensure!(
            norm_squared > 0.0 && norm_squared <= f64::from(f32::MAX),
            "embedding norm must be nonzero and representable as f32"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
