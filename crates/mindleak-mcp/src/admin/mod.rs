mod alerts;
mod azure;
mod bundle;
mod database;
mod operations;
mod process;
mod records;
mod repository;
mod schedule;
mod security;
mod settings;

use std::path::PathBuf;

use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Args)]
pub struct BackupArgs {
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[arg(long, global = true)]
    non_interactive: bool,
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    Doctor,
    Init(Change),
    Create {
        #[arg(long)]
        target: String,
        #[command(flatten)]
        change: Change,
    },
    Run {
        #[arg(long, required = true)]
        all: bool,
        #[arg(long)]
        verify: bool,
        #[command(flatten)]
        change: Change,
    },
    List {
        #[arg(long)]
        target: String,
    },
    Check {
        #[arg(long)]
        read_data: bool,
    },
    Verify {
        #[arg(long)]
        target: String,
        #[arg(long)]
        snapshot: String,
        #[command(flatten)]
        change: Change,
    },
    Restore {
        #[arg(long)]
        target: String,
        #[arg(long)]
        snapshot: String,
        #[arg(long)]
        new_db: String,
        #[command(flatten)]
        change: Change,
    },
    Retention {
        #[arg(long)]
        target: String,
        #[arg(long, requires = "yes", conflicts_with = "dry_run")]
        apply: bool,
        #[arg(long, requires = "apply")]
        yes: bool,
        #[command(flatten)]
        change: Change,
    },
    Status {
        #[arg(long)]
        check: bool,
    },
    Schedule {
        #[command(subcommand)]
        action: Schedule,
    },
}

#[derive(Args)]
struct Change {
    #[arg(long)]
    dry_run: bool,
}

#[derive(Subcommand)]
enum Schedule {
    Install {
        #[arg(long, required = true)]
        yes: bool,
        #[command(flatten)]
        change: Change,
    },
    Status,
    Remove {
        #[arg(long, required = true)]
        yes: bool,
        #[command(flatten)]
        change: Change,
    },
}

