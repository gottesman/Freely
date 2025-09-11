use anyhow::Result;
use once_cell::sync::Lazy;
use std::{sync::Mutex, time::{Instant, Duration}, ffi::{CString, CStr, c_void}};
use std::os::raw::{c_int, c_char, c_uint, c_ulong};
use libloading::{Library, Symbol};
use std::path::{Path, PathBuf};
use std::fs;
use std::io::Write;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use reqwest;

struct PlaybackState {
    url: Option<String>,
    stream: Option<u32>,
    playing: bool,
    started_at: Option<Instant>,
    paused_at: Option<Instant>,
    accumulated_paused: Duration,
    duration: Option<f64>,
    seek_offset: f64,
    ended: bool,
    last_error: Option<String>,
    bass_lib: Option<Library>,
    bass_initialized: bool,
    // Volume control
    volume: f32,
    muted: bool,
    volume_before_mute: f32,
    // Cache-related fields
    current_track_id: Option<String>,
    current_source_type: Option<String>,
    current_source_hash: Option<String>,
    cache_download_tx: Option<mpsc::UnboundedSender<CacheDownloadResult>>,
}

impl PlaybackState { 
    fn new() -> Self { 
        Self { 
            url: None, 
            stream: None, 
            playing: false, 
            started_at: None, 
            paused_at: None, 
            accumulated_paused: Duration::ZERO, 
            duration: None, 
            seek_offset: 0.0, 
            ended: false, 
            last_error: None, 
            bass_lib: None,
            bass_initialized: false,
            // Volume control - default to 50% volume
            volume: 0.5,
            muted: false,
            volume_before_mute: 0.5,
            // Cache-related fields
            current_track_id: None,
            current_source_type: None,
            current_source_hash: None,
            cache_download_tx: None,
        } 
    } 
}

static STATE: Lazy<Mutex<PlaybackState>> = Lazy::new(|| Mutex::new(PlaybackState::new()));

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

    pub fn add_cached_file(&mut self, track_id: String, source_type: String, source_hash: String, file_path: String, file_size: u64) -> Result<(), String> {
        let cache_key = Self::generate_cache_key(&track_id, &source_type, &source_hash);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Add to cache index
        let entry = CacheEntry {
            track_id: track_id.clone(),
            source_type: source_type.clone(),
            source_hash: source_hash.clone(),
            file_path: file_path.clone(),
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

        println!("[cache] Successfully cached track: {} ({}:{}) - {} bytes", track_id, source_type, source_hash, file_size);
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

#[derive(Debug)]
struct CacheDownloadResult {
    track_id: String,
    source_type: String,
    source_hash: String,
    cached_path: String,
    file_size: u64,
}

async fn download_and_cache_audio(track_id: String, source_type: String, source_hash: String, url: String, tx: mpsc::UnboundedSender<CacheDownloadResult>) {
    println!("[cache] Starting download for track: {} ({}:{})", track_id, source_type, source_hash);

    // Download the file
    let response = match reqwest::get(&url).await {
        Ok(resp) => resp,
        Err(e) => {
            println!("[cache] Download failed for {} ({}:{}): {}", track_id, source_type, source_hash, e);
            return;
        }
    };

    if !response.status().is_success() {
        println!("[cache] Download failed with status {} for {} ({}:{})", response.status(), track_id, source_type, source_hash);
        return;
    }

    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            println!("[cache] Failed to read response body for {} ({}:{}): {}", track_id, source_type, source_hash, e);
            return;
        }
    };

    // Handle the cache operations with the downloaded data
    let mut cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_mut() {
        let cache_key = AudioCache::generate_cache_key(&track_id, &source_type, &source_hash);

        // Generate filename based on cache key (sanitized for filesystem)
        let safe_key = cache_key.replace(":", "_").replace("/", "_").replace("\\", "_");
        let file_name = format!("{}.m4a", safe_key);
        let file_path = cache.cache_dir.join(&file_name);

        // Write to file
        let mut file = match fs::File::create(&file_path) {
            Ok(f) => f,
            Err(e) => {
                println!("[cache] Failed to create cache file for {} ({}:{}): {}", track_id, source_type, source_hash, e);
                return;
            }
        };

        if let Err(e) = file.write_all(&bytes) {
            println!("[cache] Failed to write cache file for {} ({}:{}): {}", track_id, source_type, source_hash, e);
            return;
        }

        let file_size = bytes.len() as u64;

        // Add to cache index
        if let Err(e) = cache.add_cached_file(track_id.clone(), source_type.clone(), source_hash.clone(), file_name, file_size) {
            println!("[cache] Failed to add to cache index for {} ({}:{}): {}", track_id, source_type, source_hash, e);
            return;
        }

        let cached_path = file_path.to_string_lossy().to_string();

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
    } else {
        println!("[cache] Cache not initialized, cannot cache {} ({}:{})", track_id, source_type, source_hash);
    }
}

// SAFETY: We mark PlaybackState as Send because we guard all access behind a Mutex and only manipulate
// BASS objects on the threads invoking the tauri commands. This is a simplification; for production
// consider a single dedicated audio thread and message passing instead of unsafe impls.
unsafe impl Send for PlaybackState {}

// BASS function type definitions
type BassInit = unsafe extern "system" fn(device: c_int, freq: c_uint, flags: c_uint, win: *mut c_void, dsguid: *mut c_void) -> c_int;
type BassFree = unsafe extern "system" fn() -> c_int;
type BassSetConfig = unsafe extern "system" fn(option: c_uint, value: c_uint) -> c_uint;
type BassPluginLoad = unsafe extern "system" fn(file: *const c_char, flags: c_uint) -> u32;
type BassStreamCreateFile = unsafe extern "system" fn(mem: c_int, file: *const c_void, offset: c_ulong, length: c_ulong, flags: c_uint) -> u32;
type BassStreamCreateUrl = unsafe extern "system" fn(url: *const c_char, offset: c_ulong, flags: c_uint, proc_: *mut c_void, user: *mut c_void) -> u32;
type BassStreamFree = unsafe extern "system" fn(handle: u32) -> c_int;
type BassChannelPlay = unsafe extern "system" fn(handle: u32, restart: c_int) -> c_int;
type BassChannelPause = unsafe extern "system" fn(handle: u32) -> c_int;
type BassChannelStop = unsafe extern "system" fn(handle: u32) -> c_int;
type BassChannelIsActive = unsafe extern "system" fn(handle: u32) -> c_uint;
type BassChannelGetLength = unsafe extern "system" fn(handle: u32, mode: c_uint) -> c_ulong;
type BassChannelGetPosition = unsafe extern "system" fn(handle: u32, mode: c_uint) -> c_ulong;
type BassChannelBytes2Seconds = unsafe extern "system" fn(handle: u32, pos: c_ulong) -> f64;
type BassChannelSeconds2Bytes = unsafe extern "system" fn(handle: u32, sec: f64) -> c_ulong;
type BassChannelSetPosition = unsafe extern "system" fn(handle: u32, pos: c_ulong, mode: c_uint) -> c_int;
type BassErrorGetCode = unsafe extern "system" fn() -> c_int;
type BassChannelGetAttribute = unsafe extern "system" fn(handle: u32, attrib: c_uint, value: *mut f32) -> c_int;
type BassChannelSetAttribute = unsafe extern "system" fn(handle: u32, attrib: c_uint, value: f32) -> c_int;
type BassGetVolume = unsafe extern "system" fn() -> f32;
type BassSetVolume = unsafe extern "system" fn(volume: f32) -> c_int;
type BassGetDeviceInfo = unsafe extern "system" fn(device: c_uint, info: *mut BassDeviceInfo) -> c_int;
type BassGetInfo = unsafe extern "system" fn(info: *mut BassInfo) -> c_int;
type BassGetDevice = unsafe extern "system" fn() -> c_uint;

// BASS constants
#[allow(dead_code)]
const BASS_OK: c_int = 0;
#[allow(dead_code)]
const BASS_ERROR_INIT: c_int = 2;
#[allow(dead_code)]
const BASS_ERROR_NOTAVAIL: c_int = 37;
#[allow(dead_code)]
const BASS_ERROR_CREATE: c_int = 5;
#[allow(dead_code)]
const BASS_ERROR_FILEOPEN: c_int = 2;

const BASS_DEVICE_DEFAULT: c_int = -1;
#[allow(dead_code)]
const BASS_CONFIG_NET_TIMEOUT: c_uint = 11;
#[allow(dead_code)]
const BASS_CONFIG_NET_AGENT: c_uint = 16;

#[allow(dead_code)]
const BASS_STREAM_BLOCK: c_uint = 0x100000;
const BASS_STREAM_STATUS: c_uint = 0x800000;
const BASS_STREAM_AUTOFREE: c_uint = 0x40000;

const BASS_POS_BYTE: c_uint = 0;
const BASS_ACTIVE_STOPPED: c_uint = 0;
#[allow(dead_code)]
const BASS_ACTIVE_PLAYING: c_uint = 1;
#[allow(dead_code)]
const BASS_ACTIVE_STALLED: c_uint = 2;
#[allow(dead_code)]
const BASS_ACTIVE_PAUSED: c_uint = 3;

// Volume attributes
const BASS_ATTRIB_VOL: c_uint = 2;

// Device flags
const BASS_DEVICE_ENABLED: c_uint = 1;
const BASS_DEVICE_DEFAULT_FLAG: c_uint = 2;
const BASS_DEVICE_INIT: c_uint = 4;

// BASS device info structure
#[repr(C)]
#[derive(Debug)]
struct BassDeviceInfo {
    name: *const c_char,
    driver: *const c_char, 
    flags: c_uint,
}

