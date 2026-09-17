use std::{path::Path, time::Duration};

use serde_json::{json, Value};
use tokio::process::Command;
use uuid::Uuid;

fn private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            path,
            std::fs::Permissions::from_mode(if path.is_dir() { 0o700 } else { 0o600 }),
        )
        .unwrap();
    }
    #[cfg(windows)]
    {
        let script = "$ErrorActionPreference='Stop'; $path=$env:ML_PRIVATE_FIXTURE; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; if((Get-Item -LiteralPath $path).PSIsContainer){$acl=[System.Security.AccessControl.DirectorySecurity]::new();$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{$acl=[System.Security.AccessControl.FileSecurity]::new();$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','Allow')}; $acl.SetOwner($me);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule($rule);Set-Acl -LiteralPath $path -AclObject $acl";
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("ML_PRIVATE_FIXTURE", dunce::simplified(path))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fixture ACL setup failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

async fn invoke(arguments: &[&str], directory: &Path) -> (i32, Value) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command
        .args(arguments)
        .current_dir(directory)
        .env_remove("MINDLEAK_DATABASE_URL")
        .env("MINDLEAK_TRANSPORT", "invalid-server-setting")
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .unwrap()
        .unwrap();
    let output = String::from_utf8(result.stdout).unwrap();
    assert!(!output.contains("fixture-secret-do-not-log"));
    assert!(!String::from_utf8_lossy(&result.stderr).contains("fixture-secret-do-not-log"));
    let value: Value =
        serde_json::from_str(&output).expect("administrative stdout must contain one JSON object");
    (result.status.code().unwrap(), value)
}

#[tokio::test]
async fn administrative_help_does_not_load_dotenv_or_server_dependencies() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join(".env"),
        "this is invalid dotenv syntax {{{",
    )
    .unwrap();
    for arguments in [
        vec!["--help"],
        vec!["backup", "--help"],
        vec!["backup", "schedule", "install", "--help"],
        vec!["serve", "--help"],
        vec!["--version"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_mindleak-light"))
            .args(arguments)
            .current_dir(directory.path())
            .env_remove("MINDLEAK_DATABASE_URL")
            .env("MINDLEAK_LISTEN", "invalid")
            .output()
            .await
            .unwrap();
        assert!(result.status.success());
    }
    let (code, result) = invoke(&["backup", "doctor", "--json"], directory.path()).await;
    assert_eq!(code, 2);
    assert_eq!(result["error"]["code"], "explicit_config_required");
}

fn offline_configuration(root: &Path) -> (std::path::PathBuf, std::path::PathBuf, Value) {
    let work = root.join("work");
    std::fs::create_dir(&work).unwrap();
    for path in [root, &work] {
        private(path);
    }
    let path = root.join("backup.json");
    let config = json!({"schemaVersion":1,"repository":{"kind":"local","path":root.join("repository"),"passwordFile":root.join("absent-key")},
        "workDir":work,"tools":{"restic":"unavailable-restic"},"targets":[{"id":"fixture","connectionFile":root.join("absent-connection")} ]});
    (path, work, config)
}

#[tokio::test]
async fn administrative_status_does_not_resolve_database_or_repository_secrets() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let (path, work, config) = offline_configuration(&root);
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let arguments = [
        "backup",
        "status",
        "--config",
        path.to_str().unwrap(),
        "--json",
    ];
    let (code, result) = invoke(&arguments, &root).await;
    assert_eq!(code, 0, "offline status: {result}");
    assert_eq!(result["result"]["healthy"], false);
    let mut check = arguments.to_vec();
    check.push("--check");
    assert_eq!(invoke(&check, &root).await.0, 3);
    assert_eq!(std::fs::read_dir(work).unwrap().count(), 0);
}

#[tokio::test]
async fn administrative_dry_run_validates_without_writing_status() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let (path, work, mut config) = offline_configuration(&root);
    config["targets"] = json!([{"id":"fixture","container":"unavailable-container"}]);
    std::fs::write(root.join("absent-key"), "fixture-secret-do-not-log").unwrap();
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let (code, result) = invoke(
        &[
            "backup",
            "restore",
            "--target",
            "fixture",
            "--snapshot",
            "latest",
            "--new-db",
            "unsafe/name",
            "--dry-run",
            "--config",
            path.to_str().unwrap(),
            "--json",
        ],
        &root,
    )
    .await;
    assert_eq!(code, 2, "dry-run validates destination: {result}");
    assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&work, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            invoke(
                &[
                    "backup",
                    "create",
                    "--target",
                    "fixture",
                    "--dry-run",
                    "--config",
                    path.to_str().unwrap(),
                    "--json"
                ],
                &root
            )
            .await
            .0,
            2
        );
        assert_eq!(
            std::fs::read_dir(&work).unwrap().count(),
            0,
            "failed dry-run must not write receipts"
        );
    }
}

