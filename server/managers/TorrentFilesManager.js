/**
 * Torrent Files Manager - Handles torrent file listing with caching
 */
const WebTorrent = require('webtorrent');
const fs = require('fs');
const path = require('path');

class TorrentFilesManager {
  constructor(dataDir = null) {
    this.dataDir = dataDir || path.join(__dirname, '..', 'data');
    this.cacheFile = path.join(this.dataDir, 'torrent-files-cache.json');
    this.cacheTTL = 24 * 60 * 60 * 1000; // 24 hours
    this.ensureDataDir();
  }

  /**
   * Ensure data directory exists
   */
  ensureDataDir() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch (error) {
      console.warn('[TorrentFilesManager] Could not create data directory:', error.message);
    }
  }

  /**
   * Read cache from disk
   */
  readCache() {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return {};
      }
      
      const raw = fs.readFileSync(this.cacheFile, 'utf8');
      return JSON.parse(raw || '{}');
    } catch (error) {
      console.warn('[TorrentFilesManager] Cache read error:', error.message);
      return {};
    }
  }

  /**
   * Write cache to disk
   */
  writeCache(cache) {
    try {
      // Atomic write using temp file
      const tempFile = this.cacheFile + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2));
      
      try {
        fs.renameSync(tempFile, this.cacheFile);
      } catch (renameError) {
        // Fallback to direct write
        fs.writeFileSync(this.cacheFile, JSON.stringify(cache, null, 2));
      }
    } catch (error) {
      console.warn('[TorrentFilesManager] Cache write error:', error.message);
    }
  }

  /**
   * Get torrent files with caching
   */
  async getTorrentFiles(id, options = {}) {
    const { 
      timeout = 20000, 
      forceRefresh = false 
    } = options;

    if (!id || typeof id !== 'string') {
      throw new Error('Invalid torrent ID provided');
    }

    // Check cache first (unless forced refresh)
    if (!forceRefresh) {
      const cached = this.getCachedFiles(id);
      if (cached) {
        return cached;
      }
    }

    // Fetch from torrent
    const files = await this.fetchTorrentFiles(id, timeout);
    
    // Cache the results
    this.cacheFiles(id, files);
    
    return files;
  }

  /**
   * Get cached files if valid
   */
  getCachedFiles(id) {
    try {
      const cache = this.readCache();
      const entry = cache[id];
      
      if (!entry || typeof entry.ts !== 'number' || !Array.isArray(entry.files)) {
        return null;
      }

      const now = Date.now();
      if ((now - entry.ts) >= this.cacheTTL) {
        return null; // Expired
      }

      return entry.files;
    } catch (error) {
      console.warn('[TorrentFilesManager] Cache check error:', error.message);
      return null;
    }
  }

  /**
   * Cache files for a torrent ID
   */
  cacheFiles(id, files) {
    try {
      const cache = this.readCache();
      cache[id] = {
        ts: Date.now(),
        files: files
      };
      this.writeCache(cache);
    } catch (error) {
      console.warn('[TorrentFilesManager] Failed to cache files:', error.message);
    }
  }

  /**
   * Fetch torrent files using WebTorrent
   */
  async fetchTorrentFiles(id, timeout) {
    return new Promise((resolve, reject) => {
      const client = new WebTorrent();
      let timedOut = false;
      
      const timeoutId = setTimeout(() => {
        timedOut = true;
        client.destroy(() => {
          reject(new Error(`Timeout after ${timeout}ms`));
        });
      }, timeout);

      const cleanup = (callback) => {
        clearTimeout(timeoutId);
        if (!timedOut) {
          client.destroy(callback);
        }
      };

      try {
        client.add(id, { destroyStoreOnDestroy: true }, (torrent) => {
          if (timedOut) return;

          const files = (torrent.files || []).map(f => ({
            name: f.name,
            length: f.length,
            path: f.path
          }));

          cleanup(() => {
            resolve(files);
          });
        });

        client.on('error', (error) => {
          if (!timedOut) {
            cleanup(() => {
              reject(new Error(`WebTorrent error: ${error.message}`));
            });
          }
        });

      } catch (error) {
        cleanup(() => {
          reject(new Error(`Failed to add torrent: ${error.message}`));
        });
      }
    });
  }

  /**
   * Clear entire cache
   */
  clearCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        fs.unlinkSync(this.cacheFile);
        return { cleared: true };
      } else {
        return { cleared: false, reason: 'no-cache-file' };
      }
    } catch (error) {
      throw new Error(`Failed to clear cache: ${error.message}`);
    }
  }

  /**
   * Clear cache for specific torrent ID
   */
  clearCacheForId(id) {
    try {
      const cache = this.readCache();
      
      if (cache[id]) {
        delete cache[id];
        this.writeCache(cache);
        return { cleared: true, id };
      } else {
        return { cleared: false, id, reason: 'not-found' };
      }
    } catch (error) {
      throw new Error(`Failed to clear cache for ID ${id}: ${error.message}`);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    try {
      const cache = this.readCache();
      const entries = Object.keys(cache);
      const now = Date.now();
      
      let validEntries = 0;
      let expiredEntries = 0;
      
      for (const id of entries) {
        const entry = cache[id];
        if (entry && typeof entry.ts === 'number') {
          if ((now - entry.ts) < this.cacheTTL) {
            validEntries++;
          } else {
            expiredEntries++;
          }
        }
      }

      return {
        totalEntries: entries.length,
        validEntries,
        expiredEntries,
        cacheFile: this.cacheFile,
        cacheTTL: this.cacheTTL
      };
    } catch (error) {
      return {
        error: error.message,
        totalEntries: 0,
        validEntries: 0,
        expiredEntries: 0
      };
    }
  }
}

module.exports = TorrentFilesManager;
