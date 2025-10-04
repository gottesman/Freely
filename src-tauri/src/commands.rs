use crate::paths::PathConfig;
// logging macros available globally
use base64::Engine;
use serde::Deserialize;
use tauri::State;
use crate::youtube as yt;

/// Database operations
pub mod db {
    use super::*;
    #[tauri::command]
    pub async fn db_path(config: State<'_, PathConfig>) -> Result<String, String> {
        let db_file = config.app_config_dir.join("freely.db");
        Ok(db_file.to_string_lossy().to_string())
    }
    #[tauri::command]
    pub async fn db_read(config: State<'_, PathConfig>) -> Result<Option<String>, String> {
        let db_file = config.app_config_dir.join("freely.db");
        if !db_file.exists() {
            return Ok(None);
        }

        let data =
            std::fs::read(&db_file).map_err(|e| format!("Failed to read database: {}", e))?;

        Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(&data),
        ))
    }

    #[tauri::command]
    pub async fn db_write(
        base64_data: String,
        config: State<'_, PathConfig>,
    ) -> Result<bool, String> {
        // Ensure parent directory exists
        let db_file = config.app_config_dir.join("freely.db");
        if let Some(parent) = db_file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create database directory: {}", e))?;
        }

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_data)
            .map_err(|e| format!("Invalid base64 data: {}", e))?;

        std::fs::write(&db_file, bytes)
            .map_err(|e| format!("Failed to write database: {}", e))?;

        Ok(true)
    }
}

/// Torrent operations
pub mod torrent {
    use super::*;
    use crate::torrents::{get_engine, engine_progress, register_download, unregister_download, ensure_progress_loop, ProgressData, TorrentFileInfo};
    use tokio::time::{timeout, Duration};
    use serde_json::json;

    #[tauri::command]
    pub async fn torrent_get_files(id: String, timeout_ms: Option<u64>, _config: State<'_, PathConfig>) -> Result<serde_json::Value, serde_json::Value> {
        let engine = get_engine();
        let to_ms = timeout_ms.unwrap_or(20_000);
        let id_clone = id.clone();
        let fut = tokio::task::spawn_blocking(move || engine.list_files(&id_clone));
        match timeout(Duration::from_millis(to_ms), fut).await {
            Ok(join_res) => match join_res {
                Ok(Ok(files)) => Ok(json!({ "status": "ok", "data": files.into_iter().map(|f: TorrentFileInfo| json!({ "index": f.index, "name": f.name, "length": f.length })).collect::<Vec<_>>() })),
                Ok(Err(e)) => Err(json!({ "error": "list_files_failed", "message": e })),
                Err(join_err) => Err(json!({ "error": "internal", "message": format!("join error: {}", join_err) })),
            },
            Err(_) => Err(json!({ "error": "timeout", "message": format!("Timeout after {} ms", to_ms) })),
        }
    }

    #[tauri::command]
    pub async fn torrent_pause(id: String) -> Result<serde_json::Value, String> {
        let id_clone = id.clone();
        let res = tokio::task::spawn_blocking(move || get_engine().pause(&id_clone)).await.map_err(|e| format!("join error: {e}"))?;
        res.map(|_| json!({"status":"ok"}))
    }
    #[tauri::command]
    pub async fn torrent_resume(id: String) -> Result<serde_json::Value, String> {
        let id_clone = id.clone();
        let res = tokio::task::spawn_blocking(move || get_engine().resume(&id_clone)).await.map_err(|e| format!("join error: {e}"))?;
        res.map(|_| json!({"status":"ok"}))
    }

    #[tauri::command]
    pub async fn torrent_remove(id: String, remove_data: bool) -> Result<serde_json::Value, String> {
        let id_clone = id.clone();
        let res = tokio::task::spawn_blocking(move || get_engine().remove(&id_clone, remove_data)).await.map_err(|e| format!("join error: {e}"))?;
        let res = res.map(|_| json!({"status":"ok"}));
        unregister_download(&id);
        res
    }

    #[tauri::command]
    pub async fn torrent_start_download(app: tauri::AppHandle, magnet: String, index: u32, config: State<'_, PathConfig>) -> Result<serde_json::Value, String> {
        let dir = &config.torrents_dir;
        let magnet_clone = magnet.clone();
        let dir_clone = dir.clone();
        let result = tokio::task::spawn_blocking(move || get_engine().start_download(&magnet_clone, index, &dir_clone))
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map(|_| json!({"status":"ok"}));
        if result.is_ok() { register_download(&app, &magnet, index); ensure_progress_loop(&app); }
        result
    }

