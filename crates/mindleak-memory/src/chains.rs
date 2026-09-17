use std::collections::HashSet;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    validate_text, FactLifecycle, InvalidInput, MemoryContext, PreparedMemory, WrittenFragment,
    MAX_MEMORY_BYTES,
};

pub const MAX_CHAIN_EVIDENCE: usize = 8;
pub const MAX_CHAIN_RESULTS: usize = 10;

#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeKind {
    #[default]
    Chain,
    Principle,
}

impl KnowledgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chain => "chain",
            Self::Principle => "principle",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChainSupport {
    pub chain_id: Uuid,
    pub revision: u32,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChainEvidenceRole {
    Supports,
    Counterexample,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChainEvidence {
    pub fragment_id: Uuid,
    pub role: ChainEvidenceRole,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportedConfidence {
    pub estimate: f64,
    pub method: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChainDocument {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formation: Option<crate::FormationProvenance>,
    #[serde(default)]
    pub kind: KnowledgeKind,
    pub claim: String,
    pub rationale: String,
    pub conclusion: String,
    pub applicability: String,
    #[serde(default)]
    pub assumptions: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<ChainEvidence>,
    #[serde(default)]
    pub supported_by: Vec<ChainSupport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Optional caller-reported estimate and method, not server-calibrated truth confidence."
    )]
    pub reported_confidence: Option<ReportedConfidence>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChainValidation {
    pub method: String,
    pub result: String,
    pub source: String,
    #[serde(default)]
    pub counter_evidence_reviewed: Vec<Uuid>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChainCommand {
    Propose {
        chain_id: Uuid,
        document: ChainDocument,
    },
    Accept {
        chain_id: Uuid,
        expected_revision: u32,
        validation: ChainValidation,
    },
    Challenge {
        chain_id: Uuid,
        expected_revision: u32,
        evidence: Vec<ChainEvidence>,
    },
    Revise {
        chain_id: Uuid,
        expected_revision: u32,
        document: ChainDocument,
    },
    Retire {
        chain_id: Uuid,
        expected_revision: u32,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainState {
    Candidate,
    Accepted,
    Retired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChainReview {
    Unreviewed,
    Reviewed,
    Challenged,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSnapshot {
    pub document: ChainDocument,
    pub state: ChainState,
    pub review: ChainReview,
    pub validation: Option<ChainValidation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainWriteRequest {
    pub request_id: Uuid,
    pub agent_id: String,
    pub text: String,
    pub context: MemoryContext,
    pub chain: ChainCommand,
}

#[derive(Clone, Debug)]
pub struct PreparedChain {
    pub request: ChainWriteRequest,
    pub memory: PreparedMemory,
    pub embedding: Option<Vec<f32>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainWriteResult {
    pub chain_id: Uuid,
    pub memory_id: Uuid,
    pub revision: u32,
    pub state: ChainState,
    pub review: ChainReview,
    pub fragments: Vec<WrittenFragment>,
}

fn require(condition: bool, message: &str) -> Result<()> {
    if !condition {
        return Err(InvalidInput(message.into()).into());
    }
    Ok(())
}

fn validate_evidence(evidence: &[ChainEvidence]) -> Result<()> {
    require(
        !evidence.is_empty() && evidence.len() <= MAX_CHAIN_EVIDENCE,
        "a chain requires 1..8 evidence references",
    )?;
    let mut ids = HashSet::new();
    for reference in evidence {
        require(
            !reference.fragment_id.is_nil() && ids.insert(reference.fragment_id),
            "chain evidence must have distinct non-nil observation fragment IDs",
        )?;
        validate_text(&reference.reason, "evidence reason", 1024)?;
    }
    Ok(())
}

impl ChainDocument {
    pub fn search_text(&self) -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}",
            self.claim,
            self.conclusion,
            self.applicability,
            self.rationale,
            self.assumptions.join("\n")
        )
    }

    pub fn validate(&self) -> Result<()> {
        if let Some(formation) = &self.formation {
            validate_text(&formation.model, "formation model", 256)?;
            require(
                formation.prompt_version == 1,
                "unsupported formation prompt version",
            )?;
            crate::FormationInput {
                kind: self.kind,
                fragment_ids: formation.source_fragment_ids.clone(),
                chains: formation.source_chains.clone(),
                scope: None,
                agent_id: None,
            }
            .validate()?;
        }
        for (value, field, maximum) in [
            (&self.claim, "chain claim", 2048),
            (&self.rationale, "chain rationale", 4096),
            (&self.conclusion, "chain conclusion", 2048),
            (&self.applicability, "chain applicability", 2048),
        ] {
            validate_text(value, field, maximum)?;
        }
        require(
            self.assumptions.len() <= 8,
            "a chain accepts at most eight assumptions",
        )?;
        for assumption in &self.assumptions {
            validate_text(assumption, "chain assumption", 1024)?;
        }
        if !self.evidence.is_empty() {
            validate_evidence(&self.evidence)?;
        }
        match self.kind {
            KnowledgeKind::Chain => {
                require(
                    self.supported_by.is_empty(),
                    "chains reference observations, not other knowledge",
                )?;
                require(
                    self.evidence
                        .iter()
                        .any(|reference| reference.role == ChainEvidenceRole::Supports),
                    "a chain requires supporting observation evidence",
                )?;
            }
            KnowledgeKind::Principle => {
                require(
                    (2..=MAX_CHAIN_EVIDENCE).contains(&self.supported_by.len()),
                    "a principle requires 2..8 distinct supporting chain revisions",
                )?;
                require(
                    self.evidence
                        .iter()
                        .all(|reference| reference.role == ChainEvidenceRole::Counterexample),
                    "principle support comes from chains; direct observations are counterevidence",
                )?;
                let mut ids = HashSet::new();
                for support in &self.supported_by {
                    require(
                        !support.chain_id.is_nil()
                            && ids.insert(support.chain_id)
                            && support.revision > 0
                            && support.revision <= i32::MAX as u32,
                        "principle support requires distinct non-nil chain IDs and valid revisions",
                    )?;
                    validate_text(&support.reason, "principle support reason", 1024)?;
                }
            }
        }
        if let Some(confidence) = &self.reported_confidence {
            require(
                confidence.estimate.is_finite() && (0.0..=1.0).contains(&confidence.estimate),
                "reported confidence must be finite and in 0..=1",
            )?;
            validate_text(&confidence.method, "reported confidence method", 1024)?;
        }
        require(
            serde_json::to_vec(self)?.len() <= MAX_MEMORY_BYTES,
            "chain document exceeds its serialized byte budget",
        )
    }

    pub fn claim_key(&self) -> String {
        self.claim
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    }
}

impl ChainCommand {
    pub fn chain_id(&self) -> Uuid {
        match self {
            Self::Propose { chain_id, .. }
            | Self::Accept { chain_id, .. }
            | Self::Challenge { chain_id, .. }
            | Self::Revise { chain_id, .. }
            | Self::Retire { chain_id, .. } => *chain_id,
        }
    }

    pub fn expected_revision(&self) -> Option<u32> {
        match self {
            Self::Propose { .. } => None,
            Self::Accept {
                expected_revision, ..
            }
            | Self::Challenge {
                expected_revision, ..
            }
            | Self::Revise {
                expected_revision, ..
            }
            | Self::Retire {
                expected_revision, ..
            } => Some(*expected_revision),
        }
    }

    pub fn operation(&self) -> &'static str {
        match self {
            Self::Propose { .. } => "propose",
            Self::Accept { .. } => "accept",
            Self::Challenge { .. } => "challenge",
            Self::Revise { .. } => "revise",
            Self::Retire { .. } => "retire",
        }
    }

    pub fn validate(&self) -> Result<()> {
        require(!self.chain_id().is_nil(), "chainId must not be nil")?;
        require(
            self.expected_revision()
                .is_none_or(|revision| revision > 0 && revision < i32::MAX as u32),
            "expectedRevision must be a positive supported revision",
        )?;
        match self {
            Self::Propose { document, chain_id }
            | Self::Revise {
                document, chain_id, ..
            } => {
                document.validate()?;
                require(
                    document
                        .supported_by
                        .iter()
                        .all(|support| support.chain_id != *chain_id),
                    "knowledge cannot support itself",
                )
            }
            Self::Challenge { evidence, .. } => {
                validate_evidence(evidence)?;
                require(
                    evidence
                        .iter()
                        .all(|reference| reference.role == ChainEvidenceRole::Counterexample),
                    "a challenge must reference counterevidence",
                )
            }
            Self::Accept { validation, .. } => {
                for (value, field) in [
                    (&validation.method, "validation method"),
                    (&validation.result, "validation result"),
                    (&validation.source, "validation source"),
                ] {
                    validate_text(value, field, 2048)?;
                }
                require(
                    validation.counter_evidence_reviewed.len() <= MAX_CHAIN_EVIDENCE,
                    "too many reviewed counterevidence references",
                )
            }
            Self::Retire { .. } => Ok(()),
        }
    }

    pub fn apply(&self, previous: Option<&ChainSnapshot>) -> Result<ChainSnapshot> {
        self.validate()?;
        if let Self::Propose { document, .. } = self {
            require(previous.is_none(), "chainId already exists")?;
            return Ok(ChainSnapshot {
                document: document.clone(),
                state: ChainState::Candidate,
                review: ChainReview::Unreviewed,
                validation: None,
            });
        }
        let mut next = previous
            .cloned()
            .ok_or_else(|| InvalidInput("chain does not exist".into()))?;
        require(
            next.state != ChainState::Retired,
            "a retired chain cannot be revised or accepted",
        )?;
        match self {
            Self::Accept { validation, .. } => {
                let counters: HashSet<_> = next
                    .document
                    .evidence
                    .iter()
                    .filter(|reference| reference.role == ChainEvidenceRole::Counterexample)
                    .map(|reference| reference.fragment_id)
                    .collect();
                let reviewed: HashSet<_> = validation
                    .counter_evidence_reviewed
                    .iter()
                    .copied()
                    .collect();
                require(reviewed.len() == validation.counter_evidence_reviewed.len() && reviewed == counters, "validation must explicitly review every declared counterexample, without extras or duplicates")?;
                next.state = ChainState::Accepted;
                next.review = ChainReview::Reviewed;
                next.validation = Some(validation.clone());
            }
            Self::Challenge { evidence, .. } => {
                next.document.evidence.extend(evidence.clone());
                next.document.validate()?;
                next.review = ChainReview::Challenged;
            }
            Self::Revise { document, .. } => {
                require(
                    document.kind == next.document.kind,
                    "a revision must retain its knowledge kind",
                )?;
                require(next.document.evidence.iter().filter(|reference| reference.role == ChainEvidenceRole::Counterexample)
                    .all(|old| document.evidence.iter().any(|reference| reference.fragment_id == old.fragment_id && reference.role == old.role)),
                    "a revision must preserve known counterevidence; address it in validation instead of removing it")?;
                next.document = document.clone();
                next.state = ChainState::Candidate;
                next.review = ChainReview::Unreviewed;
                next.validation = None;
            }
            Self::Retire { .. } => next.state = ChainState::Retired,
            Self::Propose { .. } => unreachable!(),
        }
        Ok(next)
    }
}

#[derive(Clone, Debug, Default)]
pub struct ChainFilter {
    pub kind: Option<KnowledgeKind>,
    pub agent_id: Option<String>,
    pub scope: Option<String>,
    pub include_inactive: bool,
    pub include_candidates: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainRevision {
    pub chain_id: Uuid,
    pub memory_id: Uuid,
    pub revision: u32,
    pub agent_id: String,
    pub context: MemoryContext,
    pub created_at: i64,
    pub operation: String,
    pub current: bool,
    pub snapshot: ChainSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainEvidenceView {
    pub reference: ChainEvidence,
    pub memory_id: Option<Uuid>,
    pub text: Option<String>,
    pub agent_id: Option<String>,
    pub context: Option<MemoryContext>,
    pub lifecycle: Option<FactLifecycle>,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSupportView {
    pub reference: ChainSupport,
    pub document: Option<ChainDocument>,
    pub evidence: Vec<ChainEvidenceView>,
    pub memory_id: Option<Uuid>,
    pub current_revision: Option<u32>,
    pub state: Option<ChainState>,
    pub review: Option<ChainReview>,
    pub observation_sources: Vec<Uuid>,
    pub available: bool,
    pub requires_review: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainInspection {
    pub chain: ChainRevision,
    pub raw_text: String,
    pub evidence: Vec<ChainEvidenceView>,
    pub supporting_chains: Vec<ChainSupportView>,
    pub observation_sources: Vec<Uuid>,
    pub evidence_details_truncated: bool,
    pub requires_review: bool,
    pub history: Vec<ChainRevision>,
    pub next_revision: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainMatch {
    pub chain: ChainRevision,
    pub score: f64,
    pub vector_score: Option<f64>,
    pub keyword_score: Option<f64>,
    pub requires_review: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainSearchResponse {
    pub kind: &'static str,
    pub strategy: &'static str,
    pub results: Vec<ChainMatch>,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChainQuery {
    Search {
        query: String,
        kind: Option<KnowledgeKind>,
        #[serde(default)]
        include_candidates: bool,
    },
    Inspect {
        chain_id: Uuid,
        revision: Option<u32>,
        after_revision: Option<u32>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal() -> ChainCommand {
        ChainCommand::Propose {
            chain_id: Uuid::new_v4(),
            document: ChainDocument {
                formation: None,
                kind: KnowledgeKind::Chain,
                supported_by: vec![],
                claim: "Scoped retrieval helped this workload".into(),
                rationale: "Measured comparison".into(),
                conclusion: "Use it for matching tasks".into(),
                applicability: "This fixture only".into(),
                assumptions: vec![],
                evidence: vec![ChainEvidence {
                    fragment_id: Uuid::new_v4(),
                    role: ChainEvidenceRole::Supports,
                    reason: "Recorded test outcome".into(),
                }],
                reported_confidence: None,
            },
        }
    }

    #[test]
    fn candidate_challenge_revision_and_acceptance_keep_evidence_distinct() {
        let command = proposal();
        let chain_id = command.chain_id();
        let candidate = command.apply(None).unwrap();
        assert_eq!(candidate.state, ChainState::Candidate);
        assert_eq!(candidate.review, ChainReview::Unreviewed);
        let validation = ChainValidation {
            method: "Controlled comparison".into(),
            result: "Same correctness, lower input usage".into(),
            source: "test result".into(),
            counter_evidence_reviewed: vec![],
        };
        let accepted = ChainCommand::Accept {
            chain_id,
            expected_revision: 1,
            validation: validation.clone(),
        }
        .apply(Some(&candidate))
        .unwrap();
        let counter = ChainEvidence {
            fragment_id: Uuid::new_v4(),
            role: ChainEvidenceRole::Counterexample,
            reason: "Different task failed".into(),
        };
        let challenged = ChainCommand::Challenge {
            chain_id,
            expected_revision: 2,
            evidence: vec![counter.clone()],
        }
        .apply(Some(&accepted))
        .unwrap();
        assert_eq!(challenged.state, ChainState::Accepted);
        assert_eq!(challenged.review, ChainReview::Challenged);
        assert!(ChainCommand::Accept {
            chain_id,
            expected_revision: 3,
            validation: validation.clone()
        }
        .apply(Some(&challenged))
        .is_err());
        assert!(ChainCommand::Revise {
            chain_id,
            expected_revision: 3,
            document: candidate.document
        }
        .apply(Some(&challenged))
        .is_err());
        let mut narrowed = challenged.document.clone();
        narrowed.applicability = "Only the original measured task".into();
        let revision = ChainCommand::Revise {
            chain_id,
            expected_revision: 3,
            document: narrowed,
        }
        .apply(Some(&challenged))
        .unwrap();
        assert_eq!(revision.state, ChainState::Candidate);
        let validation = ChainValidation {
            counter_evidence_reviewed: vec![counter.fragment_id],
            ..validation
        };
        let accepted = ChainCommand::Accept {
            chain_id,
            expected_revision: 4,
            validation,
        }
        .apply(Some(&revision))
        .unwrap();
        assert_eq!(accepted.review, ChainReview::Reviewed);
        let retired = ChainCommand::Retire {
            chain_id,
            expected_revision: 5,
        }
        .apply(Some(&accepted))
        .unwrap();
        assert!(ChainCommand::Retire {
            chain_id,
            expected_revision: 6
        }
        .apply(Some(&retired))
        .is_err());
    }
}
