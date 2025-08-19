const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load environment variables from .env (development) before using them
try {
  const dotenvPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(dotenvPath)) {
    require('dotenv').config({ path: dotenvPath });
  }
} catch (e) {
  console.warn('[env] Could not load .env file:', e?.message || e);
}

let mainWindow;
let serverProcess;

function createWindow() {
  // Resolve window icon depending on environment (dev vs packaged)
  const resolveIcon = () => {
    const iconFile = 'icon.ico';
    if (app.isPackaged) {
      // Prefer icon inside asar/dist (vite copies public assets to dist)
      const distAsar = path.join(process.resourcesPath, 'app.asar', 'dist', iconFile);
      if (fs.existsSync(distAsar)) return distAsar;
      const distUnpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', iconFile);
      if (fs.existsSync(distUnpacked)) return distUnpacked;
      // Fallback: root of resources
      const rootIcon = path.join(process.resourcesPath, iconFile);
      if (fs.existsSync(rootIcon)) return rootIcon;
      return undefined; // let Electron fallback to default icon
    } else {
      // In dev: use public/icon.ico if present, else attempt dist copy
      const publicIcon = path.join(__dirname, '..', 'public', iconFile);
      if (fs.existsSync(publicIcon)) return publicIcon;
      const distIcon = path.join(__dirname, '..', 'dist', iconFile);
      if (fs.existsSync(distIcon)) return distIcon;
      return undefined;
    }
  };

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 755,
    minHeight: 136,
  frame: false, // we'll draw our own titlebar
  transparent: true,
    resizable: true,
  // use fully transparent background so CSS rounded corners render as transparent
  backgroundColor: '#00000000',
    icon: resolveIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Resolve index.html differently when packaged vs dev
  let indexHtml;
  if (app.isPackaged) {
    // packaged resources live in process.resourcesPath
    indexHtml = path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html');
    if (!fs.existsSync(indexHtml)) {
      // fallback to unpacked area if present
      indexHtml = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'index.html');
    }
  } else {
    indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
  }

  const { pathToFileURL } = require('url');
  mainWindow.loadURL(pathToFileURL(indexHtml).href);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // forward maximize/unmaximize events to renderer so UI can update
  mainWindow.on('maximize', () => {
    try { mainWindow.webContents.send('window:maximized', true) } catch (e) {}
  });
  mainWindow.on('unmaximize', () => {
    try { mainWindow.webContents.send('window:maximized', false) } catch (e) {}
  });

  // Also monitor resize to detect user dragging to restore from snapped/maximized states.
  let _maxNotifyTimer = null;
  const notifyMaxState = () => {
    try {
      const isMax = mainWindow.isMaximized();
      mainWindow.webContents.send('window:maximized', !!isMax);
    } catch (e) {}
  };
  const scheduleNotify = () => {
    if (_maxNotifyTimer) clearTimeout(_maxNotifyTimer);
    _maxNotifyTimer = setTimeout(() => { _maxNotifyTimer = null; notifyMaxState(); }, 60);
  };

  mainWindow.on('resize', scheduleNotify);

  // 'move' fires while dragging on many platforms — use it to detect restore-via-drag
  // and also start a short polling loop while the user is dragging so we can
  // update the renderer rapidly and implement drag-to-top-to-maximize behavior.
  let _dragPoll = null;
  let _lastMoveAt = 0;
  let _pendingEdgeMax = false;

  const startDragPoll = () => {
    if (_dragPoll) return;
    _dragPoll = setInterval(() => {
      const now = Date.now();
        // stop polling after a short idle period -> consider this the "drop" / mouse-up
        if (_lastMoveAt && (now - _lastMoveAt) > 300) {
          clearInterval(_dragPoll);
          _dragPoll = null;
          _lastMoveAt = 0;
          try {
            if (_pendingEdgeMax && mainWindow && typeof mainWindow.maximize === 'function' && !mainWindow.isMaximized()) {
              _pendingEdgeMax = false;
              mainWindow.maximize();
            } else {
              _pendingEdgeMax = false;
              notifyMaxState();
            }
          } catch (e) {}
          return;
        }
      try {
        const isMax = mainWindow.isMaximized();
        mainWindow.webContents.send('window:maximized', !!isMax);
        // detect if the user has dragged to the top edge; set a pending flag
        // and only maximize when the drag finishes (on idle). If the window
        // moves away from the top edge, clear the pending flag.
        const bounds = mainWindow.getBounds();
        if (!isMax && bounds && typeof bounds.y === 'number') {
          if (bounds.y <= 0) {
            _pendingEdgeMax = true;
          } else {
            _pendingEdgeMax = false;
          }
        }
      } catch (e) {}
    }, 50); // poll at 50ms for responsive UI updates
  };

  mainWindow.on('move', () => {
    _lastMoveAt = Date.now();
    scheduleNotify();
    startDragPoll();
  });
}

