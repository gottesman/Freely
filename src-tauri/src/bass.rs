use libloading::{Library, Symbol};
use std::ffi::{c_void, CStr, CString};
use std::os::raw::{c_char, c_int, c_uint, c_ulong};

// DOWNLOADPROC callback type - called by BASS when downloading data
pub type DownloadProc =
    unsafe extern "C" fn(buffer: *const c_void, length: c_uint, user: *mut c_void);

// BASS function type definitions
pub type BassInit = unsafe extern "system" fn(
    device: c_int,
    freq: c_uint,
    flags: c_uint,
    win: *mut std::ffi::c_void,
    dsguid: *mut std::ffi::c_void,
) -> c_int;
pub type BassFree = unsafe extern "system" fn() -> c_int;
pub type BassSetConfig = unsafe extern "system" fn(option: c_uint, value: c_uint) -> c_uint;
// Pointer variant used for string-based settings like HTTP User-Agent
pub type BassSetConfigPtr = unsafe extern "system" fn(option: c_uint, value: *const u8) -> c_uint;
pub type BassPluginLoad = unsafe extern "system" fn(file: *const c_char, flags: c_uint) -> u32;
pub type BassPluginGetInfo = unsafe extern "system" fn(handle: u32) -> *const BassPluginInfo;
pub type BassStreamCreateFile = unsafe extern "system" fn(
    mem: c_int,
    file: *const std::ffi::c_void,
    offset: c_ulong,
    length: c_ulong,
    flags: c_uint,
) -> u32;
pub type BassStreamCreateUrl = unsafe extern "system" fn(
    url: *const c_char,
    offset: c_ulong,
    flags: c_uint,
    proc_: Option<DownloadProc>,
    user: *mut std::ffi::c_void,
) -> u32;
pub type BassStreamFree = unsafe extern "system" fn(handle: u32) -> c_int;
pub type BassChannelPlay = unsafe extern "system" fn(handle: u32, restart: c_int) -> c_int;
pub type BassChannelPause = unsafe extern "system" fn(handle: u32) -> c_int;
pub type BassChannelStop = unsafe extern "system" fn(handle: u32) -> c_int;
pub type BassChannelIsActive = unsafe extern "system" fn(handle: u32) -> c_uint;
pub type BassChannelGetLength = unsafe extern "system" fn(handle: u32, mode: c_uint) -> c_ulong;
pub type BassChannelGetPosition = unsafe extern "system" fn(handle: u32, mode: c_uint) -> c_ulong;
pub type BassChannelBytes2Seconds = unsafe extern "system" fn(handle: u32, pos: c_ulong) -> f64;
pub type BassChannelSeconds2Bytes = unsafe extern "system" fn(handle: u32, sec: f64) -> c_ulong;
pub type BassChannelSetPosition =
    unsafe extern "system" fn(handle: u32, pos: c_ulong, mode: c_uint) -> c_int;
pub type BassErrorGetCode = unsafe extern "system" fn() -> c_int;
pub type BassChannelGetAttribute =
    unsafe extern "system" fn(handle: u32, attrib: c_uint, value: *mut f32) -> c_int;
pub type BassChannelSetAttribute =
    unsafe extern "system" fn(handle: u32, attrib: c_uint, value: f32) -> c_int;
pub type BassChannelGetInfo =
    unsafe extern "system" fn(handle: u32, info: *mut BassChannelInfo) -> c_int;
pub type BassChannelGetTags = unsafe extern "system" fn(handle: u32, tags: c_uint) -> *const c_char;
pub type BassGetVolume = unsafe extern "system" fn() -> f32;
pub type BassSetVolume = unsafe extern "system" fn(volume: f32) -> c_int;
pub type BassGetDeviceInfo =
    unsafe extern "system" fn(device: c_uint, info: *mut BassDeviceInfo) -> c_int;
pub type BassGetInfo = unsafe extern "system" fn(info: *mut BassInfo) -> c_int;
pub type BassGetDevice = unsafe extern "system" fn() -> c_uint;
pub type BassStreamGetFilePosition =
    unsafe extern "system" fn(handle: u32, mode: c_uint) -> c_ulong;

// BASS constants
pub const BASS_OK: c_int = 0;
pub const BASS_ERROR_INIT: c_int = 2;
pub const BASS_ERROR_NOTAVAIL: c_int = 37;
pub const BASS_ERROR_CREATE: c_int = 5;
pub const BASS_ERROR_FILEOPEN: c_int = 2;

