/**
 * Minimal Spotify Web API client (client credentials flow) for metadata: search, track, album, artist.
 * Does NOT handle user-specific endpoints (playlists, library) since that requires OAuth authorization code.
 */

export interface SpotifyConfig {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string; // optional pre-fetched token
  tokenExpiresAt?: number; // epoch ms
  market?: string; // default market for track/album/artist resource tailoring
  locale?: string; // optional ui locale (e.g. en-US)
}

export interface SpotifySearchResult<T> { query: string; type: string; items: T[]; raw: any; }
export interface SpotifyArtist { id: string; name: string; url: string; genres: string[]; images: { url: string; width?: number; height?: number }[]; followers?: number; popularity?: number; }
export interface SpotifyAlbum { id: string; name: string; url: string; albumType: string; releaseDate: string; totalTracks: number; images: { url: string; width?: number; height?: number }[]; artists: SpotifyArtistRef[]; label?: string; copyrights?: string[]; }
export interface SpotifyTrack { id: string; name: string; url: string; durationMs: number; explicit: boolean; trackNumber: number; discNumber: number; previewUrl?: string; popularity?: number; artists: SpotifyArtistRef[]; album?: SpotifyAlbumRef; }
export interface SpotifyArtistRef { id: string; name: string; url: string; }
export interface SpotifyAlbumRef { id: string; name: string; url: string; images?: { url: string; width?: number; height?: number }[]; }
export interface SpotifyPlaylist { id: string; name: string; url: string; images: { url: string; width?: number; height?: number }[]; description?: string; ownerName?: string; totalTracks?: number; }

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

// Module-level shared token cache so multiple SpotifyClient instances reuse the same app token.
let __sharedToken: { accessToken?: string; tokenExpiresAt?: number } = {};
let __sharedTokenInflight: Promise<void> | undefined;
let __sharedLocale: string | undefined; // module-level locale propagated from UI

function env(name: string){
  // @ts-ignore
  if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
  // @ts-ignore
  if (typeof import.meta !== 'undefined' && import.meta.env?.[name]) return import.meta.env[name];
  return undefined;
}

export class SpotifyClient {
  private cfg: SpotifyConfig;
  private cache = new Map<string, any>();
  private tokenInflight?: Promise<void>; // de-dupe concurrent token fetches
  private db?: { getApiCache: (key: string) => Promise<any | null>; setApiCache: (key: string, data: any) => Promise<void> }; // database cache
  
  constructor(cfg: SpotifyConfig = {}) { 
    this.cfg = { market: env('SPOTIFY_DEFAULT_MARKET') || 'US', ...cfg }; 
  }

  // Inject database cache functions
  setDatabaseCache(db: { getApiCache: (key: string) => Promise<any | null>; setApiCache: (key: string, data: any) => Promise<void> }) {
    this.db = db;
  }

  setCredentials(clientId: string, clientSecret: string){ this.cfg.clientId = clientId; this.cfg.clientSecret = clientSecret; }
  setAccessToken(token: string, expiresInSec = 3600){
    const exp = Date.now() + (expiresInSec * 1000);
    this.cfg.accessToken = token; this.cfg.tokenExpiresAt = exp;
    __sharedToken.accessToken = token; __sharedToken.tokenExpiresAt = exp;
  }

