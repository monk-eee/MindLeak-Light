use chrono::Utc;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    bundle::{self, Manifest, PROFILE},
    database::Database,
    failure,
    records::{self, Operation, Receipt, TargetState},
    repository::Restic,
    security,
    settings::{BackupConfig, Target},
    AdminResult,
};

pub(super) async fn create(
    config: &BackupConfig,
    target: &Target,
    cancel: &CancellationToken,
) -> AdminResult<Value> {
    let operation = Uuid::new_v4();
    let _repository_lock = security::Lock::repository(config)?;
    let _target_lock = security::Lock::acquire(
        &config
            .work_dir
            .join(format!("{}.lock", security::hash(target.id.as_bytes()))),
    )?;
    let mut state = records::read(config, &target.id)?;
    let restic = Restic::new(config, cancel);
    restic.version().await?;
    let repository_id = restic.id().await?;
    if state
        .operations
        .iter()
        .any(|operation| ["running", "outcomeUnknown"].contains(&operation.state.as_str()))
    {
        return reconcile(&restic, &target.id, &repository_id, &mut state).await;
    }
    restic.azure_access(false).await?;
    let database = Database::resolve(config, target, cancel).await?;
    let root = config.work_dir.join(format!("operation-{operation}"));
    security::directory(&root)?;
    security::atomic_json(
        &root.join("ownership.json"),
        &json!({"operationId":operation,"target":target.id}),
    )?;
    let mut record = Operation::new(operation, "create", "capture");
    record.repository_id = Some(repository_id.clone());
    state.operations.push(record);
    records::save(config, &target.id, &mut state)?;
    let result = async {
        let files = bundle::capture_assets(target, &root, config, cancel)?;
        let snapshot = database.snapshot(cancel).await?;
        let available = fs2::available_space(&root).map_err(|_| failure("capture", "disk_capacity_unavailable", 3))?;
        if available < snapshot.fingerprint.database_bytes.saturating_mul(2).saturating_add(config.policy.staging_reserve_bytes) { snapshot.close().await; return Err(failure("capture", "insufficient_staging_space", 3)); }
        let dump = root.join("database.dump");
        let dumped = database.dump(&snapshot, &dump, cancel).await;
        let fingerprint = snapshot.fingerprint.clone(); snapshot.close().await; dumped?;
        let manifest = Manifest { format_version: 1, target_id: target.id.clone(), repository_id: repository_id.clone(), operation_id: operation, created_at: Utc::now(),
            engine: database.engine.clone(), image_id: database.image_id.clone(), database_identity: database.identity.clone(), database: fingerprint,
            dump_sha256: security::hash_file(&dump)?, files, external_sources: target.external_sources.clone(), verification_profile: PROFILE.into() };
        bundle::pack(&root, &manifest)?;
        state.operations.last_mut().unwrap().bundle_sha256 = Some(security::hash_file(&root.join("bundle.tar"))?);
        state.operations.last_mut().unwrap().stage = "repository_commit".into(); records::save(config, &target.id, &mut state)?;
        let id = restic.backup(&root, &repository_id, &target.id, operation).await?;
        state.last_backup = Some(Receipt { repository_id: repository_id.clone(), snapshot_id: id.clone(), operation_id: operation, completed_at: Utc::now(), profile: PROFILE.into() });
        state.operations.last_mut().unwrap().snapshot_id = Some(id.clone());
        state.operations.last_mut().unwrap().stage = "backup_complete".into();
        Ok(json!({"target":target.id,"operationId":operation,"snapshotId":id,"repositoryId":repository_id,
            "backupComplete":true,"restoreVerified":false,"offMachineProtection":config.repository.remote(),
            "rows":manifest.database.rows,"schemaSha256":manifest.database.schema_sha256,"includedAssets":manifest.files.len(),"externalOnlySources":manifest.external_sources.len()}))
    }.await;
    finish(config, &target.id, &mut state, &root, operation, &result)?;
    result
}

