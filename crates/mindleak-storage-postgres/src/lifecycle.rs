use std::collections::{HashMap, HashSet};

use anyhow::{ensure, Context, Result};
use mindleak_memory::{
    FactLifecycle, FactState, InvalidInput, MemoryTier, PreparedMemory, RecallFilter, RecallMatch,
    RelatedFact, RelationshipType, MAX_FACT_LINKS, MAX_MEMORY_LINKS,
};
use tokio_postgres::{Row, Transaction};
use uuid::Uuid;

use crate::PostgresMemoryStore;

pub(super) const LIFECYCLE_COLUMNS: &str = "memories.context::text AS context, \
    fragments.tier, fragments.state, fragments.evidence, fragments.pinned, fragments.importance, \
    fragments.useful_sessions, fragments.confirmed_sessions, \
    extract(epoch from memories.created_at)::bigint AS created_at, \
    extract(epoch from COALESCE(fragments.reinforced_at, memories.created_at))::bigint AS reinforced_at, \
    extract(epoch from fragments.first_evidence_at)::bigint AS first_evidence_at, \
    extract(epoch from now())::bigint AS observed_at";

pub(super) fn from_row(row: &Row) -> Result<FactLifecycle> {
    Ok(FactLifecycle {
        tier: serde_json::from_value(serde_json::Value::String(row.try_get("tier")?))?,
        state: serde_json::from_value(serde_json::Value::String(row.try_get("state")?))?,
        evidence: serde_json::from_value(serde_json::Value::String(row.try_get("evidence")?))?,
        pinned: row.try_get("pinned")?,
        useful_sessions: row.try_get::<_, i32>("useful_sessions")?.try_into()?,
        confirmed_sessions: row.try_get::<_, i32>("confirmed_sessions")?.try_into()?,
        created_at: row.try_get("created_at")?,
        reinforced_at: row.try_get("reinforced_at")?,
        first_evidence_at: row.try_get("first_evidence_at")?,
    })
}

fn priority(fact: &RecallMatch) -> f64 {
    fact.score - fact.score.abs() * 0.25 * (1.0 - fact.activation)
}

impl PostgresMemoryStore {
    pub(super) async fn apply_relationships(
        &self,
        transaction: &Transaction<'_>,
        memory: &PreparedMemory,
    ) -> Result<()> {
        ensure!(
            memory.relationships.len() <= MAX_MEMORY_LINKS,
            "too many memory relationships"
        );
        if memory.relationships.is_empty() {
            return Ok(());
        }
        let sources: HashSet<_> = memory
            .fragments
            .iter()
            .map(|fragment| fragment.id)
            .collect();
        let mut targets: Vec<_> = memory
            .relationships
            .iter()
            .map(|link| link.target_fragment)
            .collect();
        targets.sort();
        targets.dedup();
        let rows = transaction.query(
            &format!("SELECT fragments.id, {LIFECYCLE_COLUMNS} \
                FROM public.fragments AS fragments JOIN public.memories AS memories ON memories.id = fragments.memory_id \
                WHERE fragments.id = ANY($1) ORDER BY fragments.id FOR UPDATE OF fragments"),
            &[&targets],
        ).await?;
        if rows.len() != targets.len() {
            return Err(InvalidInput("a relationship target does not exist".into()).into());
        }
        let mut states = HashMap::new();
        for row in rows {
            let context: mindleak_memory::MemoryContext =
                serde_json::from_str(&row.try_get::<_, String>("context")?)?;
            if context.scope != memory.context.scope {
                return Err(InvalidInput(
                    "related facts must belong to the same context.scope".into(),
                )
                .into());
            }
            states.insert(row.try_get::<_, Uuid>("id")?, from_row(&row)?.state);
        }
        let mut reinforced = HashSet::new();
        let mut changed_targets = HashSet::new();
        for link in &memory.relationships {
            if !sources.contains(&link.source_fragment)
                || link.source_fragment == link.target_fragment
            {
                return Err(InvalidInput(
                    "relationship source must be a distinct fact from this write".into(),
                )
                .into());
            }
            if !matches!(
                link.relationship_type,
                RelationshipType::Supports | RelationshipType::Related
            ) {
                if !changed_targets.insert(link.target_fragment) {
                    return Err(InvalidInput(
                        "only one lifecycle-changing relationship per target is allowed in a write"
                            .into(),
                    )
                    .into());
                }
                if states[&link.target_fragment] == FactState::Superseded {
                    return Err(InvalidInput("superseded facts cannot change state; link new evidence to their current replacement".into()).into());
                }
            }
            if link.relationship_type.is_feedback()
                && states[&link.target_fragment] != FactState::Active
            {
                return Err(InvalidInput(
                    "only active facts can receive reinforcement or confirmation".into(),
                )
                .into());
            }
            if link.relationship_type == RelationshipType::Restores
                && states[&link.target_fragment] != FactState::Archived
            {
                return Err(InvalidInput("only archived facts can be restored; superseded facts require a new correction".into()).into());
            }
            let evidence_session =
                if link.relationship_type.is_feedback() {
                    Some(memory.context.session_id.as_deref().ok_or_else(|| {
                        InvalidInput("feedback requires context.sessionId".into())
                    })?)
                } else {
                    None
                };
            let inserted = transaction.execute(
                "INSERT INTO public.relationships(source_fragment, target_fragment, relationship_type, evidence_session) \
                 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                &[&link.source_fragment, &link.target_fragment, &link.relationship_type.as_str(), &evidence_session],
            ).await?;
            if inserted == 0 {
                continue;
            }
            if link.relationship_type.is_feedback() {
                reinforced.insert(link.target_fragment);
            }
            let statement = match link.relationship_type {
                RelationshipType::Confirms => "UPDATE public.fragments SET confirmed_sessions = confirmed_sessions + 1, \
                    evidence = CASE WHEN evidence = 'disputed' THEN evidence ELSE 'confirmed' END, \
                    reinforced_at = now(), first_evidence_at = COALESCE(first_evidence_at, now()) WHERE id = $1",
                RelationshipType::Reinforces => "UPDATE public.fragments SET useful_sessions = useful_sessions + 1, \
                    reinforced_at = now(), first_evidence_at = COALESCE(first_evidence_at, now()) WHERE id = $1",
                RelationshipType::Contradicts => "UPDATE public.fragments SET evidence = 'disputed' WHERE id = $1",
                RelationshipType::Supersedes => "UPDATE public.fragments SET state = 'superseded' WHERE id = $1",
                RelationshipType::Archives => "UPDATE public.fragments SET state = 'archived' WHERE id = $1",
                RelationshipType::Restores => "UPDATE public.fragments SET state = 'active', reinforced_at = now() WHERE id = $1",
                RelationshipType::Supports | RelationshipType::Related => continue,
            };
            transaction
                .execute(statement, &[&link.target_fragment])
                .await?;
        }
        let reinforced: Vec<_> = reinforced.into_iter().collect();
        let rows = transaction.query(
            &format!("SELECT fragments.id, {LIFECYCLE_COLUMNS} \
                FROM public.fragments AS fragments JOIN public.memories AS memories ON memories.id = fragments.memory_id \
                WHERE fragments.id = ANY($1)"), &[&reinforced],
        ).await?;
        for row in rows {
            let lifecycle = from_row(&row)?;
            if lifecycle.tier == MemoryTier::ShortTerm
                && lifecycle.eligible_for_consolidation(row.try_get("observed_at")?)
            {
                transaction
                    .execute(
                        "UPDATE public.fragments SET tier = 'long_term' WHERE id = $1",
                        &[&row.try_get::<_, Uuid>("id")?],
                    )
                    .await?;
            }
        }
        Ok(())
    }

