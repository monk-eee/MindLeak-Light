use std::{
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use mindleak_decomposition::OpenAiDecomposer;
use mindleak_embeddings::OpenAiEmbedder;
use mindleak_mcp::{http_router, MemoryMcp};
use mindleak_memory::MemoryService;
use mindleak_storage_postgres::{PostgresMemoryStore, VectorMemoryRetriever};
use reqwest::{Client, StatusCode, Url};
use rmcp::{
    model::CallToolRequestParams,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
        TokioChildProcess,
    },
    ServiceExt,
};
use serde_json::{json, Value};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, Request, ResponseTemplate,
};

mod mcp_lifecycle;

const FACTS: [&str; 3] = [
    "User dislikes huge PRs",
    "Team requires reviews",
    "PRs under 500 LOC merge faster",
];
const TOKEN: &str = "mindleak-light-integration-test-token";

fn database_url() -> String {
    let url = std::env::var("MINDLEAK_TEST_DATABASE_URL")
        .expect("set MINDLEAK_TEST_DATABASE_URL to a disposable *_test database");
    let config: tokio_postgres::Config = url.parse().unwrap();
    assert!(config
        .get_dbname()
        .is_some_and(|name| name.ends_with("_test")));
    url
}

async fn provider() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"choices": [{
            "finish_reason": "stop", "message": {"content": json!({"fragments": FACTS}).to_string()}
        }]}))).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(|request: &Request| {
            let body: Value = request.body_json().unwrap();
            let inputs = body["input"].as_array().unwrap();
            let data: Vec<_> = inputs
                .iter()
                .enumerate()
                .rev()
                .map(|(index, input)| {
                    let vector = if input.as_str().unwrap().contains("reviews") {
                        [0.0, 1.0]
                    } else {
                        [1.0, 0.0]
                    };
                    json!({"index": index, "embedding": vector})
                })
                .collect();
            ResponseTemplate::new(200).set_body_json(json!({"data": data}))
        })
        .mount(&server)
        .await;
    server
}

fn call(name: &'static str, arguments: Value) -> CallToolRequestParams {
    CallToolRequestParams::new(name).with_arguments(arguments.as_object().unwrap().clone())
}

#[tokio::test]
async fn actual_runtime_checks_retrieval_canaries_before_readiness_without_writes() {
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("migration-canaries-{}", Uuid::new_v4());
    let scope = format!("migration-scope-{}", Uuid::new_v4());
    let memory_id = Uuid::new_v4();
    let fragment_id = Uuid::new_v4();
    let detail_id = Uuid::new_v4();
    let store = PostgresMemoryStore::connect(&database_url(), None, 1, None)
        .await
        .unwrap();
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let raw_text = "System.Reflection.TargetInvocationException wraps the underlying error.\nPRIVATE-CANARY-SOURCE detail.";
    let context = json!({"scope": scope, "source": "wiki/AuthFlow/config-file.md", "summary": "rollout review"}).to_string();
    database.execute("INSERT INTO public.memories(id, agent_id, raw_text, context) VALUES ($1,$2,$3,$4::text::jsonb)",
        &[&memory_id, &agent_id, &raw_text, &context]).await.unwrap();
    database
        .execute(
            "INSERT INTO public.fragments(id, memory_id, text, fragment_index) VALUES
        ($1,$2,'System.Reflection.TargetInvocationException wraps the underlying error.',0),
        ($3,$2,'PRIVATE-CANARY-SOURCE detail.',1)",
            &[&fragment_id, &memory_id, &detail_id],
        )
        .await
        .unwrap();
    let cases = vec![
        json!({"arguments": {"query":"TargetInvocationException", "scope":scope},
            "expected": {"/results/0/fragmentId":fragment_id}}),
        json!({"arguments": {"query":"System.Reflection.TargetInvocationException", "scope":scope},
            "expected": {"/results/0/memoryId":memory_id}}),
        json!({"arguments": {"query":"TargetInvocationException AuthFlow rollout", "scope":scope,
            "matchMode":"all", "contextLimit":1, "diagnostics":true},
            "expected": {"/results/0/fragmentId":fragment_id, "/results/0/documentContext/orderKnown":true,
                "/results/0/documentContext/fragments/0/fragmentId":detail_id}}),
        json!({"arguments": {"query":"missingterm TargetInvocationException", "scope":scope, "matchMode":"any"},
            "expected": {"/results/0/fragmentId":fragment_id}}),
        json!({"arguments": {"query":"\"underlying error\"", "scope":scope},
            "expected": {"/results/0/fragmentId":fragment_id}}),
        json!({"arguments": {"query":"TargetInvocationException -wraps", "scope":scope},
            "expected": {"/results":[]}}),
        json!({"arguments": {"query":"TargetInvocationException", "scope":format!("wrong-{scope}")},
            "expected": {"/results":[]}}),
        json!({"arguments": {"fragmentId":fragment_id, "scope":scope},
            "expected": {"/rawText":raw_text, "/fragmentId":fragment_id}}),
    ];
    let path = directory.path().join("canaries.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({"version":1,"cases":cases})).unwrap(),
    )
    .unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command
        .current_dir(directory.path())
        .env_clear()
        .env("MINDLEAK_DATABASE_URL", database_url())
        .args(["--migrate-only", "--migration-canaries"])
        .arg(&path);
    let accepted = command.output().await.unwrap();
    let mut invalid = cases;
    invalid[0]["expected"]["/results/0/fragmentId"] = json!("PRIVATE-CANARY-EXPECTATION");
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({"version":1,"cases":invalid})).unwrap(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let rejected = Command::new(env!("CARGO_BIN_EXE_mindleak-light"))
        .current_dir(directory.path())
        .env_clear()
        .env("MINDLEAK_DATABASE_URL", database_url())
        .env("MINDLEAK_HTTP_TOKEN", TOKEN)
        .args([
            "--transport",
            "http",
            "--listen",
            &address.to_string(),
            "--migration-canaries",
        ])
        .arg(&path)
        .output()
        .await
        .unwrap();
    let healthy = Client::new()
        .get(format!("http://{address}/health"))
        .send()
        .await
        .is_ok();
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id=$1",
            &[&agent_id],
        )
        .await
        .unwrap()
        .get(0);
    let any_matches = database.query_one(
        "SELECT count(*), count(*) FILTER (WHERE fragments.id <> $2) FROM public.fragments
         JOIN public.memories ON memories.id = fragments.memory_id
         WHERE context->>'scope' = $1 AND search_vector @@ (
            SELECT coalesce(string_agg(quote_literal(term), ' | '), '')::tsquery
            FROM unnest(tsvector_to_array(to_tsvector('english', 'missingterm TargetInvocationException'))) AS terms(term))",
        &[&scope, &fragment_id],
    ).await.unwrap();
    database
        .execute("DELETE FROM public.memories WHERE id=$1", &[&memory_id])
        .await
        .unwrap();
    drop(store);
    assert_eq!(
        any_matches.get::<_, i64>(0),
        1,
        "literal-any fixture must have one matching fragment"
    );
    assert_eq!(
        any_matches.get::<_, i64>(1),
        0,
        "literal-any fixture must not match the detail fragment"
    );
    assert!(
        accepted.status.success(),
        "literal_any_matches={} other_fragments={} {}",
        any_matches.get::<_, i64>(0),
        any_matches.get::<_, i64>(1),
        String::from_utf8_lossy(&accepted.stderr)
    );
    assert!(!rejected.status.success());
    assert!(
        !healthy,
        "readiness must not be advertised after a failed canary"
    );
    assert_eq!(count, 1, "canaries must be read-only");
    assert!(accepted.stdout.is_empty() && rejected.stdout.is_empty());
    for output in [&accepted.stderr, &rejected.stderr] {
        let log = String::from_utf8_lossy(output);
        assert!(!log.contains("PRIVATE-CANARY-SOURCE"));
        assert!(!log.contains("PRIVATE-CANARY-EXPECTATION"));
        assert!(!log.contains(TOKEN));
        assert!(log.contains("phase=canaries") || log.contains("phase=\"canaries\""));
    }
    assert!(String::from_utf8_lossy(&accepted.stderr).contains("completed_rows=8"));
}

