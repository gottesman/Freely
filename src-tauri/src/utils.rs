use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};

/// Spawns a background thread to capture and log process output
pub fn spawn_logger(
    stdio: impl std::io::Read + Send + 'static,
    log_path: impl AsRef<std::path::Path> + Send + 'static,
) {
    let log_path = log_path.as_ref().to_path_buf();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdio);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            for line in reader.lines().flatten() {
                let _ = writeln!(file, "{}", line);
            }
        }
    });
}

/// Captures both stdout and stderr from a child process
pub fn capture_process_output(child: &mut Child, log_file: std::path::PathBuf, err_file: std::path::PathBuf) {
    if let Some(stdout) = child.stdout.take() {
        spawn_logger(stdout, log_file.clone());
    }
    
    if let Some(stderr) = child.stderr.take() {
        spawn_logger(stderr, err_file);
    }
}

/// Kills a process by PID using platform-specific commands
pub fn kill_process_by_pid(pid: u32) -> Result<(), std::io::Error> {
    let pid_str = pid.to_string();
    
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid_str, "/T", "/F"])
            .output()?;
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("kill")
            .args(["-9", &pid_str])
            .output()?;
    }
    
    Ok(())
}

/// Creates a Node.js command with common settings
pub fn create_node_command(script_path: &std::path::Path, working_dir: &std::path::Path) -> std::process::Command {
    let node_path = if cfg!(target_os = "windows") {
        "C:\\Program Files\\nodejs\\node.exe"
    } else {
        "node"
    };

    let mut cmd = std::process::Command::new(node_path);
    cmd.arg(script_path)
        .current_dir(working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}
