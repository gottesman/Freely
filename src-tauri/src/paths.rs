use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Global path configuration for the application
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PathConfig {
    /// Base directories
    pub app_data_dir: PathBuf,
    pub app_log_dir: PathBuf,
    pub app_config_dir: PathBuf,
    pub resource_dir: PathBuf,
    
    /// Download directories
    pub torrents_dir: PathBuf,
    pub youtube_dir: PathBuf,
    
    /// Cache directories
    pub audio_cache_dir: PathBuf,
    
    /// Log files
    pub logs: LogPaths,
    
    /// Server files
    pub server: ServerPaths,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LogPaths {
    pub backend_logs: PathBuf,
    pub backend_errors: PathBuf,
    pub frontend_logs: PathBuf,
    pub frontend_errors: PathBuf,
    pub server_logs: PathBuf,
    pub server_errors: PathBuf,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ServerPaths {
    pub script: PathBuf,
    pub pid_file: PathBuf,
    pub db_file: PathBuf,
}

impl PathConfig {
    /// Initialize path configuration using Tauri's APIs
    pub fn new(app_handle: &AppHandle) -> Result<Self, String> {
        // Get base directories from Tauri
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data directory: {}", e))?;
        
        let app_log_dir = app_handle
            .path()
            .app_log_dir()
            .map_err(|e| format!("Failed to get app log directory: {}", e))?;
        
        let app_config_dir = app_handle
            .path()
            .app_config_dir()
            .map_err(|e| format!("Failed to get app config directory: {}", e))?;
        
        let resource_dir = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource directory: {}", e))?;

        // Create subdirectories
        let downloads_dir = app_data_dir.join("downloads");
        let torrents_dir = downloads_dir.join("torrents");
        let youtube_dir = downloads_dir.join("youtube");
        let audio_cache_dir = app_data_dir.join("audio_cache");

        // Define log file paths
        let logs = LogPaths {
            backend_logs: app_log_dir.join("backend_logs.txt"),
            backend_errors: app_log_dir.join("backend_errors.txt"),
            frontend_logs: app_log_dir.join("frontend_logs.txt"),
            frontend_errors: app_log_dir.join("frontend_errors.txt"),
            server_logs: app_log_dir.join("server_logs.txt"),
            server_errors: app_log_dir.join("server_errors.txt"),
        };

        // Define server file paths
        let server = ServerPaths {
            script: resource_dir.join("server-dist").join("server.bundle.js"),
            pid_file: app_config_dir.join(".server.pid"),
            db_file: app_config_dir.join("freely.db"),
        };

        let config = PathConfig {
            app_data_dir,
            app_log_dir,
            app_config_dir,
            resource_dir,
            torrents_dir,
            youtube_dir,
            audio_cache_dir,
            logs,
            server,
        };

        // Ensure all directories exist
        config.ensure_directories_exist()?;

        Ok(config)
    }

    /// Ensure all necessary directories exist
    pub fn ensure_directories_exist(&self) -> Result<(), String> {
        let dirs_to_create = [
            &self.app_data_dir,
            &self.app_log_dir,
            &self.app_config_dir,
            &self.torrents_dir,
            &self.youtube_dir,
            &self.audio_cache_dir,
        ];

        for dir in dirs_to_create {
            if !dir.exists() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("Failed to create directory {}: {}", dir.display(), e))?;
            }
        }

        Ok(())
    }

    /// Get a JSON representation of the path configuration
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize path config: {}", e))
    }

    /// Export path configuration for use by other processes (like Node.js server)
    pub fn export_as_env_vars(&self) -> Vec<(String, String)> {
        vec![
            ("FREELY_APP_DATA_DIR".to_string(), self.app_data_dir.to_string_lossy().to_string()),
            ("FREELY_LOG_DIR".to_string(), self.app_log_dir.to_string_lossy().to_string()),
            ("FREELY_CONFIG_DIR".to_string(), self.app_config_dir.to_string_lossy().to_string()),
            ("FREELY_TORRENTS_DIR".to_string(), self.torrents_dir.to_string_lossy().to_string()),
            ("FREELY_YOUTUBE_DIR".to_string(), self.youtube_dir.to_string_lossy().to_string()),
            ("FREELY_AUDIO_CACHE_DIR".to_string(), self.audio_cache_dir.to_string_lossy().to_string()),
            
            // Log files
            ("FREELY_BACKEND_LOGS".to_string(), self.logs.backend_logs.to_string_lossy().to_string()),
            ("FREELY_BACKEND_ERRORS".to_string(), self.logs.backend_errors.to_string_lossy().to_string()),
            ("FREELY_FRONTEND_LOGS".to_string(), self.logs.frontend_logs.to_string_lossy().to_string()),
            ("FREELY_FRONTEND_ERRORS".to_string(), self.logs.frontend_errors.to_string_lossy().to_string()),
            ("FREELY_SERVER_LOGS".to_string(), self.logs.server_logs.to_string_lossy().to_string()),
            ("FREELY_SERVER_ERRORS".to_string(), self.logs.server_errors.to_string_lossy().to_string()),
            
            // Server files (for backwards compatibility)
            ("PID_FILE_PATH".to_string(), self.server.pid_file.to_string_lossy().to_string()),
            ("LOG_FILE_PATH".to_string(), self.logs.server_logs.to_string_lossy().to_string()),
            ("ERR_FILE_PATH".to_string(), self.logs.server_errors.to_string_lossy().to_string()),
        ]
    }
}

/// Tauri command to get path configuration as JSON
#[tauri::command]
pub async fn get_path_config(config: tauri::State<'_, PathConfig>) -> Result<String, String> {
    config.to_json()
}

/// Tauri command to write content to a log file
#[tauri::command]
pub async fn write_to_log_file(file_path: String, content: String) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;

    // Ensure the parent directory exists
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create log directory: {}", e))?;
    }

    // Append content to the file
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("Failed to open log file {}: {}", file_path, e))?;

    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write to log file: {}", e))?;

    file.flush()
        .map_err(|e| format!("Failed to flush log file: {}", e))?;

    Ok(())
}