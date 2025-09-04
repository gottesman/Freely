#!/usr/bin/env node
const WebTorrent = require('webtorrent');
const fs = require('fs');
const path = require('path');

// Parse CLI args: usage: node torrent-get-files.js <id> [timeoutMs] [--force|-f|--no-cache] | --clear-cache | --clear-id <id>
const rawArgs = process.argv.slice(2);
let id = undefined;
let timeoutMs = 20000;
let FORCE_REFRESH = false;
let CLEAR_CACHE = false;
let CLEAR_ID = undefined;
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--force' || a === '-f' || a === '--no-cache') {
    FORCE_REFRESH = true;
    continue;
  }
  if (a === '--clear-cache') {
    CLEAR_CACHE = true;
    continue;
  }
  if (a === '--clear-id') {
    const next = rawArgs[i + 1];
    if (next && !next.startsWith('-')) {
      CLEAR_ID = next;
      i++; // consume
    }
    continue;
  }
  // first non-flag is id
  if (!id) {
    id = a;
    continue;
  }
  // next numeric arg is timeout
  if (!isNaN(Number(a))) {
    timeoutMs = parseInt(a, 10);
    continue;
  }
}
const CACHE_TTL_MS = parseInt(String(24 * 60 * 60 * 1000), 10); // default 1 day
const CACHE_FILE = path.join(__dirname, 'data', 'torrent-files-cache.json');

// If user requested cache clearing, handle and exit before normal operation
if (CLEAR_CACHE) {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
      console.log(JSON.stringify({ cleared: true }));
      process.exit(0);
    } else {
      console.log(JSON.stringify({ cleared: false, reason: 'no-cache-file' }));
      process.exit(0);
    }
  } catch (e) {
    console.error('failed to clear cache', e && e.message ? e.message : e);
    process.exit(3);
  }
}

if (CLEAR_ID) {
  try {
    const cache = readCache();
    if (cache[CLEAR_ID]) {
      delete cache[CLEAR_ID];
      writeCache(cache);
      console.log(JSON.stringify({ cleared: true, id: CLEAR_ID }));
      process.exit(0);
    } else {
      console.log(JSON.stringify({ cleared: false, id: CLEAR_ID, reason: 'not-found' }));
      process.exit(0);
    }
  } catch (e) {
    console.error('failed to clear cache id', CLEAR_ID, e && e.message ? e.message : e);
    process.exit(3);
  }
}

if (!id) {
  console.error('missing id');
  console.error('usage: torrent-get-files.js <id> [timeoutMs] [--force|-f|--no-cache]');
  console.error('       torrent-get-files.js --clear-cache');
  console.error('       torrent-get-files.js --clear-id <id>');
  process.exit(2);
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw || '{}');
  } catch (e) {
    // don't let cache errors block operation
    try { console.warn('torrent-get-files: cache read error', e && e.message ? e.message : e); } catch (_) {}
    return {};
  }
}

function writeCache(cache) {
  try {
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    try { fs.renameSync(tmp, CACHE_FILE); } catch (e) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); }
  } catch (e) {
    try { console.warn('torrent-get-files: cache write error', e && e.message ? e.message : e); } catch (_) {}
  }
}

// Check cache first (unless forced)
if (!FORCE_REFRESH) {
  try {
    const cache = readCache();
    const entry = cache[id];
    const now = Date.now();
    if (entry && typeof entry.ts === 'number' && (now - entry.ts) < CACHE_TTL_MS && Array.isArray(entry.files)) {
      // return cached files
      try { console.log(JSON.stringify(entry.files)); } catch (e) { console.error('json error', e); }
      process.exit(0);
    }
  } catch (e) {
    // continue to fetch
  }
} else {
  try { console.warn('torrent-get-files: forcing refresh, skipping cache for id', id); } catch (_) {}
}

const client = new WebTorrent();
let timedOut = false;
const tid = setTimeout(() => { timedOut = true; console.error('timeout'); try { client.destroy(() => process.exit(2)); } catch (_) { process.exit(2); } }, timeoutMs);

function finishExit(code, obj) {
  clearTimeout(tid);
  if (obj !== undefined) {
    try { console.log(JSON.stringify(obj)); } catch (e) { console.error('json error', e); }
  }
  try { client.destroy(() => process.exit(code)); } catch (_) { process.exit(code); }
}

try {
  client.add(id, { destroyStoreOnDestroy: true }, (torrent) => {
    if (timedOut) return;
    const files = (torrent.files || []).map(f => ({ name: f.name, length: f.length }));

    // persist to cache (read-modify-write)
    try {
      const cache = readCache();
      cache[id] = { ts: Date.now(), files };
      writeCache(cache);
    } catch (e) {
      try { console.warn('torrent-get-files: failed to write cache', e && e.message ? e.message : e); } catch (_) {}
    }

    finishExit(0, files);
  });
} catch (e) {
  if (!timedOut) {
    console.error('error', e && e.message ? e.message : JSON.stringify(e));
    finishExit(3);
  }
}
