/**
 * Optimized torrent management with singleton pattern
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { createWebTorrentClient, isWebTorrentAvailable } = require('../utils/webtorrent-loader');
const { getUserDataDir } = require('../utils/helpers');

// Simple, clean logging for TorrentManager
const log = (msg) => {
  console.log(`[${new Date().toISOString()}] [TorrentManager] ${msg}`);
};

const tempDir = getUserDataDir('torrents');

class TorrentManager {
  constructor() {
    if (TorrentManager.instance) {
      return TorrentManager.instance;
    }

    this.client = null;
    this.isAvailable = false;
    this.initializationError = null;

    try {
      const wtVersion = require('webtorrent/package.json').version;
      log(`WebTorrent version: ${wtVersion}`);
    } catch (_) {
      log('WebTorrent package info not available');
    }

    this.torrents = new Map();
    this.torrentData = new Map();
    this.selectedFiles = new Map(); // Track which files are selected for each torrent
    this.waitingFiles = new Map(); // Track files currently being waited for to prevent duplicates
    this.pendingAdds = new Map(); // Deduplicate concurrent addTorrent calls per infoHash
    this.torrentReadyWaits = new Map(); // Share ready-wait promises per torrent
    this.trackers = [];

    fetch('https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt')
      .then(response => response.text())
      .then(data => {
        this.trackers = data.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        log(`Loaded ${this.trackers.length} trackers`);

      })
      .catch(error => { log(`Failed to load trackers: ${error.message}`) })
      .finally(() => {
        this.checkAvailability();
      });

    TorrentManager.instance = this;

  }

  async checkAvailability() {
    try {
      this.isAvailable = await isWebTorrentAvailable();
      if (this.isAvailable) {
        log('WebTorrent is available');
      } else {
        log('WebTorrent is not available due to native dependency issues');
      }
    } catch (error) {
      this.isAvailable = false;
      this.initializationError = error;
      log(`WebTorrent availability check failed: ${error.message}`);
    }
  }

  async startTorrentClient() {
    if (this.client) {
      return this.client;
    }

    if (!this.isAvailable) {
      throw new Error('WebTorrent is not available due to native dependency issues');
    }

    try {
      const clientOptions = {
        // Enable features; loader will downshift if native deps are missing
        utp: true,
        webSeeds: true
      };

      log('Starting WebTorrent client with safe options');
      this.client = await createWebTorrentClient(clientOptions);
      log('WebTorrent client started successfully');
      return this.client;
    } catch (error) {
      this.isAvailable = false;
      this.initializationError = error;
      log(`Failed to start WebTorrent client: ${error.message}`);
      throw error;
    }
  }

  static getInstance() {
    if (!TorrentManager.instance) {
      new TorrentManager();
    }
    return TorrentManager.instance;
  }

  /**
   * Check if torrent functionality is available
   */
  isReady() {
    return this.isAvailable && !this.initializationError;
  }

  /**
   * Get status information about WebTorrent availability
   */
  getStatus() {
    return {
      available: this.isAvailable,
      clientReady: !!this.client,
      error: this.initializationError?.message || null,
      activeTorrents: this.torrents.size
    };
  }

  /**
   * Add torrent from magnet URI or infoHash
   * If torrent already exists, remove and re-add it to apply new configurations
   */
  async addTorrent(id, options = {}) {
    const { mimeType = 'application/octet-stream', name, forceRecreate = false } = options;

    // Extract infoHash for duplicate checking
    let infoHash = id;
    if (typeof id === 'string' && id.startsWith('magnet:')) {
      const hexMatch = id.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
      if (hexMatch) {
        infoHash = hexMatch[1].toLowerCase();
      } else {
        // Fallback to raw digest (could be base32) for dedup keys
        const anyDigest = id.match(/xt=urn:btih:([^&]+)/i);
        if (anyDigest) {
          infoHash = anyDigest[1].toLowerCase();
        }
      }
    }

    // Create a canonical dedup key independent of extra magnet params
    const getDedupKey = (value) => {
      try {
        const s = String(value);
        if (s.startsWith('magnet:')) {
          const m = s.match(/xt=urn:btih:([^&]+)/i);
          if (m) return m[1].toLowerCase();
        }
        return s.toLowerCase();
      } catch (_) {
        return String(value);
      }
    };
    const dedupKey = getDedupKey(id);

    // Check if torrent already exists
    const existingTorrent = this.torrents.get(infoHash);
    if (existingTorrent && !forceRecreate) {
      log(`Torrent ${infoHash} already exists, returning existing torrent`);
      return existingTorrent;
    } else if (existingTorrent && forceRecreate) {
      log(`Torrent ${infoHash} exists but forceRecreate=true, removing and re-adding`);
      await this.removeTorrentCompletely(infoHash);
    }

    // Deduplicate concurrent add attempts (by canonical dedup key)
    if (this.pendingAdds.has(dedupKey) && !forceRecreate) {
      log(`Join pending addTorrent for ${dedupKey}`);
      return this.pendingAdds.get(dedupKey);
    }

    // Fast fail if not available to avoid unhandled rejections
    if (!this.isAvailable) {
      throw new Error('WebTorrent is not available due to native dependency issues');
    }

    const addPromise = new Promise((resolve, reject) => {
      // Initialize client safely without async executor traps
      this.startTorrentClient()
        .then((client) => {
          if (!client) {
            return reject(new Error('WebTorrent client not initialized'));
          }

          const torrentOptions = {
            // Use default disk storage to verify downloads are working
            path: tempDir, // Explicit path for disk storage
            announce: Array.isArray(this.trackers) ? this.trackers : undefined,
            // Let WebTorrent handle storage normally for testing
          };

          log(`Torrent options:`, torrentOptions);
          log(`Download path: ${tempDir}`);
          log(`Adding torrent with DISK-based storage for testing`);

          // If client already has this torrent, reuse it to avoid duplicate add errors
          try {
            const dup = client.torrents.find(t => {
              if (!t) return false;
              const ih = (t.infoHash || '').toLowerCase();
              const magnet = (t.magnetURI || '').toLowerCase();
              const source = String(id).toLowerCase();
              return (ih && (ih === infoHash || source.includes(ih))) || (magnet && magnet === source);
            });
            if (dup) {
              log(`Client already has torrent ${infoHash}, reusing`);
              this.torrents.set(dup.infoHash, dup);
              this.torrentData.set(dup.infoHash, { mimeType, name: name || dup.name });
              return resolve(dup);
            }
          } catch (_) { }

          // Prepare a temporary client error handler for this add attempt
          const onClientError = (error) => {
            try { client.off('error', onClientError); } catch (_) { }
            console.error('[TorrentManager] Add torrent error:', error);
            // Gracefully resolve on duplicate errors by returning the existing torrent
            const msg = String(error && error.message || '');
            if (/duplicate torrent/i.test(msg)) {
              try {
                // Try to extract hash from message
                const hashMatch = msg.match(/([a-fA-F0-9]{40})/);
                let existing;
                if (hashMatch) {
                  const hex = hashMatch[1].toLowerCase();
                  existing = client.torrents.find(t => (t.infoHash || '').toLowerCase() === hex);
                }
                if (!existing) {
                  const source = String(id).toLowerCase();
                  existing = client.torrents.find(t => {
                    const ih = (t.infoHash || '').toLowerCase();
                    const magnet = (t.magnetURI || '').toLowerCase();
                    return (ih && source.includes(ih)) || (magnet && magnet === source);
                  });
                }
                if (existing) {
                  log(`Resolved duplicate add for ${infoHash} by reusing existing torrent`);
                  this.torrents.set(existing.infoHash, existing);
                  this.torrentData.set(existing.infoHash, { mimeType, name: name || existing.name });
                  return resolve(existing);
                }
              } catch (_) { }
            }
            reject(error);
          };
          client.on('error', onClientError);

          // Add torrent with disk storage for testing
          client.add(id, torrentOptions, (torrent) => {
            // Remove temporary error handler on success path
            try { client.off('error', onClientError); } catch (_) { }
            try {
              log(`Added torrent: ${torrent.infoHash} with ${torrent.files ? torrent.files.length : 'unknown'} files`);

              // Add download event listener for real-time progress tracking
              torrent.on('download', () => {
                const progress = torrent.progress || 0;
                const downloadSpeed = torrent.downloadSpeed || 0;
                if (Math.random() < 0.001) {
                  const selectedFiles = torrent.files ? torrent.files.filter(f => f.progress > 0) : [];
                  if (selectedFiles.length > 0) {
                    const activeFile = selectedFiles[0];
                    const fileProgress = (activeFile.progress || 0) * 100;
                    log(`File download progress: ${fileProgress.toFixed(1)}% (${activeFile.name}, ${downloadSpeed} bytes/s)`);
                  } else {
                    log(`Torrent download progress: ${(progress * 100).toFixed(1)}% (${downloadSpeed} bytes/s)`);
                  }
                }
              });

              // Immediately pause to prevent any auto-download until we configure deselection
              if (typeof torrent.pause === 'function') {
                try {
                  torrent.pause();
                  log('Paused torrent immediately on add to prevent auto-download');
                } catch (e) {
                  console.warn('[TorrentManager] Failed to pause torrent on add:', e.message);
                }
              }

              // Configure for selective downloading
              const configureSelectiveDownload = () => {
                if (torrent.files && torrent.files.length > 0) {
                  log(`Configuring ${torrent.files.length} files for selective download`);

                  // Deselect all files first (reduced logging for performance)
                  let deselectedCount = 0;
                  torrent.files.forEach((f, i) => {
                    try {
                      f.deselect();
                      deselectedCount++;
                    } catch (e) {
                      console.warn(`[TorrentManager] Failed to deselect file ${i}:`, e.message);
                    }
                  });
                  log(`Deselected ${deselectedCount}/${torrent.files.length} files`);

                  // If we have a pre-selected file index for this torrent, ensure it's selected
                  const preSelectedFileIndex = this.selectedFiles.get(torrent.infoHash);
                  if (preSelectedFileIndex !== undefined && torrent.files[preSelectedFileIndex]) {
                    log(`Applying pre-selected file index ${preSelectedFileIndex}`);
                    torrent.files[preSelectedFileIndex].select();
                    log(`Selected pre-configured file ${preSelectedFileIndex}: ${torrent.files[preSelectedFileIndex].name}`);
                  }

                  // Resume torrent to allow downloading after configuration
                  try {
                    if (typeof torrent.resume === 'function') {
                      torrent.resume();
                      log('Resumed torrent after file configuration');
                    }
                  } catch (e) {
                    console.warn('[TorrentManager] Failed to resume torrent after configuration:', e.message);
                  }
                }
              };
              configureSelectiveDownload();

              // Store torrent metadata
              this.torrents.set(torrent.infoHash, torrent);
              this.torrentData.set(torrent.infoHash, {
                mimeType,
                name: name || torrent.name
              });

              resolve(torrent);
            } catch (cbErr) {
              reject(cbErr);
            }
          });

          // Note: error handler is attached above and removed on success/error
        })
        .catch((err) => {
          // Ensure we reject if starting the client fails
          reject(err);
        });
    });
    this.pendingAdds.set(dedupKey, addPromise);
    // Ensure cleanup of pendingAdds map
    addPromise.finally(() => {
      this.pendingAdds.delete(dedupKey);
    });
    return addPromise;
  }

  /**
   * Wait for a torrent to emit 'ready' with deduplication to avoid listener leaks.
   */
  async waitForTorrentReady(infoHash, timeoutMs = 10000) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) {
      throw new Error(`Torrent ${infoHash} not found`);
    }
    if (torrent.ready) return true;

    const key = infoHash.toLowerCase();
    if (this.torrentReadyWaits.has(key)) {
      return this.torrentReadyWaits.get(key);
    }

    const waitPromise = new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve(true);
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Torrent ready timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        try { torrent.off('ready', onReady); } catch (_) { }
        try { torrent.off('error', onError); } catch (_) { }
        clearTimeout(timer);
        this.torrentReadyWaits.delete(key);
      };

      torrent.on('ready', onReady);
      torrent.on('error', onError);
    });

    this.torrentReadyWaits.set(key, waitPromise);
    return waitPromise;
  }

  /**
   * Completely remove a torrent from client and cleanup
   */
  async removeTorrentCompletely(infoHash) {
    const torrent = this.torrents.get(infoHash);
    if (torrent) {
      log(`Completely removing torrent ${infoHash}`);

      return new Promise((resolve) => {
        // Remove from WebTorrent client
        this.client.remove(torrent, (err) => {
          if (err) {
            console.warn(`[TorrentManager] Error removing torrent from client:`, err.message);
          } else {
            log(`Successfully removed torrent from client`);
          }

          // Clean up our maps
          this.torrents.delete(infoHash);
          this.torrentData.delete(infoHash);
          this.selectedFiles.delete(infoHash);

          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  /**
   * Seed a file as a torrent
   */
  async seedFile(filePath, options = {}) {
    const { mimeType = 'application/octet-stream', name } = options;

    return new Promise((resolve, reject) => {
      // Attach a temporary error handler on the client and ensure it's removed on success
      const onClientError = (error) => {
        try { this.client.off('error', onClientError); } catch (_) { }
        console.error('[TorrentManager] Seeding error:', error);
        reject(error);
      };
      this.client.on('error', onClientError);

      this.client.seed(filePath, (torrent) => {
        // Seeding succeeded; remove temporary error handler to avoid accumulating listeners
        try { this.client.off('error', onClientError); } catch (_) { }
        log('Seeded file:', torrent.infoHash);
        this.torrents.set(torrent.infoHash, torrent);
        this.torrentData.set(torrent.infoHash, {
          mimeType,
          name: name || torrent.name
        });
        resolve(torrent);
      });
    });
  }

  /**
   * Check if a specific file is already selected for download
   */
  isFileSelected(infoHash, fileIndex) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent || !torrent.files || !torrent.files[fileIndex]) {
      return false;
    }

    // Check our internal tracking
    const trackedSelection = this.selectedFiles.get(infoHash);
    const isTrackedAsSelected = trackedSelection === fileIndex;

    // Also check the actual file state
    const file = torrent.files[fileIndex];
    const isActuallySelected = file.selected === true;
    const hasProgress = (file.downloaded || 0) > 0;
    const fullyDownloaded = (typeof file.length === 'number' && file.length > 0) ? ((file.downloaded || 0) >= file.length) : false;

    // Only trust WebTorrent's selection state (or fully downloaded) for effective selection.
    // Do not treat internal tracking or partial progress as selected.
    const effectivelySelected = isActuallySelected || fullyDownloaded;

    // NEW: If the file is actively downloading (has progress) but not marked selected,
    // proactively enforce selection so downloading continues. This prevents stalls where
    // WebTorrent deselect state and partial data get out of sync.
    if (!isActuallySelected && hasProgress && !fullyDownloaded) {
      log(`File ${fileIndex} has progress (${file.downloaded || 0} bytes) but is not selected; auto-selecting`);
      const enforced = this.selectFileForDownload(infoHash, fileIndex);
      if (enforced) {
        return true;
      }
    }

    // Log any mismatches for debugging
    if (isTrackedAsSelected !== isActuallySelected && !fullyDownloaded) {
      // Self-heal our tracking to reflect actual state
      if (!isActuallySelected) {
        this.selectedFiles.delete(infoHash);
      } else {
        this.selectedFiles.set(infoHash, fileIndex);
      }
      log(`File ${fileIndex} selection mismatch: tracked=${isTrackedAsSelected}, actual=${isActuallySelected}, progress=${hasProgress ? Math.floor((file.downloaded || 0) / 1024) + 'KB' : 'none'}`);
    } else {
      log(`File ${fileIndex} selection status: tracked=${isTrackedAsSelected}, actual=${isActuallySelected}, effectively=${effectivelySelected}`);
    }

    return effectivelySelected;
  }

  /**
   * Optimized file selection for streaming
   */
  selectFileForDownload(infoHash, fileIndex) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent || !torrent.files || !torrent.files[fileIndex]) {
      console.error(`[TorrentManager] Cannot select file ${fileIndex} for torrent ${infoHash}`);
      return false;
    }

    const file = torrent.files[fileIndex];

    // Check if file is actually selected in WebTorrent (not just our tracking)
    const currentlySelected = this.selectedFiles.get(infoHash);
    const isActuallySelected = file.selected === true;
    const hasProgress = (file.downloaded || 0) > 0;

    // Only skip if WebTorrent already marks the file as selected.
    // Do NOT skip based solely on partial progress; ensure explicit selection so downloading continues.
    if (isActuallySelected) {
      log(`File ${fileIndex} already selected by WebTorrent, skipping re-selection`);
      this.selectedFiles.set(infoHash, fileIndex);
      return true;
    }

    // Log the mismatch for debugging
    if (currentlySelected === fileIndex && !isActuallySelected) {
      log(`File ${fileIndex} tracked as selected but WebTorrent shows unselected - fixing selection`);
    }

    log(`Selecting file ${fileIndex}: ${file.name}`);

    try {
      // Efficiently deselect all files and select target
      torrent.files.forEach((f, i) => {
        try {
          if (i === fileIndex) {
            f.select();
          } else {
            f.deselect();
          }
        } catch (_) { }
      });

      this.selectedFiles.set(infoHash, fileIndex);
      this.prioritizeFilePieces(torrent, file);

      // Verify the selection actually worked
      let verifySelected = torrent.files[fileIndex].selected === true;
      if (!verifySelected) {
        // Fallback: explicitly select the entire file's piece range at high priority
        try {
          const pieceLength = torrent.pieceLength || 16384;
          const startPiece = Math.floor(file.offset / pieceLength);
          const endPiece = Math.ceil((file.offset + file.length) / pieceLength) - 1;
          log(`File ${fileIndex} select fallback: selecting pieces ${startPiece}-${endPiece}`);
          if (typeof torrent.select === 'function') {
            torrent.select(startPiece, endPiece, true);
          }
          // Re-check selection state
          verifySelected = torrent.files[fileIndex].selected === true;
        } catch (e) {
          console.warn(`[TorrentManager] Fallback select() failed for file ${fileIndex}:`, e.message);
        }
      }
      log(`File ${fileIndex} selection complete - WebTorrent confirms: ${verifySelected}`);

      // Resume torrent if needed
      if (typeof torrent.resume === 'function') {
        torrent.resume();
      }

      return true;
    } catch (err) {
      console.error(`[TorrentManager] Error selecting file ${fileIndex}:`, err.message);
      return false;
    }
  }

  /**
   * Prioritize the first few pieces of a file for streaming
   */
  prioritizeFilePieces(torrent, file) {
    try {
      if (typeof torrent.critical === 'function') {
        // Calculate which pieces contain the beginning of this file
        const pieceLength = torrent.pieceLength || 16384; // Default WebTorrent piece size
        const startPiece = Math.floor(file.offset / pieceLength);
        // Prioritize first ~2MB worth of pieces (helps resume from partial)
        const headBytes = 2 * 1024 * 1024;
        const numPiecesToPrioritize = Math.max(8, Math.ceil((file.offset + headBytes) / pieceLength) - startPiece);
        const endPiece = startPiece + numPiecesToPrioritize - 1;

        log(`Prioritizing pieces ${startPiece}-${endPiece} for file streaming (${file.name})`);
        torrent.critical(startPiece, endPiece);
      } else {
        console.warn('[TorrentManager] Torrent.critical() not available for piece prioritization');
      }
    } catch (e) {
      console.warn(`[TorrentManager] Failed to prioritize pieces for file streaming:`, e.message);
    }
  }

  /**
   * Optimized file readiness check with debouncing and minimal logging
   */
  async waitForFileReady(infoHash, fileIndex, timeoutMs = 15000) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent || !torrent.files || !torrent.files[fileIndex]) {
      throw new Error(`File ${fileIndex} not found in torrent ${infoHash}`);
    }

    const file = torrent.files[fileIndex];
    const waitKey = `${infoHash}:${fileIndex}`;

    // Prevent multiple simultaneous waits for the same file
    if (this.waitingFiles.has(waitKey)) {
      log(`File ${fileIndex} already being waited for, joining existing wait`);
      return this.waitingFiles.get(waitKey);
    }

    const minBufferSize = Math.floor(Math.min(3 * 1024 * 1024, file.length * 0.05)); // Clean integer

    log(`Waiting for file ${fileIndex} (need ${Math.floor(minBufferSize / 1024)}KB)`);
    log(`Using WebTorrent native progress tracking for file: ${file.name}`);

    const waitPromise = new Promise((resolve) => {
      const startTime = Date.now();
      let lastLogTime = 0;
      let extensionCount = 0;
      const maxExtensions = 20; // Allow up to 20 extensions (5+ minutes total)
      let checkInterval;

      const cleanup = () => {
        if (checkInterval) clearInterval(checkInterval);
        this.waitingFiles.delete(waitKey);
      };

      const checkFile = () => {
        const elapsed = Date.now() - startTime;

        try {
          // Use WebTorrent's built-in progress tracking instead of filesystem checks
          const fileDownloaded = file.downloaded || 0; // Bytes downloaded for this file
          const fileProgress = file.progress || 0; // Progress percentage (0-1)
          const fileLength = file.length || 1; // Total file size

          // Calculate progress percentage for logging
          const progressPercent = (fileProgress * 100).toFixed(1);
          const downloadedKB = Math.floor(fileDownloaded / 1024);
          const totalKB = Math.floor(fileLength / 1024);

          // Ready check - file has sufficient data for streaming
          if (fileDownloaded >= minBufferSize) {
            cleanup();
            log(`File ${fileIndex} ready: ${progressPercent}% (${downloadedKB}KB downloaded)`);
            resolve(true);
            return;
          }

          // Timeout check with extension limits
          if (elapsed >= timeoutMs) {
            const minProgressBytes = Math.max(512 * 1024, fileLength * 0.01); // At least 512KB or 1% of file
            if (fileDownloaded >= minProgressBytes) {
              cleanup();
              log(`File ${fileIndex} proceeding after ${(elapsed / 1000).toFixed(1)}s with ${progressPercent}% progress (${downloadedKB}KB)`);
              resolve(true);
              return;
            } else if (extensionCount < maxExtensions) {
              // Limited extensions to prevent infinite loops
              extensionCount++;
              log(`File ${fileIndex} timeout reached but insufficient progress (${progressPercent}%), extending wait... (${extensionCount}/${maxExtensions})`);
              // Don't return - keep waiting
            } else {
              // Maximum extensions reached, proceed anyway to prevent infinite loops
              cleanup();
              log(`File ${fileIndex} max extensions reached (${maxExtensions}), proceeding with ${progressPercent}% progress after ${(elapsed / 1000).toFixed(1)}s`);
              resolve(true);
              return;
            }
          }

          // Throttled progress logging (only show if we haven't been extending repeatedly)
          const now = Date.now();
          if (now - lastLogTime > 6000 && extensionCount < 3) { // Less frequent logging, skip during heavy extensions
            log(`File ${fileIndex}: ${progressPercent}% (${downloadedKB}KB of ${totalKB}KB downloaded)`);
            lastLogTime = now;
          }

        } catch (error) {
          // Log WebTorrent API errors but continue checking
          const now = Date.now();
          if (elapsed >= timeoutMs && now - lastLogTime > 10000) {
            log(`File ${fileIndex} WebTorrent API error: ${error.message}, continuing to wait...`);
            lastLogTime = now;
          }
        }
      };

      // Check every 2 seconds (less aggressive for large torrent files)
      checkInterval = setInterval(checkFile, 2000);

      // Initial check
      checkFile();
    });

    // Store the promise to prevent duplicates
    this.waitingFiles.set(waitKey, waitPromise);

    return waitPromise;
  }

  /**
   * Clear any selections and stop background downloading for a torrent
   */
  clearSelection(infoHash) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return;
    try {
      torrent.files?.forEach(f => { try { f.deselect(); } catch (_) { } });
      if (typeof torrent.deselect === 'function' && Array.isArray(torrent.pieces) && torrent.pieces.length > 0) {
        torrent.deselect(0, torrent.pieces.length - 1, false);
      }
      this.selectedFiles.delete(infoHash);
      log(`Cleared selections for torrent ${infoHash}`);
    } catch (e) {
      console.warn('[TorrentManager] Failed to clear selections:', e.message);
    }
  }

  /**
   * Get torrent by infoHash
   */
  getTorrent(infoHash) {
    return this.torrents.get(infoHash);
  }

  /**
   * Get additional torrent data (mimeType, name)
   */
  getTorrentData(infoHash) {
    return this.torrentData.get(infoHash);
  }

  /**
   * Get all torrents with metadata
   */
  getAllTorrents() {
    const result = [];
    for (const [infoHash, torrent] of this.torrents) {
      const data = this.torrentData.get(infoHash);
      result.push({
        infoHash,
        magnetURI: torrent.magnetURI,
        name: data?.name || torrent.name,
        mimeType: data?.mimeType,
        progress: torrent.progress || 0,
        numPeers: torrent.numPeers || 0,
      });
    }
    return result;
  }

  /**
   * Remove torrent with improved cleanup
   */
  removeTorrent(infoHash, destroyStore = false) {
    const torrent = this.torrents.get(infoHash);
    if (torrent) {
      try {
        // Remove all listeners to prevent memory leaks
        torrent.removeAllListeners();

        if (destroyStore) {
          torrent.destroy();
        }
      } catch (e) {
        console.warn(`[TorrentManager] Error during torrent cleanup:`, e.message);
      }

      this.torrents.delete(infoHash);
      this.torrentData.delete(infoHash);
      this.selectedFiles.delete(infoHash);
      log(`Removed torrent ${infoHash}`);
      return true;
    }
    return false;
  }

  /**
   * Get torrent status
   */
  getStatus(infoHash) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return null;

    const data = this.torrentData.get(infoHash);
    return {
      infoHash: torrent.infoHash,
      magnetURI: torrent.magnetURI,
      name: data?.name || torrent.name,
      mimeType: data?.mimeType,
      progress: torrent.progress || 0,
      numPeers: torrent.numPeers || 0,
    };
  }

  /**
   * Get configured trackers
   */
  getTrackers() {
    return this.trackers;
  }

  /**
   * Enhanced cleanup for memory management
   */
  destroy() {
    if (this.client) {
      try {
        // Clean up all torrents properly
        for (const [infoHash, torrent] of this.torrents) {
          try {
            torrent.removeAllListeners();
            torrent.destroy();
          } catch (e) {
            console.warn(`[TorrentManager] Error destroying torrent ${infoHash}:`, e.message);
          }
        }

        this.client.destroy();
        log(`Client destroyed, cleaned up ${this.torrents.size} torrents`);
      } catch (e) {
        console.error(`[TorrentManager] Error during client destruction:`, e.message);
      }

      this.torrents.clear();
      this.torrentData.clear();
      this.selectedFiles.clear();
      this.client = null;
    }
  }

  /**
   * Cleanup inactive torrents to manage memory
   */
  cleanupInactiveTorrents(maxIdleTime = 30 * 60 * 1000) { // 30 minutes
    const now = Date.now();
    const toRemove = [];

    for (const [infoHash, torrent] of this.torrents) {
      const isInactive = torrent.numPeers === 0 &&
        torrent.downloadSpeed === 0 &&
        (!torrent.lastUsed || (now - torrent.lastUsed) > maxIdleTime);

      if (isInactive) {
        toRemove.push(infoHash);
      }
    }

    toRemove.forEach(infoHash => this.removeTorrent(infoHash, true));

    if (toRemove.length > 0) {
      log(`Cleaned up ${toRemove.length} inactive torrents`);
    }

    return toRemove.length;
  }
}

module.exports = TorrentManager;
