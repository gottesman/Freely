const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const WebTorrent = require('webtorrent');
const http = require('http');
const https = require('https');
const { URL } = require('url');
let YtDlp = null;
try {
  ({ YtDlp } = require('ytdlp-nodejs'));
} catch (_) {
  console.warn('ytdlp-nodejs not installed; youtube features disabled');
}
// Monkey-patch to avoid ffmpeg/ffprobe auto-download since we only need metadata & direct audio URLs.
if (YtDlp && YtDlp.prototype) {
  for (const fn of ['downloadFFmpeg','ensureFFmpeg','downloadFFprobe','ensureFFprobe']) {
    if (typeof YtDlp.prototype[fn] === 'function') {
      try { YtDlp.prototype[fn] = async function () { return null; }; } catch (_) { /* ignore */ }
    }
  }
}
function createYtDlpInstance() {
  if (!YtDlp) return null;
  // Attempt to find an existing yt-dlp binary in common locations to avoid auto-download.
  const candidates = [];
  const platform = process.platform;
  const arch = process.arch;
  const binNames = platform === 'win32'
    ? ['yt-dlp.exe', 'yt-dlp_x86.exe']
    : ['yt-dlp', 'yt-dlp_macos', 'yt-dlp_linux_armv7l', 'yt-dlp_linux_aarch64'];
  try {
    // 1) Environment override
    if (process.env.YTDLP_BINARY_PATH) candidates.push(process.env.YTDLP_BINARY_PATH);
    // 2) Local bin folders relative to app (resource) dir
    const localBin = path.join(__dirname, 'bin');
    for (const n of binNames) candidates.push(path.join(localBin, n));
    // 3) One level up (in case bundler placed it differently)
    candidates.push(path.join(__dirname, '..', 'bin', 'yt-dlp'));
    // 4) System path hint (only try name; spawning will let wrapper resolve) – last resort
    binNames.forEach(n => candidates.push(n));
  } catch (_) { /* ignore path building errors */ }

  let chosen = null;
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) { chosen = c; break; } } catch (_) {}
  }

  const opts = { ffmpegPath: '', autoDownload: false, downloadFFmpeg: false };
  if (chosen) opts['binaryPath'] = chosen;

  try {
    const inst = new YtDlp(opts);
    if (chosen) console.log('[youtube] using existing yt-dlp binary', chosen);
    ///else console.warn('[youtube] no local yt-dlp binary found; wrapper may attempt download or fail');
    return inst;
  } catch (e) {
    console.warn('[youtube] failed to construct YtDlp instance with opts', e && e.message ? e.message : e);
    try {
      return new YtDlp();
    } catch (e2) {
      console.error('[youtube] fallback YtDlp() failed', e2 && e2.message ? e2.message : e2);
      return null;
    }
  }
}

// Log capability status once at startup
console.log('[youtube] capability', {
  loaded: !!YtDlp,
  patched: !!(YtDlp && typeof YtDlp.prototype.downloadFFmpeg === 'function' && YtDlp.prototype.downloadFFmpeg.toString().includes('return null'))
});
// Utilities extracted to utils.js (trimmed to only what this file uses)
const { computeMatchScore, booleanParam, buildSourceCacheKeys, scoreTorrentResults, initSearchCache, getSearchCacheEntry, setSearchCacheEntry, deleteSearchCacheEntry, clearSearchCache, persistSearchCacheSync, SEARCH_CACHE_TTL_SECONDS } = require('./utils.js');

const subdir = "data"

// Prevent crashes from unhandled promise rejections or exceptions in scrapers.
process.on('unhandledRejection', (reason, promise) => {
  try {
    console.warn('Unhandled Rejection at:', promise, 'reason:', reason && reason.stack ? reason.stack : reason);
  } catch (e) { /* ignore */ }
});
process.on('uncaughtException', (err) => {
  try {
    console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
  } catch (e) { /* ignore */ }
});

const upload = multer({ dest: path.join(__dirname, subdir) });
const client = new WebTorrent();
const app = express();
const PORT = process.env.PORT || 9000; // CACHE flag deprecated (was unused)
// Max entries to retain in in-memory YouTube info cache (LRU pruning)
const INFO_CACHE_MAX_ENTRIES = parseInt(process.env.YTDLP_INFO_CACHE_MAX_ENTRIES || '200', 10);

