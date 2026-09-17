use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

use super::{failure, AdminResult};

pub(super) struct Invocation {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: BTreeMap<OsString, OsString>,
    pub cwd: Option<PathBuf>,
    pub input_file: Option<PathBuf>,
}

impl Invocation {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
            input_file: None,
        }
    }
    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }
    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args).env_clear().kill_on_drop(true);
        for name in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "SystemDrive",
            "COMSPEC",
            "PATHEXT",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "ProgramData",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "CommonProgramFiles",
            "HOME",
            "TMPDIR",
            "TEMP",
            "TMP",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.env("LC_ALL", "C").envs(&self.env);
        if let Some(directory) = &self.cwd {
            command.current_dir(directory);
        }
        #[cfg(unix)]
        command.process_group(0);
        command
    }
}

pub(super) struct Output {
    pub code: i32,
    pub bytes: Vec<u8>,
}

pub(super) async fn capture(
    invocation: &Invocation,
    input: &[u8],
    seconds: u64,
    cancel: &CancellationToken,
    stage: &'static str,
) -> AdminResult<Output> {
    if cancel.is_cancelled() {
        return Err(failure(stage, "cancelled", 130));
    }
    let input_stdio = invocation
        .input_file
        .as_ref()
        .map(std::fs::File::open)
        .transpose()
        .map_err(|_| failure(stage, "input_file_unavailable", 3))?
        .map(Stdio::from)
        .unwrap_or_else(|| {
            if input.is_empty() {
                Stdio::null()
            } else {
                Stdio::piped()
            }
        });
    let mut child = invocation
        .command()
        .stdin(input_stdio)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| failure(stage, "tool_unavailable", 2))?;
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().unwrap().take(8 * 1024 * 1024 + 1);
    let mut stderr = child.stderr.take().unwrap();
    let operation = async {
        let mut bytes = Vec::new();
        let mut discarded = tokio::io::sink();
        tokio::try_join!(
            async {
                if let Some(mut stdin) = stdin {
                    stdin
                        .write_all(input)
                        .await
                        .map_err(|_| failure(stage, "tool_input_failed", 3))?;
                    stdin
                        .shutdown()
                        .await
                        .map_err(|_| failure(stage, "tool_input_failed", 3))?;
                }
                Ok(())
            },
            async {
                stdout
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|_| failure(stage, "tool_output_failed", 3))?;
                if bytes.len() > 8 * 1024 * 1024 {
                    return Err(failure(stage, "tool_output_limit", 3));
                }
                Ok(())
            },
            async {
                tokio::io::copy(&mut stderr, &mut discarded)
                    .await
                    .map_err(|_| failure(stage, "tool_output_failed", 3))
            }
        )?;
        Ok(bytes)
    };
    let result = tokio::select! {
        _ = cancel.cancelled() => Err(failure(stage, "cancelled", 130)),
        result = tokio::time::timeout(Duration::from_secs(seconds), operation) => result.unwrap_or_else(|_| Err(failure(stage, "tool_timeout", 3))),
    };
    if result.is_err() {
        stop(&mut child).await;
        return result.map(|bytes| Output { code: -1, bytes });
    }
    let waited = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .map_err(|_| failure(stage, "tool_exit_timeout", 3))
        .and_then(|result| result.map_err(|_| failure(stage, "tool_wait_failed", 3)));
    let status = match waited {
        Ok(status) => status,
        Err(error) => {
            stop(&mut child).await;
            return Err(error);
        }
    };
    Ok(Output {
        code: status.code().unwrap_or(-1),
        bytes: result?,
    })
}

pub(super) async fn stop(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut killer = Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok();
        if let Some(killer) = killer.as_mut() {
            let _ = tokio::time::timeout(Duration::from_secs(5), killer.wait()).await;
        }
    }
    let _ = child.kill().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

pub(super) fn succeeded(output: Output, stage: &'static str) -> AdminResult<Vec<u8>> {
    let result = match output.code {
        0 => Ok(output.bytes),
        10 => Err(failure(stage, "repository_not_initialized", 2)),
        11 => Err(failure(stage, "repository_locked", 6)),
        12 => Err(failure(stage, "repository_key_rejected", 2)),
        130 => Err(failure(stage, "cancelled", 130)),
        _ => Err(failure(stage, "tool_failed", 3)),
    };
    result.map_err(|error| error.detail("toolExitCode", serde_json::json!(output.code)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "owned subprocess fixture"]
    fn output_fixture() {
        if std::env::var("MINDLEAK_BACKUP_OUTPUT_FIXTURE").as_deref() == Ok("stdin") {
            use std::io::Read;
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).unwrap();
            println!("received-input-bytes:{}", bytes.len());
            return;
        }
        if std::env::var("MINDLEAK_BACKUP_OUTPUT_FIXTURE").as_deref() != Ok("overflow") {
            return;
        }
        use std::io::Write;
        std::io::stdout()
            .write_all(&vec![b'x'; 9 * 1024 * 1024])
            .unwrap();
        std::thread::park();
    }

    #[tokio::test]
    async fn command_stdin_reaches_eof_with_and_without_input() {
        let mut invocation = Invocation::new(std::env::current_exe().unwrap()).args([
            "--exact",
            "admin::process::tests::output_fixture",
            "--ignored",
            "--nocapture",
        ]);
        invocation
            .env
            .insert("MINDLEAK_BACKUP_OUTPUT_FIXTURE".into(), "stdin".into());
        for input in [b"".as_slice(), b"input-fixture".as_slice()] {
            let output = capture(
                &invocation,
                input,
                5,
                &CancellationToken::new(),
                "stdin_probe",
            )
            .await
            .unwrap();
            let bytes = succeeded(output, "stdin_probe").unwrap();
            assert!(String::from_utf8(bytes)
                .unwrap()
                .contains(&format!("received-input-bytes:{}", input.len())));
        }
    }

    #[tokio::test]
    async fn oversized_output_fails_before_waiting_for_process_exit() {
        let mut invocation = Invocation::new(std::env::current_exe().unwrap()).args([
            "--exact",
            "admin::process::tests::output_fixture",
            "--ignored",
            "--nocapture",
        ]);
        invocation
            .env
            .insert("MINDLEAK_BACKUP_OUTPUT_FIXTURE".into(), "overflow".into());
        let error = capture(&invocation, &[], 2, &CancellationToken::new(), "test")
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "tool_output_limit");
    }
}