// BASS info structure for current audio settings
#[repr(C)]
#[derive(Debug)]
struct BassInfo {
    flags: c_uint,          // device capabilities (DSCAPS_xxx flags)
    hwsize: c_uint,         // size of total device hardware buffer
    hwfree: c_uint,         // size of free device hardware buffer
    freesam: c_uint,        // number of free sample slots in the hardware
    free3d: c_uint,         // number of free 3D sample slots in the hardware
    minrate: c_uint,        // min sample rate supported by the hardware
    maxrate: c_uint,        // max sample rate supported by the hardware
    eax: c_int,             // device supports EAX? (always FALSE if BASS_DEVICE_3D was not used)
    minbuf: c_uint,         // recommended minimum buffer length in ms
    dsver: c_uint,          // DirectSound version
    latency: c_uint,        // delay (in ms) before start of playback
    initflags: c_uint,      // BASS_Init "flags" parameter
    speakers: c_uint,       // number of speakers available
    freq: c_uint,           // current output sample rate
}

// Dynamic loading helper functions
fn load_bass_library() -> Result<Library, String> {
    // Try to load BASS DLL from different locations
    let possible_paths = [
        "bass.dll",
        "./bass.dll", 
        "./bin/bass.dll",
        "bin/bass.dll",
    ];
    
    for path in &possible_paths {
        if let Ok(lib) = unsafe { Library::new(path) } {
            return Ok(lib);
        }
    }
    
    Err("Could not load bass.dll. Make sure the BASS library is available.".to_string())
}

fn ensure_bass_loaded(state: &mut PlaybackState) -> Result<(), String> {
    if state.bass_lib.is_none() {
        let lib = load_bass_library()?;
        
        // Test that we can load a basic function to verify the library is valid
        unsafe {
            let _: Symbol<BassErrorGetCode> = lib.get(b"BASS_ErrorGetCode")
                .map_err(|_| "Invalid BASS library: missing BASS_ErrorGetCode function")?;
        }
        
        state.bass_lib = Some(lib);
        
        // Load plugins after BASS is initialized
        load_bass_plugins(state)?;
    }
    Ok(())
}

fn load_bass_plugins(state: &mut PlaybackState) -> Result<(), String> {
    let lib = state.bass_lib.as_ref().unwrap();
    
    // Load BASS_PluginLoad function
    let bass_plugin_load: Symbol<BassPluginLoad> = unsafe {
        match lib.get(b"BASS_PluginLoad") {
            Ok(func) => func,
            Err(_) => {
                println!("[bass] Warning: BASS_PluginLoad not available, plugins won't be loaded");
                return Ok(());
            }
        }
    };
    
    // List of plugins to try loading with their paths
    let plugin_configs = [
        ("bass_aac.dll", vec!["bass_aac.dll", "./bin/bass_aac.dll", "bin/bass_aac.dll"]),
        ("bassflac.dll", vec!["bassflac.dll", "./bin/bassflac.dll", "bin/bassflac.dll"]),
        ("bassopus.dll", vec!["bassopus.dll", "./bin/bassopus.dll", "bin/bassopus.dll"]),
    ];
    
    for (plugin_name, paths) in &plugin_configs {
        for path in paths {
            let c_path = match CString::new(*path) {
                Ok(p) => p,
                Err(_) => continue,
            };
            
            let result = unsafe { bass_plugin_load(c_path.as_ptr(), 0) };
            if result != 0 {
                println!("[bass] Loaded plugin: {} (handle: {})", plugin_name, result);
                break;
            }
        }
    }
    
    Ok(())
}

fn bass_err(lib: &Library) -> String { 
    let get_error_code = unsafe {
        match lib.get::<BassErrorGetCode>(b"BASS_ErrorGetCode") {
            Ok(func) => func,
            Err(_) => return "Could not get BASS_ErrorGetCode function".to_string(),
        }
    };
    
    let code = unsafe { get_error_code() };
    match code {
        1 => "BASS_ERROR_MEM: Memory error".to_string(),
        2 => "BASS_ERROR_FILEOPEN: Can't open the file".to_string(),
        3 => "BASS_ERROR_DRIVER: Can't find a free/valid driver".to_string(),
        4 => "BASS_ERROR_BUFLOST: The sample buffer was lost".to_string(),
        5 => "BASS_ERROR_HANDLE: Invalid handle".to_string(),
        6 => "BASS_ERROR_FORMAT: Unsupported sample format".to_string(),
        7 => "BASS_ERROR_POSITION: Invalid position".to_string(),
        8 => "BASS_ERROR_INIT: BASS_Init has not been successfully called".to_string(),
        9 => "BASS_ERROR_START: BASS_Start has not been successfully called".to_string(),
        14 => "BASS_ERROR_ALREADY: Already initialized/paused/whatever".to_string(),
        18 => "BASS_ERROR_NOCHAN: Can't get a free channel".to_string(),
        19 => "BASS_ERROR_ILLTYPE: An illegal type was specified".to_string(),
        20 => "BASS_ERROR_ILLPARAM: An illegal parameter was specified".to_string(),
        21 => "BASS_ERROR_NO3D: No 3D support".to_string(),
        22 => "BASS_ERROR_NOEAX: No EAX support".to_string(),
        23 => "BASS_ERROR_DEVICE: Illegal device number".to_string(),
        24 => "BASS_ERROR_NOPLAY: Not playing".to_string(),
        25 => "BASS_ERROR_FREQ: Illegal sample rate".to_string(),
        27 => "BASS_ERROR_NOTFILE: The stream is not a file stream".to_string(),
        29 => "BASS_ERROR_NOHW: No hardware voices available".to_string(),
        31 => "BASS_ERROR_EMPTY: The MOD music has no sequence data".to_string(),
        32 => "BASS_ERROR_NONET: No internet connection could be opened".to_string(),
        33 => "BASS_ERROR_CREATE: Couldn't create the file".to_string(),
        34 => "BASS_ERROR_NOFX: Effects are not available".to_string(),
        37 => "BASS_ERROR_NOTAVAIL: Requested data is not available".to_string(),
        38 => "BASS_ERROR_DECODE: The channel is/isn't a 'decoding channel'".to_string(),
        39 => "BASS_ERROR_DX: A sufficient DirectX version is not installed".to_string(),
        40 => "BASS_ERROR_TIMEOUT: Connection timedout".to_string(),
        41 => "BASS_ERROR_FILEFORM: Unsupported file format".to_string(),
        42 => "BASS_ERROR_SPEAKER: Unavailable speaker".to_string(),
        43 => "BASS_ERROR_VERSION: Invalid BASS version (used by add-ons)".to_string(),
        44 => "BASS_ERROR_CODEC: Codec is not available/supported".to_string(),
        45 => "BASS_ERROR_ENDED: The channel/file has ended".to_string(),
        46 => "BASS_ERROR_BUSY: The device is busy".to_string(),
        47 => "BASS_ERROR_UNSTREAMABLE: Unstreamable file".to_string(),
        48 => "BASS_ERROR_WASAPI: WASAPI is not available".to_string(),
        _ => format!("BASS unknown error {}", code),
    }
}

fn probe_duration_bass(lib: &Library, handle: u32) -> Option<f64> {
    unsafe {
        let get_length: Symbol<BassChannelGetLength> = lib.get(b"BASS_ChannelGetLength").ok()?;
        let bytes_to_seconds: Symbol<BassChannelBytes2Seconds> = lib.get(b"BASS_ChannelBytes2Seconds").ok()?;
        
        let len_bytes = get_length(handle, BASS_POS_BYTE);
        // BASS returns -1 (0xFFFFFFFF as c_ulong) on error
        if len_bytes == 0xFFFFFFFF || len_bytes == 0 { 
            return None; 
        }
        let secs = bytes_to_seconds(handle, len_bytes);
        if secs.is_finite() && secs > 0.1 { 
            Some(secs) 
        } else { 
            None 
        }
    }
}