pub const BASS_DEVICE_DEFAULT: c_int = -1;
pub const BASS_CONFIG_NET_TIMEOUT: c_uint = 11;
pub const BASS_CONFIG_NET_AGENT: c_uint = 16;
pub const BASS_CONFIG_NET_BUFFER: c_uint = 10;
// General device buffer length (ms) used prior to BASS_Init
pub const BASS_CONFIG_BUFFER: c_uint = 0;

pub const BASS_STREAM_BLOCK: c_uint = 0x100000; // No longer used - we handle buffering manually
pub const BASS_STREAM_STATUS: c_uint = 0x800000;
pub const BASS_STREAM_AUTOFREE: c_uint = 0x40000;
pub const BASS_STREAM_PRESCAN: c_uint = 0x200000;
pub const BASS_STREAM_RESTRATE: c_uint = 0x80000;

pub const BASS_POS_BYTE: c_uint = 0;
pub const BASS_ACTIVE_STOPPED: c_uint = 0;

// File position modes for BASS_StreamGetFilePosition
pub const BASS_FILEPOS_CURRENT: c_uint = 0;
pub const BASS_FILEPOS_DOWNLOAD: c_uint = 1;
pub const BASS_FILEPOS_END: c_uint = 2;
pub const BASS_FILEPOS_START: c_uint = 3;
pub const BASS_FILEPOS_CONNECTED: c_uint = 4;
pub const BASS_FILEPOS_SIZE: c_uint = 5;
pub const BASS_FILEPOS_ASYNCBUF: c_uint = 6;
pub const BASS_FILEPOS_ASYNCBUFLEN: c_uint = 7;
pub const BASS_ACTIVE_PLAYING: c_uint = 1;
pub const BASS_ACTIVE_STALLED: c_uint = 2;
pub const BASS_ACTIVE_PAUSED: c_uint = 3;

// Volume attributes
pub const BASS_ATTRIB_VOL: c_uint = 2;
pub const BASS_ATTRIB_FREQ: c_uint = 1;

// Tag types for BASS_ChannelGetTags
pub const BASS_TAG_ID3: c_uint = 0; // ID3v1 tags : TAG_ID3 structure
pub const BASS_TAG_ID3V2: c_uint = 1; // ID3v2 tags : variable length block
pub const BASS_TAG_OGG: c_uint = 2; // OGG comments : series of null-terminated UTF-8 strings
pub const BASS_TAG_HTTP: c_uint = 3; // HTTP headers : series of null-terminated ANSI strings
pub const BASS_TAG_ICY: c_uint = 4; // ICY headers : series of null-terminated ANSI strings
pub const BASS_TAG_META: c_uint = 5; // ICY metadata : ANSI string
pub const BASS_TAG_APE: c_uint = 6; // APE tags : series of null-terminated UTF-8 strings
pub const BASS_TAG_MP4: c_uint = 7; // MP4/iTunes metadata : series of null-terminated UTF-8 strings
pub const BASS_TAG_WMA: c_uint = 8; // WMA tags : series of null-terminated UTF-8 strings
pub const BASS_TAG_VENDOR: c_uint = 9; // OGG encoder : UTF-8 string
pub const BASS_TAG_LYRICS3: c_uint = 10; // Lyric3v2 tag : ANSI string
pub const BASS_TAG_CA_CODEC: c_uint = 11; // CoreAudio codec info : TAG_CA_CODEC structure
pub const BASS_TAG_MF: c_uint = 13; // Media Foundation tags : series of null-terminated UTF-8 strings
pub const BASS_TAG_WAVEFORMAT: c_uint = 14; // WAVE format : WAVEFORMATEX structure
pub const BASS_TAG_RIFF_INFO: c_uint = 0x100; // RIFF "INFO" tags : series of null-terminated ANSI strings
pub const BASS_TAG_RIFF_BEXT: c_uint = 0x101; // RIFF "BEXT" tags : TAG_BEXT structure
pub const BASS_TAG_RIFF_CART: c_uint = 0x102; // RIFF "CART" tags : TAG_CART structure
pub const BASS_TAG_RIFF_DISP: c_uint = 0x103; // RIFF "DISP" tags : TAG_DISP structure
pub const BASS_TAG_APE_BINARY: c_uint = 0x1000; // + index #, binary APE tag : TAG_APE_BINARY structure
pub const BASS_TAG_MUSIC_NAME: c_uint = 0x10000; // MOD music name : ANSI string
pub const BASS_TAG_MUSIC_MESSAGE: c_uint = 0x10001; // MOD message : ANSI string
pub const BASS_TAG_MUSIC_ORDERS: c_uint = 0x10002; // MOD order list : BYTE array of size length
pub const BASS_TAG_MUSIC_AUTH: c_uint = 0x10003; // MOD author : UTF-8 string
pub const BASS_TAG_MUSIC_INST: c_uint = 0x10100; // + instrument #, MOD instrument name : ANSI string
pub const BASS_TAG_MUSIC_SAMPLE: c_uint = 0x10300; // + sample #, MOD sample name : ANSI string

