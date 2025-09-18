use std::path::{Path, PathBuf};
use std::fs;
use std::io::Write;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use once_cell::sync::Lazy;
use tokio::sync::mpsc;
use reqwest;
use tokio::io::AsyncWriteExt;
use tokio::fs as tokio_fs;
use tauri::Manager;
use tauri::Emitter;
use crate::utils::resolve_audio_source;
use crate::downloads;

#[derive(Debug)]
pub struct CacheDownloadResult {
    pub track_id: String,
    pub source_type: String,
    pub source_hash: String,
    pub cached_path: String,
    pub file_size: u64,
}

// Cache configuration constants
const CACHE_DIR_NAME: &str = "audio_cache";
const CACHE_INDEX_FILE: &str = "cache_index.json";
const MAX_CACHE_SIZE_MB: u64 = 500; // 500MB max cache size
const MAX_CACHE_AGE_DAYS: u64 = 30; // 30 days max age

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub track_id: String,
    pub source_type: String, // "youtube", "torrent", "http", "local"
    pub source_hash: String, // YouTube ID, torrent infoHash, URL hash, etc.
    pub file_path: String,
    pub file_size: u64,
    pub cached_at: u64, // Unix timestamp
    pub last_accessed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheIndex {
    pub entries: HashMap<String, CacheEntry>,
    pub total_size: u64,
}

impl CacheIndex {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            total_size: 0,
        }
    }
}

pub struct AudioCache {
    cache_dir: PathBuf,
    index_file: PathBuf,
    index: CacheIndex,
}

impl AudioCache {
    pub fn new(app_config_dir: &Path) -> Result<Self, String> {
        let cache_dir = app_config_dir.join(CACHE_DIR_NAME);
        let index_file = cache_dir.join(CACHE_INDEX_FILE);

        // Create cache directory if it doesn't exist
        if !cache_dir.exists() {
            fs::create_dir_all(&cache_dir)
                .map_err(|e| format!("Failed to create cache directory: {}", e))?;
        }

        // Load existing index or create new one
        let index = if index_file.exists() {
            Self::load_index(&index_file)?
        } else {
            CacheIndex::new()
        };

        Ok(Self {
            cache_dir,
            index_file,
            index,
        })
    }

    fn generate_cache_key(track_id: &str, source_type: &str, source_hash: &str) -> String {
        format!("{}:{}:{}", track_id, source_type, source_hash)
    }

    fn load_index(index_file: &Path) -> Result<CacheIndex, String> {
        let content = fs::read_to_string(index_file)
            .map_err(|e| format!("Failed to read cache index: {}", e))?;
        
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse cache index: {}", e))
    }

    fn save_index(&self) -> Result<(), String> {
        let content = serde_json::to_string_pretty(&self.index)
            .map_err(|e| format!("Failed to serialize cache index: {}", e))?;
        
        fs::write(&self.index_file, content)
            .map_err(|e| format!("Failed to write cache index: {}", e))
    }

    pub fn get_cached_file(&mut self, track_id: &str, source_type: &str, source_hash: &str) -> Option<PathBuf> {
        let cache_key = Self::generate_cache_key(track_id, source_type, source_hash);
        
        if let Some(entry) = self.index.entries.get_mut(&cache_key) {
            let file_path = self.cache_dir.join(&entry.file_path);
            
            // Check if file actually exists
            if file_path.exists() {
                // Update last accessed time
                entry.last_accessed = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                
                //println!("[cache] Cache hit for track: {} ({}:{})", track_id, source_type, source_hash);
                return Some(file_path);
            } else {
                // File doesn't exist, remove from index
                println!("[cache] Cached file missing, removing from index: {} ({}:{})", track_id, source_type, source_hash);
                self.index.total_size = self.index.total_size.saturating_sub(entry.file_size);
                self.index.entries.remove(&cache_key);
                let _ = self.save_index();
            }
        }
        
        // Debounce frequent cache miss logs to avoid spamming when frontend polls repeatedly
        let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let mut recent = RECENT_MISSES.lock().unwrap();
        let last = recent.get(&cache_key).cloned().unwrap_or(0);
        if now_secs.saturating_sub(last) >= MISS_LOG_DEBOUNCE_SECS {
            println!("[cache] Cache miss for track: {} ({}:{})", track_id, source_type, source_hash);
            recent.insert(cache_key.clone(), now_secs);
        }
        None
    }

