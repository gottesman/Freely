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
// Cache ReccoBeats recommendations for the app lifetime to avoid repeated calls
const __reccoCache = new Map<string, Promise<{ tracks: SpotifyTrack[]; seeds: any[]; raw: any }>>();

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

  /**
   * Get recommendations based on seed artists / tracks / genres.
   * See: https://developer.spotify.com/documentation/web-api/reference/#/operations/get-recommendations
   * opts:
   *  - limit (1-100, default 20)
   *  - market (ISO country code)
   *  - seed_artists (string or string[])
   *  - seed_genres (string or string[])
   *  - seed_tracks (string or string[])
   */
  async getRecommendations(opts: { limit?: number; market?: string; seed_artists?: string | string[]; seed_genres?: string | string[]; seed_tracks?: string | string[]; seeds?: string[] } = {}): Promise<{ tracks: SpotifyTrack[]; seeds: any[]; raw: any }> {
    // Use ReccoBeats API as Spotify /recommendations is deprecated.
    const RECCO_BASE = 'https://api.reccobeats.com/v1';
    const size = Math.min(Math.max(opts.limit ?? 20, 1), 100);

    // ReccoBeats expects: seeds = string[] (required, 1..5 Spotify track IDs)
    // Support legacy opts.seed_tracks and best-effort seed_artists conversion for compatibility.
    let seedsArray: string[] = [];
    // Primary: explicit array in opts.seeds
    if (Array.isArray(opts.seeds) && opts.seeds.length) {
      seedsArray = opts.seeds.map(String);
    } else if (opts.seed_tracks) {
      seedsArray = Array.isArray(opts.seed_tracks) ? opts.seed_tracks.map(String) : String(opts.seed_tracks).split(',').map(s => s.trim()).filter(Boolean);
    } else if (opts.seed_artists) {
      const artistIds = Array.isArray(opts.seed_artists) ? opts.seed_artists.map(String) : String(opts.seed_artists).split(',').map(s => s.trim()).filter(Boolean);
      // Try to get one top track per artist (best-effort)
      for (const aid of artistIds.slice(0, 5)) {
        try {
          const top = await this.get(`/artists/${aid}/top-tracks`, { market: opts.market || this.cfg.market });
          const first = Array.isArray(top.tracks) && top.tracks.length ? top.tracks[0] : null;
          if (first && first.id) seedsArray.push(first.id);
        } catch (e) { /* ignore per-artist failures */ }
      }
    }

    // Helper: extract Spotify track id from a href if user passed a url
    const extractSpotifyId = (href?: string) => {
      if (!href || typeof href !== 'string') return undefined;
      const m = href.match(/(?:open\.spotify\.com\/(?:track|tracks)\/|spotify:track:)([A-Za-z0-9]{22})/i);
      return m ? m[1] : undefined;
    };

    // Normalize and validate seed IDs: prefer raw id, else try to extract from url-like values
    seedsArray = seedsArray.map(s => String(s).trim()).filter(Boolean).map(s => {
      // If looks like a full spotify url or uri, try extract
      if (!/^[A-Za-z0-9]{22}$/.test(s)) {
        const ext = extractSpotifyId(s);
        return ext || s;
      }
      return s;
    }).filter(Boolean);

    // Keep only valid-looking Spotify IDs (22 alnum chars). This enforces the ReccoBeats spec.
    seedsArray = seedsArray.filter(s => /^[A-Za-z0-9]{22}$/.test(s)).slice(0, 5);
    if (seedsArray.length < 1 || seedsArray.length > 5) {
      throw new Error('getRecommendations requires 1 to 5 valid Spotify track IDs in opts.seeds (or seed_tracks)');
    }

    const key = `${size}|${seedsArray.join(',')}`;
    // Return cached Promise if present
    if (__reccoCache.has(key)) return __reccoCache.get(key)!;

    // Store the inflight Promise so concurrent callers get the same result
    const inflight = (async () => {
      const params = new URLSearchParams();
      params.set('size', String(size));
      for (const s of seedsArray) params.append('seeds', s);

      const url = `${RECCO_BASE}/track/recommendation?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) {
        let bodyText = '';
        try { bodyText = await res.text(); } catch(e) { bodyText = String(e); }
        console.error('ReccoBeats error response:', res.status, bodyText);
        throw new Error('ReccoBeats recommendation HTTP ' + res.status + (bodyText ? ' - ' + bodyText : ''));
      }
      const json = await res.json();

    // Attempt to extract tracks from common shapes (including ReccoBeats `content`)
    let rawList: any[] = [];
    if (Array.isArray(json)) rawList = json;
    else if (Array.isArray((json as any).content)) rawList = (json as any).content;
    else if (Array.isArray((json as any).tracks)) rawList = (json as any).tracks;
    else if (Array.isArray((json as any).data)) rawList = (json as any).data;
    else if (Array.isArray((json as any).items)) rawList = (json as any).items;

    // Helper to extract a Spotify id from an open.spotify.com href (track/artist/album)
    const extractSpotifyId = (href?: string) => {
      if (!href || typeof href !== 'string') return undefined;
      const m = href.match(/open\.spotify\.com\/(?:track|tracks|artist|album)\/(?:embed\/)?([A-Za-z0-9]+)(?:[?\/]|$)/i);
      return m ? m[1] : undefined;
    };

    // Map into SpotifyTrack-like objects when possible
  const mapped: SpotifyTrack[] = rawList.map((it: any) => {
      // Support different shapes: ReccoBeats uses trackTitle, href, durationMs, popularity, artists[{name, href}]
      const name = it.name || it.title || it.trackTitle || '';
      const url = it.external_urls?.spotify || it.href || it.url || undefined;
      const idFromHref = extractSpotifyId(url);
      const id = idFromHref;
      const durationMs = it.duration_ms || it.duration || it.durationMs || undefined;
      const popularity = it.popularity ?? it.score ?? undefined;

      // Normalize artists
      let artistsArr: any[] = [];
      if (Array.isArray(it.artists)) artistsArr = it.artists;
      else if (Array.isArray(it.artist)) artistsArr = it.artist;
      else artistsArr = [];

      const mappedArtists: SpotifyArtistRef[] = (artistsArr || []).map((a: any) => {
        const aUrl = a.external_urls?.spotify || a.href || a.url || undefined;
        const aId = extractSpotifyId(aUrl);
        return { id: aId, name: a.name || a.artistName || '', url: aUrl } as SpotifyArtistRef;
      });

      const album = it.album || it.albumInfo || it.album_ref || undefined;
      const albumRef = album ? { id: extractSpotifyId(album.external_urls?.spotify || album.href || album.url), name: album.name, url: album.external_urls?.spotify || album.href || album.url, images: album.images || [] } : undefined;

      return {
        id: id,
        name: name,
        url: url,
        durationMs: durationMs,
        explicit: !!it.explicit,
        trackNumber: it.track_number || it.trackNumber || 0,
        discNumber: it.disc_number || it.discNumber || 0,
        previewUrl: it.preview_url || it.previewUrl || undefined,
        popularity: popularity,
        artists: mappedArtists,
        album: albumRef
      } as SpotifyTrack;
    });

    // Best-effort: enrich mapped tracks by fetching Spotify track details for items
    // that lack album images. This helps provide cover art when ReccoBeats doesn't include it.
    try {
      const idsToFetch = mapped
        .filter(t => (!!t.id) && (!(t.album && Array.isArray(t.album.images) && t.album.images.length)))
        .map(t => t.id) as string[];
      const uniqueIds = Array.from(new Set(idsToFetch)).slice(0, 10); // limit to 10 tracks
      if (uniqueIds.length) {
        const fetched = await Promise.all(uniqueIds.map(id => this.getTrack(id).catch(() => null)));
        const byId = new Map<string, SpotifyTrack>();
        for (const f of fetched) if (f && f.id) byId.set(f.id, f);
        for (let i = 0; i < mapped.length; i++) {
          const t = mapped[i];
          if (!t || !t.id) continue;
          const fres = byId.get(t.id);
          if (!fres) continue;
          // Merge useful fields, prefer existing data when present
          if (!(t.album && Array.isArray(t.album.images) && t.album.images.length)) t.album = fres.album;
          if (!(t.artists && t.artists.length)) t.artists = fres.artists;
          if (!t.previewUrl && fres.previewUrl) t.previewUrl = fres.previewUrl;
          if (!t.durationMs && fres.durationMs) t.durationMs = fres.durationMs;
          if (t.popularity === undefined && fres.popularity !== undefined) t.popularity = fres.popularity;
        }
      }
    } catch (e) {
      // Enrichment is non-critical; ignore failures
      console.log('Recommendation enrichment failed:', e);
    }

      return { tracks: mapped, seeds: seedsArray, raw: json };
    })();

    __reccoCache.set(key, inflight);
    return inflight;
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