#[tauri::command]
pub async fn playback_start(url: String) -> Result<serde_json::Value, String> {
    println!("[bass] playback_start called with URL: {}", url);
    
    // Check if this is a YouTube URL that might have a cached version
    let actual_url = if url.contains("googlevideo.com") {
        // Try to extract track ID from context or use URL hash as fallback
        // For now, we'll use the URL directly since we don't have track context here
        // The frontend should handle cache checking before calling playback_start
        url
    } else {
        url
    };
    
    let mut st = STATE.lock().unwrap();
    
    // Ensure BASS library is loaded
    println!("[bass] Ensuring BASS library is loaded...");
    match ensure_bass_loaded(&mut st) {
        Ok(_) => println!("[bass] BASS library loaded successfully"),
        Err(e) => {
            println!("[bass] Failed to load BASS library: {}", e);
            return Err(e);
        }
    }
    
    // Clone the library reference to avoid borrow checker issues
    let lib_ptr = st.bass_lib.as_ref().unwrap() as *const Library;
    let lib = unsafe { &*lib_ptr };
    
    // Load required functions
    let bass_init: Symbol<BassInit> = unsafe { 
        lib.get(b"BASS_Init").map_err(|_| "Could not load BASS_Init")? 
    };
    let bass_set_config: Symbol<BassSetConfig> = unsafe { 
        lib.get(b"BASS_SetConfig").map_err(|_| "Could not load BASS_SetConfig")? 
    };
    let bass_stream_create_url: Symbol<BassStreamCreateUrl> = unsafe { 
        lib.get(b"BASS_StreamCreateURL").map_err(|_| "Could not load BASS_StreamCreateURL")? 
    };
    let bass_stream_create_file: Symbol<BassStreamCreateFile> = unsafe { 
        lib.get(b"BASS_StreamCreateFile").map_err(|_| "Could not load BASS_StreamCreateFile")? 
    };
    let bass_stream_free: Symbol<BassStreamFree> = unsafe { 
        lib.get(b"BASS_StreamFree").map_err(|_| "Could not load BASS_StreamFree")? 
    };
    let bass_channel_play: Symbol<BassChannelPlay> = unsafe { 
        lib.get(b"BASS_ChannelPlay").map_err(|_| "Could not load BASS_ChannelPlay")? 
    };
    let bass_channel_stop: Symbol<BassChannelStop> = unsafe { 
        lib.get(b"BASS_ChannelStop").map_err(|_| "Could not load BASS_ChannelStop")? 
    };
    let bass_channel_seconds_to_bytes: Symbol<BassChannelSeconds2Bytes> = unsafe { 
        lib.get(b"BASS_ChannelSeconds2Bytes").map_err(|_| "Could not load BASS_ChannelSeconds2Bytes")? 
    };
    let bass_channel_set_position: Symbol<BassChannelSetPosition> = unsafe { 
        lib.get(b"BASS_ChannelSetPosition").map_err(|_| "Could not load BASS_ChannelSetPosition")? 
    };
    
    // Initialize BASS (only once)
    if !st.bass_initialized {
        println!("[bass] Initializing BASS audio system...");
        let ok = unsafe { bass_init(BASS_DEVICE_DEFAULT, 44100, 0, std::ptr::null_mut(), std::ptr::null_mut()) };
        if ok == 0 { 
            let error_code = unsafe {
                let get_error: Symbol<BassErrorGetCode> = lib.get(b"BASS_ErrorGetCode")
                    .map_err(|_| "Could not get BASS_ErrorGetCode function")?;
                get_error()
            };
            
            // Error 14 (BASS_ERROR_ALREADY) means BASS is already initialized, which is fine
            // Error 48 (BASS_ERROR_WASAPI) might indicate audio device issues
            if error_code == 14 {
                println!("[bass] BASS already initialized (this is fine)");
                st.bass_initialized = true;
            } else if error_code == 48 {
                println!("[bass] WASAPI error detected, attempting fallback initialization...");
                // Try different sample rate
                let fallback_ok = unsafe { bass_init(BASS_DEVICE_DEFAULT, 48000, 0, std::ptr::null_mut(), std::ptr::null_mut()) };
                if fallback_ok == 0 {
                    let fallback_error = bass_err(lib);
                    println!("[bass] Fallback initialization also failed: {}", fallback_error);
                    st.last_error = Some(format!("Audio device initialization failed: {}", fallback_error)); 
                    return Err(format!("Audio device initialization failed: {}", fallback_error));
                } else {
                    println!("[bass] Fallback initialization successful at 48kHz");
                    st.bass_initialized = true;
                }
            } else {
                let error = bass_err(lib);
                println!("[bass] BASS initialization failed: {}", error);
                st.last_error = Some(error.clone()); 
                return Err(error);
            }
        } else {
            println!("[bass] BASS initialized successfully");
            st.bass_initialized = true;
        }
        
        // Set network timeout to 15 seconds for YouTube streaming
        unsafe { 
            bass_set_config(BASS_CONFIG_NET_TIMEOUT, 15000); 
        }
        
        println!("[bass] BASS initialization complete");
    } else {
        println!("[bass] BASS already initialized, skipping initialization");
    }
    
    // Set HTTP User-Agent for YouTube compatibility
    let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\0";
    unsafe {
        let set_config_ptr: Symbol<unsafe extern "system" fn(option: u32, value: *const u8) -> u32> = lib.get(b"BASS_SetConfigPtr")
            .map_err(|_| "Could not get BASS_SetConfigPtr function")?;
        set_config_ptr(BASS_CONFIG_NET_AGENT, user_agent.as_ptr());
    }
    
    // Stop and free any existing stream
    if let Some(h) = st.stream.take() { 
        unsafe { 
            bass_channel_stop(h);
            bass_stream_free(h);
        } 
    }
    
    // Create new stream from URL
    println!("[bass] Creating stream from URL: {}", actual_url);
    
    let handle = if actual_url.starts_with("file://") {
        // For local files, use BASS_StreamCreateFile
        let file_path = actual_url.strip_prefix("file://").unwrap_or(&actual_url);
        let c_file_path = CString::new(file_path).map_err(|_| "Invalid file path: contains null bytes".to_string())?;
        println!("[bass] Creating stream from local file: {}", file_path);
        
        unsafe { 
            bass_stream_create_file(
                0, // FALSE - not from memory
                c_file_path.as_ptr() as *const c_void,
                0, // offset
                0, // length (0 = use entire file)
                BASS_STREAM_AUTOFREE
            ) 
        }
    } else {
        // For remote URLs, use BASS_StreamCreateURL
        let c_url = CString::new(actual_url.clone()).map_err(|_| "Invalid URL: contains null bytes".to_string())?;
        unsafe { 
            bass_stream_create_url(
                c_url.as_ptr(), 
                0, 
                BASS_STREAM_STATUS | BASS_STREAM_AUTOFREE | BASS_STREAM_BLOCK, 
                std::ptr::null_mut(), 
                std::ptr::null_mut()
            ) 
        }
    };
    
    if handle == 0 { 
        let error = bass_err(lib);
        println!("[bass] Stream creation failed: {}", error);
        st.last_error = Some(error.clone()); 
        return Err(error); 
    }
    println!("[bass] Stream created successfully with handle: {}", handle);
    
    // Apply current volume to the new stream
    let current_volume = if st.muted { 0.0 } else { st.volume };
    let bass_channel_set_attribute: Symbol<BassChannelSetAttribute> = unsafe {
        lib.get(b"BASS_ChannelSetAttribute").map_err(|_| "Could not load BASS_ChannelSetAttribute")?
    };
    unsafe {
        let result = bass_channel_set_attribute(handle, BASS_ATTRIB_VOL, current_volume);
        if result == 0 {
            println!("[bass] Warning: Failed to set initial volume to {:.2}", current_volume);
        } else {
            println!("[bass] Initial volume set to {:.2}", current_volume);
        }
    }
    
    // Apply seek offset if needed
    if st.seek_offset > 0.0 {
        unsafe {
            let bytes = bass_channel_seconds_to_bytes(handle, st.seek_offset);
            if bass_channel_set_position(handle, bytes, BASS_POS_BYTE) == 0 { 
                st.last_error = Some(bass_err(lib)); 
            }
        }
    }
    
    // Start playback
    println!("[bass] Starting playback...");
    if unsafe { bass_channel_play(handle, 0) } == 0 { 
        let error = bass_err(lib);
        println!("[bass] Playback start failed: {}", error);
        st.last_error = Some(error.clone()); 
        unsafe { bass_stream_free(handle); }
        return Err(error); 
    }
    println!("[bass] Playback started successfully");
    
    // Update state
    st.duration = probe_duration_bass(lib, handle);
    st.stream = Some(handle);
    st.url = Some(actual_url);
    st.playing = true;
    st.started_at = Some(Instant::now());
    st.paused_at = None;
    st.accumulated_paused = Duration::ZERO;
    st.ended = false;
    st.last_error = None;
    // Reset cache-related state for new playback
    st.current_track_id = None;
    st.current_source_type = None;
    st.current_source_hash = None;
    st.cache_download_tx = None;
    
    println!("[bass] Playback state updated, duration: {:?}", st.duration);
    Ok(serde_json::json!({"success": true, "data": {"duration": st.duration}}))
}

fn extract_source_info(url: &str) -> (String, String) {
    if url.contains("googlevideo.com") || url.contains("youtube.com") || url.contains("youtu.be") {
        // For YouTube URLs, try to extract video ID from various URL patterns
        if let Some(start) = url.find("v=") {
            if let Some(end) = url[start + 2..].find('&') {
                let video_id = &url[start + 2..start + 2 + end];
                return ("youtube".to_string(), video_id.to_string());
            } else {
                let video_id = &url[start + 2..];
                if video_id.len() >= 11 {
                    return ("youtube".to_string(), video_id[..11].to_string());
                }
            }
        }
        // Try to extract from googlevideo.com URLs that have id parameter
        if let Some(start) = url.find("id=") {
            if let Some(end) = url[start + 3..].find('&') {
                let video_id = &url[start + 3..start + 3 + end];
                return ("youtube".to_string(), video_id.to_string());
            }
        }
        // Fallback: use a hash of the URL for YouTube if we can't extract ID
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        let hash = format!("{:x}", hasher.finish());
        ("youtube".to_string(), hash[..11].to_string())
    } else if url.starts_with("magnet:") {
        // For torrents, extract info hash from magnet link
        if let Some(start) = url.find("xt=urn:btih:") {
            let hash_start = start + 12;
            if let Some(end) = url[hash_start..].find('&') {
                let info_hash = &url[hash_start..hash_start + end];
                return ("torrent".to_string(), info_hash.to_lowercase());
            } else {
                let info_hash = &url[hash_start..];
                return ("torrent".to_string(), info_hash.to_lowercase());
            }
        }
        ("torrent".to_string(), "unknown".to_string())
    } else if url.starts_with("http://") || url.starts_with("https://") {
        // For HTTP URLs, use a hash of the URL
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        let hash = format!("{:x}", hasher.finish());
        ("http".to_string(), hash[..16].to_string())
    } else if url.starts_with("file://") || std::path::Path::new(url).exists() {
        // For local files, use the file path hash
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        let hash = format!("{:x}", hasher.finish());
        ("local".to_string(), hash[..16].to_string())
    } else {
        // Unknown source type
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        let hash = format!("{:x}", hasher.finish());
        ("unknown".to_string(), hash[..8].to_string())
    }
}

