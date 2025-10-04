use crate::audio_settings::{get_audio_settings, update_audio_settings, AudioSettings};
// Logging macros (exported globally) explicitly brought into scope for clarity
// logging macros are available via #[macro_export] from logging module
use crate::bass::{
    bass_err, bass_free, bass_init, bass_set_config, bass_set_config_ptr, channel_bytes2seconds,
    channel_get_attribute, channel_get_info, channel_get_length, channel_get_position,
    channel_get_tags, channel_is_active, channel_pause, channel_play, channel_seconds2bytes,
    channel_set_attribute, channel_set_position, channel_stop, ensure_bass_loaded, error_get_code,
    get_device, get_device_info, get_info, probe_audio_format_from_channel, probe_duration_bass,
    stream_create, stream_free, stream_get_file_position, BassAudioFormatInfo, BassChannelInfo,
    BassInfo, StreamSource, BASS_CONFIG_BUFFER, BASS_CTYPE_STREAM_AIFF, BASS_CTYPE_STREAM_CA,
    BASS_CTYPE_STREAM_DSD, BASS_CTYPE_STREAM_DSD_RAW, BASS_CTYPE_STREAM_MF, BASS_CTYPE_STREAM_MP3,
    BASS_CTYPE_STREAM_OGG, BASS_CTYPE_STREAM_WAV, BASS_CTYPE_STREAM_WAV_FLOAT,
    BASS_CTYPE_STREAM_WAV_PCM, BASS_CTYPE_STREAM_FLAC, BASS_CTYPE_STREAM_FLAC_OGG,
    BASS_CTYPE_STREAM_AAC, BASS_CTYPE_STREAM_MP4, BASS_CTYPE_STREAM_OPUS,
    BASS_CTYPE_STREAM_WEBM, BASS_CTYPE_STREAM_APE, BASS_CTYPE_STREAM_ALAC,
    BASS_TAG_APE, BASS_TAG_ID3V2, BASS_TAG_MP4, BASS_TAG_OGG, BASS_TAG_WMA, BASS_TAG_HTTP,
};
use crate::bass::{
    BassChannelPlay, BassChannelSeconds2Bytes, BassChannelSetAttribute, BassChannelSetPosition,
    BassChannelStop, BassDeviceInfo, BassStreamCreateFile, BassStreamFree, DownloadProc,
    BASS_ACTIVE_PAUSED, BASS_ACTIVE_PLAYING, BASS_ACTIVE_STALLED, BASS_ACTIVE_STOPPED,
    BASS_ATTRIB_FREQ, BASS_ATTRIB_VOL, BASS_CONFIG_NET_AGENT, BASS_CONFIG_NET_BUFFER,
    BASS_CONFIG_NET_TIMEOUT, BASS_DEVICE_DEFAULT, BASS_DEVICE_DEFAULT_FLAG, BASS_DEVICE_ENABLED,
    BASS_DEVICE_INIT, BASS_FILEPOS_ASYNCBUF, BASS_FILEPOS_ASYNCBUFLEN, BASS_FILEPOS_CONNECTED,
    BASS_FILEPOS_CURRENT, BASS_FILEPOS_DOWNLOAD, BASS_FILEPOS_END, BASS_FILEPOS_SIZE,
    BASS_FILEPOS_START, BASS_POS_BYTE, BASS_STREAM_AUTOFREE, BASS_STREAM_BLOCK,
    BASS_STREAM_PRESCAN, BASS_STREAM_RESTRATE, BASS_STREAM_STATUS,
};
use crate::cache::{
    add_cached_file_to_index, add_cached_file_to_index_with_format,
    add_cached_file_to_index_with_index, create_cache_filename, create_cache_filename_with_index,
    get_cache_dir, get_cached_file_path, get_cached_file_path_with_index,
};
use crate::commands::playback::{playback_seek, playback_status};
use crate::utils::{resolve_audio_source_with_format, AudioFormat, ResolvedAudioSource};
use anyhow::Result;
use libloading::{Library, Symbol};
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::raw::{c_char, c_int, c_uint, c_ulong};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use std::{
    collections::HashMap,
    ffi::{c_void, CStr, CString},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Emitter;

/// Structure to hold playback state for restoration after audio reinitialization
#[derive(Debug, Clone)]
struct PlaybackStateSnapshot {
    url: Option<String>,
    was_playing: bool,
    position: f64,
    track_id: Option<String>,
    source_type: Option<String>,
    source_hash: Option<String>,
}

impl PlaybackStateSnapshot {
    /// Create a snapshot of current playback state
    fn capture(state: &PlaybackState, lib: Option<&Library>) -> Self {
        let position = if let (Some(handle), Some(lib)) = (state.stream, lib) {
            let pos_bytes = channel_get_position(lib, handle, BASS_POS_BYTE);
            if pos_bytes != 0xFFFFFFFF {
                let secs = channel_bytes2seconds(lib, handle, pos_bytes);
                if secs.is_finite() && secs >= 0.0 {
                    secs
                } else {
                    0.0
                }
            } else {
                0.0
            }
        } else {
            0.0
        };

        Self {
            url: state.url.clone(),
            was_playing: state.playing,
            position,
            track_id: state.current_track_id.clone(),
            source_type: state.current_source_type.clone(),
            source_hash: state.current_source_hash.clone(),
        }
    }

    /// Check if there's a meaningful playback state to restore
    fn has_playback(&self) -> bool {
        self.url.is_some() && (self.was_playing || self.position > 0.0)
    }
}

/// Centralized BASS initialization function
/// This replaces all the duplicated initialization logic throughout the codebase
pub fn ensure_bass_initialized(state: &mut PlaybackState, force_reinit: bool) -> Result<(), String> {
    let settings = get_audio_settings();
    
    // Load BASS library if not already loaded
    if state.bass_lib.is_none() {
        match ensure_bass_loaded() {
            Ok(lib) => state.bass_lib = Some(lib),
            Err(e) => return Err(format!("Failed to load BASS library: {}", e)),
        }
    }
    
    let lib = state.bass_lib.as_ref().unwrap();
    
    // Check if we need to reinitialize
    let needs_init = !state.bass_initialized || force_reinit;
    
    if needs_init {
        // Free existing BASS instance if reinitializing
        if force_reinit && state.bass_initialized {
            log_info!("[bass] Force reinitializing BASS...");
            
            // Stop and free current stream if any
            if let Some(handle) = state.stream.take() {
                channel_stop(lib, handle);
                stream_free(lib, handle);
                log_debug!("[bass] Stopped and freed current stream for reinit");
            }
            
            bass_free(lib);
            state.bass_initialized = false;
        }
        
    log_info!("[bass] Initializing BASS audio system... (device={}, sample_rate={}Hz)", settings.device_id, settings.sample_rate);
        
        // Apply configuration before initialization
        settings.apply_to_bass(lib);
        
        // Initialize BASS
        let ok = bass_init(lib, settings.device_id, settings.sample_rate, 0);
        if ok == 0 {
            let error_code = error_get_code(lib);
            
            // Handle specific error cases
            match error_code {
                14 => {
                    // BASS_ERROR_ALREADY - already initialized
                    log_debug!("[bass] BASS already initialized (this is fine)");
                    state.bass_initialized = true;
                }
                48 => {
                    // BASS_ERROR_WASAPI - audio device issues
                    let error_msg = if settings.has_user_override {
                        format!("Audio device initialization failed for device {} at {}Hz (WASAPI error). Please check your audio device settings.", 
                                settings.device_id, settings.sample_rate)
                    } else {
                        "Audio device initialization failed. Please check your audio device settings.".to_string()
                    };
                    return Err(error_msg);
                }
                _ => {
                    let error = bass_err(lib);
                    return Err(format!("BASS initialization failed: {}", error));
                }
            }
        } else {
            log_info!("[bass] BASS initialized successfully");
            state.bass_initialized = true;
        }
        
        // Verify sample rate if user has overridden settings
        if settings.has_user_override {
            let mut info = BassInfo {
                flags: 0, hwsize: 0, hwfree: 0, freesam: 0, free3d: 0,
                minrate: 0, maxrate: 0, eax: 0, minbuf: 0, dsver: 0,
                latency: 0, initflags: 0, speakers: 0, freq: 0,
            };
            
            if get_info(lib, &mut info) != 0 {
                if info.freq as u32 != settings.sample_rate {
                    let msg = format!(
                        "Audio device forced {}Hz instead of requested {}Hz. This may indicate incompatible device settings.",
                        info.freq, settings.sample_rate
                    );
                    log_warn!("[bass] {}", msg);
                    // Don't fail here, just warn - the device might still work
                }
            }
        }
        
        // Load codec plugins
        if let Err(e) = crate::bass::load_bass_plugins(lib) {
            log_warn!("[bass] Failed to load some plugins: {}", e);
        }
        
    log_info!("[bass] BASS initialization complete");
    }
    
    Ok(())
}

/// Restore playback state after audio reinitialization
async fn restore_playback_state(snapshot: PlaybackStateSnapshot) -> Result<(), String> {
    if !snapshot.has_playback() {
    log_debug!("[bass] No meaningful playback state to restore");
        return Ok(());
    }

    log_info!("[bass] Restoring playback state: url={:?}, was_playing={}, position={:.2}s", snapshot.url, snapshot.was_playing, snapshot.position);

    if let Some(url) = snapshot.url {
        // Restore playback using the appropriate method
        if let (Some(track_id), Some(source_type), Some(source_hash)) = 
           (snapshot.track_id, snapshot.source_type, snapshot.source_hash) {
            // Use playback_start_with_source if we have source information
            let spec = PlaybackSourceSpec {
                track_id,
                source_type,
                source_value: url.clone(),
                prefer_cache: Some(true),
                source_meta: None,
                client_request_id: Some("audio_settings_restore".to_string()),
            };
            
            // We need the app handle for playback_start_with_source_internal
            // For now, fall back to simple playback_start since we don't have app handle access here
            if let Err(e) = playback_start_internal(url).await {
                log_error!("[bass] Failed to restore playback: {}", e);
                return Err(format!("Failed to restore playback: {}", e));
            }
        } else {
            // Use simple playback start
            if let Err(e) = playback_start_internal(url).await {
                log_error!("[bass] Failed to restore playback: {}", e);
                return Err(format!("Failed to restore playback: {}", e));
            }
        }

        // Seek to the previous position if needed
        if snapshot.position > 0.0 {
            if let Err(e) = playback_seek_internal(snapshot.position).await {
                log_warn!("[bass] Failed to seek to position {:.2}s: {}", snapshot.position, e);
                // Don't treat seek failure as fatal - playback is restored
            }
        }

        // If it was paused, pause it again
        if !snapshot.was_playing {
            if let Err(e) = playback_pause_internal().await {
                log_warn!("[bass] Failed to restore paused state: {}", e);
                // Don't treat pause failure as fatal
            }
        }

    log_info!("[bass] Successfully restored playback state");
    }

    Ok(())
}

// Use shared helper from bass.rs for format probing
type AudioFormatInfo = BassAudioFormatInfo;
fn get_audio_format_info(lib: &Library, handle: u32) -> AudioFormatInfo {
    probe_audio_format_from_channel(lib, handle)
}

fn detect_codec_from_channel_info(lib: &Library, handle: u32) -> Option<String> {
    let mut info = BassChannelInfo {
        freq: 0,
        chans: 0,
        flags: 0,
        ctype: 0,
        origres: 0,
        plugin: 0,
        sample: 0,
        filename: std::ptr::null(),
    };

    if channel_get_info(lib, handle, &mut info) == 0 {
        return None;
    }

    // Check for DXD first (very high sample rates typical of DXD)
    if info.freq >= 352000
        && (info.ctype == BASS_CTYPE_STREAM_DSD || info.ctype == BASS_CTYPE_STREAM_DSD_RAW)
    {
        return Some("dxd".to_string());
    }

    // Map BASS channel types to format strings
    match info.ctype {
        BASS_CTYPE_STREAM_MP3 => Some("mp3".to_string()),
        BASS_CTYPE_STREAM_OGG => Some("ogg".to_string()),
        BASS_CTYPE_STREAM_WAV | BASS_CTYPE_STREAM_WAV_PCM | BASS_CTYPE_STREAM_WAV_FLOAT => {
            Some("wav".to_string())
        }
        BASS_CTYPE_STREAM_AIFF => Some("aiff".to_string()),
        BASS_CTYPE_STREAM_DSD | BASS_CTYPE_STREAM_DSD_RAW => Some("dsd".to_string()),
        BASS_CTYPE_STREAM_FLAC | BASS_CTYPE_STREAM_FLAC_OGG => Some("flac".to_string()),
        BASS_CTYPE_STREAM_AAC => Some("aac".to_string()),
        BASS_CTYPE_STREAM_MP4 => Some("mp4".to_string()),
        BASS_CTYPE_STREAM_ALAC => Some("alac".to_string()),
        BASS_CTYPE_STREAM_OPUS => Some("opus".to_string()),
        BASS_CTYPE_STREAM_WEBM => Some("webm".to_string()),
        BASS_CTYPE_STREAM_APE => Some("ape".to_string()),
        BASS_CTYPE_STREAM_CA => {
            // CoreAudio - could be various formats, try to get more info from tags
            if let Some(codec) = get_codec_from_tags(lib, handle) {
                Some(codec)
            } else {
                Some("aac".to_string()) // Default assumption
            }
        }
        BASS_CTYPE_STREAM_MF => {
            // Media Foundation - could be various formats
            if let Some(codec) = get_codec_from_tags(lib, handle) {
                Some(codec)
            } else {
                Some("m4a".to_string()) // Default assumption
            }
        }
        _ => {
            // For unknown ctypes, print the value for debugging and try tags
            log_debug!("[bass] Unknown ctype for codec detection: 0x{:x}", info.ctype);
            get_codec_from_tags(lib, handle)
        }
    }
}

// Helper function to extract codec info from metadata tags
fn get_codec_from_tags(lib: &Library, handle: u32) -> Option<String> {
    // Try different tag types to find codec information
    let tag_types = [
        BASS_TAG_ID3V2,
        BASS_TAG_MP4,
        BASS_TAG_OGG,
        BASS_TAG_APE,
        BASS_TAG_WMA,
    ];

    for &tag_type in &tag_types {
        let tags_ptr = channel_get_tags(lib, handle, tag_type);
        if !tags_ptr.is_null() {
            // Parse tags to find codec info - this is a simplified approach
            // In a real implementation, you'd parse the specific tag format
            unsafe {
                let tags_str = CStr::from_ptr(tags_ptr).to_string_lossy();
                let tags = tags_str.to_lowercase();

                // Look for common codec indicators in tags
                if tags.contains("mp3") || tags.contains("mpeg-1") || tags.contains("mpeg-2") {
                    return Some("mp3".to_string());
                } else if tags.contains("aac") {
                    return Some("aac".to_string());
                } else if tags.contains("flac") {
                    return Some("flac".to_string());
                } else if tags.contains("vorbis") {
                    return Some("ogg".to_string());
                } else if tags.contains("opus") {
                    return Some("opus".to_string());
                }
            }
        }
    }

    None
}

// Structure to manage download file state for BASS download callback
#[derive(Clone)]
pub struct DownloadFileState {
    pub track_id: String,
    pub source_type: String,
    pub source_hash: String,
    pub file_index: Option<usize>,
    pub cache_file: Arc<Mutex<File>>,
    pub cache_path: PathBuf,
    // When resuming without server Range support, skip this many bytes from the start
    pub skip_remaining: u64,
    // Observed bytes downloaded for this stream (captured on stop)
    pub downloaded_bytes: u64,
    // Observed total bytes if known (captured on stop)
    pub total_bytes: Option<u64>,
    // Whether the download has completed
    pub download_complete: bool,
}

// filename helper was moved to crate::cache::create_cache_filename

// BASS download callback function
unsafe extern "C" fn download_proc(buffer: *const c_void, length: c_uint, user: *mut c_void) {
    if user.is_null() {
        return;
    }

    // Cast user data back to our download state
    let state = &mut *(user as *mut DownloadFileState);

    // Check for download completion (BASS calls with buffer=NULL, length=0 when done)
    if buffer.is_null() && length == 0 {
    log_info!("[bass] Download completed for track: {}", state.track_id);

        // Mark download as complete
        state.download_complete = true;

        // Flush the file
        if let Ok(mut file) = state.cache_file.lock() {
            let _ = file.flush();
        }

        // If the track has already ended, finalize the cache now
        // We need to check if the playback has ended
        // For now, we'll finalize when playback_status detects the end
        return;
    }

    if buffer.is_null() || length == 0 {
        return; // Nothing to write or invalid
    }

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
    state.downloaded_bytes = state
        .downloaded_bytes
        .saturating_add(write_slice.len() as u64);
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
    // Cache-related fields
    current_track_id: Option<String>,
    current_source_type: Option<String>,
    current_source_hash: Option<String>,
    // Download file state for BASS callback
    download_file_state: Option<Box<DownloadFileState>>,
    // Codec/format information
    codec: Option<String>,
    sample_rate: Option<u32>,
    bits_per_sample: Option<u32>,
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
            // Cache-related fields
            current_track_id: None,
            current_source_type: None,
            current_source_hash: None,
            download_file_state: None,
            // Codec/format information
            codec: None,
            sample_rate: None,
            bits_per_sample: None,
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
    cache_info: Option<(&str, &str, &str)>, // track_id, source_type, source_hash
    file_index: Option<usize>,
) -> Result<(u32, Option<Box<DownloadFileState>>), String> {
    let handle = if url.starts_with("file://") {
        // For local files, use BASS_StreamCreateFile (no caching needed)
        let file_path = url.strip_prefix("file://").unwrap_or(url);
        let c_file_path =
            CString::new(file_path).map_err(|_| "Invalid file path: contains null bytes")?;
    log_debug!("[bass] Creating stream from local file: {}", file_path);

        stream_create(
            lib,
            StreamSource::File(&c_file_path),
            BASS_STREAM_AUTOFREE,
            None,
            std::ptr::null_mut(),
        )
    } else {
        // For remote URLs, use BASS_StreamCreateURL
        let c_url = CString::new(url).map_err(|_| "Invalid URL: contains null bytes")?;

        if enable_caching && cache_info.is_some() {
            // Create stream with download callback for caching
            let (track_id, source_type, source_hash) = cache_info.unwrap();

            // Get cache directory
            let cache_dir = get_cache_dir().ok_or("Cache not initialized")?;

            // Create cache file name and path using .part for in-progress
            let base =
                create_cache_filename_with_index(track_id, source_type, source_hash, file_index);
            let cache_path = cache_dir.join(format!("{}.part", base));

            // Create or open the cache file. If it exists, open for append to resume;
            // otherwise create a new file.
            let (cache_file, existing_len) = if cache_path.exists() {
                let meta = std::fs::metadata(&cache_path)
                    .map_err(|e| format!("Failed to stat cache file: {}", e))?;
                let len = meta.len();
                let f = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&cache_path)
                    .map_err(|e| format!("Failed to open cache file for append: {}", e))?;
                log_debug!(
                    "[bass] Resuming cache file: {} (existing {} bytes)",
                    cache_path.display(),
                    len
                );
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

            log_debug!("[bass] Creating cache file: {}", cache_path.display());

            // Create download state
            let mut download_state = Box::new(DownloadFileState {
                track_id: track_id.to_string(),
                source_type: source_type.to_string(),
                source_hash: source_hash.to_string(),
                file_index,
                cache_file: Arc::new(Mutex::new(cache_file)),
                cache_path: cache_path,
                skip_remaining: 0,
                downloaded_bytes: existing_len as u64,
                total_bytes: None,
                download_complete: false,
            });

            let stream_flags = BASS_STREAM_STATUS | BASS_STREAM_BLOCK;

            // Robust resume: always start from 0 and skip existing bytes in the callback.
            // This avoids duplicate data when servers ignore Range requests.
            if existing_len > 0 {
                download_state.skip_remaining = existing_len as u64;
            }
            let handle = stream_create(
                lib,
                StreamSource::Url {
                    url: &c_url,
                    offset: None,
                },
                stream_flags,
                Some(download_proc),
                download_state.as_ref() as *const DownloadFileState as *mut std::ffi::c_void,
            );

            if handle == 0 {
                let error = bass_err(lib);
                log_error!("[bass] Stream creation with callback failed: {}", error);
                return Err(format!("Stream creation failed: {}", error));
            }

            log_debug!("[bass] Stream created with download callback, handle: {}", handle);
            return Ok((handle, Some(download_state)));
        } else {
            // Create stream without download callback (streaming only)
            stream_create(
                lib,
                StreamSource::Url {
                    url: &c_url,
                    offset: None,
                },
                BASS_STREAM_STATUS | BASS_STREAM_BLOCK,
                None,
                std::ptr::null_mut(),
            )
        }
    };

    if handle == 0 {
        let error = bass_err(lib);
        log_error!("[bass] Stream creation failed: {}", error);
        return Err(format!("Stream creation failed: {}", error));
    }
    log_debug!("[bass] Stream created successfully, handle: {}", handle);
    Ok((handle, None))
}

// Function to finalize the cache file (.part -> extension-less) and add it to the cache index
async fn finalize_cache_file(
    track_id: String,
    source_type: String,
    source_hash: String,
    file_index: Option<usize>,
    cache_path: PathBuf,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    download_complete: bool,
) {
    // Check if file exists and has content
    if let Ok(metadata) = std::fs::metadata(&cache_path) {
        let file_size = metadata.len();

        if file_size > 1024 {
            // Only cache files larger than 1KB
            // If total size is known and file is incomplete, do not finalize yet
            if let Some(total) = total_bytes {
                if file_size < total {
                    log_debug!("[bass] Download incomplete ({} of {} bytes), keeping .part: {}", file_size, total, cache_path.display());
                    return;
                }
            } else {
                // Unknown total size; check if BASS indicated download completion
                if download_complete {
                    log_info!("[bass] Download marked complete by BASS despite unknown total size, finalizing: {}", cache_path.display());
                } else {
                    // Unknown total size and not marked complete - defer finalization
                    log_debug!("[bass] Total size unknown and download not complete, deferring finalization for: {}", cache_path.display());
                    return;
                }
            }
            // Create a proper cache filename (extension-less final name)
            let cache_filename =
                create_cache_filename_with_index(&track_id, &source_type, &source_hash, file_index);

            // Get cache directory and final path
            if let Some(cache_dir) = get_cache_dir() {
                let final_cache_path = cache_dir.join(&cache_filename);

                // Move the temporary .part file to the final (extension-less) location
                if let Err(e) = std::fs::rename(&cache_path, &final_cache_path) {
                    log_warn!("[bass] Failed to move cache file to final location: {}", e);
                    // If rename fails, try copy and delete
                    if let Err(e2) = std::fs::copy(&cache_path, &final_cache_path) {
                        log_warn!("[bass] Failed to copy cache file: {}", e2);
                        return;
                    }
                    let _ = std::fs::remove_file(&cache_path);
                }

                // Add to cache index
                // Try to persist known audio format into cache index for UI reuse
                let (codec, sample_rate, bits_per_sample) = {
                    let st = STATE.lock().unwrap();
                    (st.codec.clone(), st.sample_rate, st.bits_per_sample)
                };
                if let Err(e) = add_cached_file_to_index_with_format(
                    track_id.clone(),
                    source_type.clone(),
                    source_hash.clone(),
                    cache_filename,
                    file_size,
                    file_index,
                    codec,
                    sample_rate,
                    bits_per_sample,
                ) {
                    log_warn!("[bass] Failed to add file to cache index: {}", e);
                } else {
                    log_info!("[bass] Successfully cached audio file: {} ({}:{}) size: {} bytes", track_id, source_type, source_hash, file_size);
                }
            } else {
                log_error!("[bass] Could not get cache directory");
            }
        } else {
            log_debug!("[bass] Cache file too small ({} bytes), not caching: {}", file_size, cache_path.display());
            let _ = std::fs::remove_file(&cache_path);
        }
    } else {
        log_debug!("[bass] Cache file does not exist or cannot be accessed: {}", cache_path.display());
    }
}

// SAFETY: We mark PlaybackState as Send because we guard all access behind a Mutex and only manipulate
// BASS objects on the threads invoking the tauri commands. This is a simplification; for production
// consider a single dedicated audio thread and message passing instead of unsafe impls.
unsafe impl Send for PlaybackState {}

pub async fn playback_start_internal(url: String) -> Result<serde_json::Value, String> {
    log_debug!("[bass] playback_start called");

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

    // Use centralized initialization
    ensure_bass_initialized(&mut st, false)?;
    
    // Get lib reference before releasing the lock
    let lib_ptr = st.bass_lib.as_ref().unwrap() as *const Library;
    drop(st); // Release lock before using lib
    let lib = unsafe { &*lib_ptr };

    // Stop and free any existing stream
    {
        let mut st = STATE.lock().unwrap();
        if let Some(h) = st.stream.take() {
            channel_stop(lib, h);
            stream_free(lib, h);
        }
    }

    // Create new stream using unified function (no caching for simple playback_start)
    log_info!("[bass] Creating stream for: {}", actual_url);
    let (handle, _download_state) = match create_bass_stream(lib, &actual_url, false, None, None) {
        Ok(v) => v,
        Err(e) => return Err(e),
    };

    // Detect codec/format and audio properties from the stream
    let format_info = get_audio_format_info(lib, handle);
    
    // Update state with format info
    {
        let mut st = STATE.lock().unwrap();
        st.codec = format_info.codec.clone();
        st.sample_rate = format_info.sample_rate;
        st.bits_per_sample = format_info.bits_per_sample;
    }

    if let Some(ref codec) = format_info.codec {
    log_info!("[bass] Detected codec: {}", codec);
    }
    if let Some(sample_rate) = format_info.sample_rate {
    log_debug!("[bass] Sample rate: {} Hz", sample_rate);
    }
    if let Some(bits) = format_info.bits_per_sample {
    log_debug!("[bass] Bits per sample: {}", bits);
    }

    // Apply current volume to the new stream
    let settings = get_audio_settings();
    let current_volume = if settings.muted { 0.0 } else { settings.volume };
    let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, current_volume);
    if result == 0 {
    log_warn!("[bass] Failed to set initial volume to {:.2}", current_volume);
    } else {
    log_info!("[bass] Initial volume set to {:.2}", current_volume);
    }

    // Apply seek offset if needed
    {
        let mut st = STATE.lock().unwrap();
        if st.seek_offset > 0.0 {
            let bytes = channel_seconds2bytes(lib, handle, st.seek_offset);
            if channel_set_position(lib, handle, bytes, BASS_POS_BYTE) == 0 {
                st.last_error = Some(bass_err(lib));
            }
        }
    }

    // Start playback
    log_info!("[bass] Starting playback...");
    if channel_play(lib, handle, 0) == 0 {
        let error = bass_err(lib);
    log_error!("[bass] Playback start failed: {}", error);
        {
            let mut st = STATE.lock().unwrap();
            st.last_error = Some(error.clone());
        }
        stream_free(lib, handle);
        return Err(error);
    }

    // Update state
    {
        let mut st = STATE.lock().unwrap();
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
    }

    // Emit status update
    emit_playback_status();

    // Start position update timer
    start_position_update_timer();

    // Re-acquire the lock to access duration
    let st = STATE.lock().unwrap();
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
            status
                .get("data")
                .and_then(|d| d.get("position"))
                .and_then(|p| p.as_f64())
                .unwrap_or(0.0)
        } else {
            0.0
        }
    };

    // Snapshot library pointer, old handle, and volume/mute state
    let (lib_ptr_opt, old_handle_opt, target_volume, is_muted) = {
        let state_guard = STATE.lock().unwrap();
        let settings = get_audio_settings();
        let lib_ptr = state_guard.bass_lib.as_ref().map(|l| l as *const Library);
        (
            lib_ptr,
            state_guard.stream,
            settings.volume,
            settings.muted,
        )
    };

    // Fallback if we can't handoff
    let (lib_ptr, old_handle) = match (lib_ptr_opt, old_handle_opt) {
        (Some(lp), Some(h)) => (lp, h),
        _ => {
            if let Ok(_) = playback_start_internal(cached_url).await {
                if current_position > 0.0 {
                    let _ = playback_seek(current_position).await;
                }
            }
            return;
        }
    };

    // Create new stream from cached file via wrapper
    let c_path = match CString::new(cached_path.clone()) {
        Ok(c) => c,
        Err(e) => {
            log_warn!("[bass] Invalid cached path CString: {}", e);
            if let Ok(_) = playback_start_internal(cached_url.clone()).await {
                let _ = playback_seek_internal(current_position).await;
            }
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
    log_warn!("[bass] Failed to create new stream for cached file, falling back");
        if let Ok(_) = playback_start_internal(cached_url.clone()).await {
            let _ = playback_seek_internal(current_position).await;
        }
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

    // Emit status update
    emit_playback_status();

    // Start position update timer
    start_position_update_timer();

    log_info!(
        "[bass] Gapless handoff complete; playing cached file: {}",
        cached_url
    );
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

pub async fn playback_start_with_source_internal(
    app: tauri::AppHandle,
    spec: PlaybackSourceSpec,
) -> Result<serde_json::Value, String> {
    log_debug!(
        "[bass] playback_start_with_source track={} type={} prefer_cache={:?}",
        spec.track_id, spec.source_type, spec.prefer_cache
    );

    // Extract source hash for caching BEFORE doing any URL resolution
    let source_hash = match spec.source_type.as_str() {
        "youtube" => {
            // For YouTube, use the video ID as hash
            if spec.source_value.len() == 11
                && spec
                    .source_value
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
            {
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
        }
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
        }
        _ => {
            // For other types, use the value directly as hash
            spec.source_value.clone()
        }
    };

    log_debug!(
        "[bass] Generated source hash: {} type={}",
        source_hash, spec.source_type
    );

    // OPTIMIZATION: Check cache FIRST before doing any URL resolution
    // Dedupe rapid repeated calls: check both active playback and recent processing
    {
        let key = format!("{}:{}:{}", spec.track_id, spec.source_type, source_hash);
        let mut recent = RECENT_STARTS.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_millis();

        // Check if we're already actively playing this exact track
        let currently_playing_same_track = {
            let state = STATE.lock().unwrap();
            state.playing
                && state.current_track_id.as_ref() == Some(&spec.track_id)
                && state.current_source_type.as_ref() == Some(&spec.source_type)
                && state.current_source_hash.as_ref() == Some(&source_hash)
        };

        // For cached files, be less aggressive with deduplication (only 500ms window)
        // For non-cached files, use 1000ms window to prevent file conflicts
        let has_cached_file = get_cached_file_path_with_index(
            &spec.track_id,
            &spec.source_type,
            &source_hash,
            if let Some(meta) = &spec.source_meta {
                meta.get("fileIndex")
                    .and_then(|v| v.as_u64().map(|v| v as usize))
            } else {
                None
            },
        )
        .is_some();

        let dedup_window = if has_cached_file { 500 } else { 1000 };

        // Check if we've processed this exact track very recently
        let recently_processed = if let Some(&ts) = recent.get(&key) {
            now.saturating_sub(ts) < dedup_window
        } else {
            false
        };

        if currently_playing_same_track || recently_processed {
            let reason = if currently_playing_same_track {
                "already playing"
            } else {
                "recently processed"
            };
            let time_diff = recent
                .get(&key)
                .map(|ts| now.saturating_sub(*ts))
                .unwrap_or(0);
            let file_status = if has_cached_file {
                "cached"
            } else {
                "not cached"
            };
            log_debug!("[bass] Duplicate playback_start_with_source for {} ({}, {}), returning quick ack (last: {}ms ago)", key, reason, file_status, time_diff);
            let _ = app.emit(
                "playback:start:ack",
                serde_json::json!({
                    "trackId": spec.track_id,
                    "sourceType": spec.source_type,
                    "sourceHash": source_hash,
                    "async": true,
                    "dedup": true,
                    "clientRequestId": spec.client_request_id
                }),
            );
            return Ok(serde_json::json!({ "success": true, "async": true, "dedup": true }));
        }
        recent.insert(key, now);

        // Emit an immediate ack with optional client_request_id so frontend can correlate
        let _ = app.emit(
            "playback:start:ack",
            serde_json::json!({
                "trackId": spec.track_id,
                "sourceType": spec.source_type,
                "sourceHash": source_hash,
                "async": true,
                "early_ack": true,
                "clientRequestId": spec.client_request_id
            }),
        );
    }

    // Extract file index from source metadata for torrents (needed for cache lookup)
    log_debug!("[bass] playback_start_with_source called with source_meta: {:?}", spec.source_meta);
    let file_index = if let Some(meta) = &spec.source_meta {
    log_debug!("[bass] Extracting file_index from source_meta: {:?}", meta);
        if let Some(file_idx) = meta.get("fileIndex") {
            let idx = file_idx.as_u64().map(|v| v as usize);
            log_debug!("[bass] Extracted file_index: {:?}", idx);
            idx
        } else {
            log_debug!("[bass] No fileIndex found in source_meta");
            None
        }
    } else {
    log_debug!("[bass] No source_meta found");
        None
    };
    log_debug!("[bass] Final file_index being used: {:?}", file_index);

    if spec.prefer_cache.unwrap_or(true) {
    log_debug!("[bass] Checking cache before URL resolution...");

        // Check for cached files directly (with file index support for torrents)
        if let Some(cached_path) = get_cached_file_path_with_index(
            &spec.track_id,
            &spec.source_type,
            &source_hash,
            file_index,
        ) {
            log_info!(
                "[bass] Cache hit! Playing from cached file directly: {}",
                cached_path.display()
            );
            return playback_start_internal(format!("file://{}", cached_path.display())).await;
        }

    log_debug!("[bass] Cache miss, proceeding with URL resolution...");
    }

    // Only resolve URL if we don't have a cached file
    log_debug!(
        "[bass] Resolving source URL with format information... file_index={:?}",
        file_index
    );
    let resolved_source =
        resolve_audio_source_with_format(&spec.source_type, &spec.source_value, file_index).await?;
    log_info!(
        "[bass] Resolved source URL: {} format: {:?}",
        resolved_source.url, resolved_source.format
    );

    // If this is a torrent source, enforce verified-bytes gating before starting stream
    if spec.source_type == "torrent" {
        // We require at least a minimal buffer OR full file before playback.
        // Threshold: 256 KiB or total, whichever is smaller.
        let min_buffer: u64 = 256 * 1024;
        let mut attempts = 0u32;
        let max_wait_ms = 15_000; // hard cap 15s to avoid infinite wait
        let poll_interval_ms = 500;
        let mut waited_ms = 0u64;
    log_info!("[bass] Applying torrent verified-bytes gating (min buffer {} bytes)", min_buffer);
        if let Some(fi) = file_index {
            // Attempt to poll backend torrent progress command via tauri invoke-like internal helper is not present here.
            // We will directly call into engine through crate::torrents if available.
            {
                use crate::torrents::{get_engine, TorrentEngine};
                let engine = get_engine();
                loop {
                    match engine.progress(&spec.source_value, fi as u32) {
                        Ok(p) => {
                            let verified = p.verified_bytes;
                            let needed = std::cmp::min(min_buffer, p.total);
                            log_debug!("[bass] Torrent gating progress: verified={} total={} need={} downSpeed={}B/s", verified, p.total, needed, p.down_speed);
                            if verified >= needed || verified == p.total { break; }
                        }
                        Err(e) => {
                            log_warn!("[bass] Torrent gating progress error: {}", e);
                            // On error, break early rather than block playback forever
                            break;
                        }
                    }
                    if waited_ms >= max_wait_ms as u64 { log_warn!("[bass] Gating timeout reached, continuing anyway"); break; }
                    attempts += 1;
                    waited_ms += poll_interval_ms as u64;
                    tokio::time::sleep(std::time::Duration::from_millis(poll_interval_ms)).await;
                }
            }
        } else {
            log_warn!("[bass] No file_index provided for torrent source; cannot gate by verified bytes");
        }
    }

    // Use the new BASS download callback approach for both streaming and caching
    if spec.prefer_cache.unwrap_or(true) {
    log_info!("[bass] Starting playback with BASS download callback for caching");

        // Use centralized initialization
        {
            let mut state = STATE.lock().unwrap();
            ensure_bass_initialized(&mut state, false)?;
        }
        
        let lib_ref = {
            let state = STATE.lock().unwrap();
            state.bass_lib.as_ref().unwrap() as *const Library
        };
        let lib = unsafe { &*lib_ref };

        // Determine if caching should be enabled for this source
        // For local files (file://), we do not enable caching/download callback.
        let allow_caching = !resolved_source.url.starts_with("file://");

        // Create stream with optional download callback for caching

        let (handle, mut download_state_opt) = {
            // Capture override flag with a short-lived lock
            let strict_override = get_audio_settings().has_user_override;
            let cache_info = if allow_caching {
                Some((
                    spec.track_id.as_str(),
                    spec.source_type.as_str(),
                    source_hash.as_str(),
                ))
            } else {
                None
            };
            log_debug!(
                "[bass] Calling create_bass_stream file_index={:?} caching={} url={}",
                file_index,
                allow_caching,
                resolved_source.url
            );
            match create_bass_stream(lib, &resolved_source.url, allow_caching, cache_info, file_index) {
                Ok(v) => v,
                Err(e) => {
                    // If stream creation fails and we were caching, cancel the associated download
                    if allow_caching && cache_info.is_some() {
                        let (track_id, source_type, source_hash) = cache_info.unwrap();
                        let cache_key = crate::cache::create_cache_filename_with_index(
                            track_id,
                            source_type,
                            source_hash,
                            file_index,
                        );
                        log_error!("[bass] Stream creation failed, cancelling cache download: {}", cache_key);
                        crate::downloads::request_cancel(&cache_key);
                        
                        // Also clean up inflight tracking
                        {
                            let mut inflight = crate::cache::INFLIGHT_DOWNLOADS.lock().unwrap();
                            inflight.remove(&cache_key);
                            let mut meta = crate::cache::INFLIGHT_META.lock().unwrap();
                            meta.remove(&cache_key);
                        }
                        
                        // Emit cache error to notify frontend
                        let _ = app.emit(
                            "cache:download:error",
                            serde_json::json!({
                                "trackId": track_id,
                                "sourceType": source_type,
                                "sourceHash": source_hash,
                                "message": format!("Stream creation failed: {}", e)
                            }),
                        );
                    }
                    
                    // If the error points to WASAPI not available, attempt a controlled reinit and a single retry
                    let is_wasapi = e.contains("WASAPI");
                    if is_wasapi {
                        if strict_override {
                            log_error!("[bass] WASAPI failure with user override during cached start; no fallback.");
                            return Err(e);
                        } else {
                            log_error!("[bass] WASAPI failure without override; skipping fallback for determinism.");
                            return Err(e);
                        }
                    } else { return Err(e); }
                }
            }
        };
        // If we know the total file size from resolution, store it in the download state now
        if let (true, Some(total)) = (
            download_state_opt.is_some(),
            resolved_source.format.as_ref().and_then(|f| f.filesize),
        ) {
            if let Some(ref mut ds) = download_state_opt {
                ds.total_bytes = Some(total);
            }
        }

        // Wait a brief moment for additional buffering after stream creation
        // This gives us more control over buffering without the blocking behavior during creation
        let add_wait = get_audio_settings().additional_buffer_wait_ms;
        tokio::time::sleep(std::time::Duration::from_millis(add_wait)).await;
    log_debug!("[bass] Additional buffering wait completed");

        // Apply volume and start playback
        {
            let mut state = STATE.lock().unwrap();
            let settings = get_audio_settings();

            // Apply current volume to the new stream
            let current_volume = if settings.muted { 0.0 } else { settings.volume };
            let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, current_volume);
            if result == 0 {
                log_warn!("[bass] Failed to set initial volume to {:.2}", current_volume);
            } else {
                log_info!("[bass] Initial volume set to {:.2}", current_volume);
            }

            // Start playback

            log_info!("[bass] Starting playback with download callback...");
            if channel_play(lib, handle, 0) == 0 {
                let error = bass_err(lib);
                log_error!("[bass] Playback start failed: {}", error);

                // Clean up on failure
                stream_free(lib, handle);
                return Err(error);
            }

            // Stop and free any existing stream
            if let Some(old_handle) = state.stream.take() {
                channel_stop(lib, old_handle);
                stream_free(lib, old_handle);
            }

            // Detect codec/format and audio properties from the stream (so UI can show them)
            let format_info = get_audio_format_info(lib, handle);
            state.codec = format_info.codec.clone().or_else(|| {
                // Fallback: use resolved format (e.g., YouTube server-provided)
                resolved_source
                    .format
                    .as_ref()
                    .and_then(|f| f.acodec.clone())
                    .or_else(|| resolved_source.format.as_ref().and_then(|f| f.ext.clone()))
            });
            state.sample_rate = format_info.sample_rate;
            state.bits_per_sample = format_info.bits_per_sample;

            if let Some(ref codec) = state.codec {
                log_info!("[bass] Detected codec: {}", codec);
            }
            if let Some(sample_rate) = state.sample_rate {
                log_debug!("[bass] Sample rate: {} Hz", sample_rate);
            }
            if let Some(bits) = state.bits_per_sample {
                log_debug!("[bass] Bits per sample: {}", bits);
            }

            log_debug!("[bass] Audio properties detected, continuing to state setup...");

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
            // Only set download state if caching/downloading is active
            state.download_file_state = download_state_opt;
        }

        // Emit status update
        emit_playback_status();

        // Start position update timer
        start_position_update_timer();

        log_info!(
            "[bass] Emitting playback:start:complete event for track: {}",
            spec.track_id
        );

        // Emit completion event to notify frontend that playback has started successfully
        let _ = app.emit(
            "playback:start:complete",
            serde_json::json!({
                "trackId": spec.track_id,
                "sourceType": spec.source_type,
                "sourceHash": source_hash,
                "caching": true,
                "clientRequestId": spec.client_request_id
            }),
        );

    log_info!("[bass] Successfully emitted completion event and returning success");

        return Ok(serde_json::json!({"success": true, "data": {"caching": true}}));
    } else {
        // Not preferring cache: start streaming immediately without callback
    log_info!("[bass] Starting streaming playback without caching");
        return playback_start_internal(resolved_source.url.clone()).await;
    }
}

pub async fn playback_pause_internal() -> Result<serde_json::Value, String> {
    log_debug!("[bass] playback_pause called");
    let mut st = STATE.lock().unwrap();
    if let Some(h) = st.stream {
        if let Some(lib) = st.bass_lib.as_ref() {
            log_debug!("[bass] Pausing stream with handle: {}", h);

            // Check download progress before pausing
            {
                let downloaded = stream_get_file_position(lib, h, BASS_FILEPOS_DOWNLOAD);
                let connected = stream_get_file_position(lib, h, BASS_FILEPOS_CONNECTED);
                log_debug!(
                    "[bass] Before pause - downloaded: {} bytes, connected: {}",
                    downloaded,
                    connected != 0
                );
            }

            if channel_pause(lib, h) == 0 {
                let error = bass_err(lib);
                log_error!("[bass] Pause failed: {}", error);
                st.last_error = Some(error.clone());
                return Err(error);
            }
            log_info!("[bass] Stream paused successfully - download should continue in background");

            // Check download progress after pausing
            {
                let downloaded = stream_get_file_position(lib, h, BASS_FILEPOS_DOWNLOAD);
                let connected = stream_get_file_position(lib, h, BASS_FILEPOS_CONNECTED);
                log_debug!(
                    "[bass] After pause - downloaded: {} bytes, connected: {}",
                    downloaded,
                    connected != 0
                );
            }
        }
    }
    if st.playing {
        st.playing = false;
        st.paused_at = Some(Instant::now());
    log_debug!("[bass] Playback state set to paused; stream remains active for downloading");
    }

    // Emit status update
    drop(st); // Release the lock before emitting
    emit_playback_status();

    Ok(serde_json::json!({"success": true}))
}

pub async fn playback_resume_internal() -> Result<serde_json::Value, String> {
    log_debug!("[bass] playback_resume called");
    let mut st = STATE.lock().unwrap();
    if let Some(h) = st.stream {
        if let Some(lib) = st.bass_lib.as_ref() {
            log_debug!("[bass] Resuming stream with handle: {}", h);
            if channel_play(lib, h, 0) == 0 {
                let error = bass_err(lib);
                log_error!("[bass] Resume failed: {}", error);
                st.last_error = Some(error.clone());
                return Err(error);
            }
            log_info!("[bass] Stream resumed successfully");
        }
    }
    if !st.playing {
        if let Some(paused_at) = st.paused_at.take() {
            st.accumulated_paused += paused_at.elapsed();
        }
        st.playing = true;
    }

    // Emit status update
    drop(st); // Release the lock before emitting
    emit_playback_status();

    // Start position update timer
    start_position_update_timer();

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
            let downloaded_bytes = if downloaded == 0xFFFFFFFF {
                None
            } else {
                Some(downloaded as u64)
            };
            let total_bytes = if total == 0xFFFFFFFF {
                None
            } else {
                Some(total as u64)
            };
            if let Some(d) = downloaded_bytes {
                captured_progress = Some((d, total_bytes));
            }
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
        if let Some((d, t)) = captured_progress {
            download_state.downloaded_bytes = d;
            download_state.total_bytes = t;
        }

        log_debug!(
            "[bass] Finalizing cache file for stopped track: {}",
            cache_path.display()
        );

        let file_index = download_state.file_index;
        let download_complete = download_state.download_complete;

        // Drop the download state to ensure file is closed
        drop(download_state);

        // Spawn async task to finalize cache (don't block the stop command)
        tokio::spawn(async move {
            let (dl, total) = captured_progress.unwrap_or((0, None));
            finalize_cache_file(
                track_id,
                source_type,
                source_hash,
                file_index,
                cache_path,
                Some(dl),
                total,
                download_complete,
            )
            .await;
        });
    }

    // Emit status update
    drop(st); // Release the lock before emitting
    emit_playback_status();

    Ok(serde_json::json!({"success": true}))
}

