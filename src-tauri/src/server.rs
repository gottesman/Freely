use crate::utils::{capture_process_output, create_node_command, kill_process_by_pid};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::State;

/// Server process information
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ServerPidInfo {
    pub pid: Option<u32>,
    pub port: Option<u16>,
}

impl Default for ServerPidInfo {
    fn default() -> Self {
        Self {
            pid: None,
            port: None,
        }
    }
}

/// All dynamically resolved paths for the application
pub struct PathState {
    pub server_script: PathBuf,
    pub pid_file: PathBuf,
    pub log_file: PathBuf,
    pub err_file: PathBuf,
    pub db_file: PathBuf,
}

impl PathState {
    /// Reads server status from PID file and validates with ping
    pub async fn get_server_status(&self) -> Result<ServerPidInfo, String> {
        // Check if PID file exists
        if !self.pid_file.exists() {
            return Ok(ServerPidInfo::default());
        }

        // Read and parse PID file
        let raw_content = std::fs::read_to_string(&self.pid_file)
            .map_err(|e| format!("Failed to read PID file: {}", e))?;

        let info: ServerPidInfo = serde_json::from_str(&raw_content).map_err(|e| {
            eprintln!("Failed to parse PID file: {}", e);
            return format!("Malformed PID file: {}", e);
        })?;

        // Validate server is responding if port is available
        if let Some(port) = info.port {
            if self.ping_server(port).await {
                return Ok(info);
            }
        }

        // Server not responding, return PID without port
        Ok(ServerPidInfo {
            pid: info.pid,
            port: None,
        })
    }

    /// Pings the server to check if it's responsive
    async fn ping_server(&self, port: u16) -> bool {
        let url = format!("http://localhost:{}/ping", port);

        reqwest::Client::new()
            .get(&url)
            .timeout(Duration::from_millis(1500))
            .send()
            .await
            .map(|res| res.status().is_success())
            .unwrap_or(false)
    }

    /// Starts the server process
    pub async fn start_server(&self) -> Result<ServerPidInfo, String> {
        // Kill any existing server
        self.kill_server();

        // Validate paths
        if !self.server_script.exists() {
            return Err(format!(
                "Server script not found: {}",
                self.server_script.display()
            ));
        }

        let working_dir = self
            .server_script
            .parent()
            .ok_or("Could not get server script directory")?;

        // Create and configure command
        let mut cmd = create_node_command(&self.server_script, working_dir);
        cmd.env("PID_FILE_PATH", &self.pid_file);

        // Spawn process
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn server: {}", e))?;

        let pid = child.id();

        // Capture output
        capture_process_output(&mut child, self.log_file.clone(), self.err_file.clone());

        // Wait for server to become ready
        self.wait_for_server_ready(pid).await
    }

    /// Waits for the server to become ready and responsive
    async fn wait_for_server_ready(&self, pid: u32) -> Result<ServerPidInfo, String> {
        const MAX_ATTEMPTS: u8 = 20;
        const WAIT_MS: u64 = 500;

        for _ in 0..MAX_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(WAIT_MS)).await;

            if let Ok(status) = self.get_server_status().await {
                if status.port.is_some() {
                    return Ok(ServerPidInfo {
                        pid: Some(pid),
                        port: status.port,
                    });
                }
            }
        }

        // Server didn't start in time, kill it
        let _ = kill_process_by_pid(pid);
        Err("Server did not start responding in time".to_string())
    }

    /// Kills the server process using PID file information
    pub fn kill_server(&self) {
        if !self.pid_file.exists() {
            return;
        }

        if let Ok(content) = std::fs::read_to_string(&self.pid_file) {
            if let Ok(info) = serde_json::from_str::<ServerPidInfo>(&content) {
                if let Some(pid) = info.pid {
                    println!("Killing server process {}", pid);
                    let _ = kill_process_by_pid(pid);
                }
            }
        }

        // Clean up PID file
        let _ = std::fs::remove_file(&self.pid_file);
    }
}

/// Tauri command wrapper for getting server status
#[tauri::command]
pub async fn server_status(paths: State<'_, PathState>) -> Result<ServerPidInfo, String> {
    paths.get_server_status().await
}

/// Tauri command wrapper for starting the server
#[tauri::command]
pub async fn server_start(paths: State<'_, PathState>) -> Result<ServerPidInfo, String> {
    paths.start_server().await
}