    pub fn add_cached_file(&mut self, track_id: String, source_type: String, source_hash: String, file_path: String, file_size: u64) -> Result<(), String> {
        let cache_key = Self::generate_cache_key(&track_id, &source_type, &source_hash);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Add to cache index
        let entry = CacheEntry {
            track_id,
            source_type,
            source_hash,
            file_path,
            file_size,
            cached_at: now,
            last_accessed: now,
        };

        self.index.entries.insert(cache_key, entry);
        self.index.total_size += file_size;

        // Clean up old entries if cache is too large
        self.cleanup_cache()?;

        // Save index
        self.save_index()?;

        Ok(())
    }

    fn cleanup_cache(&mut self) -> Result<(), String> {
        let max_size_bytes = MAX_CACHE_SIZE_MB * 1024 * 1024;
        let max_age_seconds = MAX_CACHE_AGE_DAYS * 24 * 60 * 60;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let mut entries_to_remove = Vec::new();

        // Remove entries that are too old
        for (cache_key, entry) in &self.index.entries {
            if now.saturating_sub(entry.cached_at) > max_age_seconds {
                entries_to_remove.push(cache_key.clone());
            }
        }

        // Remove old entries
        for cache_key in &entries_to_remove {
            if let Some(entry) = self.index.entries.remove(cache_key) {
                let file_path = self.cache_dir.join(&entry.file_path);
                if file_path.exists() {
                    let _ = fs::remove_file(file_path);
                }
                self.index.total_size = self.index.total_size.saturating_sub(entry.file_size);
                println!("[cache] Removed old cached file: {} ({}:{})", entry.track_id, entry.source_type, entry.source_hash);
            }
        }

        // If still over size limit, remove least recently accessed files
        if self.index.total_size > max_size_bytes {
            let mut entries_by_access: Vec<_> = self.index.entries.iter().collect();
            entries_by_access.sort_by(|a, b| a.1.last_accessed.cmp(&b.1.last_accessed));

            // Collect keys to remove
            let mut keys_to_remove = Vec::new();
            for (cache_key, _) in entries_by_access {
                if self.index.total_size <= max_size_bytes {
                    break;
                }
                keys_to_remove.push(cache_key.clone());
            }

            // Now remove the entries
            for cache_key in keys_to_remove {
                if let Some(entry) = self.index.entries.remove(&cache_key) {
                    let file_path = self.cache_dir.join(&entry.file_path);
                    if file_path.exists() {
                        let _ = fs::remove_file(file_path);
                    }
                    self.index.total_size = self.index.total_size.saturating_sub(entry.file_size);
                    println!("[cache] Removed LRU cached file: {} ({}:{})", entry.track_id, entry.source_type, entry.source_hash);
                }
            }
        }

        Ok(())
    }

    pub fn get_cache_stats(&self) -> (u64, usize) {
        (self.index.total_size, self.index.entries.len())
    }

    pub fn clear_cache(&mut self) -> Result<(), String> {
        // Remove all cached files
        for entry in self.index.entries.values() {
            let file_path = self.cache_dir.join(&entry.file_path);
            if file_path.exists() {
                let _ = fs::remove_file(file_path);
            }
        }

        // Reset index
        self.index = CacheIndex::new();
        self.save_index()?;

        println!("[cache] Cache cleared");
        Ok(())
    }
}
/// Create a safe cache filename (without extension) based on identifiers.
/// Returns a string like "<track>_<source_type>_<hash>" sanitized for filesystem.
pub fn create_cache_filename(track_id: &str, source_type: &str, source_hash: &str) -> String {
    let safe_track: String = track_id
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let safe_hash: String = source_hash
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    format!("{}_{}_{}", safe_track, source_type, safe_hash)
}