pub async fn playback_seek_internal(position: f64) -> Result<serde_json::Value, String> {
    log_debug!("[bass] playback_seek called position={}", position);
    let mut st = STATE.lock().unwrap();
    if st.stream.is_none() || st.bass_lib.is_none() {
        log_warn!("[bass] No stream or library available for seeking");
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
        log_debug!(
            "[bass] Position clamped from {} to {} (duration: {})",
            position, clamped, d
        );
        clamped
    } else {
        let clamped = position.max(0.0);
        log_debug!(
            "[bass] No duration available, clamped position from {} to {}",
            position, clamped
        );
        clamped
    };

    // Try to get stream length and available data to check buffering status
    let _len_bytes = channel_get_length(lib, h, BASS_POS_BYTE);

    let bytes = channel_seconds2bytes(lib, h, pos);
    log_debug!(
        "[bass] Seeking to position {} seconds = {} bytes",
        pos, bytes
    );

    // Check if position is valid before seeking
    if bytes == 0xFFFFFFFF {
        let error = "Invalid seek position (bytes conversion failed)";
    log_error!("[bass] {}", error);
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
            log_debug!(
                "[bass] Already at target position ({} vs {}), skipping seek",
                current_pos, pos
            );
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
    log_error!("[bass] Seek failed: {}", error);

        // For streaming content, seeking errors are often non-fatal
        // Instead of failing, we can continue playback and just update our internal position
        if error.contains("BASS_ERROR_NOTAVAIL") {
            log_warn!(
                "[bass] Seek data not available, updating position tracker without actual seek"
            );
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

    log_info!("[bass] Seek successful position={}s", pos);

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
pub struct PlaybackStatus {
    pub url: Option<String>,
    pub playing: bool,
    pub position: f64,
    pub duration: Option<f64>,
    pub ended: bool,
    pub error: Option<String>,
}

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
                    "error": st.last_error,
                    "codec": st.codec,
                    "sampleRate": st.sample_rate,
                    "bitsPerSample": st.bits_per_sample
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
                    "error": st.last_error,
                    "codec": st.codec,
                    "sampleRate": st.sample_rate,
                    "bitsPerSample": st.bits_per_sample
                }
            }));
        }
    };

    // Check if stream is still active
    let active = channel_is_active(lib, h);
    if active == BASS_ACTIVE_STOPPED && st.playing {
        // Startup grace: avoid treating STOPPED immediately after start as an "end"
        let started_recently = st
            .started_at
            .map(|t| t.elapsed() < Duration::from_millis(1200))
            .unwrap_or(false);

        if started_recently {
            log_debug!(
                "[bass] Stream reported STOPPED within startup grace window; suppressing end"
            );
        } else {
            st.playing = false;
            st.ended = true;

            // Emit status update for stream end detection immediately
            drop(st); // Release the lock before emitting
            emit_playback_status();
            st = STATE.lock().unwrap(); // Re-acquire the lock

            // If we were caching, finalize the .part file now as a natural end
            if let Some(mut download_state) = st.download_file_state.take() {
                let track_id = download_state.track_id.clone();
                let source_type = download_state.source_type.clone();
                let source_hash = download_state.source_hash.clone();
                let cache_path = download_state.cache_path.clone();
                let file_index = download_state.file_index;
                // Capture totals accurately for finalization gating
                let known_total = download_state.total_bytes;
                let download_complete = download_state.download_complete;

                log_debug!(
                    "[bass] Finalizing cache file after BASS stopped: {}",
                    cache_path.display()
                );

                // Drop the download state to ensure file is closed
                drop(download_state);

                tokio::spawn(async move {
                    // Use current .part size as downloaded, and persist known total if available
                    let downloaded = std::fs::metadata(&cache_path).ok().map(|m| m.len());
                    finalize_cache_file(
                        track_id,
                        source_type,
                        source_hash,
                        file_index,
                        cache_path,
                        downloaded,
                        known_total,
                        download_complete,
                    )
                    .await;
                });
            }
        }
    }

    // Try to get duration if we don't have it yet
    if st.duration.is_none() {
        st.duration = probe_duration_bass(lib, h);
        if st.duration.is_some() {
            log_debug!("[bass] Got duration: {:.2}s", st.duration.unwrap());
        }
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

    // Check if track has reached the end (position >= duration - 0.1s threshold or stream stopped)
    if !st.ended && st.playing && st.duration.is_some() {
        let duration = st.duration.unwrap();
        let is_near_end = position >= duration - 0.1;
        let stream_stopped = active == BASS_ACTIVE_STOPPED;
        let started_recently = st
            .started_at
            .map(|t| t.elapsed() < Duration::from_millis(1200))
            .unwrap_or(false);
        // NOTE: Do NOT treat "file_at_end" (CURRENT == END) as finished; that just means we've caught up to the
        // downloaded bytes and are stalled. Only consider STOPPED or truly near the known duration.
        // Tighten end condition: require either credible near-end, or STOPPED after grace period
        let allow_end = (duration >= 2.0 && is_near_end) || (stream_stopped && !started_recently);
        if allow_end {
        log_info!("[bass] Track ended position {:.2}s >= duration {:.2}s (near_end: {}, stopped: {})", 
            position, duration, is_near_end, stream_stopped);
            st.playing = false;
            st.ended = true;
            // Immediately notify the frontend that playback ended so it can advance the queue
            drop(st); // Release lock before emitting
            emit_playback_status();
            st = STATE.lock().unwrap();

            // Handle download file state cleanup and cache finalization for natural track ending
            if let Some(mut download_state) = st.download_file_state.take() {
                let track_id = download_state.track_id.clone();
                let source_type = download_state.source_type.clone();
                let source_hash = download_state.source_hash.clone();
                let cache_path = download_state.cache_path.clone();
                let file_index = download_state.file_index;
                // Capture totals accurately for finalization gating
                let known_total = download_state.total_bytes;
                let download_complete = download_state.download_complete;

                log_debug!(
                    "[bass] Finalizing cache file for naturally ended track: {}",
                    cache_path.display()
                );

                // Drop the download state to ensure file is closed
                drop(download_state);

                // Spawn async task to finalize cache (don't block the status check)
                tokio::spawn(async move {
                    // Use current .part size as downloaded, and persist known total if available
                    let downloaded = std::fs::metadata(&cache_path).ok().map(|m| m.len());
                    finalize_cache_file(
                        track_id,
                        source_type,
                        source_hash,
                        file_index,
                        cache_path,
                        downloaded,
                        known_total,
                        download_complete,
                    )
                    .await;
                });
            }
        }
    }

    let result = serde_json::json!({
        "success": true,
        "data": {
            "url": st.url,
            "playing": st.playing,
            "position": position,
            "duration": st.duration,
            "ended": st.ended,
            "error": st.last_error,
            "codec": st.codec,
            "sampleRate": st.sample_rate,
            "bitsPerSample": st.bits_per_sample
        }
    });

    // Emit event for real-time updates
    if let Ok(app_handle) = crate::APP_HANDLE.lock() {
        if let Some(handle) = app_handle.as_ref() {
            let _ = handle.emit("playback:status", result.clone());
        }
    }

    Ok(result)
}