app.whenReady().then(() => {
  // Start the local torrent server as a child process.
  // When packaged we expect the server JS to be unpacked (app.asar.unpacked/server/...)
  let serverPath;
  const serverRel = path.join('server', 'torrent-server.js');
  if (app.isPackaged) {
    // Prefer unpacked server (executable outside asar)
    serverPath = path.join(process.resourcesPath, 'app.asar.unpacked', serverRel);
    if (!fs.existsSync(serverPath)) {
      // fallback: try inside asar (not ideal for spawning)
      serverPath = path.join(process.resourcesPath, 'app.asar', serverRel);
    }
  } else {
    serverPath = path.join(__dirname, '..', 'server', 'torrent-server.js');
  }

  try {
    serverProcess = spawn(process.execPath, [serverPath], {
      stdio: 'inherit',
      cwd: path.dirname(serverPath),
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start server process:', err);
    });

    serverProcess.on('exit', (code, signal) => {
      console.log('Server process exited', code, signal);
      serverProcess = null;
    });
  } catch (e) {
    console.error('Error spawning server process', e);
  }

  createWindow();

  app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window:maximize', () => {
  if (mainWindow) mainWindow.maximize();
});

ipcMain.on('window:restore', () => {
  if (mainWindow) {
    // restore from maximized state
    if (typeof mainWindow.unmaximize === 'function') mainWindow.unmaximize();
    else mainWindow.restore();
  }
});

ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

