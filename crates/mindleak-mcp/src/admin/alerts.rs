use chrono::Utc;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{
    failure,
    process::{self, Invocation},
    settings::BackupConfig,
    AdminResult,
};

pub(super) async fn notify(
    config: &BackupConfig,
    target: &str,
    stage: &str,
    code: &str,
    cancel: &CancellationToken,
) -> AdminResult<Option<bool>> {
    let Some(alerts) = &config.alerts else {
        return Ok(None);
    };
    let payload = json!({"target":target,"stage":stage,"code":code,"timestamp":Utc::now()});
    let mut success = true;
    if alerts.webhook_env.is_some() || alerts.webhook_file.is_some() {
        let result = async {
            let destination = super::security::reference(
                alerts.webhook_env.as_deref(),
                alerts.webhook_file.as_deref(),
                cancel,
            )
            .await?;
            let url = reqwest::Url::parse(&destination)
                .map_err(|_| failure("alert", "invalid_webhook_destination", 2))?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(failure("alert", "https_webhook_required", 2));
            }
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| failure("alert", "alert_client_failed", 4))?;
            let response = client
                .post(url)
                .json(&payload)
                .send()
                .await
                .map_err(|_| failure("alert", "alert_delivery_failed", 4))?;
            if !response.status().is_success() {
                return Err(failure("alert", "alert_delivery_failed", 4));
            }
            Ok(())
        }
        .await;
        success &= result.is_ok();
    }
    if alerts.os_event {
        let message = serde_json::to_string(&payload).unwrap();
        #[cfg(unix)]
        let command = Invocation::new("logger").args(["-t", "mindleak-backup", "--", &message]);
        #[cfg(windows)]
        let command = Invocation::new("eventcreate.exe").args([
            "/T",
            "ERROR",
            "/ID",
            "100",
            "/L",
            "APPLICATION",
            "/SO",
            "MindLeakBackup",
            "/D",
            &message,
        ]);
        success &= process::capture(&command, &[], 15, cancel, "alert")
            .await
            .is_ok_and(|output| output.code == 0);
    }
    Ok(Some(success))
}

pub(super) async fn preserve_failure(
    config: &BackupConfig,
    target: &str,
    error: &super::Failure,
    cancel: &CancellationToken,
) -> AdminResult<Value> {
    if error.exit_code == 6 {
        return Err(error.clone());
    }
    let _lock = super::security::Lock::acquire(
        &config
            .work_dir
            .join(format!("{}.lock", super::security::hash(target.as_bytes()))),
    )
    .map_err(|lock_error| error.clone().detail("statusError", json!(lock_error)))?;
    let delivered = notify(config, target, error.stage, error.code, cancel).await?;
    let mut state = super::records::read(config, target)
        .map_err(|status_error| error.clone().detail("statusError", json!(status_error)))?;
    let id = error
        .details
        .as_ref()
        .and_then(|details| details["operationId"].as_str())
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .unwrap_or_else(uuid::Uuid::new_v4);
    if !state.operations.iter().any(|operation| operation.id == id) {
        let mut operation = super::records::Operation::new(id, "preflight", error.stage);
        operation.state = if error.exit_code == 130 {
            "cancelled"
        } else {
            "failed"
        }
        .into();
        operation.completed_at = Some(Utc::now());
        operation.error_code = Some(error.code.into());
        state.operations.push(operation);
    }
    let operation = state
        .operations
        .iter_mut()
        .find(|operation| operation.id == id)
        .unwrap();
    operation.alert_delivered = delivered;
    let operation_state = operation.state.clone();
    let error = error
        .clone()
        .detail("operationId", json!(id))
        .detail("operationState", json!(operation_state));
    super::records::save(config, target, &mut state)
        .map_err(|status_error| error.clone().detail("statusError", json!(status_error)))?;
    if config.alerts.as_ref().is_some_and(|alerts| alerts.required) && delivered != Some(true) {
        return Err(super::Failure {
            details: Some(
                json!({"operationError":error,"alertDelivered":false,"operationId":id,"operationState":operation_state}),
            ),
            ..failure("alert", "required_alert_delivery_failed", 4)
        });
    }
    Err(error)
}
