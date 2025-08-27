#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Stdio;
use dirs::config_dir;
use base64::Engine;
use tauri;
use tauri::Emitter;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::fs::OpenOptions;
use std::thread;
use std::time::Duration;

#[derive(Serialize, Deserialize)]
struct ServerPidInfo {
    pid: Option<u32>,
    port: Option<u16>
}

#[tauri::command]
async fn db_path() -> Result<Option<String>, String> {
    // tauri v1 app_dir requires a &Config; use app_config_dir with default
    match config_dir() {
        Some(mut p) => {
            p.push("freely");
            if !p.exists() { let _ = std::fs::create_dir_all(&p); }
            p.push("freely.db");
            Ok(Some(p.to_string_lossy().to_string()))
        }
        None => Ok(None)
    }
}

#[tauri::command]
async fn db_read() -> Result<Option<String>, String> {
    match db_path().await? {
        Some(p) => {
            let pb = PathBuf::from(p);
            if !pb.exists() { return Ok(None); }
            let data = std::fs::read(pb).map_err(|e| e.to_string())?;
            Ok(Some(base64::engine::general_purpose::STANDARD.encode(&data)))
        }
        None => Ok(None)
    }
}

#[tauri::command]
async fn db_write(base64_data: String) -> Result<bool, String> {
    match db_path().await? {
        Some(p) => {
            let pb = PathBuf::from(p);
            if let Some(parent) = pb.parent() { let _ = std::fs::create_dir_all(parent); }
            let bytes = base64::engine::general_purpose::STANDARD.decode(&base64_data).map_err(|e| e.to_string())?;
            std::fs::write(pb, bytes).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Err("No app dir available".into())
    }
}

// Server status: read server/.torrent-server.pid and probe http endpoint
#[tauri::command]
async fn server_status() -> Result<ServerPidInfo, String> {
    let pid_file = std::path::Path::new("server/.torrent-server.pid");
    if !pid_file.exists() { return Ok(ServerPidInfo{ pid: None, port: None }); }
    let raw = std::fs::read_to_string(pid_file).map_err(|e| e.to_string())?;
    let info: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    let port = info.get("port").and_then(|v| v.as_u64()).map(|v| v as u16);
    let pid = info.get("pid").and_then(|v| v.as_u64()).map(|v| v as u32);
    // Probe reachability
    if let Some(p) = port {
        let url = format!("http://localhost:{}/api/torrent-search?q=ping", p);
        let client = reqwest::Client::new();
        let res = client.get(&url).timeout(std::time::Duration::from_millis(1500)).send().await;
        if let Ok(r) = res { if r.status().is_success() { return Ok(ServerPidInfo{ pid, port: Some(p) }); } }
    }
    Ok(ServerPidInfo{ pid, port })
}

// Try to start the node-based server by spawning `node server/torrent-server.js`
#[tauri::command]
async fn server_start() -> Result<bool, String> {
    // If server already appears reachable, return early
    if let Ok(existing) = server_status().await {
        if existing.port.is_some() {
            return Ok(true);
        }
    }

    // Prepare log files
    let log_path = std::path::Path::new("server/torrent-server.log");
    let err_path = std::path::Path::new("server/torrent-server.err.log");
    if let Some(p) = log_path.parent() { let _ = std::fs::create_dir_all(p); }

    // Spawn child process with pipes for stdout/stderr
    let mut cmd = std::process::Command::new("node");
    cmd.arg("server/torrent-server.js");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    // On Windows, avoid creating a visible window
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {}", e))?;
    let pid = child.id();

    // Write initial PID file (assume default port 9000) so other parts can probe it
    let pid_obj = serde_json::json!({ "pid": pid, "port": 9000 });
    let _ = std::fs::write("server/.torrent-server.pid", serde_json::to_string(&pid_obj).unwrap());

    // Capture stdout
    if let Some(stdout) = child.stdout.take() {
        let lp = log_path.to_path_buf();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            while let Ok(bytes) = reader.read_line(&mut line) {
                if bytes == 0 { break; }
                if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&lp) {
                    let _ = writeln!(f, "{}", line.trim_end());
                }
                line.clear();
            }
        });
    }

    // Capture stderr
    if let Some(stderr) = child.stderr.take() {
        let ep = err_path.to_path_buf();
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while let Ok(bytes) = reader.read_line(&mut line) {
                if bytes == 0 { break; }
                if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&ep) {
                    let _ = writeln!(f, "{}", line.trim_end());
                }
                line.clear();
            }
        });
    }

    // Detach: don't await the child here; let it run independently

    // Wait for server readiness by probing localhost:9000
    let client = reqwest::Client::new();
    let mut reachable = false;
    let mut attempts = 0;
    while attempts < 20 {
        let res = client.get("http://localhost:9000/api/torrent-search?q=ping").send().await;
        if let Ok(r) = res {
            if r.status().is_success() { reachable = true; break; }
        }
        attempts += 1;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if reachable {
        return Ok(true);
    }

    // If not reachable, include recent logs in error message and return failure
    let recent = tail_lines(log_path, 50).unwrap_or_default();
    let recent_err = tail_lines(err_path, 50).unwrap_or_default();
    let mut msg = String::from("server did not become reachable on port 9000");
    if !recent.is_empty() {
        msg.push_str("; recent stdout: \n");
        for l in recent.iter().rev().take(20) { msg.push_str(&format!("{}\n", l)); }
    }
    if !recent_err.is_empty() {
        msg.push_str("; recent stderr: \n");
        for l in recent_err.iter().rev().take(20) { msg.push_str(&format!("{}\n", l)); }
    }
    Err(msg)
}

