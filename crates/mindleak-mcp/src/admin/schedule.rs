use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{
    alerts, bundle::PROFILE, failure, records, repository::Restic, security,
    settings::BackupConfig, AdminResult,
};

#[cfg(any(target_os = "linux", target_os = "windows"))]
use super::process::{self, Invocation};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    owner: String,
    platform: String,
    config_path: PathBuf,
    config_sha256: String,
    binary: PathBuf,
    binary_sha256: String,
    jobs: Vec<Job>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    name: String,
    target: String,
    definition_sha256: String,
    path: Option<PathBuf>,
    unit_hashes: Option<[String; 2]>,
}

#[cfg(any(target_os = "linux", test))]
fn owned_unit_files(job: &Job) -> AdminResult<Vec<PathBuf>> {
    let path = job
        .path
        .as_ref()
        .ok_or_else(|| failure("schedule", "job_path_missing", 6))?;
    let timer = path.with_extension("timer");
    let hashes = job
        .unit_hashes
        .as_ref()
        .ok_or_else(|| failure("schedule", "unit_ownership_hashes_missing", 6))?;
    let mut existing = Vec::new();
    for (file, hash) in [path, &timer].into_iter().zip(hashes) {
        super::settings::safe_path(file)?;
        match std::fs::symlink_metadata(file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(failure("schedule", "job_definition_unavailable", 6)),
            Ok(_) => {}
        }
        if security::hash_file(file)? != *hash {
            return Err(failure("schedule", "job_definition_changed", 6));
        }
        existing.push(file.clone());
    }
    Ok(existing)
}

fn registry_path(config: &BackupConfig) -> PathBuf {
    config.work_dir.join("schedule.json")
}

fn registry(config: &BackupConfig) -> AdminResult<Option<Registry>> {
    let path = registry_path(config);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = security::read_bounded(&path, 1024 * 1024)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| failure("schedule", "invalid_schedule_registry", 2))
}

fn args(config_path: &Path, _target: &str, verify: bool) -> Vec<String> {
    let mut args = vec!["backup".into(), "run".into(), "--all".into()];
    if verify {
        args.push("--verify".into());
    }
    args.extend([
        "--config".into(),
        config_path.to_string_lossy().into_owned(),
        "--json".into(),
        "--non-interactive".into(),
    ]);
    args
}

#[cfg(any(not(target_os = "windows"), test))]
fn systemd_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    )
}

#[cfg(any(not(target_os = "windows"), test))]
pub(super) fn definitions(
    config: &BackupConfig,
    config_path: &Path,
    binary: &Path,
    target: &str,
    verify: bool,
) -> (String, String) {
    let command = std::iter::once(binary.to_string_lossy().into_owned())
        .chain(args(config_path, target, verify))
        .map(|arg| systemd_quote(&arg))
        .collect::<Vec<_>>()
        .join(" ");
    let budget = config.targets.len() as u64
        * (config.policy.backup_timeout_secs
            + config.policy.repository_timeout_secs * 10
            + if verify {
                config.policy.restore_timeout_secs * 4 + config.policy.backup_timeout_secs * 2
            } else {
                0
            }
            + 120);
    let service = format!("[Unit]\nDescription=MindLeak owned backup operation\n[Service]\nType=oneshot\nUMask=0077\nExecStart={command}\nTimeoutStartSec={budget}\n");
    let time = if verify {
        &config.schedule.weekly
    } else {
        &config.schedule.daily
    };
    let calendar = format!(
        "{}*-*-* {time}:00 {}",
        if verify { "Sun " } else { "" },
        config.schedule.timezone
    );
    let timer = format!("[Unit]\nDescription=MindLeak owned backup timer\n[Timer]\nOnCalendar={calendar}\nPersistent=true\n[Install]\nWantedBy=timers.target\n");
    (service, timer)
}