  private async ensureToken(){
    // Prefer instance token if valid
    if (this.cfg.accessToken && this.cfg.tokenExpiresAt && Date.now() < this.cfg.tokenExpiresAt - 60_000) return;
    if (this.cfg.accessToken && !this.cfg.tokenExpiresAt) return; // static injected
    // Try shared token if instance lacks/expired
    if (!this.cfg.accessToken && __sharedToken.accessToken && __sharedToken.tokenExpiresAt && Date.now() < __sharedToken.tokenExpiresAt - 60_000){
      this.cfg.accessToken = __sharedToken.accessToken; this.cfg.tokenExpiresAt = __sharedToken.tokenExpiresAt; return;
    }
    // Await shared inflight if present
    if (__sharedTokenInflight){ await __sharedTokenInflight; // copy over after wait
      if (this.cfg.accessToken && this.cfg.tokenExpiresAt && Date.now() < this.cfg.tokenExpiresAt - 60_000) return;
      if (__sharedToken.accessToken){ this.cfg.accessToken = __sharedToken.accessToken; this.cfg.tokenExpiresAt = __sharedToken.tokenExpiresAt; }
      return;
    }
    // Start new fetch
    console.log('🎫 Fetching Spotify access token...');
    __sharedTokenInflight = this.tokenInflight = (async () => {
      // Support external token endpoint for browser (no secret). Vite exposes only VITE_ prefixed vars.
      const externalEndpoint = env('VITE_SPOTIFY_TOKEN_ENDPOINT') || env('SPOTIFY_TOKEN_ENDPOINT');
      console.log('🔗 Environment check:', {
        VITE_SPOTIFY_TOKEN_ENDPOINT: env('VITE_SPOTIFY_TOKEN_ENDPOINT'),
        SPOTIFY_TOKEN_ENDPOINT: env('SPOTIFY_TOKEN_ENDPOINT'),
        finalEndpoint: externalEndpoint
      });
      console.log('🔗 Checking for external token endpoint:', externalEndpoint);
      if (externalEndpoint){
        console.log('🌐 Using external token endpoint:', externalEndpoint);
        try {
          console.log('📞 Making fetch request to token endpoint...');
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout
          
          const r = await fetch(String(externalEndpoint), { 
            headers: { 'Accept':'application/json' },
            signal: controller.signal
          });
          clearTimeout(timeout);
          
          console.log('📨 Got response, status:', r.status, 'content-type:', r.headers.get('content-type'));
          const ct = r.headers.get('content-type')||'';
          let raw = '';
          if(!r.ok){ 
            raw = await safeReadText(r); 
            console.error('❌ Token endpoint HTTP error:', r.status, raw);
            throw new Error('token_http_'+r.status); 
          }
          if(!/json/i.test(ct)){ 
            raw = await safeReadText(r); 
            console.error('❌ Token endpoint content-type error:', ct, 'body:', raw.slice(0,40));
            throw new Error('token_ct:'+ct+' snippet:'+ raw.slice(0,40)); 
          }
          console.log('🔄 Parsing JSON response...');
          const j = await r.json();
          console.log('✅ Parsed token response:', { hasToken: !!j.access_token, expiresIn: j.expires_in });
          if(!j.access_token) throw new Error('token_missing_access_token');
          // Prefer absolute unix expiry if provided (seconds). Fallback to expires_in.
          let expiresInSec: number;
          if(j.expires_at_unix){
            const absMs = Number(j.expires_at_unix) * 1000;
            const diff = Math.floor((absMs - Date.now()) / 1000);
            expiresInSec = isFinite(diff) ? Math.max(1, diff) : 3600;
          } else {
            expiresInSec = Number(j.expires_in || 3600);
          }
          this.setAccessToken(j.access_token, expiresInSec);
          console.log('✅ Successfully got token from external endpoint, expires in', expiresInSec, 'seconds');
          return;
        } catch (e){
          console.error('❌ External token endpoint failed:', e);
          if (e instanceof Error && e.name === 'AbortError') {
            console.error('🕐 Token request timed out after 10 seconds');
          }
          // Fall through to client credentials attempt only if we actually have credentials
          const hasCreds = (this.cfg.clientId || env('SPOTIFY_CLIENT_ID')) && (this.cfg.clientSecret || env('SPOTIFY_CLIENT_SECRET'));
          console.log('🔍 Checking for fallback credentials, hasCreds:', hasCreds);
          if(!hasCreds){
            // No credentials to fallback to; propagate a clearer message (handled by callers)
            throw new Error('Spotify token endpoint failed & no credentials: ' + (e as any)?.message);
          }
        }
      }

      const id = this.cfg.clientId || env('SPOTIFY_CLIENT_ID');
      const secret = this.cfg.clientSecret || env('SPOTIFY_CLIENT_SECRET');
      if (!id || !secret) throw new Error('Spotify disabled (no credentials or token endpoint)');
      const body = new URLSearchParams({ grant_type: 'client_credentials' });
      // Use Buffer if available (Node / Electron), else btoa (browser)
      let basic: string;
      try {
        // @ts-ignore
        if (typeof Buffer !== 'undefined') { // Node/Electron
          // @ts-ignore
          basic = Buffer.from(id + ':' + secret).toString('base64');
        } else {
          basic = btoa(id + ':' + secret);
        }
      } catch {
        basic = btoa(id + ':' + secret);
      }
      const res = await fetch(TOKEN_URL, { method:'POST', headers: { 'Authorization': 'Basic ' + basic, 'Content-Type':'application/x-www-form-urlencoded' }, body });
      if (!res.ok) throw new Error('Spotify token failed ' + res.status);
      const json = await res.json();
      // json.expires_in is in seconds
      this.setAccessToken(json.access_token, Number(json.expires_in || 3600));
    })();

  try { await this.tokenInflight; } finally { this.tokenInflight = undefined; __sharedTokenInflight = undefined; }
  console.log('🎫 Token fetch completed successfully');
  }