#[tauri::command]
pub async fn playback_start_with_cache(
    track_id: String,
    url: String,
    prefer_cache: bool,
    source_type: Option<String>,
    source_hash: Option<String>
) -> Result<serde_json::Value, String> {
    println!("[bass] playback_start_with_cache called for track: {}, prefer_cache: {}", track_id, prefer_cache);

    // Use provided source info if available, otherwise extract from URL
    let (final_source_type, final_source_hash) = if let (Some(st), Some(sh)) = (source_type, source_hash) {
        println!("[bass] Using provided source info: {} with hash: {}", st, sh);
        (st, sh)
    } else {
        println!("[bass] Extracting source info from URL");
        extract_source_info(&url)
    };

    println!("[bass] Final source: {} with hash: {}", final_source_type, final_source_hash);

    // Update current track info for cache switching (without holding lock across await)
    {
        let mut state_guard = STATE.lock().unwrap();
        state_guard.current_track_id = Some(track_id.clone());
        state_guard.current_source_type = Some(final_source_type.clone());
        state_guard.current_source_hash = Some(final_source_hash.clone());
    }    // Try to get cached file first if preferred
    let use_cached = if prefer_cache {
        let cache_result = {
            let mut cache_guard = CACHE.lock().unwrap();
            if let Some(cache) = cache_guard.as_mut() {
                cache.get_cached_file(&track_id, &final_source_type, &final_source_hash)
            } else {
                None
            }
        };

        if let Some(cached_path) = cache_result {
            println!("[bass] Using cached file: {}", cached_path.display());
            return playback_start(format!("file://{}", cached_path.display())).await;
        }
        true // We want to cache even if not found
    } else {
        false
    };

    // Start streaming playback immediately for instant playback
    println!("[bass] Starting streaming playback for instant access");
    let result = playback_start(url.clone()).await;

    // If streaming works and we want to cache, start background download with channel for completion
    if result.is_ok() && use_cached {
        println!("[bass] Starting background cache download");

        // Create a channel for cache download completion
        let (tx, mut rx) = mpsc::unbounded_channel::<CacheDownloadResult>();

        // Store the sender in the state (without holding lock across await)
        {
            let mut state_guard = STATE.lock().unwrap();
            state_guard.cache_download_tx = Some(tx.clone());
        }

        // Start background download
        let track_id_clone = track_id.clone();
        let source_type_clone = final_source_type.clone();
        let source_hash_clone = final_source_hash.clone();
        let url_clone = url.clone();

        tokio::spawn(async move {
            download_and_cache_audio(track_id_clone, source_type_clone, source_hash_clone, url_clone, tx).await;
        });

        // Spawn a task to listen for cache completion and switch playback
        let current_track_id = track_id.clone();
        let current_source_type = final_source_type.clone();
        let current_source_hash = final_source_hash.clone();

        tokio::spawn(async move {
            while let Some(result) = rx.recv().await {
                // Check if this is still the current track (without holding lock across await)
                let is_current_track = {
                    let state_guard = STATE.lock().unwrap();
                    state_guard.current_track_id.as_ref() == Some(&current_track_id) &&
                    state_guard.current_source_type.as_ref() == Some(&current_source_type) &&
                    state_guard.current_source_hash.as_ref() == Some(&current_source_hash)
                };

                if is_current_track {
                    println!("[bass] Cache download completed, switching to cached file: {}", result.cached_path);

                    // Get current position to resume from same point (without holding lock across await)
                    let current_position = {
                        if let Ok(status) = playback_status().await {
                            status.get("data").and_then(|d| d.get("position")).and_then(|p| p.as_f64()).unwrap_or(0.0)
                        } else {
                            0.0
                        }
                    };

                    // Switch to cached playback and seek to current position
                    let cached_url = format!("file://{}", result.cached_path);
                    if let Ok(_) = playback_start(cached_url).await {
                        if current_position > 0.0 {
                            let _ = playback_seek(current_position).await;
                        }
                    }
                } else {
                    println!("[bass] Cache completed but track changed, ignoring switch");
                }
                break; // Only handle one completion
            }
        });
    }

    result
}

// URL resolution functions for different source types
async fn resolve_local_source(value: &str) -> Result<String, String> {
    // For local files, return file:// URL
    if value.starts_with("file://") {
        Ok(value.to_string())
    } else {
        Ok(format!("file://{}", value))
    }
}

async fn resolve_http_source(value: &str) -> Result<String, String> {
    // For HTTP URLs, return as-is
    Ok(value.to_string())
}

async fn resolve_torrent_source(value: &str) -> Result<String, String> {
    // Extract infoHash from magnetURI if needed
    if value.starts_with("magnet:") {
        if let Some(start) = value.find("xt=urn:btih:") {
            let hash_start = start + 12;
            if let Some(end) = value[hash_start..].find('&') {
                let info_hash = &value[hash_start..hash_start + end];
                return Ok(format!("http://localhost:9000/stream/{}/0", info_hash.to_lowercase()));
            } else {
                let info_hash = &value[hash_start..];
                return Ok(format!("http://localhost:9000/stream/{}/0", info_hash.to_lowercase()));
            }
        }
        return Err("Invalid magnet URI format".to_string());
    }
    // Assume it's already an infoHash
    Ok(format!("http://localhost:9000/stream/{}/0", value.to_lowercase()))
}

async fn resolve_youtube_source(value: &str) -> Result<String, String> {
    // If it's already a localhost streaming URL, return as-is
    if value.starts_with("http://localhost:9000/source/youtube") {
        return Ok(value.to_string());
    }

    // For YouTube sources, get the direct CDN URL from the info endpoint
    let video_id = if value.len() == 11 && value.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
        // It's already a video ID
        value.to_string()
    } else {
        // Try to extract video ID from URL
        if let Some(start) = value.find("v=") {
            if let Some(end) = value[start + 2..].find('&') {
                value[start + 2..start + 2 + end].to_string()
            } else {
                value[start + 2..].to_string()
            }
        } else if let Some(start) = value.find("youtu.be/") {
            if let Some(end) = value[start + 9..].find('?') {
                value[start + 9..start + 9 + end].to_string()
            } else {
                value[start + 9..].to_string()
            }
        } else {
            return Err("Unable to extract YouTube video ID".to_string());
        }
    };

    // Get the info to extract the direct YouTube CDN URL
    let info_url = format!("http://localhost:9000/source/youtube?id={}&get=info", video_id);
    println!("[resolve] Fetching YouTube info for direct URL: {}", info_url);

    let client = reqwest::Client::new();
    let response = client.get(&info_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch YouTube info: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("YouTube info request failed with status: {}", response.status()));
    }

    let data: serde_json::Value = response.json()
        .await
        .map_err(|e| format!("Failed to parse YouTube info response: {}", e))?;

    println!("[resolve] YouTube info response: {:?}", data);

    if let Some(success) = data.get("success").and_then(|s| s.as_bool()) {
        if success {
            if let Some(format_data) = data.get("data").and_then(|d| d.get("format")) {
                if let Some(url) = format_data.get("url").and_then(|u| u.as_str()) {
                    println!("[resolve] Successfully extracted direct YouTube CDN URL: {}", url);
                    return Ok(url.to_string());
                }
            }
        }
    }

    // Fallback to streaming endpoint if direct URL extraction fails
    println!("[resolve] Falling back to streaming endpoint for video ID: {}", video_id);
    Ok(format!("http://localhost:9000/source/youtube?id={}&get=stream", video_id))
}

async fn resolve_audio_source(source_type: &str, value: &str) -> Result<String, String> {
    println!("[bass] resolve_audio_source called with type: '{}', value: '{}'", source_type, value);
    
    let result = match source_type {
        "local" => resolve_local_source(value).await,
        "http" => resolve_http_source(value).await,
        "torrent" => resolve_torrent_source(value).await,
        "youtube" => resolve_youtube_source(value).await,
        _ => {
            println!("[bass] Unsupported source type: {}", source_type);
            Err(format!("Unsupported source type: {}", source_type))
        },
    };
    
    match &result {
        Ok(url) => println!("[bass] Source resolution successful: {}", url),
        Err(error) => println!("[bass] Source resolution failed: {}", error),
    }
    
    result
}

#[derive(Deserialize)]
pub struct PlaybackSourceSpec {
    pub track_id: String,
    pub source_type: String,
    pub source_value: String,
    pub prefer_cache: Option<bool>,
    pub source_meta: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn playback_start_with_source(spec: PlaybackSourceSpec) -> Result<serde_json::Value, String> {
    println!("[bass] playback_start_with_source called for track: {}, type: {}, prefer_cache: {:?}",
             spec.track_id, spec.source_type, spec.prefer_cache);

    // Extract source hash for caching BEFORE doing any URL resolution
    let source_hash = match spec.source_type.as_str() {
        "youtube" => {
            // For YouTube, use the video ID as hash
            if spec.source_value.len() == 11 && spec.source_value.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                spec.source_value.clone()
            } else if let Some(start) = spec.source_value.find("v=") {
                if let Some(end) = spec.source_value[start + 2..].find('&') {
                    spec.source_value[start + 2..start + 2 + end].to_string()
                } else {
                    spec.source_value[start + 2..].to_string()
                }
            } else {
                spec.source_value.clone() // Assume it's already a video ID
            }
        },
        "torrent" => {
            // For torrents, extract info hash
            if spec.source_value.starts_with("magnet:") {
                if let Some(start) = spec.source_value.find("xt=urn:btih:") {
                    let hash_start = start + 12;
                    if let Some(end) = spec.source_value[hash_start..].find('&') {
                        spec.source_value[hash_start..hash_start + end].to_lowercase()
                    } else {
                        spec.source_value[hash_start..].to_lowercase()
                    }
                } else {
                    "unknown".to_string()
                }
            } else {
                spec.source_value.to_lowercase()
            }
        },
        _ => {
            // For other types, use the value directly as hash
            spec.source_value.clone()
        }
    };

