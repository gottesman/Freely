// Shared utility functions for server logic: normalization, scoring, simple fuzzy matching.
// Keeping this lightweight (no external deps) to avoid increasing bundle size.

// Normalize strings for approximate matching (retain spaces, alphanum only, collapse whitespace)
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalization for cache keys / query components (tokenized & rejoined)
function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function tokens(s) {
  return normalizeForMatch(s)
    .split(' ')
    .filter(Boolean)
    .filter(t => t.length > 1);
}

function intersectionCount(a, b) {
  const setB = new Set(b);
  let c = 0;
  for (const x of a) if (setB.has(x)) c++;
  return c;
}

// Simple Levenshtein distance (iterative DP) for fuzzy fallback
function levenshtein(a, b) {
  a = String(a || '');
  b = String(b || '');
  const n = a.length, m = b.length;
  if (!n) return m; if (!m) return n;
  const dp = Array(m + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,        // deletion
        dp[j - 1] + 1,    // insertion
        prev + cost       // substitution
      );
      prev = tmp;
    }
  }
  return dp[m];
}

// Compute a composite score (0..100) representing similarity of candidate to query
function computeMatchScore(queryTitle, queryArtist, candidateTitle, candidateArtist) {
  const qTitleNorm = normalizeForMatch(queryTitle || '');
  const qArtistNorm = normalizeForMatch(queryArtist || '');
  const cTitleNorm = normalizeForMatch(candidateTitle || '');
  const cArtistNorm = normalizeForMatch(candidateArtist || '');

  const qTokens = tokens(qTitleNorm);
  const cTokens = tokens(cTitleNorm);
  const tkMatch = qTokens.length ? (intersectionCount(qTokens, cTokens) / qTokens.length) : 0;

  const exactTitleBonus = qTitleNorm && cTitleNorm.includes(qTitleNorm) ? 1 : 0;
  const artistMatch = qArtistNorm && cArtistNorm ? (
    cArtistNorm.includes(qArtistNorm) ||
    intersectionCount(tokens(qArtistNorm), tokens(cArtistNorm)) > 0 ? 1 : 0
  ) : 0;

  const yearRe = /\b(19|20)\d{2}\b/;
  const yearMatch = (
    yearRe.test(qTitleNorm) &&
    yearRe.test(cTitleNorm) &&
    qTitleNorm.match(yearRe)[0] === cTitleNorm.match(yearRe)[0]
  ) ? 1 : 0;

  let editSim = 0;
  try {
    const d = levenshtein(qTitleNorm, cTitleNorm);
    const maxL = Math.max(1, qTitleNorm.length, cTitleNorm.length);
    editSim = 1 - (d / maxL);
    if (editSim < 0) editSim = 0;
  } catch (_) { /* ignore */ }

  const score = Math.round(100 * (
    0.55 * tkMatch +
    0.20 * exactTitleBonus +
    0.15 * artistMatch +
    0.05 * yearMatch +
    0.05 * editSim
  ));
  return Math.max(0, Math.min(100, score));
}

// --- Additional helpers ---

function booleanParam(v) {
  return ['1','true','yes','on'].includes(String(v).toLowerCase());
}

function buildTorrentCacheKeys(q, albumTitle, artist, year, page) {
  // Preserve legacy raw key format (no prefix) and normalized variant
  const rawKey = `${String(q)}::${String(albumTitle)}::${String(artist)}::${String(year)}::${page}`;
  const normKey = `${normalizeKey(q)}::${normalizeKey(albumTitle)}::${normalizeKey(artist)}::${normalizeKey(year)}::${page}`;
  return { rawKey, normKey };
}

function buildSourceCacheKeys(searchQuery, page, includeYoutube, includeTorrents) {
  const rawKey = `source::${String(searchQuery)}::${String(page)}::yt=${includeYoutube}::t=${includeTorrents}`;
  const normKey = `source::${normalizeKey(searchQuery)}::${String(page)}::yt=${includeYoutube}::t=${includeTorrents}`;
  return { rawKey, normKey };
}

