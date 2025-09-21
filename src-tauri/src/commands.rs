use crate::server::PathState;
use base64::Engine;
use serde::Deserialize;
use tauri::State;

/// Database operations
pub mod db {
    use super::*;
    #[tauri::command]
    pub async fn db_path(paths: State<'_, PathState>) -> Result<String, String> {
        Ok(paths.db_file.to_string_lossy().to_string())
    }
    #[tauri::command]
    pub async fn db_read(paths: State<'_, PathState>) -> Result<Option<String>, String> {
        if !paths.db_file.exists() {
            return Ok(None);
        }

        let data =
            std::fs::read(&paths.db_file).map_err(|e| format!("Failed to read database: {}", e))?;

        Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(&data),
        ))
    }

    #[tauri::command]
    pub async fn db_write(
        base64_data: String,
        paths: State<'_, PathState>,
    ) -> Result<bool, String> {
        // Ensure parent directory exists
        if let Some(parent) = paths.db_file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create database directory: {}", e))?;
        }

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&base64_data)
            .map_err(|e| format!("Invalid base64 data: {}", e))?;

        std::fs::write(&paths.db_file, bytes)
            .map_err(|e| format!("Failed to write database: {}", e))?;

        Ok(true)
    }
}

/// Torrent operations
pub mod torrent {
    use super::*;

    #[tauri::command]
    pub async fn torrent_get_files(
        id: String,
        timeout_ms: Option<u64>,
        paths: State<'_, PathState>,
    ) -> Result<serde_json::Value, serde_json::Value> {
        let timeout = timeout_ms.unwrap_or(20000);

        // Get server status to check if it's running
        let status = paths.get_server_status().await.map_err(|e| {
            serde_json::json!({
                "error": "server_check_failed",
                "message": e
            })
        })?;

        let port = status.port.ok_or_else(|| {
            serde_json::json!({
                "error": "server_not_running",
                "message": "Server is not currently running"
            })
        })?;

        // Make request to server endpoint
        let url = format!(
            "http://localhost:{}/api/torrent-files/{}?timeout={}",
            port,
            urlencoding::encode(&id),
            timeout
        );

        let response = reqwest::get(&url).await.map_err(|e| {
            serde_json::json!({
                "error": "request_failed",
                "message": e.to_string()
            })
        })?;

        if !response.status().is_success() {
            let status_code = response.status().as_u16();
            let error_text = response.text().await.unwrap_or_default();
            return Err(serde_json::json!({
                "error": "server_error",
                "message": format!("Server returned {}: {}", status_code, error_text),
                "status_code": status_code
            }));
        }

        response.json().await.map_err(|e| {
            serde_json::json!({
                "error": "response_parse_failed",
                "message": e.to_string()
            })
        })
    }

    #[tauri::command]
    pub async fn torrent_list_scrapers(
        paths: State<'_, PathState>,
    ) -> Result<serde_json::Value, String> {
        let status = paths.get_server_status().await?;

        if let Some(port) = status.port {
            let url = format!("http://localhost:{}/ping", port);
            let response = reqwest::get(&url)
                .await
                .map_err(|e| format!("Failed to contact server: {}", e))?;

            response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))
        } else {
            Ok(serde_json::json!([]))
        }
    }
}

/// Search operations
pub mod search {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SourceSearchPayload {
        pub title: Option<String>,
        pub artist: Option<String>,
        pub r#type: Option<String>,
    }

    #[tauri::command]
    pub async fn source_search(
        payload: SourceSearchPayload,
        paths: State<'_, PathState>,
    ) -> Result<serde_json::Value, String> {
        let status = paths.get_server_status().await?;

        let port = status.port.ok_or("Server not running")?;

        let url = build_search_url(port, &payload);

        reqwest::get(&url)
            .await
            .map_err(|e| format!("Search request failed: {}", e))?
            .json()
            .await
            .map_err(|e| format!("Failed to parse search response: {}", e))
    }

    fn build_search_url(port: u16, payload: &SourceSearchPayload) -> String {
        let mut params = Vec::new();

        // Add non-empty string parameters
        if let Some(title) = payload.title.as_ref().filter(|s| !s.trim().is_empty()) {
            params.push(format!("title={}", urlencoding::encode(title.trim())));
        }
        if let Some(artist) = payload.artist.as_ref().filter(|s| !s.trim().is_empty()) {
            params.push(format!("artist={}", urlencoding::encode(artist.trim())));
        }
        if let Some(type_filter) = payload.r#type.as_ref().filter(|s| !s.trim().is_empty()) {
            params.push(format!("type={}", urlencoding::encode(type_filter.trim())));
        }

        let query_string = params.join("&");
        format!(
            "http://localhost:{}/api/source-search?{}",
            port, query_string
        )
    }
}

/// YouTube operations
pub mod youtube {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
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
        paths: State<'_, PathState>,
    ) -> Result<serde_json::Value, String> {
        let status = paths.get_server_status().await?;

        let port = status.port.ok_or("Server not running")?;

        let url = build_youtube_url(port, &payload);

        let mut response: serde_json::Value = reqwest::get(&url)
            .await
            .map_err(|e| format!("YouTube request failed: {}", e))?
            .json()
            .await
            .map_err(|e| format!("Failed to parse YouTube response: {}", e))?;

        Ok(response)
    }

    fn build_youtube_url(port: u16, payload: &YoutubeInfoPayload) -> String {
        let mut params = vec![
            format!("id={}", urlencoding::encode(&payload.id)),
            "get=info".to_string(),
        ];

        if payload.debug {
            params.push("debug=1".to_string());
        }
        if payload.force {
            params.push("forceInfo=1".to_string());
        }

        let query_string = params.join("&");
        format!("http://localhost:{}/source/youtube?{}", port, query_string)
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
        paths: tauri::State<'_, crate::server::PathState>,
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
        let base_dir: PathBuf = paths
            .db_file
            .parent()
            .ok_or("Invalid app config path")?
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
            eprintln!("lyrics cache write failed: {}", e);
        }
        Ok(body)
    }

    // Lightweight file-based cache for lyrics (text/JSON) stored under app config dir
    #[tauri::command]
    pub async fn lyrics_cache_get(
        key: String,
        paths: tauri::State<'_, crate::server::PathState>,
    ) -> Result<Option<String>, String> {
        use sha2::{Digest, Sha256};
        use std::path::PathBuf;

        // Compute cache directory based on app config directory (use db_file's parent)
        let base_dir: PathBuf = paths
            .db_file
            .parent()
            .ok_or("Invalid app config path")?
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
        paths: tauri::State<'_, crate::server::PathState>,
    ) -> Result<bool, String> {
        use sha2::{Digest, Sha256};
        use std::fs;
        use std::path::PathBuf;

        let base_dir: PathBuf = paths
            .db_file
            .parent()
            .ok_or("Invalid app config path")?
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
