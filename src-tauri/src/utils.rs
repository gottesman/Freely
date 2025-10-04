use crate::bass::{bass_init, ensure_bass_loaded, probe_audio_format_for_url, BASS_DEVICE_DEFAULT};
use reqwest;
use tauri::Manager;
use std::io::{BufRead, BufReader, Write};
// logging macros available globally
use std::path::PathBuf;
use std::process::{Child, Stdio};
use tokio::process::Command;
use tokio::sync::mpsc;

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
pub fn capture_process_output(
    child: &mut Child,
    log_file: std::path::PathBuf,
    err_file: std::path::PathBuf,
) {
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

pub async fn resolve_torrent_source_with_index(
    value: &str,
    file_index: Option<usize>,
) -> Result<String, String> {
    // Extract infoHash from magnetURI if needed
    let info_hash = if value.starts_with("magnet:") {
        if let Some(start) = value.find("xt=urn:btih:") {
            let hash_start = start + 12;
            if let Some(end) = value[hash_start..].find('&') {
                value[hash_start..hash_start + end].to_lowercase()
            } else {
                value[hash_start..].to_lowercase()
            }
        } else {
            return Err("Invalid magnet URI format".to_string());
        }
    } else {
        // Assume it's already an infoHash
        value.to_lowercase()
    };

    // With no HTTP server, we cannot return a streaming URL.
    // Caller should use torrent_start_download + torrent_get_file_path.
    // Here we return a synthetic scheme to indicate torrent source.
    let index = file_index.unwrap_or(0);
    Ok(format!("torrent://{}/{}", info_hash, index))
}

pub async fn resolve_youtube_source(value: &str) -> Result<String, String> {
    // Determine the video ID from several possible input formats, including
    // direct IDs, YouTube URLs, youtu.be short links, and local streaming/info URLs
    let mut video_id_opt: Option<String> = None;

    // Ignore legacy local streaming/info URL formats

    // If not a local URL, check if value is already a video ID
    if video_id_opt.is_none()
        && value.len() == 11
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        video_id_opt = Some(value.to_string());
    }

    // Try to extract from common URL patterns
    if video_id_opt.is_none() {
        if let Some(start) = value.find("v=") {
            if let Some(end) = value[start + 2..].find('&') {
                video_id_opt = Some(value[start + 2..start + 2 + end].to_string());
            } else {
                video_id_opt = Some(value[start + 2..].to_string());
            }
        } else if let Some(start) = value.find("youtu.be/") {
            if let Some(end) = value[start + 9..].find('?') {
                video_id_opt = Some(value[start + 9..start + 9 + end].to_string());
            } else {
                video_id_opt = Some(value[start + 9..].to_string());
            }
        }
    }

    let video_id = match video_id_opt {
        Some(id) => id,
        None => return Err("Unable to extract YouTube video ID".to_string()),
    };

    // Use yt-dlp directly to get bestaudio URL
    let config = get_path_config_clone().ok_or("PathConfig not initialized")?;
    let url = crate::youtube::get_stream_url(&video_id, &config).await?;
    Ok(url)
}

