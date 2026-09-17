mod connection;
mod documents;
mod lifecycle;
mod migrations;
mod persistence;
mod queries;
mod relationships;
mod retrieval;

pub use migrations::MigrationOptions;
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
