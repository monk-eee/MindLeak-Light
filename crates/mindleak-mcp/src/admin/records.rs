use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{failure, security, settings::BackupConfig, AdminResult};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Receipt {
    pub repository_id: String,
    pub snapshot_id: String,
    pub operation_id: Uuid,
    pub completed_at: DateTime<Utc>,
    pub profile: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Operation {
    pub id: Uuid,
    pub action: String,
    pub state: String,
    pub stage: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub snapshot_id: Option<String>,
    pub error_code: Option<String>,
    pub cleanup_failed: bool,
    pub alert_delivered: Option<bool>,
    pub repository_id: Option<String>,
    pub bundle_sha256: Option<String>,
    pub tool_exit_code: Option<i32>,
    pub process_id: u32,
    pub planned_removals: Vec<String>,
    pub removed_snapshot_ids: Vec<String>,
}

impl Operation {
    pub fn new(id: Uuid, action: &str, stage: &str) -> Self {
        Self {
            id,
            action: action.into(),
            state: "running".into(),
            stage: stage.into(),
            started_at: Utc::now(),
            completed_at: None,
            snapshot_id: None,
            error_code: None,
            cleanup_failed: false,
            alert_delivered: None,
            repository_id: None,
            bundle_sha256: None,
            tool_exit_code: None,
            process_id: std::process::id(),
            planned_removals: Vec::new(),
            removed_snapshot_ids: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TargetState {
    pub last_backup: Option<Receipt>,
    pub last_verified_restore: Option<Receipt>,
    pub operations: Vec<Operation>,
}

pub(super) fn state_path(config: &BackupConfig, target: &str) -> std::path::PathBuf {
    config
        .work_dir
        .join(format!("target-{}.json", security::hash(target.as_bytes())))
}

pub(super) fn read(config: &BackupConfig, target: &str) -> AdminResult<TargetState> {
    let path = state_path(config, target);
    if !path.exists() {
        return Ok(TargetState::default());
    }
    let bytes = security::read_bounded(&path, 1024 * 1024)
        .map_err(|_| failure("status", "status_unavailable_or_large", 3))?;
    serde_json::from_slice(&bytes).map_err(|_| failure("status", "invalid_status", 3))
}

pub(super) fn save(
    config: &BackupConfig,
    target: &str,
    state: &mut TargetState,
) -> AdminResult<()> {
    if state.operations.len() > 128 {
        let remove = state.operations.len() - 128;
        if state.operations[..remove]
            .iter()
            .any(|operation| operation.state != "succeeded")
        {
            return Err(failure(
                "status",
                "unresolved_history_requires_operator_review",
                6,
            ));
        }
        state.operations.drain(..remove);
    }
    security::atomic_json(&state_path(config, target), state)
}