    println!("[bass] Generated source hash: {} for type: {}", source_hash, spec.source_type);

    // OPTIMIZATION: Check cache FIRST before doing any URL resolution
    if spec.prefer_cache.unwrap_or(true) {
        println!("[bass] Checking cache before URL resolution...");
        
        // Use the existing cache_get_file command to check for cached files
        match cache_get_file(spec.track_id.clone(), spec.source_type.clone(), source_hash.clone()).await {
            Ok(cache_result) => {
                if let Some(exists) = cache_result.get("exists").and_then(|v| v.as_bool()) {
                    if exists {
                        println!("[bass] Cache hit! Playing from cached file directly");
                        
                        // Use existing playback_start_with_cache but force it to use cache
                        return playback_start_with_cache(
                            spec.track_id,
                            "".to_string(), // Empty URL since we're using cache
                            true, // prefer_cache = true
                            Some(spec.source_type),
                            Some(source_hash)
                        ).await;
                    }
                }
            }
            Err(e) => {
                println!("[bass] Cache check failed: {}, proceeding with URL resolution", e);
            }
        }
        
        println!("[bass] Cache miss, proceeding with URL resolution...");
    }

    // Only resolve URL if we don't have a cached file
    println!("[bass] Resolving source URL...");
    let resolved_url = resolve_audio_source(&spec.source_type, &spec.source_value).await?;
    println!("[bass] Resolved source URL: {}", resolved_url);

    // Now use the existing hybrid caching system for downloads
    playback_start_with_cache(
        spec.track_id,
        resolved_url,
        spec.prefer_cache.unwrap_or(true),
        Some(spec.source_type),
        Some(source_hash)
    ).await
}

