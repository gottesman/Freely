const express = require('express');
const TorrentFilesManager = require('../managers/TorrentFilesManager');
const { booleanParam } = require('../utils');

const router = express.Router();

// Initialize the torrent files manager
const torrentFilesManager = new TorrentFilesManager();

/**
 * Get files for a torrent
 * GET /api/torrent-files/:id?timeout=20000&force=false
 */
router.get('/torrent-files/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const timeout = parseInt(req.query.timeout || '20000', 10);
    const forceRefresh = booleanParam(req.query.force || req.query.f);

    if (!id) {
      return res.status(400).json({
        error: 'missing_id',
        message: 'Torrent ID is required'
      });
    }

    console.log(`[TorrentFiles] Getting files for ${id} (timeout: ${timeout}, force: ${forceRefresh})`);

    const files = await torrentFilesManager.getTorrentFiles(id, {
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
    console.error('[TorrentFiles] Error getting files:', error.message);
    
    res.status(500).json({
      error: 'fetch_failed',
      message: error.message,
      id: req.params.id
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
      const result = torrentFilesManager.clearCacheForId(id);
      res.json({
        success: true,
        ...result
      });
    } else {
      // Clear entire cache
      const result = torrentFilesManager.clearCache();
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
    const stats = torrentFilesManager.getCacheStats();
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
