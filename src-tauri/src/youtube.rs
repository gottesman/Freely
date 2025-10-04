use std::path::PathBuf;
use tokio::process::Command;

use crate::paths::PathConfig;

/// Return yt-dlp (or youtube-dl) executable located in resources/bin
fn resolve_ytdlp_exe(resource_dir: &PathBuf) -> Option<PathBuf> {
    let bin = resource_dir.join("bin");
    let candidate = if cfg!(target_os = "windows") {
        "youtube-dl.exe"
    } else {
        "youtube-dl"
    };
    let p = bin.join(candidate);
    if p.exists() {
        return Some(p);
    }
    None
}

pub fn execute_ytdlp(args: &[&str], config: &PathConfig) -> Result<String, String> {
    let exe = resolve_ytdlp_exe(&config.resource_dir)
        .ok_or("yt-dlp/youtube-dl not found in resources/bin")?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        
        let output = std::process::Command::new(&exe)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "yt-dlp exit {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(stdout)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = std::process::Command::new(&exe)
            .args(args)
            .output()
            .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "yt-dlp exit {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(stdout)
    }
}

/// Fetch full JSON info for a YouTube video via yt-dlp -j
pub async fn get_info(id: &str, config: &PathConfig) -> Result<serde_json::Value, String> {
    let output = execute_ytdlp(
        &["-j", &format!("https://www.youtube.com/watch?v={}", id)],
        config,
    )?;
    let val: serde_json::Value = serde_json::from_str(&output)
        .map_err(|e| format!("Bad yt-dlp JSON: {}", e))?;
    Ok(val)
}

/// Fetch a direct bestaudio stream URL for a YouTube video via yt-dlp -g -f bestaudio
pub async fn get_stream_url(id: &str, config: &PathConfig) -> Result<String, String> {
    let url = execute_ytdlp(
        &["-g", "-f", "bestaudio", &format!("https://www.youtube.com/watch?v={}", id)],
        config,
    )?;

    if url.is_empty() {
        return Err("No stream URL found".into());
    }
    Ok(url)
}