use anyhow::Result;
use once_cell::sync::Lazy;
use std::{sync::Mutex, time::{Instant, Duration}, ffi::{CString, c_void, CStr}, collections::HashMap};
use std::os::raw::{c_int, c_char, c_uint, c_ulong};
use libloading::{Library, Symbol};
use serde::Deserialize;
use tauri::Emitter;
use crate::cache::{get_cached_file_path, get_cache_dir, add_cached_file_to_index, create_cache_filename};
use crate::bass::{
    ensure_bass_loaded, bass_err, probe_duration_bass,
    bass_init, bass_free, bass_set_config, bass_set_config_ptr,
    stream_create, stream_free, StreamSource,
    channel_play, channel_pause, channel_stop, channel_is_active,
    channel_get_length, channel_get_position, channel_bytes2seconds, channel_seconds2bytes,
    channel_set_position, channel_set_attribute, get_device_info, get_info, get_device,
    stream_get_file_position, error_get_code, BASS_CONFIG_BUFFER,
};
use crate::bass::{
    BassStreamCreateFile, BassStreamFree,
    BassChannelPlay, BassChannelStop, BassChannelSeconds2Bytes, BassChannelSetPosition,
    BassChannelSetAttribute, BassDeviceInfo, BassInfo, DownloadProc,
    BASS_DEVICE_DEFAULT, BASS_CONFIG_NET_TIMEOUT, BASS_CONFIG_NET_AGENT, BASS_CONFIG_NET_BUFFER, BASS_STREAM_BLOCK,
    BASS_STREAM_STATUS, BASS_STREAM_AUTOFREE, BASS_STREAM_PRESCAN, BASS_STREAM_RESTRATE, BASS_POS_BYTE, BASS_ACTIVE_STOPPED,
    BASS_ACTIVE_PLAYING, BASS_ACTIVE_STALLED, BASS_ACTIVE_PAUSED, BASS_ATTRIB_VOL,
    BASS_DEVICE_ENABLED, BASS_DEVICE_DEFAULT_FLAG, BASS_DEVICE_INIT,
    BASS_FILEPOS_CURRENT, BASS_FILEPOS_DOWNLOAD, BASS_FILEPOS_END, BASS_FILEPOS_START,
    BASS_FILEPOS_CONNECTED, BASS_FILEPOS_SIZE, BASS_FILEPOS_ASYNCBUF, BASS_FILEPOS_ASYNCBUFLEN,
};
use crate::utils::{resolve_audio_source_with_format, AudioFormat, ResolvedAudioSource};
use crate::commands::playback::{playback_status, playback_seek};
use std::time::SystemTime;
use std::sync::Arc;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

// Centralized runtime configuration for BASS-related timeouts and buffers
#[derive(Clone)]
struct PlaybackRuntimeConfig {
    // BASS_CONFIG_NET_TIMEOUT in milliseconds
    net_timeout_ms: u32,
    // BASS_CONFIG_NET_BUFFER in milliseconds
    net_buffer_ms: u32,
    // BASS_CONFIG_BUFFER in milliseconds
    buffer_size_ms: u32,
    // Extra wait after creating a streaming handle to allow initial buffering (ms)
    additional_buffer_wait_ms: u64,
}

impl Default for PlaybackRuntimeConfig {
    fn default() -> Self {
        Self {
            net_timeout_ms: 15000,
            net_buffer_ms: 15000,
            buffer_size_ms: 1024,
            additional_buffer_wait_ms: 200,
        }
    }
}

static RUNTIME_CFG: Lazy<Mutex<PlaybackRuntimeConfig>> = Lazy::new(|| Mutex::new(PlaybackRuntimeConfig::default()));

fn get_runtime_cfg_snapshot() -> PlaybackRuntimeConfig {
    RUNTIME_CFG.lock().unwrap().clone()
}

fn apply_bass_runtime_config(lib: &Library) {
    let cfg = get_runtime_cfg_snapshot();
    // Apply buffer sizes and timeouts to BASS
    bass_set_config(lib, BASS_CONFIG_BUFFER, cfg.buffer_size_ms);
    bass_set_config(lib, BASS_CONFIG_NET_TIMEOUT, cfg.net_timeout_ms);
    bass_set_config(lib, BASS_CONFIG_NET_BUFFER, cfg.net_buffer_ms);
}

// Structure to manage download file state for BASS download callback
#[derive(Clone)]
pub struct DownloadFileState {
    pub track_id: String,
    pub source_type: String,
    pub source_hash: String,
    pub cache_file: Arc<Mutex<File>>,
    pub cache_path: PathBuf,
    // When resuming without server Range support, skip this many bytes from the start
    pub skip_remaining: u64,
    // Observed bytes downloaded for this stream (captured on stop)
    pub downloaded_bytes: u64,
    // Observed total bytes if known (captured on stop)
    pub total_bytes: Option<u64>,
}

// filename helper was moved to crate::cache::create_cache_filename

