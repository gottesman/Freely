const path = require('path');
const fs = require('fs');
const os = require('os');

// YouTube integration with optimized initialization
let YtDlp = null;
let ytdlpAvailable = false;

try {
  ({ YtDlp } = require('ytdlp-nodejs'));
  ytdlpAvailable = true;
} catch (_) {
  console.warn('ytdlp-nodejs not installed; youtube features disabled');
}

// Cache configuration
const CACHE_EXPIRY_MS = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
const CACHE_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 1000;

/**
 * Cache entry structure
 */
class CacheEntry {
  constructor(data) {
    this.data = data;
    this.timestamp = Date.now();
    this.accessCount = 1;
    this.lastAccessed = Date.now();
  }

  isExpired() {
    return Date.now() - this.timestamp > CACHE_EXPIRY_MS;
  }

  touch() {
    this.accessCount++;
    this.lastAccessed = Date.now();
  }
}

/**
 * YouTube data cache manager
 */
class YtDlpCache {
  constructor() {
    this.memoryCache = new Map();
    this.inflightRequests = new Map();
    this.cacheDir = path.join(os.tmpdir(), 'freely-ytdlp-cache');
    this.setupCleanupInterval();
    this.ensureCacheDir();
  }

  ensureCacheDir() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[ytdlp-cache] Failed to create cache directory:', e.message);
    }
  }

  generateCacheKey(target, formatPreference) {
    return `${target}::${formatPreference || 'default'}`;
  }

  getFileCachePath(key) {
    const hash = require('crypto').createHash('md5').update(key).digest('hex');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  async get(key) {
    // Check memory cache first
    const memEntry = this.memoryCache.get(key);
    if (memEntry && !memEntry.isExpired()) {
      memEntry.touch();
      console.log('[ytdlp-cache] Memory cache hit for:', key.substring(0, 50));
      return memEntry.data;
    }

    // Remove expired memory entry
    if (memEntry && memEntry.isExpired()) {
      this.memoryCache.delete(key);
    }

    // Check file cache
    try {
      const filePath = this.getFileCachePath(key);
      if (fs.existsSync(filePath)) {
        const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Date.now() - fileData.timestamp < CACHE_EXPIRY_MS) {
          // Restore to memory cache
          const entry = new CacheEntry(fileData.data);
          entry.timestamp = fileData.timestamp; // Preserve original timestamp
          this.memoryCache.set(key, entry);
          console.log('[ytdlp-cache] File cache hit for:', key.substring(0, 50));
          return fileData.data;
        } else {
          // Remove expired file
          fs.unlinkSync(filePath);
        }
      }
    } catch (e) {
      console.warn('[ytdlp-cache] File cache read error:', e.message);
    }

    return null;
  }

  async set(key, data) {
    try {
      const entry = new CacheEntry(data);
      
      // Store in memory cache
      this.memoryCache.set(key, entry);
      
      // Enforce memory cache size limit
      if (this.memoryCache.size > MAX_CACHE_ENTRIES) {
        this.evictOldestEntries();
      }

      // Store in file cache
      const filePath = this.getFileCachePath(key);
      const fileData = {
        data: data,
        timestamp: entry.timestamp
      };
      fs.writeFileSync(filePath, JSON.stringify(fileData), 'utf8');
      
      console.log('[ytdlp-cache] Cached result for:', key.substring(0, 50));
    } catch (e) {
      console.warn('[ytdlp-cache] Failed to cache data:', e.message);
    }
  }

  evictOldestEntries() {
    const entries = Array.from(this.memoryCache.entries())
      .sort(([,a], [,b]) => a.lastAccessed - b.lastAccessed);
    
    const toRemove = entries.slice(0, Math.floor(MAX_CACHE_ENTRIES * 0.2));
    for (const [key] of toRemove) {
      this.memoryCache.delete(key);
    }
    
    console.log(`[ytdlp-cache] Evicted ${toRemove.length} old entries`);
  }

  setupCleanupInterval() {
    setInterval(() => {
      this.cleanup();
    }, CACHE_CLEANUP_INTERVAL);
  }

  cleanup() {
    let removedCount = 0;
    
    // Clean memory cache
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.isExpired()) {
        this.memoryCache.delete(key);
        removedCount++;
      }
    }

    // Clean file cache
    try {
      if (fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir);
        for (const file of files) {
          const filePath = path.join(this.cacheDir, file);
          try {
            const stats = fs.statSync(filePath);
            if (Date.now() - stats.mtime.getTime() > CACHE_EXPIRY_MS) {
              fs.unlinkSync(filePath);
              removedCount++;
            }
          } catch (e) {
            // File might have been deleted, ignore
          }
        }
      }
    } catch (e) {
      console.warn('[ytdlp-cache] Cleanup error:', e.message);
    }

    if (removedCount > 0) {
      console.log(`[ytdlp-cache] Cleaned up ${removedCount} expired entries`);
    }
  }

  getCacheStats() {
    return {
      memoryEntries: this.memoryCache.size,
      inflightRequests: this.inflightRequests.size,
      cacheDir: this.cacheDir
    };
  }
}

