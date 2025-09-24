use crate::downloads;
use crate::utils::resolve_audio_source;
use once_cell::sync::Lazy;
use reqwest;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::Manager;
use tokio::fs as tokio_fs;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::mpsc;

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
    // Optional audio format info (if known at cache time)
    pub codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub bits_per_sample: Option<u32>,
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
    pub fn new(cache_dir_path: &Path) -> Result<Self, String> {
        let cache_dir = cache_dir_path.to_path_buf();
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

    fn generate_cache_key_with_index(
        track_id: &str,
        source_type: &str,
        source_hash: &str,
        file_index: Option<usize>,
    ) -> String {
        if source_type == "torrent" && file_index.is_some() {
            format!(
                "{}:{}:{}:{}",
                track_id,
                source_type,
                source_hash,
                file_index.unwrap()
            )
        } else {
            format!("{}:{}:{}", track_id, source_type, source_hash)
        }
    }

    fn load_index(index_file: &Path) -> Result<CacheIndex, String> {
        let content = fs::read_to_string(index_file)
            .map_err(|e| format!("Failed to read cache index: {}", e))?;

        serde_json::from_str(&content).map_err(|e| format!("Failed to parse cache index: {}", e))
    }

    fn save_index(&self) -> Result<(), String> {
        let content = serde_json::to_string_pretty(&self.index)
            .map_err(|e| format!("Failed to serialize cache index: {}", e))?;

        fs::write(&self.index_file, content)
            .map_err(|e| format!("Failed to write cache index: {}", e))
    }

    pub fn get_cached_file_with_index(
        &mut self,
        track_id: &str,
        source_type: &str,
        source_hash: &str,
        file_index: Option<usize>,
    ) -> Option<PathBuf> {
        let cache_key =
            Self::generate_cache_key_with_index(track_id, source_type, source_hash, file_index);

        if let Some(entry) = self.index.entries.get_mut(&cache_key) {
            let file_path = self.cache_dir.join(&entry.file_path);

            // Check if file actually exists
            if file_path.exists() {
                // Update last accessed time
                entry.last_accessed = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();

                return Some(file_path);
            } else {
                // File doesn't exist, remove from index
                println!(
                    "[cache] Cached file missing, removing from index: {} ({}:{}) index {:?}",
                    track_id, source_type, source_hash, file_index
                );
                self.index.total_size = self.index.total_size.saturating_sub(entry.file_size);
                self.index.entries.remove(&cache_key);
                let _ = self.save_index();
            }
        }

        // Debounce frequent cache miss logs to avoid spamming when frontend polls repeatedly
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut recent = RECENT_MISSES.lock().unwrap();
        let last = recent.get(&cache_key).cloned().unwrap_or(0);
        if now_secs.saturating_sub(last) >= MISS_LOG_DEBOUNCE_SECS {
            println!(
                "[cache] Cache miss for track: {} ({}:{}) index {:?}",
                track_id, source_type, source_hash, file_index
            );
            recent.insert(cache_key.clone(), now_secs);
        }
        None
    }

    pub fn add_cached_file_with_index(
        &mut self,
        track_id: String,
        source_type: String,
        source_hash: String,
        file_path: String,
        file_size: u64,
        file_index: Option<usize>,
    ) -> Result<(), String> {
        self.add_cached_file_with_index_and_format(
            track_id,
            source_type,
            source_hash,
            file_path,
            file_size,
            file_index,
            None,
            None,
            None,
        )
    }

    pub fn add_cached_file_with_index_and_format(
        &mut self,
        track_id: String,
        source_type: String,
        source_hash: String,
        file_path: String,
        file_size: u64,
        file_index: Option<usize>,
        codec: Option<String>,
        sample_rate: Option<u32>,
        bits_per_sample: Option<u32>,
    ) -> Result<(), String> {
        let cache_key =
            Self::generate_cache_key_with_index(&track_id, &source_type, &source_hash, file_index);
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
            codec,
            sample_rate,
            bits_per_sample,
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

        // Remove entries that are too old in one pass
        let mut keys_to_remove: Vec<String> = self
            .index
            .entries
            .iter()
            .filter(|(_, entry)| now.saturating_sub(entry.cached_at) > max_age_seconds)
            .map(|(key, _)| key.clone())
            .collect();

        for cache_key in keys_to_remove {
            if let Some(entry) = self.index.entries.remove(&cache_key) {
                let file_path = self.cache_dir.join(&entry.file_path);
                if file_path.exists() {
                    let _ = fs::remove_file(file_path);
                }
                self.index.total_size = self.index.total_size.saturating_sub(entry.file_size);
                println!(
                    "[cache] Removed old cached file: {} ({}:{})",
                    entry.track_id, entry.source_type, entry.source_hash
                );
            }
        }

        // If still over size limit, remove least recently accessed files
        if self.index.total_size > max_size_bytes {
            // Sort by access time (oldest first) and collect with sizes
            let mut entries_by_access: Vec<(String, u64)> = self
                .index
                .entries
                .iter()
                .map(|(key, entry)| (key.clone(), entry.file_size))
                .collect();
            entries_by_access.sort_by(|a, b| {
                let entry_a = self.index.entries.get(&a.0).unwrap();
                let entry_b = self.index.entries.get(&b.0).unwrap();
                entry_a.last_accessed.cmp(&entry_b.last_accessed)
            });

            // Remove oldest entries until under size limit
            for (cache_key, file_size) in entries_by_access {
                if self.index.total_size <= max_size_bytes {
                    break;
                }
                if let Some(entry) = self.index.entries.remove(&cache_key) {
                    let file_path = self.cache_dir.join(&entry.file_path);
                    if file_path.exists() {
                        let _ = fs::remove_file(file_path);
                    }
                    self.index.total_size = self.index.total_size.saturating_sub(entry.file_size);
                    println!(
                        "[cache] Removed LRU cached file: {} ({}:{})",
                        entry.track_id, entry.source_type, entry.source_hash
                    );
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
    create_cache_filename_with_index(track_id, source_type, source_hash, None)
}

pub fn create_cache_filename_with_index(
    track_id: &str,
    source_type: &str,
    source_hash: &str,
    file_index: Option<usize>,
) -> String {
    let safe_track: String = track_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe_hash: String = source_hash
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();

    // Include file index for torrents to avoid cache conflicts
    if source_type == "torrent" && file_index.is_some() {
        let index = file_index.unwrap();
        let result = format!("{}_{}_{}_{}", safe_track, source_type, safe_hash, index);
        result
    } else {
        let result = format!("{}_{}_{}", safe_track, source_type, safe_hash);
        result
    }
}

// Global cache state
static CACHE: Lazy<Mutex<Option<AudioCache>>> = Lazy::new(|| Mutex::new(None));

// Track inflight downloads: map cache_key -> (bytes_written, optional_total_bytes)
static INFLIGHT_DOWNLOADS: Lazy<Mutex<HashMap<String, (u64, Option<u64>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
// Track inflight metadata to recover identifiers for UI listing: cache_key -> (track_id, source_type, source_hash)
static INFLIGHT_META: Lazy<Mutex<HashMap<String, (String, String, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

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
        println!(
            "[cache] Content too small to be audio: {} bytes",
            bytes.len()
        );
        return false;
    }

    // Check for HTML content (indicates error page)
    let content_start = &bytes[..std::cmp::min(bytes.len(), 512)];
    let content_str = String::from_utf8_lossy(content_start);

    if content_str.contains("<html")
        || content_str.contains("<HTML")
        || content_str.contains("<!DOCTYPE")
        || content_str.contains("doctype")
    {
        println!("[cache] Content appears to be HTML error page");
        return false;
    }

    // Check for common error messages in content
    if content_str.contains("Video unavailable")
        || content_str.contains("This video is unavailable")
        || content_str.contains("ERROR")
        || content_str.contains("error")
    {
        println!("[cache] Content contains error messages");
        return false;
    }

    // For M4A files, check if it starts with a valid header
    // M4A files typically start with 'ftyp' box after the first few bytes
    if bytes.len() > 8 {
        // Look for 'ftyp' box which is common in MP4/M4A files
        for i in 4..std::cmp::min(bytes.len() - 4, 64) {
            if &bytes[i..i + 4] == b"ftyp" {
                return true;
            }
        }
        // If we don't find ftyp, it might still be valid audio, so we'll be permissive
    }

    true
}

// Initialize cache with app config directory
pub fn init_cache(audio_cache_dir: &Path) -> Result<(), String> {
    let mut cache = CACHE.lock().unwrap();
    *cache = Some(AudioCache::new(audio_cache_dir)?);
    println!("[cache] Audio cache initialized at: {}", audio_cache_dir.display());
    Ok(())
}

/// Get a cached file path if it exists
pub fn get_cached_file_path(
    track_id: &str,
    source_type: &str,
    source_hash: &str,
) -> Option<PathBuf> {
    get_cached_file_path_with_index(track_id, source_type, source_hash, None)
}

/// Get a cached file path if it exists (with file index support for torrents)
pub fn get_cached_file_path_with_index(
    track_id: &str,
    source_type: &str,
    source_hash: &str,
    file_index: Option<usize>,
) -> Option<PathBuf> {
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        cache.get_cached_file_with_index(track_id, source_type, source_hash, file_index)
    } else {
        None
    }
}

/// Get the cache directory path
pub fn get_cache_dir() -> Option<PathBuf> {
    let cache_guard = CACHE.lock().unwrap();
    cache_guard.as_ref().map(|c| c.cache_dir.clone())
}

/// Add a cached file to the cache index (with file index support for torrents)
pub fn add_cached_file_to_index_with_index(
    track_id: String,
    source_type: String,
    source_hash: String,
    file_path: String,
    file_size: u64,
    file_index: Option<usize>,
) -> Result<(), String> {
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        cache.add_cached_file_with_index(
            track_id,
            source_type,
            source_hash,
            file_path,
            file_size,
            file_index,
        )
    } else {
        Err("Cache not initialized".to_string())
    }
}

/// Add a cached file to the cache index
pub fn add_cached_file_to_index(
    track_id: String,
    source_type: String,
    source_hash: String,
    file_path: String,
    file_size: u64,
) -> Result<(), String> {
    add_cached_file_to_index_with_index(
        track_id,
        source_type,
        source_hash,
        file_path,
        file_size,
        None,
    )
}

/// Add a cached file with optional format info
pub fn add_cached_file_to_index_with_format(
    track_id: String,
    source_type: String,
    source_hash: String,
    file_path: String,
    file_size: u64,
    file_index: Option<usize>,
    codec: Option<String>,
    sample_rate: Option<u32>,
    bits_per_sample: Option<u32>,
) -> Result<(), String> {
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        cache.add_cached_file_with_index_and_format(
            track_id,
            source_type,
            source_hash,
            file_path,
            file_size,
            file_index,
            codec,
            sample_rate,
            bits_per_sample,
        )
    } else {
        Err("Cache not initialized".to_string())
    }
}

// Return current inflight download status (bytes_downloaded, optional total) for a given key
pub fn get_inflight_status(
    track_id: &str,
    source_type: &str,
    source_hash: &str,
) -> Option<(u64, Option<u64>)> {
    let cache_key = create_cache_filename(track_id, source_type, source_hash);
    let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
    inflight.get(&cache_key).cloned()
}

// Return the expected final (extension-less) path for a given cache key, if the cache is initialized.
pub fn get_final_cache_path(
    track_id: &str,
    source_type: &str,
    source_hash: &str,
) -> Option<PathBuf> {
    let cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_ref() {
        let base = create_cache_filename(track_id, source_type, source_hash);
        return Some(cache.cache_dir.join(base));
    }
    None
}

// Tauri commands
#[tauri::command]
pub async fn cache_get_file(
    track_id: String,
    source_type: String,
    source_hash: String,
    file_index: Option<usize>,
) -> Result<serde_json::Value, String> {
    println!("[cache] cache_get_file called with: track_id='{}', source_type='{}', source_hash='{}', file_index={:?}", track_id, source_type, source_hash, file_index);
    // If we recently answered a miss for this key, return quickly to avoid repeated work
    let cache_key = AudioCache::generate_cache_key_with_index(
        &track_id,
        &source_type,
        &source_hash,
        file_index,
    );
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
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
        // Try to resolve entry and path together for returning extra metadata
        let entry_opt_key = AudioCache::generate_cache_key_with_index(
            &track_id,
            &source_type,
            &source_hash,
            file_index,
        );
        if let Some(entry) = cache.index.entries.get(&entry_opt_key).cloned() {
            let file_path = cache.cache_dir.join(&entry.file_path);
            if file_path.exists() {
                // Found a cached file; clear any negative cache entry and return with format metadata
                let mut neg = NEGATIVE_CACHE.lock().unwrap();
                neg.remove(&cache_key);
                println!(
                    "[cache] Found cached file for {}:{}:{} (index: {:?}) -> {}",
                    track_id,
                    source_type,
                    source_hash,
                    file_index,
                    file_path.display()
                );
                return Ok(serde_json::json!({
                    "cached_path": file_path.to_string_lossy().to_string(),
                    "exists": true,
                    "codec": entry.codec,
                    "sampleRate": entry.sample_rate,
                    "bitsPerSample": entry.bits_per_sample
                }));
            } else {
                // File missing -> drop from index
                println!(
                    "[cache] Cached file missing, removing from index: {} ({}:{}) index {:?}",
                    track_id, source_type, source_hash, file_index
                );
                cache.index.total_size = cache.index.total_size.saturating_sub(entry.file_size);
                cache.index.entries.remove(&entry_opt_key);
                let _ = cache.save_index();
            }
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
pub async fn cache_download_and_store(
    app: tauri::AppHandle,
    track_id: String,
    source_type: String,
    source_hash: String,
    url: String,
    file_index: Option<usize>,
) -> Result<String, String> {
    println!("[cache] cache_download_and_store called with track_id: '{}', source_type: '{}', source_hash: '{}', url: '{}', file_index: {:?}", track_id, source_type, source_hash, &url[..50.min(url.len())], file_index);

    let (tx, _rx) = mpsc::unbounded_channel::<CacheDownloadResult>();

    // spawn background task to avoid blocking the command
    let app_clone = app.clone();
    tokio::spawn(async move {
        // For torrent downloads, implement retry logic
        if source_type == "torrent" {
            let mut retry_count = 0;
            let max_retries = 10; // Try for up to 10 times
            let mut last_progress: Option<u64> = None; // Track progress between retries

            loop {
                println!(
                    "[cache] Torrent download attempt {} of {} for {}",
                    retry_count + 1,
                    max_retries,
                    track_id
                );

                // Check current progress before attempting download
                let current_progress = {
                    let cache_key = create_cache_filename_with_index(
                        &track_id,
                        &source_type,
                        &source_hash,
                        file_index,
                    );
                    let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                    inflight
                        .get(&cache_key)
                        .map(|(bytes, _)| *bytes)
                        .unwrap_or(0)
                };

                // If we have made progress since last attempt, reset retry count to be more patient
                if let Some(last_bytes) = last_progress {
                    if current_progress > last_bytes {
                        let progress_mb =
                            (current_progress - last_bytes) as f64 / (1024.0 * 1024.0);
                        println!("[cache] Progress detected: +{:.2}MB downloaded since last attempt, resetting retry patience", progress_mb);
                        retry_count = 0; // Reset retry count when we see progress
                    }
                }
                last_progress = Some(current_progress);

                download_and_cache_audio(
                    Some(app_clone.clone()),
                    track_id.clone(),
                    source_type.clone(),
                    source_hash.clone(),
                    url.clone(),
                    file_index,
                    tx.clone(),
                )
                .await;

                // Check if the file was successfully cached
                let cache_key = if file_index.is_some() {
                    format!(
                        "{}:{}:{}:{}",
                        track_id,
                        source_type,
                        source_hash,
                        file_index.unwrap()
                    )
                } else {
                    format!("{}:{}:{}", track_id, source_type, source_hash)
                };

                // Quick check if file exists in cache
                let is_cached = {
                    let mut cache = crate::cache::CACHE.lock().unwrap();
                    if let Some(cache_ref) = cache.as_mut() {
                        cache_ref
                            .get_cached_file_with_index(
                                &track_id,
                                &source_type,
                                &source_hash,
                                file_index,
                            )
                            .is_some()
                    } else {
                        false
                    }
                };

                if is_cached {
                    println!(
                        "[cache] Torrent download completed successfully for {}",
                        track_id
                    );
                    break;
                }

                // Check if we're making progress even if not complete
                let final_progress = {
                    let cache_key = create_cache_filename_with_index(
                        &track_id,
                        &source_type,
                        &source_hash,
                        file_index,
                    );
                    let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                    inflight
                        .get(&cache_key)
                        .map(|(bytes, _)| *bytes)
                        .unwrap_or(0)
                };

                // If file is actively downloading (has significant progress), be more patient
                if final_progress > 1024 * 1024 {
                    // More than 1MB downloaded
                    println!(
                        "[cache] Torrent has significant progress ({:.2}MB), extending patience",
                        final_progress as f64 / (1024.0 * 1024.0)
                    );
                    // Don't increment retry count if we have substantial data
                } else {
                    retry_count += 1;
                }

                if retry_count >= max_retries {
                    println!("[cache] Max retries exceeded for torrent download: {} (final progress: {:.2}MB)", track_id, final_progress as f64 / (1024.0 * 1024.0));
                    let _ = app_clone.emit(
                        "cache:download:error",
                        serde_json::json!({
                            "trackId": track_id,
                            "sourceType": source_type,
                            "sourceHash": source_hash,
                            "message": "Torrent download timeout after multiple retries"
                        }),
                    );
                    break;
                }

                // Wait before retrying (exponential backoff: 2, 4, 8, 16 seconds, then 30 seconds)
                let delay_secs = if retry_count <= 4 {
                    2_u64.pow(retry_count as u32)
                } else {
                    30
                };
                println!(
                    "[cache] Waiting {} seconds before retry for torrent: {}",
                    delay_secs, track_id
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
        } else {
            // Non-torrent downloads: single attempt
            download_and_cache_audio(
                Some(app_clone),
                track_id,
                source_type,
                source_hash,
                url,
                file_index,
                tx,
            )
            .await;
        }
    });

    // For compatibility, return immediately
    Ok("Download started".to_string())
}

pub async fn download_and_cache_audio(
    app: Option<tauri::AppHandle>,
    track_id: String,
    source_type: String,
    source_hash: String,
    url: String,
    file_index: Option<usize>,
    tx: mpsc::UnboundedSender<CacheDownloadResult>,
) {
    // Only log truncated URL to avoid excessive log verbosity
    println!("[cache] Starting download for {} ({}:{}) from: {}... (file_index: {:?})", 
        track_id, source_type, source_hash, &url[..50.min(url.len())], file_index);

    // Resolve the provided URL to a direct download URL when possible. This avoids
    // hitting the local streaming endpoint which may return HTML/error pages.
    let resolved = if source_type == "torrent" && file_index.is_some() {
        // For torrents with specific file index, construct the server URL directly
        let file_idx = file_index.unwrap();
        if url.starts_with("magnet:") {
            // Extract infoHash from magnet URI
            if let Some(start) = url.find("xt=urn:btih:") {
                let hash_start = start + 12;
                if let Some(end) = url[hash_start..].find('&') {
                    let info_hash = &url[hash_start..hash_start + end];
                    format!(
                        "http://localhost:9000/stream/{}/{}?magnet={}",
                        info_hash.to_lowercase(),
                        file_idx,
                        urlencoding::encode(&url)
                    )
                } else {
                    let info_hash = &url[hash_start..];
                    format!(
                        "http://localhost:9000/stream/{}/{}?magnet={}",
                        info_hash.to_lowercase(),
                        file_idx,
                        urlencoding::encode(&url)
                    )
                }
            } else {
                println!(
                    "[cache] Invalid magnet URI for torrent with file index: {}",
                    url
                );
                url.clone()
            }
        } else {
            // Assume it's already an infoHash
            format!(
                "http://localhost:9000/stream/{}/{}",
                url.to_lowercase(),
                file_idx
            )
        }
    } else {
        // Skip resolution for YouTube URLs that are already direct URLs (googlevideo.com, manifest URLs)
        // to avoid converting them to slow localhost streaming endpoints
        if source_type == "youtube" && (url.contains("googlevideo.com") || url.contains("youtube.com/api/manifest") || url.contains("manifest.googlevideo.com")) {
            println!("[cache] Using direct YouTube URL without resolution: {}", &url[..80.min(url.len())]);
            url.clone()
        } else {
            match resolve_audio_source(&source_type, &url).await {
                Ok(u) => {
                    // If the resolved URL is also a direct googlevideo.com URL, use it directly
                    if source_type == "youtube" && u.contains("googlevideo.com") {
                        println!("[cache] Using resolved direct YouTube CDN URL: {}", &u[..80.min(u.len())]);
                        u
                    } else {
                        u
                    }
                },
                Err(e) => {
                    println!("[cache] Failed to resolve source URL for {} ({}:{}): {}. Falling back to provided URL", track_id, source_type, source_hash, e);
                    url.clone()
                }
            }
        }
    };

    // Build a reqwest client tuned for long-running media downloads:
    // - No global request timeout (downloads can be long); use a short connect timeout instead
    // - Disable automatic body decompression to avoid "error decoding response body" when servers mislabel encodings
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .gzip(false)
        .brotli(false)
        .build()
        .unwrap();

    // Issue request (logging already done above)

    // Check if it's a localhost request and verify server is running
    if resolved.starts_with("http://localhost:9000") {
        if let Some(app_ref) = app.as_ref() {
            match app_ref
                .state::<crate::paths::PathConfig>()
                .get_server_status()
                .await
            {
                Ok(status) => {
                    let is_running = status.pid.is_some();
                    println!(
                        "[cache] Server status: running={}, pid={:?}, port={:?}",
                        is_running, status.pid, status.port
                    );
                    if !is_running {
                        println!(
                            "[cache] Server is not running, cannot download from localhost:9000"
                        );
                        if let Some(app_ref) = app.as_ref() {
                            let _ = app_ref.emit(
                                "cache:download:error",
                                serde_json::json!({
                                    "trackId": track_id,
                                    "sourceType": source_type,
                                    "sourceHash": source_hash,
                                    "message": "Torrent streaming server is not running"
                                }),
                            );
                        }
                        return;
                    }
                }
                Err(e) => {
                    println!("[cache] Server status check failed: {}", e);
                    if let Some(app_ref) = app.as_ref() {
                        let _ = app_ref.emit(
                            "cache:download:error",
                            serde_json::json!({
                                "trackId": track_id,
                                "sourceType": source_type,
                                "sourceHash": source_hash,
                                "message": format!("Server status check failed: {}", e)
                            }),
                        );
                    }
                    return;
                }
            }
        }
    }

    // Issue request with explicit identity encoding to receive raw bytes as-is
    let resp = match client
        .get(&resolved)
        .header("Accept-Encoding", "identity")
        .header(
            "User-Agent",
            // Stable UA to reduce chance of odd server responses
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
        )
        .send()
        .await
    {
        Ok(r) => {
            println!("[cache] HTTP request successful, status: {}", r.status());
            r
        }
        Err(e) => {
            println!(
                "[cache] Download request failed for {} ({}:{}): {}",
                track_id, source_type, source_hash, e
            );
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit(
                    "cache:download:error",
                    serde_json::json!({
                        "trackId": track_id,
                        "sourceType": source_type,
                        "sourceHash": source_hash,
                        "message": format!("Request failed: {}", e)
                    }),
                );
            }
            return;
        }
    };

    // Handle special case for torrents: 202 means file is downloading but not ready yet
    if resp.status() == 202 && source_type == "torrent" {
        println!(
            "[cache] Torrent file not ready yet (HTTP 202), will retry later for {} ({}:{})",
            track_id, source_type, source_hash
        );

        // Try to get progress information from the response
        if let Ok(response_text) = resp.text().await {
            if let Ok(response_json) = serde_json::from_str::<serde_json::Value>(&response_text) {
                if let Some(progress) = response_json.get("progress").and_then(|p| p.as_f64()) {
                    println!(
                        "[cache] Torrent file download progress: {:.2}%",
                        progress * 100.0
                    );
                }
            }
        }

        // Emit a specific event for torrent download in progress
        if let Some(app_ref) = app.as_ref() {
            let _ = app_ref.emit(
                "cache:download:progress",
                serde_json::json!({
                    "trackId": track_id,
                    "sourceType": source_type,
                    "sourceHash": source_hash,
                    "message": "Torrent file downloading, please wait...",
                    "status": "downloading"
                }),
            );
        }
        return;
    }

    if !resp.status().is_success() {
        println!(
            "[cache] Download failed with status {} for {} ({}:{})",
            resp.status(),
            track_id,
            source_type,
            source_hash
        );
        if let Some(app_ref) = app.as_ref() {
            let _ = app_ref.emit(
                "cache:download:error",
                serde_json::json!({
                    "trackId": track_id,
                    "sourceType": source_type,
                    "sourceHash": source_hash,
                    "message": format!("HTTP status {}", resp.status())
                }),
            );
        }
        return;
    }
    // Use shared helper for consistent base name
    let base_name =
        create_cache_filename_with_index(&track_id, &source_type, &source_hash, file_index);
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
            println!(
                "[cache] Cache not initialized, cannot cache {} ({}:{})",
                track_id, source_type, source_hash
            );
            return;
        }
    };

    let cache_path = cache_dir.join(&cache_file_name);
    let final_path = cache_dir.join(&base_name);

    // Stream response into part file while collecting initial bytes for validation
    // Capture content length before consuming the response
    let content_len_opt = resp.content_length();

    // Log a few headers to aid diagnostics when downloads fail
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let ce = resp
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let te = resp
        .headers()
        .get("transfer-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    println!(
        "[cache] Response headers: content-type='{}', content-encoding='{}', transfer-encoding='{}', content-length={:?}",
        ct, ce, te, content_len_opt
    );

    // Check for custom X-Expected-Length header for torrents using chunked encoding
    let expected_length_opt = resp
        .headers()
        .get("X-Expected-Length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    // Attempt to parse YouTube's 'clen' query parameter as a total size hint if needed
    let clen_from_url: Option<u64> = {
        if let Some(pos) = resolved.find("clen=") {
            let digits = resolved[pos + 5..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>();
            if !digits.is_empty() {
                digits.parse::<u64>().ok()
            } else {
                None
            }
        } else {
            None
        }
    };

    // Use expected length if content length is not available (for chunked transfers)
    let total_size_opt = content_len_opt.or(expected_length_opt).or(clen_from_url);

    if source_type == "torrent" && content_len_opt.is_none() && expected_length_opt.is_some() {
        println!(
            "[cache] Using expected length {} for chunked torrent transfer {} ({}:{})",
            expected_length_opt.unwrap(),
            track_id,
            source_type,
            source_hash
        );
    }

    let mut stream = resp.bytes_stream();

    // Open async file for writing with buffering (64KB buffer for better I/O performance)
    let mut file = match tokio_fs::File::create(&cache_path).await {
        Ok(f) => BufWriter::with_capacity(64 * 1024, f), // 64KB buffer
        Err(e) => {
            println!(
                "[cache] Failed to create cache file {:?}: {}",
                cache_path, e
            );
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit(
                    "cache:download:error",
                    serde_json::json!({
                        "trackId": track_id,
                        "sourceType": source_type,
                        "sourceHash": source_hash,
                        "message": format!("Failed to create cache file: {}", e)
                    }),
                );
            }
            return;
        }
    };

    const VALIDATION_BYTES: usize = 8192; // collect up to 8KB for validation
    let mut prefix_buf: Vec<u8> = Vec::with_capacity(VALIDATION_BYTES);
    let mut total_written: u64 = 0;
    let mut ready_emitted = false;
    #[allow(unused_assignments)]
    let mut download_complete = false; // Track if download completed successfully
    
    // Progress event throttling variables
    let mut last_progress_time = std::time::Instant::now();
    let mut last_progress_bytes = 0u64;
    const PROGRESS_TIME_THRESHOLD: std::time::Duration = std::time::Duration::from_millis(250);
    const PROGRESS_BYTES_THRESHOLD: u64 = 512 * 1024; // 512KB

    use futures_util::StreamExt;

    // Mark inflight
    {
        let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
        inflight.insert(base_name.clone(), (0u64, total_size_opt));
        let mut meta = INFLIGHT_META.lock().unwrap();
        meta.insert(
            base_name.clone(),
            (track_id.clone(), source_type.clone(), source_hash.clone()),
        );
    }

    // Emit initial progress event
    if let Some(app_ref) = app.as_ref() {
        let _ = app_ref.emit(
            "cache:download:progress",
            serde_json::json!({
                "trackId": track_id,
                "sourceType": source_type,
                "sourceHash": source_hash,
                "bytes_downloaded": 0u64,
                "total_bytes": total_size_opt,
                "inflight": true
            }),
        );
    }

    // For torrents, start a progress polling task to get real-time server-side progress
    let progress_task_handle = if source_type == "torrent" && file_index.is_some() {
        let track_id_clone = track_id.clone();
        let source_type_clone = source_type.clone();
        let source_hash_clone = source_hash.clone();
        let file_index_clone = file_index;
        let app_clone = app.clone();
        let base_name_clone = base_name.clone();

        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
            interval.tick().await; // Skip first tick (immediate)

            loop {
                interval.tick().await;

                // Poll server for progress
                if let Ok(client) = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                {
                    let progress_url = format!(
                        "http://localhost:9000/progress/{}/{}",
                        source_hash_clone,
                        file_index_clone.unwrap_or(0)
                    );

                    if let Ok(resp) = client.get(&progress_url).send().await {
                        if let Ok(progress_data) = resp.json::<serde_json::Value>().await {
                            if let Some(data) = progress_data.get("data") {
                                if let (Some(progress), Some(downloaded), Some(total)) = (
                                    data.get("progress").and_then(|v| v.as_f64()),
                                    data.get("downloaded").and_then(|v| v.as_u64()),
                                    data.get("total").and_then(|v| v.as_u64()),
                                ) {
                                    if let Some(app_ref) = app_clone.as_ref() {
                                        let _ = app_ref.emit(
                                            "cache:download:progress",
                                            serde_json::json!({
                                                "trackId": track_id_clone,
                                                "sourceType": source_type_clone,
                                                "sourceHash": source_hash_clone,
                                                "bytes_downloaded": downloaded,
                                                "total_bytes": total,
                                                "inflight": progress < 1.0, // Mark as inflight until 100% complete
                                                "source": "torrent_polling"
                                            }),
                                        );
                                    }

                                    // Stop polling when file is 100% complete
                                    if progress >= 1.0 {
                                        break;
                                    }
                                }
                            }
                        } else {
                            // If progress endpoint fails, check if download is still active
                            let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                            if !inflight.contains_key(&base_name_clone) {
                                break; // Download completed or cancelled
                            }
                        }
                    } else {
                        // If server request fails, check if download is still active
                        let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                        if !inflight.contains_key(&base_name_clone) {
                            break; // Download completed or cancelled
                        }
                    }
                }
            }
        }))
    } else {
        None
    };

    while let Some(item) = stream.next().await {
        // Respect pause/cancel controls
        if downloads::is_cancelled(&base_name) {
            println!(
                "[cache] Cancel requested for {} ({}:{})",
                track_id, source_type, source_hash
            );
            let _ = tokio_fs::remove_file(&cache_path).await;
            let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
            inflight.remove(&base_name);
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit(
                    "cache:download:error",
                    serde_json::json!({
                        "trackId": track_id,
                        "sourceType": source_type,
                        "sourceHash": source_hash,
                        "message": "cancelled"
                    }),
                );
            }
            // Clear control state
            downloads::clear_control(&base_name);
            return;
        }
        // If paused, wait until resumed or cancelled
        if downloads::is_paused(&base_name) {
            downloads::wait_while_paused_or_until_cancel(&base_name).await;
            if downloads::is_cancelled(&base_name) {
                continue;
            }
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
                    println!(
                        "[cache] Failed to write to part file {:?}: {}",
                        cache_path, e
                    );
                    let _ = tokio_fs::remove_file(&cache_path).await;
                    // clear inflight
                    let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                    inflight.remove(&base_name);
                    let mut meta = INFLIGHT_META.lock().unwrap();
                    meta.remove(&base_name);
                    if let Some(app_ref) = app.as_ref() {
                        let _ = app_ref.emit(
                            "cache:download:error",
                            serde_json::json!({
                                "trackId": track_id,
                                "sourceType": source_type,
                                "sourceHash": source_hash,
                                "message": format!("Write failed: {}", e)
                            }),
                        );
                    }
                    // Clear control state on error
                    downloads::clear_control(&base_name);
                    return;
                }
                total_written = total_written.saturating_add(chunk.len() as u64);
                
                // Emit a "ready" event as soon as we have enough validated prefix bytes
                if !ready_emitted && prefix_buf.len() >= 1024 {
                    if is_valid_audio_content(&prefix_buf) {
                        ready_emitted = true;
                        if let Some(app_ref) = app.as_ref() {
                            let tmp_path_str = cache_path.to_string_lossy().to_string();
                            let _ = app_ref.emit(
                                "cache:download:ready",
                                serde_json::json!({
                                    "trackId": track_id,
                                    "sourceType": source_type,
                                    "sourceHash": source_hash,
                                    "tmpPath": tmp_path_str,
                                    "bytes_downloaded": total_written,
                                    "total_bytes": total_size_opt,
                                    "inflight": true
                                }),
                            );
                        }
                    }
                }

                // Throttled progress and inflight updates - only update if enough time/bytes have passed
                let now = std::time::Instant::now();
                let time_since_last = now.duration_since(last_progress_time);
                let bytes_since_last = total_written.saturating_sub(last_progress_bytes);
                
                if time_since_last >= PROGRESS_TIME_THRESHOLD || bytes_since_last >= PROGRESS_BYTES_THRESHOLD {
                    // Update inflight bytes
                    {
                        let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                        if let Some(v) = inflight.get_mut(&base_name) {
                            v.0 = total_written;
                        }
                    }
                    
                    // emit progress event
                    if let Some(app_ref) = app.as_ref() {
                        let _ = app_ref.emit(
                            "cache:download:progress",
                            serde_json::json!({
                                "trackId": track_id,
                                "sourceType": source_type,
                                "sourceHash": source_hash,
                                "bytes_downloaded": total_written,
                                "total_bytes": total_size_opt,
                                "inflight": true
                            }),
                        );
                    }
                    
                    // Update throttling state
                    last_progress_time = now;
                    last_progress_bytes = total_written;
                }
            }
            Err(e) => {
                // For torrents with significant progress, don't immediately fail on streaming errors
                if source_type == "torrent" && total_written > 1024 * 1024 {
                    // More than 1MB downloaded
                    println!("[cache] Streaming error for torrent {} ({}:{}) but have {:.2}MB progress, preserving partial download: {}", 
                        track_id, source_type, source_hash, total_written as f64 / (1024.0 * 1024.0), e);

                    // Break from stream loop - download_complete remains false
                    // The partial file will be preserved but not marked as complete
                    break;
                } else {
                    println!(
                        "[cache] Error while streaming download for {} ({}:{}): {}",
                        track_id, source_type, source_hash, e
                    );
                    let _ = tokio_fs::remove_file(&cache_path).await;
                    let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                    inflight.remove(&base_name);
                    let mut meta = INFLIGHT_META.lock().unwrap();
                    meta.remove(&base_name);

                    // Cancel progress polling task
                    if let Some(handle) = progress_task_handle {
                        handle.abort();
                    }

                    if let Some(app_ref) = app.as_ref() {
                        let _ = app_ref.emit(
                            "cache:download:error",
                            serde_json::json!({
                                "trackId": track_id,
                                "sourceType": source_type,
                                "sourceHash": source_hash,
                                "message": format!("Streaming error: {}", e)
                            }),
                        );
                    }
                    // Clear control state on error
                    downloads::clear_control(&base_name);
                    return;
                }
            }
        }
    }

    // If we reach here, the stream ended normally - check if download is actually complete
    // For chunked transfers, server might close early even if not all data was sent
    if let Some(expected_size) = total_size_opt {
        println!(
            "[cache] Checking download completion: got {} bytes, expected {} bytes for {} ({}:{})",
            total_written, expected_size, track_id, source_type, source_hash
        );
        if total_written < expected_size {
            println!("[cache] Stream ended early - expected {} bytes but only got {} bytes for {} ({}:{})", 
                expected_size, total_written, track_id, source_type, source_hash);
            download_complete = false; // Treat as incomplete
        } else {
            download_complete = true; // Complete download
        }
    } else {
        // No content length or expected length available
        if source_type == "torrent" {
            println!("[cache] No size information available for torrent stream that ended normally - likely chunked transfer that ended early for {} ({}:{})", 
                track_id, source_type, source_hash);
            download_complete = false; // Treat torrent streams without size info as incomplete
        } else {
            println!(
                "[cache] No content length available, assuming complete for {} ({}:{})",
                track_id, source_type, source_hash
            );
            download_complete = true;
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

    // If download is not complete, handle as partial download
    if !download_complete {
        println!(
            "[cache] Partial download preserved for {} ({}:{}) - {:.2}MB downloaded",
            track_id,
            source_type,
            source_hash,
            total_written as f64 / (1024.0 * 1024.0)
        );

        // Clean up inflight tracking
        {
            let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
            inflight.remove(&base_name);
            let mut meta = INFLIGHT_META.lock().unwrap();
            meta.remove(&base_name);
        }

        // Cancel progress polling task
        if let Some(handle) = progress_task_handle {
            handle.abort();
        }

        // Clear control state
        downloads::clear_control(&base_name);

        // Don't mark as completed - preserve partial file for future retry
        // The partial file remains at cache_path for potential resume
        return;
    } // Validate collected prefix bytes
    if !is_valid_audio_content(&prefix_buf) {
        // For torrents with substantial progress, be more lenient on validation
        if source_type == "torrent" && total_written > 5 * 1024 * 1024 {
            // More than 5MB
            println!("[cache] Content validation failed for {} ({}:{}) but torrent has substantial progress ({:.2}MB), proceeding anyway", 
                track_id, source_type, source_hash, total_written as f64 / (1024.0 * 1024.0));
        } else {
            println!(
                "[cache] Downloaded content is not valid audio for {} ({}:{}), size: {} bytes",
                track_id, source_type, source_hash, total_written
            );
            let _ = tokio_fs::remove_file(&cache_path).await;
            let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
            inflight.remove(&base_name);
            let mut meta = INFLIGHT_META.lock().unwrap();
            meta.remove(&base_name);
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit(
                    "cache:download:error",
                    serde_json::json!({
                        "trackId": track_id,
                        "sourceType": source_type,
                        "sourceHash": source_hash,
                        "message": "Validation failed: content is not valid audio"
                    }),
                );
            }
            // Clear control on finalize error
            downloads::clear_control(&base_name);
            return;
        }
    }

    // Atomically rename temp file to final name
    if let Err(e) = tokio_fs::rename(&cache_path, &final_path).await {
        println!(
            "[cache] Failed to rename cache file to final cache file {:?} -> {:?}: {}",
            cache_path, final_path, e
        );

        // It's possible another concurrent task already moved/created the final file.
        // If the final file exists, treat this as success and ensure the index contains it.
        if final_path.exists() {
            println!("[cache] Final cache file already exists, assuming another worker completed the move: {:?}", final_path);

            // Obtain file size from the existing final file
            let file_size = match tokio_fs::metadata(&final_path).await {
                Ok(meta) => meta.len(),
                Err(err) => {
                    println!(
                        "[cache] Failed to stat existing final file {:?}: {}",
                        final_path, err
                    );
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
                    let cache_key = AudioCache::generate_cache_key_with_index(
                        &track_id,
                        &source_type,
                        &source_hash,
                        file_index,
                    );
                    if !cache.index.entries.contains_key(&cache_key) {
                        if let Err(e) = cache.add_cached_file_with_index(
                            track_id.clone(),
                            source_type.clone(),
                            source_hash.clone(),
                            base_name.clone(),
                            file_size,
                            file_index,
                        ) {
                            add_failed = Some(e);
                        }
                    }
                }
            }

            if let Some(e) = add_failed {
                println!(
                    "[cache] Failed to add existing final file to index for {} ({}:{}): {}",
                    track_id, source_type, source_hash, e
                );
                // Nothing else we can do; clean up cache file and return
                let _ = tokio_fs::remove_file(&cache_path).await;
                let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                inflight.remove(&base_name);
                let mut meta = INFLIGHT_META.lock().unwrap();
                meta.remove(&base_name);

                if let Some(app_ref) = app.as_ref() {
                    let _ = app_ref.emit(
                        "cache:download:error",
                        serde_json::json!({
                            "trackId": track_id,
                            "sourceType": source_type,
                            "sourceHash": source_hash,
                            "message": format!("Failed to add cache index: {}", e)
                        }),
                    );
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
                println!(
                    "[cache] Failed to send cache completion notification for {} ({}:{}): {}",
                    track_id, source_type, source_hash, e
                );
            } else {
                println!(
                    "[cache] Cache download completed (race-resolved) for {} ({}:{}) -> {}",
                    track_id, source_type, source_hash, cached_path
                );
            }

            // emit complete event
            if let Some(app_ref) = app.as_ref() {
                let _ = app_ref.emit(
                    "cache:download:complete",
                    serde_json::json!({
                        "trackId": track_id,
                        "sourceType": source_type,
                        "sourceHash": source_hash,
                        "cachedPath": cached_path,
                        "fileSize": file_size
                    }),
                );
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
            let _ = app_ref.emit(
                "cache:download:error",
                serde_json::json!({
                    "trackId": track_id,
                    "sourceType": source_type,
                    "sourceHash": source_hash,
                    "message": "Failed to finalize cache file"
                }),
            );
        }
        return;
    }

    let file_size = total_written;

    // Add to cache index under lock
    {
        let mut cache_guard = CACHE.lock().unwrap();
        if let Some(cache) = cache_guard.as_mut() {
            if let Err(e) = cache.add_cached_file_with_index(
                track_id.clone(),
                source_type.clone(),
                source_hash.clone(),
                base_name.clone(),
                file_size,
                file_index,
            ) {
                println!(
                    "[cache] Failed to add to cache index for {} ({}:{}): {}",
                    track_id, source_type, source_hash, e
                );
                // On failure remove the cached file
                let _ = std::fs::remove_file(&final_path);
                let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
                inflight.remove(&base_name);
                // Clear control on index add failure
                downloads::clear_control(&base_name);
                return;
            }
        } else {
            println!(
                "[cache] Cache not initialized during finalization, removing file: {:?}",
                final_path
            );
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
        println!(
            "[cache] Failed to send cache completion notification for {} ({}:{}): {}",
            track_id, source_type, source_hash, e
        );
    } else {
        println!(
            "[cache] Cache download completed for {} ({}:{}) -> {}",
            track_id, source_type, source_hash, cached_path
        );
    }

    // emit complete event
    if let Some(app_ref) = app.as_ref() {
        let _ = app_ref.emit(
            "cache:download:complete",
            serde_json::json!({
                "trackId": track_id,
                "sourceType": source_type,
                "sourceHash": source_hash,
                "cachedPath": cached_path,
                "fileSize": file_size
            }),
        );
    }

    // clear inflight
    {
        let mut inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
        inflight.remove(&base_name);
        let mut meta = INFLIGHT_META.lock().unwrap();
        meta.remove(&base_name);
    }

    // Cancel progress polling task
    if let Some(handle) = progress_task_handle {
        handle.abort();
    }

    // Clear control on success
    downloads::clear_control(&base_name);
}

#[tauri::command]
pub async fn cache_download_status(
    track_id: String,
    source_type: String,
    source_hash: String,
    file_index: Option<usize>,
) -> Result<serde_json::Value, String> {
    /*
    println!(
        "[cache] cache_download_status called with: track_id='{}', source_type='{}', source_hash='{}', file_index={:?}",
        track_id, source_type, source_hash, file_index
    );
    */
    // Prefer the index-aware key for torrents/multi-file sources
    let key_with_index =
        create_cache_filename_with_index(&track_id, &source_type, &source_hash, file_index);
    let key_without_index = create_cache_filename(&track_id, &source_type, &source_hash);

    let inflight = INFLIGHT_DOWNLOADS.lock().unwrap();
    if let Some((bytes, total_opt)) = inflight.get(&key_with_index) {
        // Copy values out before releasing the lock
        let (b, t) = (*bytes, *total_opt);
        drop(inflight);
        // Also check if final file already exists (race resolution)
        if let Some(path) =
            get_cached_file_path_with_index(&track_id, &source_type, &source_hash, file_index)
        {
            if path.exists() {
                return Ok(serde_json::json!({
                    "bytes_downloaded": b,
                    "total_bytes": t,
                    "inflight": false,
                    "completed": true
                }));
            }
        }
        return Ok(serde_json::json!({
            "bytes_downloaded": b,
            "total_bytes": t,
            "inflight": true
        }));
    }

    // Backward-compatibility: some callers may query without index; try the non-indexed key too
    if let Some((bytes, total_opt)) = inflight.get(&key_without_index) {
        // Copy values out before releasing the lock
        let (b, t) = (*bytes, *total_opt);
        drop(inflight);
        if let Some(path) =
            get_cached_file_path_with_index(&track_id, &source_type, &source_hash, file_index)
        {
            if path.exists() {
                return Ok(serde_json::json!({
                    "bytes_downloaded": b,
                    "total_bytes": t,
                    "inflight": false,
                    "completed": true
                }));
            }
        }
        return Ok(serde_json::json!({
            "bytes_downloaded": b,
            "total_bytes": t,
            "inflight": true
        }));
    }

    // Not inflight; check if completed exists
    if let Some(path) =
        get_cached_file_path_with_index(&track_id, &source_type, &source_hash, file_index)
    {
        if path.exists() {
            return Ok(serde_json::json!({ "inflight": false, "completed": true }));
        }
    }

    Ok(serde_json::json!({ "inflight": false, "completed": false }))
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
