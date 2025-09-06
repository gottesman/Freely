#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, State, Emitter};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::io::{BufRead, Write};
use std::time::Duration;
use base64::Engine;

struct WindowState {
    maximized: Mutex<bool>,
}

// A struct to hold all dynamically resolved paths.
// This will be managed by Tauri's state.
struct PathState {
    server_script: PathBuf,
    server_get_files: PathBuf,
    pid_file: PathBuf,
    log_file: PathBuf,
    err_file: PathBuf,
    db_file: PathBuf,
}

#[derive(Serialize, Deserialize, Clone)]
struct ServerPidInfo {
    pid: Option<u32>,
    port: Option<u16>,
}

// All commands now take a `State<'_, PathState>` argument to get the correct paths.
#[tauri::command]
async fn db_path(paths: State<'_, PathState>) -> Result<Option<String>, String> {
    Ok(Some(paths.db_file.to_string_lossy().to_string()))
}

#[tauri::command]
async fn db_read(paths: State<'_, PathState>) -> Result<Option<String>, String> {
    let db_path = &paths.db_file;
    if !db_path.exists() {
        return Ok(None);
    }
    let data = std::fs::read(db_path).map_err(|e| e.to_string())?;
    Ok(Some(base64::engine::general_purpose::STANDARD.encode(&data)))
}

#[tauri::command]
async fn db_write(base64_data: String, paths: State<'_, PathState>) -> Result<bool, String> {
    let db_path = &paths.db_file;
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&base64_data).map_err(|e| e.to_string())?;
    std::fs::write(db_path, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

// Internal helper that borrows PathState so callers can reuse the State without moving it.
async fn server_status_internal(paths: &PathState) -> Result<ServerPidInfo, String> {
    if !paths.pid_file.exists() {
        return Ok(ServerPidInfo { pid: None, port: None });
    }
    let raw = std::fs::read_to_string(&paths.pid_file).map_err(|e| e.to_string())?;

    // Safely parse the JSON instead of using unwrap_or_default
    let info: ServerPidInfo = match serde_json::from_str(&raw) {
        Ok(data) => data,
        Err(e) => {
            // The file is present but malformed. Log it and treat server as down.
            eprintln!("Failed to parse PID file: {}", e);
            return Ok(ServerPidInfo { pid: None, port: None });
        }
    };
    
    if let Some(p) = info.port {
        let url = format!("http://localhost:{}/ping", p);
        let res = reqwest::Client::new().get(&url)
            .timeout(Duration::from_millis(1500))
            .send().await;

        if res.is_ok() && res.unwrap().status().is_success() {
            // The server is alive and responding. Return the full info.
            return Ok(info);
        }
    }
    
    // If ping fails or port is missing, return what we have but with no active port.
    Ok(ServerPidInfo { pid: info.pid, port: None })
}

// Public Tauri command wrapper that takes ownership of State when invoked from JS.
#[tauri::command]
async fn server_status(paths: State<'_, PathState>) -> Result<ServerPidInfo, String> {
    server_status_internal(&paths).await
}

#[tauri::command]
async fn torrent_get_files(
    id: String,
    timeout_ms: Option<u64>,
    paths: State<'_, PathState>
) -> Result<serde_json::Value, serde_json::Value> {
    let timeout = timeout_ms.unwrap_or(20000);

    if !paths.server_get_files.exists() {
        return Err(serde_json::json!({
            "error": "path error",
            "msg": paths.server_get_files.display().to_string()
        }));
    }

    let output = Command::new("node")
        .arg(&paths.server_get_files)
        .arg(&id)
        .arg(timeout.to_string())
        .output()
        .map_err(|e| serde_json::json!({
            "error": "node error",
            "message": e.to_string()
        }))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(serde_json::json!({
            "error": "no success",
            "message": stderr.trim()
        }));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<serde_json::Value>(&stdout).map_err(|e| {
        serde_json::json!({
            "error": "bad json",
            "message": e.to_string(),
            "stdout": stdout
        })
    })
}


#[tauri::command]
async fn server_start(paths: State<'_, PathState>) -> Result<ServerPidInfo, String> {
    kill_server_process(paths.inner());

    let node_path = "C:\\Program Files\\nodejs\\node.exe";

    if !std::path::Path::new(node_path).exists() {
        return Err(format!("Node.js executable not found at hardcoded path: {}", node_path));
    }
    if !paths.server_script.exists() {
        return Err(format!("Server script not found at path: {}", paths.server_script.display()));
    }

    let server_script_dir = paths.server_script.parent().ok_or_else(|| "Could not get parent directory of server script".to_string())?;

    let mut cmd = Command::new(node_path);
    cmd.arg(&paths.server_script)
       .env("PID_FILE_PATH", &paths.pid_file)
       .current_dir(server_script_dir)
       .stdin(Stdio::null())
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    
    let mut child = cmd.spawn().map_err(|e| format!("CRITICAL SPAWN FAILED: {}", e))?;
    let pid = child.id();

    if let Some(stdout) = child.stdout.take() {
        let log_file = paths.log_file.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_file) {
                for line in reader.lines().filter_map(|l| l.ok()) {
                    // --- THIS IS THE FIX ---
                    // The macro is called directly, without the `std::io::` prefix.
                    let _ = writeln!(f, "{}", line);
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let err_file = paths.err_file.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&err_file) {
                for line in reader.lines().filter_map(|l| l.ok()) {
                    // --- THIS IS THE FIX ---
                    // The macro is called directly, without the `std::io::` prefix.
                    let _ = writeln!(f, "{}", line);
                }
            }
        });
    }

    // Polling logic remains the same
    let mut attempts = 0;
    while attempts < 20 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(status) = server_status_internal(paths.inner()).await {
            if status.port.is_some() {
                return Ok(ServerPidInfo { pid: Some(pid), port: status.port });
            }
        }
        attempts += 1;
    }

    let _ = child.kill();
    Err("Server did not start responding in time.".into())
}

