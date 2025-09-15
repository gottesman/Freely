use anyhow::Result;
use once_cell::sync::Lazy;
use std::{sync::Mutex, time::{Instant, Duration}, ffi::{CString, CStr, c_void}, collections::HashSet};
use std::os::raw::{c_int, c_char, c_uint, c_ulong};
use libloading::{Library, Symbol};
use serde::Deserialize;
use tokio::sync::mpsc;
use reqwest;
use tauri::Emitter;
use crate::cache::{download_and_cache_audio, CacheDownloadResult, get_cached_file_path};
use crate::bass::{ensure_bass_loaded, bass_err, probe_duration_bass, load_bass_plugins};
use crate::bass::{
    BassInit, BassFree, BassSetConfig, BassStreamCreateFile, BassStreamCreateUrl, BassStreamFree,
    BassChannelPlay, BassChannelPause, BassChannelStop, BassChannelIsActive, BassChannelGetLength,
    BassChannelGetPosition, BassChannelBytes2Seconds, BassChannelSeconds2Bytes, BassChannelSetPosition,
    BassErrorGetCode, BassChannelSetAttribute, BassGetVolume, BassSetVolume, BassGetDeviceInfo,
    BassGetInfo, BassGetDevice, BassDeviceInfo, BassInfo,
    BASS_DEVICE_DEFAULT, BASS_CONFIG_NET_TIMEOUT, BASS_CONFIG_NET_AGENT, BASS_CONFIG_NET_BUFFER, BASS_STREAM_BLOCK,
    BASS_STREAM_STATUS, BASS_STREAM_AUTOFREE, BASS_STREAM_PRESCAN, BASS_STREAM_RESTRATE, BASS_POS_BYTE, BASS_ACTIVE_STOPPED,
    BASS_ACTIVE_PLAYING, BASS_ACTIVE_STALLED, BASS_ACTIVE_PAUSED, BASS_ATTRIB_VOL,
    BASS_DEVICE_ENABLED, BASS_DEVICE_DEFAULT_FLAG, BASS_DEVICE_INIT,
};
use crate::utils::{resolve_audio_source};
use std::collections::HashMap;
use std::time::SystemTime;

pub struct PlaybackState {
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
    pub bass_lib: Option<Library>,
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
    ongoing_cache_downloads: std::collections::HashSet<String>,
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
            ongoing_cache_downloads: HashSet::new(),
        } 
    } 
}

static STATE: Lazy<Mutex<PlaybackState>> = Lazy::new(|| Mutex::new(PlaybackState::new()));

// Short-lived dedupe map to avoid duplicate playback_start_with_source work when frontend
// accidentally invokes it multiple times in quick succession. Maps a key -> epoch millis.
static RECENT_STARTS: Lazy<Mutex<HashMap<String, u128>>> = Lazy::new(|| Mutex::new(HashMap::new()));


