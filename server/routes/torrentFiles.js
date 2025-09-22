const express = require('express');
const TorrentFilesManager = require('../managers/TorrentFilesManager');
const { booleanParam } = require('../utils');

const router = express.Router();

// Initialize the torrent files manager
const TorrentFilesManagerSingleton = TorrentFilesManager.getInstance();

/**
 * Get files for a torrent
 * GET /api/torrent-files/:id?timeout=20000&force=false
 */
router.get('/torrent-files/:id', async (req, res) => {
  try {
    let { id } = req.params;
    const timeout = parseInt(req.query.timeout || '20000', 10);
    const forceRefresh = booleanParam(req.query.force || req.query.f);
    // Accept magnet passed via query (?magnet= or ?id=) and decode percent-encoding
    const qMagnet = req.query.magnet || req.query.id;
    if (qMagnet && typeof qMagnet === 'string') {
      try { id = decodeURIComponent(qMagnet); } catch (_) { id = qMagnet; }
    } else if (id && id.toLowerCase().startsWith('magnet')) {
      // Some clients request /torrent-files/magnet:?xt=... where Express splits at '?'
      // Recover the full magnet from originalUrl if needed
      if (!id.startsWith('magnet:?')) {
        const idx = req.originalUrl.indexOf('magnet:');
        if (idx >= 0) {
          const magnet = req.originalUrl.substring(idx);
          try { id = decodeURIComponent(magnet); } catch (_) { id = magnet; }
        }
      }
    }

    if (!id) {
      return res.status(400).json({
        error: 'missing_id',
        message: 'Torrent ID is required'
      });
    }

  // Keep the effective ID for error responses/logging
  req._effectiveTorrentId = id;

    console.log(`[TorrentFiles] Getting files for ${id} (timeout: ${timeout}, force: ${forceRefresh})`);

    const files = await TorrentFilesManagerSingleton.getTorrentFiles(id, {
      timeout,
      forceRefresh
    });

    res.json({
      success: true,
      id,
      files,
      cached: !forceRefresh
    });

  } catch (error) {
    const msg = String(error && error.message || error || 'Unknown error');
    console.error('[TorrentFiles] Error getting files:', msg);

    // Handle invalid magnet/id format explicitly
    if (/invalid torrent identifier/i.test(msg)) {
      return res.status(400).json({
        error: 'invalid_id',
        message: msg,
        id: req._effectiveTorrentId || req.params.id
      });
    }

    // Gracefully signal service unavailability for missing native dependency issues
    if (/native dependenc/i.test(msg)) {
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'WebTorrent is not available on this system',
        details: msg,
        id: req._effectiveTorrentId || req.params.id
      });
    }

    res.status(500).json({
      error: 'fetch_failed',
      message: msg,
      id: req._effectiveTorrentId || req.params.id
    });
  }
});

/**
 * Clear torrent files cache
 * DELETE /api/torrent-files/cache
 * DELETE /api/torrent-files/cache/:id
 */
router.delete('/torrent-files/cache/:id?', async (req, res) => {
  try {
    const { id } = req.params;

    if (id) {
      // Clear specific ID
  const result = TorrentFilesManagerSingleton.clearCacheForId(id);
      res.json({
        success: true,
        ...result
      });
    } else {
      // Clear entire cache
  const result = TorrentFilesManagerSingleton.clearCache();
      res.json({
        success: true,
        ...result
      });
    }

  } catch (error) {
    console.error('[TorrentFiles] Error clearing cache:', error.message);
    
    res.status(500).json({
      error: 'clear_failed',
      message: error.message
    });
  }
});

/**
 * Get cache statistics
 * GET /api/torrent-files/cache/stats
 */
router.get('/torrent-files/cache/stats', (req, res) => {
  try {
  const stats = TorrentFilesManagerSingleton.getCacheStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[TorrentFiles] Error getting cache stats:', error.message);
    
    res.status(500).json({
      error: 'stats_failed',
      message: error.message
    });
  }
});

module.exports = router;
