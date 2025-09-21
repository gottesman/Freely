/**
 * Optimized torrent management with singleton pattern
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { createWebTorrentClient } = require('../utils/webtorrent-loader');
const { getUserDataDir } = require('../utils/helpers');

// Simple, clean logging for TorrentManager
const log = (msg) => {
  console.log(`[${new Date().toISOString()}] [TorrentManager] ${msg}`);
};

const tempDir = getUserDataDir('torrents');

class TorrentManager {
  async startTorrentClient() {
    if (this.client) {
      return this.client;
    }
    const clientOptions = {
    };
    this.client = await createWebTorrentClient(clientOptions);
    return this.client;
  }
  constructor() {
    if (TorrentManager.instance) {
      return TorrentManager.instance;
    }
    
    try {
      const wtVersion = require('webtorrent/package.json').version;
      log(`WebTorrent version: ${wtVersion}`);
    } catch (_) {}
    this.torrents = new Map();
    this.torrentData = new Map();
    this.selectedFiles = new Map(); // Track which files are selected for each torrent
    this.waitingFiles = new Map(); // Track files currently being waited for to prevent duplicates
    this.trackers = [
      'udp://tracker.openbittorrent.com:80',
      'udp://tracker.opentrackr.org:1337',
      'udp://tracker.leechers-paradise.org:6969',
      'udp://tracker.coppersurfer.tk:6969',
      'wss://tracker.btorrent.xyz',
    ];

    TorrentManager.instance = this;
  }

  static getInstance() {
    if (!TorrentManager.instance) {
      new TorrentManager();
    }
    return TorrentManager.instance;
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
      const match = id.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
      if (match) {
        infoHash = match[1].toLowerCase();
      }
    }

    // Check if torrent already exists
    const existingTorrent = this.torrents.get(infoHash);
    if (existingTorrent && !forceRecreate) {
      log(`Torrent ${infoHash} already exists, returning existing torrent`);
      return existingTorrent;
    } else if (existingTorrent && forceRecreate) {
      log(`Torrent ${infoHash} exists but forceRecreate=true, removing and re-adding`);
      await this.removeTorrentCompletely(infoHash);
    }

    return new Promise(async (resolve, reject) => {
      // Try disk-based storage to verify actual file downloads
      this.client = await this.startTorrentClient();
      if (!this.client) {
        return reject(new Error('WebTorrent client not initialized'));
      }
      
      const torrentOptions = {
        // Use default disk storage to verify downloads are working
        path: tempDir, // Explicit path for disk storage
        // Let WebTorrent handle storage normally for testing
      };

      log(`Torrent options:`, torrentOptions);
      log(`Download path: ${tempDir}`);
      log(`Adding torrent with DISK-based storage for testing`);

      // Add torrent with disk storage for testing
      this.client.add(id, torrentOptions, (torrent) => {
        log(`Added torrent: ${torrent.infoHash} with ${torrent.files ? torrent.files.length : 'unknown'} files`);
        
        // Add download event listener for real-time progress tracking
        torrent.on('download', () => {
          // This event fires every time a piece is downloaded
          // We can use this for more responsive progress updates
          const progress = torrent.progress || 0;
          const downloadSpeed = torrent.downloadSpeed || 0;
          
          // Only log occasionally to avoid spam (0.1% chance = very rare)
          if (Math.random() < 0.001) {
            // Find the currently selected file and show its progress instead of torrent progress
            const selectedFiles = torrent.files ? torrent.files.filter(f => f.progress > 0) : [];
            if (selectedFiles.length > 0) {
              const activeFile = selectedFiles[0]; // Usually there's only one active file
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
      });

      // Handle add torrent errors
      this.client.on('error', (error) => {
        console.error('[TorrentManager] Add torrent error:', error);
        reject(error);
      });
    });
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
      this.client.seed(filePath, (torrent) => {
        log('Seeded file:', torrent.infoHash);
        this.torrents.set(torrent.infoHash, torrent);
        this.torrentData.set(torrent.infoHash, {
          mimeType,
          name: name || torrent.name
        });
        resolve(torrent);
      });

      this.client.on('error', (error) => {
        console.error('[TorrentManager] Seeding error:', error);
        reject(error);
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
    
    // Consider a file as "selected" if it has download progress, even if selection state is inconsistent
    const effectivelySelected = (isTrackedAsSelected && isActuallySelected) || hasProgress;
    
    // Log any mismatches for debugging
    if (isTrackedAsSelected !== isActuallySelected && !hasProgress) {
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
    
    // Only skip if BOTH our tracking AND WebTorrent agree the file is selected
    // OR if the file has progress (meaning it's actively downloading even if selection state is inconsistent)
    if ((currentlySelected === fileIndex && isActuallySelected) || hasProgress) {
      if (hasProgress) {
        log(`File ${fileIndex} has progress (${Math.floor((file.downloaded || 0) / 1024)}KB), avoiding re-selection to preserve download state`);
      } else {
        log(`File ${fileIndex} already selected and confirmed in WebTorrent, skipping`);
      }
      // Update our tracking to match reality if needed
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
        } catch (_) {}
      });

      this.selectedFiles.set(infoHash, fileIndex);
      this.prioritizeFilePieces(torrent, file);

      // Verify the selection actually worked
      const verifySelected = torrent.files[fileIndex].selected === true;
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
        const numPiecesToPrioritize = Math.min(5, Math.ceil((file.offset + 1024 * 1024) / pieceLength) - startPiece); // First 1MB worth of pieces
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
              log(`File ${fileIndex} proceeding after ${(elapsed/1000).toFixed(1)}s with ${progressPercent}% progress (${downloadedKB}KB)`);
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
              log(`File ${fileIndex} max extensions reached (${maxExtensions}), proceeding with ${progressPercent}% progress after ${(elapsed/1000).toFixed(1)}s`);
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
      torrent.files?.forEach(f => { try { f.deselect(); } catch (_) {} });
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
