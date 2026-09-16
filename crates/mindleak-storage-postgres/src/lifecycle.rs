use std::collections::{HashMap, HashSet};

use anyhow::{ensure, Context, Result};
use mindleak_memory::{
    DocumentContext, FactLifecycle, FactState, InvalidInput, MemoryTier, PreparedMemory,
    RecallFilter, RecallMatch, RelatedFact, RelationshipType, MAX_FACT_LINKS, MAX_MEMORY_LINKS,
    MAX_RECALL_RESULT_BYTES, MAX_RELATED_CONTEXT_BYTES,
};
use tokio_postgres::{IsolationLevel, Row, Transaction};
use uuid::Uuid;

use crate::{documents, PostgresMemoryStore};

pub(super) const LIFECYCLE_COLUMNS: &str = "memories.context::text AS context, \
    fragments.fragment_index, \
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
        if facts.is_empty() {
            return Ok(facts);
        }
        let identifiers: Vec<_> = facts.iter().map(|fact| fact.fragment_id).collect();
        let scores: Vec<_> = facts.iter().map(|fact| fact.score).collect();
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
        let rows = transaction.query(
            &format!("SELECT memories.id AS memory_id, fragments.id AS fragment_id, memories.agent_id, \
                fragments.text, candidates.score, {LIFECYCLE_COLUMNS} \
                FROM unnest($1::uuid[], $2::double precision[]) AS candidates(fragment_id, score) \
                JOIN public.fragments AS fragments ON fragments.id = candidates.fragment_id \
                JOIN public.memories AS memories ON memories.id = fragments.memory_id \
                WHERE ($3::text IS NULL OR memories.agent_id = $3) \
                  AND ($4::text IS NULL OR memories.context->>'scope' = $4) \
                  AND ($5::text IS NULL OR fragments.tier = $5) \
                  AND ($6::boolean OR fragments.state = 'active')"),
            &[&identifiers, &scores, &filter.agent_id, &filter.scope,
              &filter.tier.map(MemoryTier::as_str), &filter.include_inactive],
        ).await.context("refresh primary facts in recall snapshot")?;
        facts = rows
            .into_iter()
            .map(crate::queries::recall_match)
            .collect::<Result<_>>()?;
        for fact in &mut facts {
            fact.ranking_priority = priority(fact);
        }
        facts.sort_by(|left, right| {
            right
                .ranking_priority
                .total_cmp(&left.ranking_priority)
                .then_with(|| left.fragment_id.cmp(&right.fragment_id))
        });
        facts.truncate(limit);
        if facts.is_empty() {
            transaction
                .commit()
                .await
                .context("complete empty recall snapshot")?;
            return Ok(facts);
        }
        let identifiers: Vec<_> = facts.iter().map(|fact| fact.fragment_id).collect();
        if filter.context_limit > 0 {
            for fact in &mut facts {
                fact.document_context = Some(DocumentContext::default());
            }
        }
        let document_context = documents::load(&transaction, &facts, filter).await?;
        let relations = crate::relationships::read_windows(
            &transaction,
            &identifiers,
            filter,
            None,
            MAX_FACT_LINKS,
        )
        .await?
        .into_iter()
        .map(|(owner, window)| {
            (
                owner,
                (
                    window.eligible_count,
                    window.count_exact,
                    window
                        .references
                        .into_iter()
                        .map(|(_, fact)| fact)
                        .collect(),
                ),
            )
        })
        .collect();
        allocate_related_context(&mut facts, relations)?;
        documents::allocate(&mut facts, document_context, filter.context_limit)?;
        transaction
            .commit()
            .await
            .context("complete recall snapshot")?;
        Ok(facts)
    }
}

