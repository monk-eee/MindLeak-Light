use std::collections::HashMap;

use anyhow::{Context, Result};
use mindleak_memory::{
    DocumentFragment, MemoryTier, RecallFilter, RecallMatch, MAX_RECALL_RESULT_BYTES,
    MAX_RELATED_CONTEXT_BYTES,
};
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::lifecycle;

pub(super) async fn load(
    transaction: &Transaction<'_>,
    facts: &[RecallMatch],
    filter: &RecallFilter,
) -> Result<HashMap<Uuid, Vec<DocumentFragment>>> {
    if filter.context_limit == 0 {
        return Ok(HashMap::new());
    }
    filter.validate()?;
    let identifiers: Vec<_> = facts.iter().map(|fact| fact.fragment_id).collect();
    let rows = transaction.query(
        &format!("SELECT owners.id AS owner_id, nearby.* FROM unnest($1::uuid[]) AS owners(id) \
            JOIN public.fragments AS owner ON owner.id = owners.id \
            CROSS JOIN LATERAL ( \
                SELECT fragments.id AS fragment_id, fragments.memory_id, fragments.text, memories.agent_id, {} \
                FROM public.fragments AS fragments \
                JOIN public.memories AS memories ON memories.id = fragments.memory_id \
                WHERE fragments.memory_id = owner.memory_id AND fragments.id <> owner.id \
                  AND ($3::text IS NULL OR memories.agent_id = $3) \
                  AND ($4::text IS NULL OR memories.context->>'scope' = $4) \
                  AND ($5::text IS NULL OR fragments.tier = $5) \
                  AND ($6::boolean OR fragments.state = 'active') \
                ORDER BY CASE WHEN owner.fragment_index IS NOT NULL THEN abs(fragments.fragment_index - owner.fragment_index) END NULLS LAST, \
                    CASE WHEN owner.fragment_index IS NOT NULL THEN fragments.fragment_index END NULLS LAST, fragments.id \
                LIMIT $2 \
            ) AS nearby", lifecycle::LIFECYCLE_COLUMNS),
        &[&identifiers, &i64::try_from(filter.context_limit + 1)?, &filter.agent_id,
          &filter.scope, &filter.tier.map(MemoryTier::as_str), &filter.include_inactive],
    ).await.context("load bounded same-episode context")?;
    let mut documents: HashMap<Uuid, Vec<DocumentFragment>> = HashMap::new();
    for row in rows {
        documents
            .entry(row.try_get("owner_id")?)
            .or_default()
            .push(DocumentFragment {
                fragment_id: row.try_get("fragment_id")?,
                memory_id: row.try_get("memory_id")?,
                agent_id: row.try_get("agent_id")?,
                text: row.try_get("text")?,
                context: serde_json::from_str(&row.try_get::<_, String>("context")?)?,
                lifecycle: lifecycle::from_row(&row)?,
                fragment_index: row.try_get("fragment_index")?,
            });
    }
    Ok(documents)
}

pub(super) fn context_bytes(facts: &[RecallMatch]) -> Result<usize> {
    facts
        .iter()
        .filter_map(|fact| fact.document_context.as_ref())
        .try_fold(0, |total, context| {
            Ok(total + serde_json::to_vec(context)?.len())
        })
}