// BASS download callback function
unsafe extern "C" fn download_proc(buffer: *const c_void, length: c_uint, user: *mut c_void) {
    if user.is_null() || buffer.is_null() || length == 0 {
        return;
    }
    
    // Cast user data back to our download state
    let state = &mut *(user as *mut DownloadFileState);
    
    // Convert buffer to byte slice and write to cache file
    let data_slice = std::slice::from_raw_parts(buffer as *const u8, length as usize);
    
    // If we need to skip some initial bytes (server didn't honor resume), drop them
    let mut write_slice = data_slice;
    if state.skip_remaining > 0 {
        let to_skip = std::cmp::min(state.skip_remaining as usize, write_slice.len());
        state.skip_remaining -= to_skip as u64;
        write_slice = &write_slice[to_skip..];
        if write_slice.is_empty() {
            return; // nothing to write this callback
        }
    }

    if let Ok(mut file) = state.cache_file.lock() {
        let _ = file.write_all(write_slice);
        // Flush every 100KB to balance performance and data safety
        if length > 100_000 {
            let _ = file.flush();
        }
    }

    // Update in-memory counter for bytes written (best-effort)
    state.downloaded_bytes = state.downloaded_bytes.saturating_add(write_slice.len() as u64);
}

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
    // Download file state for BASS callback
    download_file_state: Option<Box<DownloadFileState>>,
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
            download_file_state: None,
        } 
    } 
}

static STATE: Lazy<Mutex<PlaybackState>> = Lazy::new(|| Mutex::new(PlaybackState::new()));

// Short-lived dedupe map to avoid duplicate playback_start_with_source work when frontend
// accidentally invokes it multiple times in quick succession. Maps a key -> epoch millis.
static RECENT_STARTS: Lazy<Mutex<HashMap<String, u128>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// Unified function to create BASS streams with optional download callback for caching
fn create_bass_stream(
    lib: &Library,
    url: &str,
    enable_caching: bool,
    cache_info: Option<(&str, &str, &str)> // track_id, source_type, source_hash
) -> Result<(u32, Option<Box<DownloadFileState>>), String> {
    
    let handle = if url.starts_with("file://") {
        // For local files, use BASS_StreamCreateFile (no caching needed)
        let file_path = url.strip_prefix("file://").unwrap_or(url);
        let c_file_path = CString::new(file_path).map_err(|_| "Invalid file path: contains null bytes")?;
        println!("[bass] Creating stream from local file: {}", file_path);
        
    stream_create(lib, StreamSource::File(&c_file_path), BASS_STREAM_AUTOFREE, None, std::ptr::null_mut())
    } else {
        // For remote URLs, use BASS_StreamCreateURL
        let c_url = CString::new(url).map_err(|_| "Invalid URL: contains null bytes")?;
        
        if enable_caching && cache_info.is_some() {
            // Create stream with download callback for caching
            let (track_id, source_type, source_hash) = cache_info.unwrap();
            
            // Get cache directory
            let cache_dir = get_cache_dir().ok_or("Cache not initialized")?;
            
            // Create cache file name and path using .part for in-progress
            let base = create_cache_filename(track_id, source_type, source_hash);
            let cache_path = cache_dir.join(format!("{}.part", base));
            
            // Create or open the cache file. If it exists, open for append to resume;
            // otherwise create a new file.
            let (cache_file, existing_len) = if cache_path.exists() {
                let meta = std::fs::metadata(&cache_path).map_err(|e| format!("Failed to stat cache file: {}", e))?;
                let len = meta.len();
                let f = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&cache_path)
                    .map_err(|e| format!("Failed to open cache file for append: {}", e))?;
                println!("[bass] Resuming cache file: {} (existing {} bytes)", cache_path.display(), len);
                (f, len)
            } else {
                let f = OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&cache_path)
                    .map_err(|e| format!("Failed to create cache file: {}", e))?;
                (f, 0)
            };
            
            println!("[bass] Creating cache file: {}", cache_path.display());
            
            // Create download state
            let mut download_state = Box::new(DownloadFileState {
                track_id: track_id.to_string(),
                source_type: source_type.to_string(),
                source_hash: source_hash.to_string(),
                cache_file: Arc::new(Mutex::new(cache_file)),
                cache_path: cache_path,
                skip_remaining: 0,
                downloaded_bytes: existing_len as u64,
                total_bytes: None,
            });
            
            let stream_flags = BASS_STREAM_STATUS | BASS_STREAM_BLOCK;

            // Robust resume: always start from 0 and skip existing bytes in the callback.
            // This avoids duplicate data when servers ignore Range requests.
            if existing_len > 0 {
                download_state.skip_remaining = existing_len as u64;
            }
            let handle = stream_create(
                lib,
                StreamSource::Url { url: &c_url, offset: None },
                stream_flags,
                Some(download_proc),
                download_state.as_ref() as *const DownloadFileState as *mut std::ffi::c_void,
            );
            
            if handle == 0 {
                let error = bass_err(lib);
                println!("[bass] Stream creation with callback failed: {}", error);
                return Err(format!("Stream creation failed: {}", error));
            }
            
            println!("[bass] Stream created with download callback, handle: {}", handle);
            return Ok((handle, Some(download_state)));
        } else {
            // Create stream without download callback (streaming only)
            stream_create(
                lib,
                StreamSource::Url { url: &c_url, offset: None },
                BASS_STREAM_STATUS | BASS_STREAM_BLOCK,
                None,
                std::ptr::null_mut(),
            )
        }
    };
    
    if handle == 0 {
        let error = bass_err(lib);
        println!("[bass] Stream creation failed: {}", error);
        return Err(format!("Stream creation failed: {}", error));
    }
    
    println!("[bass] Stream created successfully, handle: {}", handle);
    Ok((handle, None))
}

