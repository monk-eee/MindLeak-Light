use std::{
    collections::HashSet,
    io::Read,
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    database::{Engine, Fingerprint},
    failure, security,
    settings::{BackupConfig, Target},
    AdminResult,
};

pub(super) const PROFILE: &str = "mindleak-0.4-pg16-v1";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub format_version: u32,
    pub target_id: String,
    pub repository_id: String,
    pub operation_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub engine: Engine,
    pub image_id: Option<String>,
    pub database_identity: String,
    pub database: Fingerprint,
    pub dump_sha256: String,
    pub files: Vec<Asset>,
    pub external_sources: Vec<String>,
    pub verification_profile: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Asset {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub origin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceManifest {
    schema_version: u32,
    files: Vec<Asset>,
}

pub(super) fn capture_assets(
    target: &Target,
    root: &Path,
    config: &BackupConfig,
    cancel: &CancellationToken,
) -> AdminResult<Vec<Asset>> {
    config.validate_capture_secrets(target)?;
    let mut included = Vec::new();
    for (index, source) in target.sources.iter().enumerate() {
        let bytes = security::read_bounded(&source.manifest, 1024 * 1024)
            .map_err(|_| failure("assets", "source_manifest_unavailable_or_large", 3))?;
        let manifest: SourceManifest = serde_json::from_slice(&bytes)
            .map_err(|_| failure("assets", "source_manifest_invalid", 3))?;
        if manifest.schema_version != 1 || manifest.files.len() > 10000 {
            return Err(failure("assets", "source_manifest_version_or_size", 3));
        }
        let source_root = std::fs::canonicalize(&source.root)
            .map_err(|_| failure("assets", "source_root_unavailable", 3))?;
        let manifest_path = format!("assets/{index}/source-manifest.json");
        let destination = root.join(&manifest_path);
        create_parents(root, destination.parent().unwrap())?;
        let mut archived_manifest = security::create_file(&destination)?;
        std::io::Write::write_all(&mut archived_manifest, &bytes)
            .map_err(|_| failure("assets", "source_manifest_copy_failed", 3))?;
        archived_manifest
            .sync_all()
            .map_err(|_| failure("assets", "source_manifest_sync_failed", 3))?;
        included.push(Asset {
            path: manifest_path,
            bytes: bytes.len() as u64,
            sha256: security::hash(&bytes),
            origin: Some("source-manifest".into()),
        });
        for mut asset in manifest.files {
            if included.len() >= 10000 {
                return Err(failure("assets", "total_asset_limit_exceeded", 3));
            }
            if cancel.is_cancelled() {
                return Err(failure("assets", "cancelled", 130));
            }
            relative(&asset.path)?;
            let path = source_root.join(&asset.path);
            super::settings::safe_path(&path)?;
            let actual = std::fs::metadata(&path)
                .map_err(|_| failure("assets", "required_asset_missing", 3))?;
            if !actual.is_file()
                || actual.len() != asset.bytes
                || security::hash_file(&path)? != asset.sha256
            {
                return Err(failure("assets", "asset_manifest_mismatch", 3));
            }
            if fs2::available_space(root)
                .map_err(|_| failure("assets", "disk_capacity_unavailable", 3))?
                < asset
                    .bytes
                    .saturating_add(config.policy.staging_reserve_bytes)
            {
                return Err(failure("assets", "insufficient_staging_space", 3));
            }
            asset.path = format!("assets/{index}/files/{}", asset.path);
            let destination = root.join(&asset.path);
            create_parents(root, destination.parent().unwrap())?;
            let mut input = security::open_file(&path)?.take(asset.bytes.saturating_add(1));
            let mut output = security::create_file(&destination)?;
            let copied = std::io::copy(&mut input, &mut output)
                .map_err(|_| failure("assets", "asset_copy_failed", 3))?;
            if copied != asset.bytes {
                return Err(failure("assets", "asset_changed_during_capture", 3));
            }
            output
                .sync_all()
                .map_err(|_| failure("assets", "asset_sync_failed", 3))?;
            if security::hash_file(&destination)? != asset.sha256
                || security::hash_file(&path)? != asset.sha256
            {
                return Err(failure("assets", "asset_changed_during_capture", 3));
            }
            included.push(asset);
        }
    }
    Ok(included)
}

fn create_parents(root: &Path, parent: &Path) -> AdminResult<()> {
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| failure("assets", "unsafe_asset_path", 3))?;
    let mut path = root.to_owned();
    for part in relative.components() {
        path.push(part);
        if !path.exists() {
            security::directory(&path)?;
        }
    }
    Ok(())
}