// SAFETY: We mark PlaybackState as Send because we guard all access behind a Mutex and only manipulate
// BASS objects on the threads invoking the tauri commands. This is a simplification; for production
// consider a single dedicated audio thread and message passing instead of unsafe impls.
unsafe impl Send for PlaybackState {}

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
    if st.bass_lib.is_none() {
        match ensure_bass_loaded() {
            Ok(lib) => {
                st.bass_lib = Some(lib);
                println!("[bass] BASS library loaded successfully");
            }
            Err(e) => {
                println!("[bass] Failed to load BASS library: {}", e);
                return Err(e);
            }
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
            // Increase network buffer to 15 seconds to enable better seeking
            bass_set_config(BASS_CONFIG_NET_BUFFER, 15000);
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
                BASS_STREAM_STATUS | BASS_STREAM_AUTOFREE | BASS_STREAM_BLOCK | BASS_STREAM_RESTRATE, // BLOCK for format detection + RESTRATE for seeking
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
    
    //println!("[bass] Playback state updated, duration: {:?}", st.duration);
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
    app: tauri::AppHandle,
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
        let cache_result = get_cached_file_path(&track_id, &final_source_type, &final_source_hash);

        if let Some(cached_path) = cache_result {
            println!("[bass] Using cached file: {}", cached_path.display());
            return playback_start(format!("file://{}", cached_path.display())).await;
        }
        true // We want to cache even if not found
    } else {
        false
    };

    // Instead of immediately streaming the CDN URL (which creates a duplicate network stream),
    // start the background cache download first and try to play the temporary .part file as soon
    // as it has data. If the temp file doesn't become ready within a short timeout, fall back to
    // streaming the provided URL for instant playback.

    if use_cached {
        // Create a unique key for this download to prevent duplicates
        let download_key = format!("{}:{}:{}", track_id, final_source_type, final_source_hash);

        // Check if this download is already in progress
        {
            let state_guard = STATE.lock().unwrap();
            if state_guard.ongoing_cache_downloads.contains(&download_key) {
                println!("[bass] Cache download already in progress for {}, skipping duplicate", download_key);
                // If a download is already in progress, we'll still attempt to play any existing .part file
            } else {
                println!("[bass] Starting background cache download for {}", download_key);

                // Mark this download as in progress
                {
                    let mut state_guard = STATE.lock().unwrap();
                    state_guard.ongoing_cache_downloads.insert(download_key.clone());
                }

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
                let download_key_clone = download_key.clone();

                let app_clone = app.clone();
                tokio::spawn(async move {
                    // Call download_and_cache_audio with an AppHandle so it can emit progress events
                    download_and_cache_audio(Some(app_clone), track_id_clone, source_type_clone, source_hash_clone, url_clone, tx).await;

                    // Remove this download from the ongoing downloads set
                    let mut state_guard = STATE.lock().unwrap();
                    state_guard.ongoing_cache_downloads.remove(&download_key_clone);
                });

                // Spawn a task to listen for cache completion and switch playback
                let current_track_id = track_id.clone();
                let current_source_type = final_source_type.clone();
                let current_source_hash = final_source_hash.clone();

                tokio::spawn(async move {
                    while let Some(result) = rx.recv().await {
                        // Check if this cached file is still relevant
                        // More lenient check: if we're currently playing and the cached track matches
                        let (should_switch, playing, current_track) = {
                            let state_guard = STATE.lock().unwrap();
                            (state_guard.playing && state_guard.current_track_id.as_ref() == Some(&result.track_id),
                             state_guard.playing,
                             state_guard.current_track_id.clone())
                        };

                        println!("[bass] Cache completion check: should_switch={}, playing={}, cached_track={}, current_track={:?}",
                                 should_switch, playing, result.track_id, current_track);

                        if should_switch {
                            println!("[bass] Cache download completed, preparing gapless handoff to cached file: {}", result.cached_path);

                            // Delegate to the gapless handoff helper
                            gapless_handoff_to(result.cached_path.clone()).await;
                        } else {
                            println!("[bass] Cache completed but conditions not met (playing: {}, cached: {}, current: {:?}), ignoring switch",
                                     playing,
                                     result.track_id,
                                     current_track);
                        }
                        break; // Only handle one completion
                    }
                });
            }
        }

        // Attempt to play the .part file while background download is in progress if available.
        // Prefer reacting to inflight status updated by the downloader; fall back to quick filesystem polling.
        let immediate_playback_result: Result<serde_json::Value, String> = if let Some(tmp_path) = crate::cache::get_tmp_cache_path(&track_id, &final_source_type, &final_source_hash) {
            // Poll inflight bytes for up to ~3.5s
            let mut waited_ms = 0u64;
            let max_wait_ms = 3500u64;
            let mut play_result: Option<Result<serde_json::Value, String>> = None;
            while waited_ms < max_wait_ms {
                if let Some((bytes_downloaded, _total)) = crate::cache::get_inflight_status(&track_id, &final_source_type, &final_source_hash) {
                    if bytes_downloaded > 512 {
                        println!("[bass] Inflight download has {} bytes, attempting playback from temp file: {:?}", bytes_downloaded, tmp_path);
                        match playback_start(format!("file://{}", tmp_path.display())).await {
                            Ok(v) => { play_result = Some(Ok(v)); break; },
                            Err(e) => { println!("[bass] playback_start (tmp) failed after inflight check: {}", e); play_result = Some(Err(e)); break; }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                waited_ms += 100;
            }

            if let Some(res) = play_result {
                res
            } else {
                // Quick filesystem poll for up to 1.5s
                let mut waited_ms = 0u64;
                let max_wait_ms = 1500u64;
                let mut play_result2: Option<Result<serde_json::Value, String>> = None;
                while waited_ms < max_wait_ms {
                    if tmp_path.exists() {
                        if let Ok(metadata) = std::fs::metadata(&tmp_path) {
                            if metadata.len() > 512 {
                                println!("[bass] Quick-poll: playing from temp cache file while downloading: {:?}", tmp_path);
                                match playback_start(format!("file://{}", tmp_path.display())).await {
                                    Ok(v) => { play_result2 = Some(Ok(v)); break; },
                                    Err(e) => { println!("[bass] playback_start (tmp) failed after quick-poll: {}", e); play_result2 = Some(Err(e)); break; }
                                }
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    waited_ms += 100;
                }

                if let Some(res2) = play_result2 {
                    res2
                } else {
                    println!("[bass] Temp cache file not ready after wait, falling back to streaming URL");
                    playback_start(url.clone()).await
                }
            }
        } else {
            // No tmp path available; immediately stream
            println!("[bass] No tmp path available, streaming URL: {}", url);
            playback_start(url.clone()).await
        };

        match &immediate_playback_result {
            Ok(val) => println!("[bass] Immediate playback started: {:?}", val),
            Err(e) => println!("[bass] Immediate playback failed: {}", e),
        }

        return immediate_playback_result;
    } else {
        // Not preferring cache: start streaming immediately
        println!("[bass] Starting streaming playback for instant access");
        return playback_start(url.clone()).await;
    }
}

// Perform a gapless handoff to a cached file path. This creates a second stream, seeks it to the
// current position, starts it muted, crossfades volumes, stops the old stream, and updates state.
async fn gapless_handoff_to(cached_path: String) {
    let cached_url = format!("file://{}", cached_path.clone());

    // Get current playback position
    let current_position = {
        if let Ok(status) = playback_status().await {
            status.get("data").and_then(|d| d.get("position")).and_then(|p| p.as_f64()).unwrap_or(0.0)
        } else {
            0.0
        }
    };

    // Acquire function pointers and snapshot state while holding lock
    let (maybe_fns, old_handle_opt, target_volume, is_muted) = {
        let state_guard = STATE.lock().unwrap();
        if state_guard.bass_lib.is_none() || state_guard.stream.is_none() {
            (None, state_guard.stream, state_guard.volume, state_guard.muted)
        } else {
            let lib_ref = state_guard.bass_lib.as_ref().unwrap();
            unsafe {
                let f_create_file: BassStreamCreateFile = *lib_ref.get(b"BASS_StreamCreateFile").unwrap();
                let f_channel_set_attr: BassChannelSetAttribute = *lib_ref.get(b"BASS_ChannelSetAttribute").unwrap();
                let f_channel_play: BassChannelPlay = *lib_ref.get(b"BASS_ChannelPlay").unwrap();
                let f_channel_stop: BassChannelStop = *lib_ref.get(b"BASS_ChannelStop").unwrap();
                let f_stream_free: BassStreamFree = *lib_ref.get(b"BASS_StreamFree").unwrap();
                let f_seconds_to_bytes: BassChannelSeconds2Bytes = *lib_ref.get(b"BASS_ChannelSeconds2Bytes").unwrap();
                let f_set_position: BassChannelSetPosition = *lib_ref.get(b"BASS_ChannelSetPosition").unwrap();

                (Some((f_create_file, f_channel_set_attr, f_channel_play, f_channel_stop, f_stream_free, f_seconds_to_bytes, f_set_position)), state_guard.stream, state_guard.volume, state_guard.muted)
            }
        }
    };

    if maybe_fns.is_none() || old_handle_opt.is_none() {
        // Fallback to simple playback if we can't do fancy handoff
        if let Ok(_) = playback_start(cached_url).await {
            if current_position > 0.0 { let _ = playback_seek(current_position).await; }
        }
        return;
    }

    let (bass_stream_create_file, bass_channel_set_attribute, bass_channel_play, bass_channel_stop, bass_stream_free, bass_channel_seconds_to_bytes, bass_channel_set_position) = maybe_fns.unwrap();

    let c_path = match CString::new(cached_path.clone()) { Ok(c) => c, Err(e) => { println!("[bass] Invalid cached path CString: {}", e); if let Ok(_) = playback_start(cached_url.clone()).await { let _ = playback_seek(current_position).await; } return; } };

    let new_handle = unsafe { bass_stream_create_file(0, c_path.as_ptr() as *const c_void, 0, 0, BASS_STREAM_AUTOFREE) };
    if new_handle == 0 {
        println!("[bass] Failed to create new stream for cached file, falling back");
        if let Ok(_) = playback_start(cached_url.clone()).await { let _ = playback_seek(current_position).await; }
        return;
    }

    unsafe { bass_channel_set_attribute(new_handle, BASS_ATTRIB_VOL, 0.0); }

    if current_position > 0.0 {
        let bytes = unsafe { bass_channel_seconds_to_bytes(new_handle, current_position) };
        unsafe { bass_channel_set_position(new_handle, bytes, BASS_POS_BYTE); }
    }

    unsafe { bass_channel_play(new_handle, 0); }

    // Crossfade
    let steps = 20u32;
    let step_delay_ms = 8u64;
    let old_handle = old_handle_opt.unwrap();
    let user_volume = if is_muted { 0.0 } else { target_volume };

    for i in 0..=steps {
        let t = (i as f32) / (steps as f32);
        let new_vol = user_volume * t;
        let old_vol = user_volume * (1.0 - t);
        unsafe {
            let _ = bass_channel_set_attribute(new_handle, BASS_ATTRIB_VOL, new_vol);
            let _ = bass_channel_set_attribute(old_handle, BASS_ATTRIB_VOL, old_vol);
        }
        tokio::time::sleep(Duration::from_millis(step_delay_ms)).await;
    }

    unsafe {
        let _ = bass_channel_set_attribute(new_handle, BASS_ATTRIB_VOL, user_volume);
        let _ = bass_channel_set_attribute(old_handle, BASS_ATTRIB_VOL, 0.0);
        let _ = bass_channel_stop(old_handle);
        let _ = bass_stream_free(old_handle);
    }

    {
        let mut state_guard = STATE.lock().unwrap();
        state_guard.stream = Some(new_handle);
        state_guard.url = Some(cached_url.clone());
        state_guard.playing = true;
        state_guard.started_at = Some(Instant::now());
        state_guard.paused_at = None;
        state_guard.accumulated_paused = Duration::ZERO;
    }

    println!("[bass] Gapless handoff complete, now playing cached file: {}", cached_url);
}

#[derive(Deserialize)]
pub struct PlaybackSourceSpec {
    pub track_id: String,
    pub source_type: String,
    pub source_value: String,
    pub prefer_cache: Option<bool>,
    pub source_meta: Option<serde_json::Value>,
    // Optional client-provided ID for correlation
    pub client_request_id: Option<String>,
}

#[tauri::command]
pub async fn playback_start_with_source(app: tauri::AppHandle, spec: PlaybackSourceSpec) -> Result<serde_json::Value, String> {
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
    // Dedupe rapid repeated calls: if we saw the same track+source very recently, return ack
    {
        let key = format!("{}:{}:{}", spec.track_id, spec.source_type, source_hash);
        let mut recent = RECENT_STARTS.lock().unwrap();
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis();
        if let Some(&ts) = recent.get(&key) {
            if now.saturating_sub(ts) < 2000 {
                println!("[bass] Duplicate playback_start_with_source for {}, returning quick ack", key);
                let _ = app.emit("playback:start:ack", serde_json::json!({
                    "trackId": spec.track_id,
                    "sourceType": spec.source_type,
                    "sourceHash": source_hash,
                    "async": true,
                    "dedup": true,
                    "clientRequestId": spec.client_request_id
                }));
                return Ok(serde_json::json!({ "success": true, "async": true, "dedup": true }));
            }
        }
        recent.insert(key, now);

        // Emit an immediate ack with optional client_request_id so frontend can correlate
        let _ = app.emit("playback:start:ack", serde_json::json!({
            "trackId": spec.track_id,
            "sourceType": spec.source_type,
            "sourceHash": source_hash,
            "async": true,
            "early_ack": true,
            "clientRequestId": spec.client_request_id
        }));

        // Emit an immediate ack so the frontend can detect that we've accepted the
        // playback start request and begun internal work. Emitting here avoids a
        // race where the frontend subscribes after this command returns or when
        // we take a slow synchronous code path below.
        let _ = app.emit("playback:start:ack", serde_json::json!({
            "trackId": spec.track_id,
            "sourceType": spec.source_type,
            "sourceHash": source_hash,
            "async": true,
            "early_ack": true
        }));
    }
    if spec.prefer_cache.unwrap_or(true) {
        println!("[bass] Checking cache before URL resolution...");

        // Check for cached files directly
        if let Some(cached_path) = get_cached_file_path(&spec.track_id, &spec.source_type, &source_hash) {
            println!("[bass] Cache hit! Playing from cached file directly: {}", cached_path.display());

            // Start playback directly from cached file
            return playback_start(format!("file://{}", cached_path.display())).await;
        }

        // If a background download has already been started (e.g. user clicked Download first),
        // prefer to attempt playback from the temporary .part file while it's being written.
        // This avoids creating a duplicate CDN stream.
        if let Some(tmp_path) = crate::cache::get_tmp_cache_path(&spec.track_id, &spec.source_type, &source_hash) {
            // If inflight download exists, check bytes downloaded and try to play if there's enough data.
            if let Some((bytes_downloaded, _)) = crate::cache::get_inflight_status(&spec.track_id, &spec.source_type, &source_hash) {
                if bytes_downloaded > 512 {
                    println!("[bass] Inflight download found with {} bytes, attempting playback from tmp file: {:?}", bytes_downloaded, tmp_path);
                    match playback_start(format!("file://{}", tmp_path.display())).await {
                        Ok(v) => { println!("[bass] playback_start (tmp, inflight) returned Ok: {:?}", v); return Ok(v); },
                        Err(e) => { println!("[bass] playback_start (tmp, inflight) failed: {}", e); }
                    }
                } else {
                    // Wait briefly (up to 1s) for the tmp file to reach a minimal playable size
                    let mut waited_ms = 0u64;
                    let max_wait_ms = 1000u64;
                    while waited_ms < max_wait_ms {
                        if let Some((b, _)) = crate::cache::get_inflight_status(&spec.track_id, &spec.source_type, &source_hash) {
                            if b > 512 {
                                println!("[bass] Inflight download reached {} bytes, attempting playback from tmp file: {:?}", b, tmp_path);
                                match playback_start(format!("file://{}", tmp_path.display())).await {
                                    Ok(v) => { println!("[bass] playback_start (tmp after wait) returned Ok: {:?}", v); return Ok(v); },
                                    Err(e) => { println!("[bass] playback_start (tmp after wait) failed: {}", e); break; }
                                }
                            }
                        }
                        // quick filesystem check too
                        if tmp_path.exists() {
                            if let Ok(metadata) = std::fs::metadata(&tmp_path) {
                                if metadata.len() > 512 {
                                    println!("[bass] Tmp file now has {} bytes, attempting playback: {:?}", metadata.len(), tmp_path);
                                    match playback_start(format!("file://{}", tmp_path.display())).await {
                                        Ok(v) => { println!("[bass] playback_start (tmp after fs wait) returned Ok: {:?}", v); return Ok(v); },
                                        Err(e) => { println!("[bass] playback_start (tmp after fs wait) failed: {}", e); break; }
                                    }
                                }
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        waited_ms += 100;
                    }
                }
            } else {
                // No inflight record, but tmp file might exist from another worker
                if tmp_path.exists() {
                    if let Ok(metadata) = std::fs::metadata(&tmp_path) {
                        if metadata.len() > 512 {
                            println!("[bass] Tmp file exists with {} bytes, attempting playback: {:?}", metadata.len(), tmp_path);
                            match playback_start(format!("file://{}", tmp_path.display())).await {
                                Ok(v) => { println!("[bass] playback_start (tmp existing) returned Ok: {:?}", v); return Ok(v); },
                                Err(e) => { println!("[bass] playback_start (tmp existing) failed: {}", e); }
                            }
                        }
                    }
                }
            }
        }

        println!("[bass] Cache miss, proceeding with URL resolution...");
    }

    // Only resolve URL if we don't have a cached file
    println!("[bass] Resolving source URL...");
    let resolved_url = resolve_audio_source(&spec.source_type, &spec.source_value).await?;
    println!("[bass] Resolved source URL: {}", resolved_url);

    // Start playback immediately on the command thread so the frontend doesn't
    // need to wait for a background worker to manipulate audio APIs.
    println!("[bass] Starting immediate playback attempt for URL: {}", resolved_url);
    // If caching is preferred, spawn the background cache download *before*
    // attempting immediate playback. This allows us to try playing the
    // temporary .part file if it becomes ready quickly and avoids creating a
    // duplicate CDN stream when a local partial file is available.
    if spec.prefer_cache.unwrap_or(true) {
        // Create unique download key and avoid duplicate downloads
        let download_key = format!("{}:{}:{}", spec.track_id, spec.source_type, source_hash);

        {
            let state_guard = STATE.lock().unwrap();
            if state_guard.ongoing_cache_downloads.contains(&download_key) {
                println!("[bass] Cache download already in progress for {}, skipping spawn", download_key);
            } else {
                println!("[bass] Spawning background cache download for {}", download_key);

                // Mark ongoing
                {
                    let mut state_guard = STATE.lock().unwrap();
                    state_guard.ongoing_cache_downloads.insert(download_key.clone());
                }

                // create channel
                let (tx, mut rx) = mpsc::unbounded_channel::<CacheDownloadResult>();

                // store sender
                {
                    let mut state_guard = STATE.lock().unwrap();
                    state_guard.cache_download_tx = Some(tx.clone());
                }

                // spawn download worker
                let app_clone = app.clone();
                let track_id_clone = spec.track_id.clone();
                let source_type_clone = spec.source_type.clone();
                let source_hash_clone = source_hash.clone();
                let url_clone = resolved_url.clone();
                let download_key_clone = download_key.clone();

                tokio::spawn(async move {
                    download_and_cache_audio(Some(app_clone), track_id_clone, source_type_clone, source_hash_clone, url_clone, tx).await;

                    // remove from ongoing
                    let mut state_guard = STATE.lock().unwrap();
                    state_guard.ongoing_cache_downloads.remove(&download_key_clone);
                });

                // spawn listener to perform gapless handoff when download completes
                let current_track_id = spec.track_id.clone();
                tokio::spawn(async move {
                    while let Some(result) = rx.recv().await {
                        let (should_switch, playing, current_track) = {
                            let state_guard = STATE.lock().unwrap();
                            (state_guard.playing && state_guard.current_track_id.as_ref() == Some(&result.track_id),
                             state_guard.playing,
                             state_guard.current_track_id.clone())
                        };

                        println!("[bass] Cache completion check (bg listener): should_switch={}, playing={}, cached_track={}, current_track={:?}", should_switch, playing, result.track_id, current_track);

                        if should_switch {
                            println!("[bass] Cache download completed (bg), performing gapless handoff: {}", result.cached_path);
                            gapless_handoff_to(result.cached_path.clone()).await;
                        } else {
                            println!("[bass] Cache completed (bg) but not switching: playing={}, cached={}, current={:?}", playing, result.track_id, current_track);
                        }
                        break;
                    }
                });
            }
        }

        // Spawn a non-blocking task to attempt immediate playback (tmp .part preferred).
        // Returning quickly prevents the frontend from getting stuck waiting on a long blocking call.
        let play_track = spec.track_id.clone();
        let play_type = spec.source_type.clone();
        let play_hash = source_hash.clone();
        let play_resolved = resolved_url.clone();

        tokio::spawn(async move {
            if let Some(tmp_path) = crate::cache::get_tmp_cache_path(&play_track, &play_type, &play_hash) {
                let mut played = false;
                let mut waited_ms = 0u64;
                let max_wait_ms = 3000u64;
                while waited_ms < max_wait_ms {
                    if tmp_path.exists() {
                        if let Ok(metadata) = std::fs::metadata(&tmp_path) {
                            if metadata.len() > 1024 {
                                println!("[bass] Playing from temp cache file while downloading: {:?}", tmp_path);
                                played = true;
                                break;
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    waited_ms += 100;
                }

                if played {
                    println!("[bass] Attempting playback from temp file: {:?}", tmp_path);
                    match playback_start(format!("file://{}", tmp_path.display())).await {
                        Ok(val) => println!("[bass] playback_start (tmp) returned Ok: {:?}", val),
                        Err(e) => println!("[bass] playback_start (tmp) returned Err: {}", e),
                    }
                } else {
                    println!("[bass] Temp cache file not ready, falling back to streaming URL for instant playback");
                    println!("[bass] Attempting playback from stream URL: {}", play_resolved);
                    match playback_start(play_resolved.clone()).await {
                        Ok(val) => println!("[bass] playback_start (stream) returned Ok: {:?}", val),
                        Err(e) => println!("[bass] playback_start (stream) returned Err: {}", e),
                    }
                }
            } else {
                // No tmp path available; immediately stream
                println!("[bass] No tmp path available, streaming URL: {}", play_resolved);
                match playback_start(play_resolved.clone()).await {
                    Ok(val) => println!("[bass] playback_start (stream) returned Ok: {:?}", val),
                    Err(e) => println!("[bass] playback_start (stream) returned Err: {}", e),
                }
            }
        });

        // Return immediately to caller — playback is started asynchronously.
        println!("[bass] playback_start_with_source returning immediately (async spawn done)");
        return Ok(serde_json::json!({ "success": true, "async": true }));
    }

    // Not preferring cache: start streaming immediately
    println!("[bass] Starting streaming playback for instant access");
    playback_start(resolved_url.clone()).await
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
        //println!("[bass] Playback state set to paused");
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
        //println!("[bass] Playback state set to playing");
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
    if state.bass_lib.is_none() {
        match ensure_bass_loaded() {
            Ok(lib) => state.bass_lib = Some(lib),
            Err(e) => {
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
        }
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
    
    /*
    println!("[bass] Current audio settings - device: {}, sample_rate: {}Hz, bit_depth: {}bit, volume: {:.2}, output_channels: {}", 
             actual_device, actual_sample_rate, actual_bit_depth, state.volume, actual_output_channels);
    */
    
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
                bass_set_config(BASS_CONFIG_NET_BUFFER, 15000);
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
            bass_set_config(BASS_CONFIG_NET_BUFFER, 15000);
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
                //println!("[bass] Channel volume set successfully");
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