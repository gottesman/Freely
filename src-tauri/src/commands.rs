use crate::server::PathState;
use serde::Deserialize;
use tauri::State;
use base64::Engine;

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
        
        let data = std::fs::read(&paths.db_file)
            .map_err(|e| format!("Failed to read database: {}", e))?;
        
        Ok(Some(base64::engine::general_purpose::STANDARD.encode(&data)))
    }

    #[tauri::command]
    pub async fn db_write(base64_data: String, paths: State<'_, PathState>) -> Result<bool, String> {
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
        paths: State<'_, PathState>
    ) -> Result<serde_json::Value, serde_json::Value> {
        let timeout = timeout_ms.unwrap_or(20000);
        
        // Get server status to check if it's running
        let status = paths.get_server_status().await
            .map_err(|e| serde_json::json!({
                "error": "server_check_failed",
                "message": e
            }))?;

        let port = status.port.ok_or_else(|| serde_json::json!({
            "error": "server_not_running",
            "message": "Server is not currently running"
        }))?;

        // Make request to server endpoint
        let url = format!("http://localhost:{}/api/torrent-files/{}?timeout={}", port, 
                         urlencoding::encode(&id), timeout);
        
        let response = reqwest::get(&url)
            .await
            .map_err(|e| serde_json::json!({
                "error": "request_failed",
                "message": e.to_string()
            }))?;

        if !response.status().is_success() {
            let status_code = response.status().as_u16();
            let error_text = response.text().await.unwrap_or_default();
            return Err(serde_json::json!({
                "error": "server_error",
                "message": format!("Server returned {}: {}", status_code, error_text),
                "status_code": status_code
            }));
        }

        response.json()
            .await
            .map_err(|e| serde_json::json!({
                "error": "response_parse_failed",
                "message": e.to_string()
            }))
    }

    #[tauri::command]
    pub async fn torrent_list_scrapers(paths: State<'_, PathState>) -> Result<serde_json::Value, String> {
        let status = paths.get_server_status().await?;
        
        if let Some(port) = status.port {
            let url = format!("http://localhost:{}/ping", port);
            let response = reqwest::get(&url).await
                .map_err(|e| format!("Failed to contact server: {}", e))?;
            
            response.json()
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
        format!("http://localhost:{}/api/source-search?{}", port, query_string)
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

        // Inject stream URL for convenience
        if let serde_json::Value::Object(ref mut map) = response {
            let stream_url = format!(
                "http://localhost:{}/source/youtube?id={}&get=stream", 
                port, 
                urlencoding::encode(&payload.id)
            );
            map.insert("streamUrl".to_string(), serde_json::Value::String(stream_url));
        }

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

/// External API operations
pub mod external {

    #[tauri::command]
    pub async fn charts_get_weekly_tops(opts: serde_json::Value) -> Result<serde_json::Value, String> {
        let endpoint = std::env::var("CHARTS_SPOTIFY_ENDPOINT")
            .map_err(|_| "CHARTS_SPOTIFY_ENDPOINT not configured")?;
        
        let url = opts.get("url")
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
        
        let url = format!("https://api.genius.com/search?q={}", urlencoding::encode(&query));
        
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
    pub async fn spotify_search(query: String, type_or_types: String) -> Result<serde_json::Value, String> {
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
}
