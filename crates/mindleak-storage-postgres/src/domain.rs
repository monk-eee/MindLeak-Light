use std::collections::HashMap;

use anyhow::{ensure, Context, Result};
use mindleak_memory::{
    DomainCursor, DomainIdentity, DomainInspection, DomainQuery, DomainRecord, DomainWrite,
    EdgeProvenance, InvalidInput, PreparedMemory, RecallFilter, RelationshipDirection,
    MAX_RECALL_RESULT_BYTES, MAX_RELATIONSHIP_SCAN,
};
use tokio_postgres::{IsolationLevel, Row, Transaction};
use uuid::Uuid;

use crate::PostgresMemoryStore;

const RECORD_COLUMNS: &str = "memories.id AS memory_id, memories.agent_id, memories.raw_text,
    memories.context::text AS context, (memories.request_payload->'domain')::text AS domain";

fn record(row: &Row) -> Result<DomainRecord> {
    Ok(DomainRecord {
        memory_id: row.try_get("memory_id")?,
        agent_id: row.try_get("agent_id")?,
        raw_text: row.try_get("raw_text")?,
        context: serde_json::from_str(&row.try_get::<_, String>("context")?)?,
        domain: serde_json::from_str(&row.try_get::<_, String>("domain")?)?,
    })
}

async fn verify_edges(transaction: &Transaction<'_>, records: &[DomainRecord]) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }
    let ids: Vec<_> = records.iter().map(|record| record.memory_id).collect();
    let rows = transaction.query("SELECT ids.id, edge.domain_namespace, edge.domain_id, edge.predicate, edge.provenance::text,
        source.identity::text AS source_identity, target.identity::text AS target_identity,
        source.scope AS source_scope, target.scope AS target_scope
        FROM unnest($1::uuid[]) AS ids(id)
        CROSS JOIN LATERAL (SELECT domain_namespace, domain_id, predicate, provenance, source_entity, target_entity
            FROM public.relationships WHERE edge_memory_id = ids.id LIMIT 1) AS edge
        CROSS JOIN LATERAL (SELECT domain_entity->'identity' AS identity, context->>'scope' AS scope FROM public.memories WHERE id = edge.source_entity LIMIT 1) AS source
        CROSS JOIN LATERAL (SELECT domain_entity->'identity' AS identity, context->>'scope' AS scope FROM public.memories WHERE id = edge.target_entity LIMIT 1) AS target",
        &[&ids]).await.context("verify bounded stored edge columns")?;
    let rows: HashMap<Uuid, Row> = rows
        .into_iter()
        .map(|row| Ok((row.try_get("id")?, row)))
        .collect::<Result<_>>()?;
    for record in records {
        let row = rows
            .get(&record.memory_id)
            .context("stored domain edge is missing")?;
        let actual = DomainWrite::Edge {
            identity: DomainIdentity {
                namespace: row.try_get("domain_namespace")?,
                id: row.try_get("domain_id")?,
            },
            source: serde_json::from_str(&row.try_get::<_, String>("source_identity")?)
                .context("invalid stored source identity")?,
            target: serde_json::from_str(&row.try_get::<_, String>("target_identity")?)
                .context("invalid stored target identity")?,
            predicate: row.try_get("predicate")?,
            provenance: serde_json::from_str::<EdgeProvenance>(
                &row.try_get::<_, String>("provenance")?,
            )
            .context("invalid stored edge provenance")?,
        };
        ensure!(
            actual == record.domain
                && row.try_get::<_, Option<String>>("source_scope")? == record.context.scope
                && row.try_get::<_, Option<String>>("target_scope")? == record.context.scope,
            "stored domain edge differs from its source claim or endpoint scope"
        );
    }
    Ok(())
}