#[tauri::command]
pub async fn playback_pause() -> Result<serde_json::Value, String> { 
    println!("[bass] playback_pause called");
    let mut st = STATE.lock().unwrap(); 
    if let Some(h) = st.stream {
        if let Some(lib) = st.bass_lib.as_ref() {
            println!("[bass] Pausing stream with handle: {}", h);
            let bass_channel_pause: Symbol<BassChannelPause> = unsafe { 
                lib.get(b"BASS_ChannelPause").map_err(|_| "Could not load BASS_ChannelPause")? 
            };
            if unsafe { bass_channel_pause(h) } == 0 {
                let error = bass_err(lib);
                println!("[bass] Pause failed: {}", error);
                st.last_error = Some(error.clone());
                return Err(error);
            }
            println!("[bass] Stream paused successfully");
        }
    } 
    if st.playing { 
        st.playing = false; 
        st.paused_at = Some(Instant::now()); 
        println!("[bass] Playback state set to paused");
    } 
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub async fn playback_resume() -> Result<serde_json::Value, String> { 
    println!("[bass] playback_resume called");
    let mut st = STATE.lock().unwrap(); 
    if let Some(h) = st.stream {
        if let Some(lib) = st.bass_lib.as_ref() {
            println!("[bass] Resuming stream with handle: {}", h);
            let bass_channel_play: Symbol<BassChannelPlay> = unsafe { 
                lib.get(b"BASS_ChannelPlay").map_err(|_| "Could not load BASS_ChannelPlay")? 
            };
            if unsafe { bass_channel_play(h, 0) } == 0 {
                let error = bass_err(lib);
                println!("[bass] Resume failed: {}", error);
                st.last_error = Some(error.clone());
                return Err(error);
            }
            println!("[bass] Stream resumed successfully");
        }
    } 
    if !st.playing { 
        if let Some(paused_at) = st.paused_at.take() { 
            st.accumulated_paused += paused_at.elapsed(); 
        } 
        st.playing = true; 
        println!("[bass] Playback state set to playing");
    } 
    Ok(serde_json::json!({"success": true})) 
}

#[tauri::command]
pub async fn playback_stop() -> Result<serde_json::Value, String> { 
    let mut st = STATE.lock().unwrap(); 
    if let Some(h) = st.stream.take() {
        if let Some(lib) = st.bass_lib.as_ref() {
            if let (Ok(stop_fn), Ok(free_fn)) = (
                unsafe { lib.get::<BassChannelStop>(b"BASS_ChannelStop") },
                unsafe { lib.get::<BassStreamFree>(b"BASS_StreamFree") }
            ) {
                unsafe { 
                    stop_fn(h);
                    free_fn(h);
                } 
            }
        }
    } 
    st.url = None;
    st.stream = None;
    st.playing = false;
    st.started_at = None;
    st.paused_at = None;
    st.accumulated_paused = Duration::ZERO;
    st.duration = None;
    st.seek_offset = 0.0;
    st.ended = false;
    st.last_error = None;
    Ok(serde_json::json!({"success": true})) 
}

#[tauri::command]
pub async fn playback_seek(position: f64) -> Result<serde_json::Value, String> { 
    println!("[bass] playback_seek called with position: {}", position);
    let mut st = STATE.lock().unwrap(); 
    if st.stream.is_none() || st.bass_lib.is_none() { 
        println!("[bass] No stream or library available for seeking");
        return Ok(serde_json::json!({
            "success": false,
            "reason": "no_stream",
            "message": "No active stream for seeking"
        })); 
    } 
    
    let h = st.stream.unwrap();
    let lib = st.bass_lib.as_ref().unwrap();
    
    // Clamp position to valid range
    let pos = if let Some(d) = st.duration { 
        let clamped = position.clamp(0.0, d);
        println!("[bass] Position clamped from {} to {} (duration: {})", position, clamped, d);
        clamped
    } else { 
        let clamped = position.max(0.0);
        println!("[bass] No duration available, clamped position from {} to {}", position, clamped);
        clamped
    }; 
    
    let bass_channel_seconds_to_bytes: Symbol<BassChannelSeconds2Bytes> = unsafe { 
        lib.get(b"BASS_ChannelSeconds2Bytes").map_err(|_| "Could not load BASS_ChannelSeconds2Bytes")? 
    };
    let bass_channel_set_position: Symbol<BassChannelSetPosition> = unsafe { 
        lib.get(b"BASS_ChannelSetPosition").map_err(|_| "Could not load BASS_ChannelSetPosition")? 
    };
    
    // Try to get stream length and available data to check buffering status
    let _bass_channel_get_length: Option<Symbol<BassChannelGetLength>> = unsafe { 
        lib.get(b"BASS_ChannelGetLength").ok()
    };
    let _bass_channel_get_available: Option<Symbol<BassChannelGetLength>> = unsafe { 
        lib.get(b"BASS_StreamGetFilePosition").ok()
    };
    
    unsafe { 
        let bytes = bass_channel_seconds_to_bytes(h, pos);
        println!("[bass] Seeking to position {} seconds = {} bytes", pos, bytes);
        
        // Check if position is valid before seeking
        if bytes == 0xFFFFFFFF {
            let error = "Invalid seek position (bytes conversion failed)";
            println!("[bass] {}", error);
            return Ok(serde_json::json!({
                "success": false,
                "reason": "invalid_position",
                "message": error
            }));
        }
        
        // For streaming content, check current position to avoid unnecessary seeks
        let bass_channel_get_position: Option<Symbol<BassChannelGetPosition>> = lib.get(b"BASS_ChannelGetPosition").ok();
        
        if let Some(get_position) = &bass_channel_get_position {
            let current_bytes = get_position(h, BASS_POS_BYTE);
            if current_bytes != 0xFFFFFFFF {
                let bass_channel_bytes_to_seconds: Symbol<BassChannelBytes2Seconds> = lib.get(b"BASS_ChannelBytes2Seconds").map_err(|_| "Could not load BASS_ChannelBytes2Seconds")?;
                let current_pos = bass_channel_bytes_to_seconds(h, current_bytes);
                let diff = (pos - current_pos).abs();
                
                // If we're already very close to the target position, don't seek
                if diff < 0.1 {
                    println!("[bass] Already at target position ({} vs {}), skipping seek", current_pos, pos);
                    st.seek_offset = pos;
                    return Ok(serde_json::json!({
                        "success": true,
                        "position": pos,
                        "skipped": true
                    }));
                }
            }
        }
        
        // For streaming content, try seek but don't fail the entire operation if it doesn't work
        if bass_channel_set_position(h, bytes, BASS_POS_BYTE) == 0 { 
            let error = bass_err(lib);
            println!("[bass] Seek failed: {}", error);
            
            // For streaming content, seeking errors are often non-fatal
            // Instead of failing, we can continue playback and just update our internal position
            if error.contains("BASS_ERROR_NOTAVAIL") {
                println!("[bass] Seek data not available, updating position tracker without actual seek");
                // Update our position tracker as if the seek succeeded
                st.seek_offset = pos; 
                st.started_at = Some(Instant::now()); 
                st.accumulated_paused = Duration::ZERO; 
                st.paused_at = None; 
                
                return Ok(serde_json::json!({
                    "success": true,
                    "position": pos,
                    "warning": "Seek position not buffered, updated position tracker only"
                }));
            } else if error.contains("BASS_ERROR_POSITION") {
                return Ok(serde_json::json!({
                    "success": false,
                    "reason": "invalid_position",
                    "message": "Invalid seek position for this stream"
                }));
            } else if error.contains("BASS_ERROR_NOTFILE") {
                return Ok(serde_json::json!({
                    "success": false,
                    "reason": "streaming_limitation",
                    "message": "Seeking not supported for this type of stream"
                }));
            }
            
            // For other seek errors, return as non-fatal
            return Ok(serde_json::json!({
                "success": false,
                "reason": "seek_error",
                "message": error
            }));
        } 
        
        println!("[bass] Seek successful to position {} seconds", pos);
    } 
    
    st.seek_offset = pos; 
    st.started_at = Some(Instant::now()); 
    st.accumulated_paused = Duration::ZERO; 
    st.paused_at = None; 
    st.playing = true; 
    
    Ok(serde_json::json!({
        "success": true,
        "position": pos
    }))
}

#[derive(serde::Serialize)]
pub struct PlaybackStatus { pub url: Option<String>, pub playing: bool, pub position: f64, pub duration: Option<f64>, pub ended: bool, pub error: Option<String> }

#[tauri::command]
pub async fn playback_status() -> Result<serde_json::Value, String> { 
    let mut st = STATE.lock().unwrap(); 
    
    // Get library reference safely
    let lib_ptr = match st.bass_lib.as_ref() {
        Some(lib) => lib as *const Library,
        None => {
            return Ok(serde_json::json!({
                "success": true,
                "data": {
                    "url": st.url,
                    "playing": st.playing,
                    "position": 0.0,
                    "duration": st.duration,
                    "ended": st.ended,
                    "error": st.last_error
                }
            }));
        }
    };
    let lib = unsafe { &*lib_ptr };
    let h = match st.stream {
        Some(handle) => handle,
        None => {
            return Ok(serde_json::json!({
                "success": true,
                "data": {
                    "url": st.url,
                    "playing": st.playing,
                    "position": 0.0,
                    "duration": st.duration,
                    "ended": st.ended,
                    "error": st.last_error
                }
            }));
        }
    };
    
    // Check if stream is still active
    let bass_channel_is_active: Symbol<BassChannelIsActive> = unsafe { 
        lib.get(b"BASS_ChannelIsActive").map_err(|_| "Could not load BASS_ChannelIsActive")? 
    };
    
    unsafe { 
        let active = bass_channel_is_active(h); 
        if active == BASS_ACTIVE_STOPPED && st.playing { 
            st.playing = false; 
            st.ended = true; 
        } 
        
        // Try to get duration if we don't have it yet
        if st.duration.is_none() { 
            st.duration = probe_duration_bass(lib, h); 
        } 
    } 
    
    // Get current position
    let bass_channel_get_position: Symbol<BassChannelGetPosition> = unsafe { 
        lib.get(b"BASS_ChannelGetPosition").map_err(|_| "Could not load BASS_ChannelGetPosition")? 
    };
    let bass_channel_bytes_to_seconds: Symbol<BassChannelBytes2Seconds> = unsafe { 
        lib.get(b"BASS_ChannelBytes2Seconds").map_err(|_| "Could not load BASS_ChannelBytes2Seconds")? 
    };
    
    let position = unsafe { 
        let pos_bytes = bass_channel_get_position(h, BASS_POS_BYTE); 
        if pos_bytes == 0xFFFFFFFF {
            // Error getting position, return 0
            0.0
        } else {
            let secs = bass_channel_bytes_to_seconds(h, pos_bytes); 
            if secs.is_finite() && secs >= 0.0 { 
                secs 
            } else { 
                0.0 
            }
        }
    }; 
    
    Ok(serde_json::json!({
        "success": true,
        "data": {
            "url": st.url,
            "playing": st.playing,
            "position": position,
            "duration": st.duration,
            "ended": st.ended,
            "error": st.last_error
        }
    })) 
}

#[tauri::command]
pub async fn get_audio_devices() -> Result<serde_json::Value, String> {
    println!("[bass] Getting audio devices...");
    
    // First try to get the BASS library
    let mut state = STATE.lock().unwrap();
    
    // Ensure BASS library is loaded
    if let Err(e) = ensure_bass_loaded(&mut state) {
        println!("[bass] Warning: Could not load BASS library for device enumeration: {}", e);
        // Return fallback devices if BASS is not available
        return Ok(serde_json::json!({
            "success": true,
            "devices": [{
                "id": -1,
                "name": "System Default",
                "driver": "Default",
                "is_default": true,
                "is_enabled": true
            }]
        }));
    }
    
    let lib = state.bass_lib.as_ref().unwrap();
    let mut devices = Vec::new();
    
    // Get BASS_GetDeviceInfo function
    let bass_get_device_info: Symbol<BassGetDeviceInfo> = unsafe {
        match lib.get(b"BASS_GetDeviceInfo") {
            Ok(func) => func,
            Err(_) => {
                println!("[bass] Could not load BASS_GetDeviceInfo function");
                // Return fallback device
                return Ok(serde_json::json!({
                    "success": true,
                    "devices": [{
                        "id": -1,
                        "name": "System Default",
                        "driver": "Default", 
                        "is_default": true,
                        "is_enabled": true
                    }]
                }));
            }
        }
    };
    
    // Enumerate devices starting from device 0
    let mut device_index = 0u32;
    let mut found_default_device = false; // Track if we've already found a default device
    
    loop {
        let mut device_info = BassDeviceInfo {
            name: std::ptr::null(),
            driver: std::ptr::null(),
            flags: 0,
        };
        
        // Call BASS_GetDeviceInfo
        let result = unsafe { bass_get_device_info(device_index, &mut device_info) };
        
        if result == 0 {
            // No more devices
            break;
        }
        
        // Convert C strings to Rust strings safely
        let device_name = if device_info.name.is_null() {
            format!("Audio Device {}", device_index)
        } else {
            unsafe {
                match CStr::from_ptr(device_info.name).to_str() {
                    Ok(name) => name.to_string(),
                    Err(_) => format!("Audio Device {}", device_index),
                }
            }
        };
        
        let driver_name = if device_info.driver.is_null() {
            "Unknown".to_string()
        } else {
            unsafe {
                match CStr::from_ptr(device_info.driver).to_str() {
                    Ok(driver) => driver.to_string(),
                    Err(_) => "Unknown".to_string(),
                }
            }
        };
        
        // Check device flags
        let is_enabled = (device_info.flags & BASS_DEVICE_ENABLED) != 0;
        let bass_says_default = (device_info.flags & BASS_DEVICE_DEFAULT_FLAG) != 0;
        let is_initialized = (device_info.flags & BASS_DEVICE_INIT) != 0;
        
        // Only mark as default if BASS says it's default AND we haven't found one yet
        let is_default = bass_says_default && !found_default_device;
        if is_default {
            found_default_device = true;
            println!("[bass] Setting device {} as the single default device", device_index);
        }
        
        println!("[bass] Found device {}: {} (driver: {}, enabled: {}, default: {}, init: {})", 
                 device_index, device_name, driver_name, is_enabled, is_default, is_initialized);
        
        // Add device to list (include all devices, but mark their status)
        devices.push(serde_json::json!({
            "id": device_index as i32,
            "name": device_name,
            "driver": driver_name,
            "is_default": is_default,
            "is_enabled": is_enabled,
            "is_initialized": is_initialized
        }));
        
        device_index += 1;
        
        // Safety limit to prevent infinite loops
        if device_index > 32 {
            println!("[bass] Device enumeration safety limit reached");
            break;
        }
    }
    
    // If no devices were found, add a fallback default device
    if devices.is_empty() {
        println!("[bass] No devices found, adding fallback default device");
        devices.push(serde_json::json!({
            "id": -1,
            "name": "System Default",
            "driver": "Default",
            "is_default": true,
            "is_enabled": true,
            "is_initialized": false
        }));
    }
    
    println!("[bass] Device enumeration complete, found {} devices", devices.len());
    
    // Debug log all devices for troubleshooting
    for (index, device) in devices.iter().enumerate() {
        println!("[bass] Device {}: {:?}", index, device);
    }
    
    Ok(serde_json::json!({
        "success": true,
        "devices": devices
    }))
}

#[tauri::command]
pub async fn get_audio_settings() -> Result<serde_json::Value, String> {
    let state = STATE.lock().unwrap();
    
    // Get actual audio settings from BASS if initialized
    let (actual_device, actual_sample_rate, actual_bit_depth, actual_output_channels) = if state.bass_initialized {
        if let Some(lib) = state.bass_lib.as_ref() {
            // Get BASS_GetDevice and BASS_GetInfo functions
            let bass_get_device: Symbol<BassGetDevice> = unsafe {
                match lib.get(b"BASS_GetDevice") {
                    Ok(func) => func,
                    Err(_) => {
                        println!("[bass] Warning: Could not load BASS_GetDevice function");
                        return Ok(serde_json::json!({
                            "success": true,
                            "settings": {
                                "device": -1,
                                "sample_rate": 44100, // Default fallback
                                "bit_depth": 16,      // Default fallback
                                "buffer_size": 1024,
                                "net_buffer": 5000,
                                "volume": state.volume,
                                "exclusive_mode": false,
                                "output_channels": 2
                            }
                        }));
                    }
                }
            };
            
            let bass_get_info: Symbol<BassGetInfo> = unsafe {
                match lib.get(b"BASS_GetInfo") {
                    Ok(func) => func,
                    Err(_) => {
                        println!("[bass] Warning: Could not load BASS_GetInfo function");
                        return Ok(serde_json::json!({
                            "success": true,
                            "settings": {
                                "device": -1,
                                "sample_rate": 44100, // Default fallback
                                "bit_depth": 16,      // Default fallback
                                "buffer_size": 1024,
                                "net_buffer": 5000,
                                "volume": state.volume,
                                "exclusive_mode": false,
                                "output_channels": 2
                            }
                        }));
                    }
                }
            };
            
            // Get current device
            let current_device = unsafe { bass_get_device() };
            println!("[bass] Current BASS device: {}", current_device);
            
            // If BASS returns BASS_DEVICE_DEFAULT (which is -1 but returned as large uint), 
            // we need to find the actual device ID that corresponds to the default device
            let resolved_device = if current_device == (BASS_DEVICE_DEFAULT as u32) || current_device == u32::MAX {
                // Find the real default device by enumerating devices
                if let Ok(bass_get_device_info) = unsafe { lib.get::<BassGetDeviceInfo>(b"BASS_GetDeviceInfo") } {
                    let mut device_index = 0u32;
                    let mut found_device = current_device as i32;
                    
                    loop {
                        let mut device_info = BassDeviceInfo {
                            name: std::ptr::null(),
                            driver: std::ptr::null(),
                            flags: 0,
                        };
                        
                        let result = unsafe { bass_get_device_info(device_index, &mut device_info) };
                        if result == 0 {
                            break; // No more devices
                        }
                        
                        // Check if this device is marked as default
                        if (device_info.flags & BASS_DEVICE_DEFAULT_FLAG) != 0 {
                            println!("[bass] Found real default device: {} (was {})", device_index, current_device);
                            found_device = device_index as i32;
                            break;
                        }
                        
                        device_index += 1;
                        if device_index > 32 { break; } // Safety limit
                    }
                    found_device
                } else {
                    current_device as i32
                }
            } else {
                current_device as i32
            };
            
            println!("[bass] Resolved device: {} (original: {})", resolved_device, current_device);
            
            let mut bass_info = BassInfo {
                flags: 0,
                hwsize: 0,
                hwfree: 0,
                freesam: 0,
                free3d: 0,
                minrate: 0,
                maxrate: 0,
                eax: 0,
                minbuf: 0,
                dsver: 0,
                latency: 0,
                initflags: 0,
                speakers: 0,
                freq: 0,
            };
            
            let result = unsafe { bass_get_info(&mut bass_info) };
            if result != 0 {
                println!("[bass] BASS_GetInfo successful - freq: {}Hz, speakers: {}, latency: {}ms", 
                         bass_info.freq, bass_info.speakers, bass_info.latency);
                
                // Extract bit depth from init flags or use reasonable default
                // BASS doesn't directly report bit depth, so we'll infer from flags or use 16-bit as default
                let bit_depth = if (bass_info.initflags & 0x8) != 0 { 32 } // BASS_DEVICE_FLOAT
                               else if (bass_info.initflags & 0x10) != 0 { 24 } // Placeholder for 24-bit detection
                               else { 16 }; // Default to 16-bit
                
                // Use actual speakers count from BASS, with fallback to 2 if 0
                let output_channels = if bass_info.speakers > 0 { bass_info.speakers } else { 2 };
                
                (resolved_device, bass_info.freq, bit_depth, output_channels)
            } else {
                println!("[bass] BASS_GetInfo failed, using defaults");
                (resolved_device, 44100, 16, 2) // Fallback defaults
            }
        } else {
            println!("[bass] BASS library not loaded, using defaults");
            (-1, 44100, 16, 2) // Fallback defaults
        }
    } else {
        println!("[bass] BASS not initialized, checking for default device from enumeration");
        // Since BASS is not initialized yet, try to find the default device by enumerating devices
        if let Some(lib) = state.bass_lib.as_ref() {
            if let Ok(bass_get_device_info) = unsafe { lib.get::<BassGetDeviceInfo>(b"BASS_GetDeviceInfo") } {
                let mut device_index = 0u32;
                let mut default_device_id = -1i32;
                
                loop {
                    let mut device_info = BassDeviceInfo {
                        name: std::ptr::null(),
                        driver: std::ptr::null(),
                        flags: 0,
                    };
                    
                    let result = unsafe { bass_get_device_info(device_index, &mut device_info) };
                    if result == 0 {
                        break; // No more devices
                    }
                    
                    // Check if this device is marked as default
                    if (device_info.flags & BASS_DEVICE_DEFAULT_FLAG) != 0 {
                        println!("[bass] Found default device during enumeration: {}", device_index);
                        default_device_id = device_index as i32;
                        break;
                    }
                    
                    device_index += 1;
                    if device_index > 32 { break; } // Safety limit
                }
                
                (default_device_id, 44100, 16, 2) // Use found default device with fallback settings
            } else {
                println!("[bass] Could not enumerate devices, using fallback defaults");
                (-1, 44100, 16, 2) // Complete fallback
            }
        } else {
            println!("[bass] BASS library not loaded, using defaults");
            (-1, 44100, 16, 2) // Fallback defaults
        }
    };
    
    println!("[bass] Current audio settings - device: {}, sample_rate: {}Hz, bit_depth: {}bit, volume: {:.2}, output_channels: {}", 
             actual_device, actual_sample_rate, actual_bit_depth, state.volume, actual_output_channels);
    
    Ok(serde_json::json!({
        "success": true,
        "settings": {
            "device": actual_device,
            "sample_rate": actual_sample_rate,
            "bit_depth": actual_bit_depth,
            "buffer_size": 1024, // This would need to be retrieved separately
            "net_buffer": 5000,  // This is a config setting, not from BASS_GetInfo
            "volume": state.volume,
            "exclusive_mode": false, // This would need to be tracked separately
            "output_channels": actual_output_channels // Derived from BASS speakers count
        }
    }))
}

#[tauri::command]
pub async fn set_audio_settings(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    println!("[bass] Setting audio configuration: {:?}", settings);
    
    let mut state = STATE.lock().unwrap();
    let mut needs_reinit = false;
    let mut new_device = None;
    let mut new_sample_rate = None;
    let mut new_buffer_size = None;
    
    // Check if settings that require reinitialization have changed
    if let Some(device) = settings.get("device").and_then(|v| v.as_i64()) {
        new_device = Some(device as i32);
        needs_reinit = true;
        println!("[bass] Device change detected: {}", device);
    }
    
    if let Some(sample_rate) = settings.get("sample_rate").and_then(|v| v.as_u64()) {
        new_sample_rate = Some(sample_rate as u32);
        needs_reinit = true;
        println!("[bass] Sample rate change detected: {}", sample_rate);
    }
    
    if let Some(buffer_size) = settings.get("buffer_size").and_then(|v| v.as_u64()) {
        new_buffer_size = Some(buffer_size as u32);
        needs_reinit = true;
        println!("[bass] Buffer size change detected: {}", buffer_size);
    }
    
    // Update volume if provided (doesn't require reinitialization)
    if let Some(volume) = settings.get("volume").and_then(|v| v.as_f64()) {
        state.volume = volume as f32;
        println!("[bass] Volume change detected: {}", volume);
        
        // Apply volume to current stream if playing
        if let (Some(handle), Some(lib)) = (state.stream, state.bass_lib.as_ref()) {
            if let Ok(set_attr) = unsafe { lib.get::<BassChannelSetAttribute>(b"BASS_ChannelSetAttribute") } {
                let current_volume = if state.muted { 0.0 } else { state.volume };
                unsafe {
                    set_attr(handle, BASS_ATTRIB_VOL, current_volume);
                }
                println!("[bass] Applied volume to current stream: {}", current_volume);
            }
        }
    }
    
    // If reinitialization is needed, do it
    if needs_reinit && state.bass_initialized {
        println!("[bass] Reinitialization required, stopping current playback and reinitializing BASS");
        
        // Stop current playback if any
        if let Some(handle) = state.stream.take() {
            if let Some(lib) = state.bass_lib.as_ref() {
                if let (Ok(stop_fn), Ok(free_fn)) = (
                    unsafe { lib.get::<BassChannelStop>(b"BASS_ChannelStop") },
                    unsafe { lib.get::<BassStreamFree>(b"BASS_StreamFree") }
                ) {
                    unsafe {
                        stop_fn(handle);
                        free_fn(handle);
                    }
                    println!("[bass] Stopped and freed current stream");
                }
            }
        }
        
        // Free BASS if initialized
        if let Some(lib) = state.bass_lib.as_ref() {
            if let Ok(bass_free) = unsafe { lib.get::<BassFree>(b"BASS_Free") } {
                unsafe { bass_free(); }
                println!("[bass] Freed BASS resources");
            }
        }
        state.bass_initialized = false;
        
        // Get current or new settings
        let device_id = new_device.unwrap_or(BASS_DEVICE_DEFAULT);
        let sample_rate = new_sample_rate.unwrap_or(44100);
        let buffer_size = new_buffer_size.unwrap_or(1024);
        
        // Reinitialize with new settings
        if let Some(lib) = state.bass_lib.as_ref() {
            let bass_init: Symbol<BassInit> = unsafe { 
                lib.get(b"BASS_Init").map_err(|_| "Could not load BASS_Init")? 
            };
            let bass_set_config: Symbol<BassSetConfig> = unsafe { 
                lib.get(b"BASS_SetConfig").map_err(|_| "Could not load BASS_SetConfig")? 
            };
            
            // Set buffer size before initialization
            unsafe { 
                bass_set_config(BASS_CONFIG_BUFFER, buffer_size); 
                bass_set_config(BASS_CONFIG_NET_TIMEOUT, 15000);
            }
            println!("[bass] Set buffer size to {} and network timeout", buffer_size);
            
            let ok = unsafe { bass_init(device_id, sample_rate, 0, std::ptr::null_mut(), std::ptr::null_mut()) };
            if ok == 0 {
                let error = bass_err(lib);
                return Err(format!("Failed to reinitialize audio: {}", error));
            }
            
            state.bass_initialized = true;
            println!("[bass] Successfully reinitialized BASS with device: {}, sample_rate: {}, buffer_size: {}", 
                     device_id, sample_rate, buffer_size);
        }
    } else if needs_reinit && !state.bass_initialized {
        println!("[bass] BASS not initialized yet, settings will be applied when BASS is first initialized");
    }
    
    Ok(serde_json::json!({
        "success": true,
        "message": if needs_reinit { "Audio settings updated and BASS reinitialized" } else { "Audio settings updated" },
        "reinitialized": needs_reinit
    }))
}

#[tauri::command]
pub async fn reinitialize_audio(device_id: i32, sample_rate: u32, buffer_size: u32) -> Result<serde_json::Value, String> {
    println!("[bass] Reinitializing audio with device: {}, sample_rate: {}, buffer_size: {}", device_id, sample_rate, buffer_size);
    
    let mut state = STATE.lock().unwrap();
    
    // Stop current playback if any
    if let Some(handle) = state.stream.take() {
        if let Some(lib) = state.bass_lib.as_ref() {
            if let (Ok(stop_fn), Ok(free_fn)) = (
                unsafe { lib.get::<BassChannelStop>(b"BASS_ChannelStop") },
                unsafe { lib.get::<BassStreamFree>(b"BASS_StreamFree") }
            ) {
                unsafe {
                    stop_fn(handle);
                    free_fn(handle);
                }
            }
        }
    }
    
    // Free BASS if initialized
    if state.bass_initialized {
        if let Some(lib) = state.bass_lib.as_ref() {
            if let Ok(bass_free) = unsafe { lib.get::<BassFree>(b"BASS_Free") } {
                unsafe { bass_free(); }
            }
        }
        state.bass_initialized = false;
    }
    
    // Reinitialize with new settings
    if let Some(lib) = state.bass_lib.as_ref() {
        let bass_init: Symbol<BassInit> = unsafe { 
            lib.get(b"BASS_Init").map_err(|_| "Could not load BASS_Init")? 
        };
        let bass_set_config: Symbol<BassSetConfig> = unsafe { 
            lib.get(b"BASS_SetConfig").map_err(|_| "Could not load BASS_SetConfig")? 
        };
        
        // Set buffer size before initialization
        unsafe { 
            bass_set_config(BASS_CONFIG_BUFFER, buffer_size); 
            bass_set_config(BASS_CONFIG_NET_TIMEOUT, 15000);
        }
        
        let ok = unsafe { bass_init(device_id, sample_rate, 0, std::ptr::null_mut(), std::ptr::null_mut()) };
        if ok == 0 {
            let error = bass_err(lib);
            return Err(format!("Failed to reinitialize audio: {}", error));
        }
        
        state.bass_initialized = true;
        println!("[bass] Audio reinitialized successfully");
    }
    
    Ok(serde_json::json!({
        "success": true,
        "message": "Audio reinitialized successfully"
    }))
}

// BASS constants for configuration
const BASS_CONFIG_BUFFER: c_uint = 0;
const BASS_CONFIG_NET_BUFFER: c_uint = 12;

// Additional utility functions for proper BASS management
#[tauri::command]
pub async fn playback_cleanup() -> Result<bool, String> {
    let mut st = STATE.lock().unwrap();
    
    // Stop and free any active stream
    if let (Some(h), Some(lib)) = (st.stream.take(), st.bass_lib.as_ref()) {
        if let (Ok(stop_fn), Ok(free_fn)) = (
            unsafe { lib.get::<BassChannelStop>(b"BASS_ChannelStop") },
            unsafe { lib.get::<BassStreamFree>(b"BASS_StreamFree") }
        ) {
            unsafe {
                stop_fn(h);
                free_fn(h);
            }
        }
    }
    
    // Free BASS
    if let Some(lib) = st.bass_lib.as_ref() {
        if let Ok(free_fn) = unsafe { lib.get::<BassFree>(b"BASS_Free") } {
            unsafe { free_fn(); }
        }
    }
    
    // Reset state
    *st = PlaybackState::new();
    
    Ok(true)
}

// Implementation note: The BASS DLL should be placed in the bin/ directory
// and will be automatically included in the Tauri bundle via the resources configuration.
// On Windows, the library is loaded dynamically at runtime, so no import library (.lib) is needed.

// Cache management commands (integrated into playback module)
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
    let (tx, _rx) = mpsc::unbounded_channel::<CacheDownloadResult>();
    download_and_cache_audio(track_id, source_type, source_hash, url, tx).await;

    // For compatibility, return a dummy path since the actual result is handled asynchronously
    Ok("Download started".to_string())
}