// Helper function to emit current playback status
fn emit_playback_status() {
    let st = STATE.lock().unwrap();

    // Get library reference safely
    let position = if let (Some(lib_ptr), Some(h)) = (st.bass_lib.as_ref(), st.stream) {
        let lib = { &*lib_ptr };
        // Get current position
        let pos_bytes = channel_get_position(lib, h, BASS_POS_BYTE);
        if pos_bytes == 0xFFFFFFFF {
            0.0
        } else {
            let secs = channel_bytes2seconds(lib, h, pos_bytes);
            if secs.is_finite() && secs >= 0.0 {
                secs
            } else {
                0.0
            }
        }
    } else {
        0.0
    };

    let result = serde_json::json!({
        "success": true,
        "data": {
            "url": st.url,
            "playing": st.playing,
            "position": position,
            "duration": st.duration,
            "ended": st.ended,
            "error": st.last_error,
            "codec": st.codec,
            "sampleRate": st.sample_rate,
            "bitsPerSample": st.bits_per_sample
        }
    });

    // Emit event for real-time updates
    if let Ok(app_handle) = crate::APP_HANDLE.lock() {
        if let Some(handle) = app_handle.as_ref() {
            let _ = handle.emit("playback:status", result);
        }
    }
}

// Start a background task to emit periodic position updates during playback
static POSITION_UPDATE_ACTIVE: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

