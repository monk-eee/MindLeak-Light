use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use mindleak_memory::{
    EmbeddedFragment, MemoryRetriever, MemoryStore, PreparedMemory, TextEmbedder,
};
use mindleak_storage_postgres::{PostgresMemoryStore, VectorMemoryRetriever};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

fn database_url() -> String {
    let url = std::env::var("MINDLEAK_TEST_DATABASE_URL")
        .expect("postgres-tests requires MINDLEAK_TEST_DATABASE_URL pointing to a disposable *_test database");
    let config: tokio_postgres::Config = url.parse().unwrap();
    assert!(config
        .get_dbname()
        .is_some_and(|name| name.ends_with("_test")));
    url
}

async fn setup() -> (PostgresMemoryStore, Client) {
    let url = database_url();
    let store = PostgresMemoryStore::connect(&url, "test-model", 2, 4, None)
        .await
        .unwrap();
    let (client, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    (store, client)
}

fn memory(agent_id: &str) -> PreparedMemory {
    PreparedMemory {
        id: Uuid::new_v4(),
        agent_id: agent_id.into(),
        raw_text: "User prefers small PRs. Team requires reviews.".into(),
        fragments: vec![
            EmbeddedFragment {
                id: Uuid::new_v4(),
                text: "User prefers small PRs".into(),
                embedding: vec![1.0, 0.0],
                importance: 0.5,
            },
            EmbeddedFragment {
                id: Uuid::new_v4(),
                text: "Team requires reviews".into(),
                embedding: vec![0.0, 1.0],
                importance: 0.5,
            },
        ],
    }
}

struct QueryEmbedder;

#[async_trait]
impl TextEmbedder for QueryEmbedder {
    fn dimensions(&self) -> usize {
        2
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        assert_eq!(texts, ["PR preferences?"]);
        Ok(vec![vec![1.0, 0.0]])
    }
}

#[tokio::test]
async fn roundtrip_uses_pgvector_ranking_and_optional_agent_filter() {
    let (store, client) = setup().await;
    let agent_id = format!("ranking-{}", Uuid::new_v4());
    let memory = memory(&agent_id);
    store.save(&memory).await.unwrap();
    let row = client
        .query_one(
            "SELECT raw_text, created_at IS NOT NULL FROM public.memories WHERE id = $1",
            &[&memory.id],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), memory.raw_text);
    assert!(row.get::<_, bool>(1));
    let retriever = VectorMemoryRetriever::new(store, Arc::new(QueryEmbedder));
    let matches = retriever
        .recall("PR preferences?", Some(&agent_id), 2)
        .await
        .unwrap();
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0].memory_id, memory.id);
    assert_eq!(matches[0].fragment_id, memory.fragments[0].id);
    assert_eq!(matches[0].text, "User prefers small PRs");
    assert!((matches[0].score - 1.0).abs() < 1e-6);
    assert!(matches[1].score.abs() < 1e-6);
    assert_eq!(
        retriever
            .recall("PR preferences?", Some(&agent_id), 1)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(retriever
        .recall("PR preferences?", Some("absent-agent"), 2)
        .await
        .unwrap()
        .is_empty());
    let global = retriever.recall("PR preferences?", None, 3).await.unwrap();
    assert!(!global.is_empty());
    assert!(global.windows(2).all(|pair| pair[0].score >= pair[1].score));
}

#[tokio::test]
async fn fragment_insert_failure_rolls_back_raw_memory_and_every_fragment() {
    let (store, client) = setup().await;
    let mut memory = memory("rollback-test");
    memory.fragments[1].id = memory.fragments[0].id;
    assert!(store.save(&memory).await.is_err());
    for statement in [
        "SELECT count(*) FROM public.memories WHERE id = $1",
        "SELECT count(*) FROM public.fragments WHERE memory_id = $1",
    ] {
        let count: i64 = client
            .query_one(statement, &[&memory.id])
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 0);
    }
}

#[tokio::test]
async fn concurrent_agents_do_not_lose_writes() {
    let (store, client) = setup().await;
    let agent_id = format!("concurrent-{}", Uuid::new_v4());
    let mut writes = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let store = store.clone();
        let memory = memory(&agent_id);
        writes.spawn(async move { store.save(&memory).await });
    }
    while let Some(result) = writes.join_next().await {
        result.unwrap().unwrap();
    }
    let counts = client.query_one(
        "SELECT count(DISTINCT memories.id), count(fragments.id) FROM public.memories AS memories \
         JOIN public.fragments AS fragments ON fragments.memory_id = memories.id WHERE agent_id = $1",
        &[&agent_id],
    ).await.unwrap();
    assert_eq!(counts.get::<_, i64>(0), 12);
    assert_eq!(counts.get::<_, i64>(1), 24);
}

#[tokio::test]
async fn schema_has_exactly_three_tables_and_locks_the_embedding_space() {
    let (store, client) = setup().await;
    store.health().await.unwrap();
    let tables: Vec<String> = client
        .query(
            "SELECT table_name FROM information_schema.tables \
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(tables, ["fragments", "memories", "relationships"]);
    let url = database_url();
    assert!(
        PostgresMemoryStore::connect(&url, "other-model", 2, 4, None)
            .await
            .is_err()
    );
    assert!(PostgresMemoryStore::connect(&url, "test-model", 3, 4, None)
        .await
        .is_err());
    let (first, second) = tokio::join!(
        PostgresMemoryStore::connect(&url, "test-model", 2, 4, None),
        PostgresMemoryStore::connect(&url, "test-model", 2, 4, None),
    );
    first.unwrap().health().await.unwrap();
    second.unwrap().health().await.unwrap();
}

#[tokio::test]
async fn relationships_enforce_types_foreign_keys_and_cascading_deletion() {
    let (store, client) = setup().await;
    let memory = memory("relationship-test");
    store.save(&memory).await.unwrap();
    let source = memory.fragments[0].id;
    let target = memory.fragments[1].id;
    let insert = "INSERT INTO public.relationships (source_fragment, target_fragment, relationship_type) VALUES ($1, $2, $3)";
    for kind in ["supports", "contradicts", "related"] {
        client
            .execute(insert, &[&source, &target, &kind])
            .await
            .unwrap();
    }
    assert!(client
        .execute(insert, &[&source, &target, &"invented"])
        .await
        .is_err());
    assert!(client
        .execute(insert, &[&source, &source, &"related"])
        .await
        .is_err());
    assert!(client
        .execute(insert, &[&source, &Uuid::new_v4(), &"related"])
        .await
        .is_err());
    client
        .execute("DELETE FROM public.memories WHERE id = $1", &[&memory.id])
        .await
        .unwrap();
    let count: i64 = client.query_one(
        "SELECT count(*) FROM public.relationships WHERE source_fragment = $1 OR target_fragment = $1",
        &[&source],
    ).await.unwrap().get(0);
    assert_eq!(count, 0);
}
