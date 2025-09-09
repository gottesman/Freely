# Minimal FFmpeg Build for Freely

Goal: Ship a lean ffmpeg binary (a few MB) supporting only the audio formats required:
WAV, AIFF, MP3, AAC (m4a/mp4/adts), FLAC, ALAC, Vorbis, Opus.

## Enabled Components
Protocols: file, http, https, tcp, tls, pipe, data
Demuxers: wav, aiff, mp3, flac, ogg, matroska, mov, mp4, webm, adts
Decoders: pcm_s16le, pcm_f32le, mp3, aac, flac, alac, vorbis, opus
Parsers: aac, mpegaudio, flac, vorbis, opus
Filters: aresample, anull
Libs: avcodec, avformat, avutil, swresample

Disabled: encoders, muxers (except implicit), devices, docs, debug, ffplay, ffprobe, most filters.

## Build (Linux / macOS)
```bash
bash scripts/build-ffmpeg-audio-only.sh
```
Binary placed at `src-tauri/bin/ffmpeg` with marker `.minimal_ffmpeg`.

## Build (Windows, MSYS2)
1. Install MSYS2 https://www.msys2.org/
2. In MSYS2 shell:
   ```bash
   pacman -S git make nasm yasm pkgconf
   ```
3. Back in PowerShell:
   ```powershell
   pwsh scripts/build-ffmpeg-audio-only.ps1
   ```

## Using the Minimal Build
The existing `scripts/fetch-ffmpeg.js` checks for `.minimal_ffmpeg`. If present it skips download.
Set env `FREELY_ENFORCE_MIN_FFMPEG=1` to make the fetch script error if a large external binary is found instead of minimal marker.

## Duration Probing
`ffprobe` excluded. Playback falls back to:
1. Attempted ffprobe (skipped / absent) -> fallback to `ffmpeg -i` stderr Duration line parse.
2. If that fails, duration remains unknown until end.

Optionally re-enable ffprobe by adding `--enable-ffprobe` and removing `--disable-ffprobe` (size +~ few hundred KB).

## License
FFmpeg is LGPL/GPL depending on enabled parts. The above selection should remain LGPL-only (no GPL filters/codecs). Verify with:
```bash
./ffmpeg -L | grep -i gpl
```
If any GPL lines appear, you must comply with GPL requirements for distribution.

## Troubleshooting
configure: install missing build tools (nasm / yasm). On mac: `brew install nasm pkg-config`
Opus/Vorbis decode issues: ensure internal decoders were built (defaults when decoders explicitly enabled).
HTTPS failures: add `--enable-openssl` (requires openssl dev libs) or rely on system TLS on some platforms.
