use std::path::Path;

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    failure,
    process::{self, Invocation},
    security,
    settings::{BackupConfig, Repository},
    AdminResult,
};

#[derive(Clone, Deserialize)]
pub(super) struct Snapshot {
    pub id: String,
    pub time: DateTime<Utc>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub summary: Option<SnapshotSummary>,
}

#[derive(Clone, Deserialize)]
pub(super) struct SnapshotSummary {
    pub total_files_processed: u64,
    pub total_bytes_processed: u64,
}

pub(super) struct Restic<'config> {
    pub config: &'config BackupConfig,
    pub cancel: CancellationToken,
}

impl<'config> Restic<'config> {
    pub fn new(config: &'config BackupConfig, cancel: &CancellationToken) -> Self {
        Self {
            config,
            cancel: cancel.clone(),
        }
    }

    pub async fn command(&self, arguments: &[String]) -> AdminResult<Invocation> {
        let mut command = Invocation::new(&self.config.tools.restic).args(["--no-cache", "--json"]);
        command.args.extend(arguments.iter().map(Into::into));
        command.env.insert(
            "RESTIC_PASSWORD".into(),
            security::secret(self.config.repository.password_file(), &self.cancel)
                .await?
                .into(),
        );
        command.env.insert("RESTIC_PROGRESS_FPS".into(), "0".into());
        command
            .env
            .insert("RESTIC_HOST".into(), "mindleak-backup-v1".into());
        command
            .env
            .insert("TMPDIR".into(), self.config.work_dir.as_os_str().to_owned());
        command
            .env
            .insert("TMP".into(), self.config.work_dir.as_os_str().to_owned());
        let location = match &self.config.repository {
            Repository::Local { path, .. } => path.as_os_str().to_owned(),
            Repository::Azure {
                container,
                prefix,
                account_env,
                sas_env,
                account_file,
                sas_file,
                ..
            } => {
                let account = security::reference(
                    account_env.as_deref(),
                    account_file.as_deref(),
                    &self.cancel,
                )
                .await?;
                let sas =
                    security::reference(sas_env.as_deref(), sas_file.as_deref(), &self.cancel)
                        .await?;
                if account.len() < 3
                    || account.len() > 24
                    || !account
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                    || sas.is_empty()
                    || sas.contains(['\r', '\n', '\0'])
                {
                    return Err(failure("secret", "invalid_azure_credentials", 2));
                }
                command
                    .env
                    .insert("AZURE_ACCOUNT_NAME".into(), account.into());
                command.env.insert("AZURE_ACCOUNT_SAS".into(), sas.into());
                format!("azure:{container}:/{prefix}").into()
            }
        };
        command.env.insert("RESTIC_REPOSITORY".into(), location);
        Ok(command)
    }