  private async get(path: string, params?: Record<string,string|number|undefined>){
    await this.ensureToken();
    // Merge locale if not explicitly provided
    const merged: Record<string,string|number|undefined> = { ...(params||{}) };
    if(merged.locale === undefined){
      const loc = this.cfg.locale || __sharedLocale || defaultLocale();
      if(loc) merged.locale = loc;
    }
    const search = '?' + new URLSearchParams(Object.entries(merged).filter(([,v])=>v!==undefined) as any);
    const url = API_BASE + path + search;
    const k = 'GET:' + url;
    
    // Check database cache first (persistent, indefinite)
    if (this.db) {
      try {
        console.log('🔍 Checking DB cache for:', k);
        const cachedData = await this.db.getApiCache(k);
        if (cachedData) {
          console.log('📋 Cache HIT:', path);
          return cachedData;
        } else {
          console.log('📋 Cache MISS (no data):', path);
        }
      } catch (e) {
        console.log('📋 Cache MISS (error):', path, e);
        // fallback to in-memory cache if DB fails
      }
    } else {
      console.log('📋 Cache MISS (no DB):', path);
    }
    
    // Fallback to in-memory cache (60 second TTL for current session)
    const cached = this.cache.get(k);
    if (cached && Date.now() - cached.t < 60_000) {
      console.log('💾 Memory cache HIT:', path);
      return cached.v;
    }
    
    // Make API call
    console.log('🌐 API CALL:', path);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + this.cfg.accessToken } });
    if (!res.ok) throw new Error('Spotify HTTP ' + res.status);
    const json = await res.json();
    
    // Store in both caches
    this.cache.set(k, { v: json, t: Date.now() });
    console.log('💾 Stored in memory cache:', path);
    if (this.db) {
      // Don't await DB cache - it's an optimization, not critical
      this.db.setApiCache(k, json).then(() => {
        console.log('💾 Stored in DB cache:', path);
      }).catch((e) => {
        console.log('💾 DB cache store failed:', path, e);
      });
    } else {
      console.log('💾 No DB available for caching:', path);
    }
    
    return json;
  }

  async searchAll(query: string, types: Array<'track'|'album'|'artist'> = ['track','album','artist']){
    const json = await this.get('/search', { q: query, type: types.join(','), market: this.cfg.market, limit: '5' });
    return json;
  }

  /**
   * Perform a single /search request for multiple types (comma-separated) and map results.
   * Returns an object with mapped arrays under keys: track, album, artist, playlist when present.
   */
  async searchMulti(query: string, types: Array<'track'|'album'|'artist'|'playlist'> = ['track','album','artist','playlist'], limit: number = 20){
    // limit is applied per-type by the Spotify API (max 50)
    const json = await this.get('/search', { q: query, type: types.join(','), market: this.cfg.market, limit: String(limit) });
    const results: Record<string, any[]> = {};
    if (json.tracks && Array.isArray(json.tracks.items)) results.track = (json.tracks.items || []).map(mapTrack);
    if (json.albums && Array.isArray(json.albums.items)) results.album = (json.albums.items || []).map(mapAlbum);
    if (json.artists && Array.isArray(json.artists.items)) results.artist = (json.artists.items || []).map(mapArtist);
    if (json.playlists && Array.isArray(json.playlists.items)) results.playlist = (json.playlists.items || []).filter(Boolean).map(mapPlaylist);
    return { query, types, results, raw: json };
  }

  async searchTracks(query: string, limit: number = 20): Promise<SpotifySearchResult<SpotifyTrack>> {
    const json = await this.get('/search', { q: query, type: 'track', market: this.cfg.market, limit: String(limit) });
    const items = (json.tracks?.items || []).map(mapTrack);
    return { query, type: 'track', items, raw: json };
  }
  async searchAlbums(query: string, limit: number = 20): Promise<SpotifySearchResult<SpotifyAlbum>> {
    const json = await this.get('/search', { q: query, type: 'album', market: this.cfg.market, limit: String(limit) });
    const items = (json.albums?.items || []).map(mapAlbum);
    return { query, type: 'album', items, raw: json };
  }
  async searchArtists(query: string, limit: number = 20): Promise<SpotifySearchResult<SpotifyArtist>> {
    const json = await this.get('/search', { q: query, type: 'artist', market: this.cfg.market, limit: String(limit) });
    const items = (json.artists?.items || []).map(mapArtist);
    return { query, type: 'artist', items, raw: json };
  }
  async searchPlaylists(query: string, limit: number = 20): Promise<SpotifySearchResult<SpotifyPlaylist>> {
    const json = await this.get('/search', { q: query, type: 'playlist', market: this.cfg.market, limit: String(limit) });
  // Some playlist items can sporadically be null (API glitch); filter falsy before mapping.
  const items = (json.playlists?.items || []).filter(Boolean).map(mapPlaylist);
    return { query, type: 'playlist', items, raw: json } as any;
  }
  async getPlaylist(id: string): Promise<{ playlist: SpotifyPlaylist; tracks: SpotifyTrack[]; raw: any }> {
    // Initial fetch (includes first page of tracks). Spotify max limit per request for playlist items is 100.
    const first = await this.get('/playlists/' + id, { limit: '100' });
    const playlist = mapPlaylist(first);
    const total = first.tracks?.total || 0;
    const collected: SpotifyTrack[] = (first.tracks?.items || []).map((it: any) => it?.track ? mapTrack(it.track) : null).filter(Boolean) as SpotifyTrack[];
    const raws: any[] = [first];
    let offset = collected.length;
    // Safety cap to avoid runaway (e.g., 10k tracks). We'll cap at 2,000 tracks (20 pages * 100) unless total smaller.
    const MAX_PAGES = 20;
    let page = 1; // first already fetched
    while(offset < total && page < MAX_PAGES){
      const next = await this.get('/playlists/' + id + '/tracks', { limit: '100', offset: String(offset) });
      raws.push(next);
      const pageTracks: SpotifyTrack[] = (next.items || []).map((it: any) => it?.track ? mapTrack(it.track) : null).filter(Boolean) as SpotifyTrack[];
      collected.push(...pageTracks);
      offset += pageTracks.length;
      page++;
      if(pageTracks.length === 0) break; // defensive break
    }
    return { playlist, tracks: collected, raw: raws };
  }

  async getTrack(id: string): Promise<SpotifyTrack> { const json = await this.get('/tracks/' + id, { market: this.cfg.market }); return mapTrack(json); }
  async getAlbum(id: string): Promise<SpotifyAlbum> { const json = await this.get('/albums/' + id, { market: this.cfg.market }); return mapAlbum(json); }
  /** Retrieve tracks for an album (auto-paginates until all tracks or maxPages reached). */
  async getAlbumTracks(id: string, opts: { limit?: number; market?: string; fetchAll?: boolean; maxPages?: number } = {}): Promise<{ albumId: string; total: number; items: SpotifyTrack[]; raw: any[] }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50); // Spotify max 50 for album tracks
    const market = opts.market || this.cfg.market;
    const fetchAll = opts.fetchAll ?? true;
    const maxPages = opts.maxPages ?? 10; // safety cap (10 * 50 = 500)
    let offset = 0;
    let page = 0;
    const items: SpotifyTrack[] = [];
    const raws: any[] = [];
    let total = 0;
    do {
      const json = await this.get(`/albums/${id}/tracks`, { market, limit: String(limit), offset: String(offset) });
      total = json.total ?? total;
      const tracks = (json.items || []).map((t: any) => mapTrack(t));
      items.push(...tracks);
      raws.push(json);
      offset += tracks.length;
      page++;
      if (!fetchAll) break;
    } while (offset < total && page < maxPages);
    return { albumId: id, total, items, raw: raws };
  }
  async getArtist(id: string): Promise<SpotifyArtist> { const json = await this.get('/artists/' + id); return mapArtist(json); }
  /** Fetch an artist's top tracks (market required by API; uses configured market). */
  async getArtistTopTracks(id: string, market?: string): Promise<SpotifyTrack[]> {
    const json = await this.get(`/artists/${id}/top-tracks`, { market: market || this.cfg.market });
    const items: SpotifyTrack[] = (json.tracks || []).map((t: any) => mapTrack(t));
    return items;
  }
  /** Fetch artist albums by include groups (album,single,appears_on,compilation). Defaults to all. */
  async getArtistAlbums(id: string, opts: { includeGroups?: string; limit?: number; market?: string; fetchAll?: boolean; maxPages?: number } = {}): Promise<{ artistId: string; total: number; items: SpotifyAlbum[]; raw: any[] }> {
    const includeGroups = opts.includeGroups || 'album,single';
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);
    const market = opts.market || this.cfg.market;
    const fetchAll = opts.fetchAll ?? false; // usually we just need first page
    const maxPages = opts.maxPages ?? 5;
    let offset = 0; let page = 0; const items: SpotifyAlbum[] = []; const raws: any[] = []; let total = 0;
    do {
      const json = await this.get(`/artists/${id}/albums`, { include_groups: includeGroups, market, limit: String(limit), offset: String(offset) });
      total = json.total ?? total;
      const albums = (json.items||[]).map(mapAlbum);
      items.push(...albums); raws.push(json);
      offset += albums.length; page++;
      if(!fetchAll) break;
    } while(offset < total && page < maxPages);
    return { artistId: id, total, items, raw: raws };
  }
}

