use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use tokio::sync::mpsc;
use reqwest;
use std::path::PathBuf;

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

// URL resolution functions for different source types
pub async fn resolve_local_source(value: &str) -> Result<String, String> {
    // For local files, return file:// URL
    if value.starts_with("file://") {
        Ok(value.to_string())
    } else {
        Ok(format!("file://{}", value))
    }
}

pub async fn resolve_http_source(value: &str) -> Result<String, String> {
    // For HTTP URLs, return as-is
    Ok(value.to_string())
}

pub async fn resolve_torrent_source(value: &str) -> Result<String, String> {
    // Extract infoHash from magnetURI if needed
    if value.starts_with("magnet:") {
        if let Some(start) = value.find("xt=urn:btih:") {
            let hash_start = start + 12;
            if let Some(end) = value[hash_start..].find('&') {
                let info_hash = &value[hash_start..hash_start + end];
                return Ok(format!("http://localhost:9000/stream/{}/0", info_hash.to_lowercase()));
            } else {
                let info_hash = &value[hash_start..];
                return Ok(format!("http://localhost:9000/stream/{}/0", info_hash.to_lowercase()));
            }
        }
        return Err("Invalid magnet URI format".to_string());
    }
    // Assume it's already an infoHash
    Ok(format!("http://localhost:9000/stream/{}/0", value.to_lowercase()))
}

pub async fn resolve_youtube_source(value: &str) -> Result<String, String> {
    // If it's already a localhost streaming URL, return as-is
    if value.starts_with("http://localhost:9000/source/youtube") {
        return Ok(value.to_string());
    }

    // For YouTube sources, get the direct CDN URL from the info endpoint
    let video_id = if value.len() == 11 && value.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        // It's already a video ID
        value.to_string()
    } else {
        // Try to extract video ID from URL
        if let Some(start) = value.find("v=") {
            if let Some(end) = value[start + 2..].find('&') {
                value[start + 2..start + 2 + end].to_string()
            } else {
                value[start + 2..].to_string()
            }
        } else if let Some(start) = value.find("youtu.be/") {
            if let Some(end) = value[start + 9..].find('?') {
                value[start + 9..start + 9 + end].to_string()
            } else {
                value[start + 9..].to_string()
            }
        } else {
            return Err("Unable to extract YouTube video ID".to_string());
        }
    };

    // Get the info to extract the direct YouTube CDN URL
    let info_url = format!("http://localhost:9000/source/youtube?id={}&get=info", video_id);
    println!("[resolve] Fetching YouTube info for direct URL: {}", info_url);

    let client = reqwest::Client::new();
    let response = client.get(&info_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch YouTube info: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("YouTube info request failed with status: {}", response.status()));
    }

    let data: serde_json::Value = response.json()
        .await
        .map_err(|e| format!("Failed to parse YouTube info response: {}", e))?;

    println!("[resolve] YouTube info response: {:?}", data);

    if let Some(success) = data.get("success").and_then(|s| s.as_bool()) {
        if success {
            if let Some(format_data) = data.get("data").and_then(|d| d.get("format")) {
                if let Some(url) = format_data.get("url").and_then(|u| u.as_str()) {
                    println!("[resolve] Successfully extracted direct YouTube CDN URL: {}", url);
                    return Ok(url.to_string());
                }
            }
        }
    }

    // Fallback to streaming endpoint if direct URL extraction fails
    println!("[resolve] Falling back to streaming endpoint for video ID: {}", video_id);
    Ok(format!("http://localhost:9000/source/youtube?id={}&get=stream", video_id))
}

pub async fn resolve_audio_source(source_type: &str, value: &str) -> Result<String, String> {
    println!("[bass] resolve_audio_source called with type: '{}', value: '{}'", source_type, value);
    
    let result = match source_type {
        "local" => resolve_local_source(value).await,
        "http" => resolve_http_source(value).await,
        "torrent" => resolve_torrent_source(value).await,
        "youtube" => resolve_youtube_source(value).await,
        _ => {
            println!("[bass] Unsupported source type: {}", source_type);
            Err(format!("Unsupported source type: {}", source_type))
        },
    };
    
    match &result {
        Ok(url) => println!("[bass] Source resolution successful: {}", url),
        Err(error) => println!("[bass] Source resolution failed: {}", error),
    }
    
    result
}