    #[tauri::command]
    pub async fn torrent_progress(hash_or_magnet: String, index: u32) -> Result<serde_json::Value, String> {
        let key = hash_or_magnet.clone();
        let res = tokio::task::spawn_blocking(move || engine_progress(&key, index)).await.map_err(|e| format!("join error: {e}"))?;
        match res {
            Ok(ProgressData { bytes, verified_bytes, on_disk_bytes, total, peers, down_speed }) => Ok(json!({"status":"ok","data": {"bytes": bytes, "verifiedBytes": verified_bytes, "onDiskBytes": on_disk_bytes, "total": total, "peers": peers, "downSpeed": down_speed }})),
            Err(e) => Err(e)
        }
    }

    #[tauri::command]
    pub async fn torrent_get_file_path(hash_or_magnet: String, index: u32, config: State<'_, PathConfig>) -> Result<String, String> {
        let key = hash_or_magnet.clone();
        let dir = config.torrents_dir.clone();
        let p = tokio::task::spawn_blocking(move || get_engine().file_path(&key, index, &dir)).await.map_err(|e| format!("join error: {e}"))??;
        Ok(p.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub async fn torrent_list_scrapers(config: State<'_, PathConfig>) -> Result<serde_json::Value, String> { Ok(serde_json::json!(crate::plugins::list_public_info(&config))) }

    #[derive(Deserialize)]
    pub struct TorrentSearchPayload { pub query: String, #[serde(default)] pub provider: Option<String>, }
    #[tauri::command]
    pub async fn torrent_search(payload: TorrentSearchPayload, config: State<'_, PathConfig>) -> Result<serde_json::Value, String> {
        let provider = payload.provider.as_deref();
        let items = crate::plugins::search_plugins(&config, &payload.query, provider).await.map_err(|e| format!("search failed: {e}"))?;
        Ok(json!(items))
    }
}

/// Search operations
pub mod search {
    use super::*;
    use tokio::process::Command;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    pub struct SourceSearchPayload {
        pub title: Option<String>,
        pub artist: Option<String>,
        pub r#type: Option<String>,
    }

    #[tauri::command]
    pub async fn source_search(
        payload: SourceSearchPayload,
        config: State<'_, PathConfig>,
    ) -> Result<serde_json::Value, String> {
        let q_title = payload.title.unwrap_or_default();
        let q_artist = payload.artist.unwrap_or_default();
        let q = [q_title.trim(), q_artist.trim()]
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");

        let ty = payload.r#type.unwrap_or_default();

        if ty.eq_ignore_ascii_case("youtube") {
            let query = if q.is_empty() { "".to_string() } else { format!("ytsearch10:{}", q) };
            let args = if query.is_empty() { vec!["-J", "--flat-playlist", "https://www.youtube.com"] } else { vec!["-J", "--flat-playlist", &query] };
            let text = yt::execute_ytdlp(&args, &config)?;
            let json: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("Bad yt-dlp JSON: {}", e))?;

            // Normalize results to a simple array of { type, id, title, duration }
            let mut items: Vec<serde_json::Value> = Vec::new();
            if let Some(entries) = json.get("entries").and_then(|e| e.as_array()) {
                for e in entries {
                    let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if id.is_empty() { continue; }
                    let title = e.get("title").and_then(|v| v.as_str()).unwrap_or("");
                    let duration = e.get("duration").and_then(|v| v.as_u64()).unwrap_or(0);
                    items.push(serde_json::json!({
                        "type": "youtube",
                        "id": id,
                        "title": title,
                        "duration": duration,
                    }));
                }
            }
            return Ok(serde_json::json!(items));
        }

        if ty.eq_ignore_ascii_case("torrents") || ty.eq_ignore_ascii_case("torrent") {
            // No HTTP server; until the torrent engine exposes search, return empty list.
            return Ok(serde_json::json!([]));
        }

        // Unknown type -> empty
        Ok(serde_json::json!([]))
    }
}

/// Plugin management
pub mod plugins_api {
    use super::*;
    use serde_json::json;
    // no per-plugin disabled.json map; enabled state is stored in index.json
    use std::fs;
    use std::io::{Cursor, Read, Write};
    use std::path::{Path, PathBuf};

    #[derive(Deserialize)]
    pub struct SetEnabledPayload { pub name: String, pub enabled: bool }

    fn ensure_dir(p: &Path) -> Result<(), String> {
        if let Some(parent) = p.parent() { fs::create_dir_all(parent).map_err(|e| format!("create dir failed: {}", e))?; }
        Ok(())
    }

    // Read minimal manifest fields from a plugin directory
    fn read_manifest_fields(dir: &Path) -> Option<(String, String)> {
        let manifest = dir.join("manifest.json");
        if !manifest.exists() { return None; }
        let s = fs::read_to_string(&manifest).ok()?;
        let v: serde_json::Value = serde_json::from_str(&s).ok()?;
        let name = v.get("name").and_then(|v| v.as_str())
            .or_else(|| dir.file_name().and_then(|n| n.to_str()))
            .unwrap_or("").to_string();
        let version = v.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
        Some((name, version))
    }

    // Ensure user plugins index.json matches actual filesystem state and merges overrides
    fn ensure_user_index_sync(config: &PathConfig) -> Result<(), String> {
        let user_plugins = config.app_config_dir.join("plugins");
        fs::create_dir_all(&user_plugins).map_err(|e| format!("plugins dir: {}", e))?;
        let index_path = user_plugins.join("index.json");
        let mut entries: Vec<serde_json::Value> = if index_path.exists() {
            serde_json::from_str(&fs::read_to_string(&index_path).unwrap_or("[]".to_string())).unwrap_or_default()
        } else { vec![] };

        // Build quick lookups
        let mut install_idx_by_dir: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut override_idx_by_name: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (i, e) in entries.iter().enumerate() {
            let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let dir = e.get("directory").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !dir.is_empty() { install_idx_by_dir.insert(dir, i); }
            else if !name.is_empty() { override_idx_by_name.insert(name, i); }
        }

        // Scan filesystem for plugin folders (with manifest.json)
        let mut fs_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Ok(rd) = fs::read_dir(&user_plugins) {
            for ent in rd.flatten() {
                let path = ent.path();
                if path.is_dir() {
                    if let Some(dir_name) = path.file_name().and_then(|n| n.to_str()).map(|s| s.to_string()) {
                        if path.join("manifest.json").exists() {
                            fs_dirs.insert(dir_name.clone());
                            let (mf_name, mf_version) = read_manifest_fields(&path).unwrap_or((dir_name.clone(), String::new()));
                            if let Some(&idx) = install_idx_by_dir.get(&dir_name) {
                                if let Some(obj) = entries[idx].as_object_mut() {
                                    obj.insert("name".into(), serde_json::json!(mf_name));
                                    obj.insert("version".into(), serde_json::json!(mf_version));
                                    obj.insert("directory".into(), serde_json::json!(dir_name));
                                    if !obj.contains_key("enabled") { obj.insert("enabled".into(), serde_json::json!(true)); }
                                }
                            } else {
                                // Merge override row (enabled) if present
                                let mut enabled_val = true;
                                if let Some(&ov_idx) = override_idx_by_name.get(&mf_name) {
                                    if let Some(b) = entries[ov_idx].get("enabled").and_then(|v| v.as_bool()) { enabled_val = b; }
                                    entries.remove(ov_idx);
                                    // Rebuild maps after removal
                                    install_idx_by_dir.clear();
                                    override_idx_by_name.clear();
                                    for (i2, e2) in entries.iter().enumerate() {
                                        let name2 = e2.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        let dir2 = e2.get("directory").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                        if !dir2.is_empty() { install_idx_by_dir.insert(dir2, i2); }
                                        else if !name2.is_empty() { override_idx_by_name.insert(name2, i2); }
                                    }
                                }
                                entries.push(serde_json::json!({
                                    "name": mf_name,
                                    "version": mf_version,
                                    "directory": dir_name,
                                    "enabled": enabled_val
                                }));
                            }
                        }
                    }
                }
            }
        }

        // Drop install rows whose directories are gone
        entries.retain(|e| {
            if let Some(dir) = e.get("directory").and_then(|v| v.as_str()) {
                return fs_dirs.contains(dir);
            }
            true
        });

        // Sort by name for stability
        entries.sort_by(|a, b| {
            let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            an.cmp(&bn)
        });

        ensure_dir(&index_path)?;
        fs::write(&index_path, serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?)
            .map_err(|e| format!("write index: {}", e))?;
        Ok(())
    }

    // removed disabled.json helpers; index.json holds enabled flags

    #[tauri::command]
    pub async fn plugins_list(config: State<'_, PathConfig>) -> Result<serde_json::Value, String> {
        let _ = ensure_user_index_sync(&config);
        let items = crate::plugins::list_public_info(&config);
        Ok(json!(items))
    }

    #[tauri::command]
    pub async fn plugins_set_enabled(payload: SetEnabledPayload, config: State<'_, PathConfig>) -> Result<serde_json::Value, String> {
        // Update or create an override entry in user plugins index.json with "enabled" flag
        let user_plugins = config.app_config_dir.join("plugins");
        let index_path = user_plugins.join("index.json");
        ensure_dir(&index_path)?;
        let mut arr: Vec<serde_json::Value> = if index_path.exists() {
            serde_json::from_str(&std::fs::read_to_string(&index_path).unwrap_or("[]".to_string())).unwrap_or_default()
        } else { vec![] };
        let mut found = false;
        for e in arr.iter_mut() {
            if e.get("name").and_then(|v| v.as_str()) == Some(payload.name.as_str()) {
                if let Some(obj) = e.as_object_mut() {
                    obj.insert("enabled".to_string(), serde_json::json!(payload.enabled));
                }
                found = true;
            }
        }
        if !found {
            arr.push(serde_json::json!({
                "name": payload.name,
                "enabled": payload.enabled
            }));
        }
        let new_s = serde_json::to_string_pretty(&arr).map_err(|e| e.to_string())?;
        std::fs::write(&index_path, new_s).map_err(|e| format!("write index failed: {}", e))?;
        Ok(json!({"status":"ok"}))
    }

    #[tauri::command]
    pub async fn plugins_delete(name: String, config: State<'_, PathConfig>) -> Result<serde_json::Value, String> {
        // Remove plugin folder under user app_config/plugins/{name}
        let user_plugins = config.app_config_dir.join("plugins");
        let candidate = user_plugins.join(&name);
        if candidate.exists() {
            fs::remove_dir_all(&candidate).map_err(|e| format!("remove failed: {}", e))?;
        }
        // Also update user index.json in user dir: remove the install entry for this plugin,
        // but preserve an override row when enabled=false to keep the disabled state for bundled plugin.
        let index_path = user_plugins.join("index.json");
        if index_path.exists() {
            if let Ok(s) = fs::read_to_string(&index_path) {
                if let Ok(mut arr) = serde_json::from_str::<Vec<serde_json::Value>>(&s) {
                    // Determine current enabled state (default true)
                    let mut currently_enabled = true;
                    for e in arr.iter() {
                        if e.get("name").and_then(|v| v.as_str()) == Some(&name) {
                            if let Some(b) = e.get("enabled").and_then(|v| v.as_bool()) { currently_enabled = b; }
                        }
                    }
                    // Remove all rows that indicate a user install for this plugin (directory == name)
                    arr.retain(|e| {
                        let is_same = e.get("name").and_then(|v| v.as_str()) == Some(&name);
                        let is_install_row = e.get("directory").and_then(|v| v.as_str()) == Some(&name);
                        !(is_same && is_install_row)
                    });
                    // If it was disabled, ensure an override row remains with enabled=false
                    if !currently_enabled {
                        let mut has_override = false;
                        for e in arr.iter_mut() {
                            if e.get("name").and_then(|v| v.as_str()) == Some(&name) {
                                if let Some(obj) = e.as_object_mut() {
                                    obj.insert("enabled".to_string(), serde_json::json!(false));
                                }
                                has_override = true;
                            }
                        }
                        if !has_override {
                            arr.push(serde_json::json!({ "name": name, "enabled": false }));
                        }
                    } else {
                        // If it was enabled, and no other entries remain for this plugin, that's fine.
                    }
                    let new_s = serde_json::to_string_pretty(&arr).map_err(|e| e.to_string())?;
                    fs::write(&index_path, new_s).map_err(|e| format!("write index failed: {}", e))?;
                }
            }
        }
        // Resync to ensure no stale or missing entries remain
        let _ = ensure_user_index_sync(&config);
        Ok(json!({"status":"ok"}))
    }

    #[derive(Deserialize)]
    pub struct InstallZipPayload { pub base64_zip: String }

    #[tauri::command]
    pub async fn plugins_install_zip(payload: InstallZipPayload, config: State<'_, PathConfig>) -> Result<serde_json::Value, String> {
        // Decode zip
        let bytes = base64::engine::general_purpose::STANDARD.decode(&payload.base64_zip).map_err(|e| format!("invalid base64: {}", e))?;
        // Extract to a temp dir
    let temp_dir = std::env::temp_dir().join("freely-plugin-import");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).map_err(|e| format!("tmp dir: {}", e))?;

        // Use zip crate for extraction
        let reader = Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("bad zip: {}", e))?;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| format!("zip entry: {}", e))?;
            let out_path = temp_dir.join(file.name());
            if file.is_dir() {
                fs::create_dir_all(&out_path).map_err(|e| format!("mkdir: {}", e))?;
            } else {
                if let Some(parent) = out_path.parent() { fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?; }
                let mut out = fs::File::create(&out_path).map_err(|e| format!("create: {}", e))?;
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).map_err(|e| format!("read: {}", e))?;
                out.write_all(&buf).map_err(|e| format!("write: {}", e))?;
            }
        }

        // Find manifest.json (allow nested single folder root)
        fn find_manifest(root: &Path) -> Option<PathBuf> {
            let p = root.join("manifest.json");
            if p.exists() { return Some(p); }
            if let Ok(entries) = fs::read_dir(root) {
                let mut only: Option<PathBuf> = None;
                for e in entries.flatten() {
                    let path = e.path();
                    if path.is_dir() {
                        if only.is_none() { only = Some(path); } else { return None; }
                    }
                }
                if let Some(dir) = only { let pp = dir.join("manifest.json"); if pp.exists() { return Some(pp); } }
            }
            None
        }

        let manifest_path = find_manifest(&temp_dir).ok_or("manifest.json not found in zip")?;
        let manifest_str = fs::read_to_string(&manifest_path).map_err(|e| format!("manifest read: {}", e))?;
        let manifest_json: serde_json::Value = serde_json::from_str(&manifest_str).map_err(|e| format!("manifest parse: {}", e))?;
        let plugin_name = manifest_json.get("name").and_then(|v| v.as_str()).ok_or("manifest missing name")?.to_string();
        let version = manifest_json.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0").to_string();

        // Move extracted content to user plugins dir under {name}/
        let dest_root = config.app_config_dir.join("plugins");
        fs::create_dir_all(&dest_root).map_err(|e| format!("plugins dir: {}", e))?;
        let dest = dest_root.join(&plugin_name);
        if dest.exists() { fs::remove_dir_all(&dest).map_err(|e| format!("remove old: {}", e))?; }
        // Move all files from temp_dir/(single folder or root) into dest
        let copy_root = manifest_path.parent().unwrap_or(&temp_dir);
        // Ensure manifest is at dest/manifest.json
        fs::create_dir_all(&dest).map_err(|e| format!("mkdir dest: {}", e))?;
        let mut stack = vec![copy_root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).map_err(|e| format!("readdir: {}", e))? {
                let entry = entry.map_err(|e| format!("dirent: {}", e))?;
                let path = entry.path();
                let rel = path.strip_prefix(copy_root).unwrap_or(&path);
                let out = dest.join(rel);
                if path.is_dir() {
                    fs::create_dir_all(&out).map_err(|e| format!("mkdir: {}", e))?;
                    stack.push(path);
                } else {
                    if let Some(parent) = out.parent() { fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?; }
                    fs::copy(&path, &out).map_err(|e| format!("copy: {}", e))?;
                }
            }
        }

        // Update user index.json (new schema: name, version, directory, enabled)
        let index_path = dest_root.join("index.json");
        let mut entries: Vec<serde_json::Value> = if index_path.exists() {
            serde_json::from_str(&fs::read_to_string(&index_path).unwrap_or("[]".to_string())).unwrap_or_default()
        } else { vec![] };
        // Remove existing by name, then add
        entries.retain(|e| e.get("name").and_then(|v| v.as_str()) != Some(plugin_name.as_str()));
        entries.push(json!({
            "name": plugin_name,
            "version": version,
            "directory": plugin_name,
            "enabled": true
        }));
        fs::write(&index_path, serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?).map_err(|e| format!("write index: {}", e))?;

        // Cleanup temp
        let _ = fs::remove_dir_all(&temp_dir);

        // Resync index.json so filesystem and index stay consistent
        let _ = ensure_user_index_sync(&config);

        Ok(json!({"status":"ok"}))
    }

    #[tauri::command]
    pub async fn plugins_script_sources(config: State<'_, PathConfig>) -> Result<serde_json::Value, String> {
        let arr = crate::plugins::list_script_sources(&config);
        Ok(serde_json::json!(arr))
    }
}

