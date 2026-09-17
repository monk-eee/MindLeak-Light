use std::collections::{HashMap, HashSet};

use anyhow::{ensure, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    validate_text, ChainDocument, ChainInspection, ChainSupport, FragmentInspection, InvalidInput,
    KnowledgeKind, MAX_CHAIN_EVIDENCE, MAX_FRAGMENT_BYTES, MAX_MEMORY_BYTES,
};

pub const MAX_FORMATION_CANDIDATES: usize = 3;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormationProvenance {
    pub model: String,
    pub prompt_version: u32,
    pub source_fragment_ids: Vec<Uuid>,
    pub source_chains: Vec<ChainSupport>,
}

#[derive(Clone, Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormationInput {
    pub kind: KnowledgeKind,
    #[serde(default)]
    pub fragment_ids: Vec<Uuid>,
    #[serde(default)]
    pub chains: Vec<ChainSupport>,
    pub scope: Option<String>,
    pub agent_id: Option<String>,
}

impl FormationInput {
    pub fn validate(&self) -> Result<()> {
        let distinct: HashSet<_> = self.fragment_ids.iter().collect();
        if self.fragment_ids.len() > MAX_CHAIN_EVIDENCE
            || distinct.len() != self.fragment_ids.len()
            || self.fragment_ids.iter().any(Uuid::is_nil)
        {
            return Err(InvalidInput(
                "formation requires at most 8 distinct observation IDs".into(),
            )
            .into());
        }
        let distinct: HashSet<_> = self.chains.iter().map(|source| source.chain_id).collect();
        if distinct.len() != self.chains.len()
            || self.chains.len() > MAX_CHAIN_EVIDENCE
            || self.chains.iter().any(|source| {
                source.chain_id.is_nil()
                    || source.revision == 0
                    || source.revision > i32::MAX as u32
            })
            || match self.kind {
                KnowledgeKind::Chain => self.fragment_ids.is_empty() || !self.chains.is_empty(),
                KnowledgeKind::Principle => self.chains.len() < 2,
            }
        {
            return Err(InvalidInput("chain formation needs observations; principle formation needs 2..8 distinct validated chain revisions".into()).into());
        }
        for source in &self.chains {
            validate_text(&source.reason, "chain selection reason", 1024)?;
        }
        for (field, value) in [("scope", &self.scope), ("agentId", &self.agent_id)] {
            if let Some(value) = value {
                validate_text(value, field, 256)?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormationContext {
    pub kind: KnowledgeKind,
    pub question: String,
    pub observations: Vec<FragmentInspection>,
    pub chains: Vec<ChainInspection>,
}

impl FormationContext {
    pub fn validate(&self) -> Result<()> {
        validate_text(&self.question, "text", MAX_MEMORY_BYTES)?;
        ensure!(
            self.observations.len() <= MAX_CHAIN_EVIDENCE
                && self.chains.len() <= MAX_CHAIN_EVIDENCE,
            "formation source limit exceeded"
        );
        ensure!(
            serde_json::to_vec(self)?.len() <= 128 * 1024,
            "formation sources exceed 128 KiB; select fewer sources"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormationCitation {
    pub fragment_id: Uuid,
    pub quote: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeFormation {
    pub documents: Vec<ChainDocument>,
    pub citations: Vec<FormationCitation>,
    pub gaps: Vec<String>,
}

impl KnowledgeFormation {
    pub fn validate(&self, sources: &FormationContext) -> Result<()> {
        ensure!(
            self.documents.len() <= MAX_FORMATION_CANDIDATES
                && self.gaps.len() <= 8
                && self.citations.len() <= MAX_CHAIN_EVIDENCE * (MAX_CHAIN_EVIDENCE + 1),
            "formation output exceeds its bounds"
        );
        ensure!(
            !self.documents.is_empty() || !self.gaps.is_empty(),
            "an empty formation must explain its evidence gaps"
        );
        for gap in &self.gaps {
            validate_text(gap, "formation gap", 2048)?;
        }
        let mut observations: HashMap<_, _> = sources
            .observations
            .iter()
            .map(|source| (source.fragment_id, source.text.as_str()))
            .collect();
        for chain in &sources.chains {
            for source in &chain.evidence {
                if let Some(text) = &source.text {
                    observations.insert(source.reference.fragment_id, text);
                }
            }
        }
        let mut citations = HashSet::new();
        for citation in &self.citations {
            validate_text(&citation.quote, "citation quote", MAX_FRAGMENT_BYTES)?;
            ensure!(
                citations.insert(citation.fragment_id)
                    && observations
                        .get(&citation.fragment_id)
                        .is_some_and(|source| source.contains(citation.quote.as_str())),
                "formation citation is duplicated, unknown or not an exact source quote"
            );
        }
        let mut claims = HashSet::new();
        for document in &self.documents {
            document.validate()?;
            ensure!(
                document.kind == sources.kind
                    && claims.insert((document.claim_key(), document.applicability.clone())),
                "formation kind mismatch or duplicate candidate"
            );
            ensure!(
                document
                    .evidence
                    .iter()
                    .all(|reference| citations.contains(&reference.fragment_id)),
                "every direct evidence reference needs a checked source citation"
            );
            ensure!(
                document.supported_by.iter().all(|support| sources
                    .chains
                    .iter()
                    .any(|source| source.chain.chain_id == support.chain_id
                        && source.chain.revision == support.revision)),
                "formation references an unselected supporting chain revision"
            );
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormationPreview {
    pub kind: &'static str,
    pub status: &'static str,
    pub model: String,
    pub validation: &'static str,
    pub proposal: KnowledgeFormation,
    pub source_fragment_ids: Vec<Uuid>,
    pub source_chains: Vec<ChainSupport>,
}

#[async_trait]
pub trait KnowledgeFormer: Send + Sync {
    fn model(&self) -> &str;
    fn capabilities(&self) -> crate::ProcessingCapabilities {
        crate::ProcessingCapabilities {
            mode: "custom",
            model: Some(self.model().into()),
        }
    }
    async fn form(&self, sources: &FormationContext) -> Result<KnowledgeFormation>;
}