#[tokio::test]
async fn administrative_preflight_failure_is_recorded_separately() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let (path, _, config) = offline_configuration(&root);
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let (code, failure) = invoke(
        &[
            "backup",
            "create",
            "--target",
            "fixture",
            "--config",
            path.to_str().unwrap(),
            "--json",
        ],
        &root,
    )
    .await;
    assert_eq!(code, 2);
    let (code, report) = invoke(
        &[
            "backup",
            "status",
            "--config",
            path.to_str().unwrap(),
            "--json",
        ],
        &root,
    )
    .await;
    assert_eq!(code, 0);
    let operation = &report["result"]["targets"][0]["lastOperation"];
    assert_eq!(operation["state"], "failed");
    assert_eq!(operation["errorCode"], failure["error"]["code"]);
    assert_eq!(operation["id"], failure["operationId"]);
}

#[tokio::test]
async fn administrative_argument_errors_are_json_and_reject_unused_flags() {
    let directory = tempfile::tempdir().unwrap();
    for arguments in [
        vec![
            "backup",
            "--json",
            "create",
            "--target",
            "fixture",
            "--snapshot",
            "latest",
        ],
        vec![
            "backup",
            "--json",
            "retention",
            "--target",
            "fixture",
            "--apply",
        ],
        vec![
            "backup",
            "--json",
            "retention",
            "--target",
            "fixture",
            "--apply",
            "--yes",
            "--dry-run",
        ],
        vec!["backup", "--json", "run"],
    ] {
        let (code, result) = invoke(&arguments, directory.path()).await;
        assert_eq!(code, 2);
        assert_eq!(result["error"]["code"], "invalid_arguments");
    }
}

#[tokio::test]
async fn administrative_status_reports_older_unresolved_operations_and_alert_failure() {
    use sha2::{Digest, Sha256};
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let (path, work, mut config) = offline_configuration(&root);
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let operation = |state: &str| {
        json!({"id":Uuid::new_v4(),"action":"create","state":state,"stage":"repository_commit","startedAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:00:01Z",
        "snapshotId":null,"errorCode":null,"cleanupFailed":false,"alertDelivered":null,"repositoryId":null,"bundleSha256":null,"toolExitCode":null,"processId":0,"plannedRemovals":[],"removedSnapshotIds":[]})
    };
    let digest: String = Sha256::digest(b"fixture")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let state = work.join(format!("target-{digest}.json"));
    std::fs::write(&state, serde_json::to_vec(&json!({"lastBackup":null,"lastVerifiedRestore":null,"operations":[operation("outcomeUnknown"),operation("succeeded")]})).unwrap()).unwrap();
    let (code, result) = invoke(
        &[
            "backup",
            "status",
            "--config",
            path.to_str().unwrap(),
            "--json",
        ],
        &root,
    )
    .await;
    assert_eq!(code, 0);
    assert_eq!(result["result"]["targets"][0]["unresolvedFailure"], true);
    config["alerts"] = json!({"required":true,"webhookFile":root.join("unavailable-webhook")});
    std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let (code, result) = invoke(
        &[
            "backup",
            "status",
            "--check",
            "--config",
            path.to_str().unwrap(),
            "--json",
        ],
        &root,
    )
    .await;
    assert_eq!(
        code, 4,
        "required alert failure must not look like a delivered alert: {result}"
    );
    assert_eq!(
        result["error"]["details"]["targets"][0]["alertDelivered"],
        false
    );
}