#[tauri::command]
pub async fn cache_get_stats() -> Result<serde_json::Value, String> {
    let cache_guard = CACHE.lock().unwrap();
    if let Some(cache) = cache_guard.as_ref() {
        let (total_size, entry_count) = (cache.index.total_size, cache.index.entries.len());
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
        // Remove all cached files
        for entry in cache.index.entries.values() {
            let file_path = cache.cache_dir.join(&entry.file_path);
            if file_path.exists() {
                let _ = fs::remove_file(file_path);
            }
        }

        // Reset index
        cache.index = CacheIndex::new();
        cache.save_index()?;

        println!("[cache] Cache cleared");
        return Ok(());
    }
    Err("Cache not initialized".to_string())
}

// Volume control commands

#[tauri::command]
pub async fn playback_set_volume(volume: f32) -> Result<serde_json::Value, String> {
    let mut state = STATE.lock().unwrap();
    
    // Clamp volume between 0.0 and 1.0
    let clamped_volume = volume.max(0.0).min(1.0);
    state.volume = clamped_volume;
        
    // If currently muted, don't actually set the volume yet
    if state.muted {
        state.volume_before_mute = clamped_volume;
        return Ok(serde_json::json!({
            "success": true,
            "data": {
                "volume": clamped_volume,
                "muted": state.muted
            }
        }));
    }
    
    // Apply volume to current stream if playing
    if let (Some(handle), Some(ref lib)) = (state.stream, state.bass_lib.as_ref()) {
        let bass_channel_set_attribute: Symbol<BassChannelSetAttribute> = unsafe {
            lib.get(b"BASS_ChannelSetAttribute").map_err(|_| "Could not load BASS_ChannelSetAttribute")?
        };
        
        unsafe {
            let result = bass_channel_set_attribute(handle, BASS_ATTRIB_VOL, clamped_volume);
            if result == 0 {
                println!("[bass] Warning: Failed to set channel volume");
            } else {
                println!("[bass] Channel volume set successfully");
            }
        }
    }
    
    Ok(serde_json::json!({
        "success": true,
        "data": {
            "volume": clamped_volume,
            "muted": state.muted
        }
    }))
}

