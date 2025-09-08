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

module.exports = {
  booleanParam,
  buildTorrentCacheKeys,
  buildSourceCacheKeys
};