// Helper: return last N lines of a file
fn tail_lines<P: AsRef<std::path::Path>>(p: P, n: usize) -> Option<Vec<String>> {
    let p = p.as_ref();
    if !p.exists() { return None; }
    if let Ok(s) = std::fs::read_to_string(p) {
        let mut lines: Vec<String> = s.lines().map(|l| l.to_string()).collect();
        if lines.len() > n { lines.drain(0..lines.len()-n); }
        return Some(lines);
    }
    None
}

// TorrentSearchArgs removed because it's unused; keep code simpler.

#[tauri::command]
async fn torrent_list_scrapers() -> Result<serde_json::Value, String> {
    // If the server is running, query its /api/torrent-search without q to infer providers
    let status = server_status().await.map_err(|e| e.to_string())?;
    if let Some(port) = status.port {
        let url = format!("http://localhost:{}/api/torrent-search?q=ping", port);
        let client = reqwest::Client::new();
        let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if res.status().is_success() {
            let body = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
            return Ok(body);
        }
    }
    Ok(serde_json::json!([]))
}

#[tauri::command]
async fn torrent_search(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    let status = server_status().await.map_err(|e| e.to_string())?;
    if let Some(port) = status.port {
        let query = opts.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let page = opts.get("page").and_then(|v| v.as_u64()).unwrap_or(1);
        let url = format!("http://localhost:{}/api/torrent-search?q={}&page={}", port, urlencoding::encode(query), page);
        let client = reqwest::Client::new();
        let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
        let body = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
        return Ok(body);
    }
    Err("Torrent server not running".into())
}

#[tauri::command]
async fn charts_get_weekly_tops(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    // Forward to configured URL or default
    let url = opts.get("url").and_then(|v| v.as_str()).unwrap_or("https://round-boat-07c7.gabrielgonzalez-gsun.workers.dev/");
    let client = reqwest::Client::new();
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    let body = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    Ok(body)
}

// Genius and Spotify proxies: lightweight wrappers that follow existing main.js behavior.
#[tauri::command]
async fn genius_search(query: String) -> Result<serde_json::Value, String> {
    let token = std::env::var("GENIUS_ACCESS_TOKEN").or_else(|_| std::env::var("VITE_GENIUS_ACCESS_TOKEN")).unwrap_or_default();
    if token.is_empty() { return Err("Missing Genius token".into()); }
    let url = format!("https://api.genius.com/search?{}", urlencoding::encode(&format!("q={}", query)));
    let client = reqwest::Client::new();
    let res = client.get(&url).header("Authorization", format!("Bearer {}", token)).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() { return Err(format!("HTTP {}", res.status())); }
    let body = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    Ok(body)
}

#[tauri::command]
async fn spotify_search(query: String, type_or_types: String) -> Result<serde_json::Value, String> {
    // If SPOTIFY_TOKEN_ENDPOINT is provided, call it to obtain a token, then call Spotify API.
    let token_endpoint = std::env::var("SPOTIFY_TOKEN_ENDPOINT").unwrap_or_else(|_| String::new());
    let token = if !token_endpoint.is_empty() {
        // POST or GET depending on server; try GET first
        let client = reqwest::Client::new();
        let res = client.get(&token_endpoint).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() { return Err("Token endpoint returned error".into()); }
        let js = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
        js.get("access_token").and_then(|v| v.as_str()).map(|s| s.to_string()).ok_or_else(|| "No access_token in response".to_string())?
    } else {
        return Err("No SPOTIFY_TOKEN_ENDPOINT configured".into());
    };

    // Build Spotify Web API search URL
    let types = type_or_types;
    let url = format!("https://api.spotify.com/v1/search?{}", urlencoding::encode(&format!("q={}&type={}&limit=20", query, types)));
    let client = reqwest::Client::new();
    let res = client.get(&url).header("Authorization", format!("Bearer {}", token)).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() { return Err(format!("HTTP {}", res.status())); }
    let body = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    Ok(body)
}

fn main() {
    // Initialize tokio runtime for async reqwest calls inside commands
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("failed to create tokio runtime");
    rt.block_on(async move {
        tauri::Builder::default()
            .invoke_handler(tauri::generate_handler![
            db_path,
            db_read,
            db_write,
            server_status,
            server_start,
            torrent_list_scrapers,
            torrent_search,
            charts_get_weekly_tops,
            genius_search,
            spotify_search
            ])
            .on_window_event(|window, _event| {
                // Use the provided window reference to emit maximize/unmaximize/minimize events.
                let is_max = window.is_maximized().unwrap_or(false);
                if is_max {
                    let _ = window.emit("window:maximize", true);
                } else {
                    let _ = window.emit("window:unmaximize", false);
                }
                if let Ok(minimized) = window.is_minimized() {
                    if minimized { let _ = window.emit("window:minimize", ()); }
                }
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    });
}