/// YouTube operations
pub mod youtube {
    use super::*;

    #[derive(Deserialize)]
    pub struct YoutubeInfoPayload {
        pub id: String,
        #[serde(default)]
        pub debug: bool,
        #[serde(default)]
        pub force: bool,
    }

    #[tauri::command]
    pub async fn youtube_get_info(
        payload: YoutubeInfoPayload,
        config: State<'_, PathConfig>,
    ) -> Result<serde_json::Value, String> {
        let data = yt::get_info(&payload.id, &config).await?;
        Ok(serde_json::json!({ "status": "ok", "data": data }))
    }

    #[tauri::command]
    pub async fn youtube_get_stream_url(
        id: String,
        config: State<'_, PathConfig>,
    ) -> Result<serde_json::Value, String> {
        let url = yt::get_stream_url(&id, &config).await?;
        Ok(serde_json::json!({ "status": "ok", "data": { "url": url } }))
    }
}

// (No additional filesystem commands here)

/// External API operations
pub mod external {

    #[tauri::command]
    pub async fn charts_get_weekly_tops(
        opts: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let endpoint = std::env::var("CHARTS_SPOTIFY_ENDPOINT")
            .map_err(|_| "CHARTS_SPOTIFY_ENDPOINT not configured")?;

        let url = opts
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or(&endpoint);

        reqwest::get(url)
            .await
            .map_err(|e| format!("Charts request failed: {}", e))?
            .json()
            .await
            .map_err(|e| format!("Failed to parse charts response: {}", e))
    }