// Plugin info structs for BASS_PluginGetInfo
#[repr(C)]
pub struct BassPluginForm {
    pub ctype: c_uint,
    pub name: *const c_char,
    pub exts: *const c_char,
}

#[repr(C)]
pub struct BassPluginInfo {
    pub version: c_uint,
    pub formatc: c_uint,
    pub formats: *const BassPluginForm,
}

// Channel type flags (ctype field in BASS_CHANNELINFO)
pub const BASS_CTYPE_SAMPLE: c_uint = 1;
pub const BASS_CTYPE_RECORD: c_uint = 2;
pub const BASS_CTYPE_STREAM: c_uint = 0x10000;
pub const BASS_CTYPE_STREAM_OGG: c_uint = 0x10002;
pub const BASS_CTYPE_STREAM_MP1: c_uint = 0x10003;
pub const BASS_CTYPE_STREAM_MP2: c_uint = 0x10004;
pub const BASS_CTYPE_STREAM_MP3: c_uint = 0x10005;
pub const BASS_CTYPE_STREAM_AIFF: c_uint = 0x10006;
pub const BASS_CTYPE_STREAM_CA: c_uint = 0x10007;
pub const BASS_CTYPE_STREAM_MF: c_uint = 0x10008;
pub const BASS_CTYPE_STREAM_WAV: c_uint = 0x10009;
pub const BASS_CTYPE_STREAM_WAV_PCM: c_uint = 0x50001;
pub const BASS_CTYPE_STREAM_WAV_FLOAT: c_uint = 0x50003;
// Plugin-provided stream types (partial)
// Values based on BASS plugin API docs; used for codec identification only
pub const BASS_CTYPE_STREAM_FLAC: c_uint = 0x10900; // from bassflac
pub const BASS_CTYPE_STREAM_FLAC_OGG: c_uint = 0x10901; // from bassflac (Ogg FLAC)
pub const BASS_CTYPE_MUSIC_MOD: c_uint = 0x20000;
pub const BASS_CTYPE_MUSIC_MTM: c_uint = 0x20001;
pub const BASS_CTYPE_MUSIC_S3M: c_uint = 0x20002;
pub const BASS_CTYPE_MUSIC_XM: c_uint = 0x20003;
pub const BASS_CTYPE_MUSIC_IT: c_uint = 0x20004;
pub const BASS_CTYPE_MUSIC_MO3: c_uint = 0x00100;

// DSD and DXD stream types
pub const BASS_CTYPE_STREAM_DSD: c_uint = 0x10700;
pub const BASS_CTYPE_STREAM_DSD_RAW: c_uint = 0x10701;

// Device flags
pub const BASS_DEVICE_ENABLED: c_uint = 1;
pub const BASS_DEVICE_DEFAULT_FLAG: c_uint = 2;
pub const BASS_DEVICE_INIT: c_uint = 4;

// BASS device info structure
#[repr(C)]
#[derive(Debug)]
pub struct BassDeviceInfo {
    pub name: *const c_char,
    pub driver: *const c_char,
    pub flags: c_uint,
}

// BASS info structure for current audio settings
#[repr(C)]
#[derive(Debug)]
pub struct BassInfo {
    pub flags: c_uint,     // device capabilities (DSCAPS_xxx flags)
    pub hwsize: c_uint,    // size of total device hardware buffer
    pub hwfree: c_uint,    // size of free device hardware buffer
    pub freesam: c_uint,   // number of free sample slots in the hardware
    pub free3d: c_uint,    // number of free 3D sample slots in the hardware
    pub minrate: c_uint,   // min sample rate supported by the hardware
    pub maxrate: c_uint,   // max sample rate supported by the hardware
    pub eax: c_int,        // device supports EAX? (always FALSE if BASS_DEVICE_3D was not used)
    pub minbuf: c_uint,    // recommended minimum buffer length in ms
    pub dsver: c_uint,     // DirectSound version
    pub latency: c_uint,   // delay (in ms) before start of playback
    pub initflags: c_uint, // BASS_Init "flags" parameter
    pub speakers: c_uint,  // number of speakers available
    pub freq: c_uint,      // current output sample rate
}