pub(super) async fn inspect(
    config: &BackupConfig,
    cancel: &CancellationToken,
) -> AdminResult<Value> {
    let Some(registry) = registry(config)? else {
        return Ok(json!({"installed":false,"expected":config.schedule.enabled,"jobs":[]}));
    };
    let mut jobs = Vec::new();
    for job in &registry.jobs {
        if !job
            .name
            .starts_with(&format!("mindleak-{}-", registry.owner))
        {
            return Err(failure("schedule", "job_ownership_mismatch", 6));
        }
        #[cfg(target_os = "linux")]
        {
            let output = process::capture(
                &Invocation::new("systemctl").args([
                    "--user",
                    "show",
                    &format!("{}.timer", job.name),
                    "--property=LoadState",
                    "--property=ActiveState",
                    "--property=NextElapseUSecRealtime",
                    "--property=LastTriggerUSec",
                ]),
                &[],
                15,
                cancel,
                "schedule_status",
            )
            .await?;
            let text = String::from_utf8_lossy(&output.bytes);
            let properties: std::collections::BTreeMap<_, _> = text
                .lines()
                .filter_map(|line| line.split_once('='))
                .collect();
            let enabled = process::capture(
                &Invocation::new("systemctl").args([
                    "--user",
                    "is-enabled",
                    &format!("{}.timer", job.name),
                ]),
                &[],
                15,
                cancel,
                "schedule_status",
            )
            .await?;
            jobs.push(json!({"name":job.name,"target":job.target,"present":properties.get("LoadState")==Some(&"loaded"),"active":properties.get("ActiveState")==Some(&"active"),"enabled":enabled.code==0,"lastTrigger":properties.get("LastTriggerUSec"),"nextRun":properties.get("NextElapseUSecRealtime")}));
            let definition_matches = job.path.as_ref().is_some_and(|path| {
                security::read_bounded(path, 1024 * 1024)
                    .ok()
                    .zip(security::read_bounded(&path.with_extension("timer"), 1024 * 1024).ok())
                    .is_some_and(|(service, timer)| {
                        security::hash(&[service, timer].concat()) == job.definition_sha256
                    })
            });
            jobs.last_mut().unwrap()["definitionMatches"] = json!(definition_matches);
        }
        #[cfg(target_os = "windows")]
        {
            let script = include_str!("scheduled-task.ps1");
            let mut command = Invocation::new("powershell.exe").args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ]);
            command
                .env
                .insert("ML_JOB_NAME".into(), job.name.clone().into());
            command.env.insert("ML_JOB_ACTION".into(), "inspect".into());
            let bytes = process::succeeded(
                process::capture(&command, &[], 15, cancel, "schedule_status").await?,
                "schedule_status",
            )?;
            let mut value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| failure("schedule", "invalid_scheduler_response", 3))?;
            value["name"] = json!(job.name);
            value["target"] = json!(job.target);
            value["definitionMatches"] = json!(
                value["definitionSha256"] == job.definition_sha256
                    && value["owner"] == registry.owner
                    && value["logonType"] == "S4U"
            );
            jobs.push(value);
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            let _ = cancel;
            jobs.push(json!({"name":job.name,"target":job.target,"present":false,"platformUnsupported":true}));
        }
    }
    let unchanged = security::hash_file(&registry.config_path).ok().as_deref()
        == Some(&registry.config_sha256)
        && security::hash_file(&registry.binary).ok().as_deref() == Some(&registry.binary_sha256);
    let installed = registry.platform == std::env::consts::OS
        && unchanged
        && jobs.len() == 2
        && jobs.iter().all(|job| {
            job["present"] == true
                && job["enabled"] == true
                && job["active"] == true
                && job["definitionMatches"] == true
        });
    Ok(
        json!({"installed":installed,"expected":config.schedule.enabled,"definitionUnchanged":unchanged,"jobs":jobs}),
    )
}