pub(super) async fn restore(
    config: &BackupConfig,
    target: &Target,
    requested: &str,
    new_database: Option<&str>,
    cancel: &CancellationToken,
) -> AdminResult<Value> {
    let operation = Uuid::new_v4();
    let _repository_lock = security::Lock::repository(config)?;
    let _target_lock = security::Lock::acquire(
        &config
            .work_dir
            .join(format!("{}.lock", security::hash(target.id.as_bytes()))),
    )?;
    let restic = Restic::new(config, cancel);
    restic.version().await?;
    let repository_id = restic.id().await?;
    let snapshot = restic
        .resolve(&repository_id, &target.id, requested)
        .await?;
    restic.check(false).await?;
    let database = Database::restore_server(config, target, cancel).await?;
    let root = config.work_dir.join(format!("operation-{operation}"));
    security::directory(&root)?;
    security::atomic_json(
        &root.join("ownership.json"),
        &json!({"operationId":operation,"target":target.id}),
    )?;
    let mut state = records::read(config, &target.id)?;
    let previous_verified = state.last_verified_restore.clone();
    let mut record = Operation::new(
        operation,
        if new_database.is_some() {
            "restore"
        } else {
            "verify"
        },
        "restore",
    );
    record.snapshot_id = Some(snapshot.id.clone());
    record.repository_id = Some(repository_id.clone());
    state.operations.push(record);
    records::save(config, &target.id, &mut state)?;
    let mut owned = None;
    let mut result = async {
        restic.restore(&snapshot, &root).await?;
        let capacity = fs2::available_space(&root).map_err(|_| failure("restore", "disk_capacity_unavailable", 5))?.saturating_sub(config.policy.staging_reserve_bytes);
        let manifest = bundle::unpack(&root, capacity)?;
        if manifest.target_id != target.id || manifest.repository_id != repository_id || !snapshot.tags.contains(&format!("ml-operation-{}", manifest.operation_id)) { return Err(failure("restore", "snapshot_target_identity_mismatch", 5)); }
        if manifest.engine.version != database.engine.version || manifest.engine.sha256 != database.engine.sha256 { return Err(failure("restore", "matching_engine_artifact_required", 5)); }
        let name = new_database.map(str::to_owned).unwrap_or_else(|| format!("mindleak_restore_{}_test", operation.simple()));
        owned = Some(database.create_destination(&name, operation, cancel).await?);
        let restored = database.with_name(&name);
        restored.restore(&root.join("database.dump"), cancel).await?;
        let verify = restored.snapshot(cancel).await?;
        let equal = verify.fingerprint.matches(&manifest.database);
        let compared = json!({"records":verify.fingerprint.records_sha256 == manifest.database.records_sha256,
            "schema":verify.fingerprint.schema_sha256 == manifest.database.schema_sha256,"counts":verify.fingerprint.rows == manifest.database.rows,
            "embeddingBinding":verify.fingerprint.embedding_binding == manifest.database.embedding_binding,
            "extensions":verify.fingerprint.extensions == manifest.database.extensions,"databaseSettings":verify.fingerprint.database_settings == manifest.database.database_settings,
            "schemaComponents":manifest.database.schema_components.iter().map(|(name, hash)| (name.clone(), json!(verify.fingerprint.schema_components.get(name) == Some(hash)))).collect::<serde_json::Map<_, _>>()});
        verify.close().await;
        if !equal { return Err(failure("verify", "restored_records_mismatch", 5).detail("fingerprintMatches", compared)); }
        let canaries = restored.verify_mcp(&manifest.database, cancel).await?;
        let after = restored.snapshot(cancel).await?;
        let unchanged = after.fingerprint.matches(&manifest.database); after.close().await;
        if !unchanged { return Err(failure("verify", "verification_modified_records", 5)); }
        state.last_verified_restore = Some(Receipt { repository_id: repository_id.clone(), snapshot_id: snapshot.id.clone(), operation_id: operation, completed_at: Utc::now(), profile: PROFILE.into() });
        Ok(json!({"target":target.id,"operationId":operation,"snapshotId":snapshot.id,"repositoryId":repository_id,
            "restoredDatabase":new_database.map(|_| name),"restoreVerified":true,"workingDatabaseChanged":false,"schemaUnchanged":true,"canaries":canaries,"assetsVerified":manifest.files.len(),
            "assetsDirectory":new_database.map(|_| root.join("assets")),"offMachineProtection":config.repository.remote()}))
    }.await;
    let mut cleanup_error = None;
    if new_database.is_none() || result.is_err() {
        if let Some(owned) = &owned {
            if let Err(error) = database.drop_owned(owned).await {
                cleanup_error = Some(error);
            }
        }
    }
    if let Some(error) = cleanup_error {
        state.operations.last_mut().unwrap().cleanup_failed = true;
        state.last_verified_restore = previous_verified.clone();
        result = Err(cleanup_failure(&result, &[error]));
    }
    if new_database.is_some() && result.is_ok() {
        let retained = result.as_ref().unwrap().clone();
        for name in ["database.dump", "bundle.tar"] {
            if std::fs::remove_file(root.join(name)).is_err() {
                state.operations.last_mut().unwrap().cleanup_failed = true;
                state.last_verified_restore = previous_verified.clone();
                result = Err(cleanup_failure(
                    &result,
                    &[failure("cleanup", "restore_staging_cleanup_failed", 5)],
                )
                .detail("retainedRestore", retained));
                break;
            }
        }
        record_result(&mut state, &result);
        records::save(config, &target.id, &mut state).map_err(|error| {
            error.detail(
                "operationResult",
                result.as_ref().ok().cloned().unwrap_or(Value::Null),
            )
        })?;
    } else {
        if let Err(error) = finish(config, &target.id, &mut state, &root, operation, &result) {
            if state
                .operations
                .last()
                .is_some_and(|record| record.cleanup_failed)
            {
                state.last_verified_restore = previous_verified;
            }
            if let Err(status_error) = records::save(config, &target.id, &mut state) {
                return Err(cleanup_failure(&Err(error), &[status_error]));
            }
            return Err(error);
        }
    }
    result
}