#[tauri::command]
pub async fn playback_get_volume() -> Result<serde_json::Value, String> {
    let state = STATE.lock().unwrap();
    
    Ok(serde_json::json!({
        "success": true,
        "data": {
            "volume": state.volume,
            "muted": state.muted
        }
    }))
}

#[tauri::command]
pub async fn playback_set_mute(muted: bool) -> Result<serde_json::Value, String> {
    let mut state = STATE.lock().unwrap();
    
    println!("[bass] Setting mute to {}", muted);
    
    if muted && !state.muted {
        // Muting: save current volume and set to 0
        state.volume_before_mute = state.volume;
        state.muted = true;
        
        if let (Some(handle), Some(ref lib)) = (state.stream, state.bass_lib.as_ref()) {
            let bass_channel_set_attribute: Symbol<BassChannelSetAttribute> = unsafe {
                lib.get(b"BASS_ChannelSetAttribute").map_err(|_| "Could not load BASS_ChannelSetAttribute")?
            };
            
            unsafe {
                let result = bass_channel_set_attribute(handle, BASS_ATTRIB_VOL, 0.0);
                if result == 0 {
                    println!("[bass] Warning: Failed to mute channel");
                } else {
                    println!("[bass] Channel muted successfully");
                }
            }
        }
    } else if !muted && state.muted {
        // Unmuting: restore previous volume
        state.muted = false;
        
        if let (Some(handle), Some(ref lib)) = (state.stream, state.bass_lib.as_ref()) {
            let bass_channel_set_attribute: Symbol<BassChannelSetAttribute> = unsafe {
                lib.get(b"BASS_ChannelSetAttribute").map_err(|_| "Could not load BASS_ChannelSetAttribute")?
            };
            
            unsafe {
                let result = bass_channel_set_attribute(handle, BASS_ATTRIB_VOL, state.volume_before_mute);
                if result == 0 {
                    println!("[bass] Warning: Failed to unmute channel");
                } else {
                    println!("[bass] Channel unmuted successfully");
                }
            }
        }
        
        state.volume = state.volume_before_mute;
    }
    
    Ok(serde_json::json!({
        "success": true,
        "data": {
            "volume": state.volume,
            "muted": state.muted
        }
    }))
}

#[tauri::command]
pub async fn playback_toggle_mute() -> Result<serde_json::Value, String> {
    let current_muted = {
        let state = STATE.lock().unwrap();
        state.muted
    };
    
    playback_set_mute(!current_muted).await
}