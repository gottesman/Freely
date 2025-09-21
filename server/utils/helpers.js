const { app } = require('@tauri-apps/api');
const { normalizeKey } = require('./stringUtils');

/**
 * Parse boolean parameter from query string
 */
function booleanParam(v) {
  return ['1','true','yes','on'].includes(String(v).toLowerCase());
}

/**
 * Build torrent cache keys for legacy compatibility
 */
function buildTorrentCacheKeys(q, title, artist, year, page) {
  // Preserve legacy raw key format (no prefix) and normalized variant
  const rawKey = `${String(q)}::${String(title)}::${String(artist)}::${String(year)}::${page}`;
  const normKey = `${normalizeKey(q)}::${normalizeKey(title)}::${normalizeKey(artist)}::${normalizeKey(year)}::${page}`;
  return { rawKey, normKey };
}

/**
 * Build source cache keys for unified search
 */
function buildSourceCacheKeys(searchQuery, page, includeYoutube, includeTorrents) {
  const rawKey = `source::${String(searchQuery)}::${String(page)}::yt=${includeYoutube}::t=${includeTorrents}`;
  const normKey = `source::${normalizeKey(searchQuery)}::${String(page)}::yt=${includeYoutube}::t=${includeTorrents}`;
  return { rawKey, normKey };
}

const getUserDataDir = (folder = '') => {
  if (!folder) {
    folder = 'general';
  }
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const platform = os.platform();
  const homeDir = os.homedir();
  let appDataDir;
  
  switch (platform) {
    case 'win32':
      // Windows: Use APPDATA environment variable or fallback
      appDataDir = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming', 'Freely Player', folder);
    case 'darwin':
      // macOS: Application Support directory
      appDataDir = path.join(homeDir, 'Library', 'Application Support', 'Freely Player', folder);
    default:
      // Linux and others: XDG data directory or fallback
      appDataDir = process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share', 'Freely Player', folder);
  }
  if (!fs.existsSync(appDataDir)) {
    fs.mkdirSync(appDataDir, { recursive: true });
  }
  return appDataDir;
};

module.exports = {
  booleanParam,
  buildTorrentCacheKeys,
  buildSourceCacheKeys,
  getUserDataDir
};
