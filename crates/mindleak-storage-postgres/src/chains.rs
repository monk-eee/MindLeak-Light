#[path = "knowledge.rs"]
mod knowledge;

use std::collections::{BTreeSet, HashMap};

use anyhow::{ensure, Context, Result};
use mindleak_memory::{
    ChainCommand, ChainEvidenceRole, ChainEvidenceView, ChainFilter, ChainInspection, ChainMatch,
    ChainReview, ChainRevision, ChainSnapshot, ChainState, ChainSupportView, ChainWriteResult,
    EvidenceStatus, FactState, InvalidInput, KnowledgeKind, PreparedChain, MAX_CHAIN_RESULTS,
    MAX_RECALL_RESULT_BYTES, MAX_RELATED_CONTEXT_BYTES,
};
use pgvector::Vector;
use tokio_postgres::{IsolationLevel, Row, Transaction};
use uuid::Uuid;

use crate::{
    lifecycle,
    persistence::{write_receipt, WRITE_REPLAY_SQL},
    PostgresMemoryStore,
};

const CHAIN_COLUMNS: &str = "memories.id AS memory_id, memories.agent_id, memories.context::text AS context, memories.raw_text, \
    extract(epoch from memories.created_at)::bigint AS created_at, memories.chain_id, memories.chain_revision, \
    memories.chain_current, memories.chain_snapshot::text AS snapshot, memories.chain_operation";

fn observation_review_sql(owner: &str) -> String {
    format!("({owner}.chain_snapshot->>'review' <> 'reviewed' OR EXISTS ( \
        SELECT 1 FROM jsonb_array_elements({owner}.chain_snapshot->'document'->'evidence') AS reference \
    LEFT JOIN public.fragments AS evidence ON evidence.id = (reference->>'fragmentId')::uuid \
    LEFT JOIN public.memories AS source ON source.id = evidence.memory_id \
    WHERE evidence.id IS NULL OR source.chain_id IS NOT NULL \
            OR (source.context->>'scope') IS DISTINCT FROM ({owner}.context->>'scope') \
            OR (reference->>'role' = 'supports' AND (evidence.state <> 'active' OR evidence.evidence = 'disputed'))))")
}

fn review_sql(owner: &str) -> String {
    let direct = observation_review_sql(owner);
    let support = observation_review_sql("supporting");
    format!("({direct} OR EXISTS ( \
                SELECT 1 FROM jsonb_array_elements({owner}.chain_snapshot->'document'->'supportedBy') AS dependency \
                LEFT JOIN public.memories AS supporting ON supporting.chain_id=(dependency->>'chainId')::uuid AND supporting.chain_current \
                WHERE supporting.id IS NULL OR supporting.chain_revision <> (dependency->>'revision')::integer \
                    OR COALESCE(supporting.chain_snapshot->'document'->>'kind','chain') <> 'chain' \
                    OR supporting.chain_snapshot->>'state' <> 'accepted' \
                    OR (supporting.context->>'scope') IS DISTINCT FROM ({owner}.context->>'scope') OR {support}))")
}

fn revision(row: &Row) -> Result<ChainRevision> {
    Ok(ChainRevision {
        chain_id: row.try_get("chain_id")?,
        memory_id: row.try_get("memory_id")?,
        revision: row.try_get::<_, i32>("chain_revision")?.try_into()?,
        agent_id: row.try_get("agent_id")?,
        context: serde_json::from_str(&row.try_get::<_, String>("context")?)
            .context("decode chain context")?,
        created_at: row.try_get("created_at")?,
        operation: row.try_get("chain_operation")?,
        current: row.try_get("chain_current")?,
        snapshot: serde_json::from_str(&row.try_get::<_, String>("snapshot")?)
            .map_err(|_| anyhow::anyhow!("invalid stored chain snapshot"))?,
    })
}

fn invalid(message: &str) -> anyhow::Error {
    InvalidInput(message.into()).into()
}