// Global cache state
static CACHE: Lazy<Mutex<Option<AudioCache>>> = Lazy::new(|| Mutex::new(None));

// Track inflight downloads: map cache_key -> (bytes_written, optional_total_bytes)
static INFLIGHT_DOWNLOADS: Lazy<Mutex<HashMap<String, (u64, Option<u64>)>>> = Lazy::new(|| Mutex::new(HashMap::new()));
// Track inflight metadata to recover identifiers for UI listing: cache_key -> (track_id, source_type, source_hash)
static INFLIGHT_META: Lazy<Mutex<HashMap<String, (String, String, String)>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// Recent cache miss log debouncing: map cache_key -> last_logged_unix_seconds
const MISS_LOG_DEBOUNCE_SECS: u64 = 5;
static RECENT_MISSES: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// Short-lived negative cache for cache_get_file to avoid repeated lookups
const NEGATIVE_CACHE_TTL_SECS: u64 = 3;
static NEGATIVE_CACHE: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// Validate that downloaded content appears to be audio data
fn is_valid_audio_content(bytes: &[u8]) -> bool {
    // Check minimum size (audio files should be at least a few KB)
    if bytes.len() < 1024 {
        println!("[cache] Content too small to be audio: {} bytes", bytes.len());
        return false;
    }

    // Check for HTML content (indicates error page)
    let content_start = &bytes[..std::cmp::min(bytes.len(), 512)];
    let content_str = String::from_utf8_lossy(content_start);
    
    if content_str.contains("<html") || content_str.contains("<HTML") ||
       content_str.contains("<!DOCTYPE") || content_str.contains("doctype") {
        println!("[cache] Content appears to be HTML error page");
        return false;
    }

    // Check for common error messages in content
    if content_str.contains("Video unavailable") || 
       content_str.contains("This video is unavailable") ||
       content_str.contains("ERROR") ||
       content_str.contains("error") {
        println!("[cache] Content contains error messages");
        return false;
    }

    // For M4A files, check if it starts with a valid header
    // M4A files typically start with 'ftyp' box after the first few bytes
    if bytes.len() > 8 {
        // Look for 'ftyp' box which is common in MP4/M4A files
        for i in 4..std::cmp::min(bytes.len() - 4, 64) {
            if &bytes[i..i+4] == b"ftyp" {
                println!("[cache] Found valid M4A/MP4 header");
                return true;
            }
        }
        
        // If we don't find ftyp, it might still be valid audio, so we'll be permissive
        // but log it for debugging
        println!("[cache] No M4A header found, but content passes other checks");
    }

    true
}

// Initialize cache with app config directory
pub fn init_cache(app_config_dir: &Path) -> Result<(), String> {
    let mut cache = CACHE.lock().unwrap();
    *cache = Some(AudioCache::new(app_config_dir)?);
    println!("[cache] Audio cache initialized");
    Ok(())
}

/// Get a cached file path if it exists
pub fn get_cached_file_path(track_id: &str, source_type: &str, source_hash: &str) -> Option<PathBuf> {
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        cache.get_cached_file(track_id, source_type, source_hash)
    } else {
        None
    }
}

/// Get the cache directory path
pub fn get_cache_dir() -> Option<PathBuf> {
    let cache_guard = CACHE.lock().unwrap();
    cache_guard.as_ref().map(|c| c.cache_dir.clone())
}

/// Add a cached file to the cache index
pub fn add_cached_file_to_index(track_id: String, source_type: String, source_hash: String, file_path: String, file_size: u64) -> Result<(), String> {
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        cache.add_cached_file(track_id, source_type, source_hash, file_path, file_size)
    } else {
        Err("Cache not initialized".to_string())
    }
}

// Return current inflight download status (bytes_downloaded, optional total) for a given key
pub fn get_inflight_status(track_id: &str, source_type: &str, source_hash: &str) -> Option<(u64, Option<u64>)> {
    let cache_key = create_cache_filename(track_id, source_type, source_hash);
    let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
    inflight.get(&cache_key).cloned()
}

