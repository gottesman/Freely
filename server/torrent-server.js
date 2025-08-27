const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const WebTorrent = require('webtorrent');
const subdir = "data"

const upload = multer({ dest: path.join(__dirname, subdir) });
const client = new WebTorrent();
const app = express();
const PORT = process.env.PORT || 9000;
const PID_FILE = path.join(__dirname, subdir, '.torrent-server.pid');

// Simple CORS for dev: allow browser dev server to call this API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Optional: load torrent-search helper (reuse same scrapers used by Electron main)
let torrentSearchHelper;
try {
  torrentSearchHelper = require(path.join(__dirname, '..', 'electron', 'torrent-search.js'));
} catch (e) {
  console.warn('Could not load torrent-search helper for server API:', e?.message || e);
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
  try {
    // Check if process exists
    process.kill(pid, 0);
  } catch (e) {
    return false; // not running
  }
  try {
    // Try graceful
    try { process.kill(pid, 'SIGINT'); } catch (_) { try { process.kill(pid); } catch (_) {} }
  } catch (_) {}
  // Wait briefly for exit
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); } catch (e) { return true; }
    await new Promise(r => setTimeout(r, 100));
  }
  // Force kill if still running
  try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  try { process.kill(pid, 0); return false; } catch (e) { return true; }
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
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}

// Expose a simple JSON API for torrent searching so the renderer (vite) can use it in dev
// Simple in-memory cache for search responses (with disk persistence)
const SEARCH_CACHE_TTL_SECONDS = parseInt(process.env.TORRENT_SEARCH_CACHE_TTL_SECONDS || '86400', 10);
const SEARCH_CACHE_FILE = path.join(__dirname, subdir, 'search-cache.json');
const searchCache = new Map(); // key -> { ts: number, value: any }

// Persistence helpers: load on startup, debounce saves, flush on exit
let _saveTimer = null;
function scheduleCacheSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    try {
      const serial = JSON.stringify(Array.from(searchCache.entries()));
      fs.writeFileSync(SEARCH_CACHE_FILE, serial, { encoding: 'utf8' });
    } catch (e) {
      console.warn('Failed to write search cache', e && e.message ? e.message : e);
    } finally {
      _saveTimer = null;
    }
  }, 1000);
}

function loadSearchCacheFromDisk() {
  try {
    if (!fs.existsSync(SEARCH_CACHE_FILE)) return;
    const raw = fs.readFileSync(SEARCH_CACHE_FILE, 'utf8');
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (!entry || !entry.ts) continue;
      if ((now - entry.ts) < SEARCH_CACHE_TTL_SECONDS * 1000) {
        searchCache.set(key, entry);
      }
    }
  } catch (e) {
    console.warn('Failed to load search cache', e && e.message ? e.message : e);
  }
}

function flushSearchCacheToDiskSync() {
  try {
    const serial = JSON.stringify(Array.from(searchCache.entries()));
    fs.writeFileSync(SEARCH_CACHE_FILE, serial, { encoding: 'utf8' });
  } catch (e) {
    /* ignore */
  }
}

// Load existing cache now
// loadSearchCacheFromDisk();

app.get('/api/torrent-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const page = parseInt(req.query.page || '1', 10) || 1;
  if (!torrentSearchHelper || !torrentSearchHelper.search) {
    return res.status(501).json({ error: 'torrent search not available on server' });
  }

  // Build a normalized cache key to avoid collisions caused by casing/spacing
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ');
  const rawKey = `${String(q)}::${page}`;
  const normKey = `${normalize(q)}::${page}`;
  const now = Date.now();

  // Check both raw and normalized cache entries for backward compatibility
  const cachedRaw = searchCache.get(rawKey);
  if (cachedRaw && (now - cachedRaw.ts) < SEARCH_CACHE_TTL_SECONDS * 1000) {
    console.log(`[torrent-search] cache hit rawKey=${rawKey} q="${q}" page=${page} items=${(cachedRaw.value||[]).length}`);
    return res.json(Array.isArray(cachedRaw.value) ? cachedRaw.value.slice() : cachedRaw.value);
  }
  const cachedNorm = searchCache.get(normKey);
  if (cachedNorm && (now - cachedNorm.ts) < SEARCH_CACHE_TTL_SECONDS * 1000) {
    console.log(`[torrent-search] cache hit normKey=${normKey} q="${q}" page=${page} items=${(cachedNorm.value||[]).length}`);
    return res.json(Array.isArray(cachedNorm.value) ? cachedNorm.value.slice() : cachedNorm.value);
  }
  console.log(`[torrent-search] cache miss q="${q}" page=${page}`);

  try {
    const results = await torrentSearchHelper.search({ query: String(q), page });
    // Deep-clone before caching to prevent future mutation affecting cached copy
    let cacheValue;
    try { cacheValue = JSON.parse(JSON.stringify(results)); } catch (_) { cacheValue = results.slice(); }

    try {
      // Save normalized key going forward and also preserve raw key for compatibility
      searchCache.set(normKey, { ts: now, value: cacheValue });
      try { searchCache.set(rawKey, { ts: now, value: cacheValue }); } catch (_) {}
      scheduleCacheSave();
    } catch (_) {}

    // Return a fresh copy to the client
    return res.json(results);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
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
    try { stream.destroy(); } catch (e) {}
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

// Start server with retry on EADDRINUSE so running multiple dev instances doesn't crash
let _server = null;
async function tryListen(port, attempts = 5) {
  return new Promise((resolve, reject) => {
    try {
      _server = app.listen(port, () => {
        console.log(`Torrent server listening on http://localhost:${port}`);
        resolve(port);
      });
  // Ensure any previous server is stopped before starting
        ensureNoExistingServer().then(()=>{
          _server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && attempts > 0) {
          console.warn(`Port ${port} in use, trying ${port + 1}...`);
          setTimeout(() => tryListen(port + 1, attempts - 1).then(resolve).catch(reject), 200);
        } else {
          console.error('Server listen error', err && err.message ? err.message : err);
          reject(err);
        }
      });
        }).catch((e)=>{
          console.warn('Error while ensuring no existing server:', e && e.message ? e.message : e);
          // proceed anyway
          _server.on('error', (err) => {
            if (err && err.code === 'EADDRINUSE' && attempts > 0) {
              console.warn(`Port ${port} in use, trying ${port + 1}...`);
              setTimeout(() => tryListen(port + 1, attempts - 1).then(resolve).catch(reject), 200);
            } else {
              console.error('Server listen error', err && err.message ? err.message : err);
              reject(err);
            }
          });
        });
    } catch (e) {
      reject(e);
    }
  });
}

  // When the server binds successfully, write PID file
  function writePidFile(port) {
    try {
      const info = { pid: process.pid, port: port, startedAt: Date.now() };
      fs.writeFileSync(PID_FILE, JSON.stringify(info), { encoding: 'utf8' });
    } catch (e) { /* ignore */ }
  }

  process.on('exit', ()=>{ try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch(_){} });
  process.on('SIGINT', ()=>{ try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch(_){} process.exit(0); });

  // Hook into the listen success to write PID file
  const _origTryListen = tryListen;
  tryListen = function(port, attempts){
    return _origTryListen(port, attempts).then(p => { writePidFile(p); return p; });
  }
tryListen(PORT).catch((e) => {
  console.error('Failed to start torrent server:', e && e.message ? e.message : e);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down torrent server...');
  try { flushSearchCacheToDiskSync(); } catch(_){}
  client.destroy(() => process.exit(0));
});

process.on('exit', () => { try { flushSearchCacheToDiskSync(); } catch(_){} });