fn start_position_update_timer() {
    let mut active = POSITION_UPDATE_ACTIVE.lock().unwrap();
    if *active {
        // Timer already running
        return;
    }
    *active = true;

    tokio::spawn(async {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

            // Check if we're still playing
            let should_continue = {
                let state = STATE.lock().unwrap();
                // Keep emitting while playing; once ended or stopped, break so we don't mask the terminal status
                state.playing && state.stream.is_some() && !state.ended
            };

            if should_continue {
                // Use the full status path so we also perform end-of-track detection
                let _ = playback_status_internal().await;
            } else {
                // If not playing anymore, stop the timer
                let mut active = POSITION_UPDATE_ACTIVE.lock().unwrap();
                *active = false;
                break;
            }
        }
    });
}

pub async fn get_audio_devices_internal() -> Result<serde_json::Value, String> {
    log_debug!("[bass] Getting audio devices...");

    // First try to get the BASS library
    let mut state = STATE.lock().unwrap();

    // Ensure BASS library is loaded
    if state.bass_lib.is_none() {
        match ensure_bass_loaded() {
            Ok(lib) => state.bass_lib = Some(lib),
            Err(e) => {
                log_warn!(
                    "[bass] Warning: Could not load BASS library for device enumeration: {}",
                    e
                );
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

    // Enumerate devices via BASS_GetDevice and BASS_GetInfo wrappers
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
            log_debug!(
                "[bass] Setting device {} as the single default device",
                device_index
            );
        }

        /*
        log_debug!(
            "[bass] Found device {}: {} (driver: {}, enabled: {}, default: {}, init: {})",
            device_index, device_name, driver_name, is_enabled, is_default, is_initialized
        );
        */

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
            log_warn!("[bass] Device enumeration safety limit reached");
            break;
        }
    }

    // If no devices were found, add a fallback default device
    if devices.is_empty() {
    log_warn!("[bass] No devices found, adding fallback default device");
        devices.push(serde_json::json!({
            "id": -1,
            "name": "System Default",
            "driver": "Default",
            "is_default": true,
            "is_enabled": true,
            "is_initialized": false
        }));
    }

    log_info!(
        "[bass] Device enumeration complete, found {} devices",
        devices.len()
    );

    Ok(serde_json::json!({
        "success": true,
        "devices": devices
    }))
}

