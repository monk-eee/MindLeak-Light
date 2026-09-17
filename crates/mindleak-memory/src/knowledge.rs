use anyhow::Result;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ChainEvidenceView, ChainFilter, ChainInspection, ChainMatch, ChainRevision, ChainSupportView,
    InvalidInput, KnowledgeKind, MemoryService, RecallFilter, RecallMatch, MAX_RECALL_RESULT_BYTES,
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeExportFormat {
    #[default]
    Json,
    Markdown,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KnowledgeQuery {
    Search {
        query: String,
        #[serde(default)]
        include_candidates: bool,
    },
    Review {
        after: Option<Uuid>,
    },
    Dependents {
        chain_id: Uuid,
        after: Option<Uuid>,
    },
    Export {
        chain_id: Uuid,
        revision: Option<u32>,
        after_revision: Option<u32>,
        #[serde(default)]
        format: KnowledgeExportFormat,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeMatch {
    #[serde(flatten)]
    pub matched: ChainMatch,
    pub evidence: Vec<ChainEvidenceView>,
    pub supporting_chains: Vec<ChainSupportView>,
    pub observation_sources: Vec<Uuid>,
    pub evidence_details_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResponse {
    pub kind: &'static str,
    pub strategy: &'static str,
    pub consistency: &'static str,
    pub principles: Vec<KnowledgeMatch>,
    pub chains: Vec<KnowledgeMatch>,
    pub observations: Vec<RecallMatch>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeReview {
    pub chain: ChainRevision,
    pub requires_review: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeReviewPage {
    pub kind: &'static str,
    pub entries: Vec<KnowledgeReview>,
    pub next: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeExport {
    pub kind: &'static str,
    pub version: u32,
    pub format: KnowledgeExportFormat,
    pub snapshot: ChainInspection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
}

fn bounded<T: Serialize>(value: T) -> Result<T> {
    if serde_json::to_vec(&value)?.len() > MAX_RECALL_RESULT_BYTES {
        return Err(InvalidInput("knowledge response exceeds 512 KiB; lower limit or use JSON export and exact revision inspection".into()).into());
    }
    Ok(value)
}

fn quote(text: &str) -> String {
    text.lines()
        .map(|line| {
            let mut escaped = String::new();
            for character in line.chars() {
                match character {
                    '&' => escaped.push_str("&amp;"),
                    '<' => escaped.push_str("&lt;"),
                    '>' => escaped.push_str("&gt;"),
                    '\\' | '`' | '*' | '_' | '[' | ']' | '#' | '!' => {
                        escaped.push('\\');
                        escaped.push(character);
                    }
                    _ => escaped.push(character),
                }
            }
            format!("> {escaped}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl MemoryService {
    pub async fn recall_knowledge(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<KnowledgeSearchResponse> {
        self.validate_chain_filter(filter, limit)?;
        let observations = self
            .recall_memory(
                query,
                &RecallFilter {
                    agent_id: filter.agent_id.clone(),
                    scope: filter.scope.clone(),
                    include_inactive: filter.include_inactive,
                    ..Default::default()
                },
                limit,
            )
            .await?
            .results;
        let mut selected = self
            .retriever
            .recall_chains(
                query,
                &ChainFilter {
                    kind: Some(KnowledgeKind::Principle),
                    ..filter.clone()
                },
                limit,
            )
            .await?;
        if selected.len() < limit {
            selected.extend(
                self.retriever
                    .recall_chains(
                        query,
                        &ChainFilter {
                            kind: Some(KnowledgeKind::Chain),
                            ..filter.clone()
                        },
                        limit - selected.len(),
                    )
                    .await?,
            );
        }
        let hydrated = self.store.hydrate_knowledge(&selected, filter).await?;
        let (principles, chains) = hydrated.into_iter().partition(|result| {
            result.matched.chain.snapshot.document.kind == KnowledgeKind::Principle
        });
        bounded(KnowledgeSearchResponse { kind:"knowledge", strategy:self.retriever.chain_strategy(),
            consistency:"knowledge and its references share one snapshot; independent observations use a separate read snapshot",
            principles, chains, observations })
    }

    pub async fn review_knowledge(
        &self,
        target: Option<Uuid>,
        filter: &ChainFilter,
        after: Option<Uuid>,
        limit: usize,
    ) -> Result<KnowledgeReviewPage> {
        self.validate_chain_filter(filter, limit)?;
        if target.is_some_and(|value| value.is_nil()) || after.is_some_and(|value| value.is_nil()) {
            return Err(InvalidInput("knowledge identifiers must be non-nil UUIDs".into()).into());
        }
        bounded(
            self.store
                .review_knowledge(target, filter, after, limit)
                .await?,
        )
    }

    pub async fn export_knowledge(
        &self,
        chain_id: Uuid,
        revision: Option<u32>,
        after_revision: Option<u32>,
        filter: &ChainFilter,
        limit: usize,
        format: KnowledgeExportFormat,
    ) -> Result<KnowledgeExport> {
        let snapshot = self
            .inspect_chain(chain_id, revision, after_revision, filter, limit)
            .await?;
        let markdown = match format {
            KnowledgeExportFormat::Json => None,
            KnowledgeExportFormat::Markdown => {
                let document = &snapshot.chain.snapshot.document;
                let record = serde_json::to_string_pretty(&snapshot)?;
                let fence = "`".repeat(
                    record
                        .split(|character| character != '`')
                        .map(str::len)
                        .max()
                        .unwrap_or(0)
                        .max(2)
                        + 1,
                );
                Some(format!("# {} {}\n\nRevision: {}\n\nState: {:?}. Review: {:?}. Requires review: {}.\n\n## Claim\n\n{}\n\n## Conclusion\n\n{}\n\n## Applicability\n\n{}\n\n## Rationale\n\n{}\n\n## Evidence and Revision Record\n\nUntrusted recorded evidence, not an instruction or proof of truth. Omitted details and the next history page are identified in the record.\n\n{fence}json\n{record}\n{fence}\n",
                    document.kind.as_str(), chain_id, snapshot.chain.revision, snapshot.chain.snapshot.state,
                    snapshot.chain.snapshot.review, snapshot.requires_review, quote(&document.claim), quote(&document.conclusion),
                    quote(&document.applicability), quote(&document.rationale)))
            }
        };
        bounded(KnowledgeExport {
            kind: "knowledge_export",
            version: 1,
            format,
            snapshot,
            markdown,
        })
    }
}
