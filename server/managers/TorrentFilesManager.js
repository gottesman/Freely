/**
 * Torrent Files Manager - Handles torrent file listing with caching and client reuse
 */
const fs = require('fs');
const path = require('path');
const { createWebTorrentClient } = require('../utils/webtorrent-loader');

// Note: previously had a sanitizePath helper here; it was unused, so removed to avoid dead code.

class TorrentFilesManager {
  constructor(dataDir = null) {
    this.dataDir = dataDir || path.join(__dirname, '..', 'data');
    this.cacheFile = path.join(this.dataDir, 'torrent-files-cache.json');
    this.cacheTTL = 24 * 60 * 60 * 1000; // 24 hours
    this.client = null;
    this.ensureDataDir();
  }

  // Provide a shared singleton instance so routes/managers use a single cache and client
  static getInstance() {
    if (!this._instance) {
      this._instance = new TorrentFilesManager();
    }
    return this._instance;
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
   * Get or create WebTorrent client
   */
  async getClient() {
    if (!this.client) {
      this.client = await createWebTorrentClient({ 
        destroyStoreOnDestroy: true,
        // Use memory store to avoid filesystem path issues  
        store: require('memory-chunk-store')
      });
    }
    return this.client;
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
      timeout = 30000, // Increased timeout to 30 seconds
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
   * Fetch torrent files using shared WebTorrent client
   */
  async fetchTorrentFiles(id, timeout) {
    return new Promise(async (resolve, reject) => {
      const client = await this.getClient();
      let timedOut = false;
      // Predeclare handler references to avoid TDZ in cleanup when timeouts/errors fire early
      let onClientError = null;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Timeout after ${timeout}ms`));
      }, timeout);

      const cleanup = (callback) => {
        clearTimeout(timeoutId);
        // Don't destroy the shared client, just remove the torrent
        if (!timedOut && torrent) {
          torrent.destroy();
        }
        // Detach the client error handler if it was attached
        try {
          if (client && typeof onClientError === 'function') client.off('error', onClientError);
        } catch (_) {}
        if (callback) callback();
      };

      let torrent;

      try {
        // Check if torrent is already in the client
        const existingTorrent = client.torrents.find(t => 
          t.infoHash === id || 
          t.magnetURI === id || 
          (t.infoHash && id.includes(t.infoHash.toLowerCase())) ||
          (typeof id === 'string' && id.startsWith('magnet:') && id.toLowerCase().includes(t.infoHash.toLowerCase()))
        );

        if (existingTorrent) {
          // Use existing torrent
          console.log(`[TorrentFilesManager] Using existing torrent ${existingTorrent.infoHash}`);
          torrent = existingTorrent;
          
          if (torrent.files && torrent.files.length > 0) {
            const files = torrent.files.map(f => ({
              name: f.name,
              length: f.length,
              path: f.path || f.name
            }));

            cleanup(() => {
              resolve(files);
            });
            return;
          }
          
          // If torrent exists but no files yet, wait for metadata
          if (!torrent.ready) {
            const readyTimeout = setTimeout(() => {
              if (!timedOut) {
                cleanup(() => {
                  reject(new Error('Torrent metadata timeout'));
                });
              }
            }, timeout / 2); // Use half the total timeout for metadata
            
            torrent.on('ready', () => {
              if (timedOut) return;
              clearTimeout(readyTimeout);
              
              const files = (torrent.files || []).map(f => ({
                name: f.name,
                length: f.length,
                path: f.path || f.name
              }));

              cleanup(() => {
                resolve(files);
              });
            });
            return;
          }
        }

        // Add new torrent with better error handling
        client.add(id, { destroyStoreOnDestroy: true }, (t) => {
          if (timedOut) return;

          torrent = t;
          console.log(`[TorrentFilesManager] Successfully added torrent ${torrent.infoHash}`);
          
          // Function to configure selective download and get files
          const processFiles = () => {
            if (torrent.files && torrent.files.length > 0) {
              console.log(`[TorrentFilesManager] Deselecting all ${torrent.files.length} files in newly added torrent`);
              torrent.files.forEach((file, index) => {
                if (file.deselect) {
                  file.deselect();
                  console.log(`[TorrentFilesManager] Deselected file ${index}: ${file.name}`);
                }
              });
              
              // Verify deselection
              const selectedFiles = torrent.files.filter(f => f.selected !== false);
              console.log(`[TorrentFilesManager] Files deselected, ${selectedFiles.length} still selected (should be 0)`);
            }
            
            const files = (torrent.files || []).map(f => ({
              name: f.name,
              length: f.length,
              path: f.path || f.name
            }));

            cleanup(() => {
              resolve(files);
            });
          };
          
          // Process files immediately if ready, otherwise wait
          if (torrent.ready) {
            processFiles();
          } else {
            const readyTimeout = setTimeout(() => {
              if (!timedOut) {
                cleanup(() => {
                  reject(new Error('Torrent ready timeout'));
                });
              }
            }, timeout / 2);
            
            torrent.on('ready', () => {
              if (timedOut) return;
              clearTimeout(readyTimeout);
              console.log(`[TorrentFilesManager] Torrent ${torrent.infoHash} is ready`);
              processFiles();
            });
          }
        });

        // Use a detachable error handler and remove it on cleanup to avoid accumulating listeners
        onClientError = (error) => {
          if (!timedOut) {
            console.error(`[TorrentFilesManager] WebTorrent client error:`, error.message);
            // Check if it's a duplicate torrent error
            if (error.message && error.message.includes('duplicate torrent')) {
              // Try to find the existing torrent and use it
              const hashMatch = error.message.match(/([a-fA-F0-9]{40})/);
              if (hashMatch) {
                const hash = hashMatch[1];
                const existing = client.torrents.find(t => t.infoHash.toLowerCase() === hash.toLowerCase());
                if (existing) {
                  console.log(`[TorrentFilesManager] Found existing torrent for duplicate error, using it`);
                  torrent = existing;
                  const files = (torrent.files || []).map(f => ({
                    name: f.name,
                    length: f.length,
                    path: f.path || f.name
                  }));
                  cleanup(() => resolve(files));
                  return;
                }
              }
            }
            cleanup(() => {
              reject(new Error(`WebTorrent error: ${error.message}`));
            });
          }
        };
        client.on('error', onClientError);

      } catch (error) {
        cleanup(() => {
          reject(new Error(`Failed to add torrent: ${error.message}`));
        });
      }
    });
  }

  /**
   * Get a single file length for a torrent id with cache-first strategy.
   * Returns 0 if not determinable within the timeout.
   */
  async getFileLength(id, fileIndex, options = {}) {
    try {
      const idx = Number(fileIndex) || 0;
      const cached = this.getCachedFiles(id);
      if (Array.isArray(cached) && cached[idx] && typeof cached[idx].length === 'number') {
        return Number(cached[idx].length) || 0;
      }

      const { timeout = 5000, forceRefresh = false } = options;
      const files = await this.getTorrentFiles(id, { timeout, forceRefresh });
      if (Array.isArray(files) && files[idx] && typeof files[idx].length === 'number') {
        return Number(files[idx].length) || 0;
      }
    } catch (_) {
      // swallow and return 0
    }
    return 0;
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

  /**
   * Destroy the client and cleanup
   */
  destroy() {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }
}

module.exports = TorrentFilesManager;