// Return the expected final (extension-less) path for a given cache key, if the cache is initialized.
pub fn get_final_cache_path(track_id: &str, source_type: &str, source_hash: &str) -> Option<PathBuf> {
    let cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_ref() {
        let base = create_cache_filename(track_id, source_type, source_hash);
        return Some(cache.cache_dir.join(base));
    }
    None
}

// Tauri commands
#[tauri::command]
pub async fn cache_get_file(track_id: String, source_type: String, source_hash: String) -> Result<serde_json::Value, String> {
    // If we recently answered a miss for this key, return quickly to avoid repeated work
    let cache_key = AudioCache::generate_cache_key(&track_id, &source_type, &source_hash);
    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    {
        let neg = NEGATIVE_CACHE.lock().unwrap();
        if let Some(&ts) = neg.get(&cache_key) {
            if now_secs.saturating_sub(ts) < NEGATIVE_CACHE_TTL_SECS {
                return Ok(serde_json::json!({ "cached_path": null, "exists": false }));
            }
        }
    }

    // Perform the actual cache lookup
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        if let Some(file_path) = cache.get_cached_file(&track_id, &source_type, &source_hash) {
            // Found a cached file; clear any negative cache entry and return
            let mut neg = NEGATIVE_CACHE.lock().unwrap();
            neg.remove(&cache_key);
            println!("[cache] Found cached file for {}:{}:{} -> {}", track_id, source_type, source_hash, file_path.display());
            return Ok(serde_json::json!({
                "cached_path": file_path.to_string_lossy().to_string(),
                "exists": true
            }));
        }
    }

    // Register a negative cache entry to suppress immediate repeated lookups
    {
        let mut neg = NEGATIVE_CACHE.lock().unwrap();
        neg.insert(cache_key.clone(), now_secs);
    }

    Ok(serde_json::json!({ "cached_path": null, "exists": false }))
}

#[tauri::command]
pub async fn cache_download_and_store(app: tauri::AppHandle, track_id: String, source_type: String, source_hash: String, url: String) -> Result<String, String> {
    let (tx, _rx) = mpsc::unbounded_channel::<CacheDownloadResult>();
    // spawn background task to avoid blocking the command
    let app_clone = app.clone();
    tokio::spawn(async move {
        download_and_cache_audio(Some(app_clone), track_id, source_type, source_hash, url, tx).await;
    });

    // For compatibility, return immediately
    Ok("Download started".to_string())
}

