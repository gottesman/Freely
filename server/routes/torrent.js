const express = require('express');
const multer = require('multer');
const path = require('path');
const TorrentManager = require('../managers/TorrentManager');
const TorrentFilesManager = require('../managers/TorrentFilesManager');
const { SERVER_CONSTANTS } = require('../config/constants');

const router = express.Router();
// Get torrent manager instance - it's a singleton so this is safe
const getTorrentManager = () => TorrentManager.getInstance();
// Use TorrentFilesManager singleton for cache/client reuse across routes
const getTorrentFilesManager = () => TorrentFilesManager.getInstance();

// Cache recent magnets by infoHash so /progress can recall without re-sending magnet param
// Also track recently removed torrents ("tombstones") so polling after removal does NOT resurrect them.
const recentMagnets = new Map(); // infoHashLower -> { magnet, ts }
const removedMagnets = new Map(); // infoHashLower -> ts (time of removal)

// How long (ms) a removal tombstone prevents auto re-add (polling) – 10 minutes default
const REMOVAL_TOMBSTONE_MS = 10 * 60 * 1000;

const markRemovedMagnet = (infoHash) => {
  try {
    const key = String(infoHash).toLowerCase();
    recentMagnets.delete(key); // prevent recall
    removedMagnets.set(key, Date.now());
    if (process.env.DEBUG_TORRENT_REMOVAL) {
      console.log('[TorrentRoutes] Marked removed torrent', key);
    }
  } catch (_) {}
};

const wasRemovedRecently = (infoHash) => {
  try {
    const key = String(infoHash).toLowerCase();
    const ts = removedMagnets.get(key);
    if (!ts) return false;
    if ((Date.now() - ts) > REMOVAL_TOMBSTONE_MS) {
      removedMagnets.delete(key);
      return false;
    }
    return true;
  } catch (_) { return false; }
};

const rememberMagnet = (infoHash, magnet) => {
  try {
    if (!infoHash || !magnet) return;
    const key = String(infoHash).toLowerCase();
    recentMagnets.set(key, { magnet, ts: Date.now() });
    // If it was previously removed, clear the tombstone because we are explicitly re-adding
    removedMagnets.delete(key);
  } catch (_) {}
};

const recallMagnet = (infoHash, maxAgeMs = 60 * 60 * 1000) => {
  try {
    const key = String(infoHash).toLowerCase();
    // Do NOT recall if it was removed recently (prevents resurrection through polling)
    if (wasRemovedRecently(key)) return null;
    const entry = recentMagnets.get(key);
    if (!entry) return null;
    if ((Date.now() - entry.ts) > maxAgeMs) {
      recentMagnets.delete(key);
      return null;
    }
    return entry.magnet;
  } catch (_) { return null; }
};