// Initialize file logging (write all console output into data/server.log & data/server.err.log)
(() => {
  try {
    const LOG_DIR = path.join(__dirname, subdir);
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const LOG_FILE = path.join(LOG_DIR, 'server.log');
    const ERR_FILE = path.join(LOG_DIR, 'server.err.log');
    const outStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const errStream = fs.createWriteStream(ERR_FILE, { flags: 'a' });
    const formatArg = (a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch (_) { return String(a); }
      }
      return String(a);
    };
    const write = (stream, level, args) => {
      const line = `[${new Date().toISOString()}] [${level}] ` + args.map(formatArg).join(' ') + '\n';
      stream.write(line);
    };
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    console.log = (...args) => { write(outStream, 'LOG', args); orig.log(...args); };
    console.info = (...args) => { write(outStream, 'INFO', args); orig.info(...args); };
    console.warn = (...args) => { write(errStream, 'WARN', args); orig.warn(...args); };
    console.error = (...args) => { write(errStream, 'ERROR', args); orig.error(...args); };
    process.on('exit', () => { try { outStream.end(); } catch (_) {} try { errStream.end(); } catch (_) {} });
  } catch (e) {
    // If file logging init fails, just continue with normal console.
    try { console.error('File logging init failed', e && e.message ? e.message : e); } catch (_) {}
  }
})();

// --- MODIFIED SECTION START ---

// Read the PID file path from the environment variable set by Tauri.
// Provide a fallback for local testing where the variable isn't set.
const PID_FILE = process.env.PID_FILE_PATH || path.join(__dirname, subdir, '.server.pid');
console.log(`Using PID file path: ${PID_FILE}`);

// --- MODIFIED SECTION END ---


// Simple CORS for dev: allow browser dev server to call this API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

let torrentSearchHelper;
try {
  // Webpack will understand this relative path during the build process
  // and bundle the contents of the file directly.
  torrentSearchHelper = require('./torrent-scrappers.js');
  console.log('Loaded scrappers for server API');
} catch (e) {
  console.warn('Could not load scrapper helper for server API:', e.message);
  // Assign a dummy object so the app doesn't crash if the file is missing
  torrentSearchHelper = { searchAll: () => Promise.resolve([]) };
}


// If a previous server left a PID file, attempt to terminate that process first.
function readPidFile() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, 'utf8');
    return JSON.parse(raw || 'null');
  } catch (e) { return null; }
}

async function killPid(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const signals = ['SIGINT','SIGTERM','SIGKILL'];
  for (const sig of signals) {
    try { process.kill(pid, sig); } catch (_) { }
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { process.kill(pid, 0); } catch { return true; }
    }
  }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

async function ensureNoExistingServer() {
  const info = readPidFile();
  if (!info || !info.pid) return;
  const pid = info.pid;
  try {
    const killed = await killPid(pid);
    if (killed) console.log(`Previous torrent server (pid ${pid}) terminated.`);
    else console.warn(`Previous torrent server (pid ${pid}) did not terminate.`);
  } catch (e) {
    console.warn('Error terminating previous server pid', e && e.message ? e.message : e);
  }
  try { fs.unlinkSync(PID_FILE); } catch (_) { }
}

// ytdlp info cache: target -> { ts, value } (search cache handled via utils)
const INFO_CACHE_TTL_MS = parseInt(process.env.YTDLP_INFO_CACHE_TTL_MS || String(1000 * 60 * 60 * 6), 10); // 6 hours default
const infoCache = new Map();

// Initialize disk-backed search cache (enabled via env SEARCH_CACHE_ENABLED=1)
initSearchCache(path.join(__dirname, subdir));


app.get('/ping', (req, res) => {
  console.log('Received ping request');
  res.json({ pong: true });
});

// NOTE: Former /api/torrent-search endpoint removed.
// Torrent searching is now fully handled via /api/source-search with ?torrents=1

