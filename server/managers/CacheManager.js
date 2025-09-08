const { SERVER_CONSTANTS } = require('../config/constants');

/**
 * Enhanced caching system with TTL and LRU eviction
 */
class CacheManager {
  constructor() {
    this.infoCache = new Map();
    this.maxEntries = SERVER_CONSTANTS.CACHE.MAX_INFO_ENTRIES;
    this.ttl = SERVER_CONSTANTS.CACHE.INFO_TTL_MS;
  }

  get(key) {
    const entry = this.infoCache.get(key);
    if (!entry) return null;
    
    if (Date.now() - entry.ts > this.ttl) {
      this.infoCache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    // Simple LRU eviction
    if (this.infoCache.size >= this.maxEntries) {
      const oldestKey = this.infoCache.keys().next().value;
      this.infoCache.delete(oldestKey);
    }
    
    this.infoCache.set(key, {
      ts: Date.now(),
      value: value
    });
  }

  clear() {
    this.infoCache.clear();
  }

  size() {
    return this.infoCache.size;
  }
}

module.exports = CacheManager;