    pub async fn version(&self) -> AdminResult<String> {
        let bytes = process::succeeded(
            process::capture(
                &Invocation::new(&self.config.tools.restic).args(["version", "--json"]),
                &[],
                10,
                &self.cancel,
                "dependencies",
            )
            .await?,
            "dependencies",
        )?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| failure("dependencies", "invalid_restic_version", 2))?;
        let version = value["version"]
            .as_str()
            .ok_or_else(|| failure("dependencies", "invalid_restic_version", 2))?;
        if !version.starts_with("0.19.") {
            return Err(failure("dependencies", "restic_0_19_required", 2));
        }
        Ok(version.to_owned())
    }

    pub async fn output(
        &self,
        args: &[String],
        stage: &'static str,
    ) -> AdminResult<process::Output> {
        process::capture(
            &self.command(args).await?,
            &[],
            self.config.policy.repository_timeout_secs,
            &self.cancel,
            stage,
        )
        .await
    }

    pub async fn id(&self) -> AdminResult<String> {
        let bytes = process::succeeded(
            self.output(&["cat".into(), "config".into()], "repository_identity")
                .await?,
            "repository_identity",
        )?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| failure("repository_identity", "invalid_repository_identity", 3))?;
        let id = value["id"]
            .as_str()
            .filter(|id| full_id(id))
            .ok_or_else(|| failure("repository_identity", "invalid_repository_identity", 3))?;
        Ok(id.to_owned())
    }

    pub async fn init(&self) -> AdminResult<String> {
        self.version().await?;
        if let Repository::Local { path, .. } = &self.config.repository {
            if path.exists()
                && (!path.is_dir()
                    || std::fs::read_dir(path)
                        .map_err(|_| failure("init", "repository_unreadable", 2))?
                        .next()
                        .is_some())
            {
                return Err(failure("init", "repository_not_empty", 2));
            }
            security::private(
                path.parent()
                    .ok_or_else(|| failure("init", "repository_parent_required", 2))?,
                &self.cancel,
            )
            .await?;
        } else {
            self.azure_access(true).await?;
        }
        let existing = self
            .output(&["cat".into(), "config".into()], "init")
            .await?;
        if existing.code != 10 {
            return Err(failure(
                "init",
                "repository_exists_or_cannot_confirm_absence",
                2,
            ));
        }
        process::succeeded(
            self.output(
                &["init".into(), "--repository-version".into(), "2".into()],
                "init",
            )
            .await?,
            "init",
        )?;
        self.id().await
    }

    pub fn tag(&self, repository_id: &str, target: &str) -> String {
        format!(
            "ml-target-{}",
            security::hash(format!("{repository_id}:{target}").as_bytes())
        )
    }

    pub async fn snapshots(&self, repository_id: &str, target: &str) -> AdminResult<Vec<Snapshot>> {
        let tag = self.tag(repository_id, target);
        let bytes = process::succeeded(
            self.output(
                &[
                    "snapshots".into(),
                    "--tag".into(),
                    format!("ml-backup-v1,{tag}"),
                ],
                "list",
            )
            .await?,
            "list",
        )?;
        let mut snapshots: Vec<Snapshot> =
            serde_json::from_slice(&bytes).map_err(|_| failure("list", "invalid_snapshots", 3))?;
        if snapshots.len() > 10000
            || snapshots.iter().any(|snapshot| {
                !full_id(&snapshot.id)
                    || !snapshot.tags.contains(&tag)
                    || !snapshot.tags.iter().any(|tag| tag == "ml-backup-v1")
                    || snapshot
                        .tags
                        .iter()
                        .filter_map(|tag| tag.strip_prefix("ml-operation-"))
                        .filter(|id| Uuid::parse_str(id).is_ok())
                        .count()
                        != 1
            })
        {
            return Err(failure("list", "snapshot_identity_mismatch", 3));
        }
        snapshots.sort_by(|left, right| {
            right
                .time
                .cmp(&left.time)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(snapshots)
    }

    pub async fn resolve(
        &self,
        repository_id: &str,
        target: &str,
        requested: &str,
    ) -> AdminResult<Snapshot> {
        let snapshots = self.snapshots(repository_id, target).await?;
        snapshots
            .into_iter()
            .find(|snapshot| requested == "latest" || snapshot.id == requested)
            .ok_or_else(|| failure("snapshot", "target_snapshot_not_found", 2))
    }

    pub async fn backup(
        &self,
        root: &Path,
        repository_id: &str,
        target: &str,
        operation: Uuid,
    ) -> AdminResult<String> {
        let tag = self.tag(repository_id, target);
        let operation_tag = format!("ml-operation-{operation}");
        let mut command = self
            .command(&[
                "backup".into(),
                "--quiet".into(),
                "--tag".into(),
                "ml-backup-v1".into(),
                "--tag".into(),
                tag,
                "--tag".into(),
                operation_tag.clone(),
                "--stdin".into(),
                "--stdin-filename".into(),
                "bundle.tar".into(),
            ])
            .await?;
        command.cwd = Some(root.to_owned());
        command.input_file = Some(root.join("bundle.tar"));
        let bytes = process::succeeded(
            process::capture(
                &command,
                &[],
                self.config.policy.repository_timeout_secs,
                &self.cancel,
                "repository_commit",
            )
            .await?,
            "repository_commit",
        )?;
        let summary = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(serde_json::from_slice::<Value>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| failure("repository_commit", "acknowledgment_invalid", 3))?;
        let id = summary
            .iter()
            .find(|value| value["message_type"] == "summary")
            .and_then(|value| value["snapshot_id"].as_str())
            .filter(|id| full_id(id))
            .ok_or_else(|| failure("repository_commit", "acknowledgment_missing", 3))?;
        let snapshot = self.resolve(repository_id, target, id).await?;
        if !snapshot.tags.contains(&operation_tag) {
            return Err(failure(
                "repository_commit",
                "operation_identity_mismatch",
                3,
            ));
        }
        Ok(snapshot.id)
    }

    pub async fn restore(&self, snapshot: &Snapshot, destination: &Path) -> AdminResult<()> {
        use tokio::io::AsyncReadExt;
        let size = snapshot
            .summary
            .as_ref()
            .filter(|summary| {
                summary.total_files_processed == 1 && summary.total_bytes_processed >= 512
            })
            .map(|summary| summary.total_bytes_processed)
            .ok_or_else(|| failure("repository_restore", "complete_bundle_metadata_required", 5))?;
        let free = fs2::available_space(destination)
            .map_err(|_| failure("repository_restore", "disk_capacity_unavailable", 5))?;
        if size
            .saturating_mul(2)
            .saturating_add(self.config.policy.staging_reserve_bytes)
            > free
        {
            return Err(failure(
                "repository_restore",
                "insufficient_restore_space",
                5,
            ));
        }
        let command = self
            .command(&["dump".into(), snapshot.id.clone(), "bundle.tar".into()])
            .await?;
        let mut output =
            tokio::fs::File::from_std(security::create_file(&destination.join("bundle.tar"))?);
        let mut child = command
            .command()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| failure("repository_restore", "restic_unavailable", 2))?;
        let mut input = child.stdout.take().unwrap().take(size.saturating_add(1));
        let downloaded = async {
            let copied = tokio::io::copy(&mut input, &mut output)
                .await
                .map_err(|_| failure("repository_restore", "bundle_download_failed", 5))?;
            if copied != size {
                return Err(failure(
                    "repository_restore",
                    "bundle_download_size_mismatch",
                    5,
                ));
            }
            let exited = child
                .wait()
                .await
                .map_err(|_| failure("repository_restore", "restore_wait_failed", 5))?;
            process::succeeded(
                process::Output {
                    code: exited.code().unwrap_or(-1),
                    bytes: Vec::new(),
                },
                "repository_restore",
            )?;
            output
                .sync_all()
                .await
                .map_err(|_| failure("repository_restore", "bundle_sync_failed", 5))?;
            Ok(())
        };
        let result = tokio::select! { _ = self.cancel.cancelled() => Err(failure("repository_restore", "cancelled", 130)),
        result = tokio::time::timeout(std::time::Duration::from_secs(self.config.policy.restore_timeout_secs), downloaded) => result.unwrap_or_else(|_| Err(failure("repository_restore", "restore_timeout", 5))) };
        if result.is_err() {
            process::stop(&mut child).await;
        }
        result
    }

    async fn validate_recovery_point(
        &self,
        snapshot: &Snapshot,
        repository_id: &str,
        target: &str,
    ) -> AdminResult<()> {
        let temporary = tempfile::Builder::new()
            .prefix("retention-check-")
            .tempdir_in(&self.config.work_dir)
            .map_err(|_| failure("retention", "validation_directory_failed", 3))?;
        let checked = async {
            self.restore(snapshot, temporary.path()).await?;
            let capacity = fs2::available_space(temporary.path())
                .map_err(|_| failure("retention", "disk_capacity_unavailable", 3))?
                .saturating_sub(self.config.policy.staging_reserve_bytes);
            let manifest = super::bundle::unpack(temporary.path(), capacity)?;
            if manifest.repository_id != repository_id
                || manifest.target_id != target
                || !snapshot
                    .tags
                    .contains(&format!("ml-operation-{}", manifest.operation_id))
            {
                return Err(failure("retention", "recovery_point_identity_mismatch", 5));
            }
            Ok(())
        }
        .await;
        if temporary.close().is_err() {
            let error = failure("retention", "validation_cleanup_failed", 3);
            return Err(match checked {
                Ok(()) => error,
                Err(primary) => primary.detail("cleanupError", json!(error)),
            });
        }
        checked
    }

    pub async fn check(&self, read_data: bool) -> AdminResult<()> {
        let mut args = vec!["check".into()];
        if read_data {
            args.push("--read-data".into());
        }
        process::succeeded(
            self.output(&args, "repository_check").await?,
            "repository_check",
        )?;
        Ok(())
    }

    pub async fn azure_access(&self, require_empty: bool) -> AdminResult<()> {
        super::azure::access(self.config, require_empty, &self.cancel).await
    }

    pub async fn retention(
        &self,
        repository_id: &str,
        target: &str,
        apply: bool,
    ) -> AdminResult<Value> {
        let before = self.snapshots(repository_id, target).await?;
        let latest = before
            .first()
            .ok_or_else(|| failure("retention", "no_complete_snapshot", 2))?;
        let tag = format!("ml-backup-v1,{}", self.tag(repository_id, target));
        let policy = &self.config.retention;
        let args = vec![
            "forget".into(),
            "--dry-run".into(),
            "--tag".into(),
            tag,
            "--group-by".into(),
            "".into(),
            "--keep-last".into(),
            policy.last.to_string(),
            "--keep-daily".into(),
            policy.daily.to_string(),
            "--keep-weekly".into(),
            policy.weekly.to_string(),
            "--keep-monthly".into(),
            policy.monthly.to_string(),
        ];
        let bytes = process::succeeded(
            self.output(&args, "retention_plan").await?,
            "retention_plan",
        )?;
        let groups: Vec<Value> = serde_json::from_slice(&bytes)
            .map_err(|_| failure("retention", "invalid_retention_plan", 3))?;
        let removed: Vec<String> = groups
            .iter()
            .flat_map(|group| group["remove"].as_array().into_iter().flatten())
            .map(|snapshot| snapshot["id"].as_str().unwrap_or_default().to_owned())
            .collect();
        let unique: std::collections::HashSet<_> = removed.iter().collect();
        if groups.len() != 1
            || groups.iter().any(|group| {
                group.get("keep").is_none_or(|value| !value.is_array())
                    || group
                        .get("remove")
                        .is_none_or(|value| !value.is_null() && !value.is_array())
            })
            || unique.len() != removed.len()
            || removed.iter().any(|id| !full_id(id))
        {
            return Err(failure("retention", "invalid_retention_plan", 3));
        }
        let protected: Vec<_> = before.iter().take(2).map(|snapshot| &snapshot.id).collect();
        if removed
            .iter()
            .any(|id| !before.iter().any(|snapshot| &snapshot.id == id) || protected.contains(&id))
        {
            return Err(failure(
                "retention",
                "minimum_recovery_points_would_be_removed",
                2,
            ));
        }
        if !apply {
            return Ok(
                json!({"apply":false,"snapshotIdsToRemove":removed,"preservedSnapshots":before.len()-removed.len()}),
            );
        }
        let _target_lock = security::Lock::acquire(
            &self
                .config
                .work_dir
                .join(format!("{}.lock", security::hash(target.as_bytes()))),
        )?;
        let mut state = super::records::read(self.config, target)?;
        if state.operations.iter().any(|operation| {
            ["running", "outcomeUnknown"].contains(&operation.state.as_str())
                || operation.cleanup_failed
        }) {
            return Err(failure(
                "retention",
                "unresolved_operation_blocks_retention",
                6,
            ));
        }
        let verified = state
            .last_verified_restore
            .as_ref()
            .ok_or_else(|| failure("retention", "latest_restore_receipt_required", 2))?;
        if verified.repository_id != repository_id
            || verified.snapshot_id != latest.id
            || verified.profile != "mindleak-0.4-pg16-v1"
            || before.len().saturating_sub(removed.len()) < 2
            || removed.contains(&verified.snapshot_id)
            || state.last_backup.as_ref().is_none_or(|receipt| {
                receipt.repository_id != repository_id
                    || receipt.snapshot_id != latest.id
                    || receipt.profile != super::bundle::PROFILE
            })
        {
            return Err(failure("retention", "latest_restore_receipt_required", 2));
        }
        for snapshot in before.iter().take(2) {
            self.validate_recovery_point(snapshot, repository_id, target)
                .await?;
        }
        let current = self.snapshots(repository_id, target).await?;
        if current
            .iter()
            .map(|snapshot| &snapshot.id)
            .collect::<Vec<_>>()
            != before
                .iter()
                .map(|snapshot| &snapshot.id)
                .collect::<Vec<_>>()
        {
            return Err(failure("retention", "stale_retention_plan", 6));
        }
        let operation = Uuid::new_v4();
        let mut record = super::records::Operation::new(operation, "retention", "forget");
        record.repository_id = Some(repository_id.into());
        record.planned_removals = removed.clone();
        state.operations.push(record);
        super::records::save(self.config, target, &mut state)?;
        let result = async {
            if !removed.is_empty() {
                let mut forget = vec!["forget".into()]; forget.extend(removed.clone());
                let forgotten = self.output(&forget, "forget").await.and_then(|output| process::succeeded(output, "forget"));
                let current = self.snapshots(repository_id, target).await;
                if let Ok(current) = &current {
                    state.operations.last_mut().unwrap().removed_snapshot_ids = removed.iter().filter(|id| !current.iter().any(|snapshot| &snapshot.id == *id)).cloned().collect();
                }
                super::records::save(self.config, target, &mut state)?;
                forgotten?; current?;
                if state.operations.last().unwrap().removed_snapshot_ids != removed { return Err(failure("forget", "deletion_not_fully_acknowledged", 3)); }
                state.operations.last_mut().unwrap().stage = "prune".into(); super::records::save(self.config, target, &mut state)?;
                let pruned = self.output(&["prune".into()], "prune_after_forget").await.and_then(|output| process::succeeded(output, "prune_after_forget"));
                let checked = self.check(false).await;
                if let Err(error) = pruned { return Err(error.detail("integrityChecked", json!(checked.is_ok()))); }
                checked?;
            } else { self.check(false).await?; }
            Ok(json!({"operationId":operation,"apply":true,"removedSnapshotIds":removed,"integrityChecked":true}))
        }.await;
        let record = state.operations.last_mut().unwrap();
        record.completed_at = Some(Utc::now());
        record.state = match &result {
            Ok(_) => "succeeded",
            Err(_) if record.stage == "forget" => "outcomeUnknown",
            Err(_) => "failed",
        }
        .into();
        if let Err(error) = &result {
            record.error_code = Some(error.code.into());
        }
        let saved = super::records::save(self.config, target, &mut state);
        match result {
            Err(error) => Err(error
                .detail("operationId", json!(operation))
                .detail(
                    "operationState",
                    json!(state.operations.last().unwrap().state),
                )
                .detail(
                    "removedSnapshotIds",
                    json!(state.operations.last().unwrap().removed_snapshot_ids),
                )
                .detail("statusSaved", json!(saved.is_ok()))),
            Ok(value) => {
                saved.map_err(|error| error.detail("operationResult", value.clone()))?;
                Ok(value)
            }
        }
    }
}

fn full_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