// BASS channel info structure
#[repr(C)]
#[derive(Debug)]
pub struct BassChannelInfo {
    pub freq: c_uint,            // default playback rate
    pub chans: c_uint,           // channels
    pub flags: c_uint,           // BASS_SAMPLE/STREAM/MUSIC/SPEAKER flags
    pub ctype: c_uint,           // type of channel (BASS_CTYPE_xxx)
    pub origres: c_uint,         // original resolution
    pub plugin: u32,             // plugin handle (HPLUGIN)
    pub sample: u32,             // sample handle (HSAMPLE/HMUSIC)
    pub filename: *const c_char, // filename (NULL=live stream)
}

// Dynamic loading helper functions
pub fn load_bass_library() -> Result<Library, String> {
    // Try to load BASS DLL from different locations
    let possible_paths = ["bass.dll", "./bass.dll", "./bin/bass.dll", "bin/bass.dll"];

    for path in &possible_paths {
        if let Ok(lib) = unsafe { Library::new(path) } {
            println!("[bass] Successfully loaded BASS library from: {}", path);
            return Ok(lib);
        }
    }

    Err("Could not load bass.dll. Make sure the BASS library is available.".to_string())
}

pub fn ensure_bass_loaded() -> Result<Library, String> {
    let lib = load_bass_library()?;

    // Test that we can load a basic function to verify the library is valid
    unsafe {
        let _test_func: Result<Symbol<BassFree>, _> = lib.get(b"BASS_Free");
        if _test_func.is_err() {
            return Err("BASS library loaded but BASS_Free function not found".to_string());
        }
    };

    // Load plugins after BASS is initialized
    load_bass_plugins(&lib)?;

    Ok(lib)
}

pub fn load_bass_plugins(lib: &Library) -> Result<(), String> {
    // Load BASS_PluginLoad function
    let bass_plugin_load: Symbol<BassPluginLoad> = unsafe {
        match lib.get(b"BASS_PluginLoad") {
            Ok(func) => func,
            Err(_) => {
                println!("[bass] BASS_PluginLoad not available, skipping plugin loading");
                return Ok(());
            }
        }
    };

    // List of plugins to try loading with their paths
    let plugin_configs = [
        (
            "bass_aac.dll",
            vec!["bass_aac.dll", "./bin/bass_aac.dll", "bin/bass_aac.dll"],
        ),
        (
            "bassflac.dll",
            vec!["bassflac.dll", "./bin/bassflac.dll", "bin/bassflac.dll"],
        ),
        (
            "bassopus.dll",
            vec!["bassopus.dll", "./bin/bassopus.dll", "bin/bassopus.dll"],
        ),
        (
            "basshls.dll",
            vec!["basshls.dll", "./bin/basshls.dll", "bin/basshls.dll"],
        ),
        (
            "bassaac.dll",
            vec!["bassaac.dll", "./bin/bassaac.dll", "bin/bassaac.dll"],
        ),
        (
            "bassdsd.dll",
            vec!["bassdsd.dll", "./bin/bassdsd.dll", "bin/bassdsd.dll"],
        ),
        (
            "basswebm.dll",
            vec!["basswebm.dll", "./bin/basswebm.dll", "bin/basswebm.dll"],
        ),
        (
            "bassalac.dll",
            vec!["bassalac.dll", "./bin/bassalac.dll", "bin/bassalac.dll"],
        ),
        (
            "basswv.dll",
            vec!["basswv.dll", "./bin/basswv.dll", "bin/basswv.dll"],
        ),
    ];

    for (plugin_name, paths) in &plugin_configs {
        for path in paths {
            unsafe {
                let c_path = std::ffi::CString::new(*path).map_err(|_| "Invalid plugin path")?;
                let result = bass_plugin_load(c_path.as_ptr(), 0);
                if result != 0 {
                    println!(
                        "[bass] Successfully loaded plugin: {} from {}",
                        plugin_name, path
                    );
                    break;
                }
            }
        }
    }

    Ok(())
}