async fn evidence(
    transaction: &Transaction<'_>,
    snapshot: &ChainSnapshot,
    scope: &Option<String>,
    lock: bool,
) -> Result<Vec<ChainEvidenceView>> {
    let mut identifiers: Vec<_> = snapshot
        .document
        .evidence
        .iter()
        .map(|reference| reference.fragment_id)
        .collect();
    identifiers.sort();
    let rows =
        transaction
            .query(
                &format!(
        "SELECT fragments.id, fragments.memory_id, fragments.text, memories.agent_id, {} \
         FROM public.fragments JOIN public.memories ON memories.id = fragments.memory_id \
                 WHERE fragments.id = ANY($1) AND memories.chain_id IS NULL \
                     AND (memories.context->>'scope') IS NOT DISTINCT FROM $2::text ORDER BY fragments.id {}",
        lifecycle::LIFECYCLE_COLUMNS, if lock { "FOR SHARE OF fragments, memories" } else { "" }),
                                &[&identifiers, &scope],
            )
            .await?;
    let mut rows: HashMap<Uuid, Row> = rows
        .into_iter()
        .map(|row| Ok((row.try_get("id")?, row)))
        .collect::<Result<_>>()?;
    snapshot
        .document
        .evidence
        .iter()
        .map(|reference| {
            let row = rows.remove(&reference.fragment_id);
            Ok(match row {
                Some(row) => ChainEvidenceView {
                    reference: reference.clone(),
                    memory_id: Some(row.try_get("memory_id")?),
                    text: Some(row.try_get("text")?),
                    agent_id: Some(row.try_get("agent_id")?),
                    context: Some(serde_json::from_str(&row.try_get::<_, String>("context")?)?),
                    lifecycle: Some(lifecycle::from_row(&row)?),
                    available: true,
                },
                None => ChainEvidenceView {
                    reference: reference.clone(),
                    memory_id: None,
                    text: None,
                    agent_id: None,
                    context: None,
                    lifecycle: None,
                    available: false,
                },
            })
        })
        .collect()
}

fn requires_review(
    snapshot: &ChainSnapshot,
    evidence: &[ChainEvidenceView],
    scope: &Option<String>,
) -> bool {
    snapshot.review != ChainReview::Reviewed
        || evidence.iter().any(|reference| {
            !reference.available
                || reference
                    .context
                    .as_ref()
                    .is_none_or(|context| context.scope != *scope)
                || (reference.reference.role == ChainEvidenceRole::Supports
                    && reference.lifecycle.as_ref().is_none_or(|lifecycle| {
                        lifecycle.state != FactState::Active
                            || lifecycle.evidence == EvidenceStatus::Disputed
                    }))
        })
}

async fn supporting_chains(
    transaction: &Transaction<'_>,
    snapshot: &ChainSnapshot,
    scope: &Option<String>,
    lock: bool,
) -> Result<Vec<ChainSupportView>> {
    let mut references = snapshot.document.supported_by.clone();
    references.sort_by_key(|reference| reference.chain_id);
    let mut result = Vec::new();
    for reference in references {
        let head = transaction.query_opt(&format!("SELECT {CHAIN_COLUMNS} FROM public.memories \
            WHERE chain_id=$1 AND chain_current AND (context->>'scope') IS NOT DISTINCT FROM $2::text {}",
            if lock { "FOR SHARE" } else { "" }), &[&reference.chain_id, &scope]).await?;
        let head = head.as_ref().map(revision).transpose()?;
        let pinned = transaction.query_opt(&format!("SELECT {CHAIN_COLUMNS} FROM public.memories \
            WHERE chain_id=$1 AND chain_revision=$2 AND (context->>'scope') IS NOT DISTINCT FROM $3::text"),
            &[&reference.chain_id, &i32::try_from(reference.revision)?, &scope]).await?;
        let pinned = pinned.as_ref().map(revision).transpose()?;
        let current_revision = head.as_ref().map(|head| head.revision);
        let Some(pinned) =
            pinned.filter(|pinned| pinned.snapshot.document.kind == KnowledgeKind::Chain)
        else {
            result.push(ChainSupportView {
                reference,
                document: None,
                evidence: vec![],
                memory_id: None,
                current_revision,
                state: None,
                review: None,
                observation_sources: vec![],
                available: false,
                requires_review: true,
            });
            continue;
        };
        let observations = evidence(transaction, &pinned.snapshot, scope, lock).await?;
        let invalid = head.as_ref().is_none_or(|head| {
            head.revision != reference.revision
                || head.snapshot.document.kind != KnowledgeKind::Chain
                || head.snapshot.state != ChainState::Accepted
        }) || pinned.snapshot.state != ChainState::Accepted
            || requires_review(&pinned.snapshot, &observations, scope);
        let sources: BTreeSet<_> = observations
            .iter()
            .filter_map(|evidence| evidence.memory_id)
            .collect();
        result.push(ChainSupportView {
            reference,
            memory_id: Some(pinned.memory_id),
            current_revision,
            document: Some(pinned.snapshot.document),
            evidence: observations,
            state: Some(pinned.snapshot.state),
            review: Some(pinned.snapshot.review),
            observation_sources: sources.into_iter().collect(),
            available: true,
            requires_review: invalid,
        });
    }
    Ok(result)
}