pub async fn get_audio_settings_internal() -> Result<serde_json::Value, String> {
    let settings = get_audio_settings();
    let state = STATE.lock().unwrap();

    // Get actual audio settings from BASS if initialized
    let (actual_device, actual_sample_rate, actual_bit_depth, actual_output_channels) = if state.bass_initialized {
        if let Some(lib) = state.bass_lib.as_ref() {
            // Get current device
            let current_device = get_device(lib);
            log_debug!("[bass] Current BASS device: {}", current_device);

            // If BASS returns BASS_DEVICE_DEFAULT, find the actual default device
            let resolved_device = if current_device == (BASS_DEVICE_DEFAULT as u32) || current_device == u32::MAX {
                let mut device_index = 0u32;
                let mut found_device = current_device as i32;
                loop {
                    let mut device_info = BassDeviceInfo {
                        name: std::ptr::null(),
                        driver: std::ptr::null(),
                        flags: 0,
                    };
                    let result = get_device_info(lib, device_index, &mut device_info);
                    if result == 0 {
                        break;
                    }
                    if (device_info.flags & BASS_DEVICE_DEFAULT_FLAG) != 0 {
                        log_debug!("[bass] Found real default device: {} (was {})", device_index, current_device);
                        found_device = device_index as i32;
                        break;
                    }
                    device_index += 1;
                    if device_index > 32 { break; }
                }
                found_device
            } else {
                current_device as i32
            };

            let mut bass_info = BassInfo {
                flags: 0, hwsize: 0, hwfree: 0, freesam: 0, free3d: 0,
                minrate: 0, maxrate: 0, eax: 0, minbuf: 0, dsver: 0,
                latency: 0, initflags: 0, speakers: 0, freq: 0,
            };

            let result = get_info(lib, &mut bass_info);
            if result != 0 {
                log_debug!("[bass] BASS_GetInfo successful - freq: {}Hz, speakers: {}, latency: {}ms",
                         bass_info.freq, bass_info.speakers, bass_info.latency);

                // Extract bit depth from init flags
                let bit_depth = if (bass_info.initflags & 0x8) != 0 {
                    32 // BASS_DEVICE_FLOAT
                } else if (bass_info.initflags & 0x10) != 0 {
                    24 // Placeholder for 24-bit detection
                } else {
                    16 // Default to 16-bit
                };

                let output_channels = if bass_info.speakers > 0 { bass_info.speakers } else { 2 };
                (resolved_device, bass_info.freq, bit_depth, output_channels)
            } else {
                log_warn!("[bass] BASS_GetInfo failed, using defaults");
                (resolved_device, 44100, 16, 2)
            }
        } else {
            log_warn!("[bass] BASS library not loaded, using defaults");
            (-1, 44100, 16, 2)
        }
    } else {
        // BASS not initialized yet - report current settings as provisional
    log_debug!("[bass] BASS not initialized, reporting current settings");
        (settings.device_id, settings.sample_rate, settings.bit_depth, settings.output_channels)
    };

    if actual_sample_rate as u32 != settings.sample_rate {
    log_warn!("[bass] Actual sample rate ({} Hz) differs from desired ({} Hz)",
         actual_sample_rate, settings.sample_rate);
    }

    Ok(serde_json::json!({
        "success": true,
        "settings": {
            "device": actual_device,
            "sample_rate": actual_sample_rate,
            "desired_device": settings.device_id,
            "desired_sample_rate": settings.sample_rate,
            "bit_depth": actual_bit_depth,
            "buffer_size": settings.buffer_size_ms,
            "net_buffer": settings.net_buffer_ms,
            "net_timeout": settings.net_timeout_ms,
            "additional_buffer_wait": settings.additional_buffer_wait_ms,
            "volume": settings.volume,
            "exclusive_mode": settings.exclusive_mode,
            "output_channels": actual_output_channels
        }
    }))
}