pub fn bass_err(lib: &Library) -> String {
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

pub fn probe_duration_bass(lib: &Library, handle: u32) -> Option<f64> {
    unsafe {
        let get_length: Symbol<BassChannelGetLength> = lib.get(b"BASS_ChannelGetLength").ok()?;
        let bytes_to_seconds: Symbol<BassChannelBytes2Seconds> =
            lib.get(b"BASS_ChannelBytes2Seconds").ok()?;

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

// ---- Lightweight wrapper functions over BASS symbols ----

pub fn bass_init(lib: &Library, device: c_int, freq: c_uint, flags: c_uint) -> c_int {
    unsafe {
        let f: Symbol<BassInit> = match lib.get(b"BASS_Init") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(
            device,
            freq,
            flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    }
}

pub fn bass_free(lib: &Library) -> c_int {
    unsafe {
        let f: Symbol<BassFree> = match lib.get(b"BASS_Free") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f()
    }
}

pub fn bass_set_config(lib: &Library, option: c_uint, value: c_uint) -> c_uint {
    unsafe {
        let f: Symbol<BassSetConfig> = match lib.get(b"BASS_SetConfig") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(option, value)
    }
}

pub fn bass_set_config_ptr(lib: &Library, option: c_uint, value: *const u8) -> c_uint {
    unsafe {
        let f: Symbol<BassSetConfigPtr> = match lib.get(b"BASS_SetConfigPtr") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(option, value)
    }
}

// legacy variants removed; use stream_create below

// Unified stream creation API to handle both file and URL sources with optional offset and callback
pub enum StreamSource<'a> {
    File(&'a CStr),
    Url {
        url: &'a CStr,
        offset: Option<c_ulong>,
    },
}

pub fn stream_create(
    lib: &Library,
    src: StreamSource,
    flags: c_uint,
    proc_cb: Option<DownloadProc>,
    user: *mut std::ffi::c_void,
) -> u32 {
    unsafe {
        match src {
            StreamSource::File(path) => {
                let f: Symbol<BassStreamCreateFile> = match lib.get(b"BASS_StreamCreateFile") {
                    Ok(f) => f,
                    Err(_) => return 0,
                };
                f(0, path.as_ptr() as *const std::ffi::c_void, 0, 0, flags)
            }
            StreamSource::Url { url, offset } => {
                let ofs = offset.unwrap_or(0);
                let f: Symbol<BassStreamCreateUrl> = match lib.get(b"BASS_StreamCreateURL") {
                    Ok(f) => f,
                    Err(_) => return 0,
                };
                f(url.as_ptr(), ofs, flags, proc_cb, user)
            }
        }
    }
}

pub fn stream_free(lib: &Library, handle: u32) -> c_int {
    unsafe {
        let f: Symbol<BassStreamFree> = match lib.get(b"BASS_StreamFree") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle)
    }
}

pub fn channel_play(lib: &Library, handle: u32, restart: c_int) -> c_int {
    unsafe {
        let f: Symbol<BassChannelPlay> = match lib.get(b"BASS_ChannelPlay") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle, restart)
    }
}

pub fn channel_pause(lib: &Library, handle: u32) -> c_int {
    unsafe {
        let f: Symbol<BassChannelPause> = match lib.get(b"BASS_ChannelPause") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle)
    }
}

pub fn channel_stop(lib: &Library, handle: u32) -> c_int {
    unsafe {
        let f: Symbol<BassChannelStop> = match lib.get(b"BASS_ChannelStop") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle)
    }
}

pub fn channel_is_active(lib: &Library, handle: u32) -> c_uint {
    unsafe {
        let f: Symbol<BassChannelIsActive> = match lib.get(b"BASS_ChannelIsActive") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle)
    }
}

pub fn channel_get_length(lib: &Library, handle: u32, mode: c_uint) -> c_ulong {
    unsafe {
        let f: Symbol<BassChannelGetLength> = match lib.get(b"BASS_ChannelGetLength") {
            Ok(f) => f,
            Err(_) => return 0xFFFFFFFF,
        };
        f(handle, mode)
    }
}

pub fn channel_get_position(lib: &Library, handle: u32, mode: c_uint) -> c_ulong {
    unsafe {
        let f: Symbol<BassChannelGetPosition> = match lib.get(b"BASS_ChannelGetPosition") {
            Ok(f) => f,
            Err(_) => return 0xFFFFFFFF,
        };
        f(handle, mode)
    }
}

pub fn channel_bytes2seconds(lib: &Library, handle: u32, pos: c_ulong) -> f64 {
    unsafe {
        let f: Symbol<BassChannelBytes2Seconds> = match lib.get(b"BASS_ChannelBytes2Seconds") {
            Ok(f) => f,
            Err(_) => return 0.0,
        };
        f(handle, pos)
    }
}

pub fn channel_seconds2bytes(lib: &Library, handle: u32, sec: f64) -> c_ulong {
    unsafe {
        let f: Symbol<BassChannelSeconds2Bytes> = match lib.get(b"BASS_ChannelSeconds2Bytes") {
            Ok(f) => f,
            Err(_) => return 0xFFFFFFFF,
        };
        f(handle, sec)
    }
}

