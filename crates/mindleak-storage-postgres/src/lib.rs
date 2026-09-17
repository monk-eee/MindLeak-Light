mod connection;
mod documents;
mod domain;
mod lifecycle;
mod persistence;
mod queries;
mod relationships;
mod retrieval;

pub use retrieval::{HybridMemoryRetriever, KeywordMemoryRetriever, VectorMemoryRetriever};

use deadpool_postgres::Pool;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct EmbeddingSpace {
    model: String,
    dimensions: usize,
}

#[derive(Clone)]
pub struct PostgresMemoryStore {
    pool: Pool,
    space: Option<EmbeddingSpace>,
}
