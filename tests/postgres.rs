use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use anyhow::Result;
use async_trait::async_trait;
use mindleak_memory::{
    EmbeddedFragment, FactDirective, InvalidInput, MemoryContext, MemoryRetriever, MemoryStore,
    MemoryTier, PreparedMemory, RecallFilter, TextEmbedder, WriteRequest,
};
use mindleak_storage_postgres::{
    HybridMemoryRetriever, KeywordMemoryRetriever, PostgresMemoryStore, VectorMemoryRetriever,
};
use tokio_postgres::{Client, NoTls};
use url::Url;
use uuid::Uuid;

mod lifecycle;

fn filter(agent_id: Option<&str>) -> RecallFilter {
    RecallFilter {
        agent_id: agent_id.map(str::to_owned),
        ..Default::default()
    }
}

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
    let store = PostgresMemoryStore::connect(&url, Some(("test-model", 2)), 4, None)
        .await
        .unwrap();
    let (client, connection) = tokio_postgres::connect(&url, NoTls).await.unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    (store, client)
}

async fn isolated_database() -> (Client, Url, String) {
    let mut url = Url::parse(&database_url()).unwrap();
    let (admin, connection) = tokio_postgres::connect(url.as_str(), NoTls).await.unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    let name = format!("mindleak_{}_test", Uuid::new_v4().simple());
    let create: String = admin
        .query_one("SELECT format('CREATE DATABASE %I', $1::text)", &[&name])
        .await
        .unwrap()
        .get(0);
    admin.batch_execute(&create).await.unwrap();
    let cleanup: String = admin
        .query_one(
            "SELECT format('DROP DATABASE %I WITH (FORCE)', $1::text)",
            &[&name],
        )
        .await
        .unwrap()
        .get(0);
    url.set_path(&name);
    (admin, url, cleanup)
}

fn memory(agent_id: &str) -> PreparedMemory {
    PreparedMemory {
        id: Uuid::new_v4(),
        agent_id: agent_id.into(),
        raw_text: "User prefers small PRs. Team requires reviews.".into(),
        context: MemoryContext::default(),
        relationships: Vec::new(),
        request: None,
        fragments: vec![
            EmbeddedFragment {
                id: Uuid::new_v4(),
                text: "User prefers small PRs".into(),
                embedding: Some(vec![1.0, 0.0]),
                importance: 0.5,
                tier: MemoryTier::ShortTerm,
                pinned: false,
            },
            EmbeddedFragment {
                id: Uuid::new_v4(),
                text: "Team requires reviews".into(),
                embedding: Some(vec![0.0, 1.0]),
                importance: 0.5,
                tier: MemoryTier::ShortTerm,
                pinned: false,
            },
        ],
    }
}

fn keyed_memory(agent_id: &str) -> PreparedMemory {
    let mut memory = memory(agent_id);
    memory.request = Some(WriteRequest {
        request_id: Uuid::new_v4(),
        agent_id: memory.agent_id.clone(),
        text: memory.raw_text.clone(),
        context: memory.context.clone(),
        facts: Vec::new(),
    });
    memory
}

#[tokio::test]
async fn idempotent_writes_scope_keys_and_reject_changed_payloads() {
    let (store, database) = setup().await;
    let agent_id = format!("idempotency-conflict-{}", Uuid::new_v4());
    let original = keyed_memory(&agent_id);
    let receipt = store.save(&original).await.unwrap();
    let mut repeated = memory(&agent_id);
    repeated.request = original.request.clone();
    assert_eq!(store.save(&repeated).await.unwrap(), receipt);
    for variant in 0..3 {
        let mut changed = repeated.clone();
        let request = changed.request.as_mut().unwrap();
        match variant {
            0 => {
                changed.raw_text.push(' ');
                request.text = changed.raw_text.clone();
            }
            1 => {
                changed.context.source = Some("different source".into());
                request.context = changed.context.clone();
            }
            _ => request.facts.push(FactDirective {
                text: changed.fragments[0].text.clone(),
                importance: Some(0.9),
                ..Default::default()
            }),
        }
        assert!(store
            .lookup_write(request)
            .await
            .unwrap_err()
            .is::<InvalidInput>());
        assert!(store.save(&changed).await.unwrap_err().is::<InvalidInput>());
    }
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id = $1",
            &[&agent_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 1);
    let mut other_agent = keyed_memory(&format!("other-{agent_id}"));
    other_agent.request.as_mut().unwrap().request_id =
        original.request.as_ref().unwrap().request_id;
    assert!(store
        .lookup_write(other_agent.request.as_ref().unwrap())
        .await
        .unwrap()
        .is_none());
    assert_ne!(
        store.save(&other_agent).await.unwrap().memory_id,
        receipt.memory_id
    );
    let unkeyed_first = store.save(&memory(&agent_id)).await.unwrap();
    let unkeyed_second = store.save(&memory(&agent_id)).await.unwrap();
    assert_ne!(unkeyed_first.memory_id, unkeyed_second.memory_id);
    assert_ne!(unkeyed_first.memory_id, receipt.memory_id);
}