    #[tauri::command]
    pub async fn genius_search(query: String) -> Result<serde_json::Value, String> {
        let token = std::env::var("GENIUS_ACCESS_TOKEN")
            .map_err(|_| "GENIUS_ACCESS_TOKEN not configured")?;

        let url = format!(
            "https://api.genius.com/search?q={}",
            urlencoding::encode(&query)
        );

        reqwest::Client::new()
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("Genius request failed: {}", e))?
            .json()
            .await
            .map_err(|e| format!("Failed to parse Genius response: {}", e))
    }

    #[tauri::command]
    pub async fn spotify_search(
        query: String,
        type_or_types: String,
    ) -> Result<serde_json::Value, String> {
        let token_endpoint = std::env::var("SPOTIFY_TOKEN_ENDPOINT")
            .map_err(|_| "SPOTIFY_TOKEN_ENDPOINT not configured")?;

        // Get access token
        let token_response: serde_json::Value = reqwest::get(&token_endpoint)
            .await
            .map_err(|e| format!("Failed to get Spotify token: {}", e))?
            .json()
            .await
            .map_err(|e| format!("Failed to parse token response: {}", e))?;

        let token = token_response["access_token"]
            .as_str()
            .ok_or("No access_token in response")?;

        // Perform search
        let url = format!(
            "https://api.spotify.com/v1/search?q={}&type={}&limit=20",
            urlencoding::encode(&query),
            type_or_types
        );

        reqwest::Client::new()
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("Spotify search failed: {}", e))?
            .json()
            .await
            .map_err(|e| format!("Failed to parse Spotify response: {}", e))
    }

    #[tauri::command]
    pub async fn musixmatch_fetch_lyrics(
        title: String,
        artist: String,
        config: tauri::State<'_, crate::paths::PathConfig>,
    ) -> Result<serde_json::Value, String> {
        use sha2::{Digest, Sha256};
        use std::fs;
        use std::path::PathBuf;

        // Normalize a string for cache key (lowercase, collapse whitespace)
        fn norm(s: &str) -> String {
            s.to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        }

        // Compute cache file path under app config dir
        let base_dir: PathBuf = config
            .app_config_dir
            .join("lyrics_cache");
        let key = format!("v1|musixmatch|{}|{}", norm(&title), norm(&artist));
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        let hash_hex = format!("{:x}", hasher.finalize());
        let file_path = base_dir.join(format!("{}.json", hash_hex));

        // Try cache first
        if let Ok(data) = fs::read_to_string(&file_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&data) {
                return Ok(json);
            }
        }
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, USER_AGENT};

        // Build client with browser-like headers + cookies (as used by onetagger)
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/plain, */*"),
        );
        headers.insert(
            HeaderName::from_static("accept-language"),
            HeaderValue::from_static("en-US,en;q=0.9"),
        );
        headers.insert(
            HeaderName::from_static("origin"),
            HeaderValue::from_static("https://www.musixmatch.com"),
        );
        headers.insert(
            HeaderName::from_static("referer"),
            HeaderValue::from_static("https://www.musixmatch.com/"),
        );
        headers.insert(
            HeaderName::from_static("cookie"),
            HeaderValue::from_static("AWSELBCORS=0; AWSELB=0"),
        );
        headers.insert(
            HeaderName::from_static("x-requested-with"),
            HeaderValue::from_static("XMLHttpRequest"),
        );
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        // Simple redirect-following GET -> JSON helper (limit 5 hops)
        async fn get_json_follow_redirects(
            client: &reqwest::Client,
            mut url: reqwest::Url,
        ) -> Result<serde_json::Value, String> {
            let mut hops = 0usize;
            loop {
                let resp = client
                    .get(url.clone())
                    .send()
                    .await
                    .map_err(|e| format!("request failed: {}", e))?;
                if resp.status().is_redirection() {
                    if hops >= 5 {
                        return Err("too many redirects".into());
                    }
                    let location = resp
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .ok_or_else(|| "redirect without Location".to_string())?;
                    // Build next URL relative to previous
                    url = url
                        .join(location)
                        .map_err(|e| format!("redirect URL join failed: {}", e))?;
                    hops += 1;
                    continue;
                }
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                return resp
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|e| format!("response parse failed: {}", e));
            }
        }

        async fn get_token(client: &reqwest::Client) -> Result<String, String> {
            let mut url =
                reqwest::Url::parse("https://apic-desktop.musixmatch.com/ws/1.1/token.get")
                    .map_err(|e| format!("URL parse error: {}", e))?;
            let t_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "SystemTime before UNIX_EPOCH".to_string())?
                .as_millis()
                .to_string();
            url.query_pairs_mut()
                .append_pair("user_language", "en")
                .append_pair("app_id", "web-desktop-app-v1.0")
                .append_pair("t", &t_ms);
            let resp = get_json_follow_redirects(client, url)
                .await
                .map_err(|e| format!("Musixmatch token request failed: {}", e))?;
            let status = resp["message"]["header"]["status_code"]
                .as_i64()
                .unwrap_or(0);
            if status == 401 {
                return Err("Unauthorized (token)".to_string());
            }
            let token = resp["message"]["body"]["user_token"]
                .as_str()
                .ok_or("Missing user_token")?;
            Ok(token.to_string())
        }

        async fn macro_call(
            client: &reqwest::Client,
            token: &str,
            title: &str,
            artist: &str,
        ) -> Result<serde_json::Value, String> {
            let mut url = reqwest::Url::parse(
                "https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get",
            )
            .map_err(|e| format!("URL parse error: {}", e))?;
            let t_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "SystemTime before UNIX_EPOCH".to_string())?
                .as_millis()
                .to_string();
            url.query_pairs_mut()
                .append_pair("format", "json")
                .append_pair("namespace", "lyrics_richsynced")
                .append_pair("optional_calls", "track.richsync")
                .append_pair("subtitle_format", "lrc")
                .append_pair("q_artist", artist)
                .append_pair("q_track", title)
                .append_pair("app_id", "web-desktop-app-v1.0")
                .append_pair("usertoken", token)
                .append_pair("t", &t_ms);
            let resp = get_json_follow_redirects(client, url)
                .await
                .map_err(|e| format!("Musixmatch macro request failed: {}", e))?;
            Ok(resp)
        }

        // Try token + macro, with one retry on 401 at macro stage
        let mut token = get_token(&client).await?;
        let mut macro_resp = macro_call(&client, &token, &title, &artist).await?;
        let status = macro_resp["message"]["header"]["status_code"]
            .as_i64()
            .unwrap_or(0);
        if status == 401 {
            // refresh token once and retry macro
            token = get_token(&client).await?;
            macro_resp = macro_call(&client, &token, &title, &artist).await?;
        }

        // Return the inner body (macro_calls payload) if present; else the whole response
        let body = macro_resp
            .get("message")
            .and_then(|m| m.get("body"))
            .cloned()
            .unwrap_or(macro_resp);
        // Persist to cache (best-effort)
        if let Err(e) = (|| -> Result<(), String> {
            fs::create_dir_all(&base_dir)
                .map_err(|e| format!("Failed creating lyrics cache dir: {}", e))?;
            let serialized = serde_json::to_string(&body)
                .map_err(|e| format!("Failed to serialize lyrics JSON: {}", e))?;
            fs::write(&file_path, serialized)
                .map_err(|e| format!("Failed writing lyrics cache: {}", e))?;
            Ok(())
        })() {
            log_error!("lyrics cache write failed: {}", e);
        }
        Ok(body)
    }

    // Lightweight file-based cache for lyrics (text/JSON) stored under app config dir
    #[tauri::command]
    pub async fn lyrics_cache_get(
        key: String,
        config: tauri::State<'_, crate::paths::PathConfig>,
    ) -> Result<Option<String>, String> {
        use sha2::{Digest, Sha256};
        use std::path::PathBuf;

        // Compute cache directory based on app config directory (use db_file's parent)
        let base_dir: PathBuf = config
            .app_config_dir
            .join("lyrics_cache");

        // Hash the key to a filename (avoid filesystem issues)
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        let hash_hex = format!("{:x}", hasher.finalize());
        let file_path = base_dir.join(format!("{}.json", hash_hex));

        if !file_path.exists() {
            return Ok(None);
        }
        let data = std::fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed reading lyrics cache: {}", e))?;
        Ok(Some(data))
    }

    #[tauri::command]
    pub async fn lyrics_cache_set(
        key: String,
        content: String,
        config: tauri::State<'_, crate::paths::PathConfig>,
    ) -> Result<bool, String> {
        use sha2::{Digest, Sha256};
        use std::fs;
        use std::path::PathBuf;

        let base_dir: PathBuf = config
            .app_config_dir
            .join("lyrics_cache");

        // Ensure cache directory exists
        fs::create_dir_all(&base_dir)
            .map_err(|e| format!("Failed creating lyrics cache dir: {}", e))?;

        // Hash key -> filename
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        let hash_hex = format!("{:x}", hasher.finalize());
        let file_path = base_dir.join(format!("{}.json", hash_hex));

        fs::write(&file_path, content)
            .map_err(|e| format!("Failed writing lyrics cache: {}", e))?;
        Ok(true)
    }
}

/// Playback operations
pub mod playback {
    use crate::playback::{
        get_audio_devices_internal, get_audio_settings_internal, get_download_progress_internal,
        playback_cleanup_internal, playback_get_volume_internal, playback_pause_internal,
        playback_resume_internal, playback_seek_internal, playback_set_mute_internal,
        playback_set_volume_internal, playback_start_internal, playback_start_with_source_internal,
        playback_status_internal, playback_stop_internal, playback_toggle_mute_internal,
        reinitialize_audio_internal, set_audio_settings_internal, PlaybackSourceSpec,
        PlaybackStatus,
    };
    use tauri::Emitter;

    // Tauri command wrappers that call the internal implementation functions

    #[tauri::command]
    pub async fn playback_start(url: String) -> Result<serde_json::Value, String> {
        playback_start_internal(url).await
    }

    #[tauri::command]
    pub async fn playback_start_with_source(
        app: tauri::AppHandle,
        spec: PlaybackSourceSpec,
    ) -> Result<serde_json::Value, String> {
        playback_start_with_source_internal(app, spec).await
    }

    #[tauri::command]
    pub async fn playback_pause() -> Result<serde_json::Value, String> {
        playback_pause_internal().await
    }

    #[tauri::command]
    pub async fn playback_resume() -> Result<serde_json::Value, String> {
        playback_resume_internal().await
    }

    #[tauri::command]
    pub async fn playback_stop() -> Result<serde_json::Value, String> {
        playback_stop_internal().await
    }

    #[tauri::command]
    pub async fn playback_seek(position: f64) -> Result<serde_json::Value, String> {
        playback_seek_internal(position).await
    }

    #[tauri::command]
    pub async fn playback_status() -> Result<serde_json::Value, String> {
        playback_status_internal().await
    }

    #[tauri::command]
    pub async fn get_audio_devices() -> Result<serde_json::Value, String> {
        get_audio_devices_internal().await
    }

    #[tauri::command]
    pub async fn get_audio_settings() -> Result<serde_json::Value, String> {
        get_audio_settings_internal().await
    }

    #[tauri::command]
    pub async fn set_audio_settings(
        settings: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        set_audio_settings_internal(settings).await
    }

    #[tauri::command]
    pub async fn reinitialize_audio(
        device_id: i32,
        sample_rate: u32,
        buffer_size: u32,
    ) -> Result<serde_json::Value, String> {
        reinitialize_audio_internal(device_id, sample_rate, buffer_size).await
    }

    #[tauri::command]
    pub async fn playback_cleanup() -> Result<bool, String> {
        playback_cleanup_internal().await
    }

    #[tauri::command]
    pub async fn playback_set_volume(volume: f32) -> Result<serde_json::Value, String> {
        playback_set_volume_internal(volume).await
    }

    #[tauri::command]
    pub async fn playback_get_volume() -> Result<serde_json::Value, String> {
        playback_get_volume_internal().await
    }

    #[tauri::command]
    pub async fn playback_set_mute(muted: bool) -> Result<serde_json::Value, String> {
        playback_set_mute_internal(muted).await
    }

    #[tauri::command]
    pub async fn playback_toggle_mute() -> Result<serde_json::Value, String> {
        playback_toggle_mute_internal().await
    }

    #[tauri::command]
    pub async fn get_download_progress() -> Result<serde_json::Value, String> {
        get_download_progress_internal().await
    }
}

/// Download control operations
pub mod downloads {
    use super::*;
    use crate::downloads as dl;

    #[tauri::command]
    pub async fn downloads_pause(
        app: tauri::AppHandle,
        track_id: String,
        source_type: String,
        source_hash: String,
    ) -> Result<bool, String> {
        dl::downloads_pause(app, track_id, source_type, source_hash).await
    }

    #[tauri::command]
    pub async fn downloads_resume(
        app: tauri::AppHandle,
        track_id: String,
        source_type: String,
        source_hash: String,
    ) -> Result<bool, String> {
        dl::downloads_resume(app, track_id, source_type, source_hash).await
    }

    #[tauri::command]
    pub async fn downloads_remove(
        app: tauri::AppHandle,
        track_id: String,
        source_type: String,
        source_hash: String,
    ) -> Result<bool, String> {
        dl::downloads_remove(app, track_id, source_type, source_hash).await
    }
}