// Unified source search endpoint for renderer (`source_search` Tauri command should call this)
// Supports: torrent search (existing), youtube search (when ytdlp-nodejs installed)
app.get('/api/source-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const year = String(req.query.year || '').trim();
  const page = parseInt(req.query.page || '1', 10) || 1;
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 200);
  const type = String(req.query.type || 'torrents').trim().toLowerCase();
  const includeTorrents = type == 'torrents'; // enable torrent results
  const includeYoutube = type == 'youtube'; // enable youtube results
  const debug = String(req.query.debug || '').trim() === '1';
  // Respect optional ?force=1 to bypass cache; default false enables caching
  const force = booleanParam(req.query.force || req.query.f);

  // Cache clear / key clear (superset of old /api/torrent-search controls)
  const clearCacheParam = booleanParam(req.query.clear_cache || req.query.clearCache);
  const clearIdParam = (req.query.clear_id || req.query.clearId || req.query.clearKey || req.query.clear) || null;

  const searchQuery = q || (title ? (title + (artist ? ' ' + artist : '')) : '');
  if (!searchQuery) return res.status(400).json({ error: 'query required' });
  const now = Date.now();

  // Build cache keys BEFORE potential clear so callers can easily derive keys by reusing params
  const { rawKey, normKey } = buildSourceCacheKeys(searchQuery, page, includeYoutube, includeTorrents);

  if (clearCacheParam) {
    try { clearSearchCache(); } catch (e) { return res.status(500).json({ error: String(e) }); }
    if (debug) console.log('[source-search] full cache cleared via API');
    return res.json({ cleared: true });
  }

  if (clearIdParam) {
    const key = String(clearIdParam);
    if (deleteSearchCacheEntry(key)) {
      if (debug) console.log('[source-search] cleared explicit cache key', key);
      return res.json({ cleared: true, id: key });
    }
    // also attempt to remove the norm/raw variants for this request if they match
    let removed = false;
    if (key === normKey && deleteSearchCacheEntry(normKey)) removed = true;
    if (key === rawKey && deleteSearchCacheEntry(rawKey)) removed = true;
    return res.json({ cleared: removed, id: key, reason: removed ? undefined : 'not-found' });
  }

  if (!force) {
    const cached = getSearchCacheEntry(normKey) || getSearchCacheEntry(rawKey);
    if (cached && (now - cached.ts) < SEARCH_CACHE_TTL_SECONDS * 1000) {
      if (debug) console.log('[source-search] cache hit', { normKey, includeYoutube, includeTorrents });
      return res.json(Array.isArray(cached.value) ? cached.value.slice() : cached.value);
    } else if (debug) {
      console.log('[source-search] cache miss', { normKey, includeYoutube, includeTorrents });
    }
  } else if (debug) {
    console.log('[source-search] force refresh requested; skipping cache', { normKey });
  }

  const results = [];

  if (includeYoutube && YtDlp) {
    console.log('[source-search] performing youtube search for', searchQuery);
    try {
      const ytdlp = createYtDlpInstance();
  if (!ytdlp) throw new Error('ytdlp unavailable');
      const searchTarget = `ytmusicsearch5:${searchQuery}`;
      const SEARCH_TIMEOUT_MS = Number(process.env.YTDLP_SEARCH_TIMEOUT_MS || req.query.searchTimeout || 7000);
      let info;
      try {
        info = await Promise.race([
          ytdlp.getInfoAsync(searchTarget, { args: ['--no-warnings','--no-config','--dump-single-json','--no-playlist','--socket-timeout','3','--retries','0'] }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('ytdlp-info-timeout')), SEARCH_TIMEOUT_MS))
        ]);
      } catch (e) {
        // fallback to ytsearch if ytmusicsearch unsupported
        try {
          info = await Promise.race([
            ytdlp.getInfoAsync(`ytsearch5:${searchQuery}`, { args: ['--no-warnings','--no-config','--dump-single-json','--no-playlist','--socket-timeout','3','--retries','0'] }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ytdlp-info-timeout')), SEARCH_TIMEOUT_MS))
          ]);
        } catch (e2) { console.warn('[source-search] ytdlp search fallbacks failed', e2 && e2.message ? e2.message : e2); }
      }

      const entries = Array.isArray(info?.entries) ? info.entries : (info ? [info] : []);
      if (!entries.length) {
        console.warn('[source-search] youtube search returned no entries (timeout? network?); target:', searchQuery);
      }
      const scored = [];
      const queryTitleForScore = title || q || searchQuery || '';
      const queryArtistForScore = artist || '';
      const stripParen = (s) => String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g,' ').trim();
      const coreQuery = stripParen(queryTitleForScore);
      const coreQueryTokens = coreQuery.toLowerCase().split(/\s+/).filter(Boolean);
      for (const e of entries.slice(0, limit)) {
        const ytTitle = e.title || '';
        const candidateArtist = e.uploader || '';
        let s = computeMatchScore(queryTitleForScore, queryArtistForScore, ytTitle, candidateArtist);
        // Heuristic boost: if stripped candidate contains most of the stripped query tokens
        if (coreQueryTokens.length) {
          const coreCandidate = stripParen(ytTitle).toLowerCase();
            let covered = 0;
            for (const tok of coreQueryTokens) if (coreCandidate.includes(tok)) covered++;
            const coverage = covered / coreQueryTokens.length;
            if (coverage >= 0.8) {
              // Boost but cap at 85 to still allow ordering by other factors
              s = Math.max(s, Math.min(85, Math.round(s + 20 * coverage)));
            }
        }
        if (debug) console.log('[source-search][yt-score]', { ytTitle, candidateArtist, s });
        scored.push({ entry: e, _score: s });
      }

      // filter threshold and sort
      const MIN_SCORE = 40; // relaxed threshold after improved scoring heuristics
      scored.sort((a, b) => b._score - a._score);
      let accepted = 0;
      for (const item of scored) {
        if ((item._score || 0) < MIN_SCORE) break; // ensure at least a few candidates
        const e = item.entry;
        results.push({
          type: 'youtube',
          title: e.title || null,
          source: 'youtube',
          id: e.id || null,
          url: e.webpage_url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
          duration: e.duration || null,
          uploader: e.uploader || null,
          _score: item._score,
          //raw: e
        });
      }
    } catch (e) {
      if (debug) console.warn('[source-search] youtube search failed', e && e.message ? e.message : e);
    }
  }

  if (includeTorrents && torrentSearchHelper && torrentSearchHelper.searchAll) {
    try {
      const opts = { query: searchQuery, title: title || undefined, artist: artist || undefined, year: year || undefined, page };
      const tResults = await torrentSearchHelper.searchAll(opts);
        if (Array.isArray(tResults) && tResults.length) {
          // map to unified shape and compute scores using hoisted computeMatchScore
          const queryTitle = title || searchQuery || '';
          const scoredTorrentItems = scoreTorrentResults(tResults.slice(0, limit), queryTitle, artist || '');
          for (const t of scoredTorrentItems) {
            const this_result ={
              type: 'torrent',
              title: t.title || t.name || null,
              source: t.source || 'torrent',
              infoHash: t.infoHash || null,
              magnetURI: t.magnetURI || null,
              seeders: t.seeders ?? t.seeds ?? null,
              size: t.size || t.filesize || null,
              _score: t._score,
              //raw: t
            };
            if(this_result.seeders > 0 ){
              results.push(this_result);
            }
          }
        }
    } catch (e) {
      if (debug) console.warn('[source-search] torrent search failed', e && e.message ? e.message : e);
    }
  }

  // sort by _score descending when present; items without _score go afterwards
  /*
  results.sort((a, b) => {
    const sa = (typeof a._score === 'number') ? a._score : -1;
    const sb = (typeof b._score === 'number') ? b._score : -1;
    return sb - sa;
  });
  */

  const finalResults = results.slice(0, limit);
  // Cache successful search (even if empty) unless force
  if (!force) {
    try {
      const cacheValue = Array.isArray(finalResults) ? finalResults.slice() : finalResults;
      setSearchCacheEntry(normKey, { ts: now, value: cacheValue });
      try { setSearchCacheEntry(rawKey, { ts: now, value: cacheValue }); } catch (_) {}
    } catch (_) { /* ignore cache errors */ }
  }
  res.json(finalResults);
});