pub(super) fn pack(root: &Path, manifest: &Manifest) -> AdminResult<()> {
    security::atomic_json(&root.join("manifest.json"), manifest)?;
    let bytes = manifest
        .files
        .iter()
        .fold(0_u64, |total, asset| total.saturating_add(asset.bytes))
        .saturating_add(
            std::fs::metadata(root.join("database.dump"))
                .map_err(|_| failure("bundle", "dump_missing", 3))?
                .len(),
        )
        .saturating_add(8 * 1024 * 1024);
    if fs2::available_space(root).map_err(|_| failure("bundle", "disk_capacity_unavailable", 3))?
        < bytes
    {
        return Err(failure("bundle", "insufficient_bundle_space", 3));
    }
    let file = security::create_file(&root.join("bundle.tar"))?;
    let mut archive = tar::Builder::new(file);
    for path in std::iter::once("manifest.json")
        .chain(std::iter::once("database.dump"))
        .chain(manifest.files.iter().map(|asset| asset.path.as_str()))
    {
        archive
            .append_path_with_name(root.join(path), path)
            .map_err(|_| failure("bundle", "bundle_pack_failed", 3))?;
    }
    archive
        .finish()
        .map_err(|_| failure("bundle", "bundle_finish_failed", 3))?;
    archive
        .into_inner()
        .map_err(|_| failure("bundle", "bundle_finish_failed", 3))?
        .sync_all()
        .map_err(|_| failure("bundle", "bundle_sync_failed", 3))?;
    Ok(())
}

pub(super) fn unpack(root: &Path, max_bytes: u64) -> AdminResult<Manifest> {
    let file = security::open_file(&root.join("bundle.tar"))
        .map_err(|_| failure("bundle", "archive_missing", 5))?;
    let mut archive = tar::Archive::new(file);
    let mut paths = HashSet::new();
    let mut total = 0_u64;
    for entry in archive
        .entries()
        .map_err(|_| failure("bundle", "invalid_archive", 5))?
    {
        let mut entry = entry.map_err(|_| failure("bundle", "invalid_archive_entry", 5))?;
        let path = entry
            .path()
            .map_err(|_| failure("bundle", "invalid_archive_path", 5))?
            .to_str()
            .ok_or_else(|| failure("bundle", "invalid_archive_path", 5))?
            .to_owned();
        relative(&path)?;
        if !entry.header().entry_type().is_file()
            || !paths.insert(path.clone())
            || paths.len() > 10002
            || !["manifest.json", "database.dump"].contains(&path.as_str())
                && !path.starts_with("assets/")
        {
            return Err(failure("bundle", "unexpected_archive_entry", 5));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| failure("bundle", "archive_size_overflow", 5))?;
        if total > max_bytes || path == "manifest.json" && entry.size() > 4 * 1024 * 1024 {
            return Err(failure("bundle", "archive_exceeds_capacity", 5));
        }
        let destination = root.join(&path);
        create_parents(root, destination.parent().unwrap())?;
        let mut output = security::create_file(&destination)?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|_| failure("bundle", "archive_extract_failed", 5))?;
        output
            .sync_all()
            .map_err(|_| failure("bundle", "archive_sync_failed", 5))?;
    }
    let bytes = security::read_bounded(&root.join("manifest.json"), 4 * 1024 * 1024)
        .map_err(|_| failure("bundle", "manifest_missing_or_large", 5))?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| failure("bundle", "invalid_manifest", 5))?;
    if manifest.format_version != 1
        || manifest.verification_profile != PROFILE
        || !manifest.database.postgres_version.starts_with("16.")
    {
        return Err(failure("bundle", "unsupported_bundle_compatibility", 5));
    }
    let mut expected: HashSet<String> = ["manifest.json".into(), "database.dump".into()]
        .into_iter()
        .collect();
    for asset in &manifest.files {
        if !expected.insert(asset.path.clone()) {
            return Err(failure("bundle", "duplicate_manifest_asset", 5));
        }
        if !asset.path.starts_with("assets/") {
            return Err(failure("bundle", "invalid_manifest_asset", 5));
        }
    }
    if paths != expected
        || security::hash_file(&root.join("database.dump"))? != manifest.dump_sha256
    {
        return Err(failure("bundle", "dump_or_inventory_mismatch", 5));
    }
    for asset in &manifest.files {
        relative(&asset.path)?;
        if !paths.contains(&asset.path)
            || security::hash_file(&root.join(&asset.path))? != asset.sha256
            || std::fs::metadata(root.join(&asset.path))
                .map_err(|_| failure("bundle", "asset_missing", 5))?
                .len()
                != asset.bytes
        {
            return Err(failure("bundle", "restored_asset_mismatch", 5));
        }
    }
    Ok(manifest)
}