fn budget_details(
    evidence: &mut [ChainEvidenceView],
    supporting: &mut [ChainSupportView],
    remaining: &mut usize,
) -> Result<bool> {
    let mut truncated = false;
    for reference in evidence {
        let bytes = serde_json::to_vec(&(&reference.text, &reference.context))?.len();
        if bytes > *remaining {
            reference.text = None;
            reference.context = None;
            truncated = true;
        } else {
            *remaining -= bytes;
        }
    }
    for support in supporting {
        let bytes = serde_json::to_vec(&support.document)?.len();
        if bytes > *remaining {
            support.document = None;
            truncated = true;
        } else {
            *remaining -= bytes;
        }
        truncated |= budget_details(&mut support.evidence, &mut [], remaining)?;
    }
    Ok(truncated)
}

impl PostgresMemoryStore {
    pub(super) async fn store_chain(&self, chain: &PreparedChain) -> Result<ChainWriteResult> {
        let request = &chain.request;
        let memory = &chain.memory;
        self.validate_memory(memory)?;
        match (&self.space, &chain.embedding) {
            (Some(space), Some(vector)) => mindleak_memory::validate_embeddings(
                std::slice::from_ref(vector),
                1,
                space.dimensions,
            )?,
            (None, None) => {}
            _ => {
                return Err(invalid(
                    "chain embedding must match the configured embedding mode",
                ))
            }
        }
        request.chain.validate()?;
        ensure!(
            memory.agent_id == request.agent_id
                && memory.raw_text == request.text
                && memory.context == request.context
                && memory.request.is_none()
                && memory.relationships.is_empty(),
            "prepared chain source does not match its request"
        );
        if request.request_id.is_nil()
            || memory.context.source.is_none()
            || memory.context.session_id.is_none()
        {
            return Err(invalid(
                "chain writes require requestId, context.source and context.sessionId",
            ));
        }
        let payload = serde_json::to_string(request)?;
        let chain_id = request.chain.chain_id();
        let mut connection = self.pool.get().await?;
        let transaction = connection.transaction().await?;
        if let Some(row) = transaction
            .query_opt(
                WRITE_REPLAY_SQL,
                &[&request.agent_id, &request.request_id, &payload],
            )
            .await?
        {
            return write_receipt(row);
        }
        let current_sql = format!("SELECT {CHAIN_COLUMNS} FROM public.memories WHERE chain_id = $1 AND chain_current FOR UPDATE");
        let mut current = transaction.query_opt(&current_sql, &[&chain_id]).await?;
        if let Some(row) = transaction
            .query_opt(
                WRITE_REPLAY_SQL,
                &[&request.agent_id, &request.request_id, &payload],
            )
            .await?
        {
            return write_receipt(row);
        }
        if current.is_none() && request.chain.expected_revision().is_some() {
            current = transaction.query_opt(&current_sql, &[&chain_id]).await?;
        }
        let previous = current.as_ref().map(revision).transpose()?;
        if previous.as_ref().map(|previous| previous.revision) != request.chain.expected_revision()
        {
            return Err(invalid(
                "chain revision conflict; inspect the current revision before a new operation",
            ));
        }
        if previous
            .as_ref()
            .is_some_and(|previous| previous.context.scope != memory.context.scope)
        {
            return Err(invalid("chain revisions must retain the original scope"));
        }
        let snapshot = request
            .chain
            .apply(previous.as_ref().map(|previous| &previous.snapshot))?;
        let supporting =
            supporting_chains(&transaction, &snapshot, &memory.context.scope, true).await?;
        if matches!(
            request.chain,
            ChainCommand::Propose { .. }
                | ChainCommand::Revise { .. }
                | ChainCommand::Accept { .. }
        ) && supporting.iter().any(|support| support.requires_review)
        {
            return Err(invalid("principle support must reference current accepted, reviewed chains with available evidence in the same scope"));
        }
        if matches!(request.chain, ChainCommand::Revise { .. })
            && snapshot.document.kind == KnowledgeKind::Principle
        {
            let previous = previous
                .as_ref()
                .context("missing prior principle revision")?;
            let previous_support = supporting_chains(
                &transaction,
                &previous.snapshot,
                &memory.context.scope,
                false,
            )
            .await?;
            if previous_support
                .iter()
                .any(|support| support.document.is_none())
            {
                return Err(invalid("prior principle support is unavailable; restore the source or retire the principle instead of discarding unknown counterevidence"));
            }
            let retained: BTreeSet<_> = snapshot
                .document
                .evidence
                .iter()
                .chain(
                    supporting
                        .iter()
                        .filter_map(|support| support.document.as_ref())
                        .flat_map(|document| &document.evidence),
                )
                .filter(|reference| reference.role == ChainEvidenceRole::Counterexample)
                .map(|reference| reference.fragment_id)
                .collect();
            if previous_support
                .iter()
                .filter_map(|support| support.document.as_ref())
                .flat_map(|document| &document.evidence)
                .any(|reference| {
                    reference.role == ChainEvidenceRole::Counterexample
                        && !retained.contains(&reference.fragment_id)
                })
            {
                return Err(invalid("principle revisions must retain inherited counterevidence directly or through their supporting chains"));
            }
        }
        let evidence = evidence(&transaction, &snapshot, &memory.context.scope, true).await?;
        if !matches!(request.chain, ChainCommand::Retire { .. })
            && evidence.iter().any(|reference| {
                !reference.available
                    || reference
                        .context
                        .as_ref()
                        .is_none_or(|context| context.scope != memory.context.scope)
            })
        {
            return Err(invalid("chain evidence must reference existing observation fragments in the same scope; derived chains are not evidence"));
        }
        if matches!(request.chain, ChainCommand::Accept { .. })
            && requires_review(&snapshot, &evidence, &memory.context.scope)
        {
            return Err(invalid("supporting evidence is inactive or disputed; revise or validate different evidence before acceptance"));
        }
        let next = previous
            .as_ref()
            .map_or(1, |previous| previous.revision + 1);
        let previous_id = previous.as_ref().map(|previous| previous.memory_id);
        let result = ChainWriteResult {
            chain_id,
            memory_id: memory.id,
            revision: next,
            state: snapshot.state,
            review: snapshot.review,
            fragments: memory.write_result().fragments,
        };
        let content = serde_json::to_string(&snapshot)?;
        let key = serde_json::to_string(&(
            snapshot.document.kind,
            snapshot.document.claim_key(),
            snapshot
                .document
                .applicability
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase(),
        ))?;
        let search = snapshot.document.search_text();
        let embedding = chain.embedding.clone().map(Vector::from);
        if let Some(previous_id) = previous_id {
            transaction
                .execute(
                    "UPDATE public.memories SET chain_current = false WHERE id = $1",
                    &[&previous_id],
                )
                .await?;
        }
        let inserted = transaction.execute(
            "INSERT INTO public.memories (id,agent_id,raw_text,context,request_id,request_payload,write_result,chain_id,chain_revision,chain_current,chain_snapshot,chain_operation,chain_previous_id,chain_claim_key,chain_search,chain_embedding) \
             VALUES ($1,$2,$3,$4::text::jsonb,$5,$6::text::jsonb,$7::text::jsonb,$8,$9,true,$10::text::jsonb,$11,$12,encode(sha256(convert_to($13,'UTF8')),'hex'),to_tsvector('english',$14),$15) \
             ON CONFLICT DO NOTHING",
            &[&memory.id, &memory.agent_id, &memory.raw_text, &serde_json::to_string(&memory.context)?, &request.request_id, &payload,
              &serde_json::to_string(&result)?, &chain_id, &i32::try_from(next)?, &content, &request.chain.operation(), &previous_id, &key, &search, &embedding]).await?;
        if inserted == 0 {
            let replay = transaction
                .query_opt(
                    WRITE_REPLAY_SQL,
                    &[&request.agent_id, &request.request_id, &payload],
                )
                .await?;
            return match replay {
                Some(row) => write_receipt(row),
                None => Err(invalid(
                    "chain identity or normalized claim/applicability already exists in this scope",
                )),
            };
        }
        self.persist_fragments(&transaction, memory).await?;
        transaction
            .commit()
            .await
            .context("commit complete chain revision")?;
        Ok(result)
    }

