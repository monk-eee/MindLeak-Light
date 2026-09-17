use std::collections::HashMap;

use anyhow::{Context, Result};
use mindleak_memory::{
    FragmentInspection, InvalidInput, MemoryContext, MemoryTier, RecallFilter, RelatedFact,
    RelationshipCursor, RelationshipDirection, MAX_FACT_LINKS, MAX_RECALL_RESULT_BYTES,
    MAX_RELATIONSHIP_SCAN,
};
use tokio_postgres::{IsolationLevel, Transaction};
use uuid::Uuid;

use crate::{lifecycle, PostgresMemoryStore};

impl PostgresMemoryStore {
    pub(super) async fn inspect_fragment_in_snapshot(
        &self,
        fragment_id: Uuid,
        filter: &RecallFilter,
        after: Option<&RelationshipCursor>,
        limit: usize,
    ) -> Result<Option<FragmentInspection>> {
        filter.validate()?;
        if !(1..=MAX_FACT_LINKS).contains(&limit)
            || after.is_some_and(|cursor| cursor.fragment_id != fragment_id)
        {
            return Err(InvalidInput("invalid inspection limit or cursor".into()).into());
        }
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
        let row = transaction
            .query_opt(
                &format!(
                    "SELECT memories.id AS memory_id, memories.agent_id, memories.raw_text, \
                fragments.text, {} \
                FROM public.fragments AS fragments \
                JOIN public.memories AS memories ON memories.id = fragments.memory_id \
                WHERE fragments.id = $1 AND memories.chain_id IS NULL \
                  AND ($2::text IS NULL OR memories.agent_id = $2) \
                  AND ($3::text IS NULL OR memories.context->>'scope' = $3) \
                  AND ($4::text IS NULL OR fragments.tier = $4) \
                  AND ($5::boolean OR fragments.state = 'active')",
                    lifecycle::LIFECYCLE_COLUMNS
                ),
                &[
                    &fragment_id,
                    &filter.agent_id,
                    &filter.scope,
                    &filter.tier.map(MemoryTier::as_str),
                    &filter.include_inactive,
                ],
            )
            .await
            .context("inspect original source and current fact")?;
        let Some(row) = row else {
            transaction.commit().await?;
            return Ok(None);
        };
        let mut result = FragmentInspection {
            memory_id: row.try_get("memory_id")?,
            fragment_id,
            agent_id: row.try_get("agent_id")?,
            text: row.try_get("text")?,
            raw_text: row.try_get("raw_text")?,
            context: serde_json::from_str(&row.try_get::<_, String>("context")?)?,
            lifecycle: lifecycle::from_row(&row)?,
            relationships: Vec::new(),
            next_cursor: None,
            scanned_relationships: 0,
            domain: row
                .try_get::<_, Option<String>>("domain")?
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
        };
        if serde_json::to_vec(&result)?.len() > MAX_RECALL_RESULT_BYTES {
            return Err(InvalidInput(
                "source inspection exceeds the 512 KiB response budget".into(),
            )
            .into());
        }
        if let Some(window) = read_windows(&transaction, &[fragment_id], filter, after, limit)
            .await?
            .remove(&fragment_id)
        {
            result.scanned_relationships = window.scanned;
            let mut accepted_cursor = None;
            for (cursor, related) in window.references {
                result.relationships.push(related);
                result.next_cursor = Some(cursor.clone());
                if serde_json::to_vec(&result)?.len() > MAX_RECALL_RESULT_BYTES {
                    result.relationships.pop();
                    if accepted_cursor.is_none() {
                        return Err(InvalidInput(
                            "source and related fact exceed the 512 KiB inspection budget".into(),
                        )
                        .into());
                    }
                    break;
                }
                accepted_cursor = Some(cursor);
            }
            result.next_cursor = if window.eligible_count > result.relationships.len() as i64 {
                accepted_cursor
            } else if !window.count_exact {
                window.scanned_to
            } else {
                None
            };
        }
        if serde_json::to_vec(&result)?.len() > MAX_RECALL_RESULT_BYTES {
            return Err(InvalidInput(
                "source inspection exceeds the 512 KiB response budget".into(),
            )
            .into());
        }
        transaction
            .commit()
            .await
            .context("complete source inspection snapshot")?;
        Ok(Some(result))
    }
}

pub(super) const PRIORITY_SQL: &str = "CASE relationship_type \
    WHEN 'supersedes' THEN 0 WHEN 'contradicts' THEN 1 \
    WHEN 'archives' THEN 2 WHEN 'restores' THEN 3 \
    WHEN 'supports' THEN 4 WHEN 'confirms' THEN 5 \
    WHEN 'reinforces' THEN 6 ELSE 7 END";

pub(super) struct RelationshipWindow {
    pub eligible_count: i64,
    pub count_exact: bool,
    pub scanned: usize,
    pub scanned_to: Option<RelationshipCursor>,
    pub references: Vec<(RelationshipCursor, RelatedFact)>,
}

