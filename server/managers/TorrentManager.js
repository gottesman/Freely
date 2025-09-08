/**
 * Optimized torrent management
 */
class TorrentManager {
  constructor() {
    if (TorrentManager.instance) {
      return TorrentManager.instance;
    }
    
    this.torrents = new Map();
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
      TorrentManager.instance = new TorrentManager();
    }
    return TorrentManager.instance;
  }

  addTorrent(infoHash, torrent, mimeType, name) {
    this.torrents.set(infoHash, { torrent, mimeType, name });
  }

  getTorrent(infoHash) {
    return this.torrents.get(infoHash);
  }

  removeTorrent(infoHash) {
    return this.torrents.delete(infoHash);
  }

  getStatus(infoHash) {
    const stored = this.torrents.get(infoHash);
    if (!stored) return null;

    const { torrent, mimeType, name } = stored;
    return {
      infoHash: torrent.infoHash,
      magnetURI: torrent.magnetURI,
      name,
      mimeType,
      progress: torrent.progress || 0,
      numPeers: torrent.numPeers || 0,
    };
  }

  getTrackers() {
    return this.trackers;
  }
}

module.exports = TorrentManager;