#[tokio::test]
async fn idempotent_concurrent_writers_share_one_committed_result() {
    let (store, database) = setup().await;
    let agent_id = format!("idempotency-race-{}", Uuid::new_v4());
    let original = keyed_memory(&agent_id);
    let barrier = Arc::new(tokio::sync::Barrier::new(8));
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let store = store.clone();
        let barrier = barrier.clone();
        let mut candidate = memory(&agent_id);
        candidate.request = original.request.clone();
        tasks.spawn(async move {
            barrier.wait().await;
            store.save(&candidate).await.unwrap()
        });
    }
    let mut receipts = Vec::new();
    while let Some(result) = tasks.join_next().await {
        receipts.push(result.unwrap());
    }
    assert_eq!(receipts.len(), 8);
    assert!(receipts.iter().all(|receipt| receipt == &receipts[0]));
    let counts = database.query_one(
        "SELECT (SELECT count(*) FROM public.memories WHERE agent_id = $1), \
         (SELECT count(*) FROM public.fragments JOIN public.memories ON memory_id = memories.id WHERE agent_id = $1)",
        &[&agent_id],
    ).await.unwrap();
    assert_eq!(counts.get::<_, i64>(0), 1);
    assert_eq!(counts.get::<_, i64>(1), 2);
    assert_eq!(
        store
            .lookup_write(original.request.as_ref().unwrap())
            .await
            .unwrap()
            .unwrap(),
        receipts[0]
    );
}

#[tokio::test]
async fn idempotent_failed_transaction_does_not_consume_the_request_key() {
    let (store, database) = setup().await;
    let agent_id = format!("idempotency-rollback-{}", Uuid::new_v4());
    let original = keyed_memory(&agent_id);
    let mut broken = original.clone();
    broken.fragments[1].id = broken.fragments[0].id;
    assert!(store.save(&broken).await.is_err());
    assert!(store
        .lookup_write(original.request.as_ref().unwrap())
        .await
        .unwrap()
        .is_none());
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id = $1",
            &[&agent_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 0);
    let receipt = store.save(&original).await.unwrap();
    assert_eq!(receipt.memory_id, original.id);
    assert_eq!(
        store
            .lookup_write(original.request.as_ref().unwrap())
            .await
            .unwrap(),
        Some(receipt)
    );
}

#[tokio::test]
async fn reopening_idempotency_migration_does_not_block_active_readers() {
    let (_store, mut reader) = setup().await;
    let read_transaction = reader.transaction().await.unwrap();
    read_transaction
        .query("SELECT id FROM public.memories LIMIT 1", &[])
        .await
        .unwrap();
    let (migration, connection) = tokio_postgres::connect(&database_url(), NoTls)
        .await
        .unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    migration
        .batch_execute("SET lock_timeout = '100ms'")
        .await
        .unwrap();
    let result = migration
        .batch_execute(include_str!(
            "../crates/mindleak-storage-postgres/migrations/0004-idempotent-writes.sql"
        ))
        .await;
    read_transaction.rollback().await.unwrap();
    assert!(
        result.is_ok(),
        "current idempotency metadata must not require DDL locks: {result:?}"
    );
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

#[derive(Default)]
struct CountingQueryEmbedder {
    calls: AtomicUsize,
    fail_first: bool,
    invalid_first: bool,
    gate: Option<tokio::sync::Semaphore>,
}

#[async_trait]
impl TextEmbedder for CountingQueryEmbedder {
    fn dimensions(&self) -> usize {
        2
    }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        anyhow::ensure!(texts.len() == 1, "expected one query");
        if let Some(gate) = &self.gate {
            let _permit = gate.acquire().await?;
        }
        anyhow::ensure!(call != 0 || !self.fail_first, "provider unavailable");
        if call == 0 && self.invalid_first {
            return Ok(vec![vec![0.0, 0.0]]);
        }
        Ok(vec![vec![1.0, 0.0]])
    }
}