// Simple in-memory map of infoHash -> { torrent, mimeType, name }
const torrents = new Map();

const trackers = [
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.opentrackr.org:1337',
  'udp://tracker.leechers-paradise.org:6969',
  'udp://tracker.coppersurfer.tk:6969',
  'wss://tracker.btorrent.xyz',
];

app.post('/seed', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const filePath = req.file.path;
  const mimeType = req.file.mimetype || 'application/octet-stream';
  const originalName = req.file.originalname || req.file.filename;
  console.log('Seeding file at', filePath, 'mime:', mimeType);

  client.seed(
    filePath,
    { announce: trackers },
    (torrent) => {
      console.log('Seeding torrent:', torrent.infoHash);
      torrents.set(torrent.infoHash, { torrent, mimeType, name: originalName });
      res.json({
        infoHash: torrent.infoHash,
        magnetURI: torrent.magnetURI,
        streamUrl: `/stream/${torrent.infoHash}`,
        mimeType,
        name: originalName,
      });
    }
  );
});

app.get('/stream/:infoHash', async (req, res) => {
  const infoHash = req.params.infoHash;
  const torrent = client.get(infoHash) || torrents.get(infoHash);
  if (!torrent) return res.status(404).end('Torrent not found');

  // Use the first file in the torrent for streaming
  const file = torrent.files[0];
  if (!file) return res.status(404).end('No file in torrent');

  // Wait until file length / pieces available
  const waitForReady = () =>
    new Promise((resolve) => {
      if (file.length) return resolve();
      torrent.on('ready', resolve);
    });

  await waitForReady();

  const range = req.headers.range;
  let start = 0;
  let end = file.length - 1;
  if (range) {
    const matches = /bytes=(\d+)-(\d+)?/.exec(range);
    if (matches) {
      start = parseInt(matches[1], 10);
      if (matches[2]) end = parseInt(matches[2], 10);
    }
  }

  // Try to read stored mimeType for this torrent
  const stored = torrents.get(infoHash);
  const mimeTypeHeader = stored?.mimeType || 'application/octet-stream';

  res.status(range ? 206 : 200);
  res.set({
    'Content-Type': mimeTypeHeader,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${file.length}`,
  });

  const stream = file.createReadStream({ start, end });
  stream.pipe(res);

  res.on('close', () => {
    try { stream.destroy(); } catch (e) { }
  });
});

app.get('/status/:infoHash', (req, res) => {
  const infoHash = req.params.infoHash;
  const stored = torrents.get(infoHash);
  if (!stored) return res.status(404).json({ error: 'not found' });
  const { torrent, mimeType, name } = stored;
  res.json({
    infoHash: torrent.infoHash,
    magnetURI: torrent.magnetURI,
    name,
    mimeType,
    progress: torrent.progress || 0,
    numPeers: torrent.numPeers || 0,
  });
});

// YouTube streaming endpoint: /source/youtube?id=<id>&get=info|stream&debug=1
// Streams audio from video. This endpoint requires ytdlp-nodejs to be installed.
app.get('/source/youtube', async (req, res) => {
  const debug = String(req.query.debug || '').trim() === '1';
  const raw = String(req.query.id || req.query.url || '').trim();
  const INFO_TIMEOUT = Number(req.query.infoTimeout || 10000); // ms for info lookup
  const PROXY_FIRST_BYTE_TIMEOUT = Number(req.query.fbTimeout || 3000); // ms for proxied CDN
  const formatPreference = 'bestaudio[ext=m4a]'; // try to prefer m4a, otherwise best audio

  const tStart = Date.now();
  if (debug) console.log('[audio/stream] incoming', { raw, formatPreference });

  // operation mode: 'info' (default) returns metadata, 'stream' streams audio
  const mode = String(req.query.get || 'info').toLowerCase();

  // allow callers to use search mode without providing an id/url
  if (!raw && mode !== 'search') return res.status(400).json({ error: 'id or url required' });

  // normalize target (conservative) for info/stream modes
  let target;
  if (mode !== 'search') {
    if (/^https?:\/\//i.test(raw)) target = raw;
    else target = `https://www.youtube.com/watch?v=${encodeURIComponent(raw)}`;

    if (debug) console.log('[audio/stream] target =', target);
  }

  // Helper: pick audio-only format from parsed info
  function pickAudioFormat(info) {
    if (!info || !Array.isArray(info.formats)) return null;

    // prefer requested_formats (present when -f chosen)
    if (info.requested_formats && info.requested_formats[0] && info.requested_formats[0].url) {
      return info.requested_formats[0];
    }

    // Candidate predicates - prefer m4a/mp4, then webm/opus, then any format with acodec != 'none'
    const preferExts = ['m4a', 'mp4', 'webm', 'opus', 'aac', 'mp3', 'vorbis'];
    // Try preferred ext with url
    for (const ext of preferExts) {
      const f = info.formats.find(ff => ff.ext === ext && ff.url && ff.acodec && ff.acodec !== 'none');
      if (f) return f;
    }
    // fallback: any format with audio codec and URL
    const anyAudio = info.formats.find(ff => ff.url && ff.acodec && ff.acodec !== 'none');
    if (anyAudio) return anyAudio;
    return null;
  }

  // Helper: proxy CDN url to response; returns a promise that resolves when pipe ends or rejects on error
  function proxyUrl(urlStr) {
    return new Promise((resolve, reject) => {
      let parsed;
      try { parsed = new URL(urlStr); } catch (e) { return reject(new Error('invalid-format-url')); }

      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const headers = {
        'User-Agent': req.get('User-Agent') || 'node.js',
        // forward incoming Range header (if any) to upstream so CDN can honor seeks
      };
      if (req.headers.range) headers.Range = req.headers.range;

      const opts = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: PROXY_FIRST_BYTE_TIMEOUT
      };

      if (debug) console.log('[audio/stream] proxy opts', opts);

    // guard to prevent double resolve/reject
    let settled = false;
    const doResolve = () => { if (settled) return; settled = true; try { resolve(); } catch (_) {} };
    const doReject = (err) => { if (settled) return; settled = true; try { reject(err); } catch (_) {} };

    const upstreamReq = lib.request(opts, upstreamRes => {
        // copy status and headers (selectively)
        if (!res.headersSent) {
          res.statusCode = upstreamRes.statusCode || 200;
          // copy content-type and content-length if present
          if (upstreamRes.headers['content-type']) res.setHeader('Content-Type', upstreamRes.headers['content-type']);
          if (upstreamRes.headers['content-length']) res.setHeader('Content-Length', upstreamRes.headers['content-length']);
      // copy content-range if upstream provided it (important for ranged responses)
      if (upstreamRes.headers['content-range']) res.setHeader('Content-Range', upstreamRes.headers['content-range']);
          // forward accept-ranges or other useful headers
          if (upstreamRes.headers['accept-ranges']) res.setHeader('Accept-Ranges', upstreamRes.headers['accept-ranges']);
        }

        // first-byte guard: if we don't get any 'data' event soon, kill request
        let first = false;
        const firstTimer = setTimeout(() => {
          if (!first) {
            if (debug) console.warn('[audio/stream] proxy first-byte timeout, aborting upstream request');
            try { upstreamReq.abort(); } catch (_) { try { upstreamReq.destroy(); } catch (_) {} }
            doReject(new Error('proxy-first-byte-timeout'));
            // downstream response will be ended by error handlers below
          }
        }, PROXY_FIRST_BYTE_TIMEOUT);

        upstreamRes.on('data', chunk => {
          if (!first) {
            first = true;
            clearTimeout(firstTimer);
            if (debug) console.log('[audio/stream] first-byte from CDN after', Date.now() - tStart, 'ms');
          }
        });

        upstreamRes.on('end', () => {
          clearTimeout(firstTimer);
        });

        upstreamRes.on('close', () => {
          clearTimeout(firstTimer);
          if (debug) console.warn('[audio/stream] upstreamRes closed');
          if (!first) {
            doReject(new Error('upstream-closed-before-first-byte'));
          }
        });

        upstreamRes.on('error', err => {
          clearTimeout(firstTimer);
          if (debug) console.error('[audio/stream] upstreamRes error', err && err.message ? err.message : err);
          doReject(err);
        });

        upstreamRes.pipe(res).on('finish', () => {
          clearTimeout(firstTimer);
          if (debug) console.log('[audio/stream] proxy finished');
          doResolve();
        }).on('error', err => {
          clearTimeout(firstTimer);
          if (debug) console.error('[audio/stream] proxy stream error', err && err.message ? err.message : err);
          doReject(err);
        });
      });

      upstreamReq.on('timeout', () => {
        if (debug) console.warn('[audio/stream] upstream request socket timeout');
        try { upstreamReq.abort(); } catch (_) { try { upstreamReq.destroy(); } catch (_) {} }
        doReject(new Error('upstream-timeout'));
      });

      upstreamReq.on('error', (err) => {
        if (debug) console.error('[audio/stream] upstream request error', err && err.message ? err.message : err);
        doReject(err);
      });

      // if client disconnects, abort the upstream request and reject
      req.on('close', () => {
        if (debug) console.log('[audio/stream] client disconnected, aborting upstream request');
        try { upstreamReq.abort(); } catch (_) { try { upstreamReq.destroy(); } catch (_) {} }
        doReject(new Error('client-disconnected'));
      });

      upstreamReq.end();
    });
  }

  // MAIN FLOW
  try {
    // quick early header so client can start
    if (!res.headersSent) {
      res.setHeader('Accept-Ranges', 'bytes');
      // set Content-Type to JSON for info/search modes, otherwise default to octet-stream
      const earlyContentType = (mode === 'search' || mode === 'info') ? 'application/json' : 'application/octet-stream';
      res.setHeader('Content-Type', earlyContentType);
    }

      // Ensure the ytdlp wrapper is available
      if (!YtDlp) {
        if (debug) console.warn('[audio/stream] ytdlp-nodejs not installed; endpoint unavailable');
        return res.status(501).json({ error: 'ytdlp-nodejs not installed' });
      }

      // instantiate wrapper and get info JSON (with timeout)
      const ytdlp = createYtDlpInstance(); // patched instance (no ffmpeg download)
      if (!ytdlp) {
        if (debug) console.warn('[audio/stream] ytdlp unavailable after patch');
        return res.status(501).json({ error: 'ytdlp unavailable' });
      }

      // Build a set of args intended to make yt-dlp info lookup faster.
      // Assumption: YtDlp.getInfoAsync accepts an options object with `args` (common wrappers do).
      // If the wrapper rejects this signature, we fall back to the original call.
      const preferFormat = req.query.format || formatPreference;
      // Aggressive args to speed up info extraction and fail fast on slow extractors
      const infoArgs = [
        '--no-warnings',         // quieter
        '--no-config',           // don't load user config which can slow startup
        '--no-playlist',         // don't try to resolve playlists
        '--skip-download',       // don't attempt any download
        '--no-call-home',        // avoid network telemetry
        '--no-check-certificate',
        '--no-mtime',
        '--no-embed-thumbnail',
        '--dump-single-json',    // output single json blob quickly
        '--socket-timeout', '2', // short socket timeout (seconds) to fail fast
        '--retries', '0',        // avoid retry delays
        '--no-simulate',
        '-f', preferFormat
      ];

      if (debug) console.log('[audio/stream] ytdlp info args', infoArgs);

      // Search mode has moved to /api/source-search which returns unified results
      if (mode === 'search') {
        return res.status(307).json({ error: 'moved', reason: 'use /api/source-search?q=... or title/artist params' });
      }

      // try preferred faster call, but if it fails, fallback to the basic call
      let infoPromise;
      try {
        infoPromise = ytdlp.getInfoAsync(target, { args: infoArgs });
      } catch (e) {
        if (debug) console.warn('[audio/stream] wrapper does not accept args option, falling back to basic call');
        infoPromise = ytdlp.getInfoAsync(target);
      }

      // allow clients to force-refresh info
      const forceInfo = String(req.query.forceInfo || req.query.force || '').toLowerCase() === '1' || String(req.query.forceInfo || req.query.force || '').toLowerCase() === 'true';

      // Try cached info first (fast path)
      let info = null;
      try {
        if (!forceInfo) {
          const cached = infoCache.get(target);
          if (cached && (Date.now() - cached.ts) < INFO_CACHE_TTL_MS) {
            if (debug) console.log('[audio/stream] using cached yt-dlp info for', target);
            info = cached.value;
          }
        }

        if (!info) {
          // enforce INFO_TIMEOUT when retrieving info from yt-dlp
          info = await Promise.race([
            infoPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('ytdlp-info-timeout')), INFO_TIMEOUT))
          ]).catch(err => { throw err; });

          // cache the info for future requests with simple LRU pruning
          try {
            infoCache.set(target, { ts: Date.now(), value: info });
            if (infoCache.size > INFO_CACHE_MAX_ENTRIES) {
              const entries = Array.from(infoCache.entries()).sort((a,b) => a[1].ts - b[1].ts); // oldest first
              for (let i = 0; i < entries.length - INFO_CACHE_MAX_ENTRIES; i++) {
                infoCache.delete(entries[i][0]);
              }
            }
          } catch (_) { /* ignore cache failures */ }
        }
      } catch (e) {
        throw e;
      }

    const chosen = pickAudioFormat(info);
    if (!chosen || !chosen.url) {
      // No direct audio-only format available — avoiding ffmpeg per your request.
      if (debug) console.warn('[audio/stream] no direct audio format with URL found in info; formats:', Array.isArray(info?.formats) ? info.formats.map(f => f.ext).slice(0,10) : 'none');
      return res.status(422).json({ error: 'no direct audio-only format available; would require remux/merge (ffmpeg)' });
    }

    if (debug) console.log('[audio/stream] chosen format ext=', chosen.ext, 'acodec=', chosen.acodec, 'urlPresent=', !!chosen.url);

    // If caller only wants info, return quick metadata JSON
    if (mode === 'info') {
      const metadata = {
        title: info?.title || null,
        duration: info?.duration || null,
        uploader: info?.uploader || info?.uploader_id || null,
        format: {
          ext: chosen.ext || null,
          acodec: chosen.acodec || null,
          mime_type: chosen.mime_type || null,
          url: chosen.url || null,
          filesize: chosen.filesize || chosen.filesize_approx || null,
        },
        requested_at: Date.now(),
      };
      return res.json(metadata);
    }

    /*
    // Set precise Content-Type if available
    if (!res.headersSent) {
      if (chosen.mime_type) res.setHeader('Content-Type', chosen.mime_type.split(';')[0]);
      else if (chosen.ext === 'm4a' || chosen.ext === 'mp4') res.setHeader('Content-Type', 'audio/mp4');
      else if (chosen.ext === 'webm' || chosen.ext === 'opus') res.setHeader('Content-Type', 'audio/webm');
    } else {
      // If headers already sent keep them
    }
    */

    // Proxy the direct CDN url to the response (no ffmpeg)
    try {
      await proxyUrl(chosen.url);
      return;
    } catch (proxyErr) {
      if (debug) console.warn('[audio/stream] primary CDN proxy failed', proxyErr && proxyErr.message ? proxyErr.message : proxyErr);

      // Attempt fallback candidate formats from info.formats (avoid chosen again)
      if (Array.isArray(info?.formats) && info.formats.length) {
        const tried = new Set();
        tried.add(chosen.url);
        // prefer formats with audio and url
        const candidates = info.formats
          .filter(f => f && f.url && f.acodec && f.acodec !== 'none')
          // keep requested_formats first if present
          .sort((a, b) => (a.requested ? -1 : 0) - (b.requested ? -1 : 0));

        for (const fmt of candidates) {
          try {
            if (!fmt.url || tried.has(fmt.url)) continue;
            if (debug) console.log('[audio/stream] trying fallback format', fmt.ext || fmt.format || 'unknown');
            tried.add(fmt.url);
            await proxyUrl(fmt.url);
            return;
          } catch (e2) {
            if (debug) console.warn('[audio/stream] fallback format failed', e2 && e2.message ? e2.message : e2);
            // try next
          }
        }
      }

      // All attempts failed
      if (!res.headersSent) {
        return res.status(502).json({ error: 'failed to proxy any CDN url', reason: proxyErr?.message || String(proxyErr) });
      } else {
        try { res.end(); } catch (_) {}
        return;
      }
    }
  } catch (err) {
    if (debug) console.error('[audio/stream] unexpected error', err && err.stack ? err.stack : err);
    try { if (!res.headersSent) res.status(500).json({ error: err?.message || String(err) }); else res.end(); } catch (_) {}
  }
});