pub async fn set_audio_settings_internal(
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    log_info!("[bass] Setting audio configuration: {:?}", settings);

    let mut needs_reinit = false;
    let mut needs_volume_update = false;

    // Update settings using the centralized system
    let updated_settings = update_audio_settings(|audio_settings| {
        // Check if settings that require reinitialization have changed
        if let Some(device) = settings.get("device").and_then(|v| v.as_i64()) {
            if audio_settings.device_id != device as i32 {
                needs_reinit = true;
                log_info!("[bass] Device change detected: {}", device);
                audio_settings.device_id = device as i32;
                audio_settings.has_user_override = true;
            }
        }

        if let Some(sample_rate) = settings.get("sample_rate").and_then(|v| v.as_u64()) {
            if audio_settings.sample_rate != sample_rate as u32 {
                needs_reinit = true;
                log_info!("[bass] Sample rate change detected: {}", sample_rate);
                audio_settings.sample_rate = sample_rate as u32;
                audio_settings.has_user_override = true;
            }
        }

        if let Some(buffer_size) = settings.get("buffer_size").and_then(|v| v.as_u64()) {
            if audio_settings.buffer_size_ms != buffer_size as u32 {
                needs_reinit = true; // BASS_CONFIG_BUFFER must be set before init
                log_info!("[bass] Buffer size change detected: {}", buffer_size);
                audio_settings.buffer_size_ms = buffer_size as u32;
            }
        }

        // Audio quality settings that require reinitialization
        if let Some(bit_depth) = settings.get("bit_depth").and_then(|v| v.as_u64()) {
            if audio_settings.bit_depth != bit_depth as u32 {
                needs_reinit = true;
                log_info!("[bass] Bit depth change detected: {}", bit_depth);
                audio_settings.bit_depth = bit_depth as u32;
                audio_settings.has_user_override = true;
            }
        }

        if let Some(exclusive) = settings.get("exclusive_mode").and_then(|v| v.as_bool()) {
            if audio_settings.exclusive_mode != exclusive {
                needs_reinit = true;
                log_info!("[bass] Exclusive mode change detected: {}", exclusive);
                audio_settings.exclusive_mode = exclusive;
                audio_settings.has_user_override = true;
            }
        }

        if let Some(channels) = settings.get("output_channels").and_then(|v| v.as_u64()) {
            if audio_settings.output_channels != channels as u32 {
                needs_reinit = true;
                log_info!("[bass] Output channels change detected: {}", channels);
                audio_settings.output_channels = channels as u32;
                audio_settings.has_user_override = true;
            }
        }

        // Network settings can be applied live (no reinit needed)
        if let Some(timeout) = settings.get("net_timeout").and_then(|v| v.as_u64()) {
            audio_settings.net_timeout_ms = timeout as u32;
            log_debug!("[bass] Net timeout change detected: {} ms", timeout);
        }
        
        if let Some(net_buf) = settings.get("net_buffer").and_then(|v| v.as_u64()) {
            audio_settings.net_buffer_ms = net_buf as u32;
            log_debug!("[bass] Net buffer change detected: {} ms", net_buf);
        }
        
        if let Some(wait_ms) = settings.get("additional_buffer_wait").and_then(|v| v.as_u64()) {
            audio_settings.additional_buffer_wait_ms = wait_ms as u64;
            log_debug!("[bass] Additional buffer wait change detected: {} ms", wait_ms);
        }

        // Volume settings
        if let Some(volume) = settings.get("volume").and_then(|v| v.as_f64()) {
            audio_settings.volume = volume as f32;
            needs_volume_update = true;
            log_info!("[bass] Volume change detected: {}", volume);
        }

        if let Some(muted) = settings.get("muted").and_then(|v| v.as_bool()) {
            if muted != audio_settings.muted {
                if muted {
                    audio_settings.volume_before_mute = audio_settings.volume;
                }
                audio_settings.muted = muted;
                needs_volume_update = true;
                log_info!("[bass] Mute change detected: {}", muted);
            }
        }
    })?;

    // Apply network settings immediately if BASS is initialized
    {
        let state = STATE.lock().unwrap();
        if state.bass_initialized {
            if let Some(lib) = state.bass_lib.as_ref() {
                bass_set_config(lib, BASS_CONFIG_NET_TIMEOUT, updated_settings.net_timeout_ms);
                bass_set_config(lib, BASS_CONFIG_NET_BUFFER, updated_settings.net_buffer_ms);
            }
        }
    }

    // Handle reinitialization if needed
    if needs_reinit {
        // Capture current playback state before reinitialization
        let playback_snapshot = {
            let state = STATE.lock().unwrap();
            let lib = state.bass_lib.as_ref();
            PlaybackStateSnapshot::capture(&state, lib)
        };

        // Reinitialize BASS
        {
            let mut state = STATE.lock().unwrap();
            if state.bass_initialized {
                log_info!("[bass] Reinitialization required; preserving playback state and reinitializing BASS");
                ensure_bass_initialized(&mut state, true)?;
                log_info!("[bass] Successfully reinitialized BASS with new settings");
            } else {
                log_debug!("[bass] BASS not initialized yet, settings will be applied when first initialized");
            }
        }

        // Restore playback state if there was something playing
        if playback_snapshot.has_playback() {
            // Give BASS a moment to fully initialize before restoring playback
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            
            if let Err(e) = restore_playback_state(playback_snapshot).await {
                log_warn!("[bass] Failed to restore playback state after reinitialization: {}", e);
                // Don't fail the entire operation if playback restoration fails
            }
        }
    }

    // Apply volume changes to current stream if needed
    if needs_volume_update {
        let state = STATE.lock().unwrap();
        if let (Some(handle), Some(ref lib)) = (state.stream, state.bass_lib.as_ref()) {
            let current_volume = if updated_settings.muted { 0.0 } else { updated_settings.volume };
            let _ = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, current_volume);
            log_debug!("[bass] Applied volume to current stream: {}", current_volume);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "message": if needs_reinit { "Audio settings updated and BASS reinitialized" } else { "Audio settings updated" },
        "reinitialized": needs_reinit
    }))
}