pub(super) async fn install(
    config: &BackupConfig,
    config_path: &Path,
    cancel: &CancellationToken,
) -> AdminResult<Value> {
    if !cfg!(any(target_os = "linux", target_os = "windows")) {
        return Err(failure(
            "schedule",
            "scheduling_requires_windows_or_systemd",
            2,
        ));
    }
    if !config.schedule.enabled {
        return Err(failure(
            "schedule",
            "schedule_preferences_must_be_enabled_explicitly",
            2,
        ));
    }
    if config.alerts.as_ref().is_none_or(|alerts| {
        !alerts.os_event && alerts.webhook_env.is_none() && alerts.webhook_file.is_none()
    }) {
        return Err(failure("schedule", "observable_alert_route_required", 2));
    }
    if matches!(
        &config.repository,
        super::settings::Repository::Azure {
            account_env: Some(_),
            ..
        } | super::settings::Repository::Azure {
            sas_env: Some(_),
            ..
        }
    ) || config
        .alerts
        .as_ref()
        .is_some_and(|alerts| alerts.webhook_env.is_some())
    {
        return Err(failure(
            "schedule",
            "persistent_file_credentials_required_for_scheduler",
            2,
        ));
    }
    let mut tools = vec![&config.tools.restic];
    if config
        .targets
        .iter()
        .chain(config.restore_target.iter())
        .any(|target| target.container.is_some())
    {
        tools.push(&config.tools.container);
    }
    if config
        .targets
        .iter()
        .chain(config.restore_target.iter())
        .any(|target| target.connection_file.is_some())
    {
        tools.extend([
            &config.tools.psql,
            &config.tools.pg_dump,
            &config.tools.pg_restore,
        ]);
    }
    if tools
        .iter()
        .any(|path| !path.is_absolute() || !path.is_file())
    {
        return Err(failure(
            "schedule",
            "absolute_tool_paths_required_for_scheduler",
            2,
        ));
    }
    #[cfg(target_os = "linux")]
    {
        let uid = unsafe { libc::geteuid() }.to_string();
        let output = process::succeeded(
            process::capture(
                &Invocation::new("loginctl").args([
                    "show-user",
                    &uid,
                    "--property=Linger",
                    "--value",
                ]),
                &[],
                15,
                cancel,
                "schedule_prerequisites",
            )
            .await?,
            "schedule_prerequisites",
        )?;
        if String::from_utf8_lossy(&output).trim() != "yes" {
            return Err(failure(
                "schedule",
                "operator_must_enable_user_lingering",
                2,
            ));
        }
        process::succeeded(
            process::capture(
                &Invocation::new("systemd-analyze").args([
                    "calendar",
                    &format!(
                        "Sun *-*-* {}:00 {}",
                        config.schedule.weekly, config.schedule.timezone
                    ),
                ]),
                &[],
                15,
                cancel,
                "schedule_prerequisites",
            )
            .await?,
            "schedule_prerequisites",
        )?;
    }
    let _lock = security::Lock::repository(config)?;
    let restic = Restic::new(config, cancel);
    let id = restic.id().await?;
    restic.azure_access(false).await?;
    let targets: Vec<_> = config
        .targets
        .iter()
        .filter(|target| {
            config.schedule.targets.is_empty() || config.schedule.targets.contains(&target.id)
        })
        .collect();
    if targets.len() != config.targets.len() {
        return Err(failure(
            "schedule",
            "schedule_all_configured_targets_or_use_separate_config",
            2,
        ));
    }
    for target in &targets {
        let state = records::read(config, &target.id)?;
        let latest = restic.resolve(&id, &target.id, "latest").await?;
        let valid = state
            .last_backup
            .as_ref()
            .zip(state.last_verified_restore.as_ref())
            .is_some_and(|(backup, verified)| {
                backup.repository_id == id
                    && verified.repository_id == id
                    && backup.snapshot_id == latest.id
                    && verified.snapshot_id == latest.id
                    && verified.profile == PROFILE
                    && Utc::now()
                        .signed_duration_since(backup.completed_at)
                        .num_hours()
                        < i64::from(config.policy.backup_max_age_hours)
                    && Utc::now()
                        .signed_duration_since(verified.completed_at)
                        .num_days()
                        < i64::from(config.policy.restore_max_age_days)
            });
        if !valid {
            return Err(failure(
                "schedule",
                "successful_initial_backup_and_restore_required",
                2,
            ));
        }
        if alerts::notify(
            config,
            &target.id,
            "schedule_install",
            "alert_route_test",
            cancel,
        )
        .await?
            != Some(true)
        {
            return Err(failure("schedule", "alert_route_test_failed", 4));
        }
    }
    if registry(config)?.is_some() {
        return Err(failure("schedule", "owned_schedule_already_registered", 6));
    }
    let binary =
        std::env::current_exe().map_err(|_| failure("schedule", "absolute_binary_required", 2))?;
    let config_path = config_path
        .canonicalize()
        .map_err(|_| failure("schedule", "absolute_config_required", 2))?;
    let owner =
        security::hash(format!("{}:{}", config_path.display(), uuid::Uuid::new_v4()).as_bytes())
            [..20]
            .to_owned();
    let mut registry = Registry {
        owner: owner.clone(),
        platform: std::env::consts::OS.into(),
        config_path: config_path.clone(),
        config_sha256: security::hash_file(&config_path)?,
        binary: binary.clone(),
        binary_sha256: security::hash_file(&binary)?,
        jobs: Vec::new(),
    };
    for target in ["all"] {
        for verify in [false, true] {
            let name = format!(
                "mindleak-{owner}-{}-{}",
                &security::hash(target.as_bytes())[..12],
                if verify { "weekly" } else { "daily" }
            );
            #[cfg(not(target_os = "windows"))]
            let (service, timer) = definitions(config, &config_path, &binary, target, verify);
            #[cfg(target_os = "linux")]
            {
                let home = std::env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .or_else(|| {
                        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"))
                    })
                    .ok_or_else(|| failure("schedule", "user_config_directory_unavailable", 2))?;
                let directory = home.join("systemd/user");
                std::fs::create_dir_all(&directory)
                    .map_err(|_| failure("schedule", "user_units_directory_unavailable", 2))?;
                super::settings::safe_path(&directory)?;
                let path = directory.join(format!("{name}.service"));
                let timer_path = directory.join(format!("{name}.timer"));
                if path.exists() || timer_path.exists() {
                    return Err(failure("schedule", "job_already_exists", 6));
                }
                registry.jobs.push(Job {
                    name: name.clone(),
                    target: target.into(),
                    definition_sha256: security::hash(format!("{service}{timer}").as_bytes()),
                    path: Some(path.clone()),
                    unit_hashes: Some([
                        security::hash(service.as_bytes()),
                        security::hash(timer.as_bytes()),
                    ]),
                });
                security::atomic_json(&registry_path(config), &registry)?;
                let mut service_file = security::create_file(&path)?;
                std::io::Write::write_all(&mut service_file, service.as_bytes())
                    .map_err(|_| failure("schedule", "service_write_failed", 3))?;
                service_file
                    .sync_all()
                    .map_err(|_| failure("schedule", "service_write_failed", 3))?;
                let mut timer_file = security::create_file(&timer_path)?;
                std::io::Write::write_all(&mut timer_file, timer.as_bytes())
                    .map_err(|_| failure("schedule", "timer_write_failed", 3))?;
                timer_file
                    .sync_all()
                    .map_err(|_| failure("schedule", "timer_write_failed", 3))?;
            }
            #[cfg(target_os = "windows")]
            {
                let time = if verify {
                    &config.schedule.weekly
                } else {
                    &config.schedule.daily
                };
                let script = include_str!("scheduled-task.ps1");
                let command_args = args(&config_path, target, verify)
                    .iter()
                    .map(|arg| format!("\"{}\"", arg.replace('"', "\\\"")))
                    .collect::<Vec<_>>()
                    .join(" ");
                let mut command = Invocation::new("powershell.exe").args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    script,
                ]);
                for (key, value) in [
                    ("ML_JOB_NAME", name.clone()),
                    ("ML_BINARY", binary.to_string_lossy().into_owned()),
                    ("ML_ARGUMENTS", command_args),
                    ("ML_TIME", time.clone()),
                    ("ML_TIMEZONE", config.schedule.timezone.clone()),
                    ("ML_WEEKLY", verify.to_string()),
                    ("ML_OWNER", owner.clone()),
                    ("ML_JOB_ACTION", "install".into()),
                    (
                        "ML_TIMEOUT",
                        (config.targets.len() as u64
                            * (config.policy.backup_timeout_secs * 3
                                + config.policy.restore_timeout_secs * 4
                                + config.policy.repository_timeout_secs * 10
                                + 120))
                            .to_string(),
                    ),
                ] {
                    command.env.insert(key.into(), value.into());
                }
                registry.jobs.push(Job {
                    name: name.clone(),
                    target: target.into(),
                    definition_sha256: String::new(),
                    path: None,
                    unit_hashes: None,
                });
                security::atomic_json(&registry_path(config), &registry)?;
                let registered = process::succeeded(
                    process::capture(&command, &[], 30, cancel, "schedule_install").await?,
                    "schedule_install",
                )?;
                let registered: Value = serde_json::from_slice(&registered)
                    .map_err(|_| failure("schedule", "registration_not_acknowledged", 6))?;
                let definition = registered["definitionSha256"]
                    .as_str()
                    .filter(|hash| hash.len() == 64)
                    .ok_or_else(|| failure("schedule", "registration_not_acknowledged", 6))?;
                registry.jobs.last_mut().unwrap().definition_sha256 = definition.into();
                security::atomic_json(&registry_path(config), &registry)?;
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows")))]
            {
                let _ = (&service, &timer, &name, &mut registry);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        process::succeeded(
            process::capture(
                &Invocation::new("systemctl").args(["--user", "daemon-reload"]),
                &[],
                15,
                cancel,
                "schedule_activate",
            )
            .await?,
            "schedule_activate",
        )?;
        let mut command = Invocation::new("systemctl").args(["--user", "enable", "--now"]);
        command.args.extend(
            registry
                .jobs
                .iter()
                .map(|job| format!("{}.timer", job.name).into()),
        );
        process::succeeded(
            process::capture(&command, &[], 15, cancel, "schedule_activate").await?,
            "schedule_activate",
        )?;
    }
    #[cfg(target_os = "windows")]
    for index in 0..registry.jobs.len() {
        let job = &registry.jobs[index];
        let mut command = Invocation::new("powershell.exe").args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("scheduled-task.ps1"),
        ]);
        for (key, value) in [
            ("ML_JOB_ACTION", "activate"),
            ("ML_JOB_NAME", job.name.as_str()),
            ("ML_OWNER", registry.owner.as_str()),
            ("ML_DEFINITION_SHA256", job.definition_sha256.as_str()),
        ] {
            command.env.insert(key.into(), value.into());
        }
        let bytes = process::succeeded(
            process::capture(&command, &[], 15, cancel, "schedule_activate").await?,
            "schedule_activate",
        )?;
        let activated: Value = serde_json::from_slice(&bytes)
            .map_err(|_| failure("schedule", "activation_not_acknowledged", 6))?;
        registry.jobs[index].definition_sha256 = activated["definitionSha256"]
            .as_str()
            .filter(|value| value.len() == 64)
            .ok_or_else(|| failure("schedule", "activation_not_acknowledged", 6))?
            .into();
        security::atomic_json(&registry_path(config), &registry)?;
    }
    inspect(config, cancel).await
}