pub async fn resolve_youtube_source_with_format(
    value: &str,
) -> Result<ResolvedAudioSource, String> {
    // Determine the video ID from several possible input formats
    let mut video_id_opt: Option<String> = None;

    // Ignore legacy local streaming/info URL formats

    // If not a local URL, check if value is already a video ID
    if video_id_opt.is_none()
        && value.len() == 11
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        video_id_opt = Some(value.to_string());
    }

    // Try to extract from common URL patterns
    if video_id_opt.is_none() {
        if let Some(start) = value.find("v=") {
            if let Some(end) = value[start + 2..].find('&') {
                video_id_opt = Some(value[start + 2..start + 2 + end].to_string());
            } else {
                video_id_opt = Some(value[start + 2..].to_string());
            }
        } else if let Some(start) = value.find("youtu.be/") {
            if let Some(end) = value[start + 9..].find('?') {
                video_id_opt = Some(value[start + 9..start + 9 + end].to_string());
            } else {
                video_id_opt = Some(value[start + 9..].to_string());
            }
        }
    }

    let video_id = match video_id_opt {
        Some(id) => id,
        None => return Err("Unable to extract YouTube video ID".to_string()),
    };

    // Use yt-dlp directly to get bestaudio URL (and try to probe basic format via BASS)
    let config = get_path_config_clone().ok_or("PathConfig not initialized")?;
    let url = crate::youtube::get_stream_url(&video_id, &config).await?;
    // Attempt to probe format
    let mut format: Option<AudioFormat> = None;
    if let Ok(lib) = crate::bass::ensure_bass_loaded() {
        let _ = crate::bass::bass_init(&lib, crate::bass::BASS_DEVICE_DEFAULT, 44100, 0);
        if let Some(info) = crate::bass::probe_audio_format_for_url(&lib, &url) {
            format = Some(AudioFormat { acodec: info.codec, ext: None, filesize: None, mime_type: None });
        }
    }
    Ok(ResolvedAudioSource { url, format })
}

fn get_path_config_clone() -> Option<crate::paths::PathConfig> {
    if let Ok(lock) = crate::APP_HANDLE.lock() {
        if let Some(app) = lock.as_ref() {
            let state = app.state::<crate::paths::PathConfig>();
            return Some(state.inner().clone());
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct AudioFormat {
    pub acodec: Option<String>,
    pub ext: Option<String>,
    pub filesize: Option<u64>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedAudioSource {
    pub url: String,
    pub format: Option<AudioFormat>,
}

pub async fn resolve_audio_source(source_type: &str, value: &str) -> Result<String, String> {
    log_debug!("[bass] resolve_audio_source type='{}' value='{}'", source_type, value);

    let result = match source_type {
        "local" => resolve_local_source(value).await,
        "http" => resolve_http_source(value).await,
        "torrent" => resolve_torrent_source_with_index(value, None).await,
        "youtube" => resolve_youtube_source(value).await,
        _ => {
            log_warn!("[bass] Unsupported source type: {}", source_type);
            Err(format!("Unsupported source type: {}", source_type))
        }
    };

    match &result {
        Ok(url) => log_info!("[bass] Source resolution successful: {}", url),
        Err(error) => log_error!("[bass] Source resolution failed: {}", error),
    }

    result
}

pub async fn resolve_audio_source_with_format(
    source_type: &str,
    value: &str,
    file_index: Option<usize>,
) -> Result<ResolvedAudioSource, String> {
    log_debug!("[bass] resolve_audio_source_with_format type='{}' value='{}' index={:?}", source_type, value, file_index);

    // First, resolve the final URL for the source type
    let resolved = match source_type {
        "local" => resolve_local_source(value).await?,
        "http" => resolve_http_source(value).await?,
        "torrent" => resolve_torrent_source_with_index(value, file_index).await?,
        "youtube" => {
            // For YouTube we already extract format when possible via server info
            let yt = resolve_youtube_source_with_format(value).await?;
            return Ok(yt);
        }
        _ => {
            log_warn!("[bass] Unsupported source type: {}", source_type);
            return Err(format!("Unsupported source type: {}", source_type));
        }
    };

    // Try probing format using BASS (shared helper) without starting full playback
    let mut format: Option<AudioFormat> = None;
    if let Ok(lib) = ensure_bass_loaded() {
        // Initialize BASS if not already (safe no-op if already initialized)
        let _ = bass_init(&lib, BASS_DEVICE_DEFAULT, 44100, 0);
        if let Some(info) = probe_audio_format_for_url(&lib, &resolved) {
            format = Some(AudioFormat {
                acodec: info.codec,
                ext: None,
                filesize: None,
                mime_type: None,
            });
        }
    } else {
        log_warn!("[bass] Unable to load BASS library for format probing");
    }

    let result = ResolvedAudioSource {
        url: resolved,
        format,
    };

    log_info!("[bass] Source resolution successful");
    Ok(result)
}
