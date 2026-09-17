use anyhow::Result;
use serde::{Deserialize, Serialize};

use uuid::Uuid;

use crate::{
    validate_text, InvalidInput, KeywordMatchMode, MemoryContext, RecallFilter,
    RelationshipDirection, MAX_RECALL_LIMIT,
};

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainIdentity {
    pub namespace: String,
    pub id: String,
}

impl DomainIdentity {
    pub fn validate(&self) -> Result<()> {
        for (field, value) in [
            ("domain namespace", &self.namespace),
            ("domain id", &self.id),
        ] {
            validate_text(value, field, 256)?;
            if value.trim() != value || value.chars().any(char::is_control) {
                return Err(InvalidInput(format!(
                    "{field} must not contain control characters or surrounding whitespace"
                ))
                .into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DomainWrite {
    Entity {
        identity: DomainIdentity,
        label: String,
        entity_type: String,
    },
    Edge {
        identity: DomainIdentity,
        source: DomainIdentity,
        target: DomainIdentity,
        predicate: String,
        provenance: EdgeProvenance,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeProvenance {
    pub source_references: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        description = "Confidence reported by the source, not verified truth or a similarity score."
    )]
    pub reported_confidence: Option<f64>,
}

impl DomainWrite {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Entity {
                identity,
                label,
                entity_type,
            } => {
                identity.validate()?;
                validate_text(label, "entity label", 1024)?;
                validate_text(entity_type, "entityType", 256)
            }
            Self::Edge {
                identity,
                source,
                target,
                predicate,
                provenance,
            } => {
                identity.validate()?;
                source.validate()?;
                target.validate()?;
                validate_predicate(predicate)?;
                if !(1..=8).contains(&provenance.source_references.len()) {
                    return Err(InvalidInput(
                        "edge provenance requires 1..8 sourceReferences".into(),
                    )
                    .into());
                }
                for reference in &provenance.source_references {
                    validate_text(reference, "source reference", 1024)?;
                }
                if provenance
                    .reported_confidence
                    .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                {
                    return Err(InvalidInput("reportedConfidence must be finite and in 0..=1; it is a source claim, not verified truth".into()).into());
                }
                Ok(())
            }
        }
    }

    pub fn identity(&self) -> &DomainIdentity {
        match self {
            Self::Entity { identity, .. } | Self::Edge { identity, .. } => identity,
        }
    }
}

fn validate_predicate(predicate: &str) -> Result<()> {
    validate_text(predicate, "domain predicate", 256)?;
    if predicate.trim() != predicate || predicate.chars().any(char::is_control) {
        return Err(InvalidInput(
            "domain predicate must not contain control characters or surrounding whitespace".into(),
        )
        .into());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainCursor {
    pub entity: DomainIdentity,
    pub predicate: Option<String>,
    pub direction: RelationshipDirection,
    pub agent_id: Option<String>,
    pub scope: Option<String>,
    pub edge_predicate: String,
    pub edge_memory_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DomainQuery {
    Entity {
        identity: DomainIdentity,
        predicate: Option<String>,
        direction: Option<RelationshipDirection>,
        after: Option<DomainCursor>,
    },
    Edge {
        identity: DomainIdentity,
    },
}

impl DomainQuery {
    pub fn validate(&self, filter: &RecallFilter, limit: usize) -> Result<()> {
        filter.validate()?;
        if !(1..=MAX_RECALL_LIMIT).contains(&limit)
            || filter.tier.is_some()
            || filter.include_inactive
            || filter.match_mode != KeywordMatchMode::Websearch
            || filter.diagnostics
            || filter.context_limit != 0
            || filter.group_duplicates
        {
            return Err(InvalidInput("domain inspection accepts limit 1..50, scope and agentId; fact lifecycle and search controls do not apply".into()).into());
        }
        match self {
            Self::Entity {
                identity,
                predicate,
                direction,
                after,
            } => {
                identity.validate()?;
                if let Some(predicate) = predicate {
                    validate_predicate(predicate)?;
                }
                if let Some(cursor) = after {
                    validate_predicate(&cursor.edge_predicate)?;
                    if predicate
                        .as_ref()
                        .is_some_and(|predicate| predicate != &cursor.edge_predicate)
                    {
                        return Err(InvalidInput(
                            "domain cursor predicate does not match the requested predicate".into(),
                        )
                        .into());
                    }
                }
                if direction.is_none() && (predicate.is_some() || after.is_some()) {
                    return Err(InvalidInput(
                        "domain predicate and cursor require an explicit direction".into(),
                    )
                    .into());
                }
                if after.as_ref().is_some_and(|cursor| {
                    &cursor.entity != identity
                        || &cursor.predicate != predicate
                        || Some(cursor.direction) != *direction
                        || cursor.agent_id != filter.agent_id
                        || cursor.scope != filter.scope
                }) {
                    return Err(InvalidInput("domain cursor belongs to a different entity, predicate, direction or filters".into()).into());
                }
            }
            Self::Edge { identity } => identity.validate()?,
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainRecord {
    pub memory_id: Uuid,
    pub agent_id: String,
    pub raw_text: String,
    pub context: MemoryContext,
    pub domain: DomainWrite,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainInspection {
    pub record: DomainRecord,
    pub relationships: Vec<DomainRecord>,
    pub next_cursor: Option<DomainCursor>,
    pub scanned_relationships: usize,
}