pub async fn reinitialize_audio_internal(
    device_id: i32,
    sample_rate: u32,
    buffer_size: u32,
) -> Result<serde_json::Value, String> {
    log_info!("[bass] Reinitializing audio with device: {}, sample_rate: {}, buffer_size: {}",
             device_id, sample_rate, buffer_size);

    // Update settings and force reinit
    update_audio_settings(|settings| {
        settings.device_id = device_id;
        settings.sample_rate = sample_rate;
        settings.buffer_size_ms = buffer_size;
        settings.has_user_override = true;
    })?;

    // Capture current playback state before reinitialization
    let playback_snapshot = {
        let state = STATE.lock().unwrap();
        let lib = state.bass_lib.as_ref();
        PlaybackStateSnapshot::capture(&state, lib)
    };

    // Force reinitialize BASS
    {
        let mut state = STATE.lock().unwrap();
        ensure_bass_initialized(&mut state, true)?;
    }

    // Restore playback state if there was something playing
    if playback_snapshot.has_playback() {
        // Give BASS a moment to fully initialize before restoring playback
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        
        if let Err(e) = restore_playback_state(playback_snapshot).await {
            log_warn!("[bass] Failed to restore playback state after reinitialization: {}", e);
            // Don't fail the entire operation if playback restoration fails
        }
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

// Volume control commands

pub async fn playback_set_volume_internal(volume: f32) -> Result<serde_json::Value, String> {
    // Clamp volume between 0.0 and 1.0
    let clamped_volume = volume.max(0.0).min(1.0);
    
    // Update settings
    let updated_settings = update_audio_settings(|settings| {
        settings.volume = clamped_volume;
    })?;

    // If currently muted, don't actually set the volume yet
    if updated_settings.muted {
        return Ok(serde_json::json!({
            "success": true,
            "data": {
                "volume": clamped_volume,
                "muted": updated_settings.muted
            }
        }));
    }

    // Apply volume to current stream if playing
    let state = STATE.lock().unwrap();
    if let (Some(handle), Some(ref lib)) = (state.stream, state.bass_lib.as_ref()) {
        let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, clamped_volume);
        if result == 0 {
            log_warn!("[bass] Failed to set channel volume");
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "volume": clamped_volume,
            "muted": updated_settings.muted
        }
    }))
}