// Setup multer for file uploads
const upload = multer({ 
  dest: path.join(__dirname, '..', 'data'),
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1GB limit
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

    const torrent = await getTorrentManager().seedFile(filePath, {
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

    const manager = getTorrentManager();
    if (!manager.isReady()) {
      return res.status(503).json({
        success: false,
        error: 'WebTorrent is not available on this system',
        details: manager.getStatus()
      });
    }

    const torrent = await manager.addTorrent(magnetURI, { mimeType: 'application/octet-stream', name });
    
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
  // Set request timeout to prevent hanging connections
  req.setTimeout(60000, () => {
    console.log(`[TorrentRoutes] Request timeout for ${req.params.infoHash}/${req.params.fileIndex}`);
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });

  try {
    const { infoHash, fileIndex = '0' } = req.params;
  const { magnet } = req.query; // Allow magnet URI to be passed as query param
    const range = req.headers.range;

    console.log(`[TorrentRoutes] Streaming request for ${infoHash}/${fileIndex}, magnet: ${magnet ? 'provided' : 'not provided'}`);

  const manager = getTorrentManager();
  // Remember magnet for subsequent /progress calls
  try { if (magnet) rememberMagnet(infoHash, magnet); } catch (_) {}
    let torrent = manager.getTorrent(infoHash);
    if (!torrent) {
      // Torrent not found, try to add it
      console.log(`[TorrentRoutes] Torrent ${infoHash} not found, attempting to add`);
      
      if (!manager.isReady()) {
        console.warn('[TorrentRoutes] WebTorrent unavailable, cannot add torrent');
        return res.status(503).json({
          success: false,
          error: 'WebTorrent is not available on this system',
          details: manager.getStatus()
        });
      }

      try {
        // Use provided magnet URI or construct basic one
        const magnetURI = magnet || `magnet:?xt=urn:btih:${infoHash}`;
        console.log(`[TorrentRoutes] Adding torrent with magnet: ${magnetURI.substring(0, 100)}...`);
        
        torrent = await manager.addTorrent(magnetURI, {
          mimeType: 'application/octet-stream',
          name: `torrent-${infoHash}`,
          forceRecreate: false
        });
        console.log(`[TorrentRoutes] Successfully added torrent ${infoHash}, ready: ${torrent.ready}, files: ${torrent.files ? torrent.files.length : 'unknown'}`);
      } catch (addError) {
        console.error(`[TorrentRoutes] Failed to add torrent ${infoHash}:`, addError.message);
        
        // Check if it's a duplicate error - try to get the existing torrent
        if (addError.message.includes('duplicate torrent')) {
          console.log(`[TorrentRoutes] Torrent ${infoHash} already exists, attempting to retrieve it`);
          torrent = manager.getTorrent(infoHash);
          if (!torrent) {
            return res.status(404).json({
              success: false,
              error: 'Torrent exists but could not be retrieved'
            });
          }
        } else {
          return res.status(404).json({
            success: false,
            error: 'Torrent not found and could not be added'
          });
        }
      }
    } else {
      console.log(`[TorrentRoutes] Using existing torrent ${infoHash} (${torrent.files ? torrent.files.length : '?'} files, ${torrent.numPeers || 0} peers)`);
    }
    
    // Wait for torrent to be ready with centralized helper (deduped)
    try {
      await getTorrentManager().waitForTorrentReady(infoHash, 10000);
      console.log(`[TorrentRoutes] Torrent ready: ${torrent.files.length} files`);
    } catch (readyError) {
      console.error(`[TorrentRoutes] Torrent ${infoHash} failed to become ready:`, readyError.message);
      return res.status(504).json({
        success: false,
        error: 'Torrent not ready: ' + readyError.message
      });
    }

    const fileIdx = parseInt(fileIndex, 10);
    const file = torrent.files[fileIdx];
    if (!file) {
      console.error(`[TorrentRoutes] File ${fileIdx} not found (${torrent.files.length} files available)`);
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    console.log(`[TorrentRoutes] Found file at index ${fileIdx}: "${file.name}" (${file.length} bytes)`);
    
    // Check if file is already selected to avoid resetting download progress
    const isAlreadySelected = getTorrentManager().isFileSelected(infoHash, fileIdx);
    console.log(`[TorrentRoutes] File ${fileIdx} already selected: ${isAlreadySelected}`);

    // Safety: if our manager claims selected but WebTorrent shows unselected, force re-selection
    const isActualSelected = file.selected === true;
    if (isAlreadySelected && !isActualSelected && (file.downloaded || 0) < (file.length || Infinity)) {
      console.warn(`[TorrentRoutes] Manager reports selected but WebTorrent shows unselected; forcing re-selection for file ${fileIdx}`);
      const forced = getTorrentManager().selectFileForDownload(infoHash, fileIdx);
      if (!forced) {
        console.error(`[TorrentRoutes] Forced selection failed for file ${fileIdx}`);
      }
      try {
        await getTorrentManager().waitForFileReady(infoHash, fileIdx, 20000);
        console.log(`[TorrentRoutes] File ready after forced selection`);
      } catch (e) {
        console.warn(`[TorrentRoutes] Forced selection readiness wait error: ${e.message}`);
      }
    }

    if (!isAlreadySelected) {
      // Use TorrentManager's selective download method only if not already selected
      console.log(`[TorrentRoutes] Configuring selective download for file index ${fileIdx}`);
      const selectionSuccess = getTorrentManager().selectFileForDownload(infoHash, fileIdx);
      
      if (!selectionSuccess) {
        console.error(`[TorrentRoutes] Failed to configure selective download for file ${fileIdx}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to configure selective download'
        });
      }
      
      console.log(`[TorrentRoutes] Successfully configured selective download for file: ${file.name}`);
      
      // Wait for the file to have some downloaded pieces before streaming
      try {
        await getTorrentManager().waitForFileReady(infoHash, fileIdx, 20000); // Increased timeout
        console.log(`[TorrentRoutes] File ready for streaming`);
      } catch (waitError) {
        console.warn(`[TorrentRoutes] File readiness error:`, waitError.message);
        // Check if torrent is actually downloading anything at all
        if (torrent.downloadSpeed === 0 && torrent.progress === 0) {
          console.error(`[TorrentRoutes] Torrent appears to be stalled (no download speed, no progress). Peers: ${torrent.numPeers}`);
          return res.status(503).json({
            success: false,
            error: 'Torrent download stalled - no peers or network connectivity',
            downloadSpeed: torrent.downloadSpeed,
            progress: torrent.progress,
            peers: torrent.numPeers
          });
        }
      }
    } else {
      console.log(`[TorrentRoutes] File ${fileIdx} already selected`);
    }
    // Check file readiness for streaming (non-blocking): prefer attempting stream to trigger piece requests
    try {
      console.log(`[TorrentRoutes] Checking file properties for streaming readiness...`);
      const fileDownloaded = file.downloaded || 0;
      const fileProgress = file.progress || 0;
      const torrentDownloaded = torrent.downloaded || 0;
      const torrentProgress = torrent.progress || 0;
      
      console.log(`[TorrentRoutes] File properties: downloaded=${fileDownloaded}, progress=${fileProgress}`);
      console.log(`[TorrentRoutes] Torrent properties: downloaded=${torrentDownloaded}, progress=${torrentProgress}, downloadSpeed=${torrent.downloadSpeed || 0}`);
      
      // Do not return 202 here; proceed to create a stream which will trigger piece requests.
      // We'll still log if it's likely not ready yet.
      if (fileProgress === 0 && fileDownloaded === 0) {
        console.log(`[TorrentRoutes] File likely not ready yet; attempting to create stream to trigger piece requests`);
      }
    } catch (propError) {
      console.error(`[TorrentRoutes] Error checking file properties:`, propError.message);
      // Return error instead of continuing, as we can't verify file readiness
      return res.status(500).json({
        success: false,
        error: 'Could not check file readiness: ' + propError.message
      });
    }
    
    const total = file.length;
    const torrentData = getTorrentManager().getTorrentData(infoHash);
    
    // Detect MIME type based on file extension if not provided
    const getContentType = (filename) => {
      const ext = filename.toLowerCase().split('.').pop();
      const mimeTypes = {
        'flac': 'audio/flac',
        'mp3': 'audio/mpeg',
        'm4a': 'audio/mp4',
        'aac': 'audio/aac',
        'ogg': 'audio/ogg',
        'wav': 'audio/wav'
      };
      return mimeTypes[ext] || 'application/octet-stream';
    };
    
    const mimeType = torrentData?.mimeType || getContentType(file.name);
    
    console.log(`[TorrentRoutes] Streaming: ${file.name} (${(total/1024/1024).toFixed(1)}MB, ${mimeType}) ${range ? 'range' : 'full'}`);
    
    if (range) {
      console.log(`[TorrentRoutes] Range request: ${range}`);
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunksize = (end - start) + 1;

      console.log(`[TorrentRoutes] Streaming range ${start}-${end}/${total} (${chunksize} bytes)`);
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      console.log(`[TorrentRoutes] Creating read stream for range ${start}-${end}`);
      
      // Add timeout for stream creation
      const streamTimeout = setTimeout(() => {
        console.error(`[TorrentRoutes] Range stream creation timeout for ${file.name}`);
        if (!res.headersSent) {
          res.status(504).json({ error: 'Range stream creation timeout' });
        }
      }, 15000); // 15 second timeout for stream creation to allow initial pieces
      
      try {
        const stream = file.createReadStream({ start, end });
        clearTimeout(streamTimeout);
        
        console.log(`[TorrentRoutes] Range stream created successfully for ${file.name}`);
        
        let bytesStreamed = 0;
        let streamDestroyed = false;
        
        // Safe stream cleanup function
        const safeDestroyStream = () => {
          if (!streamDestroyed) {
            streamDestroyed = true;
            try { 
              stream.destroy(); 
            } catch (e) { 
              console.warn(`[TorrentRoutes] Range stream cleanup warning for ${file.name}:`, e.message);
            }
          }
        };
        
        stream.on('data', (chunk) => {
          bytesStreamed += chunk.length;
          if (bytesStreamed % 100000 === 0 || bytesStreamed === chunksize) { // Log every 100KB or at end
            console.log(`[TorrentRoutes] Streamed ${bytesStreamed}/${chunksize} bytes for ${file.name}`);
          }
        });
        
        stream.on('end', () => {
          console.log(`[TorrentRoutes] Stream ended for ${file.name}, total bytes: ${bytesStreamed}`);
          safeDestroyStream();
        });
        
        stream.on('error', (err) => {
          console.error(`[TorrentRoutes] Stream error for ${file.name}:`, err.message);
          safeDestroyStream();
          
          // Cannot send JSON response after range streaming headers - just close the connection
          if (!res.destroyed && !res.finished) {
            try {
              res.end(); // Properly end the response
            } catch (e) {
              console.warn(`[TorrentRoutes] Error ending range response for ${file.name}:`, e.message);
            }
          }
        });
        
        // Handle client disconnection gracefully - only one handler needed
        req.on('close', () => {
          console.log(`[TorrentRoutes] Client disconnected for ${file.name}`);
          safeDestroyStream();
        });
        
        res.on('close', () => {
          console.log(`[TorrentRoutes] Response closed for ${file.name}`);
          safeDestroyStream();
        });
        
        stream.pipe(res);
      } catch (streamError) {
        clearTimeout(streamTimeout);
        console.error(`[TorrentRoutes] Error creating range stream for ${file.name}:`, streamError.message);
        
        if (streamError.code === 'ENOENT') {
          // File doesn't exist yet, return 202 to indicate it's still downloading
          if (!res.headersSent) {
            res.status(202).json({
              success: false,
              error: 'File not yet available on disk',
              downloading: true,
              message: 'File is still downloading, please wait...'
            });
          }
        } else {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to create range stream: ' + streamError.message });
          }
        }
      }
    } else {
      console.log(`[TorrentRoutes] Streaming full file ${file.name} (${total} bytes)`);
      
      // Check if file is still downloading to determine streaming strategy
      const fileProgress = file.progress || 0;
      const isFullyDownloaded = fileProgress >= 1.0;
      
      // Add timeout for full file stream creation (similar to range requests)
      const streamTimeout = setTimeout(() => {
        console.error(`[TorrentRoutes] Full file stream creation timeout for ${file.name}`);
        if (!res.headersSent) {
          res.status(504).json({ error: 'Full file stream creation timeout' });
        }
      }, 20000); // 20 second timeout for full files (longer than range requests)

      console.log(`[TorrentRoutes] Creating read stream for full file`);
      
      try {
        const stream = file.createReadStream();
        clearTimeout(streamTimeout); // Cancel timeout since stream was created
        
        console.log(`[TorrentRoutes] Stream created successfully for ${file.name}`);
        
        // Set headers based on download status
        if (!isFullyDownloaded) {
          console.log(`[TorrentRoutes] File is still downloading (${(fileProgress * 100).toFixed(1)}%), using chunked encoding`);
          
          // For partially downloaded files, don't set Content-Length to avoid mismatch
          // But include the expected file size in a custom header for progress calculation
          res.writeHead(200, {
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked', // Use chunked encoding for partial files
            'X-Expected-Length': total.toString() // Custom header with expected file size
          });
        } else {
          console.log(`[TorrentRoutes] File is fully downloaded, using standard streaming`);
          
          // For fully downloaded files, safe to set Content-Length
          res.writeHead(200, {
            'Content-Length': total,
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
        }

        let bytesStreamed = 0;
        let streamDestroyed = false;
        
        // Safe stream cleanup function
        const safeDestroyStream = () => {
          if (!streamDestroyed) {
            streamDestroyed = true;
            try { 
              stream.destroy(); 
            } catch (e) { 
              console.warn(`[TorrentRoutes] Stream cleanup warning for ${file.name}:`, e.message);
            }
          }
        };
        
        stream.on('data', (chunk) => {
          bytesStreamed += chunk.length;
          if (bytesStreamed % 1000000 === 0 || bytesStreamed === total) { // Log every 1MB or at end
            console.log(`[TorrentRoutes] Streamed ${bytesStreamed}/${total} bytes for ${file.name}`);
          }
        });
        
        stream.on('end', () => {
          console.log(`[TorrentRoutes] Stream ended for ${file.name}, total bytes: ${bytesStreamed}`);
          safeDestroyStream();
        });
        
        stream.on('error', (err) => {
          console.error(`[TorrentRoutes] Stream error for ${file.name}:`, err.message);
          safeDestroyStream();
          
          // Cannot send JSON response after streaming headers - just close the connection
          if (!res.destroyed && !res.finished) {
            try {
              res.end(); // Properly end the response
            } catch (e) {
              console.warn(`[TorrentRoutes] Error ending response for ${file.name}:`, e.message);
            }
          }
        });
        
        // Handle client disconnection gracefully - only one handler needed
        req.on('close', () => {
          console.log(`[TorrentRoutes] Client disconnected for ${file.name}`);
          safeDestroyStream();
        });
        
        res.on('close', () => {
          console.log(`[TorrentRoutes] Response closed for ${file.name}`);
          safeDestroyStream();
        });

        stream.pipe(res);
        
      } catch (streamError) {
        clearTimeout(streamTimeout);
        console.error(`[TorrentRoutes] Error creating full file stream for ${file.name}:`, streamError.message);
        
        if (streamError.code === 'ENOENT') {
          // File doesn't exist yet, return 202 to indicate it's still downloading
          if (!res.headersSent) {
            res.status(202).json({
              success: false,
              error: 'File not yet available on disk',
              downloading: true,
              message: 'File is still downloading, please wait...'
            });
          }
        } else {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to create full file stream: ' + streamError.message });
          }
        }
      }
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

    const status = getTorrentManager().getStatus(infoHash);
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
    const torrents = getTorrentManager().getAllTorrents();

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

    const removed = getTorrentManager().removeTorrent(infoHash, destroyStore === 'true');
    if (removed) {
      // Mark magnet as removed to prevent automatic re-add via polling recall
      markRemovedMagnet(infoHash);
    }
    
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

// Store download tracking for each file to provide stable progress
const fileDownloadTrackers = new Map();

/**
 * Get torrent file progress using stable torrent-level progress
 * GET /progress/:infoHash/:fileIndex
 */
router.get('/progress/:infoHash/:fileIndex?', async (req, res) => {
  try {
  const { infoHash, fileIndex = '0' } = req.params;
  const magnetParam = req.query.magnet;
    const fileIdx = parseInt(fileIndex, 10);
    const fileKey = `${infoHash}:${fileIdx}`;

    let torrent = getTorrentManager().getTorrent(infoHash);
    if (!torrent) {
      // Only attempt to re-add if it was NOT removed recently
      if (!wasRemovedRecently(infoHash)) {
        const magnet = magnetParam || recallMagnet(infoHash);
        if (magnet && getTorrentManager().isReady()) {
          try {
            // Fire-and-forget; deduplicated in manager
            getTorrentManager().addTorrent(magnet, { name: `torrent-${infoHash}` })
              .catch(() => {});
          } catch (_) {}
        }
      }

      // Provide a graceful "not ready yet" status with a cached total if available
      let fallbackTotal = 0;
      try {
        const tfm = getTorrentFilesManager();
        fallbackTotal = await tfm.getFileLength(infoHash, fileIdx, { timeout: 3000, forceRefresh: false });
      } catch (_) {}

      return res.json({
        success: true,
        data: {
          ready: false,
          progress: 0,
          downloaded: 0,
          total: fallbackTotal || 0,
          downloadSpeed: 0,
          peers: 0
        }
      });
    }

    if (!torrent.ready || !torrent.files || torrent.files.length === 0) {
      // Try to get a better total size from the files cache/manager (centralized helper)
      let fallbackTotal = 0;
      try {
        const tfm = getTorrentFilesManager();
        fallbackTotal = await tfm.getFileLength(infoHash, fileIdx, { timeout: 5000, forceRefresh: false });
      } catch (_) {}
      return res.json({
        success: true,
        data: {
          ready: false,
          progress: 0,
          downloaded: 0,
          total: fallbackTotal || 0,
          downloadSpeed: 0,
          peers: torrent.numPeers || 0
        }
      });
    }

    // Validate file index
    if (fileIdx < 0 || fileIdx >= torrent.files.length) {
      return res.status(400).json({
        success: false,
        error: `File index ${fileIdx} out of range (0-${torrent.files.length - 1})`
      });
    }

  const file = torrent.files[fileIdx];
    const currentFileProgress = file.progress || 0;
    
    // Get or create download tracker for this file
    let tracker = fileDownloadTrackers.get(fileKey);
    if (!tracker) {
      tracker = {
        maxFileProgress: 0,
        maxFileBytes: 0,
        lastUpdate: Date.now(),
        fileLength: file.length || 0
      };
      fileDownloadTrackers.set(fileKey, tracker);
    }
    
    // Update tracker with latest data (only allow increases)
    const currentFileBytes = Math.floor((file.length || 0) * currentFileProgress);
    
    // Use file progress (not torrent progress) but make it monotonic
    if (currentFileProgress > tracker.maxFileProgress) {
      tracker.maxFileProgress = currentFileProgress;
      tracker.lastUpdate = Date.now();
    }
    
    if (currentFileBytes > tracker.maxFileBytes) {
      tracker.maxFileBytes = currentFileBytes;
      tracker.lastUpdate = Date.now();
    }
    
    // Clean up old trackers (after 5 minutes of inactivity)
    const now = Date.now();
    for (const [key, track] of fileDownloadTrackers.entries()) {
      if (now - track.lastUpdate > 5 * 60 * 1000) {
        fileDownloadTrackers.delete(key);
      }
    }
    
    // Use the actual file progress but ensure it's monotonic (never decreases)
    const monotonicFileProgress = Math.max(
      tracker.maxFileProgress,
      currentFileBytes / (file.length || 1)
    );
    
    // Ensure we have a valid total length; if not, try fallback via files manager
    let totalLength = file.length || 0;
    if (!totalLength) {
      try {
        const tfm = getTorrentFilesManager();
        totalLength = await tfm.getFileLength(infoHash, fileIdx, { timeout: 5000, forceRefresh: false });
      } catch (_) {}
    }

    const fileDownloaded = Math.min(tracker.maxFileBytes, totalLength || 0);

    res.json({
      success: true,
      data: {
        ready: true,
        fileName: file.name,
        progress: Math.min(monotonicFileProgress, 1.0), // Cap at 100%
        downloaded: fileDownloaded,
  total: totalLength || 0,
        downloadSpeed: torrent.downloadSpeed || 0,
        peers: torrent.numPeers || 0,
        torrentProgress: torrent.progress || 0,
        _debug: {
          rawFileProgress: currentFileProgress,
          monotonicFileProgress: monotonicFileProgress,
          torrentProgress: torrent.progress || 0,
          fileBytes: currentFileBytes,
          maxFileBytes: tracker.maxFileBytes,
          progressIncreased: currentFileProgress > (tracker.maxFileProgress - 0.001)
        }
      }
    });

  } catch (error) {
    console.error('[TorrentRoutes] Progress error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get progress'
    });
  }
});

module.exports = router;