fn allocate_related_context(
    facts: &mut [RecallMatch],
    mut relations: HashMap<Uuid, (i64, bool, Vec<RelatedFact>)>,
) -> Result<()> {
    let mut pending = Vec::with_capacity(facts.len());
    for fact in facts.iter_mut() {
        let (count, exact, relationships) = relations
            .remove(&fact.fragment_id)
            .unwrap_or_else(|| (0, true, Vec::new()));
        fact.relationship_count = count;
        fact.relationship_count_exact = exact;
        fact.relationships.clear();
        fact.relationships_truncated = false;
        pending.push(relationships.into_iter());
    }
    let primary_bytes = serde_json::to_vec(&facts)?.len();
    if primary_bytes > MAX_RECALL_RESULT_BYTES {
        return Err(InvalidInput(
            "primary recall results exceed the 512 KiB response budget; lower limit".into(),
        )
        .into());
    }
    let mut remaining = (MAX_RECALL_RESULT_BYTES - primary_bytes).min(
        MAX_RELATED_CONTEXT_BYTES
            .saturating_sub(2 * facts.len() + documents::context_bytes(facts)?),
    );
    for _ in 0..MAX_FACT_LINKS {
        for (fact, candidates) in facts.iter_mut().zip(&mut pending) {
            if let Some(related) = candidates.next() {
                let bytes = serde_json::to_vec(&related)?.len()
                    + usize::from(!fact.relationships.is_empty());
                if bytes <= remaining {
                    remaining -= bytes;
                    fact.relationships.push(related);
                }
            }
        }
    }
    for fact in facts {
        fact.relationships_truncated = !fact.relationship_count_exact
            || fact.relationship_count > fact.relationships.len() as i64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "postgres-tests")]
    #[tokio::test]
    async fn final_recall_revalidates_primary_state_and_filters() {
        use mindleak_memory::{EmbeddedFragment, MemoryContext, MemoryStore, PreparedRelationship};

        let url = std::env::var("MINDLEAK_TEST_DATABASE_URL").unwrap();
        let config: tokio_postgres::Config = url.parse().unwrap();
        assert!(config
            .get_dbname()
            .is_some_and(|name| name.ends_with("_test")));
        let store = PostgresMemoryStore::connect(&url, None, 4, None)
            .await
            .unwrap();
        let original = PreparedMemory {
            id: Uuid::new_v4(),
            agent_id: format!("snapshot-{}", Uuid::new_v4()),
            raw_text: "The team requires reviews.".into(),
            context: MemoryContext {
                scope: Some(format!("scope-{}", Uuid::new_v4())),
                ..Default::default()
            },
            fragments: vec![EmbeddedFragment {
                id: Uuid::new_v4(),
                text: "The team requires reviews.".into(),
                embedding: None,
                importance: 0.5,
                tier: MemoryTier::ShortTerm,
                pinned: false,
            }],
            relationships: Vec::new(),
            request: None,
        };
        store.save(&original).await.unwrap();
        let filter = RecallFilter {
            agent_id: Some(original.agent_id.clone()),
            scope: original.context.scope.clone(),
            ..Default::default()
        };
        let candidates = store.keyword_search("reviews", &filter, 5).await.unwrap();
        assert_eq!(candidates.len(), 1);
        let mut archive = original.clone();
        archive.id = Uuid::new_v4();
        archive.fragments[0].id = Uuid::new_v4();
        archive.fragments[0].text = "Archive decision.".into();
        archive.raw_text = archive.fragments[0].text.clone();
        archive.relationships.push(PreparedRelationship {
            source_fragment: archive.fragments[0].id,
            target_fragment: original.fragments[0].id,
            relationship_type: RelationshipType::Archives,
        });
        store.save(&archive).await.unwrap();
        store
            .pool
            .get()
            .await
            .unwrap()
            .execute(
                "UPDATE public.fragments SET tier = 'long_term', pinned = true WHERE id = $1",
                &[&original.fragments[0].id],
            )
            .await
            .unwrap();
        assert!(
            store
                .finish_recall(candidates.clone(), &filter, 5)
                .await
                .unwrap()
                .is_empty(),
            "a primary archived after candidate search must not return as active"
        );
        let history_filter = RecallFilter {
            include_inactive: true,
            ..filter.clone()
        };
        let history = store
            .finish_recall(candidates.clone(), &history_filter, 5)
            .await
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].lifecycle.state, FactState::Archived);
        assert_eq!(history[0].lifecycle.tier, MemoryTier::LongTerm);
        assert!(history[0].lifecycle.pinned);
        assert_eq!(history[0].activation, 0.0);
        assert_eq!(history[0].score, candidates[0].score);
        assert_eq!(history[0].ranking_priority, priority(&history[0]));
        assert_eq!(
            history[0].relationships[0].relationship_type,
            RelationshipType::Archives
        );
        for changed in [
            RecallFilter {
                tier: Some(MemoryTier::ShortTerm),
                ..history_filter.clone()
            },
            RecallFilter {
                scope: Some("other-scope".into()),
                ..history_filter.clone()
            },
            RecallFilter {
                agent_id: Some("other-agent".into()),
                ..history_filter
            },
        ] {
            assert!(store
                .finish_recall(candidates.clone(), &changed, 5)
                .await
                .unwrap()
                .is_empty());
        }
    }

    fn fact(identifier: u128) -> RecallMatch {
        RecallMatch {
            fragment_id: Uuid::from_u128(identifier),
            text: "Primary fact".into(),
            score: 0.9,
            activation: 1.0,
            ..Default::default()
        }
    }

    fn related(identifier: u128, text: String) -> RelatedFact {
        RelatedFact {
            fragment_id: Uuid::from_u128(identifier),
            memory_id: Uuid::from_u128(100),
            agent_id: "test-agent".into(),
            text,
            context: Default::default(),
            relationship_type: RelationshipType::Related,
            direction: "incoming".into(),
            state: FactState::Active,
        }
    }

    #[test]
    fn related_budget_counts_serialized_escaping_and_preserves_complete_text() {
        let mut facts = vec![fact(1), fact(2)];
        let text = "\u{0001}".repeat(1000);
        let relations = facts
            .iter()
            .map(|fact| {
                (
                    fact.fragment_id,
                    (
                        8,
                        true,
                        (0..8)
                            .map(|index| related(index + 10, text.clone()))
                            .collect(),
                    ),
                )
            })
            .collect();
        allocate_related_context(&mut facts, relations).unwrap();
        let bytes: usize = facts
            .iter()
            .map(|fact| serde_json::to_vec(&fact.relationships).unwrap().len())
            .sum();
        assert!(bytes <= MAX_RELATED_CONTEXT_BYTES);
        assert!(facts
            .iter()
            .all(|fact| !fact.relationships.is_empty() && fact.relationships_truncated));
        assert!(facts
            .iter()
            .flat_map(|fact| &fact.relationships)
            .all(|related| related.text == text));
        assert!(serde_json::to_vec(&facts).unwrap().len() <= MAX_RECALL_RESULT_BYTES);
    }

    #[test]
    fn primary_facts_get_the_response_budget_before_related_context() {
        let mut facts = vec![fact(1)];
        while serde_json::to_vec(&facts).unwrap().len() < MAX_RECALL_RESULT_BYTES - 40_000 {
            let mut primary = fact(facts.len() as u128 + 1);
            primary.text = "\u{0001}".repeat(4000);
            facts.push(primary);
        }
        let primary_texts: Vec<_> = facts.iter().map(|fact| fact.text.clone()).collect();
        let relations = facts
            .iter()
            .map(|fact| {
                (
                    fact.fragment_id,
                    (
                        8,
                        true,
                        (0..8)
                            .map(|index| related(index + 100, "\u{0001}".repeat(1500)))
                            .collect(),
                    ),
                )
            })
            .collect();
        allocate_related_context(&mut facts, relations).unwrap();
        assert!(serde_json::to_vec(&facts).unwrap().len() <= MAX_RECALL_RESULT_BYTES);
        assert_eq!(
            facts
                .iter()
                .map(|fact| fact.text.clone())
                .collect::<Vec<_>>(),
            primary_texts
        );
        assert!(facts.iter().any(|fact| fact.relationships_truncated));
    }

    #[test]
    fn oversized_primary_results_fail_instead_of_losing_facts() {
        let mut facts: Vec<_> = (1..=50)
            .map(|identifier| {
                let mut primary = fact(identifier);
                primary.text = "\u{0001}".repeat(4000);
                primary
            })
            .collect();
        let error = allocate_related_context(&mut facts, HashMap::new()).unwrap_err();
        assert!(error.is::<InvalidInput>());
        assert_eq!(facts.len(), 50);
        assert!(facts.iter().all(|fact| fact.text.len() == 4000));
    }

    #[test]
    fn relationship_counts_report_per_fact_truncation_and_empty_context() {
        let mut facts = vec![fact(1), fact(2), fact(3)];
        let relations = HashMap::from([
            (
                facts[0].fragment_id,
                (
                    9,
                    true,
                    (0..8)
                        .map(|index| related(index + 10, "Reference".into()))
                        .collect(),
                ),
            ),
            (
                facts[1].fragment_id,
                (1, true, vec![related(20, "Complete reference".into())]),
            ),
        ]);
        allocate_related_context(&mut facts, relations).unwrap();
        assert_eq!(facts[0].relationship_count, 9);
        assert_eq!(facts[0].relationships.len(), 8);
        assert!(facts[0].relationships_truncated);
        assert!(!facts[1].relationships_truncated);
        assert!(!facts[2].relationships_truncated);
        assert_eq!(facts[2].relationship_count, 0);
        assert!(facts[2].relationships.is_empty());
    }
}