pub fn channel_set_position(lib: &Library, handle: u32, pos: c_ulong, mode: c_uint) -> c_int {
    unsafe {
        let f: Symbol<BassChannelSetPosition> = match lib.get(b"BASS_ChannelSetPosition") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle, pos, mode)
    }
}

pub fn channel_set_attribute(lib: &Library, handle: u32, attrib: c_uint, value: f32) -> c_int {
    unsafe {
        let f: Symbol<BassChannelSetAttribute> = match lib.get(b"BASS_ChannelSetAttribute") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle, attrib, value)
    }
}

pub fn channel_get_attribute(lib: &Library, handle: u32, attrib: c_uint, value: &mut f32) -> c_int {
    unsafe {
        let f: Symbol<BassChannelGetAttribute> = match lib.get(b"BASS_ChannelGetAttribute") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle, attrib, value as *mut f32)
    }
}

pub fn error_get_code(lib: &Library) -> c_int {
    unsafe {
        let f: Symbol<BassErrorGetCode> = match lib.get(b"BASS_ErrorGetCode") {
            Ok(f) => f,
            Err(_) => return -1,
        };
        f()
    }
}

pub fn get_device_info(lib: &Library, device: c_uint, info: &mut BassDeviceInfo) -> c_int {
    unsafe {
        let f: Symbol<BassGetDeviceInfo> = match lib.get(b"BASS_GetDeviceInfo") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(device, info)
    }
}

pub fn get_info(lib: &Library, info: &mut BassInfo) -> c_int {
    unsafe {
        let f: Symbol<BassGetInfo> = match lib.get(b"BASS_GetInfo") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(info)
    }
}

pub fn get_device(lib: &Library) -> c_uint {
    unsafe {
        let f: Symbol<BassGetDevice> = match lib.get(b"BASS_GetDevice") {
            Ok(f) => f,
            Err(_) => return u32::MAX,
        };
        f()
    }
}

pub fn stream_get_file_position(lib: &Library, handle: u32, mode: c_uint) -> c_ulong {
    unsafe {
        let f: Symbol<BassStreamGetFilePosition> = match lib.get(b"BASS_StreamGetFilePosition") {
            Ok(f) => f,
            Err(_) => return 0xFFFFFFFF,
        };
        f(handle, mode)
    }
}

pub fn channel_get_info(lib: &Library, handle: u32, info: &mut BassChannelInfo) -> c_int {
    unsafe {
        let f: Symbol<BassChannelGetInfo> = match lib.get(b"BASS_ChannelGetInfo") {
            Ok(f) => f,
            Err(_) => return 0,
        };
        f(handle, info)
    }
}

pub fn channel_get_tags(lib: &Library, handle: u32, tags: c_uint) -> *const c_char {
    unsafe {
        let f: Symbol<BassChannelGetTags> = match lib.get(b"BASS_ChannelGetTags") {
            Ok(f) => f,
            Err(_) => return std::ptr::null(),
        };
        f(handle, tags)
    }
}

// ---- Format/codec probing helpers (shared) ----