impl PostgresMemoryStore {
    pub(super) async fn store_domain_edge(
        &self,
        transaction: &Transaction<'_>,
        memory: &PreparedMemory,
    ) -> Result<()> {
        let Some(DomainWrite::Edge {
            identity,
            source,
            target,
            predicate,
            provenance,
        }) = memory
            .request
            .as_ref()
            .and_then(|request| request.domain.as_ref())
        else {
            return Ok(());
        };
        let endpoints = transaction.query(
            "SELECT id, domain_entity::text AS entity, context->>'scope' AS scope FROM public.memories
             WHERE domain_entity IS NOT NULL
               AND (domain_entity #>> '{identity,namespace}', domain_entity #>> '{identity,id}') IN (($1, $2), ($3, $4))
             ORDER BY id FOR KEY SHARE",
            &[&source.namespace, &source.id, &target.namespace, &target.id],
        ).await.context("resolve indexed domain edge endpoints")?;
        let mut resolved = HashMap::new();
        for row in endpoints {
            if row.try_get::<_, Option<String>>("scope")? != memory.context.scope {
                return Err(InvalidInput(
                    "domain edge endpoints and source episode must share the same scope".into(),
                )
                .into());
            }
            let entity: DomainWrite = serde_json::from_str(&row.try_get::<_, String>("entity")?)?;
            resolved.insert(entity.identity().clone(), row.try_get::<_, Uuid>("id")?);
        }
        let source = resolved
            .get(source)
            .ok_or_else(|| InvalidInput("domain source entity is unresolved".into()))?;
        let target = resolved
            .get(target)
            .ok_or_else(|| InvalidInput("domain target entity is unresolved".into()))?;
        transaction.execute(
            "INSERT INTO public.relationships (edge_memory_id, source_entity, target_entity, domain_namespace, domain_id, predicate, provenance)
             VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb)",
            &[&memory.id, source, target, &identity.namespace, &identity.id, predicate, &serde_json::to_string(provenance)?],
        ).await.map_err(|error| {
            if error.as_db_error().and_then(|error| error.constraint()) == Some("relationships_domain_identity_idx") {
                anyhow::Error::new(InvalidInput("edge identity already exists; resume with the original agentId, requestId and exact payload".into()))
            } else { anyhow::Error::new(error).context("store independent domain edge") }
        })?;
        Ok(())
    }

