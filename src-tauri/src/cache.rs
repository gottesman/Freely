use std::path::{Path, PathBuf};
use std::fs;
use std::io::Write;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use once_cell::sync::Lazy;

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
                
                println!("[cache] Cache hit for track: {} ({}:{})", track_id, source_type, source_hash);
                return Some(file_path);
            } else {
                // File doesn't exist, remove from index
                println!("[cache] Cached file missing, removing from index: {} ({}:{})", track_id, source_type, source_hash);
                self.index.total_size = self.index.total_size.saturating_sub(entry.file_size);
                self.index.entries.remove(&cache_key);
                let _ = self.save_index();
            }
        }
        
        println!("[cache] Cache miss for track: {} ({}:{})", track_id, source_type, source_hash);
        None
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

// Global cache state
static CACHE: Lazy<Mutex<Option<AudioCache>>> = Lazy::new(|| Mutex::new(None));

// Initialize cache with app config directory
pub fn init_cache(app_config_dir: &Path) -> Result<(), String> {
    let mut cache = CACHE.lock().unwrap();
    *cache = Some(AudioCache::new(app_config_dir)?);
    println!("[cache] Audio cache initialized");
    Ok(())
}

// Tauri commands
#[tauri::command]
pub async fn cache_get_file(track_id: String, source_type: String, source_hash: String) -> Result<serde_json::Value, String> {
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        if let Some(file_path) = cache.get_cached_file(&track_id, &source_type, &source_hash) {
            println!("[cache] Found cached file for {}:{}:{} -> {}", track_id, source_type, source_hash, file_path.display());
            return Ok(serde_json::json!({
                "cached_path": file_path.to_string_lossy().to_string(),
                "exists": true
            }));
        }
    }
    println!("[cache] No cached file found for {}:{}:{}", track_id, source_type, source_hash);
    Ok(serde_json::json!({
        "cached_path": null,
        "exists": false
    }))
}

#[tauri::command]
pub async fn cache_download_and_store(track_id: String, source_type: String, source_hash: String, url: String) -> Result<String, String> {
    // Download the file first without holding the mutex
    println!("[cache] Starting download for track: {} ({}:{})", track_id, source_type, source_hash);
    
    let response = reqwest::get(&url).await
        .map_err(|e| format!("Failed to download audio: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let bytes = response.bytes().await
        .map_err(|e| format!("Failed to read response body: {}", e))?;
    
    // Now handle the cache operations with the downloaded data
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        let cache_key = AudioCache::generate_cache_key(&track_id, &source_type, &source_hash);
        
        // Generate filename based on cache key (sanitized for filesystem)
        let safe_key = cache_key.replace(":", "_").replace("/", "_").replace("\\", "_");
        let file_name = format!("{}.m4a", safe_key);
        let file_path = cache.cache_dir.join(&file_name);

        // Write to file
        let mut file = fs::File::create(&file_path)
            .map_err(|e| format!("Failed to create cache file: {}", e))?;
        
        file.write_all(&bytes)
            .map_err(|e| format!("Failed to write cache file: {}", e))?;

        let file_size = bytes.len() as u64;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Add to cache index
        let entry = CacheEntry {
            track_id: track_id.clone(),
            source_type: source_type.clone(),
            source_hash: source_hash.clone(),
            file_path: file_name,
            file_size,
            cached_at: now,
            last_accessed: now,
        };

        cache.index.entries.insert(cache_key, entry);
        cache.index.total_size += file_size;

        // Clean up old entries if cache is too large
        cache.cleanup_cache()?;

        // Save index
        cache.save_index()?;

        println!("[cache] Successfully cached track: {} ({}:{}) - {} bytes", track_id, source_type, source_hash, file_size);
        Ok(file_path.to_string_lossy().to_string())
    } else {
        Err("Cache not initialized".to_string())
    }
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
