const express = require('express');
const multer = require('multer');
const path = require('path');
const TorrentManager = require('../managers/TorrentManager');
const { SERVER_CONSTANTS } = require('../config/constants');

const router = express.Router();
const torrentManager = TorrentManager.getInstance();

// Setup multer for file uploads
const upload = multer({ 
  dest: path.join(__dirname, '..', 'data'),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

/**
 * Seed a torrent from file upload
 * POST /seed
 */
router.post('/seed', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'file required'
      });
    }

    const filePath = req.file.path;
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const originalName = req.file.originalname || req.file.filename;
    
    console.log('[TorrentRoutes] Seeding file at', filePath, 'mime:', mimeType);

    const torrent = await torrentManager.seedFile(filePath, {
      mimeType,
      name: originalName
    });

    res.json({
      success: true,
      data: {
        infoHash: torrent.infoHash,
        magnetURI: torrent.magnetURI,
        streamUrl: `/stream/${torrent.infoHash}/0`,
        mimeType,
        name: originalName,
        files: torrent.files.map(file => ({
          name: file.name,
          length: file.length,
          path: file.path
        }))
      }
    });

  } catch (error) {
    console.error('[TorrentRoutes] Seeding error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to seed torrent'
    });
  }
});

/**
 * Add torrent from magnet URI
 * POST /add-torrent
 */
router.post('/add-torrent', async (req, res) => {
  try {
    const { magnetURI, name } = req.body;

    if (!magnetURI) {
      return res.status(400).json({
        success: false,
        error: 'magnetURI is required'
      });
    }

    const torrent = await torrentManager.addTorrent(magnetURI, 'application/octet-stream', name);
    
    res.json({
      success: true,
      data: {
        infoHash: torrent.infoHash,
        magnetURI: torrent.magnetURI,
        name: torrent.name,
        length: torrent.length,
        files: torrent.files.map(file => ({
          name: file.name,
          length: file.length,
          path: file.path
        }))
      }
    });

  } catch (error) {
    console.error('[TorrentRoutes] Add torrent error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to add torrent'
    });
  }
});

/**
 * Stream torrent file
 * GET /stream/:infoHash/:fileIndex
 */
router.get('/stream/:infoHash/:fileIndex?', async (req, res) => {
  try {
    const { infoHash, fileIndex = '0' } = req.params;
    const range = req.headers.range;

    const torrent = torrentManager.getTorrent(infoHash);
    if (!torrent) {
      return res.status(404).json({
        success: false,
        error: 'Torrent not found'
      });
    }

    // Wait for torrent to be ready
    await new Promise((resolve) => {
      if (torrent.ready) return resolve();
      torrent.on('ready', resolve);
    });

    const fileIdx = parseInt(fileIndex, 10);
    const file = torrent.files[fileIdx];
    if (!file) {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    const total = file.length;
    const torrentData = torrentManager.getTorrentData(infoHash);
    const mimeType = torrentData?.mimeType || 'application/octet-stream';
    
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType
      });

      const stream = file.createReadStream({ start, end });
      stream.pipe(res);
      
      res.on('close', () => {
        try { stream.destroy(); } catch (e) { }
      });
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });

      const stream = file.createReadStream();
      stream.pipe(res);
      
      res.on('close', () => {
        try { stream.destroy(); } catch (e) { }
      });
    }

  } catch (error) {
    console.error('[TorrentRoutes] Streaming error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to stream torrent'
    });
  }
});

/**
 * Get torrent status
 * GET /status/:infoHash
 */
router.get('/status/:infoHash', (req, res) => {
  try {
    const { infoHash } = req.params;

    const status = torrentManager.getStatus(infoHash);
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Torrent not found'
      });
    }

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    console.error('[TorrentRoutes] Status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get torrent status'
    });
  }
});

/**
 * Get all torrents
 * GET /torrents
 */
router.get('/torrents', (req, res) => {
  try {
    const torrents = torrentManager.getAllTorrents();

    res.json({
      success: true,
      data: torrents,
      count: torrents.length
    });

  } catch (error) {
    console.error('[TorrentRoutes] List torrents error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list torrents'
    });
  }
});

/**
 * Remove torrent
 * DELETE /torrent/:infoHash
 */
router.delete('/torrent/:infoHash', (req, res) => {
  try {
    const { infoHash } = req.params;
    const { destroyStore = false } = req.query;

    const removed = torrentManager.removeTorrent(infoHash, destroyStore === 'true');
    
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: 'Torrent not found'
      });
    }

    res.json({
      success: true,
      message: 'Torrent removed successfully'
    });

  } catch (error) {
    console.error('[TorrentRoutes] Removal error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to remove torrent'
    });
  }
});

module.exports = router;