    pub(super) async fn inspect_domain_in_snapshot(
        &self,
        query: &DomainQuery,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Option<DomainInspection>> {
        query.validate(filter, limit)?;
        let mut connection = self
            .pool
            .get()
            .await
            .context("acquire database connection")?;
        let transaction = connection
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let (identity, selector) = match query {
            DomainQuery::Entity { identity, .. } => (identity, "FROM public.memories AS memories WHERE memories.domain_entity IS NOT NULL
                AND memories.domain_entity #>> '{identity,namespace}' = $1 AND memories.domain_entity #>> '{identity,id}' = $2"),
            DomainQuery::Edge { identity } => (identity, "FROM public.relationships AS edge JOIN public.memories AS memories ON memories.id = edge.edge_memory_id
                WHERE edge.edge_memory_id IS NOT NULL AND edge.domain_namespace = $1 AND edge.domain_id = $2"),
        };
        let row = transaction.query_opt(&format!("SELECT {RECORD_COLUMNS}, memories.domain_entity::text AS stored_entity {selector}
            AND ($3::text IS NULL OR memories.agent_id = $3) AND ($4::text IS NULL OR memories.context->>'scope' = $4)"),
            &[&identity.namespace, &identity.id, &filter.agent_id, &filter.scope]).await.context("inspect indexed domain identity")?;
        let Some(row) = row else {
            transaction.commit().await?;
            return Ok(None);
        };
        let mut result = DomainInspection {
            record: record(&row)?,
            relationships: Vec::new(),
            next_cursor: None,
            scanned_relationships: 0,
        };
        if matches!(query, DomainQuery::Entity { .. }) {
            let stored: DomainWrite =
                serde_json::from_str(&row.try_get::<_, String>("stored_entity")?)
                    .context("invalid indexed domain entity")?;
            ensure!(
                stored == result.record.domain,
                "indexed domain entity differs from its source claim"
            );
        }
        if matches!(query, DomainQuery::Edge { .. }) {
            verify_edges(&transaction, std::slice::from_ref(&result.record)).await?;
        }
        if let DomainQuery::Entity {
            identity,
            predicate,
            direction: Some(direction),
            after,
        } = query
        {
            let last = after
                .as_ref()
                .map_or(Uuid::nil(), |cursor| cursor.edge_memory_id);
            let last_predicate = after
                .as_ref()
                .map_or("", |cursor| cursor.edge_predicate.as_str());
            let statement = window_sql(*direction, predicate.is_some());
            let position = predicate.as_deref().unwrap_or(last_predicate);
            let parameters: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
                vec![&result.record.memory_id, &last, &filter.agent_id, &position];
            let rows = transaction
                .query(&statement, &parameters)
                .await
                .context("read bounded indexed domain relationships")?;
            let has_more = rows.len() > MAX_RELATIONSHIP_SCAN;
            let mut ids = Vec::new();
            let mut predicates = HashMap::new();
            let mut scanned_to = None;
            for row in rows.iter().take(MAX_RELATIONSHIP_SCAN) {
                result.scanned_relationships += 1;
                let id = row.try_get::<_, Uuid>("edge_memory_id")?;
                predicates.insert(id, row.try_get::<_, String>("predicate")?);
                scanned_to = Some(id);
                if row.try_get::<_, bool>("eligible")? {
                    ids.push(id);
                }
            }
            let selected: Vec<_> = ids.iter().take(limit).copied().collect();
            let payloads = transaction
                .query(&payload_sql(), &[&selected])
                .await
                .context("load bounded domain edge payloads")?;
            let payloads = payloads.iter().map(record).collect::<Result<Vec<_>>>()?;
            verify_edges(&transaction, &payloads).await?;
            let mut payloads: HashMap<_, _> = payloads
                .into_iter()
                .map(|record| (record.memory_id, record))
                .collect();
            let cursor = |edge_memory_id| DomainCursor {
                entity: identity.clone(),
                predicate: predicate.clone(),
                direction: *direction,
                agent_id: filter.agent_id.clone(),
                scope: filter.scope.clone(),
                edge_predicate: predicates[&edge_memory_id].clone(),
                edge_memory_id,
            };
            let mut bytes_limited = false;
            for id in &selected {
                result.relationships.push(
                    payloads
                        .remove(id)
                        .context("domain edge missing from snapshot")?,
                );
                result.next_cursor = Some(cursor(*id));
                if serde_json::to_vec(&result)?.len() > MAX_RECALL_RESULT_BYTES {
                    result.relationships.pop();
                    bytes_limited = true;
                    break;
                }
            }
            result.next_cursor = if bytes_limited || ids.len() > result.relationships.len() {
                Some(cursor(
                    result
                        .relationships
                        .last()
                        .ok_or_else(|| {
                            InvalidInput("domain record exceeds the 512 KiB response budget".into())
                        })?
                        .memory_id,
                ))
            } else if has_more {
                scanned_to.map(cursor)
            } else {
                None
            };
        }
        if serde_json::to_vec(&result)?.len() > MAX_RECALL_RESULT_BYTES {
            return Err(InvalidInput(
                "domain inspection exceeds the 512 KiB response budget".into(),
            )
            .into());
        }
        transaction
            .commit()
            .await
            .context("complete domain inspection snapshot")?;
        Ok(Some(result))
    }
}

fn payload_sql() -> String {
    format!(
        "SELECT {RECORD_COLUMNS} FROM unnest($1::uuid[]) AS selected(id)
        CROSS JOIN LATERAL (SELECT id, agent_id, raw_text, context, request_payload
            FROM public.memories WHERE id = selected.id LIMIT 1) AS memories"
    )
}

fn window_sql(direction: RelationshipDirection, predicate: bool) -> String {
    let (owner, neighbor) = match direction {
        RelationshipDirection::Outgoing => ("source_entity", "target_entity"),
        RelationshipDirection::Incoming => ("target_entity", "source_entity"),
    };
    let restriction = if predicate {
        "AND predicate = $4 AND edge_memory_id > $2"
    } else {
        "AND (predicate, edge_memory_id) > ($4::text, $2::uuid)"
    };
    format!("SELECT links.edge_memory_id, links.predicate,
        (edge.context->>'scope') IS NOT DISTINCT FROM (owner.context->>'scope')
        AND (neighbor.context->>'scope') IS NOT DISTINCT FROM (owner.context->>'scope')
        AND ($3::text IS NULL OR (edge.agent_id = $3 AND neighbor.agent_id = $3)) AS eligible
        FROM (SELECT edge_memory_id, predicate, {neighbor} AS neighbor_id FROM public.relationships
            WHERE edge_memory_id IS NOT NULL AND {owner} = $1 {restriction}
            ORDER BY predicate, edge_memory_id LIMIT {}) AS links
        JOIN public.memories AS owner ON owner.id = $1
        CROSS JOIN LATERAL (SELECT agent_id, context FROM public.memories WHERE id = links.edge_memory_id LIMIT 1) AS edge
        CROSS JOIN LATERAL (SELECT agent_id, context FROM public.memories WHERE id = links.neighbor_id LIMIT 1) AS neighbor
        ORDER BY links.predicate, links.edge_memory_id", MAX_RELATIONSHIP_SCAN + 1)
}

#[cfg(all(test, feature = "postgres-tests"))]
mod tests {
    use super::*;
    use serde_json::Value;

    fn index_scans<'entry>(plan: &'entry Value, scans: &mut Vec<&'entry Value>) {
        if plan["Relation Name"].is_string() {
            scans.push(plan);
        }
        if let Some(children) = plan["Plans"].as_array() {
            for child in children {
                index_scans(child, scans);
            }
        }
    }

    #[tokio::test]
    async fn high_degree_domain_windows_use_bounded_covering_indexes() {
        let url =
            std::env::var("MINDLEAK_TEST_DATABASE_URL").expect("use a disposable *_test database");
        let config: tokio_postgres::Config = url.parse().unwrap();
        assert!(config
            .get_dbname()
            .is_some_and(|name| name.ends_with("_test")));
        let store = PostgresMemoryStore::connect(&url, Some(("test-model", 2)), 2, None)
            .await
            .unwrap();
        let mut connection = store.pool.get().await.unwrap();
        let transaction = connection.transaction().await.unwrap();
        let owner = Uuid::new_v4();
        let neighbor = Uuid::new_v4();
        let other_owner = Uuid::new_v4();
        let other_neighbor = Uuid::new_v4();
        let namespace = format!("domain-plan-{}", Uuid::new_v4());
        transaction.execute("INSERT INTO public.memories (id, agent_id, raw_text) SELECT unnest($1::uuid[]), $2, 'Domain plan fixture.'",
            &[&vec![owner, neighbor, other_owner, other_neighbor], &namespace]).await.unwrap();
        transaction.execute("WITH edge_rows AS MATERIALIZED (
                SELECT gen_random_uuid() AS id, ordinal FROM generate_series(1, 60000) AS ordinal
            ), episodes AS (
                INSERT INTO public.memories (id, agent_id, raw_text)
                SELECT id, $1, 'Reported edge for the domain plan fixture.' FROM edge_rows RETURNING id
            ) INSERT INTO public.relationships (edge_memory_id, source_entity, target_entity, domain_namespace, domain_id, predicate, provenance)
              SELECT episodes.id, CASE WHEN edge_rows.ordinal <= 12000 THEN $2::uuid ELSE $4::uuid END,
                  CASE WHEN edge_rows.ordinal <= 12000 THEN $3::uuid ELSE $5::uuid END,
                  $1, episodes.id::text, CASE WHEN edge_rows.ordinal <= 3 THEN 'rare_predicate' ELSE 'depends_on' END,
                  '{\"sourceReferences\":[\"fixture:domain-plan\"]}'::jsonb
              FROM episodes JOIN edge_rows ON edge_rows.id = episodes.id", &[&namespace, &owner, &neighbor, &other_owner, &other_neighbor]).await.unwrap();
        transaction
            .batch_execute("ANALYZE public.relationships; ANALYZE public.memories")
            .await
            .unwrap();
        let late: Uuid = transaction.query_one("SELECT edge_memory_id FROM public.relationships WHERE source_entity = $1 AND predicate = 'depends_on' ORDER BY predicate, edge_memory_id OFFSET 11000 LIMIT 1", &[&owner]).await.unwrap().get(0);
        for (direction, entity, expected_index) in [
            (
                RelationshipDirection::Outgoing,
                owner,
                "relationships_domain_outgoing",
            ),
            (
                RelationshipDirection::Incoming,
                neighbor,
                "relationships_domain_incoming",
            ),
        ] {
            for predicate in [None, Some("rare_predicate")] {
                for after in [Uuid::nil(), late] {
                    let agent: Option<String> = None;
                    let position =
                        predicate.unwrap_or(if after.is_nil() { "" } else { "depends_on" });
                    let parameters: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
                        vec![&entity, &after, &agent, &position];
                    let statement = window_sql(direction, predicate.is_some());
                    assert!(!statement.contains("OFFSET") && !statement.contains("count(*)"));
                    let plan: Value = transaction
                        .query_one(
                            &format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {statement}"),
                            &parameters,
                        )
                        .await
                        .unwrap()
                        .get(0);
                    let mut scans = Vec::new();
                    index_scans(&plan[0]["Plan"], &mut scans);
                    let edge_scans: Vec<_> = scans
                        .iter()
                        .filter(|scan| scan["Relation Name"] == "relationships")
                        .collect();
                    assert_eq!(
                        edge_scans.len(),
                        1,
                        "one bounded relationship access per query: {plan}"
                    );
                    let scan = edge_scans[0];
                    assert!(
                        scan["Index Name"]
                            .as_str()
                            .is_some_and(|name| name.starts_with(expected_index)),
                        "wrong relationship index: {plan}"
                    );
                    assert!(
                        scan["Actual Rows"].as_u64().unwrap() <= (MAX_RELATIONSHIP_SCAN + 1) as u64,
                        "high degree must not expand scan work: {plan}"
                    );
                    assert_eq!(scan["Rows Removed by Filter"].as_u64().unwrap_or(0), 0);
                    if predicate.is_some() {
                        assert!(scan["Index Name"].as_str().unwrap().contains("predicate"));
                    }
                    for lookup in scans
                        .iter()
                        .filter(|scan| scan["Relation Name"] == "memories")
                    {
                        assert!(
                            lookup["Actual Rows"].as_u64().unwrap() <= 1,
                            "entity and source lookups must be bounded point reads: {plan}"
                        );
                        assert!(
                            lookup["Actual Loops"].as_u64().unwrap()
                                <= (MAX_RELATIONSHIP_SCAN + 1) as u64
                        );
                    }
                }
            }
        }
        let selected: Vec<Uuid> = transaction.query("SELECT edge_memory_id FROM public.relationships WHERE source_entity = $1 ORDER BY predicate, edge_memory_id LIMIT 50", &[&owner])
            .await.unwrap().iter().map(|row| row.get(0)).collect();
        let payload_plan: Value = transaction
            .query_one(
                &format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}", payload_sql()),
                &[&selected],
            )
            .await
            .unwrap()
            .get(0);
        let mut payload_scans = Vec::new();
        index_scans(&payload_plan[0]["Plan"], &mut payload_scans);
        assert_eq!(payload_scans.len(), 1);
        assert_eq!(payload_scans[0]["Index Name"], "memories_pkey");
        assert_eq!(payload_scans[0]["Actual Rows"], 1);
        assert_eq!(payload_scans[0]["Actual Loops"], 50);
        for name in [
            "relationships_target_idx",
            "relationships_incoming_context_idx",
            "relationships_outgoing_context_idx",
        ] {
            let predicate: Option<String> = transaction.query_one("SELECT pg_get_expr(indpred, indrelid) FROM pg_index WHERE indexrelid = $1::text::regclass", &[&name]).await.unwrap().get(0);
            assert!(
                predicate.is_some(),
                "legacy fragment index {name} must not index every domain edge"
            );
        }
        transaction.rollback().await.unwrap();
    }
}