impl Action {
    fn dry_run(&self) -> bool {
        match self {
            Self::Init(change)
            | Self::Create { change, .. }
            | Self::Run { change, .. }
            | Self::Verify { change, .. }
            | Self::Restore { change, .. }
            | Self::Retention { change, .. } => change.dry_run,
            Self::Schedule {
                action: Schedule::Install { change, .. } | Schedule::Remove { change, .. },
            } => change.dry_run,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    stage: &'static str,
    code: &'static str,
    exit_code: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

type AdminResult<T> = Result<T, Failure>;

fn failure(stage: &'static str, code: &'static str, exit_code: u8) -> Failure {
    Failure {
        stage,
        code,
        exit_code,
        details: None,
    }
}

impl Failure {
    fn detail(mut self, key: &str, value: Value) -> Self {
        self.details.get_or_insert_with(|| json!({}))[key] = value;
        self
    }
}

pub async fn run(args: BackupArgs) -> u8 {
    let operation = Uuid::new_v4();
    let result = execute(&args).await;
    let (exit, report) = match result {
        Ok(value) => (
            0,
            json!({"formatVersion":1,"operationId":value.get("operationId").cloned().unwrap_or_else(|| json!(operation)),"state":"succeeded","result":value}),
        ),
        Err(error) => {
            let state = error
                .details
                .as_ref()
                .and_then(|details| details["operationState"].as_str())
                .unwrap_or(if error.exit_code == 130 {
                    "cancelled"
                } else {
                    "failed"
                });
            let id = error
                .details
                .as_ref()
                .and_then(|details| details["operationId"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| operation.to_string());
            (
                error.exit_code,
                json!({"formatVersion":1,"operationId":id,"state":state,"error":error}),
            )
        }
    };
    if args.json {
        println!("{report}");
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
        );
    }
    exit
}

pub fn argument_error() {
    println!(
        "{}",
        json!({"formatVersion":1,"operationId":Uuid::new_v4(),"state":"failed","error":failure("arguments", "invalid_arguments", 2)})
    );
}

async fn execute(args: &BackupArgs) -> AdminResult<Value> {
    let path = args
        .config
        .as_ref()
        .ok_or_else(|| failure("configuration", "explicit_config_required", 2))?;
    let config = settings::BackupConfig::read(path)?;
    config.validate()?;
    let cancel = tokio_util::sync::CancellationToken::new();
    let cancellation = cancel.clone();
    let listener = tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        cancellation.cancel();
    });
    let result = dispatch(&config, path, &args.action, &cancel).await;
    let result = match result {
        Err(error) if !args.action.dry_run() => match &args.action {
            Action::Create { target, .. }
            | Action::Verify { target, .. }
            | Action::Restore { target, .. }
            | Action::Retention {
                target,
                apply: true,
                ..
            } if config.targets.iter().any(|entry| &entry.id == target)
                && security::private(&config.work_dir, &cancel).await.is_ok() =>
            {
                alerts::preserve_failure(
                    &config,
                    target,
                    &error,
                    &tokio_util::sync::CancellationToken::new(),
                )
                .await
            }
            _ => Err(error),
        },
        result => result,
    };
    listener.abort();
    result
}

async fn dispatch(
    config: &settings::BackupConfig,
    config_path: &std::path::Path,
    action: &Action,
    cancel: &tokio_util::sync::CancellationToken,
) -> AdminResult<Value> {
    security::private(&config.work_dir, cancel).await?;
    match action {
        Action::Create { target, .. }
        | Action::Verify { target, .. }
        | Action::Restore { target, .. }
        | Action::Retention { target, .. }
        | Action::List { target } => {
            find_target(config, target)?;
        }
        _ => {}
    }
    if let Action::Verify { snapshot, .. } | Action::Restore { snapshot, .. } = action {
        if snapshot != "latest"
            && (snapshot.len() != 64 || !snapshot.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return Err(failure(
                "configuration",
                "exact_snapshot_id_or_latest_required",
                2,
            ));
        }
    }
    if let Action::Restore { target, new_db, .. } = action {
        if !settings::identifier(new_db)
            || ["postgres", "template0", "template1"].contains(&new_db.as_str())
            || find_target(config, target)?.database.as_ref() == Some(new_db)
        {
            return Err(failure("configuration", "new_database_required", 2));
        }
    }
    if action.dry_run() {
        return Ok(
            json!({"dryRun":true,"mutationsPerformed":false,"offMachineProtection":false,"runtimePrerequisitesChecked":false}),
        );
    }
    let restic = repository::Restic::new(config, cancel);
    let lease = if matches!(
        action,
        Action::Init(_)
            | Action::Create { .. }
            | Action::Run { .. }
            | Action::Verify { .. }
            | Action::Restore { .. }
            | Action::Retention { apply: true, .. }
    ) {
        azure::Lease::acquire(config, cancel).await?
    } else {
        None
    };
    let result = async { match action {
        Action::Doctor => {
            let version = restic.version().await?;
            restic.azure_access(false).await?;
            let available = fs2::available_space(&config.work_dir)
                .map_err(|_| failure("doctor", "disk_capacity_unavailable", 2))?;
            if available < config.policy.staging_reserve_bytes {
                return Err(failure("doctor", "insufficient_staging_space", 2));
            }
            let repository_id = match restic.id().await {
                Ok(id) => Some(id),
                Err(error) if error.code == "repository_not_initialized" => None,
                Err(error) => return Err(error),
            };
            let mut identities = std::collections::HashSet::new();
            let mut targets = Vec::new();
            for target in &config.targets {
                let database = database::Database::resolve(config, target, cancel).await?;
                if !identities.insert(database.identity.clone()) {
                    return Err(failure("configuration", "duplicate_database_target", 2));
                }
                targets.push(json!({"target":target.id,"databaseIdentity":database.identity,"engine":database.engine,"readOnlyPreflight":true}));
            }
            Ok(
                json!({"configurationValid":true,"resticVersion":version,"stagingFreeBytes":available,
                "repositoryInitialized":repository_id.is_some(),"repositoryId":repository_id,"targets":targets,"offMachineProtection":false}),
            )
        }
        Action::Init(_) => {
            let _lock = security::Lock::repository(config)?;
            Ok(
                json!({"repositoryId":restic.init().await?,"initialized":true,"offMachineProtection":false}),
            )
        }
        Action::Check { read_data } => {
            restic.check(*read_data).await?;
            Ok(
                json!({"repositoryId":restic.id().await?,"integrityChecked":true,"dataRead":read_data}),
            )
        }
        Action::List { target } => {
            find_target(config, target)?;
            let id = restic.id().await?;
            let state = records::read(config, target)?;
            let snapshots: Vec<_> = restic.snapshots(&id, target).await?.into_iter().map(|snapshot| json!({"snapshotId":snapshot.id,"createdAt":snapshot.time,
                "restoreVerified":state.last_verified_restore.as_ref().is_some_and(|receipt| receipt.repository_id == id && receipt.snapshot_id == snapshot.id)})).collect();
            Ok(json!({"target":target,"repositoryId":id,"snapshots":snapshots}))
        }
        Action::Retention { target, apply, .. } => {
            find_target(config, target)?;
            let _lock = if *apply {
                Some(security::Lock::repository(config)?)
            } else {
                None
            };
            restic.retention(&restic.id().await?, target, *apply).await
        }
        Action::Create { target, .. } => {
            operations::create(config, find_target(config, target)?, cancel).await
        }
        Action::Verify {
            target, snapshot, ..
        } => {
            operations::restore(config, find_target(config, target)?, snapshot, None, cancel).await
        }
        Action::Restore {
            target,
            snapshot,
            new_db,
            ..
        } => {
            operations::restore(
                config,
                find_target(config, target)?,
                snapshot,
                Some(new_db),
                cancel,
            )
            .await
        }
        Action::Run { verify, .. } => {
            let mut results = Vec::new();
            let mut identities = std::collections::HashSet::new();
            let mut preflight_errors = std::collections::BTreeMap::new();
            for target in &config.targets {
                match database::Database::resolve(config, target, cancel).await {
                    Ok(database) => if !identities.insert(database.identity) { return Err(failure("configuration", "duplicate_database_target", 2)); },
                    Err(error) => { preflight_errors.insert(target.id.clone(), error); }
                }
            }
            for target in &config.targets {
                let mut completed_backup = None;
                let result = match preflight_errors.remove(&target.id) {
                    Some(error) => Err(error),
                    None if cancel.is_cancelled() => Err(failure("targets", "cancelled", 130)),
                    None => operations::create(config, target, cancel).await,
                };
                let result = match result {
                    Ok(mut value) if *verify => {
                        completed_backup = Some(value.clone());
                        let snapshot = value["snapshotId"].as_str().unwrap().to_owned();
                        match operations::restore(config, target, &snapshot, None, cancel).await {
                            Ok(verified) => {
                                value["verification"] = verified;
                                Ok(value)
                            }
                            Err(error) => Err(error),
                        }
                    }
                    result => result,
                };
                match result {
                    Ok(result) => results.push(json!({"target":target.id,"state":"succeeded","result":result})),
                    Err(error) => {
                        let error = alerts::preserve_failure(config, &target.id, &error, &tokio_util::sync::CancellationToken::new()).await.err().unwrap_or(error);
                        results.push(json!({"target":target.id,"state":if error.exit_code == 130 { "cancelled" } else { "failed" },"error":error,"result":completed_backup}));
                    }
                }
            }
            if results.iter().any(|result| result["state"] != "succeeded") {
                return Err(Failure {
                    details: Some(json!({"targets":results})),
                    ..failure("targets", "partial_target_failure", if cancel.is_cancelled() { 130 } else { 4 })
                });
            }
            Ok(json!({"targets":results}))
        }
        Action::Status { check } => {
            let jobs = schedule::inspect(config, cancel).await?;
            let repository_id = if *check {
                restic.id().await.ok()
            } else {
                None
            };
            let mut targets = Vec::new();
            for target in &config.targets {
                let state = records::read(config, &target.id)?;
                let backup_overdue = state.last_backup.as_ref().is_none_or(|receipt| {
                    receipt.completed_at > chrono::Utc::now() || chrono::Utc::now()
                        .signed_duration_since(receipt.completed_at)
                        .num_hours()
                        >= i64::from(config.policy.backup_max_age_hours)
                });
                let restore_overdue = state.last_verified_restore.as_ref().is_none_or(|receipt| {
                    receipt.completed_at > chrono::Utc::now() || chrono::Utc::now()
                        .signed_duration_since(receipt.completed_at)
                        .num_days()
                        >= i64::from(config.policy.restore_max_age_days)
                });
                let unresolved = state.operations.iter().any(|operation| ["running", "outcomeUnknown"].contains(&operation.state.as_str()) || operation.cleanup_failed)
                    || config.work_dir.join("azure-lease.json").exists() || state.operations.last().is_some_and(|operation| {
                    operation.state != "succeeded"
                        || operation.cleanup_failed
                        || operation.alert_delivered == Some(false)
                });
                let repository_confirmed = if *check {
                    match &repository_id {
                        Some(id) => restic.snapshots(id, &target.id).await.is_ok_and(|snapshots| state.last_backup.as_ref().is_some_and(|receipt| receipt.repository_id == *id
                            && snapshots.iter().any(|snapshot| snapshot.id == receipt.snapshot_id))),
                        None => false,
                    }
                } else { false };
                let off_machine = config.repository.remote()
                    && !backup_overdue && !restore_overdue && repository_confirmed && !unresolved
                    && state.last_backup.as_ref().is_some_and(|receipt| {
                        repository_id.as_ref() == Some(&receipt.repository_id)
                    });
                targets.push(json!({"target":target.id,"lastCompletedBackup":state.last_backup,"lastVerifiedRestore":state.last_verified_restore,"lastOperation":state.operations.last(),
                    "backupOverdue":backup_overdue,"restoreOverdue":restore_overdue,"unresolvedFailure":unresolved,"repositoryConfirmed":repository_confirmed,"offMachineProtection":off_machine}));
            }
            let unhealthy = targets.iter().any(|target| {
                target["backupOverdue"] == true
                    || target["restoreOverdue"] == true
                    || target["unresolvedFailure"] == true
                    || *check && target["repositoryConfirmed"] != true
                    || config.policy.off_machine_required && target["offMachineProtection"] != true
            }) || config.schedule.enabled && jobs["installed"] != true;
            let mut alert_failed = false;
            if *check && unhealthy {
                for target in &mut targets {
                    let delivered = alerts::notify(config, target["target"].as_str().unwrap(), "status", "protection_overdue_or_failed", cancel).await?;
                    target["alertDelivered"] = json!(delivered);
                    alert_failed |= config.alerts.as_ref().is_some_and(|alerts| alerts.required) && delivered != Some(true);
                }
            }
            let value = json!({"targets":targets,"scheduler":jobs,"healthy":!unhealthy,"repositoryChecked":check});
            if *check && unhealthy {
                return Err(Failure {
                    details: Some(value),
                    ..failure("status", if alert_failed { "required_alert_delivery_failed" } else { "protection_overdue_or_failed" }, if alert_failed { 4 } else { 3 })
                });
            }
            Ok(value)
        }
        Action::Schedule { action } => match action {
            Schedule::Status => schedule::inspect(config, cancel).await,
            Schedule::Install { .. } => schedule::install(config, config_path, cancel).await,
            Schedule::Remove { .. } => schedule::remove(config, cancel).await,
        },
    } }.await;
    match lease {
        Some(lease) => lease.release(result).await,
        None => result,
    }
}

fn find_target<'config>(
    config: &'config settings::BackupConfig,
    id: &str,
) -> AdminResult<&'config settings::Target> {
    config
        .targets
        .iter()
        .find(|target| target.id == id)
        .ok_or_else(|| failure("configuration", "unknown_target", 2))
}