pub async fn playback_get_volume_internal() -> Result<serde_json::Value, String> {
    let settings = get_audio_settings();

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "volume": settings.volume,
            "muted": settings.muted
        }
    }))
}

pub async fn playback_set_mute_internal(muted: bool) -> Result<serde_json::Value, String> {
    log_info!("[bass] Setting mute to {}", muted);

    let updated_settings = update_audio_settings(|settings| {
        if muted && !settings.muted {
            // Muting: save current volume
            settings.volume_before_mute = settings.volume;
            settings.muted = true;
        } else if !muted && settings.muted {
            // Unmuting: restore previous volume
            settings.muted = false;
            settings.volume = settings.volume_before_mute;
        }
    })?;

    // Apply volume change to current stream if any
    let state = STATE.lock().unwrap();
    if let (Some(handle), Some(ref lib)) = (state.stream, state.bass_lib.as_ref()) {
        let target_volume = if updated_settings.muted { 0.0 } else { updated_settings.volume };
        let result = channel_set_attribute(lib, handle, BASS_ATTRIB_VOL, target_volume);
        if result == 0 {
            log_warn!("[bass] Failed to set channel volume");
        } else {
            log_debug!("[bass] Channel volume set successfully to {}", target_volume);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "volume": updated_settings.volume,
            "muted": updated_settings.muted
        }
    }))
}

pub async fn playback_toggle_mute_internal() -> Result<serde_json::Value, String> {
    let current_muted = get_audio_settings().muted;
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

        let result = serde_json::json!({
            "success": true,
            "data": {
                "downloaded_bytes": downloaded_bytes,
                "total_bytes": total_bytes,
                "has_cache_file": state.download_file_state.is_some(),
                "is_connected": is_connected,
                "is_playing": state.playing
            }
        });

        // Emit event for real-time updates
        if let Ok(app_handle) = crate::APP_HANDLE.lock() {
            if let Some(handle) = app_handle.as_ref() {
                let _ = handle.emit("playback:download:progress", result.clone());
            }
        }

        Ok(result)
    } else {
        Ok(serde_json::json!({
            "success": false,
            "message": "No active stream"
        }))
    }
}