// Function to finalize the cache file (.part -> extension-less) and add it to the cache index
async fn finalize_cache_file(track_id: String, source_type: String, source_hash: String, cache_path: PathBuf, downloaded_bytes: Option<u64>, total_bytes: Option<u64>) {
    // Check if file exists and has content
    if let Ok(metadata) = std::fs::metadata(&cache_path) {
        let file_size = metadata.len();
        
        if file_size > 1024 { // Only cache files larger than 1KB
            // If total size is known and file is incomplete, do not finalize yet
            if let Some(total) = total_bytes {
                if file_size < total {
                    println!("[bass] Download incomplete ({} of {} bytes), keeping .part: {}", file_size, total, cache_path.display());
                    return;
                }
            } else {
                // Unknown total size; be conservative and do not finalize on stop
                println!("[bass] Total size unknown, deferring finalization for: {}", cache_path.display());
                return;
            }
            // Create a proper cache filename (extension-less final name)
            let cache_filename = create_cache_filename(&track_id, &source_type, &source_hash);
            
            // Get cache directory and final path
            if let Some(cache_dir) = get_cache_dir() {
                let final_cache_path = cache_dir.join(&cache_filename);
                
                // Move the temporary .part file to the final (extension-less) location
                if let Err(e) = std::fs::rename(&cache_path, &final_cache_path) {
                    println!("[bass] Failed to move cache file to final location: {}", e);
                    // If rename fails, try copy and delete
                    if let Err(e2) = std::fs::copy(&cache_path, &final_cache_path) {
                        println!("[bass] Failed to copy cache file: {}", e2);
                        return;
                    }
                    let _ = std::fs::remove_file(&cache_path);
                }
                
                // Add to cache index
                if let Err(e) = add_cached_file_to_index(
                    track_id.clone(),
                    source_type.clone(),
                    source_hash.clone(),
                    cache_filename,
                    file_size
                ) {
                    println!("[bass] Failed to add file to cache index: {}", e);
                } else {
                    println!("[bass] Successfully cached audio file: {} ({}:{}), size: {} bytes", 
                            track_id, source_type, source_hash, file_size);
                }
            } else {
                println!("[bass] Could not get cache directory");
            }
        } else {
            println!("[bass] Cache file too small ({} bytes), not caching: {}", file_size, cache_path.display());
            let _ = std::fs::remove_file(&cache_path);
        }
    } else {
        println!("[bass] Cache file does not exist or cannot be accessed: {}", cache_path.display());
    }
}


// SAFETY: We mark PlaybackState as Send because we guard all access behind a Mutex and only manipulate
// BASS objects on the threads invoking the tauri commands. This is a simplification; for production
// consider a single dedicated audio thread and message passing instead of unsafe impls.
unsafe impl Send for PlaybackState {}

