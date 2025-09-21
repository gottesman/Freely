/**
 * WebTorrent ESM loader utility
 * This module provides a clean interface for loading WebTorrent in a CommonJS environment
 */

let WebTorrentClass = null;
let loadPromise = null;

/**
 * Load WebTorrent class asynchronously
 * @returns {Promise<WebTorrent>} The WebTorrent constructor
 */
async function loadWebTorrent() {
  if (WebTorrentClass) {
    return WebTorrentClass;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    try {
      console.log('[WebTorrent] Loading WebTorrent ESM module...');
      
      // Use static import that webpack can bundle for packaged apps
      const WebTorrentModule = await import('webtorrent');
      
      // Handle different export patterns
      WebTorrentClass = WebTorrentModule.default || WebTorrentModule;
      
      if (typeof WebTorrentClass !== 'function') {
        throw new Error('WebTorrent is not a constructor function');
      }
      
      console.log('[WebTorrent] WebTorrent loaded successfully');
      return WebTorrentClass;
    } catch (error) {
      console.error('[WebTorrent] Failed to load WebTorrent:', error);
      loadPromise = null; // Reset so we can retry
      throw error;
    }
  })();

  return loadPromise;
}

/**
 * Create a new WebTorrent client instance
 * @param {Object} options - WebTorrent options
 * @returns {Promise<WebTorrent>} WebTorrent client instance
 */
async function createWebTorrentClient(options = {}) {
  const WebTorrent = await loadWebTorrent();
  return new WebTorrent(options);
}

module.exports = {
  loadWebTorrent,
  createWebTorrentClient
};