fn kill_server_process(paths: &PathState) {
    if !paths.pid_file.exists() { return; }
    if let Ok(raw) = std::fs::read_to_string(&paths.pid_file) {
        if let Ok(js) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(pid) = js.get("pid").and_then(|p| p.as_u64()) {
                let pid_str = pid.to_string();
                println!("Killing server process {}", pid_str);
                #[cfg(target_os = "windows")]
                {
                    let _ = Command::new("taskkill").args(["/PID", &pid_str, "/T", "/F"]).output();
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = Command::new("kill").arg("-9").arg(&pid_str).output();
                }
            }
        }
    }
    let _ = std::fs::remove_file(&paths.pid_file);
}

// Your other commands remain largely the same, as they don't depend on local file paths.
#[tauri::command]
async fn torrent_list_scrapers(paths: State<'_, PathState>) -> Result<serde_json::Value, String> {
    let status = server_status(paths).await?;
    if let Some(port) = status.port {
        let url = format!("http://localhost:{}/ping", port);
        let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let body = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    return Ok(body);
    }
    Ok(serde_json::json!([]))
}

#[tauri::command]
async fn charts_get_weekly_tops(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    let endpoint = std::env::var("CHARTS_SPOTIFY_ENDPOINT").map_err(|_| "Missing charts endpoint")?;
    let url = opts.get("url").and_then(|v| v.as_str()).unwrap_or(endpoint.as_str());
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    Ok(resp.json().await.map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn genius_search(query: String) -> Result<serde_json::Value, String> {
    let token = std::env::var("GENIUS_ACCESS_TOKEN").map_err(|_| "Missing Genius token")?;
    let url = format!("https://api.genius.com/search?q={}", urlencoding::encode(&query));
    let client = reqwest::Client::new();
    let res = client.get(&url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    Ok(res.json().await.map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn spotify_search(query: String, type_or_types: String) -> Result<serde_json::Value, String> {
    let token_endpoint = std::env::var("SPOTIFY_TOKEN_ENDPOINT").map_err(|_| "No SPOTIFY_TOKEN_ENDPOINT configured")?;
    let token_res: serde_json::Value = reqwest::get(&token_endpoint).await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let token = token_res["access_token"].as_str().ok_or("No access_token in response")?;

    let url = format!("https://api.spotify.com/v1/search?q={}&type={}&limit=20", urlencoding::encode(&query), type_or_types);
    let client = reqwest::Client::new();
    let res = client.get(&url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    Ok(res.json().await.map_err(|e| e.to_string())?)
}


fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Resolve all necessary paths once at startup.
            let resource_dir = app.path().resource_dir().expect("Failed to find resource directory");
            let app_log_dir = app.path().app_log_dir().expect("Failed to find app log directory");
            if !app_log_dir.exists() {
                std::fs::create_dir_all(&app_log_dir)?;
            }
            let app_config_dir = app.path().app_config_dir().expect("Failed to find app config directory");
            if !app_config_dir.exists() {
                std::fs::create_dir_all(&app_config_dir)?;
            }

            //let server_dir = resource_dir.join("server");

            let paths = PathState {
                server_script: resource_dir.join("server-dist").join("server.bundle.js"),
                server_get_files: resource_dir.join("server-dist").join("torrent-get-files.js"),
                
                pid_file: app_config_dir.join(".server.pid"),
                log_file: app_log_dir.join("server.log"),
                err_file: app_log_dir.join("server.err.log"),
                db_file: app_config_dir.join("freely.db"),
            };

            app.manage(paths);            

            let window = app.handle().get_webview_window("main").unwrap();

            let initial_maximized = window.is_maximized().unwrap_or(false);
            app.manage(WindowState {
                maximized: Mutex::new(initial_maximized),
            });

            
            let app_handle = app.handle().clone();
            // Start the server in a non-blocking background task.
            tauri::async_runtime::spawn(async move {
                let paths_state = app_handle.state::<PathState>();
                match server_start(paths_state).await {
                    Ok(status) => println!("Torrent server started on localhost:{}", status.port.unwrap_or(0)),
                    Err(e) => eprintln!("Failed to start torrent server: {}", e),
                }
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_path,
            db_read,
            db_write,
            server_status,
            server_start,
            torrent_list_scrapers,
            source_search,
            youtube_get_info,
            charts_get_weekly_tops,
            genius_search,
            spotify_search,
            torrent_get_files
        ])
        .on_window_event(|window, event| {
            // -- THIS IS THE CORRECTED EVENT HANDLER LOGIC --
            match event {
                tauri::WindowEvent::Resized(_) => {
                    let window_state = window.state::<WindowState>();
                    let mut maximized = window_state.maximized.lock().unwrap();
                    let new_maximized_state = window.is_maximized().unwrap_or(false);

                    // Only emit an event if the state has actually changed.
                    if *maximized != new_maximized_state {
                        *maximized = new_maximized_state;
                        if new_maximized_state {
                            let _ = window.emit("window:maximize", true);
                        } else {
                            let _ = window.emit("window:unmaximize", false);
                        }
                    }
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    // This part was already correct.
                    let paths = window.app_handle().state::<PathState>();
                    kill_server_process(&paths);
                }
                _ => {} // Ignore all other events
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceSearchPayload {
    query: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    year: Option<String>,
    page: Option<u64>,
    limit: Option<u64>,
    debug: Option<bool>,
    force: Option<bool>,
    r#type: Option<String>,
}

#[tauri::command]
async fn source_search(
    payload: SourceSearchPayload,
    paths: State<'_, PathState>,
) -> Result<serde_json::Value, String> {
    let page = payload.page.unwrap_or(1);
    let limit = payload.limit.unwrap_or(20);

    let status = server_status(paths).await?;
    if let Some(port) = status.port {
        // Build query string from provided fields (skip empty)
        let mut params: Vec<String> = Vec::new();

        if let Some(q) = payload.query.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            params.push(format!("q={}", urlencoding::encode(q)));
        }
        if let Some(t) = payload.title
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty()) {
            params.push(format!("title={}", urlencoding::encode(t)));
        }
        if let Some(a) = payload.artist.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            params.push(format!("artist={}", urlencoding::encode(a)));
        }
        if let Some(y) = payload.year.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            params.push(format!("year={}", urlencoding::encode(y)));
        }

        params.push(format!("page={}", page));
        params.push(format!("limit={}", limit));

        if let Some(d) = payload.debug {
            if d { params.push("debug=1".to_string()); }
        }
        if let Some(f) = payload.force {
            if f { params.push("force=1".to_string()); }
        }
        if let Some(type_filter) = payload.r#type.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            params.push(format!("type={}", urlencoding::encode(type_filter)));
        }

        let qs = params.join("&");
        let url = if qs.is_empty() {
            format!("http://localhost:{}/api/source-search", port)
        } else {
            format!("http://localhost:{}/api/source-search?{}", port, qs)
        };

    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let body = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
    return Ok(body);
    }

    Err("Server not running".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeInfoPayload {
    id: String,
    #[serde(default)]
    debug: bool,
    #[serde(default)]
    force: bool,
}

#[tauri::command]
async fn youtube_get_info(
    payload: YoutubeInfoPayload,
    paths: State<'_, PathState>,
) -> Result<serde_json::Value, String> {
    let status = server_status(paths.clone()).await?;
    if let Some(port) = status.port {
        let mut params: Vec<String> = Vec::new();
        params.push(format!("id={}", urlencoding::encode(&payload.id)));
        params.push("get=info".into());
        if payload.debug { params.push("debug=1".into()); }
        if payload.force { params.push("forceInfo=1".into()); }
        let qs = params.join("&");
        let url = format!("http://localhost:{}/source/youtube?{}", port, qs);
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let mut body = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
        // Inject a local stream URL for convenience (proxies through backend avoiding CORS)
        if let serde_json::Value::Object(ref mut map) = body {
            map.insert("streamUrl".into(), serde_json::Value::String(format!("http://localhost:{}/source/youtube?id={}&get=stream", port, urlencoding::encode(&payload.id))));
        }
        return Ok(body);
    }
    Err("Server not running".into())
}