pub async fn playback_start_internal(url: String) -> Result<serde_json::Value, String> {
    println!("[bass] playback_start called");
    
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
    if st.bass_lib.is_none() {
        match ensure_bass_loaded() {
            Ok(lib) => st.bass_lib = Some(lib),
            Err(e) => return Err(e),
        }
    }
    
    // Clone the library reference to avoid borrow checker issues
    let lib_ptr = st.bass_lib.as_ref().unwrap() as *const Library;
    let lib = unsafe { &*lib_ptr };
    
    // Initialize BASS (only once)
    if !st.bass_initialized {
        println!("[bass] Initializing BASS audio system...");
        let ok = bass_init(lib, BASS_DEVICE_DEFAULT, 44100, 0);
        if ok == 0 { 
            let error_code = error_get_code(lib);
            
            // Error 14 (BASS_ERROR_ALREADY) means BASS is already initialized, which is fine
            // Error 48 (BASS_ERROR_WASAPI) might indicate audio device issues
            if error_code == 14 {
                println!("[bass] BASS already initialized (this is fine)");
                st.bass_initialized = true;
            } else if error_code == 48 {
                println!("[bass] WASAPI error detected, attempting fallback initialization...");
                // Try different sample rate
                // Try different sample rate
                let fallback_ok = bass_init(lib, BASS_DEVICE_DEFAULT, 48000, 0);
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
        
    // Apply current runtime configuration (timeouts/buffers)
    apply_bass_runtime_config(lib);
        
        println!("[bass] BASS initialization complete");
    } else {
        println!("[bass] BASS already initialized, skipping initialization");
    }
    
    // Set HTTP User-Agent for YouTube compatibility
    let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\0";
    bass_set_config_ptr(lib, BASS_CONFIG_NET_AGENT, user_agent.as_ptr());
    
    // Stop and free any existing stream
    if let Some(h) = st.stream.take() { 
        channel_stop(lib, h);
        stream_free(lib, h);
    }
    
    // Create new stream using unified function (no caching for simple playback_start)
    println!("[bass] Creating stream for: {}", actual_url);
    let (handle, _download_state) = create_bass_stream(lib, &actual_url, false, None)?;
    
    // Apply current volume to the new stream
    let current_volume = if st.muted { 0.0 } else { st.volume };
    let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, current_volume);
    if result == 0 {
        println!("[bass] Warning: Failed to set initial volume to {:.2}", current_volume);
    } else {
        println!("[bass] Initial volume set to {:.2}", current_volume);
    }
    
    // Apply seek offset if needed
    if st.seek_offset > 0.0 {
        let bytes = channel_seconds2bytes(lib, handle, st.seek_offset);
        if channel_set_position(lib, handle, bytes, BASS_POS_BYTE) == 0 { 
            st.last_error = Some(bass_err(lib)); 
        }
    }
    
    // Start playback
    println!("[bass] Starting playback...");
    if channel_play(lib, handle, 0) == 0 { 
        let error = bass_err(lib);
        println!("[bass] Playback start failed: {}", error);
        st.last_error = Some(error.clone()); 
        stream_free(lib, handle);
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

    // Snapshot library pointer, old handle, and volume/mute state
    let (lib_ptr_opt, old_handle_opt, target_volume, is_muted) = {
        let state_guard = STATE.lock().unwrap();
        let lib_ptr = state_guard.bass_lib.as_ref().map(|l| l as *const Library);
        (lib_ptr, state_guard.stream, state_guard.volume, state_guard.muted)
    };

    // Fallback if we can't handoff
    let (lib_ptr, old_handle) = match (lib_ptr_opt, old_handle_opt) {
        (Some(lp), Some(h)) => (lp, h),
        _ => {
            if let Ok(_) = playback_start_internal(cached_url).await {
                if current_position > 0.0 { let _ = playback_seek(current_position).await; }
            }
            return;
        }
    };

    // Create new stream from cached file via wrapper
    let c_path = match CString::new(cached_path.clone()) {
        Ok(c) => c,
        Err(e) => {
            println!("[bass] Invalid cached path CString: {}", e);
            if let Ok(_) = playback_start_internal(cached_url.clone()).await { let _ = playback_seek_internal(current_position).await; }
            return;
        }
    };

    let lib = unsafe { &*lib_ptr };
    let new_handle = stream_create(
        lib,
        StreamSource::File(c_path.as_c_str()),
        BASS_STREAM_AUTOFREE,
        None,
        std::ptr::null_mut(),
    );
    if new_handle == 0 {
        println!("[bass] Failed to create new stream for cached file, falling back");
        if let Ok(_) = playback_start_internal(cached_url.clone()).await { let _ = playback_seek_internal(current_position).await; }
        return;
    }

    // Prepare new stream volume and position
    let _ = channel_set_attribute(lib, new_handle, BASS_ATTRIB_VOL, 0.0);
    if current_position > 0.0 {
        let bytes = channel_seconds2bytes(lib, new_handle, current_position);
        let _ = channel_set_position(lib, new_handle, bytes, BASS_POS_BYTE);
    }

    // Start the new stream
    let _ = channel_play(lib, new_handle, 0);

    // Crossfade volumes
    let steps = 20u32;
    let step_delay_ms = 8u64;
    let user_volume = if is_muted { 0.0 } else { target_volume };
    for i in 0..=steps {
        let t = (i as f32) / (steps as f32);
        let new_vol = user_volume * t;
        let old_vol = user_volume * (1.0 - t);
        let _ = channel_set_attribute(lib, new_handle, BASS_ATTRIB_VOL, new_vol);
        let _ = channel_set_attribute(lib, old_handle, BASS_ATTRIB_VOL, old_vol);
        tokio::time::sleep(Duration::from_millis(step_delay_ms)).await;
    }

    // Finalize volumes and switch over
    let _ = channel_set_attribute(lib, new_handle, BASS_ATTRIB_VOL, user_volume);
    let _ = channel_set_attribute(lib, old_handle, BASS_ATTRIB_VOL, 0.0);
    let _ = channel_stop(lib, old_handle);
    let _ = stream_free(lib, old_handle);

    // Update state with the new handle
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

pub async fn playback_start_with_source_internal(app: tauri::AppHandle, spec: PlaybackSourceSpec) -> Result<serde_json::Value, String> {
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
                println!("[bass] Duplicate playback_start_with_source for {}, returning quick ack (last: {}ms ago)", key, now.saturating_sub(ts));
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
    }
    if spec.prefer_cache.unwrap_or(true) {
        println!("[bass] Checking cache before URL resolution...");

        // Check for cached files directly
        if let Some(cached_path) = get_cached_file_path(&spec.track_id, &spec.source_type, &source_hash) {
            println!("[bass] Cache hit! Playing from cached file directly: {}", cached_path.display());
            return playback_start_internal(format!("file://{}", cached_path.display())).await;
        }

        println!("[bass] Cache miss, proceeding with URL resolution...");
    }

    // Only resolve URL if we don't have a cached file
    println!("[bass] Resolving source URL with format information...");
    let resolved_source = resolve_audio_source_with_format(&spec.source_type, &spec.source_value).await?;
    println!("[bass] Resolved source URL: {}, format: {:?}", resolved_source.url, resolved_source.format);

    // Use the new BASS download callback approach for both streaming and caching
    if spec.prefer_cache.unwrap_or(true) {
        println!("[bass] Starting playback with BASS download callback for caching");
        
        // Ensure BASS library is loaded
        let lib_ref = {
            let mut state = STATE.lock().unwrap();
            if state.bass_lib.is_none() {
                match ensure_bass_loaded() {
                    Ok(lib) => state.bass_lib = Some(lib),
                    Err(e) => return Err(format!("Failed to load BASS library: {}", e)),
                }
            }
            // We need to clone the pointer for use outside the lock
            state.bass_lib.as_ref().unwrap() as *const Library
        };
        let lib = unsafe { &*lib_ref };
        
        // Initialize BASS if needed
        {
            let mut state = STATE.lock().unwrap();
            if !state.bass_initialized {
                println!("[bass] Initializing BASS audio system...");
                let ok = bass_init(lib, BASS_DEVICE_DEFAULT, 44100, 0);
                if ok == 0 { 
                    let error_code = error_get_code(lib);
                    
                    if error_code == 14 {
                        println!("[bass] BASS already initialized");
                    } else {
                        return Err(format!("BASS initialization failed with error code: {}", error_code));
                    }
                } else {
                    println!("[bass] BASS initialized successfully");
                }
                
                state.bass_initialized = true;
                
                // Apply current runtime configuration (timeouts/buffers)
                apply_bass_runtime_config(lib);
                
                // Set HTTP User-Agent for YouTube compatibility
                let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\0";
                bass_set_config_ptr(lib, BASS_CONFIG_NET_AGENT, user_agent.as_ptr());
            }
        }
        
        // Create stream with download callback using unified function
        let (handle, mut download_state) = {
            let cache_info = Some((spec.track_id.as_str(), spec.source_type.as_str(), source_hash.as_str()));
            let (handle, download_state) = create_bass_stream(lib, &resolved_source.url, true, cache_info)?;
            (handle, download_state.expect("Download state should be present when caching is enabled"))
        };
        // If we know the total file size from resolution, store it in the download state now
        if let Some(total) = resolved_source.format.as_ref().and_then(|f| f.filesize) {
            download_state.total_bytes = Some(total);
        }
        
    // Wait a brief moment for additional buffering after stream creation
    // This gives us more control over buffering without the blocking behavior during creation
    let add_wait = get_runtime_cfg_snapshot().additional_buffer_wait_ms;
    tokio::time::sleep(std::time::Duration::from_millis(add_wait)).await;
        println!("[bass] Additional buffering wait completed");
        
        // Apply volume and start playback
        {
            let mut state = STATE.lock().unwrap();
            
            // Apply current volume to the new stream
            let current_volume = if state.muted { 0.0 } else { state.volume };
            let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, current_volume);
            if result == 0 {
                println!("[bass] Warning: Failed to set initial volume to {:.2}", current_volume);
            } else {
                println!("[bass] Initial volume set to {:.2}", current_volume);
            }
            
            // Start playback
            
            println!("[bass] Starting playback with download callback...");
            if channel_play(lib, handle, 0) == 0 { 
                let error = bass_err(lib);
                println!("[bass] Playback start failed: {}", error);
                
                // Clean up on failure
                stream_free(lib, handle);
                return Err(error); 
            }
            println!("[bass] Playback started successfully with download callback");
            
            // Stop and free any existing stream
            if let Some(old_handle) = state.stream.take() {
                channel_stop(lib, old_handle);
                stream_free(lib, old_handle);
            }
            
            // Update state
            state.duration = probe_duration_bass(lib, handle);
            state.stream = Some(handle);
            state.url = Some(resolved_source.url.clone());
            state.playing = true;
            state.started_at = Some(Instant::now());
            state.paused_at = None;
            state.accumulated_paused = Duration::ZERO;
            state.ended = false;
            state.last_error = None;
            state.current_track_id = Some(spec.track_id.clone());
            state.current_source_type = Some(spec.source_type.clone());
            state.current_source_hash = Some(source_hash.clone());
            state.download_file_state = Some(download_state);
        }
        
        println!("[bass] Playback started with BASS download callback, audio will be cached automatically");
        return Ok(serde_json::json!({"success": true, "data": {"caching": true}}));
    } else {
        // Not preferring cache: start streaming immediately without callback
        println!("[bass] Starting streaming playback without caching");
        return playback_start_internal(resolved_source.url.clone()).await;
    }
}

pub async fn playback_pause_internal() -> Result<serde_json::Value, String> { 
    println!("[bass] playback_pause called");
    let mut st = STATE.lock().unwrap(); 
    if let Some(h) = st.stream {
        if let Some(lib) = st.bass_lib.as_ref() {
            println!("[bass] Pausing stream with handle: {}", h);
            
            // Check download progress before pausing
            {
                let downloaded = stream_get_file_position(lib, h, BASS_FILEPOS_DOWNLOAD);
                let connected = stream_get_file_position(lib, h, BASS_FILEPOS_CONNECTED);
                println!("[bass] Before pause - downloaded: {} bytes, connected: {}", downloaded, connected != 0);
            }
            
            if channel_pause(lib, h) == 0 {
                let error = bass_err(lib);
                println!("[bass] Pause failed: {}", error);
                st.last_error = Some(error.clone());
                return Err(error);
            }
            println!("[bass] Stream paused successfully - download should continue in background");
            
            // Check download progress after pausing
            {
                let downloaded = stream_get_file_position(lib, h, BASS_FILEPOS_DOWNLOAD);
                let connected = stream_get_file_position(lib, h, BASS_FILEPOS_CONNECTED);
                println!("[bass] After pause - downloaded: {} bytes, connected: {}", downloaded, connected != 0);
            }
        }
    } 
    if st.playing { 
        st.playing = false; 
        st.paused_at = Some(Instant::now()); 
        println!("[bass] Playback state set to paused, but stream remains active for downloading");
    } 
    Ok(serde_json::json!({"success": true}))
}

pub async fn playback_resume_internal() -> Result<serde_json::Value, String> { 
    println!("[bass] playback_resume called");
    let mut st = STATE.lock().unwrap(); 
    if let Some(h) = st.stream {
        if let Some(lib) = st.bass_lib.as_ref() {
            println!("[bass] Resuming stream with handle: {}", h);
            if channel_play(lib, h, 0) == 0 {
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

pub async fn playback_stop_internal() -> Result<serde_json::Value, String> { 
    let mut st = STATE.lock().unwrap(); 
    // Capture download progress before freeing the stream
    let mut captured_progress: Option<(u64, Option<u64>)> = None;
    if let Some(h) = st.stream.take() {
        if let Some(lib) = st.bass_lib.as_ref() {
            let downloaded = stream_get_file_position(lib, h, BASS_FILEPOS_DOWNLOAD);
            let total = stream_get_file_position(lib, h, BASS_FILEPOS_SIZE);
            let downloaded_bytes = if downloaded == 0xFFFFFFFF { None } else { Some(downloaded as u64) };
            let total_bytes = if total == 0xFFFFFFFF { None } else { Some(total as u64) };
            if let Some(d) = downloaded_bytes { captured_progress = Some((d, total_bytes)); }
            channel_stop(lib, h);
            stream_free(lib, h);
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
    
    // Handle download file state cleanup and cache finalization
    if let Some(mut download_state) = st.download_file_state.take() {
        let track_id = download_state.track_id.clone();
        let source_type = download_state.source_type.clone();
        let source_hash = download_state.source_hash.clone();
        let cache_path = download_state.cache_path.clone();
        if let Some((d, t)) = captured_progress { download_state.downloaded_bytes = d; download_state.total_bytes = t; }
        
        println!("[bass] Finalizing cache file for stopped track: {}", cache_path.display());
        
        // Drop the download state to ensure file is closed
        drop(download_state);
        
        // Spawn async task to finalize cache (don't block the stop command)
        tokio::spawn(async move {
            let (dl, total) = captured_progress.unwrap_or((0, None));
            finalize_cache_file(track_id, source_type, source_hash, cache_path, Some(dl), total).await;
        });
    }
    
    Ok(serde_json::json!({"success": true})) 
}

pub async fn playback_seek_internal(position: f64) -> Result<serde_json::Value, String> { 
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
    
    
    // Try to get stream length and available data to check buffering status
    let _len_bytes = channel_get_length(lib, h, BASS_POS_BYTE);
    
    let bytes = channel_seconds2bytes(lib, h, pos);
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
        let current_bytes = channel_get_position(lib, h, BASS_POS_BYTE);
        if current_bytes != 0xFFFFFFFF {
            let current_pos = channel_bytes2seconds(lib, h, current_bytes);
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
        
        // For streaming content, try seek but don't fail the entire operation if it doesn't work
        if channel_set_position(lib, h, bytes, BASS_POS_BYTE) == 0 { 
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

pub async fn playback_status_internal() -> Result<serde_json::Value, String> { 
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
    let active = channel_is_active(lib, h); 
    if active == BASS_ACTIVE_STOPPED && st.playing { 
        st.playing = false; 
        st.ended = true; 
    } 
    
    // Try to get duration if we don't have it yet
    if st.duration.is_none() { 
        st.duration = probe_duration_bass(lib, h); 
    } 
    
    // Get current position
    let position = {
        let pos_bytes = channel_get_position(lib, h, BASS_POS_BYTE); 
        if pos_bytes == 0xFFFFFFFF {
            // Error getting position, return 0
            0.0
        } else {
            let secs = channel_bytes2seconds(lib, h, pos_bytes); 
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

pub async fn get_audio_devices_internal() -> Result<serde_json::Value, String> {
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
    
    // Enumerate devices via BASS_GetDeviceInfo wrapper
    
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
    let result = get_device_info(lib, device_index, &mut device_info);
        
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

pub async fn get_audio_settings_internal() -> Result<serde_json::Value, String> {
    let state = STATE.lock().unwrap();
    
    // Get actual audio settings from BASS if initialized
    let (actual_device, actual_sample_rate, actual_bit_depth, actual_output_channels) = if state.bass_initialized {
        if let Some(lib) = state.bass_lib.as_ref() {
            // Get BASS_GetDevice and BASS_GetInfo functions
            // Get current device
            let current_device = get_device(lib);
            println!("[bass] Current BASS device: {}", current_device);
            
            // If BASS returns BASS_DEVICE_DEFAULT (which is -1 but returned as large uint), 
            // we need to find the actual device ID that corresponds to the default device
            let resolved_device = if current_device == (BASS_DEVICE_DEFAULT as u32) || current_device == u32::MAX {
                // Find the real default device by enumerating devices
                let mut device_index = 0u32;
                let mut found_device = current_device as i32;
                loop {
                    let mut device_info = BassDeviceInfo { name: std::ptr::null(), driver: std::ptr::null(), flags: 0 };
                    let result = get_device_info(lib, device_index, &mut device_info);
                    if result == 0 { break; }
                    if (device_info.flags & BASS_DEVICE_DEFAULT_FLAG) != 0 {
                        println!("[bass] Found real default device: {} (was {})", device_index, current_device);
                        found_device = device_index as i32;
                        break;
                    }
                    device_index += 1;
                    if device_index > 32 { break; }
                }
                found_device
            } else { current_device as i32 };
            
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
            
            let result = get_info(lib, &mut bass_info);
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
            let mut device_index = 0u32;
            let mut default_device_id = -1i32;
            loop {
                let mut device_info = BassDeviceInfo { name: std::ptr::null(), driver: std::ptr::null(), flags: 0 };
                let result = get_device_info(lib, device_index, &mut device_info);
                if result == 0 { break; }
                if (device_info.flags & BASS_DEVICE_DEFAULT_FLAG) != 0 {
                    println!("[bass] Found default device during enumeration: {}", device_index);
                    default_device_id = device_index as i32; break;
                }
                device_index += 1; if device_index > 32 { break; }
            }
            (default_device_id, 44100, 16, 2) // Use found default device with fallback settings
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
            // Report the current runtime configuration values
            "buffer_size": get_runtime_cfg_snapshot().buffer_size_ms,
            "net_buffer": get_runtime_cfg_snapshot().net_buffer_ms,
            "net_timeout": get_runtime_cfg_snapshot().net_timeout_ms,
            "additional_buffer_wait": get_runtime_cfg_snapshot().additional_buffer_wait_ms,
            "volume": state.volume,
            "exclusive_mode": false, // This would need to be tracked separately
            "output_channels": actual_output_channels // Derived from BASS speakers count
        }
    }))
}

pub async fn set_audio_settings_internal(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    println!("[bass] Setting audio configuration: {:?}", settings);
    
    let mut state = STATE.lock().unwrap();
    let mut needs_reinit = false;
    let mut new_device = None;
    let mut new_sample_rate = None;
    let mut new_buffer_size = None;
    let mut new_net_timeout = None;
    let mut new_net_buffer = None;
    let mut new_additional_wait = None;
    
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
        needs_reinit = true; // BASS_CONFIG_BUFFER must be set before init
        println!("[bass] Buffer size change detected: {}", buffer_size);
    }

    // Network timeout and buffer do not require reinit; they can be applied live
    if let Some(timeout) = settings.get("net_timeout").and_then(|v| v.as_u64()) {
        new_net_timeout = Some(timeout as u32);
        println!("[bass] Net timeout change detected: {} ms", timeout);
    }
    if let Some(net_buf) = settings.get("net_buffer").and_then(|v| v.as_u64()) {
        new_net_buffer = Some(net_buf as u32);
        println!("[bass] Net buffer change detected: {} ms", net_buf);
    }
    if let Some(wait_ms) = settings.get("additional_buffer_wait").and_then(|v| v.as_u64()) {
        new_additional_wait = Some(wait_ms as u64);
        println!("[bass] Additional buffer wait change detected: {} ms", wait_ms);
    }
    
    // Update volume if provided (doesn't require reinitialization)
    if let Some(volume) = settings.get("volume").and_then(|v| v.as_f64()) {
        state.volume = volume as f32;
        println!("[bass] Volume change detected: {}", volume);
        
        // Apply volume to current stream if playing
        if let (Some(handle), Some(lib)) = (state.stream, state.bass_lib.as_ref()) {
            let current_volume = if state.muted { 0.0 } else { state.volume };
            let _ = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, current_volume);
            println!("[bass] Applied volume to current stream: {}", current_volume);
        }
    }
    
    // Persist runtime-only changes first (no reinit needed)
    if new_net_timeout.is_some() || new_net_buffer.is_some() || new_additional_wait.is_some() {
        let mut cfg = RUNTIME_CFG.lock().unwrap();
        if let Some(v) = new_net_timeout { cfg.net_timeout_ms = v; }
        if let Some(v) = new_net_buffer { cfg.net_buffer_ms = v; }
        if let Some(v) = new_additional_wait { cfg.additional_buffer_wait_ms = v; }

        // If BASS is initialized, apply the net_* changes immediately
        if state.bass_initialized {
            if let Some(lib) = state.bass_lib.as_ref() {
                bass_set_config(lib, BASS_CONFIG_NET_TIMEOUT, cfg.net_timeout_ms);
                bass_set_config(lib, BASS_CONFIG_NET_BUFFER, cfg.net_buffer_ms);
            }
        }
    }

    // If reinitialization is needed, do it
    if needs_reinit && state.bass_initialized {
        println!("[bass] Reinitialization required, stopping current playback and reinitializing BASS");
        
        // Stop current playback if any
        if let Some(handle) = state.stream.take() {
            if let Some(lib) = state.bass_lib.as_ref() {
                channel_stop(lib, handle);
                stream_free(lib, handle);
                println!("[bass] Stopped and freed current stream");
            }
        }
        
        // Free BASS if initialized
        if let Some(lib) = state.bass_lib.as_ref() {
            bass_free(lib);
            println!("[bass] Freed BASS resources");
        }
        state.bass_initialized = false;
        
        // Get current or new settings
        let device_id = new_device.unwrap_or(BASS_DEVICE_DEFAULT);
        let sample_rate = new_sample_rate.unwrap_or(44100);
    // Sync runtime config with buffer_size change
    if let Some(buf) = new_buffer_size { RUNTIME_CFG.lock().unwrap().buffer_size_ms = buf; }
    let buffer_size = RUNTIME_CFG.lock().unwrap().buffer_size_ms;
        
        // Reinitialize with new settings
        if let Some(lib) = state.bass_lib.as_ref() {
            // Apply runtime config before initialization
            apply_bass_runtime_config(lib);
            println!("[bass] Applied runtime config: buffer={}ms, net_timeout={}ms, net_buffer={}ms", buffer_size, get_runtime_cfg_snapshot().net_timeout_ms, get_runtime_cfg_snapshot().net_buffer_ms);
            
            let ok = bass_init(lib, device_id, sample_rate, 0);
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

pub async fn reinitialize_audio_internal(device_id: i32, sample_rate: u32, buffer_size: u32) -> Result<serde_json::Value, String> {
    println!("[bass] Reinitializing audio with device: {}, sample_rate: {}, buffer_size: {}", device_id, sample_rate, buffer_size);
    
    let mut state = STATE.lock().unwrap();
    
    // Stop current playback if any
    if let Some(handle) = state.stream.take() {
        if let Some(lib) = state.bass_lib.as_ref() {
            channel_stop(lib, handle);
            stream_free(lib, handle);
        }
    }
    
    // Free BASS if initialized
    if state.bass_initialized {
        if let Some(lib) = state.bass_lib.as_ref() {
            bass_free(lib);
        }
        state.bass_initialized = false;
    }
    
    // Reinitialize with new settings
    if let Some(lib) = state.bass_lib.as_ref() {
        // Sync and apply runtime config prior to init
        {
            let mut cfg = RUNTIME_CFG.lock().unwrap();
            cfg.buffer_size_ms = buffer_size;
        }
        apply_bass_runtime_config(lib);
        
        let ok = bass_init(lib, device_id, sample_rate, 0);
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

// BASS constants for configuration are imported from crate::bass

// Additional utility functions for proper BASS management
pub async fn playback_cleanup_internal() -> Result<bool, String> {
    let mut st = STATE.lock().unwrap();
    
    // Stop and free any active stream
    if let (Some(h), Some(lib)) = (st.stream.take(), st.bass_lib.as_ref()) {
        channel_stop(lib, h);
        stream_free(lib, h);
    }
    
    // Free BASS
    if let Some(lib) = st.bass_lib.as_ref() {
        bass_free(lib);
    }
    
    // Reset state
    *st = PlaybackState::new();
    
    Ok(true)
}

// Implementation note: The BASS DLL should be placed in the bin/ directory
// and will be automatically included in the Tauri bundle via the resources configuration.
// On Windows, the library is loaded dynamically at runtime, so no import library (.lib) is needed.

// Volume control commands

pub async fn playback_set_volume_internal(volume: f32) -> Result<serde_json::Value, String> {
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
        let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, clamped_volume);
        if result == 0 {
            println!("[bass] Warning: Failed to set channel volume");
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

pub async fn playback_get_volume_internal() -> Result<serde_json::Value, String> {
    let state = STATE.lock().unwrap();
    
    Ok(serde_json::json!({
        "success": true,
        "data": {
            "volume": state.volume,
            "muted": state.muted
        }
    }))
}

pub async fn playback_set_mute_internal(muted: bool) -> Result<serde_json::Value, String> {
    let mut state = STATE.lock().unwrap();
    
    println!("[bass] Setting mute to {}", muted);
    
    if muted && !state.muted {
        // Muting: save current volume and set to 0
        state.volume_before_mute = state.volume;
        state.muted = true;
        
        if let (Some(handle), Some(ref lib)) = (state.stream, state.bass_lib.as_ref()) {
            let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, 0.0);
            if result == 0 {
                println!("[bass] Warning: Failed to mute channel");
            } else {
                println!("[bass] Channel muted successfully");
            }
        }
    } else if !muted && state.muted {
        // Unmuting: restore previous volume
        state.muted = false;
        
        if let (Some(handle), Some(ref lib)) = (state.stream, state.bass_lib.as_ref()) {
            let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, state.volume_before_mute);
            if result == 0 {
                println!("[bass] Warning: Failed to unmute channel");
            } else {
                println!("[bass] Channel unmuted successfully");
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

pub async fn playback_toggle_mute_internal() -> Result<serde_json::Value, String> {
    let current_muted = {
        let state = STATE.lock().unwrap();
        state.muted
    };
    
    playback_set_mute_internal(!current_muted).await
}

pub async fn get_download_progress_internal() -> Result<serde_json::Value, String> {
    let state = STATE.lock().unwrap();
    
    if let (Some(handle), Some(lib)) = (state.stream, state.bass_lib.as_ref()) {
        // Prefer .part file size if we're actively caching via callback
        let mut downloaded_bytes: Option<u64> = None;
        if let Some(ref dfs) = state.download_file_state {
            if let Ok(meta) = std::fs::metadata(&dfs.cache_path) {
                downloaded_bytes = Some(meta.len());
            }
        }

        // Fallback: Ask BASS for download position
        if downloaded_bytes.is_none() {
            let downloaded = stream_get_file_position(lib, handle, BASS_FILEPOS_DOWNLOAD);
            if downloaded != 0xFFFFFFFF {
                downloaded_bytes = Some(downloaded as u64);
            }
        }

        // Total size: prefer known size from resolved format/download state
        let mut total_bytes: Option<u64> = state
            .download_file_state
            .as_ref()
            .and_then(|dfs| dfs.total_bytes);
        if total_bytes.is_none() {
            let total = stream_get_file_position(lib, handle, BASS_FILEPOS_SIZE);
            if total != 0xFFFFFFFF {
                total_bytes = Some(total as u64);
            }
        }

        // Connection state (may be 0 for local files)
        let connected = stream_get_file_position(lib, handle, BASS_FILEPOS_CONNECTED);
        let is_connected = connected != 0xFFFFFFFF && connected != 0;
        
        println!("[bass] Download progress: downloaded={:?}, total={:?}, connected={}", downloaded_bytes, total_bytes, is_connected);
        
        Ok(serde_json::json!({
            "success": true,
            "data": {
                "downloaded_bytes": downloaded_bytes,
                "total_bytes": total_bytes,
                "has_cache_file": state.download_file_state.is_some(),
                "is_connected": is_connected,
                "is_playing": state.playing
            }
        }))
    } else {
        Ok(serde_json::json!({
            "success": false,
            "message": "No active stream"
        }))
    }
}