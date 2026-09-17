use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use serde::Deserialize;

use super::{failure, AdminResult};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BackupConfig {
    pub schema_version: u32,
    pub repository: Repository,
    pub targets: Vec<Target>,
    pub restore_target: Option<Target>,
    pub work_dir: PathBuf,
    pub engine_path: Option<PathBuf>,
    #[serde(default)]
    pub tools: Tools,
    #[serde(default)]
    pub retention: Retention,
    #[serde(default)]
    pub policy: Policy,
    #[serde(default)]
    pub schedule: ScheduleConfig,
    pub alerts: Option<Alerts>,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Repository {
    #[serde(rename_all = "camelCase")]
    Local {
        path: PathBuf,
        password_file: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    Azure {
        container: String,
        prefix: String,
        account_env: Option<String>,
        sas_env: Option<String>,
        account_file: Option<PathBuf>,
        sas_file: Option<PathBuf>,
        password_file: PathBuf,
    },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Target {
    pub id: String,
    pub container: Option<String>,
    pub connection_file: Option<PathBuf>,
    pub database: Option<String>,
    pub user: Option<String>,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub external_sources: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Source {
    pub root: PathBuf,
    pub manifest: PathBuf,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Connection {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password_file: PathBuf,
    pub ca_file: Option<PathBuf>,
    #[serde(default)]
    pub local_plaintext: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Alerts {
    pub webhook_env: Option<String>,
    pub webhook_file: Option<PathBuf>,
    #[serde(default)]
    pub os_event: bool,
    #[serde(default)]
    pub required: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(super) struct ScheduleConfig {
    pub enabled: bool,
    pub timezone: String,
    pub daily: String,
    pub weekly: String,
    pub targets: Vec<String>,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            timezone: "UTC".into(),
            daily: "02:00".into(),
            weekly: "03:00".into(),
            targets: Vec::new(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(super) struct Tools {
    pub restic: PathBuf,
    pub container: PathBuf,
    pub psql: PathBuf,
    pub pg_dump: PathBuf,
    pub pg_restore: PathBuf,
}

impl Default for Tools {
    fn default() -> Self {
        Self {
            restic: "restic".into(),
            container: "docker".into(),
            psql: "psql".into(),
            pg_dump: "pg_dump".into(),
            pg_restore: "pg_restore".into(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(super) struct Policy {
    pub off_machine_required: bool,
    pub backup_max_age_hours: u32,
    pub restore_max_age_days: u32,
    pub backup_timeout_secs: u64,
    pub restore_timeout_secs: u64,
    pub repository_timeout_secs: u64,
    pub staging_reserve_bytes: u64,
    pub sources_required: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            off_machine_required: false,
            backup_max_age_hours: 48,
            restore_max_age_days: 8,
            backup_timeout_secs: 3600,
            restore_timeout_secs: 7200,
            repository_timeout_secs: 3600,
            staging_reserve_bytes: 1024 * 1024 * 1024,
            sources_required: false,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(super) struct Retention {
    pub last: u32,
    pub daily: u32,
    pub weekly: u32,
    pub monthly: u32,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            last: 3,
            daily: 7,
            weekly: 4,
            monthly: 6,
        }
    }
}

impl BackupConfig {
    pub fn read(path: &Path) -> AdminResult<Self> {
        let bytes = super::security::read_bounded(path, 1024 * 1024)
            .map_err(|_| failure("configuration", "config_unavailable_or_large", 2))?;
        serde_json::from_slice(&bytes).map_err(|_| failure("configuration", "invalid_config", 2))
    }

    pub fn validate(&self) -> AdminResult<()> {
        let invalid = || failure("configuration", "invalid_config", 2);
        if self.schema_version != 1
            || self.targets.is_empty()
            || self.targets.len() > 32
            || !self.work_dir.is_absolute()
            || [
                self.retention.last,
                self.retention.daily,
                self.retention.weekly,
                self.retention.monthly,
            ]
            .iter()
            .any(|value| !(1..=3650).contains(value))
            || self.policy.backup_max_age_hours == 0
            || self.policy.restore_max_age_days == 0
        {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        let mut destinations = HashSet::new();
        if let Some(target) = &self.restore_target {
            if !identifier(&target.id)
                || target.container.is_some() == target.connection_file.is_some()
                || target
                    .container
                    .as_ref()
                    .is_some_and(|value| !container_selector(value))
                || target.user.as_ref().is_some_and(|value| !identifier(value))
                || target.database.is_some()
                || target.connection_file.is_some() && target.user.is_some()
                || !target.sources.is_empty()
                || !target.external_sources.is_empty()
            {
                return Err(invalid());
            }
            if let Some(path) = &target.connection_file {
                safe_path(path)?;
            }
        }
        for target in &self.targets {
            if !identifier(&target.id)
                || !ids.insert(&target.id)
                || target.container.is_some() == target.connection_file.is_some()
            {
                return Err(invalid());
            }
            if target
                .container
                .as_ref()
                .is_some_and(|value| !container_selector(value))
                || target
                    .database
                    .as_ref()
                    .is_some_and(|value| !identifier(value))
                || target.user.as_ref().is_some_and(|value| !identifier(value))
                || self.policy.sources_required && target.sources.is_empty()
            {
                return Err(invalid());
            }
            let destination = if let Some(container) = &target.container {
                format!(
                    "container:{container}:{}",
                    target.database.as_deref().unwrap_or("default")
                )
            } else {
                if target.database.is_some() || target.user.is_some() {
                    return Err(invalid());
                }
                let path = target.connection_file.as_ref().unwrap();
                safe_path(path)?;
                format!("external:{}", path.display())
            };
            if !destinations.insert(destination) {
                return Err(failure("configuration", "duplicate_database_target", 2));
            }
            for source in &target.sources {
                safe_path(&source.root)?;
                safe_path(&source.manifest)?;
            }
            if target
                .external_sources
                .iter()
                .any(|value| value.len() > 2048 || value.contains(['\n', '\r']))
            {
                return Err(invalid());
            }
        }
        safe_path(&self.work_dir)?;
        if !self.work_dir.is_dir() {
            return Err(failure(
                "configuration",
                "create_private_work_directory_first",
                2,
            ));
        }
        let work = canonical(&self.work_dir)?;
        if work.ancestors().any(|parent| parent.join(".git").exists()) {
            return Err(failure("configuration", "staging_inside_checkout", 2));
        }
        let password = self.repository.password_file();
        safe_path(password)?;
        if overlap(&work, password) {
            return Err(failure("configuration", "secret_inside_staging", 2));
        }
        if let Repository::Local { path, .. } = &self.repository {
            safe_path(path)?;
            if overlap(&work, path) || overlap(path, password) {
                return Err(failure("configuration", "repository_path_overlap", 2));
            }
        }
        if let Repository::Azure {
            container,
            prefix,
            account_env,
            sas_env,
            account_file,
            sas_file,
            ..
        } = &self.repository
        {
            if !identifier(container)
                || prefix.is_empty()
                || prefix.split('/').any(|part| !identifier(part))
                || !reference(account_env.as_deref(), account_file.as_deref())
                || !reference(sas_env.as_deref(), sas_file.as_deref())
            {
                return Err(invalid());
            }
        }
        for target in &self.targets {
            for source in &target.sources {
                if overlap(&source.root, &work)
                    || overlap(&source.root, password)
                    || matches!(&self.repository, Repository::Local { path, .. } if overlap(&source.root, path))
                {
                    return Err(failure("configuration", "source_path_overlap", 2));
                }
            }
        }
        if [
            self.policy.backup_timeout_secs,
            self.policy.restore_timeout_secs,
            self.policy.repository_timeout_secs,
        ]
        .iter()
        .any(|value| !(1..=86400).contains(value))
            || !(1..=8760).contains(&self.policy.backup_max_age_hours)
            || !(1..=365).contains(&self.policy.restore_max_age_days)
            || self.schedule.timezone.is_empty()
            || !self
                .schedule
                .timezone
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"/_+- ".contains(&byte))
            || !time_of_day(&self.schedule.daily)
            || !time_of_day(&self.schedule.weekly)
            || self
                .schedule
                .targets
                .iter()
                .any(|target| !ids.contains(target))
        {
            return Err(invalid());
        }
        if let Some(alerts) = &self.alerts {
            if (alerts.webhook_env.is_some() || alerts.webhook_file.is_some())
                && !reference(
                    alerts.webhook_env.as_deref(),
                    alerts.webhook_file.as_deref(),
                )
                || alerts.required
                    && !alerts.os_event
                    && alerts.webhook_env.is_none()
                    && alerts.webhook_file.is_none()
            {
                return Err(invalid());
            }
        }
        let mut references = vec![password];
        if let Repository::Azure {
            account_file,
            sas_file,
            ..
        } = &self.repository
        {
            references.extend(account_file.as_deref());
            references.extend(sas_file.as_deref());
        }
        if let Some(alerts) = &self.alerts {
            references.extend(alerts.webhook_file.as_deref());
        }
        for target in self.targets.iter().chain(self.restore_target.iter()) {
            references.extend(target.connection_file.as_deref());
        }
        for reference in references {
            safe_path(reference)?;
            if overlap(reference, &work)
                || self
                    .targets
                    .iter()
                    .flat_map(|target| &target.sources)
                    .any(|source| overlap(reference, &source.root))
                || matches!(&self.repository, Repository::Local { path, .. } if overlap(reference, path))
            {
                return Err(failure("configuration", "secret_reference_path_overlap", 2));
            }
        }
        Ok(())
    }

    pub fn validate_capture_secrets(&self, target: &Target) -> AdminResult<()> {
        if target.sources.is_empty() {
            return Ok(());
        }
        let mut secrets = vec![self.repository.password_file().to_owned()];
        if let Repository::Azure {
            account_file,
            sas_file,
            ..
        } = &self.repository
        {
            secrets.extend(account_file.iter().cloned());
            secrets.extend(sas_file.iter().cloned());
        }
        if let Some(alerts) = &self.alerts {
            secrets.extend(alerts.webhook_file.iter().cloned());
        }
        for configured in self.targets.iter().chain(self.restore_target.iter()) {
            if let Some(path) = &configured.connection_file {
                secrets.push(path.clone());
                secrets.push(configured.connection()?.password_file);
            }
        }
        for secret in secrets {
            safe_path(&secret)?;
            if overlap(&secret, &self.work_dir)
                || target
                    .sources
                    .iter()
                    .any(|source| overlap(&secret, &source.root))
                || matches!(&self.repository, Repository::Local { path, .. } if overlap(&secret, path))
            {
                return Err(failure("assets", "credential_source_overlap", 2));
            }
        }
        Ok(())
    }
}

impl Target {
    pub fn connection(&self) -> AdminResult<Connection> {
        let path = self
            .connection_file
            .as_ref()
            .ok_or_else(|| failure("configuration", "external_connection_required", 2))?;
        safe_path(path)?;
        let bytes = super::security::read_bounded(path, 65536)
            .map_err(|_| failure("configuration", "connection_unavailable_or_large", 2))?;
        let connection: Connection = serde_json::from_slice(&bytes)
            .map_err(|_| failure("configuration", "invalid_connection", 2))?;
        if !identifier(&connection.database)
            || !identifier(&connection.user)
            || connection.host.is_empty()
            || connection.port == 0
            || connection.host.contains(['\n', '\r', '\0', '=', ' ', '\''])
            || connection.local_plaintext
                && !["localhost", "127.0.0.1", "::1"].contains(&connection.host.as_str())
        {
            return Err(failure("configuration", "invalid_connection", 2));
        }
        safe_path(&connection.password_file)?;
        if let Some(path) = &connection.ca_file {
            safe_path(path)?;
        }
        Ok(connection)
    }
}

impl Repository {
    pub fn password_file(&self) -> &Path {
        match self {
            Self::Local { password_file, .. } | Self::Azure { password_file, .. } => password_file,
        }
    }
    pub fn remote(&self) -> bool {
        matches!(self, Self::Azure { .. })
    }
}

fn container_selector(value: &str) -> bool {
    identifier(value) || value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

fn environment_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn reference(environment: Option<&str>, file: Option<&Path>) -> bool {
    match (environment, file) {
        (Some(name), None) => environment_name(name),
        (None, Some(path)) => safe_path(path).is_ok(),
        _ => false,
    }
}

fn time_of_day(value: &str) -> bool {
    value.split_once(':').is_some_and(|(hour, minute)| {
        hour.len() == 2
            && minute.len() == 2
            && hour.parse::<u8>().is_ok_and(|hour| hour < 24)
            && minute.parse::<u8>().is_ok_and(|minute| minute < 60)
    })
}

pub(super) fn safe_path(path: &Path) -> AdminResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || path.to_string_lossy().contains(['\n', '\r', '\0', ','])
    {
        return Err(failure("configuration", "unsafe_path", 2));
    }
    for parent in path.ancestors() {
        if std::fs::symlink_metadata(parent).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(failure("configuration", "symlink_path_refused", 2));
        }
        let name = parent
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if [
            "onedrive",
            "dropbox",
            "cloudstorage",
            "mobile documents",
            "google drive",
        ]
        .iter()
        .any(|cloud| name.contains(cloud))
        {
            return Err(failure("configuration", "file_sync_path_refused", 2));
        }
    }
    Ok(())
}

fn canonical(path: &Path) -> AdminResult<PathBuf> {
    std::fs::canonicalize(path).map_err(|_| failure("configuration", "path_unavailable", 2))
}
fn overlap(left: &Path, right: &Path) -> bool {
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        let left = PathBuf::from(left.to_string_lossy().to_lowercase());
        let right = PathBuf::from(right.to_string_lossy().to_lowercase());
        return left.starts_with(&right) || right.starts_with(&left);
    }
    left.starts_with(right) || right.starts_with(left)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn immutable_container_ids_are_valid_source_and_restore_selectors() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let mut value = serde_json::json!({"schemaVersion":1,"workDir":root,"repository":{"kind":"local","path":root.parent().unwrap().join("repository-fixture"),"passwordFile":root.parent().unwrap().join("key-fixture")},
            "targets":[{"id":"fixture","container":"a".repeat(64)}],"restoreTarget":{"id":"recovery","container":"b".repeat(64)}});
        serde_json::from_value::<BackupConfig>(value.clone())
            .unwrap()
            .validate()
            .unwrap();
        value["targets"][0]["container"] = serde_json::json!("z".repeat(64));
        assert!(serde_json::from_value::<BackupConfig>(value)
            .unwrap()
            .validate()
            .is_err());
    }

    #[test]
    fn persistent_remote_credentials_are_references_not_inline_values() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let value = serde_json::json!({"schemaVersion":1,"workDir":root,"repository":{"kind":"azure","container":"approved-container","prefix":"memory","passwordFile":root.parent().unwrap().join("backup-key"),
            "accountFile":root.parent().unwrap().join("account-ref"),"sasFile":root.parent().unwrap().join("sas-ref")},"targets":[{"id":"fixture","container":"fixture"}],"alerts":{"webhookFile":root.parent().unwrap().join("webhook-ref"),"required":true}});
        let config: BackupConfig =
            serde_json::from_value(value.clone()).expect("persistent file references must parse");
        config.validate().unwrap();
        let mut conflicting = value;
        conflicting["repository"]["accountEnv"] = serde_json::json!("ACCOUNT_ENV");
        assert!(serde_json::from_value::<BackupConfig>(conflicting)
            .unwrap()
            .validate()
            .is_err());
    }
}