fn relative(path: &str) -> AdminResult<PathBuf> {
    if path.split('/').any(|part| ["", ".", ".."].contains(&part))
        || path.bytes().any(|byte| byte < 32)
    {
        return Err(failure("assets", "unsafe_asset_path", 5));
    }
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.to_string_lossy().contains(['\\', ':', '\0'])
    {
        return Err(failure("assets", "unsafe_asset_path", 5));
    }
    Ok(path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> Manifest {
        std::fs::create_dir(root.join("assets")).unwrap();
        for (path, contents) in [
            ("database.dump", "dump-fixture"),
            ("assets/first", "first"),
            ("assets/second", "second"),
        ] {
            std::fs::write(root.join(path), contents).unwrap();
        }
        Manifest {
            format_version: 1,
            target_id: "fixture".into(),
            repository_id: "1".repeat(64),
            operation_id: Uuid::new_v4(),
            created_at: Utc::now(),
            engine: Engine {
                version: "0.4.0".into(),
                sha256: "2".repeat(64),
                inside_container: false,
            },
            image_id: None,
            database_identity: "3".repeat(64),
            database: Fingerprint {
                records_sha256: "4".repeat(64),
                schema_sha256: "5".repeat(64),
                schema_components: Default::default(),
                database_settings: serde_json::json!({}),
                rows: Default::default(),
                postgres_version: "16.15".into(),
                extensions: serde_json::json!([]),
                embedding_binding: None,
                database_bytes: 0,
                canary: None,
            },
            dump_sha256: security::hash(b"dump-fixture"),
            files: ["first", "second"]
                .into_iter()
                .map(|name| Asset {
                    path: format!("assets/{name}"),
                    bytes: name.len() as u64,
                    sha256: security::hash(name.as_bytes()),
                    origin: None,
                })
                .collect(),
            external_sources: Vec::new(),
            verification_profile: PROFILE.into(),
        }
    }

    #[test]
    fn duplicate_manifest_entries_cannot_hide_an_unverified_asset() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let mut manifest = fixture(source.path());
        manifest.files[1] = manifest.files[0].clone();
        security::atomic_json(&source.path().join("manifest.json"), &manifest).unwrap();
        let mut archive =
            tar::Builder::new(std::fs::File::create(target.path().join("bundle.tar")).unwrap());
        for path in [
            "manifest.json",
            "database.dump",
            "assets/first",
            "assets/second",
        ] {
            archive
                .append_path_with_name(source.path().join(path), path)
                .unwrap();
        }
        archive.finish().unwrap();
        drop(archive);
        assert_eq!(
            unpack(target.path(), 1024 * 1024).err().unwrap().code,
            "duplicate_manifest_asset"
        );
    }

    #[test]
    fn bundle_roundtrip_checks_dump_and_every_asset() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let manifest = fixture(source.path());
        pack(source.path(), &manifest).unwrap();
        std::fs::copy(
            source.path().join("bundle.tar"),
            target.path().join("bundle.tar"),
        )
        .unwrap();
        let restored = unpack(target.path(), 1024 * 1024).unwrap();
        assert_eq!(restored.files.len(), 2);
        assert_eq!(restored.operation_id, manifest.operation_id);
    }

    #[test]
    fn asset_paths_reject_cross_platform_traversal() {
        for path in [
            "../outside",
            "/absolute",
            "C:\\outside",
            "assets/../outside",
            "assets/./alias",
            "assets//alias",
            "assets\\outside",
        ] {
            assert!(relative(path).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn source_capture_refuses_referenced_database_credentials() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let sources = root.join("sources");
        std::fs::create_dir(&sources).unwrap();
        let password = sources.join("database-password");
        std::fs::write(&password, "secret-fixture").unwrap();
        let connection = root.join("connection.json");
        std::fs::write(&connection, serde_json::to_vec(&serde_json::json!({"host":"localhost","port":5432,"database":"fixture","user":"fixture","passwordFile":password,"localPlaintext":true})).unwrap()).unwrap();
        let manifest = root.join("source.json");
        std::fs::write(&manifest, serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"files":[{"path":"database-password","bytes":14,"sha256":security::hash(b"secret-fixture")}]})).unwrap()).unwrap();
        let config: BackupConfig = serde_json::from_value(serde_json::json!({"schemaVersion":1,"repository":{"kind":"local","path":root.join("repository"),"passwordFile":root.join("key")},"workDir":root.join("work"),
            "targets":[{"id":"fixture","connectionFile":connection,"sources":[{"root":sources,"manifest":manifest}]}]})).unwrap();
        let staging = root.join("staging");
        security::directory(&staging).unwrap();
        let error = capture_assets(
            &config.targets[0],
            &staging,
            &config,
            &CancellationToken::new(),
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "credential_source_overlap");
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
    }
}
