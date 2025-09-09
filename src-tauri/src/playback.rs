use anyhow::Result;
use once_cell::sync::Lazy;
use std::{sync::Mutex, time::{Instant, Duration}, ffi::{CString, c_void}};
use std::os::raw::{c_int, c_char, c_uint, c_ulong};
use libloading::{Library, Symbol};

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
        } 
    } 
}

static STATE: Lazy<Mutex<PlaybackState>> = Lazy::new(|| Mutex::new(PlaybackState::new()));

// SAFETY: We mark PlaybackState as Send because we guard all access behind a Mutex and only manipulate
// BASS objects on the threads invoking the tauri commands. This is a simplification; for production
// consider a single dedicated audio thread and message passing instead of unsafe impls.
unsafe impl Send for PlaybackState {}

// BASS function type definitions
type BASS_Init = unsafe extern "system" fn(device: c_int, freq: c_uint, flags: c_uint, win: *mut c_void, dsguid: *mut c_void) -> c_int;
type BASS_Free = unsafe extern "system" fn() -> c_int;
type BASS_SetConfig = unsafe extern "system" fn(option: c_uint, value: c_uint) -> c_uint;
type BASS_PluginLoad = unsafe extern "system" fn(file: *const c_char, flags: c_uint) -> u32;
type BASS_StreamCreateFile = unsafe extern "system" fn(mem: c_int, file: *const c_void, offset: c_ulong, length: c_ulong, flags: c_uint) -> u32;
type BASS_StreamCreateURL = unsafe extern "system" fn(url: *const c_char, offset: c_ulong, flags: c_uint, proc_: *mut c_void, user: *mut c_void) -> u32;
type BASS_StreamFree = unsafe extern "system" fn(handle: u32) -> c_int;
type BASS_ChannelPlay = unsafe extern "system" fn(handle: u32, restart: c_int) -> c_int;
type BASS_ChannelPause = unsafe extern "system" fn(handle: u32) -> c_int;
type BASS_ChannelStop = unsafe extern "system" fn(handle: u32) -> c_int;
type BASS_ChannelIsActive = unsafe extern "system" fn(handle: u32) -> c_uint;
type BASS_ChannelGetLength = unsafe extern "system" fn(handle: u32, mode: c_uint) -> c_ulong;
type BASS_ChannelGetPosition = unsafe extern "system" fn(handle: u32, mode: c_uint) -> c_ulong;
type BASS_ChannelBytes2Seconds = unsafe extern "system" fn(handle: u32, pos: c_ulong) -> f64;
type BASS_ChannelSeconds2Bytes = unsafe extern "system" fn(handle: u32, sec: f64) -> c_ulong;
type BASS_ChannelSetPosition = unsafe extern "system" fn(handle: u32, pos: c_ulong, mode: c_uint) -> c_int;
type BASS_ErrorGetCode = unsafe extern "system" fn() -> c_int;

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
            let _: Symbol<BASS_ErrorGetCode> = lib.get(b"BASS_ErrorGetCode")
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
    let bass_plugin_load: Symbol<BASS_PluginLoad> = unsafe {
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
        match lib.get::<BASS_ErrorGetCode>(b"BASS_ErrorGetCode") {
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
        let get_length: Symbol<BASS_ChannelGetLength> = lib.get(b"BASS_ChannelGetLength").ok()?;
        let bytes_to_seconds: Symbol<BASS_ChannelBytes2Seconds> = lib.get(b"BASS_ChannelBytes2Seconds").ok()?;
        
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
    let bass_init: Symbol<BASS_Init> = unsafe { 
        lib.get(b"BASS_Init").map_err(|_| "Could not load BASS_Init")? 
    };
    let bass_set_config: Symbol<BASS_SetConfig> = unsafe { 
        lib.get(b"BASS_SetConfig").map_err(|_| "Could not load BASS_SetConfig")? 
    };
    let bass_stream_create_url: Symbol<BASS_StreamCreateURL> = unsafe { 
        lib.get(b"BASS_StreamCreateURL").map_err(|_| "Could not load BASS_StreamCreateURL")? 
    };
    let bass_stream_create_file: Symbol<BASS_StreamCreateFile> = unsafe { 
        lib.get(b"BASS_StreamCreateFile").map_err(|_| "Could not load BASS_StreamCreateFile")? 
    };
    let bass_stream_free: Symbol<BASS_StreamFree> = unsafe { 
        lib.get(b"BASS_StreamFree").map_err(|_| "Could not load BASS_StreamFree")? 
    };
    let bass_channel_play: Symbol<BASS_ChannelPlay> = unsafe { 
        lib.get(b"BASS_ChannelPlay").map_err(|_| "Could not load BASS_ChannelPlay")? 
    };
    let bass_channel_stop: Symbol<BASS_ChannelStop> = unsafe { 
        lib.get(b"BASS_ChannelStop").map_err(|_| "Could not load BASS_ChannelStop")? 
    };
    let bass_channel_seconds_to_bytes: Symbol<BASS_ChannelSeconds2Bytes> = unsafe { 
        lib.get(b"BASS_ChannelSeconds2Bytes").map_err(|_| "Could not load BASS_ChannelSeconds2Bytes")? 
    };
    let bass_channel_set_position: Symbol<BASS_ChannelSetPosition> = unsafe { 
        lib.get(b"BASS_ChannelSetPosition").map_err(|_| "Could not load BASS_ChannelSetPosition")? 
    };
    
    // Initialize BASS (only once)
    if !st.bass_initialized {
        println!("[bass] Initializing BASS audio system...");
        let ok = unsafe { bass_init(BASS_DEVICE_DEFAULT, 44100, 0, std::ptr::null_mut(), std::ptr::null_mut()) };
        if ok == 0 { 
            let error_code = unsafe {
                let get_error: Symbol<BASS_ErrorGetCode> = lib.get(b"BASS_ErrorGetCode")
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
    
    // Try to get cached file first if preferred
    if prefer_cache {
        match crate::cache::cache_get_file(track_id.clone(), final_source_type.clone(), final_source_hash.clone()).await {
            Ok(cache_result) => {
                if let Some(cached_path) = cache_result.get("cached_path").and_then(|v| v.as_str()) {
                    println!("[bass] Using cached file: {}", cached_path);
                    return playback_start(format!("file://{}", cached_path)).await;
                } else {
                    println!("[bass] No cached file available, using streaming URL");
                }
            }
            Err(e) => {
                println!("[bass] Cache check failed: {}, falling back to streaming", e);
            }
        }
    }
    
    // Start streaming playback
    let result = playback_start(url.clone()).await;
    
    // If streaming works and we want to cache, start background download
    if result.is_ok() && prefer_cache {
        let track_id_clone = track_id.clone();
        let source_type_clone = final_source_type.clone();
        let source_hash_clone = final_source_hash.clone();
        let url_clone = url.clone();
        tokio::spawn(async move {
            match crate::cache::cache_download_and_store(track_id_clone.clone(), source_type_clone.clone(), source_hash_clone.clone(), url_clone).await {
                Ok(cached_path) => {
                    println!("[bass] Background cache download completed: {}", cached_path);
                }
                Err(e) => {
                    println!("[bass] Background cache download failed for {} ({}:{}): {}", track_id_clone, source_type_clone, source_hash_clone, e);
                }
            }
        });
    }
    
    result
}

#[tauri::command]
pub async fn playback_pause() -> Result<serde_json::Value, String> { 
    println!("[bass] playback_pause called");
    let mut st = STATE.lock().unwrap(); 
    if let Some(h) = st.stream {
        if let Some(lib) = st.bass_lib.as_ref() {
            println!("[bass] Pausing stream with handle: {}", h);
            let bass_channel_pause: Symbol<BASS_ChannelPause> = unsafe { 
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
pub async fn playback_resume() -> Result<bool, String> { 
    println!("[bass] playback_resume called");
    let mut st = STATE.lock().unwrap(); 
    if let Some(h) = st.stream {
        if let Some(lib) = st.bass_lib.as_ref() {
            println!("[bass] Resuming stream with handle: {}", h);
            let bass_channel_play: Symbol<BASS_ChannelPlay> = unsafe { 
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
    Ok(true) 
}

#[tauri::command]
pub async fn playback_stop() -> Result<bool, String> { 
    let mut st = STATE.lock().unwrap(); 
    if let Some(h) = st.stream.take() {
        if let Some(lib) = st.bass_lib.as_ref() {
            if let (Ok(stop_fn), Ok(free_fn)) = (
                unsafe { lib.get::<BASS_ChannelStop>(b"BASS_ChannelStop") },
                unsafe { lib.get::<BASS_StreamFree>(b"BASS_StreamFree") }
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
    Ok(true) 
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
    
    let bass_channel_seconds_to_bytes: Symbol<BASS_ChannelSeconds2Bytes> = unsafe { 
        lib.get(b"BASS_ChannelSeconds2Bytes").map_err(|_| "Could not load BASS_ChannelSeconds2Bytes")? 
    };
    let bass_channel_set_position: Symbol<BASS_ChannelSetPosition> = unsafe { 
        lib.get(b"BASS_ChannelSetPosition").map_err(|_| "Could not load BASS_ChannelSetPosition")? 
    };
    
    // Try to get stream length and available data to check buffering status
    let _bass_channel_get_length: Option<Symbol<BASS_ChannelGetLength>> = unsafe { 
        lib.get(b"BASS_ChannelGetLength").ok()
    };
    let _bass_channel_get_available: Option<Symbol<BASS_ChannelGetLength>> = unsafe { 
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
        let bass_channel_get_position: Option<Symbol<BASS_ChannelGetPosition>> = lib.get(b"BASS_ChannelGetPosition").ok();
        
        if let Some(get_position) = &bass_channel_get_position {
            let current_bytes = get_position(h, BASS_POS_BYTE);
            if current_bytes != 0xFFFFFFFF {
                let bass_channel_bytes_to_seconds: Symbol<BASS_ChannelBytes2Seconds> = lib.get(b"BASS_ChannelBytes2Seconds").map_err(|_| "Could not load BASS_ChannelBytes2Seconds")?;
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
    let bass_channel_is_active: Symbol<BASS_ChannelIsActive> = unsafe { 
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
    let bass_channel_get_position: Symbol<BASS_ChannelGetPosition> = unsafe { 
        lib.get(b"BASS_ChannelGetPosition").map_err(|_| "Could not load BASS_ChannelGetPosition")? 
    };
    let bass_channel_bytes_to_seconds: Symbol<BASS_ChannelBytes2Seconds> = unsafe { 
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

// BASS backend: ensure bass DLL/so/dylib is shipped in resources (placed in bin/).

// Additional utility functions for proper BASS management
#[tauri::command]
pub async fn playback_cleanup() -> Result<bool, String> {
    let mut st = STATE.lock().unwrap();
    
    // Stop and free any active stream
    if let (Some(h), Some(lib)) = (st.stream.take(), st.bass_lib.as_ref()) {
        if let (Ok(stop_fn), Ok(free_fn)) = (
            unsafe { lib.get::<BASS_ChannelStop>(b"BASS_ChannelStop") },
            unsafe { lib.get::<BASS_StreamFree>(b"BASS_StreamFree") }
        ) {
            unsafe {
                stop_fn(h);
                free_fn(h);
            }
        }
    }
    
    // Free BASS
    if let Some(lib) = st.bass_lib.as_ref() {
        if let Ok(free_fn) = unsafe { lib.get::<BASS_Free>(b"BASS_Free") } {
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