#[tokio::test]
async fn concurrent_identical_queries_share_embeddings_but_keep_their_filters() {
    use std::{future::Future, task::Poll, time::Duration};

    let (store, client) = setup().await;
    for hybrid in [false, true] {
        let agents = [
            format!("shared-query-first-{}", Uuid::new_v4()),
            format!("shared-query-second-{}", Uuid::new_v4()),
        ];
        for agent in &agents {
            store.save(&memory(agent)).await.unwrap();
        }
        let filters = [filter(Some(&agents[0])), filter(Some(&agents[1]))];
        let embedder = Arc::new(CountingQueryEmbedder {
            gate: Some(tokio::sync::Semaphore::new(0)),
            ..Default::default()
        });
        let retriever: Arc<dyn MemoryRetriever> = if hybrid {
            Arc::new(HybridMemoryRetriever::new(store.clone(), embedder.clone()))
        } else {
            Arc::new(VectorMemoryRetriever::new(store.clone(), embedder.clone()))
        };
        let mut requests: Vec<_> = (0..8)
            .map(|index| {
                let retriever = retriever.clone();
                let filter = filters[index % 2].clone();
                Box::pin(
                    async move { (index, retriever.recall("PR preferences?", &filter, 5).await) },
                )
            })
            .collect();
        std::future::poll_fn(|context| {
            for request in &mut requests {
                assert!(request.as_mut().poll(context).is_pending());
            }
            Poll::Ready(())
        })
        .await;
        let overlapping_calls = embedder.calls.load(Ordering::SeqCst);
        embedder.gate.as_ref().unwrap().add_permits(8);
        let mut running = tokio::task::JoinSet::new();
        for request in requests {
            running.spawn(request);
        }
        while let Some(completed) =
            tokio::time::timeout(Duration::from_secs(5), running.join_next())
                .await
                .unwrap()
        {
            let (index, results) = completed.unwrap();
            let results = results.unwrap();
            assert_eq!(results.len(), 2);
            assert!(results
                .iter()
                .all(|result| result.agent_id == agents[index % 2]));
        }
        client
            .execute(
                "DELETE FROM public.memories WHERE agent_id = ANY($1)",
                &[&agents.as_slice()],
            )
            .await
            .unwrap();
        assert_eq!(
            overlapping_calls, 1,
            "identical concurrent queries should share one embedding request"
        );
        assert_eq!(embedder.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn cancelled_query_initializer_releases_waiters_without_serializing_other_queries() {
    use std::{future::Future, task::Poll, time::Duration};

    let (store, _) = setup().await;
    let agent_id = format!("cancelled-query-{}", Uuid::new_v4());
    let filter = filter(Some(&agent_id));
    let embedder = Arc::new(CountingQueryEmbedder {
        gate: Some(tokio::sync::Semaphore::new(0)),
        ..Default::default()
    });
    let retriever = VectorMemoryRetriever::new(store, embedder.clone());
    let mut initializer = Box::pin(retriever.recall("PR preferences?", &filter, 5));
    let mut waiting = Box::pin(retriever.recall("PR preferences?", &filter, 5));
    let mut different = Box::pin(retriever.recall("pr preferences?", &filter, 5));
    std::future::poll_fn(|context| {
        assert!(initializer.as_mut().poll(context).is_pending());
        assert!(waiting.as_mut().poll(context).is_pending());
        assert!(different.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(embedder.calls.load(Ordering::SeqCst), 2);
    drop(initializer);
    embedder.gate.as_ref().unwrap().add_permits(2);
    let (waiting, different) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(waiting, different)
    })
    .await
    .unwrap();
    assert!(waiting.unwrap().is_empty());
    assert!(different.unwrap().is_empty());
    assert_eq!(embedder.calls.load(Ordering::SeqCst), 3);
    assert!(retriever
        .recall("PR preferences?", &filter, 5)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(embedder.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn failed_query_initializers_return_errors_and_allow_a_waiting_caller_to_recover() {
    use std::{future::Future, task::Poll, time::Duration};

    let (store, _) = setup().await;
    let agent_id = format!("failed-shared-query-{}", Uuid::new_v4());
    let filter = filter(Some(&agent_id));
    for invalid_first in [false, true] {
        let embedder = Arc::new(CountingQueryEmbedder {
            fail_first: !invalid_first,
            invalid_first,
            gate: Some(tokio::sync::Semaphore::new(0)),
            ..Default::default()
        });
        let retriever = VectorMemoryRetriever::new(store.clone(), embedder.clone());
        let mut initializer = Box::pin(retriever.recall("PR preferences?", &filter, 5));
        let mut waiting = Box::pin(retriever.recall("PR preferences?", &filter, 5));
        std::future::poll_fn(|context| {
            assert!(initializer.as_mut().poll(context).is_pending());
            assert!(waiting.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        assert_eq!(embedder.calls.load(Ordering::SeqCst), 1);
        embedder.gate.as_ref().unwrap().add_permits(2);
        let (failed, recovered) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(initializer, waiting)
        })
        .await
        .unwrap();
        let error = failed.unwrap_err().to_string();
        if invalid_first {
            assert_eq!(
                error,
                "embedding squared norm must be finite and normal in f32"
            );
        } else {
            assert_eq!(error, "provider unavailable");
        }
        assert!(recovered.unwrap().is_empty());
        assert_eq!(embedder.calls.load(Ordering::SeqCst), 2);
        assert!(retriever
            .recall("PR preferences?", &filter, 5)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(embedder.calls.load(Ordering::SeqCst), 2);
    }
}

#[tokio::test]
async fn repeated_queries_reuse_embeddings_but_requery_memories_and_agent_filters() {
    let (store, client) = setup().await;
    for hybrid in [false, true] {
        let agent_id = format!("query-cache-{}", Uuid::new_v4());
        let original = memory(&agent_id);
        store.save(&original).await.unwrap();
        let embedder = Arc::new(CountingQueryEmbedder::default());
        let retriever: Box<dyn MemoryRetriever> = if hybrid {
            Box::new(HybridMemoryRetriever::new(store.clone(), embedder.clone()))
        } else {
            Box::new(VectorMemoryRetriever::new(store.clone(), embedder.clone()))
        };
        assert_eq!(
            retriever
                .recall("PR preferences?", &filter(Some(&agent_id)), 1)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(retriever
            .recall("PR preferences?", &filter(Some("absent-agent")), 5)
            .await
            .unwrap()
            .is_empty());
        let added = memory(&agent_id);
        store.save(&added).await.unwrap();
        let updated = retriever
            .recall("PR preferences?", &filter(Some(&agent_id)), 5)
            .await
            .unwrap();
        assert_eq!(updated.len(), 4);
        assert!(updated.iter().any(|row| row.memory_id == added.id));
        client
            .execute("DELETE FROM memories WHERE id = $1", &[&original.id])
            .await
            .unwrap();
        let after_delete = retriever
            .recall("PR preferences?", &filter(Some(&agent_id)), 5)
            .await
            .unwrap();
        assert_eq!(after_delete.len(), 2);
        assert!(after_delete.iter().all(|row| row.memory_id == added.id));
        assert_eq!(embedder.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn query_embedding_cache_is_bounded_exact_and_does_not_cache_provider_failures() {
    let (store, _) = setup().await;
    let agent_id = format!("cache-bounds-{}", Uuid::new_v4());
    let embedder = Arc::new(CountingQueryEmbedder::default());
    let retriever = VectorMemoryRetriever::new(store.clone(), embedder.clone());
    for index in 0..128 {
        retriever
            .recall(&format!("query-{index}"), &filter(Some(&agent_id)), 1)
            .await
            .unwrap();
    }
    retriever
        .recall("query-0", &filter(Some(&agent_id)), 1)
        .await
        .unwrap();
    assert_eq!(embedder.calls.load(Ordering::SeqCst), 128);
    retriever
        .recall("Query-0", &filter(Some(&agent_id)), 1)
        .await
        .unwrap();
    retriever
        .recall("query-0", &filter(Some(&agent_id)), 1)
        .await
        .unwrap();
    assert_eq!(embedder.calls.load(Ordering::SeqCst), 130);
    for invalid_first in [false, true] {
        let provider = Arc::new(CountingQueryEmbedder {
            fail_first: !invalid_first,
            invalid_first,
            ..Default::default()
        });
        let retriever = VectorMemoryRetriever::new(store.clone(), provider.clone());
        assert!(retriever
            .recall("query", &filter(Some(&agent_id)), 1)
            .await
            .is_err());
        retriever
            .recall("query", &filter(Some(&agent_id)), 1)
            .await
            .unwrap();
        retriever
            .recall("query", &filter(Some(&agent_id)), 1)
            .await
            .unwrap();
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    }
}

#[tokio::test]
async fn unsafe_vectors_and_non_finite_scores_fail_closed() {
    struct SmallQueryEmbedder;

    #[async_trait]
    impl TextEmbedder for SmallQueryEmbedder {
        fn dimensions(&self) -> usize {
            2
        }

        async fn embed_batch(&self, _: &[String]) -> Result<Vec<Vec<f32>>> {
            Ok(vec![vec![1e-30, 0.0]])
        }
    }

    let (admin, url, cleanup) = isolated_database().await;
    let store = PostgresMemoryStore::connect(url.as_str(), Some(("test-model", 2)), 4, None)
        .await
        .unwrap();
    let (client, connection) = tokio_postgres::connect(url.as_str(), NoTls).await.unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    let agent_id = format!("unsafe-vector-{}", Uuid::new_v4());
    let mut unsafe_memory = memory(&agent_id);
    unsafe_memory.fragments[0].embedding = Some(vec![1e-30, 0.0]);
    let write_rejected = store.save(&unsafe_memory).await.is_err();
    let saved_count: i64 = client
        .query_one(
            "SELECT count(*) FROM public.memories WHERE id = $1",
            &[&unsafe_memory.id],
        )
        .await
        .unwrap()
        .get(0);
    let query_rejected = VectorMemoryRetriever::new(store.clone(), Arc::new(SmallQueryEmbedder))
        .recall("PR preferences?", &filter(Some(&agent_id)), 5)
        .await
        .is_err();

    let original = memory(&agent_id);
    store.save(&original).await.unwrap();
    client
        .execute(
            "UPDATE public.fragments SET embedding = '[0,1e-30]'::vector WHERE memory_id = $1",
            &[&original.id],
        )
        .await
        .unwrap();
    let mut rejected_scores = Vec::new();
    for hybrid in [false, true] {
        for floor in [None, Some(0.9)] {
            let retriever: Box<dyn MemoryRetriever> = if hybrid {
                Box::new(
                    HybridMemoryRetriever::new(store.clone(), Arc::new(QueryEmbedder))
                        .with_min_similarity(floor)
                        .unwrap(),
                )
            } else {
                Box::new(
                    VectorMemoryRetriever::new(store.clone(), Arc::new(QueryEmbedder))
                        .with_min_similarity(floor)
                        .unwrap(),
                )
            };
            rejected_scores.push(
                retriever
                    .recall("PR preferences?", &filter(Some(&agent_id)), 5)
                    .await
                    .is_err(),
            );
        }
    }
    drop(client);
    drop(store);
    admin.batch_execute(&cleanup).await.unwrap();

    assert!(write_rejected, "unsafe write must fail before storage");
    assert_eq!(saved_count, 0, "unsafe write must not leave a raw memory");
    assert!(
        query_rejected,
        "unsafe query embeddings must fail validation"
    );
    assert!(
        rejected_scores.iter().all(|rejected| *rejected),
        "vector and hybrid recall must reject non-finite database scores, with or without a floor"
    );
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
        .recall("PR preferences?", &filter(Some(&agent_id)), 2)
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
            .recall("PR preferences?", &filter(Some(&agent_id)), 1)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(retriever
        .recall("PR preferences?", &filter(Some("absent-agent")), 2)
        .await
        .unwrap()
        .is_empty());
    let global = retriever
        .recall("PR preferences?", &filter(None), 3)
        .await
        .unwrap();
    assert!(!global.is_empty());
    assert!(global.windows(2).all(|pair| pair[0].score >= pair[1].score));
}

#[tokio::test]
async fn hybrid_recall_fuses_semantic_and_unembedded_keyword_matches_with_agent_filtering() {
    let (store, _) = setup().await;
    let agent_id = format!("hybrid-{}", Uuid::new_v4());
    let mut embedded = memory(&agent_id);
    embedded.fragments[0].text = "Small changes are easier to inspect".into();
    embedded.fragments[1].text = "PR preferences require reviews".into();
    embedded.fragments[1].embedding = Some(vec![0.8, 0.6]);
    store.save(&embedded).await.unwrap();
    let unembedded_store = PostgresMemoryStore::connect(&database_url(), None, 4, None)
        .await
        .unwrap();
    let mut unembedded = memory(&agent_id);
    unembedded.fragments.truncate(1);
    unembedded.fragments[0].text = "PR preferences mention identifier code-713".into();
    unembedded.fragments[0].embedding = None;
    unembedded_store.save(&unembedded).await.unwrap();
    let mut foreign = embedded.clone();
    foreign.id = Uuid::new_v4();
    foreign.agent_id = format!("foreign-{}", Uuid::new_v4());
    for fragment in &mut foreign.fragments {
        fragment.id = Uuid::new_v4();
    }
    store.save(&foreign).await.unwrap();
    let retriever = HybridMemoryRetriever::new(store, Arc::new(QueryEmbedder))
        .with_min_similarity(Some(0.5))
        .unwrap();
    let matches = retriever
        .recall("PR preferences?", &filter(Some(&agent_id)), 5)
        .await
        .unwrap();
    assert_eq!(matches.len(), 3);
    assert_eq!(matches[0].fragment_id, embedded.fragments[1].id);
    assert!(matches.iter().all(|result| result.agent_id == agent_id));
    assert!(matches
        .iter()
        .any(|result| result.memory_id == unembedded.id));
    assert_eq!(
        retriever
            .recall("PR preferences?", &filter(Some(&agent_id)), 1)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(retriever
        .recall("PR preferences?", &filter(Some("absent-agent")), 5)
        .await
        .unwrap()
        .is_empty());
    assert!(retriever
        .recall("PR preferences?", &filter(Some(&agent_id)), 0)
        .await
        .is_err());
}

struct UnavailableEmbedder;

#[async_trait]
impl TextEmbedder for UnavailableEmbedder {
    fn dimensions(&self) -> usize {
        2
    }

    async fn embed_batch(&self, _: &[String]) -> Result<Vec<Vec<f32>>> {
        anyhow::bail!("provider unavailable")
    }
}

#[tokio::test]
async fn hybrid_recall_never_hides_embedding_failure_behind_keyword_results() {
    let (store, _) = setup().await;
    let agent_id = format!("hybrid-failure-{}", Uuid::new_v4());
    store.save(&memory(&agent_id)).await.unwrap();
    assert!(!KeywordMemoryRetriever::new(store.clone())
        .recall("reviews", &filter(Some(&agent_id)), 5)
        .await
        .unwrap()
        .is_empty());
    let retriever = HybridMemoryRetriever::new(store, Arc::new(UnavailableEmbedder));
    assert!(retriever
        .recall("reviews", &filter(Some(&agent_id)), 5)
        .await
        .is_err());
}

#[tokio::test]
async fn vector_floor_is_inclusive_and_rejects_invalid_configuration() {
    let (store, _) = setup().await;
    let agent_id = format!("floor-{}", Uuid::new_v4());
    store.save(&memory(&agent_id)).await.unwrap();
    for (minimum, count) in [(0.0, 2), (1.0, 1)] {
        let retriever = VectorMemoryRetriever::new(store.clone(), Arc::new(QueryEmbedder))
            .with_min_similarity(Some(minimum))
            .unwrap();
        assert_eq!(
            retriever
                .recall("PR preferences?", &filter(Some(&agent_id)), 5)
                .await
                .unwrap()
                .len(),
            count
        );
    }
    for minimum in [f64::NAN, f64::INFINITY, -1.01, 1.01] {
        assert!(
            VectorMemoryRetriever::new(store.clone(), Arc::new(QueryEmbedder))
                .with_min_similarity(Some(minimum))
                .is_err()
        );
    }
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
async fn reopening_current_schema_does_not_block_active_transactions() {
    let (admin, url, cleanup) = isolated_database().await;
    let store = PostgresMemoryStore::connect(url.as_str(), Some(("test-model", 2)), 4, None)
        .await
        .unwrap();
    let (mut session, connection) = tokio_postgres::connect(url.as_str(), NoTls).await.unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    let mut attempts = Vec::new();
    for lock_mode in ["ACCESS SHARE", "ROW EXCLUSIVE"] {
        let transaction = session
            .build_transaction()
            .read_only(lock_mode == "ACCESS SHARE")
            .start()
            .await
            .unwrap();
        transaction
            .batch_execute(&format!(
                "LOCK TABLE public.memories, public.fragments, public.relationships IN {lock_mode} MODE"
            ))
            .await
            .unwrap();
        let reopened = PostgresMemoryStore::connect(url.as_str(), Some(("test-model", 2)), 4, None)
            .await
            .map(drop);
        transaction.rollback().await.unwrap();
        attempts.push((lock_mode, reopened));
    }
    drop(session);
    drop(store);
    admin.batch_execute(&cleanup).await.unwrap();
    for (lock_mode, reopened) in attempts {
        assert!(
            reopened.is_ok(),
            "a current-schema restart must coexist with {lock_mode}: {reopened:?}"
        );
    }
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
        PostgresMemoryStore::connect(&url, Some(("other-model", 2)), 4, None)
            .await
            .is_err()
    );
    assert!(
        PostgresMemoryStore::connect(&url, Some(("test-model", 3)), 4, None)
            .await
            .is_err()
    );
    let (first, second) = tokio::join!(
        PostgresMemoryStore::connect(&url, Some(("test-model", 2)), 4, None),
        PostgresMemoryStore::connect(&url, Some(("test-model", 2)), 4, None),
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

#[tokio::test]
async fn keyword_recall_finds_unembedded_fragments_and_respects_agent_filters() {
    let (vector_store, client) = setup().await;
    let store = PostgresMemoryStore::connect(&database_url(), None, 4, None)
        .await
        .unwrap();
    let agent_id = format!("keyword-{}", Uuid::new_v4());
    let mut raw_memory = memory(&agent_id);
    for fragment in &mut raw_memory.fragments {
        fragment.embedding = None;
    }
    store.save(&raw_memory).await.unwrap();
    let null_count: i64 = client
        .query_one(
            "SELECT count(*) FROM public.fragments WHERE memory_id = $1 AND embedding IS NULL",
            &[&raw_memory.id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(null_count, 2);
    let retriever = KeywordMemoryRetriever::new(store);
    let matches = retriever
        .recall("reviews", &filter(Some(&agent_id)), 10)
        .await
        .unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].text, "Team requires reviews");
    assert_eq!(matches[0].memory_id, raw_memory.id);
    assert!((0.0..1.0).contains(&matches[0].score));
    assert!(matches[0].score > 0.0);
    assert!(retriever
        .recall("reviews", &filter(Some("absent-agent")), 10)
        .await
        .unwrap()
        .is_empty());
    assert!(retriever
        .recall("unfindablewordxyz", &filter(Some(&agent_id)), 10)
        .await
        .unwrap()
        .is_empty());
    assert!(!retriever
        .recall("reviews", &filter(None), 1)
        .await
        .unwrap()
        .is_empty());
    assert!(retriever
        .recall("the and", &filter(Some(&agent_id)), 10)
        .await
        .unwrap()
        .is_empty());

    let vectors = VectorMemoryRetriever::new(vector_store, Arc::new(QueryEmbedder));
    assert!(vectors
        .recall("PR preferences?", &filter(Some(&agent_id)), 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn model_free_upgrade_preserves_legacy_vectors_and_model_binding() {
    let (admin, url, cleanup) = isolated_database().await;
    let (database, connection) = tokio_postgres::connect(url.as_str(), NoTls).await.unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    database
        .batch_execute(&format!(
            include_str!("../crates/mindleak-storage-postgres/schema.sql"),
            dimensions = 2,
        ))
        .await
        .unwrap();
    database
        .batch_execute(
            "COMMENT ON TABLE public.fragments IS '{\"model\":\"test-model\",\"dimensions\":2}'",
        )
        .await
        .unwrap();
    let legacy = memory("legacy");
    database
        .execute(
            "INSERT INTO public.memories(id, agent_id, raw_text) VALUES($1, $2, $3)",
            &[&legacy.id, &legacy.agent_id, &legacy.raw_text],
        )
        .await
        .unwrap();
    let fragment = &legacy.fragments[0];
    database
        .execute(
            "INSERT INTO public.fragments(id, memory_id, text, embedding) VALUES($1, $2, $3, $4)",
            &[
                &fragment.id,
                &legacy.id,
                &fragment.text,
                &pgvector::Vector::from(fragment.embedding.clone().unwrap()),
            ],
        )
        .await
        .unwrap();
    let store = PostgresMemoryStore::connect(url.as_str(), None, 2, None)
        .await
        .unwrap();
    let mut unembedded = memory("new-agent");
    for fragment in &mut unembedded.fragments {
        fragment.embedding = None;
    }
    store.save(&unembedded).await.unwrap();
    let original = database.query_one(
        "SELECT raw_text, embedding FROM public.memories JOIN public.fragments ON memory_id = memories.id WHERE memories.id = $1",
        &[&legacy.id],
    ).await.unwrap();
    assert_eq!(original.get::<_, String>(0), legacy.raw_text);
    assert_eq!(
        original.get::<_, pgvector::Vector>(1).to_vec(),
        vec![1.0, 0.0]
    );
    let store = PostgresMemoryStore::connect(url.as_str(), Some(("test-model", 2)), 2, None)
        .await
        .unwrap();
    assert!(
        PostgresMemoryStore::connect(url.as_str(), Some(("other-model", 2)), 2, None)
            .await
            .is_err()
    );
    let retriever = KeywordMemoryRetriever::new(store);
    assert_eq!(
        retriever
            .recall("reviews", &filter(Some("new-agent")), 10)
            .await
            .unwrap()
            .len(),
        1
    );
    admin.batch_execute(&cleanup).await.unwrap();
}

#[tokio::test]
async fn vectors_can_be_enabled_after_model_free_writes_without_rewriting_them() {
    let (admin, url, cleanup) = isolated_database().await;
    let store = PostgresMemoryStore::connect(url.as_str(), None, 2, None)
        .await
        .unwrap();
    let mut unembedded = memory("before-model");
    for fragment in &mut unembedded.fragments {
        fragment.embedding = None;
    }
    store.save(&unembedded).await.unwrap();
    let vector_store = PostgresMemoryStore::connect(url.as_str(), Some(("test-model", 2)), 2, None)
        .await
        .unwrap();
    vector_store.save(&memory("with-model")).await.unwrap();
    let vector_retriever = VectorMemoryRetriever::new(vector_store, Arc::new(QueryEmbedder));
    assert!(vector_retriever
        .recall("PR preferences?", &filter(Some("before-model")), 10)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        vector_retriever
            .recall("PR preferences?", &filter(Some("with-model")), 10)
            .await
            .unwrap()
            .len(),
        2
    );
    let keyword_retriever = KeywordMemoryRetriever::new(store);
    let recalled = keyword_retriever
        .recall("reviews", &filter(Some("before-model")), 10)
        .await
        .unwrap();
    assert_eq!(recalled.len(), 1);
    assert_eq!(recalled[0].memory_id, unembedded.id);
    admin.batch_execute(&cleanup).await.unwrap();
}
