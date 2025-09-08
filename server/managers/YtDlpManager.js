const path = require('path');
const fs = require('fs');

// YouTube integration with optimized initialization
let YtDlp = null;
let ytdlpAvailable = false;

try {
  ({ YtDlp } = require('ytdlp-nodejs'));
  ytdlpAvailable = true;
} catch (_) {
  console.warn('ytdlp-nodejs not installed; youtube features disabled');
}

/**
 * Optimized YtDlp patching and instance management
 */
class YtDlpManager {
  static instance = null;
  static initialized = false;

  static patchYtDlp() {
    if (!YtDlp || !YtDlp.prototype) return;
    
    // Monkey-patch to avoid ffmpeg/ffprobe auto-download
    const methodsToPatch = ['downloadFFmpeg', 'ensureFFmpeg', 'downloadFFprobe', 'ensureFFprobe'];
    for (const method of methodsToPatch) {
      if (typeof YtDlp.prototype[method] === 'function') {
        try {
          YtDlp.prototype[method] = async function() { return null; };
        } catch (_) { /* ignore */ }
      }
    }
  }

  static findBinaryPath() {
    if (!ytdlpAvailable) return null;
    
    const candidates = [];
    const platform = process.platform;
    const binNames = platform === 'win32' 
      ? ['yt-dlp.exe', 'yt-dlp_x86.exe']
      : ['yt-dlp', 'yt-dlp_macos', 'yt-dlp_linux_armv7l', 'yt-dlp_linux_aarch64'];

    // Environment override
    if (process.env.YTDLP_BINARY_PATH) {
      candidates.push(process.env.YTDLP_BINARY_PATH);
    }

    // Local bin folders
    const localBin = path.join(__dirname, '..', 'bin');
    binNames.forEach(name => candidates.push(path.join(localBin, name)));
    
    // Parent directory fallback
    candidates.push(path.join(__dirname, '..', '..', 'bin', 'yt-dlp'));
    
    // System path (last resort)
    binNames.forEach(name => candidates.push(name));

    // Find existing binary
    for (const candidate of candidates) {
      try {
        if (candidate && fs.existsSync(candidate)) {
          return candidate;
        }
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  static createInstance() {
    if (!ytdlpAvailable) return null;
    if (this.instance && this.initialized) return this.instance;

    const binaryPath = this.findBinaryPath();
    const opts = { 
      ffmpegPath: '', 
      autoDownload: false, 
      downloadFFmpeg: false 
    };
    
    if (binaryPath) opts.binaryPath = binaryPath;

    try {
      this.instance = new YtDlp(opts);
      this.initialized = true;
      if (binaryPath) {
        console.log('[youtube] using existing yt-dlp binary', binaryPath);
      }
      return this.instance;
    } catch (e) {
      console.warn('[youtube] failed to construct YtDlp instance:', e.message);
      try {
        this.instance = new YtDlp();
        this.initialized = true;
        return this.instance;
      } catch (e2) {
        console.error('[youtube] fallback YtDlp() failed:', e2.message);
        return null;
      }
    }
  }

  static getInstance() {
    return this.createInstance();
  }

  static getCapabilityInfo() {
    return {
      loaded: ytdlpAvailable,
      patched: !!(YtDlp && typeof YtDlp.prototype.downloadFFmpeg === 'function' && 
                 YtDlp.prototype.downloadFFmpeg.toString().includes('return null'))
    };
  }

  async getVideoInfo(target, formatPreference = 'bestaudio[ext=m4a]') {
    const ytdlp = YtDlpManager.getInstance();
    if (!ytdlp) throw new Error('ytdlp unavailable');

    const infoArgs = [
      '--no-warnings',
      '--no-config',
      '--no-playlist',
      '--skip-download',
      '--no-call-home',
      '--no-check-certificate',
      '--no-mtime',
      '--no-embed-thumbnail',
      '--dump-single-json',
      '--socket-timeout', '2',
      '--retries', '0',
      '--no-simulate',
      '-f', formatPreference
    ];

    const { SERVER_CONSTANTS } = require('../config/constants');
    const INFO_TIMEOUT = SERVER_CONSTANTS.TIMEOUTS.YTDLP_INFO;

    try {
      const info = await Promise.race([
        ytdlp.getInfoAsync(target, { args: infoArgs }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ytdlp-info-timeout')), INFO_TIMEOUT))
      ]);

      return info;
    } catch (e) {
      // Fallback to basic call
      return await Promise.race([
        ytdlp.getInfoAsync(target),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ytdlp-info-timeout')), INFO_TIMEOUT))
      ]);
    }
  }

  async searchVideos(query, limit = 5) {
    const ytdlp = YtDlpManager.getInstance();
    if (!ytdlp) throw new Error('ytdlp unavailable');

    const searchTarget = `ytmusicsearch${limit}:${query}`;
    const { SERVER_CONSTANTS } = require('../config/constants');
    const SEARCH_TIMEOUT = SERVER_CONSTANTS.TIMEOUTS.YTDLP_SEARCH;

    try {
      const info = await Promise.race([
        ytdlp.getInfoAsync(searchTarget, { 
          args: ['--no-warnings','--no-config','--dump-single-json','--no-playlist','--socket-timeout','3','--retries','0'] 
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ytdlp-search-timeout')), SEARCH_TIMEOUT))
      ]);

      return Array.isArray(info?.entries) ? info.entries : (info ? [info] : []);
    } catch (e) {
      // Fallback to ytsearch
      try {
        const info = await Promise.race([
          ytdlp.getInfoAsync(`ytsearch${limit}:${query}`, { 
            args: ['--no-warnings','--no-config','--dump-single-json','--no-playlist','--socket-timeout','3','--retries','0'] 
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('ytdlp-search-timeout')), SEARCH_TIMEOUT))
        ]);

        return Array.isArray(info?.entries) ? info.entries : (info ? [info] : []);
      } catch (e2) {
        console.warn('[YtDlpManager] search fallbacks failed', e2?.message || e2);
        return [];
      }
    }
  }

  pickAudioFormat(info) {
    if (!info || !Array.isArray(info.formats)) return null;

    // prefer requested_formats (present when -f chosen)
    if (info.requested_formats && info.requested_formats[0] && info.requested_formats[0].url) {
      return info.requested_formats[0];
    }

    // Candidate predicates - prefer m4a/mp4, then webm/opus, then any format with acodec != 'none'
    const preferExts = ['m4a', 'mp4', 'webm', 'opus', 'aac', 'mp3', 'vorbis'];
    
    // Try preferred ext with url
    for (const ext of preferExts) {
      const f = info.formats.find(ff => ff.ext === ext && ff.url && ff.acodec && ff.acodec !== 'none');
      if (f) return f;
    }
    
    // fallback: any format with audio codec and URL
    const anyAudio = info.formats.find(ff => ff.url && ff.acodec && ff.acodec !== 'none');
    if (anyAudio) return anyAudio;
    
    return null;
  }
}

// Initialize patching
YtDlpManager.patchYtDlp();

module.exports = YtDlpManager;