pub(super) async fn remove(
    config: &BackupConfig,
    cancel: &CancellationToken,
) -> AdminResult<Value> {
    if !cfg!(any(target_os = "linux", target_os = "windows")) {
        let _ = cancel;
        return Err(failure(
            "schedule",
            "scheduling_requires_windows_or_systemd",
            2,
        ));
    }
    let _lock = security::Lock::repository(config)?;
    let Some(mut registry) = registry(config)? else {
        return Ok(json!({"removedJobs":0}));
    };
    let count = registry.jobs.len();
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    while let Some(job) = registry.jobs.first().cloned() {
        if !job
            .name
            .starts_with(&format!("mindleak-{}-", registry.owner))
        {
            return Err(failure("schedule", "job_ownership_mismatch", 6));
        }
        #[cfg(target_os = "linux")]
        {
            let files = owned_unit_files(&job)?;
            if !files.is_empty() {
                process::succeeded(
                    process::capture(
                        &Invocation::new("systemctl").args([
                            "--user",
                            "disable",
                            "--now",
                            &format!("{}.timer", job.name),
                        ]),
                        &[],
                        15,
                        cancel,
                        "schedule_remove",
                    )
                    .await?,
                    "schedule_remove",
                )?;
            }
            for file in files {
                std::fs::remove_file(file)
                    .map_err(|_| failure("schedule", "job_removal_failed", 3))?;
            }
        }
        #[cfg(target_os = "windows")]
        {
            let script = include_str!("scheduled-task.ps1");
            let mut command = Invocation::new("powershell.exe").args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ]);
            command
                .env
                .insert("ML_JOB_NAME".into(), job.name.clone().into());
            command
                .env
                .insert("ML_OWNER".into(), registry.owner.clone().into());
            command.env.insert("ML_JOB_ACTION".into(), "remove".into());
            command.env.insert(
                "ML_DEFINITION_SHA256".into(),
                job.definition_sha256.clone().into(),
            );
            process::succeeded(
                process::capture(&command, &[], 15, cancel, "schedule_remove").await?,
                "schedule_remove",
            )?;
        }
        registry.jobs.remove(0);
        security::atomic_json(&registry_path(config), &registry)?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let _ = &mut registry;
    #[cfg(target_os = "linux")]
    process::succeeded(
        process::capture(
            &Invocation::new("systemctl").args(["--user", "daemon-reload"]),
            &[],
            15,
            cancel,
            "schedule_remove",
        )
        .await?,
        "schedule_remove",
    )?;
    std::fs::remove_file(registry_path(config))
        .map_err(|_| failure("schedule", "registry_removal_failed", 3))?;
    Ok(json!({"removedJobs":count,"backupsAndKeysRetained":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduler_runs_targets_sequentially_and_quotes_expansion_characters() {
        let config: BackupConfig = serde_json::from_value(json!({"schemaVersion":1,"repository":{"kind":"local","path":"/backup/repository","passwordFile":"/backup/key"},"workDir":"/backup/work","targets":[{"id":"first","container":"first"},{"id":"second","container":"second"}]})).unwrap();
        let (service, timer) = definitions(
            &config,
            Path::new("/backup/$literal%/config.json"),
            Path::new("/opt/mindleak/bin"),
            "all",
            true,
        );
        assert!(service.contains("\"backup\" \"run\" \"--all\" \"--verify\""));
        assert!(service.contains("$$literal%%"));
        assert!(service.contains("--non-interactive"));
        assert!(timer.contains("Sun *-*-* 03:00:00 UTC"));
    }

    #[test]
    fn windows_scheduler_script_requires_ownership_and_unattended_identity() {
        let script = include_str!("scheduled-task.ps1");
        assert!(script.contains("-LogonType S4U"));
        assert!(script.contains("$state.definitionSha256 -ne $env:ML_DEFINITION_SHA256"));
        assert!(script.contains("$task.Description -ne $env:ML_OWNER"));
        assert!(!script.contains("-Password"));
    }

    #[test]
    fn owned_unit_cleanup_handles_interrupted_install_without_deleting_edits() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let path = root.join("owned.service");
        std::fs::write(&path, "service").unwrap();
        let job = Job {
            name: "owned".into(),
            target: "all".into(),
            definition_sha256: security::hash(b"servicetimer"),
            path: Some(path.clone()),
            unit_hashes: Some([security::hash(b"service"), security::hash(b"timer")]),
        };
        assert_eq!(owned_unit_files(&job).unwrap(), vec![path.clone()]);
        std::fs::write(&path, "edited by operator").unwrap();
        assert!(owned_unit_files(&job).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"edited by operator");
    }
}
