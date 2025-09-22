/**
 * WebTorrent ESM loader utility
 * This module provides a clean interface for loading WebTorrent in a CommonJS environment
 */

let WebTorrentClass = null;
let loadPromise = null;
let loadError = null;
let nativeSupport = {
  utp: false,
  webrtc: false
};

/**
 * Load WebTorrent class asynchronously with fallback handling
 * @returns {Promise<WebTorrent>} The WebTorrent constructor
 */
async function loadWebTorrent() {
  if (WebTorrentClass) {
    return WebTorrentClass;
  }

  if (loadError) {
    throw loadError;
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

      // Probe for native optional deps (best-effort, don't crash)
      try {
        require.resolve('utp-native');
        nativeSupport.utp = true;
      } catch (_) { nativeSupport.utp = false; }
      try {
        require.resolve('node-datachannel');
        nativeSupport.webrtc = true;
      } catch (_) { nativeSupport.webrtc = false; }
  console.log('[WebTorrent] Native capability:', nativeSupport);
      return WebTorrentClass;
    } catch (error) {
      console.error('[WebTorrent] Failed to load WebTorrent:', error);
      
      // Check if it's a native dependency error
      if (error.message.includes('utp-native') || 
          error.message.includes('node-datachannel') ||
          error.code === 'ERR_DLOPEN_FAILED' ||
          error.code === 'MODULE_NOT_FOUND') {
        console.warn('[WebTorrent] Native dependency error detected, WebTorrent features will be limited');
        loadError = new Error('WebTorrent native dependencies not available');
      } else {
        loadError = error;
      }
      
      loadPromise = null; // Reset so we can retry
      throw loadError;
    }
  })();

  return loadPromise;
}

/**
 * Create a new WebTorrent client instance with error handling
 * @param {Object} options - WebTorrent options
 * @returns {Promise<WebTorrent>} WebTorrent client instance
 */
async function createWebTorrentClient(options = {}) {
  try {
    // Ensure utp-native is resolvable in packaged apps via shim
    try { require.resolve('utp-native'); } catch (_) {
      try { require('./shims/utp-native'); } catch (_) {}
    }
    const WebTorrent = await loadWebTorrent();
    
    // Sensible defaults; enable features when native deps are present
    const safeOptions = {
      utp: nativeSupport.utp,           // enable uTP only if utp-native is resolvable
      webSeeds: true,                   // web seeds don't require native deps
      tracker: {
        // Prefer UDP if utp available; WebRTC is disabled unless node-datachannel exists
        rtcConfig: nativeSupport.webrtc ? {} : false,
        getAnnounceOpts: () => ({ numwant: 50, compact: 1 })
      },
      ...options
    };
    
    console.log('[WebTorrent] Creating client with safe options:', {
      utp: safeOptions.utp,
      webSeeds: safeOptions.webSeeds,
      webrtc: !!(safeOptions.tracker && safeOptions.tracker.rtcConfig !== false)
    });
    
    return new WebTorrent(safeOptions);
  } catch (error) {
    console.error('[WebTorrent] Failed to create WebTorrent client:', error.message);
    throw error;
  }
}

/**
 * Check if WebTorrent is available
 * @returns {Promise<boolean>} Whether WebTorrent can be loaded
 */
async function isWebTorrentAvailable() {
  try {
    await loadWebTorrent();
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  loadWebTorrent,
  createWebTorrentClient,
  isWebTorrentAvailable,
  // Diagnostics helper for routes/tests
  getWebTorrentDiagnostics: () => ({
    loaded: !!WebTorrentClass,
    loadError: loadError ? String(loadError && loadError.message || loadError) : null,
    nativeSupport: { ...nativeSupport }
  })
};