fn record_result(state: &mut TargetState, result: &AdminResult<Value>) {
    let record = state.operations.last_mut().unwrap();
    record.completed_at = Some(Utc::now());
    match result {
        Ok(_) => record.state = "succeeded".into(),
        Err(error) => {
            record.error_code = Some(error.code.into());
            record.tool_exit_code = error
                .details
                .as_ref()
                .and_then(|details| details["toolExitCode"].as_i64())
                .and_then(|code| i32::try_from(code).ok());
            record.state = if record.stage == "repository_commit" {
                "outcomeUnknown"
            } else if error.exit_code == 130 {
                "cancelled"
            } else {
                "failed"
            }
            .into();
        }
    }
}

fn finish(
    config: &BackupConfig,
    target: &str,
    state: &mut TargetState,
    root: &std::path::Path,
    operation: Uuid,
    result: &AdminResult<Value>,
) -> AdminResult<()> {
    let cleaned = remove_staging(root, operation, target).is_ok();
    state.operations.last_mut().unwrap().cleanup_failed |= !cleaned;
    let mut outcome = result.clone();
    if !cleaned {
        outcome = Err(cleanup_failure(
            &outcome,
            &[failure("cleanup", "owned_staging_cleanup_failed", 3)],
        ));
    }
    record_result(state, &outcome);
    if let Err(error) = records::save(config, target, state) {
        outcome = Err(cleanup_failure(&outcome, &[error]));
    }
    outcome.map(|_| ()).map_err(|error| {
        error
            .detail("operationId", json!(operation))
            .detail(
                "operationState",
                json!(state.operations.last().unwrap().state),
            )
            .detail(
                "snapshotId",
                json!(state.operations.last().unwrap().snapshot_id),
            )
    })
}

fn cleanup_failure(result: &AdminResult<Value>, errors: &[super::Failure]) -> super::Failure {
    let error = result
        .as_ref()
        .err()
        .cloned()
        .unwrap_or_else(|| errors[0].clone());
    let mut combined = error
        .details
        .as_ref()
        .and_then(|details| details["cleanupErrors"].as_array())
        .cloned()
        .unwrap_or_default();
    combined.extend(errors.iter().map(|error| json!(error)));
    let error = error.detail("cleanupErrors", json!(combined));
    match result {
        Ok(value) => error.detail("operationResult", value.clone()),
        Err(_) => error,
    }
}

fn remove_staging(root: &std::path::Path, operation: Uuid, target: &str) -> AdminResult<()> {
    super::settings::safe_path(root)?;
    let marker = std::fs::read(root.join("ownership.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    if marker.is_some_and(|marker| {
        marker["operationId"] == operation.to_string() && marker["target"] == target
    }) && std::fs::remove_dir_all(root).is_ok()
    {
        Ok(())
    } else {
        Err(failure("cleanup", "owned_staging_cleanup_failed", 3))
    }
}