/// Try to extract a codec string from available tags (metadata, container, HTTP headers)
pub fn codec_from_tags(lib: &Library, handle: u32) -> Option<String> {
    // 1) Inspect common metadata blocks
    let meta_tag_types = [
        BASS_TAG_ID3V2,
        BASS_TAG_MP4,
        BASS_TAG_OGG,
        BASS_TAG_APE,
        BASS_TAG_WMA,
    ];

    for &tag_type in &meta_tag_types {
        let tags_ptr = channel_get_tags(lib, handle, tag_type);
        if !tags_ptr.is_null() {
            unsafe {
                let tags_str = std::ffi::CStr::from_ptr(tags_ptr).to_string_lossy();
                let tags = tags_str.to_lowercase();
                if tags.contains("mp3") || tags.contains("mpeg-1") || tags.contains("mpeg-2") {
                    return Some("mp3".to_string());
                } else if tags.contains("aac") {
                    return Some("aac".to_string());
                } else if tags.contains("flac") {
                    return Some("flac".to_string());
                } else if tags.contains("alac") {
                    return Some("alac".to_string());
                } else if tags.contains("vorbis") {
                    return Some("ogg".to_string());
                } else if tags.contains("opus") {
                    return Some("opus".to_string());
                } else if tags.contains("wavpack") || tags.contains("wv") {
                    return Some("wv".to_string());
                }
            }
        }
    }

    // 2) Inspect HTTP headers (useful for streams): Content-Type
    let http_ptr = channel_get_tags(lib, handle, BASS_TAG_HTTP);
    if !http_ptr.is_null() {
        unsafe {
            let headers = std::ffi::CStr::from_ptr(http_ptr)
                .to_string_lossy()
                .to_lowercase();
            // Try to find an explicit content-type
            if headers.contains("audio/flac") || headers.contains("content-type: audio/flac") {
                return Some("flac".to_string());
            }
            if headers.contains("audio/aac") || headers.contains("content-type: audio/aac") {
                return Some("aac".to_string());
            }
            if headers.contains("audio/mp4")
                || headers.contains("audio/m4a")
                || headers.contains("content-type: audio/mp4")
            {
                return Some("m4a".to_string());
            }
            if headers.contains("audio/ogg") || headers.contains("content-type: audio/ogg") {
                // Could be Vorbis or Opus; prefer Opus if seen elsewhere later
                return Some("ogg".to_string());
            }
            if headers.contains("audio/opus") || headers.contains("content-type: audio/opus") {
                return Some("opus".to_string());
            }
            if headers.contains("audio/webm") || headers.contains("content-type: audio/webm") {
                return Some("webm".to_string());
            }
            if headers.contains("audio/wav") || headers.contains("audio/x-wav") {
                return Some("wav".to_string());
            }
        }
    }

    // 3) Inspect vendor string (primarily for OGG-based containers)
    let vendor_ptr = channel_get_tags(lib, handle, BASS_TAG_VENDOR);
    if !vendor_ptr.is_null() {
        unsafe {
            let vendor = std::ffi::CStr::from_ptr(vendor_ptr)
                .to_string_lossy()
                .to_lowercase();
            if vendor.contains("opus") {
                return Some("opus".to_string());
            }
            if vendor.contains("vorbis") {
                return Some("ogg".to_string());
            }
            if vendor.contains("flac") {
                return Some("flac".to_string());
            }
        }
    }

    None
}

/// Try to infer codec from the filename/URL extension
fn codec_from_filename_ptr(filename: *const c_char) -> Option<String> {
    if filename.is_null() {
        return None;
    }
    unsafe {
        let name = std::ffi::CStr::from_ptr(filename)
            .to_string_lossy()
            .to_lowercase();
        if name.contains(".flac") {
            return Some("flac".to_string());
        }
        if name.contains(".m4a") || name.contains(".mp4") {
            return Some("m4a".to_string());
        }
        if name.contains(".aac") {
            return Some("aac".to_string());
        }
        if name.contains(".mp3") {
            return Some("mp3".to_string());
        }
        if name.contains(".ogg") || name.contains(".oga") {
            return Some("ogg".to_string());
        }
        if name.contains(".opus") {
            return Some("opus".to_string());
        }
        if name.contains(".aiff") || name.contains(".aif") {
            return Some("aiff".to_string());
        }
        if name.contains(".wav") {
            return Some("wav".to_string());
        }
        if name.contains(".wv") {
            return Some("wv".to_string());
        }
        if name.contains(".alac") {
            return Some("alac".to_string());
        }
    }
    None
}

/// Minimal info about stream format
#[derive(Debug, Clone)]
pub struct BassAudioFormatInfo {
    pub codec: Option<String>,
    pub sample_rate: Option<u32>,
    pub bits_per_sample: Option<u32>,
}

