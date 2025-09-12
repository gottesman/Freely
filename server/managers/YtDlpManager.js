const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// YouTube integration with optimized initialization
let youtubeDlAvailable = false;
let youtubeDlPath = null;

// User agent for YouTube requests
const YOUTUBE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Execute youtube-dl command and return the result
 */
function executeYoutubeDl(args) {
  return new Promise((resolve, reject) => {
    if (!youtubeDlAvailable || !youtubeDlPath) {
      reject(new Error('youtube-dl not available'));
      return;
    }

    // Validate binary exists and is accessible
    if (!fs.existsSync(youtubeDlPath)) {
      reject(new Error(`youtube-dl binary not found at: ${youtubeDlPath}`));
      return;
    }

    console.log(`[youtube-dl] Executing: ${youtubeDlPath} with args:`, args);

    const child = spawn(youtubeDlPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`youtube-dl exited with code ${code}: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      console.error(`[youtube-dl] Spawn error for ${youtubeDlPath}:`, err.message);
      console.error(`[youtube-dl] Error code:`, err.code);
      console.error(`[youtube-dl] Error errno:`, err.errno);
      reject(err);
    });
  });
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
 * Optimized YouTube-DL manager with caching
 */
class YtDlpManager {
  static instance = null;
  static initialized = false;
  static cache = new YtDlpCache();

  static async initialize() {
    if (this.initialized) return;

    try {
      const platform = process.platform;
      const binName = platform === 'win32' ? 'youtube-dl.exe' : 'youtube-dl';

      // Look for bundled binary in multiple possible locations
      // Use the same approach as BASS DLL loading - relative paths first
      const bundledPaths = [
        // Relative paths (same as BASS approach)
        binName,
        path.join('.', binName),
        path.join('.', 'bin', binName),
        path.join('bin', binName),
        // Tauri production paths
        path.join(process.resourcesPath || '', 'bin', binName),
        path.join(process.resourcesPath || '', binName),
        // Development/fallback paths
        path.join(__dirname, '..', '..', 'bin', binName),
        path.join(__dirname, '..', '..', 'src-tauri', 'bin', binName),
        // Relative to executable
        path.join(path.dirname(process.execPath), 'bin', binName),
        path.join(path.dirname(process.execPath), binName)
      ];

      console.log('[youtube-dl] Looking for binary on platform:', platform);
      console.log('[youtube-dl] Binary name:', binName);
      console.log('[youtube-dl] process.resourcesPath:', process.resourcesPath);
      console.log('[youtube-dl] process.execPath:', process.execPath);
      console.log('[youtube-dl] os.homedir():', os.homedir());
      console.log('[youtube-dl] __dirname:', __dirname);

      for (const binPath of bundledPaths) {
        const exists = fs.existsSync(binPath);
        console.log(`[youtube-dl] Checking path: ${binPath} - ${exists ? 'EXISTS' : 'NOT FOUND'}`);
        
        if (exists) {
          // On Unix-like systems, ensure the binary is executable
          if (platform !== 'win32') {
            try {
              fs.chmodSync(binPath, '755');
              console.log('[youtube-dl] Set execute permissions for:', binPath);
            } catch (e) {
              console.warn('[youtube-dl] Failed to set execute permissions:', e.message);
            }
          }

          youtubeDlPath = binPath;
          youtubeDlAvailable = true;
          console.log('[youtube-dl] ✅ Using bundled binary:', binPath);
          break;
        }
      }

      if (!youtubeDlAvailable) {
        console.warn('[youtube-dl] Bundled binary not found in any expected location');
        console.warn('[youtube-dl] This may cause YouTube functionality to fail');
        console.warn('[youtube-dl] Checked paths:', bundledPaths);
      }

      this.initialized = true;
      console.log('[youtube-dl] Manager initialized successfully');
    } catch (e) {
      console.error('[youtube-dl] Failed to initialize:', e.message);
    }
  }

  static getInstance() {
    if (!this.instance) {
      this.instance = new YtDlpManager();
    }
    return this.instance;
  }

  static getCapabilityInfo() {
    return {
      loaded: youtubeDlAvailable,
      binaryPath: youtubeDlPath
    };
  }

  async getVideoInfo(target, formatPreference = '140') {
    const cacheKey = YtDlpManager.cache.generateCacheKey(target, formatPreference);
    
    // Check cache first
    const cached = await YtDlpManager.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Check for inflight request to prevent duplicate processes
    const inflightPromise = YtDlpManager.cache.inflightRequests.get(cacheKey);
    if (inflightPromise) {
      console.log('[youtube-dl] Deduplicating request for:', target);
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
    if (!youtubeDlAvailable) {
      throw new Error('youtube-dl not available');
    }

    console.log('[youtube-dl] Executing request for:', target);

    // Extract video ID from URL if needed
    let videoId = target;
    if (target.includes('youtube.com') || target.includes('youtu.be')) {
      const urlMatch = target.match(/[?&]v=([^?&]+)/) || target.match(/youtu\.be\/([^?&]+)/);
      if (urlMatch) {
        videoId = urlMatch[1];
      }
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Convert yt-dlp style format selectors to youtube-dl format IDs
    let youtubeDlFormat = formatPreference;
    if (formatPreference.includes('bestaudio')) {
      // Convert yt-dlp bestaudio selectors to youtube-dl format IDs
      if (formatPreference.includes('ext=m4a') || formatPreference.includes('m4a')) {
        youtubeDlFormat = '140'; // M4A audio format
      } else if (formatPreference.includes('ext=webm') || formatPreference.includes('webm')) {
        youtubeDlFormat = '251'; // WebM audio format
      } else {
        youtubeDlFormat = '140'; // Default to M4A
      }
    }

    // First, get basic metadata using --dump-json flag
    const jsonArgs = [
      '--dump-json',
      '-f', youtubeDlFormat,
      videoUrl,
      '--user-agent', YOUTUBE_USER_AGENT
    ];

    const { SERVER_CONSTANTS } = require('../config/constants');
    const INFO_TIMEOUT = SERVER_CONSTANTS.TIMEOUTS.YTDLP_INFO || 30000;

    try {
      console.log('[youtube-dl] Getting metadata for:', videoId);
      const jsonResult = await Promise.race([
        executeYoutubeDl(jsonArgs),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('youtube-dl-json-timeout')), INFO_TIMEOUT)
        )
      ]);

      let metadata = {};
      try {
        metadata = JSON.parse(jsonResult);
      } catch (parseErr) {
        console.warn('[youtube-dl] Failed to parse JSON metadata:', parseErr.message);
        // Continue with basic info
      }

      // Then get the direct URL
      const urlArgs = [
        '-f', youtubeDlFormat,
        videoUrl,
        '--user-agent', YOUTUBE_USER_AGENT,
        '-g'  // Get URL only
      ];

      console.log('[youtube-dl] Getting direct URL for:', videoId);
      const urlResult = await Promise.race([
        executeYoutubeDl(urlArgs),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('youtube-dl-url-timeout')), INFO_TIMEOUT)
        )
      ]);

      const directUrl = urlResult.trim();
      
      // Create a more complete info object compatible with the route expectations
      return {
        id: videoId,
        url: videoUrl,
        directUrl: directUrl,
        format: youtubeDlFormat, // Use the converted format
        extractor: 'youtube',
        _type: 'video',
        // Add metadata from JSON dump
        title: metadata.title || null,
        duration: metadata.duration || null,
        uploader: metadata.uploader || null,
        uploader_id: metadata.uploader_id || null,
        view_count: metadata.view_count || null,
        like_count: metadata.like_count || null,
        upload_date: metadata.upload_date || null,
        // Create a formats array for compatibility
        formats: [{
          url: directUrl,
          format_id: youtubeDlFormat, // Use the converted format
          ext: 'm4a',
          acodec: 'aac',
          vcodec: 'none',
          abr: 128,
          filesize: metadata.filesize || null,
          format_note: 'DASH audio',
          quality: 128,
          requested: true
        }]
      };

    } catch (e) {
      console.error('[youtube-dl] Request failed:', e.message);
      throw new Error(`Failed to get video info: ${e.message}`);
    }
  }

  async searchVideos(query, limit = 5) {
    // YouTube-DL doesn't support search functionality
    // This would require implementing search through YouTube's web interface
    console.warn('[youtube-dl] Search not supported with youtube-dl binary');
    return [];
  }

  async _executeSearchRequest(query, limit, cacheKey) {
    // Not implemented for youtube-dl
    return [];
  }

  pickAudioFormat(info) {
    // Check if we have a formats array (compatibility mode)
    if (info && Array.isArray(info.formats)) {
      // Find the best audio format
      const audioFormats = info.formats.filter(f => f && f.acodec && f.acodec !== 'none');
      
      // Prefer formats with URLs
      const withUrl = audioFormats.filter(f => f.url);
      if (withUrl.length > 0) {
        // Return the first format with a URL (they're already sorted by preference)
        return withUrl[0];
      }
      
      // Fallback to any audio format
      if (audioFormats.length > 0) {
        return audioFormats[0];
      }
    }

    // Fallback to direct URL mode (original implementation)
    if (!info || !info.directUrl) return null;

    // Return a simplified format object
    return {
      url: info.directUrl,
      format_id: info.format || '140',
      ext: 'm4a', // Format 140 is typically m4a
      acodec: 'aac',
      vcodec: 'none',
      abr: 128, // Approximate bitrate for format 140
      filesize: null,
      format_note: 'DASH audio',
      quality: 128
    };
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

// Initialize the manager
YtDlpManager.initialize().catch(e => {
  console.error('[youtube-dl] Initialization failed:', e.message);
});

module.exports = YtDlpManager;