    pub(super) async fn read_chain(
        &self,
        chain_id: Uuid,
        selected_revision: Option<u32>,
        after_revision: Option<u32>,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<Option<ChainInspection>> {
        ensure!(
            (1..=MAX_CHAIN_RESULTS).contains(&limit),
            "chain limit must be in 1..=10"
        );
        let mut connection = self.pool.get().await?;
        let transaction = connection
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let result = Self::read_chain_snapshot(
            &transaction,
            chain_id,
            selected_revision,
            after_revision,
            filter,
            limit,
        )
        .await?;
        transaction.commit().await?;
        Ok(result)
    }

    async fn read_chain_snapshot(
        transaction: &Transaction<'_>,
        chain_id: Uuid,
        selected_revision: Option<u32>,
        after_revision: Option<u32>,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<Option<ChainInspection>> {
        let selected_revision = selected_revision.map(i32::try_from).transpose()?;
        let after_revision = i32::try_from(after_revision.unwrap_or(0))?;
        let row = transaction
            .query_opt(
                &format!(
                    "SELECT {CHAIN_COLUMNS} FROM public.memories \
            WHERE chain_id=$1 AND (($2::integer IS NULL AND chain_current) OR chain_revision=$2) \
            AND ($3::text IS NULL OR agent_id=$3) AND ($4::text IS NULL OR context->>'scope'=$4) \
            AND ($5::boolean OR chain_snapshot->>'state' <> 'retired')"
                ),
                &[
                    &chain_id,
                    &selected_revision,
                    &filter.agent_id,
                    &filter.scope,
                    &filter.include_inactive,
                ],
            )
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let chain = revision(&row)?;
        let mut evidence =
            evidence(transaction, &chain.snapshot, &chain.context.scope, false).await?;
        let mut supporting =
            supporting_chains(transaction, &chain.snapshot, &chain.context.scope, false).await?;
        let mut observation_sources: BTreeSet<_> = evidence
            .iter()
            .filter_map(|evidence| evidence.memory_id)
            .collect();
        for source in &supporting {
            observation_sources.extend(source.observation_sources.iter().copied());
        }
        let needs_review = requires_review(&chain.snapshot, &evidence, &chain.context.scope)
            || supporting.iter().any(|support| support.requires_review);
        let mut remaining = MAX_RELATED_CONTEXT_BYTES;
        let evidence_details_truncated =
            budget_details(&mut evidence, &mut supporting, &mut remaining)?;
        let history_rows = transaction
            .query(
                &format!(
                    "SELECT {CHAIN_COLUMNS} FROM public.memories \
            WHERE chain_id=$1 AND chain_revision > $2 \
              AND ($3::text IS NULL OR agent_id=$3) AND ($4::text IS NULL OR context->>'scope'=$4) \
            ORDER BY chain_revision LIMIT $5"
                ),
                &[
                    &chain_id,
                    &after_revision,
                    &filter.agent_id,
                    &filter.scope,
                    &i64::try_from(limit + 1)?,
                ],
            )
            .await?;
        let mut history = history_rows
            .iter()
            .map(revision)
            .collect::<Result<Vec<_>>>()?;
        let next_revision = if history.len() > limit {
            history.truncate(limit);
            history.last().map(|revision| revision.revision)
        } else {
            None
        };
        let result = ChainInspection {
            requires_review: needs_review,
            chain,
            raw_text: row.try_get("raw_text")?,
            evidence,
            supporting_chains: supporting,
            observation_sources: observation_sources.into_iter().collect(),
            evidence_details_truncated,
            history,
            next_revision,
        };
        if serde_json::to_vec(&result)?.len() > MAX_RECALL_RESULT_BYTES {
            return Err(invalid(
                "chain inspection exceeds the response budget; lower limit",
            ));
        }
        Ok(Some(result))
    }

    pub(super) async fn search_chains(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<Vec<ChainMatch>> {
        self.search_knowledge(query, filter, limit, None, None, false)
            .await
    }

    pub(super) async fn search_knowledge(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
        vector: Option<Vec<f32>>,
        min_similarity: Option<f64>,
        hybrid: bool,
    ) -> Result<Vec<ChainMatch>> {
        ensure!(
            (1..=MAX_CHAIN_RESULTS).contains(&limit),
            "chain limit must be in 1..=10"
        );
        mindleak_memory::validate_text(query, "query", mindleak_memory::MAX_MEMORY_BYTES)?;
        if let Some(vector) = &vector {
            let space = self
                .space
                .as_ref()
                .context("knowledge vector search requires configured embeddings")?;
            mindleak_memory::validate_embeddings(
                std::slice::from_ref(vector),
                1,
                space.dimensions,
            )?;
        }
        let vector = vector.map(Vector::from);
        let mut connection = self.pool.get().await?;
        let transaction = connection
            .build_transaction()
            .isolation_level(IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()
            .await?;
        let needs_review = review_sql("memories");
        let conditions = format!("chain_current \
              AND ($2::text IS NULL OR agent_id=$2) AND ($3::text IS NULL OR context->>'scope'=$3) \
              AND ($5::boolean OR chain_snapshot->>'state'='accepted' OR ($4::boolean AND chain_snapshot->>'state'='candidate')) \
              AND ($5::boolean OR ($4::boolean AND chain_snapshot->>'state'='candidate') OR NOT {needs_review}) \
              AND ($6::text IS NULL OR COALESCE(chain_snapshot->'document'->>'kind','chain')=$6)");
        let bound = i64::try_from(if hybrid {
            mindleak_memory::MAX_RECALL_LIMIT
        } else {
            limit
        })?;
        let kind = filter.kind.map(KnowledgeKind::as_str);
        let mut rankings = Vec::new();
        if vector.is_none() || hybrid {
            let keyword_query = crate::queries::keyword_query_sql("$1", "$8");
            let rows = transaction.query(&format!("SELECT {CHAIN_COLUMNS}, \
                ts_rank_cd(chain_search,({keyword_query}),32)::double precision AS score, {needs_review} AS needs_review \
                FROM public.memories WHERE {conditions} AND chain_search @@ ({keyword_query}) ORDER BY score DESC, chain_id LIMIT $7"),
                &[&query, &filter.agent_id, &filter.scope, &filter.include_candidates, &filter.include_inactive, &kind, &bound, &filter.match_mode.as_str()]).await?;
            rankings.push((false, rows));
        }
        if let Some(vector) = &vector {
            let rows = transaction
                .query(
                    &format!(
                        "SELECT {CHAIN_COLUMNS}, \
                1.0-(chain_embedding <=> $1) AS score, {needs_review} AS needs_review \
                FROM public.memories WHERE {conditions} AND chain_embedding IS NOT NULL \
                AND ($8::double precision IS NULL OR 1.0-(chain_embedding <=> $1) >= $8) \
                ORDER BY chain_embedding <=> $1, chain_id LIMIT $7"
                    ),
                    &[
                        vector,
                        &filter.agent_id,
                        &filter.scope,
                        &filter.include_candidates,
                        &filter.include_inactive,
                        &kind,
                        &bound,
                        &min_similarity,
                    ],
                )
                .await?;
            rankings.push((true, rows));
        }
        let mut merged = HashMap::new();
        for (vector_branch, rows) in rankings {
            for (rank, row) in rows.iter().enumerate() {
                let score: f64 = row.try_get("score")?;
                ensure!(score.is_finite(), "invalid chain search score");
                let matched = ChainMatch {
                    chain: revision(row)?,
                    score: if hybrid {
                        30.5 / (61.0 + rank as f64)
                    } else {
                        score
                    },
                    vector_score: vector_branch.then_some(score),
                    keyword_score: (!vector_branch).then_some(score),
                    requires_review: row.try_get("needs_review")?,
                };
                merged
                    .entry(matched.chain.chain_id)
                    .and_modify(|existing: &mut ChainMatch| {
                        existing.score += matched.score;
                        existing.vector_score = existing.vector_score.or(matched.vector_score);
                        existing.keyword_score = existing.keyword_score.or(matched.keyword_score);
                    })
                    .or_insert(matched);
            }
        }
        let mut result: Vec<_> = merged.into_values().collect();
        result.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.chain.chain_id.cmp(&right.chain.chain_id))
        });
        result.truncate(limit);
        transaction.commit().await?;
        Ok(result)
    }
}