    pub(super) async fn finish_recall(
        &self,
        mut facts: Vec<RecallMatch>,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        facts.sort_by(|left, right| {
            priority(right)
                .total_cmp(&priority(left))
                .then_with(|| left.fragment_id.cmp(&right.fragment_id))
        });
        facts.truncate(limit);
        if facts.is_empty() {
            return Ok(facts);
        }
        let identifiers: Vec<_> = facts.iter().map(|fact| fact.fragment_id).collect();
        let connection = self
            .pool
            .get()
            .await
            .context("acquire database connection")?;
        let rows = connection.query(
            "SELECT owners.id AS owner_id, linked.* FROM unnest($1::uuid[]) AS owners(id) \
             JOIN public.fragments AS owner ON owner.id = owners.id \
             JOIN public.memories AS owner_memory ON owner_memory.id = owner.memory_id \
             CROSS JOIN LATERAL ( \
                SELECT related.id AS fragment_id, related.memory_id, related.text, related.state, \
                       context_memory.agent_id, context_memory.context::text AS context, links.relationship_type, \
                       CASE WHEN links.source_fragment = owner.id THEN 'outgoing' ELSE 'incoming' END AS direction, \
                       count(*) OVER() AS total_links \
                FROM public.relationships AS links \
                JOIN public.fragments AS related ON related.id = CASE WHEN links.source_fragment = owner.id \
                    THEN links.target_fragment ELSE links.source_fragment END \
                JOIN public.memories AS context_memory ON context_memory.id = related.memory_id \
                WHERE (links.source_fragment = owner.id OR links.target_fragment = owner.id) \
                  AND (context_memory.context->>'scope') IS NOT DISTINCT FROM (owner_memory.context->>'scope') \
                  AND ($2::text IS NULL OR context_memory.agent_id = $2) \
                ORDER BY links.relationship_type, related.id LIMIT $3 \
             ) AS linked",
            &[&identifiers, &filter.agent_id, &(MAX_FACT_LINKS as i64)],
        ).await.context("load direct fact relationships")?;
        let mut relations: HashMap<Uuid, (i64, Vec<RelatedFact>)> = HashMap::new();
        for row in rows {
            let entry = relations.entry(row.try_get("owner_id")?).or_default();
            entry.0 = row.try_get("total_links")?;
            entry.1.push(RelatedFact {
                fragment_id: row.try_get("fragment_id")?,
                memory_id: row.try_get("memory_id")?,
                agent_id: row.try_get("agent_id")?,
                text: row.try_get("text")?,
                context: serde_json::from_str(&row.try_get::<_, String>("context")?)?,
                relationship_type: serde_json::from_value(serde_json::Value::String(
                    row.try_get("relationship_type")?,
                ))?,
                direction: row.try_get("direction")?,
                state: serde_json::from_value(serde_json::Value::String(row.try_get("state")?))?,
            });
        }
        for fact in &mut facts {
            if let Some((total, relationships)) = relations.remove(&fact.fragment_id) {
                fact.relationship_count = total;
                fact.relationships = relationships;
            }
        }
        Ok(facts)
    }
}
