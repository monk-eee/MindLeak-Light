use mindleak_memory::{KnowledgeMatch, KnowledgeReview, KnowledgeReviewPage};

use super::*;

impl PostgresMemoryStore {
    pub(crate) async fn hydrate_chain_matches(
        &self,
        selected: &[ChainMatch],
        filter: &ChainFilter,
    ) -> Result<Vec<KnowledgeMatch>> {
        ensure!(
            selected.len() <= MAX_CHAIN_RESULTS,
            "too many knowledge candidates"
        );
        let mut connection = self.pool.get().await?;
        let transaction = connection
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let mut results = Vec::new();
        let mut remaining = MAX_RELATED_CONTEXT_BYTES;
        for matched in selected {
            let Some(mut inspection) = Self::read_chain_snapshot(
                &transaction,
                matched.chain.chain_id,
                Some(matched.chain.revision),
                None,
                filter,
                None,
            )
            .await?
            else {
                continue;
            };
            if !inspection.chain.current
                || (!filter.include_inactive
                    && !(inspection.chain.snapshot.state == ChainState::Accepted
                        && !inspection.requires_review)
                    && !(filter.include_candidates
                        && inspection.chain.snapshot.state == ChainState::Candidate))
            {
                continue;
            }
            if filter
                .kind
                .is_some_and(|kind| kind != inspection.chain.snapshot.document.kind)
            {
                continue;
            }
            inspection.evidence_details_truncated |= budget_details(
                &mut inspection.evidence,
                &mut inspection.supporting_chains,
                &mut remaining,
            )?;
            let mut matched = matched.clone();
            matched.chain = inspection.chain;
            matched.requires_review = inspection.requires_review;
            results.push(KnowledgeMatch {
                matched,
                evidence: inspection.evidence,
                supporting_chains: inspection.supporting_chains,
                observation_sources: inspection.observation_sources,
                evidence_details_truncated: inspection.evidence_details_truncated,
            });
        }
        transaction.commit().await?;
        Ok(results)
    }

    pub(crate) async fn knowledge_review_page(
        &self,
        target: Option<Uuid>,
        filter: &ChainFilter,
        after: Option<Uuid>,
        limit: usize,
    ) -> Result<KnowledgeReviewPage> {
        ensure!(
            (1..=MAX_CHAIN_RESULTS).contains(&limit),
            "knowledge review limit must be in 1..=10"
        );
        let mut connection = self.pool.get().await?;
        let transaction = connection
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let target_scope: Option<String> = if let Some(target) = target {
            let row = transaction.query_opt("SELECT context->>'scope' AS scope FROM public.memories WHERE chain_id=$1 AND chain_current \
                AND ($2::text IS NULL OR context->>'scope'=$2)", &[&target, &filter.scope]).await?
                .ok_or_else(|| invalid("dependency target not found or excluded by scope"))?;
            row.try_get("scope")?
        } else {
            None
        };
        let dependency = serde_json::json!([{"chainId":target}]).to_string();
        let needs_review = review_sql("memories");
        let rows = transaction.query(&format!("SELECT {CHAIN_COLUMNS}, {needs_review} AS needs_review FROM public.memories \
            WHERE chain_current AND ($2::text IS NULL OR agent_id=$2) AND ($3::text IS NULL OR context->>'scope'=$3) \
              AND ($4::boolean OR chain_snapshot->>'state'<>'retired') AND ($5::uuid IS NULL OR chain_id>$5) \
              AND ($1::uuid IS NOT NULL OR {needs_review}) \
              AND ($1::uuid IS NULL OR ((chain_snapshot->'document'->'supportedBy') @> $7::text::jsonb \
                  AND (context->>'scope') IS NOT DISTINCT FROM $8::text)) \
              AND ($9::text IS NULL OR chain_snapshot->'document'->>'kind'=$9) ORDER BY chain_id LIMIT $6"),
            &[&target, &filter.agent_id, &filter.scope, &filter.include_inactive, &after, &i64::try_from(limit + 1)?, &dependency, &target_scope, &filter.kind.map(KnowledgeKind::as_str)]).await?;
        let mut entries = rows
            .iter()
            .map(|row| {
                Ok(KnowledgeReview {
                    chain: revision(row)?,
                    requires_review: row.try_get("needs_review")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let next = if entries.len() > limit {
            entries.truncate(limit);
            entries.last().map(|entry| entry.chain.chain_id)
        } else {
            None
        };
        transaction.commit().await?;
        Ok(KnowledgeReviewPage {
            kind: if target.is_some() {
                "dependents"
            } else {
                "knowledge_review"
            },
            entries,
            next,
        })
    }
}