pub async fn download_and_cache_audio(app: Option<tauri::AppHandle>, track_id: String, source_type: String, source_hash: String, url: String, tx: mpsc::UnboundedSender<CacheDownloadResult>) {
    println!("[cache] Starting download for track: {} ({}:{})", track_id, source_type, source_hash);

    // Resolve the provided URL to a direct download URL when possible. This avoids
    // hitting the local streaming endpoint which may return HTML/error pages.
    let resolved = match resolve_audio_source(&source_type, &url).await {
        Ok(u) => u,
        Err(e) => {
            println!("[cache] Failed to resolve source URL for {} ({}:{}): {}. Falling back to provided URL", track_id, source_type, source_hash, e);
            url.clone()
        }
    };

    // Use a single reqwest client for better performance
    let client = reqwest::Client::new();

    // Issue request
    println!("[cache] Downloading for {} ({}:{}) from: {}", track_id, source_type, source_hash, resolved);
    let resp = match client.get(&resolved).send().await {
        Ok(r) => r,
        Err(e) => {
            println!("[cache] Download request failed for {} ({}:{}): {}", track_id, source_type, source_hash, e);
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit("cache:download:error", serde_json::json!({
                    "trackId": track_id,
                    "sourceType": source_type,
                    "sourceHash": source_hash,
                    "message": format!("Request failed: {}", e)
                }));
            }
            return;
        }
    };

    if !resp.status().is_success() {
        println!("[cache] Download failed with status {} for {} ({}:{})", resp.status(), track_id, source_type, source_hash);
        if let Some(app_ref) = app.as_ref() {
            let _ = app_ref.emit("cache:download:error", serde_json::json!({
                "trackId": track_id,
                "sourceType": source_type,
                "sourceHash": source_hash,
                "message": format!("HTTP status {}", resp.status())
            }));
        }
        return;
    }
    // Use shared helper for consistent base name
    let base_name = create_cache_filename(&track_id, &source_type, &source_hash);
    // Ensure we have a control handle for this download
    downloads::ensure_control_for(&base_name);
    
    // We'll write to a .part file and then rename to final (extension-less) name on success
    let cache_file_name = format!("{}.part", base_name);

    // Ensure cache directory exists (read it from the global cache while holding lock briefly)
    let cache_dir = {
        let cache_guard = CACHE.lock().unwrap();
        if let Some(c) = cache_guard.as_ref() {
            c.cache_dir.clone()
        } else {
            println!("[cache] Cache not initialized, cannot cache {} ({}:{})", track_id, source_type, source_hash);
            return;
        }
    };

    let cache_path = cache_dir.join(&cache_file_name);
    let final_path = cache_dir.join(&base_name);

    // Stream response into part file while collecting initial bytes for validation
    // Capture content length before consuming the response
    let content_len_opt = resp.content_length();
    let mut stream = resp.bytes_stream();

    // Open async file for writing
    let mut file = match tokio_fs::File::create(&cache_path).await {
        Ok(f) => f,
            Err(e) => {
            println!("[cache] Failed to create cache file {:?}: {}", cache_path, e);
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit("cache:download:error", serde_json::json!({
                    "trackId": track_id,
                    "sourceType": source_type,
                    "sourceHash": source_hash,
                    "message": format!("Failed to create cache file: {}", e)
                }));
            }
            return;
        }
    };

    const VALIDATION_BYTES: usize = 8192; // collect up to 8KB for validation
    let mut prefix_buf: Vec<u8> = Vec::with_capacity(VALIDATION_BYTES);
    let mut total_written: u64 = 0;
    let mut ready_emitted = false;

    use futures_util::StreamExt;

    // Mark inflight
    {
        let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
        inflight.insert(base_name.clone(), (0u64, content_len_opt));
        let mut meta = INFLIGHT_META.lock().unwrap();
        meta.insert(base_name.clone(), (track_id.clone(), source_type.clone(), source_hash.clone()));
    }

    // Emit initial progress event
    if let Some(app_ref) = app.as_ref() {
        let _ = app_ref.emit("cache:download:progress", serde_json::json!({
            "trackId": track_id,
            "sourceType": source_type,
            "sourceHash": source_hash,
            "bytes_downloaded": 0u64,
            "total_bytes": content_len_opt,
            "inflight": true
        }));
    }

    while let Some(item) = stream.next().await {
        // Respect pause/cancel controls
        if downloads::is_cancelled(&base_name) {
            println!("[cache] Cancel requested for {} ({}:{})", track_id, source_type, source_hash);
            let _ = tokio_fs::remove_file(&cache_path).await;
            let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
            inflight.remove(&base_name);
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit("cache:download:error", serde_json::json!({
                    "trackId": track_id,
                    "sourceType": source_type,
                    "sourceHash": source_hash,
                    "message": "cancelled"
                }));
            }
            // Clear control state
            downloads::clear_control(&base_name);
            return;
        }
        // If paused, wait until resumed or cancelled
        if downloads::is_paused(&base_name) {
            downloads::wait_while_paused_or_until_cancel(&base_name).await;
            if downloads::is_cancelled(&base_name) { continue; }
        }
        match item {
            Ok(chunk) => {
                // Collect into prefix buffer until we have enough
                if prefix_buf.len() < VALIDATION_BYTES {
                    let need = VALIDATION_BYTES - prefix_buf.len();
                    let to_take = std::cmp::min(need, chunk.len());
                    prefix_buf.extend_from_slice(&chunk[..to_take]);
                }

                // Write chunk to part file
                if let Err(e) = file.write_all(&chunk).await {
                    println!("[cache] Failed to write to part file {:?}: {}", cache_path, e);
                    let _ = tokio_fs::remove_file(&cache_path).await;
                    // clear inflight
                    let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                    inflight.remove(&base_name);
                    let mut meta = INFLIGHT_META.lock().unwrap();
                    meta.remove(&base_name);
                    if let Some(app_ref) = app.as_ref() {
                        let _ = app_ref.emit("cache:download:error", serde_json::json!({
                            "trackId": track_id,
                            "sourceType": source_type,
                            "sourceHash": source_hash,
                            "message": format!("Write failed: {}", e)
                        }));
                    }
                    // Clear control state on error
                    downloads::clear_control(&base_name);
                    return;
                }
                total_written = total_written.saturating_add(chunk.len() as u64);
                // update inflight bytes
                {
                    let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                    if let Some(v) = inflight.get_mut(&base_name) {
                        v.0 = total_written;
                    }
                }

                // Emit a "ready" event as soon as we have enough validated prefix bytes
                if !ready_emitted && prefix_buf.len() >= 1024 {
                    if is_valid_audio_content(&prefix_buf) {
                        ready_emitted = true;
                        if let Some(app_ref) = app.as_ref() {
                            let tmp_path_str = cache_path.to_string_lossy().to_string();
                            let _ = app_ref.emit("cache:download:ready", serde_json::json!({
                                "trackId": track_id,
                                "sourceType": source_type,
                                "sourceHash": source_hash,
                                "tmpPath": tmp_path_str,
                                "bytes_downloaded": total_written,
                                "total_bytes": content_len_opt,
                                "inflight": true
                            }));
                        }
                    }
                }

                // emit progress event
                if let Some(app_ref) = app.as_ref() {
                    let _ = app_ref.emit("cache:download:progress", serde_json::json!({
                        "trackId": track_id,
                        "sourceType": source_type,
                        "sourceHash": source_hash,
                        "bytes_downloaded": total_written,
                        "total_bytes": content_len_opt,
                        "inflight": true
                    }));
                }
            }
            Err(e) => {
                println!("[cache] Error while streaming download for {} ({}:{}): {}", track_id, source_type, source_hash, e);
                let _ = tokio_fs::remove_file(&cache_path).await;
                let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                inflight.remove(&base_name);
                let mut meta = INFLIGHT_META.lock().unwrap();
                meta.remove(&base_name);
                if let Some(app_ref) = app.as_ref() {
                    let _ = app_ref.emit("cache:download:error", serde_json::json!({
                        "trackId": track_id,
                        "sourceType": source_type,
                        "sourceHash": source_hash,
                        "message": format!("Streaming error: {}", e)
                    }));
                }
                // Clear control state on error
                downloads::clear_control(&base_name);
                return;
            }
        }
    }

    // Ensure file is flushed to disk
    if let Err(e) = file.flush().await {
    println!("[cache] Failed to flush cache file {:?}: {}", cache_path, e);
    let _ = tokio_fs::remove_file(&cache_path).await;
        // Clear control on validation failure
        downloads::clear_control(&base_name);
        return;
    }

    // Validate collected prefix bytes
    if !is_valid_audio_content(&prefix_buf) {
        println!("[cache] Downloaded content is not valid audio for {} ({}:{}), size: {} bytes", track_id, source_type, source_hash, total_written);
    let _ = tokio_fs::remove_file(&cache_path).await;
    let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
    inflight.remove(&base_name);
    let mut meta = INFLIGHT_META.lock().unwrap();
    meta.remove(&base_name);
        if let Some(app_ref) = app.as_ref() {
            let _ = app_ref.emit("cache:download:error", serde_json::json!({
                "trackId": track_id,
                "sourceType": source_type,
                "sourceHash": source_hash,
                "message": "Validation failed: content is not valid audio"
            }));
        }
        // Clear control on finalize error
        downloads::clear_control(&base_name);
        return;
    }

    // Atomically rename temp file to final name
    if let Err(e) = tokio_fs::rename(&cache_path, &final_path).await {
        println!("[cache] Failed to rename cache file to final cache file {:?} -> {:?}: {}", cache_path, final_path, e);

        // It's possible another concurrent task already moved/created the final file.
        // If the final file exists, treat this as success and ensure the index contains it.
        if final_path.exists() {
            println!("[cache] Final cache file already exists, assuming another worker completed the move: {:?}", final_path);

            // Obtain file size from the existing final file
            let file_size = match tokio_fs::metadata(&final_path).await {
                Ok(meta) => meta.len(),
                Err(err) => {
                    println!("[cache] Failed to stat existing final file {:?}: {}", final_path, err);
                    // Try to remove temp file if present, then abort
                    let _ = tokio_fs::remove_file(&cache_path).await;
                    return;
                }
            };

            // Add to cache index under lock if it's not already present.
            // Avoid awaiting while holding the mutex: perform any async cleanup after dropping the lock.
            let mut add_failed = None;
            {
                let mut cache_guard = CACHE.lock().unwrap();
                if let Some(cache) = cache_guard.as_mut() {
                    let cache_key = AudioCache::generate_cache_key(&track_id, &source_type, &source_hash);
                    if !cache.index.entries.contains_key(&cache_key) {
                        if let Err(e) = cache.add_cached_file(track_id.clone(), source_type.clone(), source_hash.clone(), base_name.clone(), file_size) {
                            add_failed = Some(e);
                        }
                    }
                }
            }

            if let Some(e) = add_failed {
                println!("[cache] Failed to add existing final file to index for {} ({}:{}): {}", track_id, source_type, source_hash, e);
                // Nothing else we can do; clean up cache file and return
                let _ = tokio_fs::remove_file(&cache_path).await;
                let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                inflight.remove(&base_name);
                let mut meta = INFLIGHT_META.lock().unwrap();
                meta.remove(&base_name);

                if let Some(app_ref) = app.as_ref() {
                    let _ = app_ref.emit("cache:download:error", serde_json::json!({
                        "trackId": track_id,
                        "sourceType": source_type,
                        "sourceHash": source_hash,
                        "message": format!("Failed to add cache index: {}", e)
                    }));
                }

                return;
            }

            // Send completion notification
            let cached_path = final_path.to_string_lossy().to_string();
            let result = CacheDownloadResult {
                track_id: track_id.clone(),
                source_type: source_type.clone(),
                source_hash: source_hash.clone(),
                cached_path: cached_path.clone(),
                file_size,
            };

            if let Err(e) = tx.send(result) {
                println!("[cache] Failed to send cache completion notification for {} ({}:{}): {}", track_id, source_type, source_hash, e);
            } else {
                println!("[cache] Cache download completed (race-resolved) for {} ({}:{}) -> {}", track_id, source_type, source_hash, cached_path);
            }

            // emit complete event
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit("cache:download:complete", serde_json::json!({
                    "trackId": track_id,
                    "sourceType": source_type,
                    "sourceHash": source_hash,
                    "cachedPath": cached_path,
                    "fileSize": file_size
                }));
            }

            // Clean up temp if it still exists
            let _ = tokio_fs::remove_file(&cache_path).await;
            let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
            inflight.remove(&base_name);
            return;
        }

        // If we get here, rename failed and final file doesn't exist. Try to remove the tmp file if present and abort.
        if tokio_fs::metadata(&cache_path).await.is_ok() {
            let _ = tokio_fs::remove_file(&cache_path).await;
        }
        let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
        inflight.remove(&base_name);
        let mut meta = INFLIGHT_META.lock().unwrap();
        meta.remove(&base_name);
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit("cache:download:error", serde_json::json!({
                    "trackId": track_id,
                    "sourceType": source_type,
                    "sourceHash": source_hash,
                    "message": "Failed to finalize cache file"
                }));
            }
        return;
    }
    
    let file_size = total_written;

    // Add to cache index under lock
    {
        let mut cache_guard = CACHE.lock().unwrap();
        if let Some(cache) = cache_guard.as_mut() {
            if let Err(e) = cache.add_cached_file(track_id.clone(), source_type.clone(), source_hash.clone(), base_name.clone(), file_size) {
                println!("[cache] Failed to add to cache index for {} ({}:{}): {}", track_id, source_type, source_hash, e);
                // On failure remove the cached file
                let _ = std::fs::remove_file(&final_path);
                let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                inflight.remove(&base_name);
                // Clear control on index add failure
                downloads::clear_control(&base_name);
                return;
            }
        } else {
            println!("[cache] Cache not initialized during finalization, removing file: {:?}", final_path);
            let _ = std::fs::remove_file(&final_path);
            let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
            inflight.remove(&base_name);
            // Clear control if cache not initialized
            downloads::clear_control(&base_name);
            return;
        }
    }

    let cached_path = final_path.to_string_lossy().to_string();

    // Send completion notification
    let result = CacheDownloadResult {
        track_id: track_id.clone(),
        source_type: source_type.clone(),
        source_hash: source_hash.clone(),
        cached_path: cached_path.clone(),
        file_size,
    };

    if let Err(e) = tx.send(result) {
        println!("[cache] Failed to send cache completion notification for {} ({}:{}): {}", track_id, source_type, source_hash, e);
    } else {
        println!("[cache] Cache download completed for {} ({}:{}) -> {}", track_id, source_type, source_hash, cached_path);
    }

    // emit complete event
    if let Some(app_ref) = app.as_ref() {
        let _ = app_ref.emit("cache:download:complete", serde_json::json!({
            "trackId": track_id,
            "sourceType": source_type,
            "sourceHash": source_hash,
            "cachedPath": cached_path,
            "fileSize": file_size
        }));
    }

    // clear inflight
    {
        let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
        inflight.remove(&base_name);
        let mut meta = INFLIGHT_META.lock().unwrap();
        meta.remove(&base_name);
    }
    // Clear control on success
    downloads::clear_control(&base_name);
}


