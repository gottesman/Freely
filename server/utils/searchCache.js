const fs = require('fs');
const path = require('path');

// Search cache subsystem (disk-persisted when enabled)
const SEARCH_CACHE_TTL_SECONDS = parseInt(process.env.TORRENT_SEARCH_CACHE_TTL_SECONDS || '86400', 10);

let _cacheMap = null; // Map instance
let _cacheFile = null;
let _cacheEnabled = false;
let _saveTimer = null;

/**
 * Initialize disk-backed search cache
 */
function initSearchCache(dir, filename = 'search-cache.json', enabledFlag = process.env.SEARCH_CACHE_ENABLED) {
  _cacheEnabled = ['1','true','yes','on'].includes(String(enabledFlag || '').toLowerCase());
  _cacheFile = path.join(dir, filename);
  _cacheMap = new Map();
  
  if (!_cacheEnabled) return; // in-memory only when disabled
  
  try {
    if (!fs.existsSync(_cacheFile)) return;
    const raw = fs.readFileSync(_cacheFile, 'utf8');
    if (!raw) return;
    
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (!entry || !entry.ts) continue;
      if ((now - entry.ts) < SEARCH_CACHE_TTL_SECONDS * 1000) {
        _cacheMap.set(key, entry);
      }
    }
    console.log(`[SearchCache] Loaded ${_cacheMap.size} entries from disk`);
  } catch (e) {
    console.warn('[SearchCache] load failed', e && e.message ? e.message : e);
  }
}

/**
 * Schedule cache persistence to disk
 */
function schedulePersist() {
  if (!_cacheEnabled) return;
  if (_saveTimer) return;
  
  _saveTimer = setTimeout(() => {
    (async () => {
      try {
        const serial = JSON.stringify(Array.from(_cacheMap.entries()));
        await fs.promises.writeFile(_cacheFile, serial, { encoding: 'utf8' });
      } catch (e) {
        console.warn('[SearchCache] persist failed', e && e.message ? e.message : e);
      } finally {
        _saveTimer = null;
      }
    })();
  }, 750);
}

/**
 * Persist search cache synchronously
 */
function persistSearchCacheSync() {
  if (!_cacheEnabled) return;
  
  try {
    const serial = JSON.stringify(Array.from(_cacheMap.entries()));
    fs.writeFileSync(_cacheFile, serial, { encoding: 'utf8' });
  } catch (e) {
    console.warn('[SearchCache] sync persist failed', e && e.message ? e.message : e);
  }
}

/**
 * Get search cache entry
 */
function getSearchCacheEntry(key) {
  return _cacheMap.get(key);
}

/**
 * Set search cache entry
 */
function setSearchCacheEntry(key, value) {
  _cacheMap.set(key, value);
  schedulePersist();
}

/**
 * Delete search cache entry
 */
function deleteSearchCacheEntry(key) {
  const existed = _cacheMap.delete(key);
  if (existed) schedulePersist();
  return existed;
}

/**
 * Clear entire search cache
 */
function clearSearchCache() {
  _cacheMap.clear();
  if (_cacheEnabled) {
    try { 
      if (fs.existsSync(_cacheFile)) fs.unlinkSync(_cacheFile); 
    } catch (_) { }
  }
}

module.exports = {
  initSearchCache,
  getSearchCacheEntry,
  setSearchCacheEntry,
  deleteSearchCacheEntry,
  clearSearchCache,
  persistSearchCacheSync,
  schedulePersist,
  SEARCH_CACHE_TTL_SECONDS
};