/**
 * Optimized YtDlp patching and instance management with caching
 */
class YtDlpManager {
  static instance = null;
  static initialized = false;
  static cache = new YtDlpCache();

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
    const cacheKey = YtDlpManager.cache.generateCacheKey(target, formatPreference);
    
    // Check cache first
    const cached = await YtDlpManager.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Check for inflight request to prevent duplicate ytdlp processes
    const inflightPromise = YtDlpManager.cache.inflightRequests.get(cacheKey);
    if (inflightPromise) {
      console.log('[ytdlp] Deduplicating request for:', target);
      return await inflightPromise;
    }

    // Create new request
    const requestPromise = this._executeVideoInfoRequest(target, formatPreference, cacheKey);
    YtDlpManager.cache.inflightRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      // Cache the result
      await YtDlpManager.cache.set(cacheKey, result);
      return result;
    } finally {
      // Always clean up inflight request
      YtDlpManager.cache.inflightRequests.delete(cacheKey);
    }
  }

  async _executeVideoInfoRequest(target, formatPreference, cacheKey) {
    const ytdlp = YtDlpManager.getInstance();
    if (!ytdlp) throw new Error('ytdlp unavailable');

    console.log('[ytdlp] Executing fresh request for:', target);

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
    const cacheKey = YtDlpManager.cache.generateCacheKey(`search:${query}`, limit.toString());
    
    // Check cache first
    const cached = await YtDlpManager.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Check for inflight request
    const inflightPromise = YtDlpManager.cache.inflightRequests.get(cacheKey);
    if (inflightPromise) {
      console.log('[ytdlp] Deduplicating search request for:', query);
      return await inflightPromise;
    }

    // Create new search request
    const requestPromise = this._executeSearchRequest(query, limit, cacheKey);
    YtDlpManager.cache.inflightRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      // Cache the result
      await YtDlpManager.cache.set(cacheKey, result);
      return result;
    } finally {
      // Always clean up inflight request
      YtDlpManager.cache.inflightRequests.delete(cacheKey);
    }
  }

  async _executeSearchRequest(query, limit, cacheKey) {
    const ytdlp = YtDlpManager.getInstance();
    if (!ytdlp) throw new Error('ytdlp unavailable');

    console.log('[ytdlp] Executing fresh search for:', query);

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

  static getCacheStats() {
    return YtDlpManager.cache.getCacheStats();
  }

  static clearCache() {
    YtDlpManager.cache.memoryCache.clear();
    YtDlpManager.cache.inflightRequests.clear();
    console.log('[ytdlp] Cache cleared');
  }
}

// Initialize patching
YtDlpManager.patchYtDlp();

module.exports = YtDlpManager;
