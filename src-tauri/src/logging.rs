use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;

/// Global backend logger instance
static BACKEND_LOGGER: Lazy<Mutex<Option<BackendLogger>>> = Lazy::new(|| Mutex::new(None));

/// Backend logger for Tauri console outputs
pub struct BackendLogger {
    log_file_path: PathBuf,
    error_file_path: PathBuf,
}

impl BackendLogger {
    /// Initialize the backend logger with file paths
    pub fn init(log_file_path: PathBuf, error_file_path: PathBuf) -> Result<(), String> {
        let logger = BackendLogger {
            log_file_path,
            error_file_path,
        };

        // Test write access to both files
        logger.ensure_files_writable()?;

        // Store the logger globally
        *BACKEND_LOGGER.lock().unwrap() = Some(logger);

        // Log initialization
        log_info("Backend logger initialized");

        Ok(())
    }

    /// Ensure log files are writable
    fn ensure_files_writable(&self) -> Result<(), String> {
        // Ensure parent directories exist
        if let Some(parent) = self.log_file_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create log directory: {}", e))?;
        }

        // Test write access
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_file_path)
            .map_err(|e| format!("Cannot write to log file {}: {}", self.log_file_path.display(), e))?;

        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.error_file_path)
            .map_err(|e| format!("Cannot write to error file {}: {}", self.error_file_path.display(), e))?;

        Ok(())
    }

    /// Write a log entry to the log file
    fn write_log(&self, level: &str, message: &str) {
        let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S UTC");
        let log_entry = format!("[{}] [{}] {}\n", timestamp, level, message);

        let file_path = match level {
            "ERROR" | "WARN" => &self.error_file_path,
            _ => &self.log_file_path,
        };

        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(file_path) {
            let _ = file.write_all(log_entry.as_bytes());
            let _ = file.flush();
        }
    }
}

/// Log an info message
pub fn log_info(message: &str) {
    println!("[INFO] {}", message);
    
    if let Ok(logger_guard) = BACKEND_LOGGER.lock() {
        if let Some(logger) = logger_guard.as_ref() {
            logger.write_log("INFO", message);
        }
    }
}

/// Log a warning message
pub fn log_warn(message: &str) {
    eprintln!("[WARN] {}", message);
    
    if let Ok(logger_guard) = BACKEND_LOGGER.lock() {
        if let Some(logger) = logger_guard.as_ref() {
            logger.write_log("WARN", message);
        }
    }
}

/// Log an error message
pub fn log_error(message: &str) {
    eprintln!("[ERROR] {}", message);
    
    if let Ok(logger_guard) = BACKEND_LOGGER.lock() {
        if let Some(logger) = logger_guard.as_ref() {
            logger.write_log("ERROR", message);
        }
    }
}

/// Log a debug message
pub fn log_debug(message: &str) {
    println!("[DEBUG] {}", message);
    
    if let Ok(logger_guard) = BACKEND_LOGGER.lock() {
        if let Some(logger) = logger_guard.as_ref() {
            logger.write_log("DEBUG", message);
        }
    }
}

/// Convenience macro for logging with format arguments
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {
        $crate::logging::log_info(&format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {
        $crate::logging::log_warn(&format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        $crate::logging::log_error(&format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => {
        $crate::logging::log_debug(&format!($($arg)*))
    };
}