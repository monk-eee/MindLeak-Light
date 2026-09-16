use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::{
    validate_text, InvalidInput, KeywordMatchMode, RecallMatch, MAX_DOCUMENT_CONTEXT_FRAGMENTS,
};

const DAY_SECONDS: f64 = 86_400.0;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryContext {
    pub scope: Option<String>,
    pub session_id: Option<String>,
    pub source: Option<String>,
    pub summary: Option<String>,
}

impl MemoryContext {
    pub fn validate(&self) -> Result<()> {
        for (name, value, maximum) in [
            ("context.scope", self.scope.as_deref(), 256),
            ("context.sessionId", self.session_id.as_deref(), 256),
            ("context.source", self.source.as_deref(), 1024),
            ("context.summary", self.summary.as_deref(), 2048),
        ] {
            if let Some(value) = value {
                validate_text(value, name, maximum)?;
            }
        }
        Ok(())
    }
}

#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum MemoryTier {
    #[default]
    ShortTerm,
    LongTerm,
}

impl MemoryTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ShortTerm => "short_term",
            Self::LongTerm => "long_term",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FactState {
    #[default]
    Active,
    Archived,
    Superseded,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    #[default]
    Unconfirmed,
    Confirmed,
    Disputed,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactLifecycle {
    pub tier: MemoryTier,
    pub state: FactState,
    pub evidence: EvidenceStatus,
    pub pinned: bool,
    pub useful_sessions: u32,
    pub confirmed_sessions: u32,
    pub created_at: i64,
    pub reinforced_at: i64,
    pub first_evidence_at: Option<i64>,
}

impl FactLifecycle {
    pub fn activation(&self, now: i64, importance: f32) -> f64 {
        if self.state != FactState::Active {
            return 0.0;
        }
        if self.pinned {
            return 1.0;
        }
        let age = now
            .saturating_sub(self.reinforced_at.max(self.created_at))
            .max(0) as f64;
        let days = match self.tier {
            MemoryTier::ShortTerm => 7.0,
            MemoryTier::LongTerm => 90.0,
        };
        let salience = 0.5 + 0.5 * f64::from(importance.clamp(0.0, 1.0));
        salience * (-age / (days * DAY_SECONDS)).exp2()
    }

    pub fn eligible_for_consolidation(&self, now: i64) -> bool {
        self.state == FactState::Active
            && self.evidence != EvidenceStatus::Disputed
            && (self.confirmed_sessions >= 2 || self.useful_sessions >= 3)
            && self.reinforced_at <= now
            && self
                .first_evidence_at
                .is_some_and(|first| self.reinforced_at.saturating_sub(first) >= 86_400)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecallFilter {
    pub agent_id: Option<String>,
    pub scope: Option<String>,
    pub tier: Option<MemoryTier>,
    #[serde(default)]
    pub include_inactive: bool,
    #[serde(default)]
    pub match_mode: KeywordMatchMode,
    #[serde(default)]
    pub diagnostics: bool,
    #[serde(default)]
    pub context_limit: usize,
    #[serde(default)]
    pub group_duplicates: bool,
}

impl RecallFilter {
    pub fn validate(&self) -> Result<()> {
        if self.context_limit > MAX_DOCUMENT_CONTEXT_FRAGMENTS {
            return Err(InvalidInput(format!(
                "contextLimit must be in 0..={MAX_DOCUMENT_CONTEXT_FRAGMENTS}"
            ))
            .into());
        }
        for (name, value) in [
            ("agentId", self.agent_id.as_deref()),
            ("scope", self.scope.as_deref()),
        ] {
            if let Some(value) = value {
                validate_text(value, name, 256)?;
            }
        }
        Ok(())
    }

    pub fn accepts(&self, fact: &RecallMatch) -> bool {
        self.agent_id
            .as_deref()
            .is_none_or(|agent| fact.agent_id == agent)
            && self
                .scope
                .as_deref()
                .is_none_or(|scope| fact.context.scope.as_deref() == Some(scope))
            && self.tier.is_none_or(|tier| fact.lifecycle.tier == tier)
            && (self.include_inactive || fact.lifecycle.state == FactState::Active)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_term_activation_fades_without_deleting_or_changing_the_fact() {
        let lifecycle = FactLifecycle::default();
        assert_eq!(lifecycle.activation(0, 1.0), 1.0);
        assert_eq!(lifecycle.activation(7 * 86_400, 1.0), 0.5);
        assert_eq!(lifecycle.activation(14 * 86_400, 1.0), 0.25);
        assert_eq!(lifecycle.state, FactState::Active);
        assert_eq!(lifecycle.evidence, EvidenceStatus::Unconfirmed);
    }

    #[test]
    fn long_term_and_pinned_facts_remain_available_longer() {
        let mut lifecycle = FactLifecycle {
            tier: MemoryTier::LongTerm,
            ..Default::default()
        };
        assert_eq!(lifecycle.activation(90 * 86_400, 1.0), 0.5);
        lifecycle.pinned = true;
        assert_eq!(lifecycle.activation(3650 * 86_400, 1.0), 1.0);
        lifecycle.state = FactState::Superseded;
        assert_eq!(lifecycle.activation(3650 * 86_400, 1.0), 0.0);
    }

    #[test]
    fn consolidation_requires_spaced_feedback_and_is_not_a_truth_claim() {
        let mut lifecycle = FactLifecycle {
            useful_sessions: 3,
            first_evidence_at: Some(0),
            reinforced_at: 86_400,
            ..Default::default()
        };
        assert!(!lifecycle.eligible_for_consolidation(60));
        assert!(lifecycle.eligible_for_consolidation(86_400));
        assert_eq!(lifecycle.evidence, EvidenceStatus::Unconfirmed);
        lifecycle.evidence = EvidenceStatus::Disputed;
        assert!(!lifecycle.eligible_for_consolidation(86_400));
        lifecycle.evidence = EvidenceStatus::Confirmed;
        lifecycle.useful_sessions = 0;
        lifecycle.confirmed_sessions = 2;
        assert!(lifecycle.eligible_for_consolidation(86_400));
        lifecycle.state = FactState::Archived;
        assert!(!lifecycle.eligible_for_consolidation(86_400));
    }

    #[test]
    fn clocks_and_salience_cannot_create_unbounded_activation() {
        let lifecycle = FactLifecycle {
            created_at: 100,
            reinforced_at: 200,
            ..Default::default()
        };
        assert_eq!(lifecycle.activation(0, 1.0), 1.0);
        assert_eq!(lifecycle.activation(200, 0.0), 0.5);
        assert_eq!(lifecycle.activation(200, 1.0), 1.0);
    }

    #[test]
    fn burst_feedback_does_not_become_spaced_practice_by_waiting() {
        let lifecycle = FactLifecycle {
            confirmed_sessions: 2,
            first_evidence_at: Some(0),
            reinforced_at: 60,
            ..Default::default()
        };
        assert!(!lifecycle.eligible_for_consolidation(7 * 86_400));
    }

    #[test]
    fn context_is_optional_but_supplied_fields_must_be_useful_and_bounded() {
        assert!(MemoryContext::default().validate().is_ok());
        assert!(MemoryContext {
            scope: Some(" ".into()),
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(MemoryContext {
            summary: Some("x".repeat(2049)),
            ..Default::default()
        }
        .validate()
        .is_err());
    }
}