pub(super) async fn read_windows(
    transaction: &Transaction<'_>,
    owners: &[Uuid],
    filter: &RecallFilter,
    after: Option<&RelationshipCursor>,
    page_size: usize,
) -> Result<HashMap<Uuid, RelationshipWindow>> {
    let priority = after.map_or(-1, |cursor| cursor.relationship_type.context_priority());
    let related = after.map_or(Uuid::nil(), |cursor| cursor.related_fragment_id);
    let direction = after.map_or(-1, |cursor| match cursor.direction {
        RelationshipDirection::Incoming => 0,
        RelationshipDirection::Outgoing => 1,
    });
    let rows = transaction
        .query(
            &format!(
                "SELECT owner.id AS owner_id, links.*, eligible.id IS NOT NULL AS eligible \
                 FROM public.fragments AS owner \
                 JOIN public.memories AS owner_memory ON owner_memory.id = owner.memory_id \
                 CROSS JOIN LATERAL ( \
                    SELECT * FROM ( \
                        (SELECT source_fragment AS related_id, relationship_type, \
                            {PRIORITY_SQL} AS priority, 0 AS direction \
                         FROM public.relationships WHERE target_fragment = owner.id \
                           AND ({PRIORITY_SQL}, source_fragment) >= ($2, $3) \
                           AND ({PRIORITY_SQL}, source_fragment, 0) > ($2, $3, $4) \
                         ORDER BY {PRIORITY_SQL}, source_fragment LIMIT $5) \
                        UNION ALL \
                        (SELECT target_fragment AS related_id, relationship_type, \
                            {PRIORITY_SQL} AS priority, 1 AS direction \
                         FROM public.relationships WHERE source_fragment = owner.id \
                           AND ({PRIORITY_SQL}, target_fragment) >= ($2, $3) \
                           AND ({PRIORITY_SQL}, target_fragment, 1) > ($2, $3, $4) \
                         ORDER BY {PRIORITY_SQL}, target_fragment LIMIT $5) \
                    ) AS bounded ORDER BY priority, related_id, direction LIMIT $5 \
                 ) AS links \
                 LEFT JOIN public.fragments AS related ON related.id = links.related_id \
                 LEFT JOIN public.memories AS eligible ON eligible.id = related.memory_id \
                   AND (eligible.context->>'scope') IS NOT DISTINCT FROM (owner_memory.context->>'scope') \
                   AND ($6::text IS NULL OR eligible.agent_id = $6) \
                 WHERE owner.id = ANY($1) \
                 ORDER BY owner.id, links.priority, links.related_id, links.direction"
            ),
            &[
                &owners,
                &priority,
                &related,
                &direction,
                &((MAX_RELATIONSHIP_SCAN + 1) as i64),
                &filter.agent_id,
            ],
        )
        .await
        .context("scan bounded direct relationships")?;
    let mut windows = HashMap::new();
    let mut selected: HashMap<Uuid, Vec<RelationshipCursor>> = HashMap::new();
    for row in rows {
        let owner: Uuid = row.try_get("owner_id")?;
        let window = windows.entry(owner).or_insert_with(|| RelationshipWindow {
            eligible_count: 0,
            count_exact: true,
            scanned: 0,
            scanned_to: None,
            references: Vec::new(),
        });
        if window.scanned == MAX_RELATIONSHIP_SCAN {
            window.count_exact = false;
            continue;
        }
        let cursor = RelationshipCursor {
            fragment_id: owner,
            relationship_type: serde_json::from_value(serde_json::Value::String(
                row.try_get("relationship_type")?,
            ))?,
            related_fragment_id: row.try_get("related_id")?,
            direction: if row.try_get::<_, i32>("direction")? == 0 {
                RelationshipDirection::Incoming
            } else {
                RelationshipDirection::Outgoing
            },
        };
        window.scanned += 1;
        window.scanned_to = Some(cursor.clone());
        if row.try_get::<_, bool>("eligible")? {
            window.eligible_count += 1;
            let references = selected.entry(owner).or_default();
            if references.len() < page_size {
                references.push(cursor);
            }
        }
    }
    let identifiers: Vec<_> = selected
        .values()
        .flatten()
        .map(|cursor| cursor.related_fragment_id)
        .collect();
    if identifiers.is_empty() {
        return Ok(windows);
    }
    let payloads = transaction
        .query(
            "SELECT fragments.id, fragments.memory_id, fragments.text, fragments.state, \
                memories.agent_id, memories.context::text AS context \
             FROM public.fragments AS fragments \
             JOIN public.memories AS memories ON memories.id = fragments.memory_id \
             WHERE fragments.id = ANY($1)",
            &[&identifiers],
        )
        .await
        .context("load bounded relationship text")?;
    let payloads: HashMap<Uuid, _> = payloads
        .into_iter()
        .map(|row| Ok((row.try_get("id")?, row)))
        .collect::<Result<_>>()?;
    for (owner, cursors) in selected {
        let window = windows
            .get_mut(&owner)
            .context("missing relationship window")?;
        for cursor in cursors {
            let row = payloads
                .get(&cursor.related_fragment_id)
                .context("related fact missing from snapshot")?;
            let related = RelatedFact {
                fragment_id: cursor.related_fragment_id,
                memory_id: row.try_get("memory_id")?,
                agent_id: row.try_get("agent_id")?,
                text: row.try_get("text")?,
                context: serde_json::from_str::<MemoryContext>(
                    &row.try_get::<_, String>("context")?,
                )?,
                relationship_type: cursor.relationship_type,
                direction: match cursor.direction {
                    RelationshipDirection::Incoming => "incoming",
                    RelationshipDirection::Outgoing => "outgoing",
                }
                .into(),
                state: serde_json::from_value(serde_json::Value::String(row.try_get("state")?))?,
            };
            window.references.push((cursor, related));
        }
    }
    Ok(windows)
}
