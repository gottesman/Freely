# BASS Download Callback Implementation

## Overview
This implementation replaces the manual download and caching system with BASS's built-in DOWNLOADPROC callback mechanism. This provides a more efficient approach where BASS handles both streaming and saving simultaneously.

## Key Changes

### 1. BASS Function Types Added (bass.rs)
- `DownloadProc`: Callback type for handling downloaded data chunks
- `BassStreamGetFilePosition`: For querying download progress
- File position constants: `BASS_FILEPOS_DOWNLOAD`, `BASS_FILEPOS_SIZE`, etc.

### 2. Download Callback Implementation (playback.rs)
- `download_proc()`: C callback function that saves audio data to cache files
- `DownloadFileState`: Structure to manage download state with Arc<Mutex<File>>
- `create_stream_with_download()`: Helper to create streams with download callback

### 3. Stream Creation Flags
- `BASS_STREAM_BLOCK`: Essential for format detection with streaming URLs
- `BASS_STREAM_STATUS`: Enables status querying
- `BASS_STREAM_AUTOFREE`: Automatic cleanup when stream ends

### 4. Caching Integration
- `finalize_cache_file()`: Adds completed downloads to cache index
- Automatic cache cleanup and validation
- Integration with existing cache directory structure

## Benefits

1. **Single Network Request**: BASS downloads once and streams/saves simultaneously
2. **Better Performance**: No duplicate streams or temporary file management
3. **Format Compatibility**: BASS handles format detection and codec support
4. **Automatic Caching**: Files are cached transparently during playback
5. **Progress Tracking**: Real-time download progress via BASS_StreamGetFilePosition

## Usage

When `playback_start_with_source` is called with `prefer_cache: true`:
1. Checks for existing cached file first
2. If not cached, creates stream with download callback
3. BASS streams audio while saving to cache file
4. On completion, adds file to cache index for future use

## Debugging Features

- Detailed logging of callback activity
- Stream creation error reporting
- Download progress tracking
- Duplicate call detection and handling

## Configuration

- **Network Timeout**: 15 seconds for reliable YouTube streaming
- **Network Buffer**: 15 seconds for better seeking support
- **User-Agent**: Modern Chrome user agent for YouTube compatibility
- **Cache Location**: User's AppData/Roaming directory under audio_cache/

## Error Handling

- Format detection failures are properly reported
- Network issues are handled gracefully
- Cache write errors are logged but don't stop playback
- Stream cleanup is automatic on errors or completion