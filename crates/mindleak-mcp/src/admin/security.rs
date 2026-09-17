use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

use fs2::FileExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{failure, settings, AdminResult};

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub(super) fn hash(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub(super) fn hash_file(path: &Path) -> AdminResult<String> {
    hash_opened_file(open_file(path)?)
}

fn hash_opened_file(mut file: File) -> AdminResult<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| failure("inventory", "file_read_failed", 3))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hex(&hash.finalize()))
}

pub(super) fn hash_executable(path: &Path) -> AdminResult<String> {
    hash_opened_file(open_regular_file(path, true)?)
}

pub(super) fn open_file(path: &Path) -> AdminResult<File> {
    open_regular_file(path, false)
}

fn open_regular_file(path: &Path, allow_hard_links: bool) -> AdminResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|_| failure("inventory", "file_unavailable", 3))?;
    let metadata = file
        .metadata()
        .map_err(|_| failure("inventory", "file_metadata_unavailable", 3))?;
    if !metadata.is_file() {
        return Err(failure("inventory", "regular_file_required", 3));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !allow_hard_links && metadata.nlink() != 1 {
            return Err(failure("inventory", "linked_file_refused", 3));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err(failure("inventory", "file_identity_unavailable", 3));
        }
        if !allow_hard_links && information.nNumberOfLinks != 1
            || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(failure("inventory", "linked_file_refused", 3));
        }
    }
    Ok(file)
}

pub(super) fn read_bounded(path: &Path, limit: usize) -> AdminResult<Vec<u8>> {
    let mut file = open_file(path)?.take(limit as u64 + 1);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| failure("inventory", "file_read_failed", 3))?;
    if bytes.len() > limit {
        return Err(failure("inventory", "file_too_large", 3));
    }
    Ok(bytes)
}

pub(super) async fn private(path: &Path, cancel: &CancellationToken) -> AdminResult<()> {
    if cancel.is_cancelled() {
        return Err(failure("permissions", "cancelled", 130));
    }
    settings::safe_path(path)?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| failure("permissions", "private_path_unavailable", 2))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(failure("permissions", "owner_only_permissions_required", 2));
        }
        let _ = cancel;
    }
    #[cfg(windows)]
    {
        private_windows(path, metadata.is_dir())?;
    }
    Ok(())
}