function scoreTorrentResults(results, queryTitle, artist) {
  if (!Array.isArray(results)) return [];
  const out = [];
  for (const t of results) {
    const titleCandidate = String(t.title || t.name || '');
    const artistCandidate = String(t.artist || t.uploader || '');
    const score = computeMatchScore(queryTitle || '', artist || '', titleCandidate, artistCandidate || '');
    out.push(Object.assign({}, t, { _score: score }));
  }
  out.sort((a, b) => (b._score || 0) - (a._score || 0));
  return out;
}

// --- Search cache subsystem (disk-persisted when enabled) ---
// (Kept lightweight; no external deps.)
const fs = require('fs');
const path = require('path');

const SEARCH_CACHE_TTL_SECONDS = parseInt(process.env.TORRENT_SEARCH_CACHE_TTL_SECONDS || '86400', 10);
let _cacheMap = null; // Map instance
let _cacheFile = null;
let _cacheEnabled = false;
let _saveTimer = null;

function initSearchCache(dir, filename = 'search-cache.json', enabledFlag = process.env.SEARCH_CACHE_ENABLED) {
  _cacheEnabled = ['1','true','yes','on'].includes(String(enabledFlag || '').toLowerCase());
  _cacheFile = path.join(dir, filename);
  _cacheMap = new Map();
  if (!_cacheEnabled) return; // in-memory only when disabled
  try {
    if (!fs.existsSync(_cacheFile)) return;
    const raw = fs.readFileSync(_cacheFile, 'utf8');
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (!entry || !entry.ts) continue;
      if ((now - entry.ts) < SEARCH_CACHE_TTL_SECONDS * 1000) {
        _cacheMap.set(key, entry);
      }
    }
  } catch (e) {
    console.warn('[cache] load failed', e && e.message ? e.message : e);
  }
}

function schedulePersist() {
  if (!_cacheEnabled) return;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    (async () => {
      try {
        const serial = JSON.stringify(Array.from(_cacheMap.entries()));
        await fs.promises.writeFile(_cacheFile, serial, { encoding: 'utf8' });
      } catch (e) {
        console.warn('[cache] persist failed', e && e.message ? e.message : e);
      } finally {
        _saveTimer = null;
      }
    })();
  }, 750);
}

function persistSearchCacheSync() {
  if (!_cacheEnabled) return;
  try {
    const serial = JSON.stringify(Array.from(_cacheMap.entries()));
    fs.writeFileSync(_cacheFile, serial, { encoding: 'utf8' });
  } catch (e) {
    console.warn('[cache] sync persist failed', e && e.message ? e.message : e);
  }
}

function getSearchCacheEntry(key) {
  return _cacheMap.get(key);
}

function setSearchCacheEntry(key, value) {
  _cacheMap.set(key, value);
  schedulePersist();
}

function deleteSearchCacheEntry(key) {
  const existed = _cacheMap.delete(key);
  if (existed) schedulePersist();
  return existed;
}

function clearSearchCache() {
  _cacheMap.clear();
  if (_cacheEnabled) {
    try { if (fs.existsSync(_cacheFile)) fs.unlinkSync(_cacheFile); } catch (_) { }
  }
}

module.exports = {
  normalizeForMatch,
  normalizeKey,
  tokens,
  intersectionCount,
  levenshtein,
  computeMatchScore,
  booleanParam,
  buildTorrentCacheKeys,
  buildSourceCacheKeys,
  scoreTorrentResults,
  initSearchCache,
  getSearchCacheEntry,
  setSearchCacheEntry,
  deleteSearchCacheEntry,
  clearSearchCache,
  persistSearchCacheSync,
  schedulePersist,
  SEARCH_CACHE_TTL_SECONDS
};