/// Probe audio format from a BASS channel handle
pub fn probe_audio_format_from_channel(lib: &Library, handle: u32) -> BassAudioFormatInfo {
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
        return BassAudioFormatInfo {
            codec: None,
            sample_rate: None,
            bits_per_sample: None,
        };
    }

    let mut actual_freq: f32 = 0.0;
    let sample_rate = if channel_get_attribute(lib, handle, BASS_ATTRIB_FREQ, &mut actual_freq) != 0
    {
        Some(actual_freq as u32)
    } else {
        Some(info.freq)
    };

    let bits_per_sample = if info.origres > 0 {
        Some(info.origres)
    } else {
        None
    };

    let codec = if info.freq >= 352000 {
        Some("dxd".to_string())
    } else {
        // First try direct ctype mappings for native/core formats we know
        let direct = match info.ctype {
            BASS_CTYPE_STREAM_MP3 => Some("mp3".to_string()),
            BASS_CTYPE_STREAM_OGG => Some("ogg".to_string()),
            BASS_CTYPE_STREAM_WAV | BASS_CTYPE_STREAM_WAV_PCM | BASS_CTYPE_STREAM_WAV_FLOAT => {
                Some("wav".to_string())
            }
            BASS_CTYPE_STREAM_AIFF => Some("aiff".to_string()),
            BASS_CTYPE_STREAM_DSD | BASS_CTYPE_STREAM_DSD_RAW => Some("dsd".to_string()),
            BASS_CTYPE_STREAM_FLAC | BASS_CTYPE_STREAM_FLAC_OGG => Some("flac".to_string()),
            // CoreAudio / Media Foundation often indicate MP4/M4A family; refine via tags
            BASS_CTYPE_STREAM_CA | BASS_CTYPE_STREAM_MF => Some("m4a".to_string()),
            _ => None,
        };

        // Then fallback to tags and HTTP headers
        let via_tags = direct.or_else(|| codec_from_tags(lib, handle));

        // Finally, try filename/URL extension if still unknown
        let via_name = via_tags.or_else(|| codec_from_filename_ptr(info.filename));

        // As a last resort, try inspecting the plugin handle with BASS_PluginGetInfo
        if via_name.is_some() {
            via_name
        } else {
            // Dynamically load BASS_PluginGetInfo and inspect formats
            unsafe {
                if let Ok(sym) = lib.get::<BassPluginGetInfo>(b"BASS_PluginGetInfo") {
                    if info.plugin != 0 {
                        let pinfo_ptr = sym(info.plugin);
                        if !pinfo_ptr.is_null() {
                            let pinfo = &*pinfo_ptr;
                            // Iterate formats to find a recognizable name or extension
                            for i in 0..pinfo.formatc {
                                let form_ptr = pinfo.formats.add(i as usize);
                                if form_ptr.is_null() {
                                    continue;
                                }
                                let form = &*form_ptr;
                                let name: String = if !form.name.is_null() {
                                    std::ffi::CStr::from_ptr(form.name)
                                        .to_string_lossy()
                                        .to_lowercase()
                                        .to_string()
                                } else {
                                    String::new()
                                };
                                let exts: String = if !form.exts.is_null() {
                                    std::ffi::CStr::from_ptr(form.exts)
                                        .to_string_lossy()
                                        .to_lowercase()
                                        .to_string()
                                } else {
                                    String::new()
                                };
                                // Heuristics based on plugin format name/extensions
                                if name.contains("flac") || exts.contains("flac") {
                                    return BassAudioFormatInfo {
                                        codec: Some("flac".to_string()),
                                        sample_rate,
                                        bits_per_sample,
                                    };
                                }
                                if name.contains("opus") || exts.contains("opus") {
                                    return BassAudioFormatInfo {
                                        codec: Some("opus".to_string()),
                                        sample_rate,
                                        bits_per_sample,
                                    };
                                }
                                if name.contains("aac") || exts.contains("aac") {
                                    return BassAudioFormatInfo {
                                        codec: Some("aac".to_string()),
                                        sample_rate,
                                        bits_per_sample,
                                    };
                                }
                                if name.contains("alac") || exts.contains("alac") {
                                    return BassAudioFormatInfo {
                                        codec: Some("alac".to_string()),
                                        sample_rate,
                                        bits_per_sample,
                                    };
                                }
                                if name.contains("wavpack") || exts.contains("wv") {
                                    return BassAudioFormatInfo {
                                        codec: Some("wv".to_string()),
                                        sample_rate,
                                        bits_per_sample,
                                    };
                                }
                                if name.contains("webm") || exts.contains("webm") {
                                    return BassAudioFormatInfo {
                                        codec: Some("webm".to_string()),
                                        sample_rate,
                                        bits_per_sample,
                                    };
                                }
                            }
                        }
                    }
                }
            }
            None
        }
    };

    BassAudioFormatInfo {
        codec,
        sample_rate,
        bits_per_sample,
    }
}

/// Create a temporary BASS stream for URL and probe its format; the stream is freed before returning.
pub fn probe_audio_format_for_url(lib: &Library, url: &str) -> Option<BassAudioFormatInfo> {
    let c_url = std::ffi::CString::new(url).ok()?;
    let flags = BASS_STREAM_STATUS | BASS_STREAM_BLOCK | BASS_STREAM_PRESCAN | BASS_STREAM_RESTRATE;
    let handle = stream_create(
        lib,
        StreamSource::Url {
            url: &c_url,
            offset: None,
        },
        flags,
        None,
        std::ptr::null_mut(),
    );
    if handle == 0 {
        return None;
    }
    let fmt = probe_audio_format_from_channel(lib, handle);
    let _ = stream_free(lib, handle);
    Some(fmt)
}