#[cfg(windows)]
fn private_windows(path: &Path, directory: bool) -> AdminResult<()> {
    use std::{
        mem::size_of_val,
        os::windows::{
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        ptr::{addr_of_mut, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            EqualSid, GetAce, GetTokenInformation, IsValidAcl, IsValidSid, IsWellKnownSid,
            TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
            ACE_HEADER, ACL, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE,
            NO_PROPAGATE_INHERIT_ACE, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, READ_CONTROL,
        },
        System::{
            SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE},
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };

    struct Descriptor(PSECURITY_DESCRIPTOR);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    let unavailable = || failure("permissions", "windows_acl_unavailable", 2);
    let denied = |reason| {
        failure("permissions", "owner_only_acl_required", 2)
            .detail("reason", serde_json::json!(reason))
    };
    let file = OpenOptions::new()
        .access_mode(READ_CONTROL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| unavailable())?;
    let mut descriptor = null_mut();
    let mut owner: PSID = null_mut();
    let mut acl: *mut ACL = null_mut();
    let code = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if code != 0 {
        return Err(unavailable());
    }
    let _descriptor = Descriptor(descriptor);
    if owner.is_null()
        || acl.is_null()
        || unsafe { IsValidSid(owner) } == 0
        || unsafe { IsValidAcl(acl) } == 0
    {
        return Err(denied("invalid_security_descriptor"));
    }

    let mut token = [0_usize; 32];
    let mut required = 0_u32;
    let mut token_handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_handle) } == 0 {
        return Err(unavailable());
    }
    let token_handle = unsafe { OwnedHandle::from_raw_handle(token_handle) };
    if unsafe {
        GetTokenInformation(
            token_handle.as_raw_handle(),
            TokenUser,
            token.as_mut_ptr().cast(),
            size_of_val(&token) as u32,
            &mut required,
        )
    } == 0
    {
        return Err(unavailable());
    }
    let user = unsafe { (*token.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let trusted_identity = |sid| unsafe {
        IsValidSid(sid) != 0
            && (EqualSid(sid, user) != 0
                || IsWellKnownSid(sid, WinLocalSystemSid) != 0
                || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0)
    };
    if !trusted_identity(owner) {
        return Err(denied("untrusted_owner"));
    }
    for index in 0..u32::from(unsafe { (*acl).AceCount }) {
        let mut entry = null_mut();
        if unsafe { GetAce(acl, index, &mut entry) } == 0 || entry.is_null() {
            return Err(unavailable());
        }
        let header = unsafe { &*entry.cast::<ACE_HEADER>() };
        if u32::from(header.AceType) == ACCESS_DENIED_ACE_TYPE {
            continue;
        }
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE {
            return Err(denied("unsupported_access_entry"));
        }
        let flags = u32::from(header.AceFlags);
        let inheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
        if directory
            && (flags & inheritance != inheritance
                || flags & (INHERIT_ONLY_ACE | NO_PROPAGATE_INHERIT_ACE) != 0)
        {
            return Err(denied("noninheritable_access"));
        }
        let sid = unsafe { addr_of_mut!((*entry.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast() };
        if !trusted_identity(sid) {
            return Err(denied("untrusted_access_identity"));
        }
    }
    Ok(())
}

pub(super) fn directory(path: &Path) -> AdminResult<()> {
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder
        .create(path)
        .map_err(|_| failure("staging", "owned_directory_creation_failed", 3))
}

pub(super) fn create_file(path: &Path) -> AdminResult<File> {
    let mut options = OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|_| failure("staging", "owned_file_creation_failed", 3))
}

pub(super) fn atomic_json(path: &Path, value: &impl Serialize) -> AdminResult<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = create_file(&temporary)?;
        serde_json::to_writer(&mut file, value)
            .map_err(|_| failure("status", "status_serialization_failed", 3))?;
        file.flush()
            .and_then(|_| file.sync_all())
            .map_err(|_| failure("status", "status_write_failed", 3))?;
        std::fs::rename(&temporary, path)
            .map_err(|_| failure("status", "status_replace_failed", 3))?;
        #[cfg(unix)]
        File::open(path.parent().unwrap())
            .and_then(|parent| parent.sync_all())
            .map_err(|_| failure("status", "status_sync_failed", 3))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(super) struct Lock(File);

impl Lock {
    pub fn repository(config: &super::settings::BackupConfig) -> AdminResult<Self> {
        let path = match &config.repository {
            settings::Repository::Local { path, .. } => {
                settings::safe_path(path)?;
                let parent = path
                    .parent()
                    .and_then(|parent| parent.canonicalize().ok())
                    .ok_or_else(|| failure("lock", "repository_parent_unavailable", 2))?;
                let name = path
                    .file_name()
                    .ok_or_else(|| failure("lock", "repository_name_required", 2))?;
                let mut identity = parent.join(name).to_string_lossy().into_owned();
                if cfg!(any(target_os = "windows", target_os = "macos")) {
                    identity = identity.to_lowercase();
                }
                parent.join(format!(
                    ".mindleak-repository-{}.lock",
                    hash(identity.as_bytes())
                ))
            }
            settings::Repository::Azure { .. } => config.work_dir.join("repository.lock"),
        };
        Self::acquire(&path)
    }

    pub fn acquire(path: &Path) -> AdminResult<Self> {
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(path)
            .map_err(|_| failure("lock", "lock_unavailable", 6))?;
        file.try_lock_exclusive()
            .map_err(|_| failure("lock", "operation_in_progress", 6))?;
        Ok(Self(file))
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub(super) async fn secret(path: &Path, cancel: &CancellationToken) -> AdminResult<String> {
    private(path, cancel).await?;
    let metadata =
        std::fs::metadata(path).map_err(|_| failure("secret", "secret_unavailable", 2))?;
    if !metadata.is_file() || metadata.len() > 65536 {
        return Err(failure("secret", "invalid_secret_file", 2));
    }
    let value = String::from_utf8(
        read_bounded(path, 65536).map_err(|_| failure("secret", "secret_unavailable", 2))?,
    )
    .map_err(|_| failure("secret", "invalid_secret_file", 2))?;
    let value = value.trim_end_matches(['\n', '\r']).to_owned();
    if value.is_empty() || value.contains('\0') {
        return Err(failure("secret", "empty_or_invalid_secret", 2));
    }
    Ok(value)
}

pub(super) async fn reference(
    environment: Option<&str>,
    file: Option<&Path>,
    cancel: &CancellationToken,
) -> AdminResult<String> {
    let value = match (environment, file) {
        (Some(name), None) => std::env::var(name)
            .map_err(|_| failure("secret", "environment_secret_unavailable", 2))?,
        (None, Some(path)) => secret(path, cancel).await?,
        _ => {
            return Err(failure(
                "secret",
                "exactly_one_secret_reference_required",
                2,
            ))
        }
    };
    if value.is_empty() || value.len() > 65536 || value.contains(['\r', '\n', '\0']) {
        return Err(failure("secret", "invalid_secret_reference_value", 2));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_fingerprints_allow_cargo_hard_links_without_allowing_asset_links() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("engine");
        let cargo_alias = directory.path().join("cargo-engine");
        std::fs::write(&executable, b"engine-fixture").unwrap();
        std::fs::hard_link(&executable, &cargo_alias).unwrap();
        assert_eq!(
            hash_executable(&cargo_alias).unwrap(),
            hash(b"engine-fixture")
        );
        assert_eq!(
            hash_file(&cargo_alias).err().unwrap().code,
            "linked_file_refused"
        );
    }

    #[test]
    fn inventory_refuses_hard_linked_files() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let alias = directory.path().join("alias");
        std::fs::write(&source, "private-fixture").unwrap();
        std::fs::hard_link(&source, &alias).unwrap();
        assert_eq!(hash_file(&alias).err().unwrap().code, "linked_file_refused");
    }

    #[test]
    fn repository_lock_coordinates_different_work_directories() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let mut config: super::super::settings::BackupConfig = serde_json::from_value(serde_json::json!({"schemaVersion":1,"repository":{"kind":"local","path":root.join("repository"),"passwordFile":root.join("key")},"workDir":root.join("first"),"targets":[{"id":"fixture","container":"fixture"}]})).unwrap();
        std::fs::create_dir(&config.work_dir).unwrap();
        let first = Lock::repository(&config).unwrap();
        config.work_dir = root.join("second");
        std::fs::create_dir(&config.work_dir).unwrap();
        assert!(
            Lock::repository(&config).is_err(),
            "the same repository must not admit a second administrative writer"
        );
        drop(first);
        assert!(Lock::repository(&config).is_ok());
    }
}