pub(super) fn allocate(
    facts: &mut [RecallMatch],
    mut documents: HashMap<Uuid, Vec<DocumentFragment>>,
    limit: usize,
) -> Result<()> {
    if limit == 0 {
        return Ok(());
    }
    let related_bytes = facts.iter().try_fold(0, |total, fact| -> Result<usize> {
        Ok(total + serde_json::to_vec(&fact.relationships)?.len())
    })?;
    let mut remaining = MAX_RELATED_CONTEXT_BYTES
        .saturating_sub(related_bytes + context_bytes(facts)?)
        .min(MAX_RECALL_RESULT_BYTES.saturating_sub(serde_json::to_vec(&facts)?.len()));
    let mut pending = Vec::with_capacity(facts.len());
    for fact in facts.iter_mut() {
        let mut fragments = documents.remove(&fact.fragment_id).unwrap_or_default();
        let context = fact
            .document_context
            .as_mut()
            .expect("document context was reserved");
        context.order_known = fact.fragment_index.is_some()
            && fragments
                .iter()
                .all(|fragment| fragment.fragment_index.is_some());
        context.truncated = fragments.len() > limit;
        fragments.truncate(limit);
        pending.push(fragments.into_iter());
    }
    for _ in 0..limit {
        for (fact, candidates) in facts.iter_mut().zip(&mut pending) {
            if let Some(fragment) = candidates.next() {
                let context = fact
                    .document_context
                    .as_mut()
                    .expect("document context was reserved");
                let bytes = serde_json::to_vec(&fragment)?.len()
                    + usize::from(!context.fragments.is_empty());
                if bytes <= remaining {
                    remaining -= bytes;
                    context.fragments.push(fragment);
                } else {
                    context.truncated = true;
                }
            }
        }
    }
    for fact in facts {
        let context = fact
            .document_context
            .as_mut()
            .expect("document context was reserved");
        if context.order_known {
            context
                .fragments
                .sort_by_key(|fragment| fragment.fragment_index);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mindleak_memory::{
        DocumentContext, FactState, MemoryContext, RelatedFact, RelationshipType,
    };

    fn primary(identifier: u128) -> RecallMatch {
        RecallMatch {
            fragment_id: Uuid::from_u128(identifier),
            memory_id: Uuid::from_u128(identifier + 1000),
            text: "Primary fact".into(),
            fragment_index: Some(0),
            document_context: Some(DocumentContext::default()),
            ..Default::default()
        }
    }

    fn candidates(facts: &[RecallMatch]) -> HashMap<Uuid, Vec<DocumentFragment>> {
        facts
            .iter()
            .map(|fact| {
                (
                    fact.fragment_id,
                    (1..=8)
                        .map(|index| DocumentFragment {
                            fragment_id: Uuid::from_u128(fact.fragment_id.as_u128() * 10 + index),
                            memory_id: fact.memory_id,
                            agent_id: "budget-agent".into(),
                            text: "\u{0001}".repeat(600),
                            context: MemoryContext {
                                source: Some("\u{0001}".repeat(300)),
                                ..Default::default()
                            },
                            lifecycle: Default::default(),
                            fragment_index: Some(i32::try_from(index).unwrap()),
                        })
                        .collect(),
                )
            })
            .collect()
    }

    #[test]
    fn document_budget_includes_relationships_and_json_escaping() {
        let mut facts = vec![primary(1), primary(2)];
        for fact in &mut facts {
            fact.relationships.push(RelatedFact {
                fragment_id: Uuid::new_v4(),
                memory_id: fact.memory_id,
                agent_id: "budget-agent".into(),
                text: "r".repeat(6000),
                context: Default::default(),
                relationship_type: RelationshipType::Related,
                direction: "outgoing".into(),
                state: FactState::Active,
            });
        }
        let documents = candidates(&facts);
        allocate(&mut facts, documents, 8).unwrap();
        let related: usize = facts
            .iter()
            .map(|fact| serde_json::to_vec(&fact.relationships).unwrap().len())
            .sum();
        assert!(related + context_bytes(&facts).unwrap() <= MAX_RELATED_CONTEXT_BYTES);
        assert!(serde_json::to_vec(&facts).unwrap().len() <= MAX_RECALL_RESULT_BYTES);
        for fact in &facts {
            assert_eq!(fact.text, "Primary fact");
            let context = fact.document_context.as_ref().unwrap();
            assert!(context.truncated && !context.fragments.is_empty());
            assert!(context.fragments.iter().all(|fragment| fragment.text
                == "\u{0001}".repeat(600)
                && fragment.context.source.as_deref() == Some("\u{0001}".repeat(300).as_str())));
        }
    }

    #[test]
    fn document_context_also_respects_the_remaining_total_response_budget() {
        let mut facts: Vec<_> = (1..=20)
            .map(|identifier| RecallMatch {
                text: "\u{0001}".repeat(4096),
                ..primary(identifier)
            })
            .collect();
        let initial_bytes = serde_json::to_vec(&facts).unwrap().len();
        assert!(initial_bytes < MAX_RECALL_RESULT_BYTES);
        assert!(MAX_RECALL_RESULT_BYTES - initial_bytes < MAX_RELATED_CONTEXT_BYTES);
        let documents = candidates(&facts);
        allocate(&mut facts, documents, 8).unwrap();
        assert_eq!(facts.len(), 20);
        assert!(facts.iter().all(|fact| fact.text.len() == 4096));
        assert!(facts
            .iter()
            .any(|fact| fact.document_context.as_ref().unwrap().truncated));
        assert!(serde_json::to_vec(&facts).unwrap().len() <= MAX_RECALL_RESULT_BYTES);
    }
}