async fn reconcile(
    restic: &Restic<'_>,
    target: &str,
    repository_id: &str,
    state: &mut TargetState,
) -> AdminResult<Value> {
    let pending: Vec<_> = state
        .operations
        .iter()
        .enumerate()
        .filter(|(_, record)| ["running", "outcomeUnknown"].contains(&record.state.as_str()))
        .collect();
    let unresolved = || {
        failure(
            "reconcile",
            "unresolved_operation_requires_operator_review",
            6,
        )
        .detail("operationState", json!("outcomeUnknown"))
    };
    if pending.len() != 1 {
        return Err(unresolved());
    }
    let (index, record) = pending[0];
    let record = record.clone();
    if record.action != "create"
        || record.stage != "repository_commit"
        || record.repository_id.as_deref() != Some(repository_id)
        || record.bundle_sha256.is_none()
        || record.tool_exit_code.is_some_and(|code| code != 0)
        || record.cleanup_failed
    {
        return Err(unresolved());
    }
    restic.check(false).await?;
    let matching: Vec<_> = restic
        .snapshots(repository_id, target)
        .await?
        .into_iter()
        .filter(|snapshot| {
            snapshot
                .tags
                .contains(&format!("ml-operation-{}", record.id))
        })
        .collect();
    if matching.len() != 1 {
        return Err(unresolved());
    }
    let snapshot = &matching[0];
    let operation = Uuid::new_v4();
    let root = restic
        .config
        .work_dir
        .join(format!("reconcile-{operation}"));
    security::directory(&root)?;
    security::atomic_json(
        &root.join("ownership.json"),
        &json!({"operationId":operation,"target":target}),
    )?;
    let checked = async {
        restic.restore(snapshot, &root).await?;
        if security::hash_file(&root.join("bundle.tar"))?.as_str()
            != record.bundle_sha256.as_deref().unwrap()
        {
            return Err(unresolved());
        }
        Ok(json!({}))
    }
    .await;
    if let Err(error) = remove_staging(&root, operation, target) {
        return Err(cleanup_failure(&checked, &[error]));
    }
    checked?;
    let previous = restic
        .config
        .work_dir
        .join(format!("operation-{}", record.id));
    if previous.exists() {
        remove_staging(&previous, record.id, target)?;
    }
    state.operations[index].state = "succeeded".into();
    state.operations[index].stage = "reconciled".into();
    state.operations[index].snapshot_id = Some(snapshot.id.clone());
    state.operations[index].completed_at = Some(Utc::now());
    state.last_backup = Some(Receipt {
        repository_id: repository_id.into(),
        snapshot_id: snapshot.id.clone(),
        operation_id: record.id,
        completed_at: snapshot.time,
        profile: PROFILE.into(),
    });
    records::save(restic.config, target, state)?;
    Ok(
        json!({"target":target,"operationId":record.id,"repositoryId":repository_id,"snapshotId":snapshot.id,"reconciled":true,"backupComplete":true,"restoreVerified":false,"offMachineProtection":restic.config.repository.remote()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_failure_preserves_the_primary_error() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let config: BackupConfig = serde_json::from_value(json!({"schemaVersion":1,"repository":{"kind":"local","path":root.join("repository"),"passwordFile":root.join("key")},"workDir":root,"targets":[{"id":"fixture","container":"fixture"}]})).unwrap();
        let operation = Uuid::new_v4();
        let staging = root.join("unowned");
        security::directory(&staging).unwrap();
        let mut state = TargetState::default();
        state
            .operations
            .push(Operation::new(operation, "create", "capture"));
        let result = Err(failure("database_dump", "primary_dump_failure", 3));
        let error = finish(&config, "fixture", &mut state, &staging, operation, &result)
            .err()
            .unwrap();
        assert_eq!(error.code, "primary_dump_failure");
        assert_eq!(
            error.details.as_ref().unwrap()["cleanupErrors"][0]["code"],
            "owned_staging_cleanup_failed"
        );
        assert!(staging.exists());
        let recorded = records::read(&config, "fixture").unwrap();
        assert_eq!(
            recorded.operations.last().unwrap().error_code.as_deref(),
            Some("primary_dump_failure")
        );
        assert!(recorded.operations.last().unwrap().cleanup_failed);
    }
}