/** Set global locale for all SpotifyClient instances (format like en-US). */
export function setSpotifyLocale(locale: string){
  if(typeof locale === 'string' && locale){
    __sharedLocale = locale;
  }
}

function defaultLocale(){
  try {
    // @ts-ignore
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const l = (nav?.language || nav?.languages?.[0]) as string | undefined;
    if(l) return normalizeLocale(l);
  } catch {}
  return 'en-US';
}

function normalizeLocale(l: string){
  if(!l) return 'en-US';
  // Ensure pattern xx-YY
  const parts = l.replace('_','-').split('-');
  if(parts.length === 1){
    const map: Record<string,string> = { en:'US', es:'ES' };
    const region = map[parts[0].toLowerCase()] || parts[0].toUpperCase();
    return parts[0].toLowerCase() + '-' + region;
  }
  return parts[0].toLowerCase() + '-' + parts[1].toUpperCase();
}

function mapArtist(a: any): SpotifyArtist { return { id: a.id, name: a.name, url: a.external_urls?.spotify, genres: a.genres || [], images: a.images || [], followers: a.followers?.total, popularity: a.popularity }; }
function mapArtistRef(a: any): SpotifyArtistRef { return { id: a.id, name: a.name, url: a.external_urls?.spotify }; }
function mapAlbum(a: any): SpotifyAlbum { return { id: a.id, name: a.name, url: a.external_urls?.spotify, albumType: a.album_type, releaseDate: a.release_date, totalTracks: a.total_tracks, images: a.images || [], artists: (a.artists||[]).map(mapArtistRef), label: a.label, copyrights: (a.copyrights||[]).map((c:any)=> c.text).filter(Boolean) }; }
function mapAlbumRef(a: any): SpotifyAlbumRef { return { id: a.id, name: a.name, url: a.external_urls?.spotify, images: a.images || [] }; }
function mapTrack(t: any): SpotifyTrack { return { id: t.id, name: t.name, url: t.external_urls?.spotify, durationMs: t.duration_ms, explicit: !!t.explicit, trackNumber: t.track_number, discNumber: t.disc_number, previewUrl: t.preview_url || undefined, popularity: t.popularity, artists: (t.artists||[]).map(mapArtistRef), album: t.album ? mapAlbumRef(t.album) : undefined }; }
function mapPlaylist(p: any): SpotifyPlaylist { return { id: p.id, name: p.name, url: p.external_urls?.spotify, images: p.images || [], description: p.description, ownerName: p.owner?.display_name || p.owner?.id, totalTracks: p.tracks?.total }; }

async function safeReadText(res: Response){ try { return await res.text(); } catch { return ''; } }

export default SpotifyClient;