// ---------------- Genius API Proxy (CORS bypass) ----------------
// Renderer cannot call Genius directly due to CORS; perform request here.
// Requires GENIUS_ACCESS_TOKEN (preferred) or VITE_GENIUS_ACCESS_TOKEN env var.
const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN || process.env.VITE_GENIUS_ACCESS_TOKEN;
ipcMain.handle('genius:search', async (_ev, query) => {
  if (!GENIUS_TOKEN) throw new Error('Missing Genius access token environment variable');
  if (typeof query !== 'string' || !query.trim()) return { query, hits: [] };
  const url = 'https://api.genius.com/search?' + new URLSearchParams({ q: query.trim() });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` } });
  if (!res.ok) throw new Error(`Genius search failed: ${res.status}`);
  const data = await res.json();
  const hits = (data.response?.hits || []).map(h => {
    const s = h.result;
    return {
      id: s.id,
      title: s.title,
      fullTitle: s.full_title,
      url: s.url,
      songArtImageUrl: s.song_art_image_url,
      headerImageUrl: s.header_image_url,
      primaryArtist: { id: s.primary_artist?.id, name: s.primary_artist?.name }
    };
  });
  return { query, hits };
});

// Helper fetch for other endpoints
async function geniusGet(path) {
  if (!GENIUS_TOKEN) throw new Error('Missing Genius access token environment variable');
  const url = 'https://api.genius.com' + path;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function mapSong(s) {
  return {
    id: s.id,
    title: s.title,
    fullTitle: s.full_title,
    url: s.url,
    headerImageUrl: s.header_image_url,
    songArtImageUrl: s.song_art_image_url,
    releaseDate: s.release_date || s.release_date_for_display,
    primaryArtist: s.primary_artist && { id: s.primary_artist.id, name: s.primary_artist.name },
    album: s.album ? { id: s.album.id, name: s.album.name, coverArtUrl: s.album.cover_art_url } : undefined
  };
}

function mapArtist(a){
  let plain = a.description?.plain || (a.description?.dom ? flattenGeniusDescriptionDom(a.description.dom) : undefined);
  // Build minimal HTML without anchor tags
  let html = undefined;
  try {
    if (a.description?.dom) html = buildDescriptionHtml(a.description.dom);
    else if (plain) html = plain.split(/\n{2,}/).map(p=>`<p>${escapeHtml(p.trim())}</p>`).join('');
  } catch(_) { /* ignore */ }
  return {
    id: a.id,
    name: a.name,
    url: a.url,
    imageUrl: a.image_url || a.header_image_url,
    description: { plain, html }
  };
}

function buildDescriptionHtml(root){
  if(root == null) return '';
  if(typeof root === 'string') return escapeHtml(root);
  const tag = (root.tag||'').toLowerCase();
  const voidTags = new Set(['br','hr']);
  const blockLike = ['p','div','section','h1','h2','h3','h4','h5','h6','ul','ol','li'];
  let childrenHtml = '';
  if(Array.isArray(root.children)) childrenHtml = root.children.map(c=> buildDescriptionHtml(c)).join('');
  if(tag === 'a') return childrenHtml; // strip link wrapper
  if(!tag) return childrenHtml;
  if(voidTags.has(tag)) return `<${tag}>`;
  const allowed = new Set([...blockLike,'strong','em','i','b','u','span','br','ul','ol','li']);
  const safeTag = allowed.has(tag) ? tag : 'span';
  return `<${safeTag}>${childrenHtml}</${safeTag}>`;
}
function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Flatten Genius description DOM tree to plain text (fallback when plain missing)
function flattenGeniusDescriptionDom(node, acc = []){
  if (!node) return acc.join('').trim();
  if (typeof node === 'string') { acc.push(node); return acc.join(''); }
  const tag = (node.tag||'').toLowerCase();
  const isBlock = ['p','div','section','br','h1','h2','h3','h4','h5','h6','ul','ol','li'].includes(tag);
  if (tag === 'br') acc.push('\n');
  if (Array.isArray(node.children)) {
    for (const c of node.children) flattenGeniusDescriptionDom(c, acc);
  }
  if (isBlock) acc.push('\n\n');
  // Collapse stray tabs / returns
  return acc.join('').replace(/[\t\r]+/g,'').replace(/\n{3,}/g,'\n\n').trim();
}

function mapAlbum(a){
  return {
    id: a.id,
    name: a.name,
    fullTitle: a.full_title,
    url: a.url,
    coverArtUrl: a.cover_art_url,
    releaseDate: a.release_date,
    artist: a.artist ? { id: a.artist.id, name: a.artist.name } : undefined,
    trackIds: (a.tracks || []).map(t => t.song?.id).filter(Boolean)
  };
}

// Lyrics parsing (reuse regex strategy matching earlier implementation)
const LYRICS_SELECTORS = [
  /<div[^>]+data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi,
  /<div class="lyrics"[^>]*>([\s\S]*?)<\/div>/i
];
function stripTags(html){
  return html
    .replace(/<br\s*\/?>(?=\n?)/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function parseLyrics(html){
  for (const re of LYRICS_SELECTORS){
    const parts = [];
    let m; re.lastIndex = 0;
    while ((m = re.exec(html)) !== null){ parts.push(m[1]); }
    if (parts.length){
      const text = stripTags(parts.join('\n'));
      if (text) return text;
    }
  }
  return undefined;
}

ipcMain.handle('genius:getSong', async (_ev, id) => {
  const json = await geniusGet(`/songs/${id}`);
  const s = json.response?.song; if(!s) throw new Error('Not found');
  return mapSong(s);
});

ipcMain.handle('genius:getArtist', async (_ev, id) => {
  const json = await geniusGet(`/artists/${id}`);
  const a = json.response?.artist; if(!a) throw new Error('Not found');
  return mapArtist(a);
});

ipcMain.handle('genius:getAlbum', async (_ev, id) => {
  const json = await geniusGet(`/albums/${id}`);
  const a = json.response?.album; if(!a) throw new Error('Not found');
  return mapAlbum(a);
});

ipcMain.handle('genius:getLyrics', async (_ev, id) => {
  const json = await geniusGet(`/songs/${id}`);
  const s = json.response?.song; if(!s) throw new Error('Not found');
  const pageRes = await fetch(s.url, { headers: { 'User-Agent': 'FreelyPlayer/0.1' } });
  if(!pageRes.ok) throw new Error(`Lyrics page HTTP ${pageRes.status}`);
  const html = await pageRes.text();
  const lyrics = parseLyrics(html);
  return { songId: s.id, url: s.url, lyrics, source: lyrics ? 'parsed-html' : 'unavailable', fetchedAt: Date.now() };
});

// ---------------- Spotify API Proxy (no bundled secret) ----------------
// We intentionally do NOT bundle the client secret. Options:
// 1. Provide SPOTIFY_TOKEN_ENDPOINT (server you control that returns { access_token, expires_in })
// 2. Provide SPOTIFY_PROXY_ENDPOINT (server that proxies Spotify Web API directly). (Not implemented here.)
// If neither is set, Spotify features degrade gracefully (empty results / errors).
// Prefer environment variable override so production can point to a Cloudflare Worker / serverless function
// In packaged builds environment variables are often stripped; allow a lightweight config file fallback.
let SPOTIFY_TOKEN_ENDPOINT_SOURCE = 'unset';
const SPOTIFY_TOKEN_ENDPOINT = (() => {
  const envVal = process.env.SPOTIFY_TOKEN_ENDPOINT || process.env.VITE_SPOTIFY_TOKEN_ENDPOINT;
  if (envVal) { SPOTIFY_TOKEN_ENDPOINT_SOURCE = 'env'; return envVal; }
  // Try config file(s)
  try {
    const candidates = [
      path.join(__dirname, '..', 'config', 'spotify-token-endpoint.txt')
    ];
    // When packaged, also look inside resources path (unpacked preferred)
    try {
      if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'config', 'spotify-token-endpoint.txt'));
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'config', 'spotify-token-endpoint.txt'));
      }
    } catch(_) {}
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) {
          const v = fs.readFileSync(file, 'utf8').trim();
          if (v) { SPOTIFY_TOKEN_ENDPOINT_SOURCE = 'file:'+file; return v; }
        }
      } catch(_) { /* ignore individual file errors */ }
    }
  } catch(_) {}
  SPOTIFY_TOKEN_ENDPOINT_SOURCE = 'missing';
  return null;
})();
let spotifyToken = null; // { access_token, expires_at }
let spotifyTokenDebug = { lastFetchAt: null, lastError: null, lastBodySnippet: null, lastContentType: null, lastStatus: null, lastLength: null, lastClassified: null };
// Lightweight classifier to label common HTML error/challenge pages so UI can surface clearer guidance.
function classifyBodySnippet(snippet){
  if(!snippet) return null;
  const lower = snippet.toLowerCase();
  if(lower.includes('<html') && lower.includes('cloudflare')) return 'cloudflare_challenge_or_block';
  if(lower.includes('captcha')) return 'captcha_challenge';
  if(lower.includes('404') && lower.includes('<html')) return 'not_found_html';
  if(lower.includes('error') && lower.includes('<html')) return 'html_error_page';
  if(lower.includes('aes.js')) return 'host_injected_script';
  return null;
}

async function getSpotifyToken(){
  if (!SPOTIFY_TOKEN_ENDPOINT) throw new Error('Spotify disabled (no SPOTIFY_TOKEN_ENDPOINT)');
  if (spotifyToken && spotifyToken.expires_at > Date.now() + 60_000) return spotifyToken.access_token;
  const res = await fetch(SPOTIFY_TOKEN_ENDPOINT, { method:'GET', headers: { 'Accept':'application/json,text/plain,*/*' } });
  spotifyTokenDebug.lastFetchAt = Date.now();
  spotifyTokenDebug.lastStatus = res.status;
  spotifyTokenDebug.lastContentType = res.headers.get('content-type')||null;
  if(!res.ok){
    let bodyTxt = '';
    try { bodyTxt = await res.text(); } catch(_){}
    spotifyTokenDebug.lastError = 'HTTP ' + res.status;
    spotifyTokenDebug.lastBodySnippet = bodyTxt.slice(0,300);
    spotifyTokenDebug.lastLength = bodyTxt.length || null;
    spotifyTokenDebug.lastClassified = classifyBodySnippet(spotifyTokenDebug.lastBodySnippet);
    throw new Error('Token endpoint HTTP ' + res.status + (bodyTxt ? ' body: ' + bodyTxt.slice(0,80) : ''));
  }
  let json;
  const ct = res.headers.get('content-type')||'';
  let rawTxt = '';
  try {
    if(!/json/i.test(ct)) { rawTxt = await res.text(); throw new Error('Unexpected content-type '+ct+' body starts '+rawTxt.slice(0,60)); }
    json = await res.json();
  } catch(parseErr){
    if(!rawTxt){ try { rawTxt = await res.text(); } catch(_){} }
    spotifyTokenDebug.lastError = 'parse_error:' + (parseErr?.message||parseErr);
    spotifyTokenDebug.lastBodySnippet = rawTxt.slice(0,300);
    spotifyTokenDebug.lastLength = rawTxt.length || null;
    spotifyTokenDebug.lastClassified = classifyBodySnippet(spotifyTokenDebug.lastBodySnippet);
    console.error('[spotify-token] Parse error. Snippet:', spotifyTokenDebug.lastBodySnippet);
    throw new Error('Token parse failed: ' + (parseErr?.message||parseErr));
  }
  if(!json.access_token){
    spotifyTokenDebug.lastError = 'missing_access_token';
    spotifyTokenDebug.lastBodySnippet = JSON.stringify(json).slice(0,300);
    spotifyTokenDebug.lastLength = spotifyTokenDebug.lastBodySnippet.length;
    spotifyTokenDebug.lastClassified = classifyBodySnippet(spotifyTokenDebug.lastBodySnippet);
    throw new Error('Token endpoint missing access_token');
  }
  spotifyTokenDebug.lastError = null;
  spotifyTokenDebug.lastBodySnippet = null;
  spotifyTokenDebug.lastLength = null;
  spotifyTokenDebug.lastClassified = null;
  const expiresIn = Number(json.expires_in || 3600);
  spotifyToken = { access_token: json.access_token, expires_at: Date.now() + (expiresIn * 1000) };
  return spotifyToken.access_token;
}

// Debug IPC to inspect last token fetch state (no secrets included)
ipcMain.handle('spotify:tokenStatus', () => {
  return {
    configured: !!SPOTIFY_TOKEN_ENDPOINT,
    endpoint: SPOTIFY_TOKEN_ENDPOINT,
  source: SPOTIFY_TOKEN_ENDPOINT_SOURCE,
    cached: !!spotifyToken,
    expiresAt: spotifyToken?.expires_at || null,
    now: Date.now(),
    lastFetchAt: spotifyTokenDebug.lastFetchAt,
    lastError: spotifyTokenDebug.lastError,
    lastBodySnippet: spotifyTokenDebug.lastBodySnippet,
    lastContentType: spotifyTokenDebug.lastContentType,
    lastStatus: spotifyTokenDebug.lastStatus,
    lastLength: spotifyTokenDebug.lastLength,
    lastClassified: spotifyTokenDebug.lastClassified
  };
});

async function spotifyGet(path, params){
  if(!SPOTIFY_TOKEN_ENDPOINT) throw new Error('Spotify disabled');
  const token = await getSpotifyToken();
  const search = params ? '?' + new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined)) : '';
  const url = 'https://api.spotify.com/v1' + path + search;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Spotify HTTP ' + res.status);
  return res.json();
}

ipcMain.handle('spotify:search', async (_ev, query, typeOrTypes='track') => { // typeOrTypes: string | string[]
  try {
    if (!query || !query.trim()) return { query, types: [], results: {} };
    const types = Array.isArray(typeOrTypes) ? typeOrTypes : String(typeOrTypes).split(',').map(s=>s.trim()).filter(Boolean);
    const typeParam = types.join(',');
    const json = await spotifyGet('/search', { q: query.trim(), type: typeParam, limit: '20', market: process.env.SPOTIFY_DEFAULT_MARKET || 'US' });
    const results = {};
    if (types.includes('track')) results.track = (json.tracks?.items||[]).map(mapSpotifyTrack);
    if (types.includes('album')) results.album = (json.albums?.items||[]).map(mapSpotifyAlbum);
    if (types.includes('artist')) results.artist = (json.artists?.items||[]).map(mapSpotifyArtist);
    return { query, types, results };
  } catch (e){
    return { query, types: [], results: {}, error: e?.message || String(e) };
  }
});
ipcMain.handle('spotify:getTrack', async (_ev, id) => {
  try { return mapSpotifyTrack(await spotifyGet('/tracks/' + id, { market: process.env.SPOTIFY_DEFAULT_MARKET || 'US' })); } catch(e){ return { error: e?.message||String(e) }; }
});
ipcMain.handle('spotify:getAlbum', async (_ev, id) => {
  try { return mapSpotifyAlbum(await spotifyGet('/albums/' + id, { market: process.env.SPOTIFY_DEFAULT_MARKET || 'US' })); } catch(e){ return { error: e?.message||String(e) }; }
});
ipcMain.handle('spotify:getArtist', async (_ev, id) => {
  try { return mapSpotifyArtist(await spotifyGet('/artists/' + id)); } catch(e){ return { error: e?.message||String(e) }; }
});
// Retrieve album tracks with optional pagination (mirrors renderer SpotifyClient behavior)
ipcMain.handle('spotify:getAlbumTracks', async (_ev, id, opts={}) => {
  if(!id) throw new Error('album id required');
  const limit = Math.min(Math.max(opts.limit ?? 50,1),50);
  const fetchAll = opts.fetchAll !== false; // default true
  const maxPages = opts.maxPages ?? 10;
  const market = process.env.SPOTIFY_DEFAULT_MARKET || 'US';
  let offset = 0; let page = 0; let total = 0; const items = []; const raws = [];
  do {
    const json = await spotifyGet(`/albums/${id}/tracks`, { market, limit: String(limit), offset: String(offset) });
    total = json.total ?? total;
    const tracks = (json.items||[]).map(t => mapSpotifyTrack(t));
    items.push(...tracks);
    raws.push(json);
    offset += tracks.length;
    page++;
    if(!fetchAll) break;
  } while(offset < total && page < maxPages);
  return { albumId: id, total, items, raw: raws };
});

// Fetch artist albums (album,single groups by default, similar to renderer client)
ipcMain.handle('spotify:getArtistAlbums', async (_ev, id, opts={}) => {
  if(!id) throw new Error('artist id required');
  const includeGroups = opts.includeGroups || 'album,single';
  const limit = Math.min(Math.max(opts.limit ?? 50,1),50);
  const fetchAll = opts.fetchAll === true; // default first page only unless explicitly true
  const maxPages = opts.maxPages ?? 5;
  const market = process.env.SPOTIFY_DEFAULT_MARKET || 'US';
  let offset = 0; let page = 0; let total = 0; const items = []; const raws = [];
  do {
    const json = await spotifyGet(`/artists/${id}/albums`, { include_groups: includeGroups, market, limit: String(limit), offset: String(offset) });
    total = json.total ?? total;
    const albums = (json.items||[]).map(a => mapSpotifyAlbum(a));
    items.push(...albums); raws.push(json);
    offset += albums.length; page++;
    if(!fetchAll) break;
  } while(offset < total && page < maxPages);
  return { artistId: id, total, items, raw: raws };
});

// Search playlists (simple wrapper; limited fields already mapped by track/album search mapper style if needed)
ipcMain.handle('spotify:searchPlaylists', async (_ev, query) => {
  if(!query || !query.trim()) return { query, items: [] };
  const market = process.env.SPOTIFY_DEFAULT_MARKET || 'US';
  const json = await spotifyGet('/search', { q: query.trim(), type: 'playlist', market, limit: '20' });
  const rawItems = Array.isArray(json.playlists?.items) ? json.playlists.items : [];
  const items = rawItems
    .filter(p => p && p.id && p.name) // guard against null/undefined entries
    .map(p => ({
      id: p.id,
      name: p.name,
      url: p.external_urls?.spotify,
      images: Array.isArray(p.images) ? p.images.filter(Boolean) : [],
      description: p.description
    }));
  return { query, items };
});

function mapSpotifyArtist(a){ return { id: a.id, name: a.name, url: a.external_urls?.spotify, genres: a.genres||[], images: a.images||[], followers: a.followers?.total, popularity: a.popularity }; }
function mapSpotifyAlbum(a){ return { id: a.id, name: a.name, url: a.external_urls?.spotify, albumType: a.album_type, releaseDate: a.release_date, totalTracks: a.total_tracks, images: a.images||[], artists: (a.artists||[]).map(ar => ({ id: ar.id, name: ar.name, url: ar.external_urls?.spotify })) }; }
function mapSpotifyTrack(t){ return { id: t.id, name: t.name, url: t.external_urls?.spotify, durationMs: t.duration_ms, explicit: !!t.explicit, trackNumber: t.track_number, discNumber: t.disc_number, previewUrl: t.preview_url||undefined, popularity: t.popularity, artists: (t.artists||[]).map(ar => ({ id: ar.id, name: ar.name, url: ar.external_urls?.spotify })), album: t.album ? { id: t.album.id, name: t.album.name, url: t.album.external_urls?.spotify, images: t.album.images||[] } : undefined }; }

app.on('window-all-closed', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch (e) {}
  }
  if (process.platform !== 'darwin') app.quit();
});