// Start server with retry on EADDRINUSE so running multiple dev instances doesn't crash
let _server = null;

// --- MODIFIED SECTION START ---

function writePidFile(port) {
  try {
    // Ensure the parent directory exists before writing the file.
    const pidDir = path.dirname(PID_FILE);
    if (!fs.existsSync(pidDir)) {
      fs.mkdirSync(pidDir, { recursive: true });
    }

    const info = { pid: process.pid, port: port, startedAt: Date.now() };
    fs.writeFileSync(PID_FILE, JSON.stringify(info), { encoding: 'utf8' });
    console.log(`Successfully wrote PID info to: ${PID_FILE}`);
  } catch (e) {
    // This is a critical failure, log it clearly.
    console.error(`CRITICAL: Failed to write PID file to ${PID_FILE}. The app backend will not be able to connect.`);
    console.error(e);
  }
}

// --- MODIFIED SECTION END ---


async function tryListen(port, attempts = 5) {
  // Ensure any previous server (from a previous run) is terminated first.
  try {
    await ensureNoExistingServer();
  } catch (e) {
    console.warn('Error while ensuring no existing server:', e && e.message ? e.message : e);
    // proceed anyway
  }

  return new Promise((resolve, reject) => {
    try {
      _server = app.listen(port, () => {
        console.log(`Torrent server listening on http://localhost:${port}`);
        // write PID file now that we have successfully bound
        writePidFile(port);
        resolve(port);
      });

      _server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && attempts > 0) {
          console.warn(`Port ${port} in use, trying ${port + 1}...`);
          setTimeout(() => {
            tryListen(port + 1, attempts - 1).then(resolve).catch(reject);
          }, 200);
        } else {
          console.error('Server listen error', err && err.message ? err.message : err);
          reject(err);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

process.on('exit', () => { try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) { } });

tryListen(PORT).catch((e) => {
  console.error('Failed to start torrent server:', e && e.message ? e.message : e);
  process.emit('exit');
});

function gracefulShutdown() {
  console.log('Shutting down torrent server...');
  try { persistSearchCacheSync(); } catch (_) { }
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) { }
  try { client.destroy(() => process.exit(0)); } catch (_) { process.exit(0); }
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('exit', () => { try { persistSearchCacheSync(); } catch (_) { } });