#[tokio::test]
#[ignore = "requires restic 0.19, PostgreSQL 16, and MINDLEAK_BACKUP_TEST_CONTAINER"]
async fn encrypted_backup_roundtrip_preserves_source_and_owned_cleanup() {
    use mindleak_memory::{
        EmbeddedFragment, MemoryContext, MemoryStore, MemoryTier, PreparedMemory,
        PreparedRelationship, RelationshipType, WriteRequest,
    };
    use mindleak_storage_postgres::PostgresMemoryStore;
    let url = std::env::var("MINDLEAK_TEST_DATABASE_URL").unwrap();
    let mut parsed: tokio_postgres::Config = url.parse().unwrap();
    assert!(parsed.get_dbname().unwrap().ends_with("_test"));
    let container = std::env::var("MINDLEAK_BACKUP_TEST_CONTAINER").unwrap();
    let container_tool =
        std::env::var("MINDLEAK_BACKUP_CONTAINER_TOOL").unwrap_or_else(|_| "docker".into());
    let (admin, connection) = parsed.connect(tokio_postgres::NoTls).await.unwrap();
    let admin = std::sync::Arc::new(admin);
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let database = format!("mindleak_backup_{}_test", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!(
            "CREATE DATABASE \"{database}\" TEMPLATE template0"
        ))
        .await
        .unwrap();
    parsed.dbname(&database);
    let mut source_url = reqwest::Url::parse(&url).unwrap();
    source_url.set_path(&database);
    let store = PostgresMemoryStore::connect(source_url.as_str(), Some(("test-model", 2)), 4, None)
        .await
        .unwrap();
    let identifiers = [Uuid::new_v4(), Uuid::new_v4()];
    let mut episode = PreparedMemory {
        id: Uuid::new_v4(),
        agent_id: "backup-agent".into(),
        raw_text: "Fixture source requires reviews. Vector values must survive.".into(),
        context: MemoryContext {
            scope: Some("backup-fixture".into()),
            source: Some("fixture".into()),
            ..Default::default()
        },
        fragments: vec![
            EmbeddedFragment {
                id: identifiers[0],
                text: "Fixture source requires reviews.".into(),
                embedding: Some(vec![1.0, 0.0]),
                importance: 0.5,
                tier: MemoryTier::LongTerm,
                pinned: true,
            },
            EmbeddedFragment {
                id: identifiers[1],
                text: "Vector values must survive.".into(),
                embedding: Some(vec![0.0, 1.0]),
                importance: 0.5,
                tier: MemoryTier::ShortTerm,
                pinned: false,
            },
        ],
        relationships: vec![PreparedRelationship {
            source_fragment: identifiers[0],
            target_fragment: identifiers[1],
            relationship_type: RelationshipType::Related,
        }],
        request: None,
    };
    episode.request = Some(WriteRequest {
        request_id: Uuid::new_v4(),
        agent_id: episode.agent_id.clone(),
        text: episode.raw_text.clone(),
        context: episode.context.clone(),
        facts: Vec::new(),
    });
    let receipt = store.save(&episode).await.unwrap();
    let read_only = PostgresMemoryStore::connect_read_only(source_url.as_str(), 2, None)
        .await
        .unwrap();
    let blocked = PreparedMemory {
        id: Uuid::new_v4(),
        agent_id: "read-only-control".into(),
        raw_text: "Writes must be refused.".into(),
        context: MemoryContext::default(),
        fragments: vec![EmbeddedFragment {
            id: Uuid::new_v4(),
            text: "Writes must be refused.".into(),
            embedding: None,
            importance: 0.5,
            tier: MemoryTier::ShortTerm,
            pinned: false,
        }],
        relationships: Vec::new(),
        request: None,
    };
    assert!(read_only.save(&blocked).await.is_err());
    drop(read_only);
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    private(&root);
    let work = root.join("work");
    std::fs::create_dir(&work).unwrap();
    private(&work);
    let key = root.join("key");
    std::fs::write(&key, "fixture-secret-do-not-log").unwrap();
    private(&key);
    let config_path = root.join("backup.json");
    let sources = root.join("sources");
    std::fs::create_dir(&sources).unwrap();
    let asset = b"Immutable fixture source.\n";
    std::fs::write(sources.join("guide.txt"), asset).unwrap();
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(asset)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let source_manifest = root.join("source-manifest.json");
    std::fs::write(&source_manifest, serde_json::to_vec(&json!({"schemaVersion":1,"files":[{"path":"guide.txt","bytes":asset.len(),"sha256":digest}]})).unwrap()).unwrap();
    let config = json!({"schemaVersion":1,"repository":{"kind":"local","path":root.join("repository"),"passwordFile":key},
        "workDir":work,"tools":{"container":container_tool},"targets":[{"id":"fixture","container":container,"database":database,"user":"mindleak_light","sources":[{"root":sources,"manifest":source_manifest}]}],
        "policy":{"stagingReserveBytes":1024*1024},"schedule":{"enabled":false,"timezone":"UTC"}});
    std::fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    let cleanup = format!("DROP DATABASE \"{database}\" WITH (FORCE)");
    let test_admin = admin.clone();
    let operation = async move {
        let config_path = config_path.to_str().unwrap();
        let (code, readiness) = invoke(
            &["backup", "doctor", "--config", config_path, "--json"],
            &root,
        )
        .await;
        assert_eq!(
            code, 0,
            "doctor must support the pre-init workflow: {readiness}"
        );
        assert_eq!(readiness["result"]["repositoryInitialized"], false);
        let (code, _) = invoke(
            &[
                "backup",
                "create",
                "--target",
                "fixture",
                "--dry-run",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0);
        assert!(!root.join("repository").exists());
        let (code, result) = invoke(
            &["backup", "init", "--config", config_path, "--json"],
            &root,
        )
        .await;
        assert_eq!(code, 0, "init: {result}");
        assert_eq!(
            invoke(
                &["backup", "init", "--config", config_path, "--json"],
                &root
            )
            .await
            .0,
            2
        );
        let (code, result) = invoke(
            &[
                "backup",
                "create",
                "--target",
                "fixture",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0, "backup: {result}");
        let snapshot = result["result"]["snapshotId"].as_str().unwrap();
        assert_eq!(snapshot.len(), 64);
        assert_eq!(result["result"]["offMachineProtection"], false);
        assert_eq!(
            result["result"]["schemaSha256"].as_str().map(str::len),
            Some(64)
        );
        let state_path = std::fs::read_dir(&work)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("target-")
            })
            .unwrap();
        let mut uncertain: Value =
            serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        uncertain["lastBackup"] = Value::Null;
        let last = uncertain["operations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap();
        last["state"] = json!("outcomeUnknown");
        last["stage"] = json!("repository_commit");
        last["snapshotId"] = Value::Null;
        last["errorCode"] = json!("acknowledgment_missing");
        std::fs::write(&state_path, serde_json::to_vec(&uncertain).unwrap()).unwrap();
        let (code, reconciled) = invoke(
            &[
                "backup",
                "create",
                "--target",
                "fixture",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(
            code, 0,
            "reconcile before creating another snapshot: {reconciled}"
        );
        assert_eq!(reconciled["result"]["snapshotId"], snapshot);
        assert_eq!(reconciled["result"]["reconciled"], true);
        let (code, listed) = invoke(
            &[
                "backup",
                "list",
                "--target",
                "fixture",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(listed["result"]["snapshots"].as_array().unwrap().len(), 1);
        let (code, result) = invoke(
            &[
                "backup",
                "verify",
                "--target",
                "fixture",
                "--snapshot",
                snapshot,
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0, "verify: {result}");
        assert_eq!(result["result"]["restoreVerified"], true);
        assert_eq!(result["result"]["schemaUnchanged"], true);
        assert_eq!(result["result"]["canaries"]["keywordRecall"], true);
        assert_eq!(result["result"]["canaries"]["negativeControl"], true);
        assert_eq!(result["result"]["assetsVerified"], 2);
        let verification_id =
            Uuid::parse_str(result["result"]["operationId"].as_str().unwrap()).unwrap();
        let verification_database = format!("mindleak_restore_{}_test", verification_id.simple());
        let (code, result) = invoke(
            &[
                "backup",
                "restore",
                "--target",
                "fixture",
                "--snapshot",
                snapshot,
                "--new-db",
                &database,
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_ne!(code, 0, "must refuse the working source database: {result}");
        assert_eq!(
            store
                .lookup_write(episode.request.as_ref().unwrap())
                .await
                .unwrap(),
            Some(receipt)
        );
        let left: i64 = test_admin
            .query_one(
                "SELECT count(*) FROM pg_database WHERE datname=$1",
                &[&verification_database],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(left, 0);
        assert!(!std::fs::read_dir(&work).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("operation-")));
        let before_failure: Value =
            serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        std::fs::write(
            sources.join("guide.txt"),
            "Changed source cannot silently enter a backup.",
        )
        .unwrap();
        let (code, failed) = invoke(
            &[
                "backup",
                "create",
                "--target",
                "fixture",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 3, "changed immutable asset: {failed}");
        let after_failure: Value =
            serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(after_failure["lastBackup"], before_failure["lastBackup"]);
        assert_eq!(
            after_failure["lastVerifiedRestore"],
            before_failure["lastVerifiedRestore"]
        );
        std::fs::write(sources.join("guide.txt"), asset).unwrap();
        for _ in 0..3 {
            let (code, result) = invoke(
                &[
                    "backup",
                    "create",
                    "--target",
                    "fixture",
                    "--config",
                    config_path,
                    "--json",
                ],
                &root,
            )
            .await;
            assert_eq!(code, 0, "retention fixture backup: {result}");
        }
        let mut retention_config = config.clone();
        retention_config["retention"] = json!({"last":2,"daily":1,"weekly":1,"monthly":1});
        std::fs::write(config_path, serde_json::to_vec(&retention_config).unwrap()).unwrap();
        let (code, preview) = invoke(
            &[
                "backup",
                "retention",
                "--target",
                "fixture",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0, "retention preview: {preview}");
        assert!(!preview["result"]["snapshotIdsToRemove"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            invoke(
                &[
                    "backup",
                    "retention",
                    "--target",
                    "fixture",
                    "--apply",
                    "--yes",
                    "--config",
                    config_path,
                    "--json"
                ],
                &root
            )
            .await
            .0,
            2
        );
        let (code, latest) = invoke(
            &[
                "backup",
                "verify",
                "--target",
                "fixture",
                "--snapshot",
                "latest",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0, "latest restore receipt: {latest}");
        let (code, retained) = invoke(
            &[
                "backup",
                "retention",
                "--target",
                "fixture",
                "--apply",
                "--yes",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0, "explicit retention apply: {retained}");
        assert_eq!(retained["result"]["integrityChecked"], true);
        let (code, listed) = invoke(
            &[
                "backup",
                "list",
                "--target",
                "fixture",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0);
        let retained = listed["result"]["snapshots"].as_array().unwrap();
        assert!(retained.len() >= 2);
        assert!(retained
            .iter()
            .any(|snapshot| snapshot["snapshotId"] == latest["result"]["snapshotId"]));
        let mut recovery = config.clone();
        recovery["restoreTarget"] =
            json!({"id":"recovery","container":container,"user":"mindleak_light"});
        recovery["targets"][0]["container"] = json!("original-source-no-longer-exists");
        std::fs::write(config_path, serde_json::to_vec(&recovery).unwrap()).unwrap();
        let (code, result) = invoke(
            &[
                "backup",
                "verify",
                "--target",
                "fixture",
                "--snapshot",
                "latest",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(
            code, 0,
            "recovery must not require the original source: {result}"
        );
        let destination = format!("mindleak_retained_{}_test", Uuid::new_v4().simple());
        let (code, restored) = invoke(
            &[
                "backup",
                "restore",
                "--target",
                "fixture",
                "--snapshot",
                "latest",
                "--new-db",
                &destination,
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 0, "retained recovery: {restored}");
        let marker: Option<String> = test_admin
            .query_one(
                "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=$1",
                &[&destination],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(
            marker,
            Some(format!(
                "mindleak-restore:{}",
                restored["result"]["operationId"].as_str().unwrap()
            ))
        );
        let assets =
            std::path::PathBuf::from(restored["result"]["assetsDirectory"].as_str().unwrap());
        let recovered_asset = std::fs::read(assets.join("0/files/guide.txt"));
        let recovered_manifest = std::fs::read(assets.join("0/source-manifest.json"));
        let plaintext_cleaned = !assets.parent().unwrap().join("bundle.tar").exists()
            && !assets.parent().unwrap().join("database.dump").exists();
        test_admin
            .batch_execute(&format!("DROP DATABASE \"{destination}\""))
            .await
            .unwrap();
        assert_eq!(recovered_asset.unwrap(), asset);
        assert_eq!(
            recovered_manifest.unwrap(),
            std::fs::read(&source_manifest).unwrap()
        );
        assert!(plaintext_cleaned);
        let mut partial = config.clone();
        partial["restoreTarget"] =
            json!({"id":"recovery","container":"unavailable-restore-server"});
        std::fs::write(config_path, serde_json::to_vec(&partial).unwrap()).unwrap();
        let (code, result) = invoke(
            &[
                "backup",
                "run",
                "--all",
                "--verify",
                "--config",
                config_path,
                "--json",
            ],
            &root,
        )
        .await;
        assert_eq!(code, 4, "partial run must fail distinctly: {result}");
        assert_eq!(
            result["error"]["details"]["targets"][0]["result"]["backupComplete"],
            true
        );
        std::fs::write(&key, "wrong-fixture-key").unwrap();
        assert_eq!(
            invoke(
                &[
                    "backup",
                    "list",
                    "--target",
                    "fixture",
                    "--config",
                    config_path,
                    "--json"
                ],
                &root
            )
            .await
            .0,
            2
        );
    };
    let result = tokio::spawn(operation).await;
    admin.batch_execute(&cleanup).await.unwrap();
    result.unwrap();
}