#[tauri::command]
pub async fn cache_download_status(track_id: String, source_type: String, source_hash: String) -> Result<serde_json::Value, String> {
    let base_name = create_cache_filename(&track_id, &source_type, &source_hash);

    let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
    if let Some((bytes, total_opt)) = inflight.get(&base_name) {
        return Ok(serde_json::json!({
            "bytes_downloaded": *bytes,
            "total_bytes": total_opt,
            "inflight": true
        }));
    }

    Ok(serde_json::json!({ "inflight": false }))
}

#[tauri::command]
pub async fn cache_get_stats() -> Result<serde_json::Value, String> {
    let cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_ref() {
        let (total_size, entry_count) = cache.get_cache_stats();
        return Ok(serde_json::json!({
            "total_size_mb": total_size as f64 / (1024.0 * 1024.0),
            "entry_count": entry_count,
            "max_size_mb": MAX_CACHE_SIZE_MB
        }));
    }
    Err("Cache not initialized".to_string())
}

#[tauri::command]
pub async fn cache_clear() -> Result<(), String> {
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        cache.clear_cache()?;
        return Ok(());
    }
    Err("Cache not initialized".to_string())
}

// Enumerate current inflight downloads for UI sync
#[tauri::command]
pub async fn cache_list_inflight() -> Result<serde_json::Value, String> {
    let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
    let meta = INFLIGHT_META.lock().unwrap();
    let mut arr: Vec<serde_json::Value> = Vec::new();
    for (base, (bytes, total_opt)) in inflight.iter() {
        if let Some((track_id, source_type, source_hash)) = meta.get(base) {
            arr.push(serde_json::json!({
                "id": base,
                "trackId": track_id,
                "sourceType": source_type,
                "sourceHash": source_hash,
                "bytes_downloaded": bytes,
                "total_bytes": total_opt,
                "inflight": true
            }));
        } else {
            arr.push(serde_json::json!({
                "id": base,
                "bytes_downloaded": bytes,
                "total_bytes": total_opt,
                "inflight": true
            }));
        }
    }
    Ok(serde_json::json!({ "items": arr }))
}