#[tokio::test]
async fn killed_runtime_resumes_checkpoint_and_never_serves_a_partial_upgrade() {
    let directory = tempfile::tempdir().unwrap();
    let (admin, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let name = format!("mindleak_process_{}_test", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    let mut url = Url::parse(&database_url()).unwrap();
    url.set_path(&name);
    let store = PostgresMemoryStore::connect(url.as_str(), None, 1, None)
        .await
        .unwrap();
    drop(store);
    let (database, connection) = tokio_postgres::connect(url.as_str(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    database
        .batch_execute(
            "INSERT INTO public.memories(id, agent_id, raw_text, context)
         SELECT ('00000000-0000-0000-0000-' || lpad(number::text,12,'0'))::uuid,
             'process-regression', 'System.Reflection.TargetInvocationException wraps error.',
             '{\"scope\":\"process-canary\",\"source\":\"wiki/AuthFlow\"}'::jsonb
         FROM generate_series(1,129) AS number;
         INSERT INTO public.fragments(id, memory_id, text, fragment_index)
         SELECT id, id, raw_text, 0 FROM public.memories;
         ALTER TABLE public.fragments DROP COLUMN search_vector CASCADE;
         SELECT pg_advisory_lock(6743148022);
         CREATE FUNCTION public.block_last_batch() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
             IF NEW.id = '00000000-0000-0000-0000-000000000129'::uuid THEN
                 PERFORM pg_advisory_xact_lock(6743148022);
             END IF;
             RETURN NEW;
         END $$;
         CREATE TRIGGER block_last_batch BEFORE UPDATE ON public.fragments
             FOR EACH ROW EXECUTE FUNCTION public.block_last_batch();",
        )
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let mut child = Command::new(env!("CARGO_BIN_EXE_mindleak-light"))
        .current_dir(directory.path())
        .env_clear()
        .env("MINDLEAK_DATABASE_URL", url.as_str())
        .env("MINDLEAK_HTTP_TOKEN", TOKEN)
        .env("MINDLEAK_MIGRATION_BATCH_SIZE", "16")
        .args(["--transport", "http", "--listen", &address.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let blocked: bool = database
                .query_one(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                 AND application_name='mindleak-light-migration' AND wait_event='advisory')",
                    &[],
                )
                .await
                .unwrap()
                .get(0);
            if blocked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let partial_healthy = Client::new()
        .get(format!("http://{address}/health"))
        .send()
        .await
        .is_ok();
    child.start_kill().unwrap();
    let killed = child.wait_with_output().await.unwrap();
    let completed: i64 = database
        .query_one(
            "SELECT count(*) FROM public.fragments WHERE search_vector IS NOT NULL",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    database
        .batch_execute(
            "CREATE TEMP TABLE completed_batches AS SELECT id, xmin::text AS original_xmin
        FROM public.fragments WHERE search_vector IS NOT NULL;
        SELECT pg_advisory_unlock(6743148022);
        DROP TRIGGER block_last_batch ON public.fragments",
        )
        .await
        .unwrap();
    let manifest = directory.path().join("canaries.json");
    std::fs::write(&manifest, serde_json::to_vec(&json!({"version":1,"cases":[{
        "arguments":{"query":"TargetInvocationException AuthFlow","matchMode":"all","scope":"process-canary","limit":1},
        "expected":{"/results/0/text":"System.Reflection.TargetInvocationException wraps error."}
    }]})).unwrap()).unwrap();
    let resumed = Command::new(env!("CARGO_BIN_EXE_mindleak-light"))
        .current_dir(directory.path())
        .env_clear()
        .env("MINDLEAK_DATABASE_URL", url.as_str())
        .env("MINDLEAK_MIGRATION_BATCH_SIZE", "16")
        .args(["--migrate-only", "--migration-canaries"])
        .arg(&manifest)
        .output()
        .await
        .unwrap();
    let unchanged: bool = database
        .query_one(
            "SELECT NOT EXISTS(SELECT 1 FROM public.fragments
        JOIN completed_batches USING(id) WHERE fragments.xmin::text <> original_xmin)",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    admin
        .batch_execute(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .await
        .unwrap();
    assert!(!partial_healthy);
    assert!(!killed.status.success() && killed.stdout.is_empty());
    assert_eq!(completed, 128);
    assert!(unchanged);
    assert!(
        resumed.status.success(),
        "{}",
        String::from_utf8_lossy(&resumed.stderr)
    );
    assert!(String::from_utf8_lossy(&resumed.stderr)
        .contains("retrieval canaries passed before readiness"));
}

#[tokio::test]
#[ignore = "explicit populated-database capacity drill; see docs/MIGRATIONS.md"]
async fn large_corpus_v02_upgrade_preserves_data_and_passes_runtime_canaries() {
    let directory = tempfile::tempdir().unwrap();
    let memory_count: i64 = std::env::var("MINDLEAK_MIGRATION_SCALE_MEMORIES")
        .unwrap_or_else(|_| "2048".into())
        .parse()
        .unwrap();
    assert!((1..=519_422).contains(&memory_count));
    let extra = if memory_count == 519_422 { 6_363 } else { 0 };
    let (admin, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let name = format!("mindleak_capacity_{}_test", Uuid::new_v4().simple());
    eprintln!("capacity drill owns disposable database {name}");
    admin
        .batch_execute(&format!("CREATE DATABASE {name}"))
        .await
        .unwrap();
    let mut url = Url::parse(&database_url()).unwrap();
    url.set_path(&name);
    let mut execution = tokio::spawn(async move {
        let (database, connection) = tokio_postgres::connect(url.as_str(), tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        database
            .batch_execute(&format!(
                include_str!("../crates/mindleak-storage-postgres/schema.sql"),
                dimensions = 2
            ))
            .await
            .unwrap();
        for sql in [
            include_str!(
                "../crates/mindleak-storage-postgres/migrations/0002-optional-embeddings.sql"
            ),
            include_str!("../crates/mindleak-storage-postgres/migrations/0003-fact-lifecycle.sql"),
        ] {
            database.batch_execute(sql).await.unwrap();
        }
        database
            .batch_execute(
                "SET statement_timeout='120s'; SET lock_timeout='5s';
        COMMENT ON TABLE public.fragments IS '{\"model\":\"test-model\",\"dimensions\":2}'",
            )
            .await
            .unwrap();
        let seed_started = Instant::now();
        for first in (1..=memory_count).step_by(4096) {
            let last = (first + 4095).min(memory_count);
            database.execute(
            "WITH sources AS MATERIALIZED (
                SELECT number,
                    ('00000000-0000-0000-0000-' || lpad(number::text,12,'0'))::uuid AS id,
                    11 + CASE WHEN number <= $3 THEN 1 ELSE 0 END AS fragments
                FROM generate_series($1::bigint,$2::bigint) AS number
             ) INSERT INTO public.memories(id, agent_id, raw_text, context, created_at)
             SELECT id, 'capacity-fixture',
                (SELECT string_agg('Corpus' || sources.number || ' Step' || step ||
                    ' System.Reflection.TargetInvocationException wraps underlying error.', E'\n' ORDER BY step)
                 FROM generate_series(1, sources.fragments) AS step),
                jsonb_build_object('scope','capacity-fixture','sessionId','seed-session',
                    'source','https://docs.example.com/wiki/AuthFlow/config-file.md',
                    'summary',repeat('Release review preserves exact context and rollback evidence. ',8)),
                '2026-01-01T00:00:00Z'
             FROM sources",
            &[&first, &last, &extra],
        ).await.unwrap();
            database.execute(
            "INSERT INTO public.fragments(id, memory_id, text, embedding, tier, pinned,
                useful_sessions, confirmed_sessions, reinforced_at, first_evidence_at)
             SELECT ('10000000-0000-0000-' || lpad(step::text,4,'0') || '-' || lpad(number::text,12,'0'))::uuid,
                ('00000000-0000-0000-0000-' || lpad(number::text,12,'0'))::uuid,
                'Corpus' || number || ' Step' || step || ' System.Reflection.TargetInvocationException wraps underlying error.',
                CASE WHEN step % 2 = 0 THEN '[1,0]'::vector ELSE NULL END,
                CASE WHEN step % 2 = 0 THEN 'long_term' ELSE 'short_term' END,
                step = 2, CASE WHEN step = 2 THEN 4 ELSE 0 END,
                CASE WHEN step = 2 THEN 3 ELSE 0 END,
                '2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z'
             FROM generate_series($1::bigint,$2::bigint) AS number
             CROSS JOIN LATERAL generate_series(1,11 + CASE WHEN number <= $3 THEN 1 ELSE 0 END) AS step",
            &[&first, &last, &extra],
        ).await.unwrap();
        }
        database
        .execute(
            "INSERT INTO public.relationships(source_fragment,target_fragment,relationship_type)
         SELECT ('10000000-0000-0000-0001-' || lpad(number::text,12,'0'))::uuid,
                ('10000000-0000-0000-0002-' || lpad(number::text,12,'0'))::uuid, 'supports'
         FROM generate_series(1,$1::bigint) AS number",
            &[&memory_count],
        )
        .await
        .unwrap();
        database
            .batch_execute(
                "ANALYZE public.memories; ANALYZE public.fragments; ANALYZE public.relationships",
            )
            .await
            .unwrap();
        let seed_ms = seed_started.elapsed().as_millis();
        let fingerprint_sql = "SELECT json_build_array(
        (SELECT json_build_array(count(*), sum(hashtextextended((to_jsonb(memories) - 'request_id' - 'request_payload' - 'write_result')::text,0)::numeric)::text)
         FROM public.memories),
        (SELECT json_build_array(count(*), sum(hashtextextended((to_jsonb(fragments) - 'search_vector' - 'fragment_index')::text,0)::numeric)::text)
         FROM public.fragments),
        (SELECT json_build_array(count(*), sum(hashtextextended(to_jsonb(relationships)::text,0)::numeric)::text)
         FROM public.relationships), obj_description('public.fragments'::regclass,'pg_class'))::text";
        let before: String = database
            .query_one(fingerprint_sql, &[])
            .await
            .unwrap()
            .get(0);
        let before_bytes: i64 = database
            .query_one("SELECT pg_database_size(current_database())", &[])
            .await
            .unwrap()
            .get(0);
        let manifest = directory.path().join("canaries.json");
        let mut cases = Vec::new();
        for source in [1, memory_count / 2 + 1, memory_count] {
            let expected_id = format!("10000000-0000-0000-0002-{source:012}");
            for (query, mode) in [
                (
                    format!("Corpus{source} Step2 TargetInvocationException"),
                    "websearch",
                ),
                (format!("Corpus{source} Step2 AuthFlow review"), "all"),
                (
                    format!("Corpus{source} Step2 \"underlying error\""),
                    "websearch",
                ),
            ] {
                cases.push(json!({"arguments":{"query":query,"scope":"capacity-fixture","matchMode":mode,"limit":1,"contextLimit":1},
                "expected":{"/results/0/fragmentId":expected_id,"/results/0/fragmentIndex":1,
                    "/results/0/documentContext/orderKnown":true}}));
            }
            cases.push(json!({"arguments":{"query":format!("Corpus{source} Step2 -wraps"),"scope":"capacity-fixture"},
            "expected":{"/results":[]}}));
        }
        let canary_count = cases.len();
        std::fs::write(
            &manifest,
            serde_json::to_vec(&json!({"version":1,"cases":cases})).unwrap(),
        )
        .unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
        command
            .current_dir(directory.path())
            .env_clear()
            .env("MINDLEAK_DATABASE_URL", url.as_str())
            .args(["--migrate-only", "--migration-canaries"])
            .arg(&manifest)
            .kill_on_drop(true);
        let started = Instant::now();
        let migrated = tokio::time::timeout(Duration::from_secs(1800), command.output())
            .await
            .unwrap()
            .unwrap();
        let migration_ms = started.elapsed().as_millis();
        let after: String = database
            .query_one(fingerprint_sql, &[])
            .await
            .unwrap()
            .get(0);
        let derived = database.query_one(
        "SELECT count(*), count(*) FILTER (WHERE search_vector IS NULL OR fragment_index IS NULL),
         count(*) FILTER (WHERE fragment_index <> split_part(id::text,'-',4)::integer - 1),
         sum(hashtextextended(xmin::text,0)::numeric)::text FROM public.fragments", &[]
    ).await.unwrap();
        let final_bytes: i64 = database
            .query_one("SELECT pg_database_size(current_database())", &[])
            .await
            .unwrap()
            .get(0);
        let started = Instant::now();
        let restarted = tokio::time::timeout(Duration::from_secs(15), command.output())
            .await
            .unwrap()
            .unwrap();
        let restart_ms = started.elapsed().as_millis();
        let restart_xmin: String = database
            .query_one(
                "SELECT sum(hashtextextended(xmin::text,0)::numeric)::text FROM public.fragments",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        let settings = database
            .query_one(
                "SELECT current_setting('fsync'), current_setting('full_page_writes'),
        current_setting('synchronous_commit'), version()",
                &[],
            )
            .await
            .unwrap();
        let log = String::from_utf8_lossy(&migrated.stderr);
        eprintln!(
            "{}",
            json!({"memories":memory_count,"fragments":memory_count*11+extra,"relationships":memory_count,
        "seedMs":seed_ms,"migrationAndCanariesMs":migration_ms,"restartAndCanariesMs":restart_ms,
        "beforeBytes":before_bytes,"afterBytes":final_bytes,"canaries":canary_count,
        "beforeFingerprint":serde_json::from_str::<Value>(&before).unwrap(),
        "afterFingerprint":serde_json::from_str::<Value>(&after).unwrap(),
        "fsync":settings.get::<_,String>(0),"fullPageWrites":settings.get::<_,String>(1),
        "synchronousCommit":settings.get::<_,String>(2),"postgres":settings.get::<_,String>(3),
        "migrationSucceeded":migrated.status.success(),"restartSucceeded":restarted.status.success()})
        );
        assert!(migrated.status.success(), "{log}");
        assert!(
            restarted.status.success(),
            "{}",
            String::from_utf8_lossy(&restarted.stderr)
        );
        assert_eq!(before, after);
        assert_eq!(derived.get::<_, i64>(0), memory_count * 11 + extra);
        assert_eq!(derived.get::<_, i64>(1), 0);
        assert_eq!(derived.get::<_, i64>(2), 0);
        assert_eq!(derived.get::<_, String>(3), restart_xmin);
        assert!(!String::from_utf8_lossy(&restarted.stderr).contains("phase=\"backfill\""));
        assert!(log.contains(&format!("completed_rows={canary_count}")));
        for position in 0..3 {
            assert_eq!(settings.get::<_, String>(position), "on");
        }
    });
    let outcome = tokio::select! {
        result = &mut execution => result,
        _ = tokio::signal::ctrl_c() => {
            execution.abort();
            execution.await
        }
    };
    admin
        .batch_execute(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .await
        .unwrap();
    eprintln!("capacity drill removed disposable database {name}");
    outcome.unwrap();
}

#[tokio::test]
async fn duplicate_groups_preserve_each_returned_source_and_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("duplicate-groups-{}", Uuid::new_v4());
    let scope = format!("duplicate-scope-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "keyword".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
    ]);
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let mut receipts = Vec::new();
    for index in 0..3 {
        let text = if index < 2 {
            "Restart the application pool."
        } else {
            "Never restart the application pool."
        };
        let written = client.call_tool(call("write_memory", json!({
            "agentId": agent_id, "text": format!("{text}\nGuide detail {index}."),
            "context": {"scope": scope, "source": format!("runbook-{index}"), "sessionId": format!("episode-{index}")},
            "facts": [{"text": text, "pinned": index == 1}]
        }))).await.unwrap();
        assert_ne!(written.is_error, Some(true));
        receipts.push(written.structured_content.unwrap());
    }
    let mut request = json!({"agentId": agent_id, "scope": scope, "query": "restart", "limit": 10, "contextLimit": 1});
    let recalls_started = Instant::now();
    let original = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(original["results"].as_array().unwrap().len(), 3);
    request["groupDuplicates"] = json!(true);
    let grouped = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap();
    assert_ne!(grouped.is_error, Some(true));
    let grouped = grouped.structured_content.unwrap();
    let groups = grouped["results"].as_array().unwrap();
    assert_eq!(
        groups.len(),
        2,
        "negation must not be collapsed into an affirmative fact"
    );
    let positive = groups
        .iter()
        .find(|group| group["text"] == "Restart the application pool.")
        .unwrap();
    assert_eq!(positive["sourceCount"], 2);
    let sources: Vec<_> = std::iter::once(positive)
        .chain(positive["duplicateSources"].as_array().unwrap())
        .collect();
    assert_eq!(sources.len(), 2);
    for source in sources {
        let original = original["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["fragmentId"] == source["fragmentId"])
            .unwrap();
        for field in [
            "memoryId",
            "fragmentId",
            "agentId",
            "context",
            "lifecycle",
            "score",
            "relationships",
            "relationshipCount",
            "relationshipCountExact",
            "relationshipsTruncated",
            "documentContext",
            "fragmentIndex",
        ] {
            assert_eq!(source[field], original[field], "provenance field: {field}");
        }
        let activation = source["activation"].as_f64().unwrap();
        let original_activation = original["activation"].as_f64().unwrap();
        let half_life_seconds = if source["lifecycle"]["tier"] == "long_term" {
            90.0 * 86_400.0
        } else {
            7.0 * 86_400.0
        };
        let elapsed_seconds_with_rounding = recalls_started.elapsed().as_secs_f64() + 1.0;
        let minimum_activation =
            original_activation * (-elapsed_seconds_with_rounding / half_life_seconds).exp2();
        assert!(
            (minimum_activation..=original_activation).contains(&activation),
            "activation must preserve its source and decay only by elapsed recall time"
        );
        if source["lifecycle"]["pinned"] == true {
            assert_eq!(activation, original_activation);
        }
        let score = source["score"].as_f64().unwrap();
        let expected_priority = score - score.abs() * 0.25 * (1.0 - activation);
        assert!(
            (source["rankingPriority"].as_f64().unwrap() - expected_priority).abs() < 1e-12,
            "ranking priority must use this snapshot's activation and original score"
        );
        assert_eq!(source["lifecycle"]["confirmedSessions"], 0);
    }
    for search_control in [
        json!({"matchMode": "any"}),
        json!({"diagnostics": true}),
        json!({"contextLimit": 1}),
        json!({"groupDuplicates": true}),
    ] {
        let mut inspection = json!({
            "fragmentId": receipts[0]["fragments"][0]["fragmentId"],
            "agentId": agent_id,
            "scope": scope,
        });
        inspection
            .as_object_mut()
            .unwrap()
            .extend(search_control.as_object().unwrap().clone());
        assert!(client
            .call_tool(call("recall_memory", inspection))
            .await
            .is_err());
    }
    let mut limited = request.clone();
    limited["limit"] = json!(1);
    let limited = client
        .call_tool(call("recall_memory", limited))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(limited["results"].as_array().unwrap().len(), 1);
    assert_eq!(
        limited["results"][0]["sourceCount"], 1,
        "group counts cover only the returned working set"
    );
    let archived = client.call_tool(call("write_memory", json!({
        "agentId": agent_id, "text": "Archive the older instruction.", "context": {"scope": scope},
        "facts": [{"text": "Archive the older instruction.", "links": [{
            "targetFragmentId": receipts[0]["fragments"][0]["fragmentId"], "relationshipType": "archives"
        }]}]
    }))).await.unwrap();
    assert_ne!(archived.is_error, Some(true));
    let active = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let active_positive = active["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["text"] == "Restart the application pool.")
        .unwrap();
    assert_eq!(active_positive["sourceCount"], 1);
    request["includeInactive"] = json!(true);
    let history = client
        .call_tool(call("recall_memory", request))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let historical = history["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["text"] == "Restart the application pool.")
        .unwrap();
    assert_eq!(historical["sourceCount"], 2);
    assert!(historical["duplicateSources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|source| source["lifecycle"]["state"] == "archived"));
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn document_context_returns_bounded_same_episode_steps() {
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("document-context-{}", Uuid::new_v4());
    let scope = format!("document-scope-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "keyword".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
    ]);
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let written = client
        .call_tool(call(
            "write_memory",
            json!({
                "agentId": agent_id,
                "text": "# PoolRecovery\n1. Check permissions.\n2. Restart the application pool.\n3. Verify the health probe.",
                "context": {"scope": scope, "source": "test-runbook"}
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(written["fragments"].as_array().unwrap().len(), 4);
    let mut request =
        json!({"agentId": agent_id, "scope": scope, "query": "PoolRecovery", "limit": 1});
    let ordinary = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap();
    assert!(ordinary.structured_content.unwrap()["results"][0]
        .get("documentContext")
        .is_none());
    request["contextLimit"] = json!(2);
    let expanded = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap();
    assert_ne!(expanded.is_error, Some(true));
    let expanded = expanded.structured_content.unwrap();
    let primary = &expanded["results"][0];
    assert_eq!(expanded["results"].as_array().unwrap().len(), 1);
    assert_eq!(primary["fragmentId"], written["fragments"][0]["fragmentId"]);
    let context = &primary["documentContext"];
    assert_eq!(context["fragments"].as_array().unwrap().len(), 2);
    assert_eq!(context["truncated"], true);
    for (index, fragment) in context["fragments"].as_array().unwrap().iter().enumerate() {
        assert_eq!(fragment["memoryId"], written["memoryId"]);
        assert_eq!(
            fragment["fragmentId"],
            written["fragments"][index + 1]["fragmentId"]
        );
        assert_eq!(fragment["text"], written["fragments"][index + 1]["text"]);
        assert_eq!(fragment["fragmentIndex"], index + 1);
        assert_eq!(fragment["context"]["scope"], scope);
        assert!(fragment.get("score").is_none());
    }
    let archived = client.call_tool(call("write_memory", json!({
        "agentId": agent_id, "text": "Archive the old permission step.",
        "context": {"scope": scope},
        "facts": [{"text": "Archive the old permission step.", "links": [{
            "targetFragmentId": written["fragments"][1]["fragmentId"], "relationshipType": "archives"
        }]}]
    }))).await.unwrap();
    assert_ne!(archived.is_error, Some(true));
    let current = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let steps = current["results"][0]["documentContext"]["fragments"]
        .as_array()
        .unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(
        steps[0]["fragmentId"],
        written["fragments"][2]["fragmentId"]
    );
    assert_eq!(
        steps[1]["fragmentId"],
        written["fragments"][3]["fragmentId"]
    );
    assert_eq!(current["results"][0]["documentContext"]["truncated"], false);
    request["includeInactive"] = json!(true);
    let history = client
        .call_tool(call("recall_memory", request))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(
        history["results"][0]["documentContext"]["fragments"][0]["lifecycle"]["state"],
        "archived"
    );
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn keyword_match_modes_and_diagnostics_use_the_postgresql_query() {
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("query-options-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "keyword".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
    ]);
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let written = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": "Restart the application pool. Check permissions first."}),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    for (mode, count) in [("websearch", 0), ("all", 0), ("any", 2)] {
        let recalled = client
            .call_tool(call(
                "recall_memory",
                json!({
                    "agentId": agent_id, "query": "restart permissions",
                    "matchMode": mode, "diagnostics": true
                }),
            ))
            .await
            .expect("recall must accept explicit matching and diagnostics");
        assert_ne!(recalled.is_error, Some(true));
        let response = recalled.structured_content.unwrap();
        assert_eq!(response["results"].as_array().unwrap().len(), count);
        let diagnostics = &response["diagnostics"];
        assert_eq!(diagnostics["strategy"], "keyword");
        assert_eq!(diagnostics["keyword"]["matchMode"], mode);
        assert_eq!(
            diagnostics["keyword"]["terms"],
            json!(["permiss", "restart"])
        );
        let parsed = diagnostics["keyword"]["parsedQuery"].as_str().unwrap();
        assert!(parsed.contains(if mode == "any" { " | " } else { " & " }));
    }
    for query in [
        "restart' | !permissions",
        "O'Reilly",
        "foo\\bar",
        "foo:*",
        "\"",
        "-",
    ] {
        let literal = client
            .call_tool(call(
                "recall_memory",
                json!({
                    "agentId": agent_id, "query": query, "matchMode": "any", "diagnostics": true
                }),
            ))
            .await
            .unwrap();
        assert_ne!(literal.is_error, Some(true), "literal query: {query}");
    }
    let empty = client
        .call_tool(call(
            "recall_memory",
            json!({"agentId": agent_id, "query": "the and", "matchMode": "any", "diagnostics": true}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert!(empty["results"].as_array().unwrap().is_empty());
    assert_eq!(empty["diagnostics"]["keyword"]["parsedQuery"], "");
    assert_eq!(empty["diagnostics"]["keyword"]["terms"], json!([]));
    assert_eq!(
        client
            .call_tool(call(
                "recall_memory",
                json!({"query": "restart", "matchMode": "unknown"})
            ))
            .await
            .unwrap()
            .is_error,
        Some(true)
    );
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn write_request_replays_committed_result_after_restart_without_model_calls() {
    let provider = provider().await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("retry-write-{}", Uuid::new_v4());
    let arguments = json!({
        "agentId": agent_id,
        "text": FACTS.join(". "),
        "requestId": Uuid::new_v4(),
        "context": {"scope": "retry-test", "sessionId": "original-session"}
    });
    let mut original = None;
    for attempt in 0..2 {
        let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
        command.current_dir(directory.path()).env_clear().envs([
            ("MINDLEAK_DATABASE_URL", database_url()),
            ("MINDLEAK_DECOMPOSITION", "openai".into()),
            ("MINDLEAK_RETRIEVAL", "vector".into()),
            ("MINDLEAK_RELEVANCE", "off".into()),
            ("MINDLEAK_MODEL", "test-model".into()),
            ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
            ("MINDLEAK_EMBED_MODEL", "test-model".into()),
            ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
            ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ]);
        let client = tokio::time::timeout(
            Duration::from_secs(15),
            ().serve(TokioChildProcess::new(command).unwrap()),
        )
        .await
        .unwrap()
        .unwrap();
        let written = client
            .call_tool(call("write_memory", arguments.clone()))
            .await
            .expect("write_memory must accept an optional requestId");
        assert_ne!(written.is_error, Some(true));
        let result = written.structured_content.unwrap();
        if let Some(original) = &original {
            assert_eq!(&result, original, "retry must replay the committed receipt");
        } else {
            assert_eq!(result["fragments"].as_array().unwrap().len(), FACTS.len());
            original = Some(result);
        }
        if attempt == 1 {
            for field in ["text", "context", "facts"] {
                let mut conflict = arguments.clone();
                conflict[field] = match field {
                    "text" => json!("A different write."),
                    "context" => json!({"scope": "another-project"}),
                    _ => json!([{"text": FACTS[0], "pinned": true}]),
                };
                assert!(client
                    .call_tool(call("write_memory", conflict))
                    .await
                    .is_err());
            }
            let mut invalid = arguments.clone();
            invalid["requestId"] = json!("not-a-uuid");
            assert_eq!(
                client
                    .call_tool(call("write_memory", invalid))
                    .await
                    .unwrap()
                    .is_error,
                Some(true)
            );
            let repeated = client
                .call_tool(call("write_memory", arguments.clone()))
                .await
                .unwrap();
            assert_ne!(repeated.is_error, Some(true));
            assert_eq!(repeated.structured_content, original);
        }
        client.cancel().await.unwrap();
        if attempt == 0 {
            provider.reset().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(503))
                .expect(0)
                .mount(&provider)
                .await;
        }
    }
    assert!(provider.received_requests().await.unwrap().is_empty());
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id = $1",
            &[&agent_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 1, "retry must not create a second episode");
}

#[tokio::test]
async fn invalid_provider_data_never_reports_success_or_leaves_partial_memories() {
    let provider = MockServer::start().await;
    let scenario = Arc::new(AtomicUsize::new(0));
    let chat_scenario = scenario.clone();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(move |_: &Request| {
            let mut body = json!({"choices": [{"finish_reason": "stop", "message": {
                "content": json!({"fragments": FACTS}).to_string()
            }}]});
            if chat_scenario.load(Ordering::SeqCst) == 2 {
                body["metadata"] = json!("x".repeat(4 * 1024 * 1024));
            }
            ResponseTemplate::new(200).set_body_json(body)
        })
        .mount(&provider)
        .await;
    let embedding_scenario = scenario.clone();
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(move |request: &Request| {
            let scenario = embedding_scenario.load(Ordering::SeqCst);
            let request: Value = request.body_json().unwrap();
            let vector = if scenario == 1 {
                [1e-30, 0.0]
            } else {
                [1.0, 0.0]
            };
            let data: Vec<_> = request["input"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(index, _)| json!({"index": index, "embedding": vector}))
                .collect();
            let mut body = json!({
                "model": if scenario == 0 { "different-test-model" } else { "test-model" },
                "data": data
            });
            if scenario == 3 {
                body["metadata"] = json!("x".repeat(4 * 1024 * 1024));
            }
            ResponseTemplate::new(200).set_body_json(body)
        })
        .mount(&provider)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("provider-validation-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "openai".into()),
        ("MINDLEAK_RETRIEVAL", "vector".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
        ("MINDLEAK_MODEL", "test-model".into()),
        ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ("MINDLEAK_RECALL_MIN_SIMILARITY", "0.9".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    for current in 0..4 {
        scenario.store(current, Ordering::SeqCst);
        let written = client
            .call_tool(call(
                "write_memory",
                json!({
                    "agentId": agent_id, "text": FACTS.join(". ")
                }),
            ))
            .await
            .unwrap();
        assert_eq!(
            written.is_error,
            Some(true),
            "invalid scenario {current} must fail"
        );
        let count: i64 = database
            .query_one(
                "SELECT count(*) FROM public.memories WHERE agent_id = $1",
                &[&agent_id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 0, "failed writes must not leave raw memories");
    }
    scenario.store(4, Ordering::SeqCst);
    let written = client
        .call_tool(call(
            "write_memory",
            json!({
                "agentId": agent_id, "text": FACTS.join(". ")
            }),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    for current in [0, 1, 3] {
        scenario.store(current, Ordering::SeqCst);
        let recalled = client
            .call_tool(call(
                "recall_memory",
                json!({
                    "agentId": agent_id, "query": format!("provider-probe-{current}"), "limit": 5
                }),
            ))
            .await
            .unwrap();
        assert_eq!(
            recalled.is_error,
            Some(true),
            "invalid scenario {current} must not be an empty success"
        );
    }
    scenario.store(4, Ordering::SeqCst);
    let recalled = client
        .call_tool(call(
            "recall_memory",
            json!({
                "agentId": agent_id, "query": "provider-probe-0", "limit": 5
            }),
        ))
        .await
        .unwrap();
    assert_ne!(recalled.is_error, Some(true));
    let content = recalled.structured_content.unwrap();
    let results = content["results"].as_array().unwrap();
    assert_eq!(results.len(), FACTS.len());
    assert!(results
        .iter()
        .all(|result| result["score"].as_f64().is_some_and(f64::is_finite)));
    client.cancel().await.unwrap();
    database
        .execute(
            "DELETE FROM public.memories WHERE agent_id = $1",
            &[&agent_id],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn vector_recall_honors_a_configured_similarity_floor() {
    for retrieval in ["vector", "hybrid"] {
        assert_similarity_floor(retrieval).await;
    }
}

async fn assert_similarity_floor(retrieval: &str) {
    let provider = provider().await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("relevance-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", retrieval.into()),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ("MINDLEAK_RECALL_MIN_SIMILARITY", "0.5".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    let written = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": "Team requires reviews."}),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    let relevant = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "reviews", "agentId": agent_id, "limit": 5}),
        ))
        .await
        .unwrap();
    let unrelated = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "PR preferences?", "agentId": agent_id, "limit": 5}),
        ))
        .await
        .unwrap();
    client.cancel().await.unwrap();
    assert_eq!(
        relevant.structured_content.unwrap()["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(unrelated.structured_content.unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn relevance_model_filters_candidates_without_changing_facts_or_hiding_failures() {
    let provider = provider().await;
    let relevance = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(|request: &Request| {
            let body: Value = request.body_json().unwrap();
            let input: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            let selected: Vec<Value> = if input["query"] == "What approval is required?" {
                input["candidates"].as_array().unwrap().iter()
                    .filter(|candidate| candidate["text"] == "Team requires reviews.")
                    .map(|candidate| json!({"index": candidate["index"], "evidence": candidate["text"]}))
                    .collect()
            } else {
                vec![]
            };
            ResponseTemplate::new(200).set_body_json(json!({"choices": [{
                "finish_reason": "stop", "message": {"content": json!({"requested_detail": "approval requirement", "relevant": selected}).to_string()}
            }]}))
        })
        .mount(&relevance).await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("relevance-model-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "hybrid".into()),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ("MINDLEAK_RELEVANCE", "openai".into()),
        ("MINDLEAK_RELEVANCE_URL", format!("{}/v1", relevance.uri())),
        ("MINDLEAK_RELEVANCE_MODEL", "relevance-model".into()),
        ("MINDLEAK_RELEVANCE_CANDIDATES", "3".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 3);
    let written = client
        .call_tool(call(
            "write_memory",
            json!({
                "agentId": agent_id, "text": "Team requires reviews. The server uses PostgreSQL."
            }),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    let memory_id = written.structured_content.unwrap()["memoryId"].clone();
    let relevant = client
        .call_tool(call(
            "recall_memory",
            json!({
                "query": "What approval is required?", "agentId": agent_id, "limit": 1
            }),
        ))
        .await
        .unwrap();
    let content = relevant.structured_content.unwrap();
    let matches = content["results"].as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["memoryId"], memory_id);
    assert_eq!(matches[0]["text"], "Team requires reviews.");
    let absent = client
        .call_tool(call(
            "recall_memory",
            json!({
                "query": "What is the payroll budget?", "agentId": agent_id, "limit": 1
            }),
        ))
        .await
        .unwrap();
    assert_ne!(absent.is_error, Some(true));
    assert_eq!(absent.structured_content.unwrap()["results"], json!([]));
    relevance.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&relevance)
        .await;
    let failed = client
        .call_tool(call(
            "recall_memory",
            json!({
                "query": "What approval is required?", "agentId": agent_id, "limit": 1
            }),
        ))
        .await
        .unwrap();
    client.cancel().await.unwrap();
    assert_eq!(failed.is_error, Some(true));
}

#[tokio::test]
async fn real_stdio_process_decomposes_writes_recalls_and_refuses_failed_writes() {
    let provider = provider().await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("stdio-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "openai".into()),
        ("MINDLEAK_RETRIEVAL", "vector".into()),
        ("MINDLEAK_MODEL", "test-model".into()),
        ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        client
            .peer_info()
            .unwrap()
            .server_info
            .as_ref()
            .unwrap()
            .name,
        "mindleak-light"
    );
    assert_eq!(client.list_all_tools().await.unwrap().len(), 3);
    let preview = client
        .call_tool(call("decompose_memory", json!({"text": FACTS.join(". ")})))
        .await
        .unwrap();
    assert_eq!(preview.structured_content.unwrap()["results"], json!(FACTS));
    let written = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": FACTS.join(". ")}),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    let memory_id = written.structured_content.unwrap()["memoryId"]
        .as_str()
        .unwrap()
        .to_owned();
    let recalled = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "PR preferences?", "agentId": agent_id, "limit": 3}),
        ))
        .await
        .unwrap();
    let structured = recalled.structured_content.unwrap();
    let matches = structured["results"].as_array().unwrap();
    assert_eq!(matches.len(), 3);
    assert!(matches.iter().all(|item| item["memoryId"] == memory_id));
    assert_eq!(matches[2]["text"], FACTS[1]);
    assert_eq!(matches[0]["score"], 1.0);

    provider.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&provider)
        .await;
    let refused = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": "must not persist"}),
        ))
        .await
        .unwrap();
    assert_eq!(refused.is_error, Some(true));
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    let database_task = tokio::spawn(connection);
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id = $1",
            &[&agent_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 1);
    client.cancel().await.unwrap();
    drop(database);
    database_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn http_requires_auth_rejects_origins_and_serves_the_same_tools() {
    let provider = provider().await;
    let store = PostgresMemoryStore::connect(&database_url(), Some(("test-model", 2)), 4, None)
        .await
        .unwrap();
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let embedder = Arc::new(
        OpenAiEmbedder::new(
            client.clone(),
            Url::parse(&format!("{}/v1/embeddings", provider.uri())).unwrap(),
            "test-model".into(),
            String::new(),
            2,
        )
        .unwrap(),
    );
    let decomposer = Arc::new(OpenAiDecomposer::new(
        client.clone(),
        Url::parse(&format!("{}/v1/chat/completions", provider.uri())).unwrap(),
        "test-model".into(),
        String::new(),
    ));
    let retriever = Arc::new(VectorMemoryRetriever::new(store.clone(), embedder.clone()));
    let memory = MemoryService::new(
        Arc::new(store.clone()),
        decomposer,
        Some(embedder),
        retriever,
    );
    let cancellation = CancellationToken::new();
    assert!(http_router(
        MemoryMcp::new(memory.clone()),
        store.clone(),
        "short",
        cancellation.child_token()
    )
    .is_err());
    let router = http_router(
        MemoryMcp::new(memory),
        store,
        TOKEN,
        cancellation.child_token(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let shutdown = cancellation.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await
            .unwrap();
    });
    for route in ["health", "mcp"] {
        assert_eq!(
            client
                .get(format!("{base}/{route}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/{route}"))
                .bearer_auth("wrong")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        client
            .get(format!("{base}/health"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .post(format!("{base}/mcp"))
            .bearer_auth(TOKEN)
            .header("Origin", "https://example.com")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client
            .post(format!("{base}/mcp"))
            .bearer_auth(TOKEN)
            .body("x".repeat(256 * 1024 + 1))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let transport = StreamableHttpClientTransport::with_client(
        reqwest_mcp::Client::new(),
        StreamableHttpClientTransportConfig::with_uri(format!("{base}/mcp")).auth_header(TOKEN),
    );
    let sdk_client = ().serve(transport).await.unwrap();
    assert_eq!(sdk_client.list_all_tools().await.unwrap().len(), 3);
    let result = sdk_client
        .call_tool(call("decompose_memory", json!({"text": FACTS.join(". ")})))
        .await
        .unwrap();
    assert_eq!(result.structured_content.unwrap()["results"], json!(FACTS));
    sdk_client.cancel().await.unwrap();
    cancellation.cancel();
    server.await.unwrap();
}

#[test]
fn dotenv_settings_are_loaded_before_clap_resolves_transport() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join(".env"),
        "MINDLEAK_TRANSPORT=invalid\n",
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_mindleak-light"))
        .env_clear()
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("invalid value"),
        "unexpected error: {stderr}"
    );
}

#[tokio::test]
async fn model_free_stdio_works_without_models_and_makes_zero_provider_requests() {
    let provider = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&provider)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("model-free-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_MODEL", "test-model".into()),
        ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 3);
    let raw = "  The user dislikes huge PRs.\nThe team requires reviews.  ";
    let preview = client
        .call_tool(call("decompose_memory", json!({"text": raw})))
        .await
        .unwrap();
    assert_ne!(
        preview.is_error,
        Some(true),
        "default decomposition must not require a model"
    );
    assert_eq!(
        preview.structured_content.unwrap()["results"],
        json!(["The user dislikes huge PRs.", "The team requires reviews."])
    );
    let written = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": raw}),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    let memory_id = written.structured_content.unwrap()["memoryId"]
        .as_str()
        .unwrap()
        .to_owned();
    let recalled = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "reviews", "agentId": agent_id}),
        ))
        .await
        .unwrap();
    assert_ne!(recalled.is_error, Some(true));
    let matches = recalled.structured_content.unwrap();
    assert_eq!(matches["results"].as_array().unwrap().len(), 1);
    assert_eq!(matches["results"][0]["memoryId"], memory_id);
    assert_eq!(matches["results"][0]["text"], "The team requires reviews.");
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    let database_task = tokio::spawn(connection);
    let row = database.query_one(
        "SELECT raw_text, (SELECT count(*) FROM public.fragments WHERE memory_id = memories.id AND embedding IS NULL) \
         FROM public.memories AS memories WHERE id = $1", &[&Uuid::parse_str(&memory_id).unwrap()],
    ).await.unwrap();
    assert_eq!(row.get::<_, String>(0), raw);
    assert_eq!(row.get::<_, i64>(1), 2);
    assert!(provider.received_requests().await.unwrap().is_empty());
    client.cancel().await.unwrap();
    drop(database);
    database_task.await.unwrap().unwrap();
}
