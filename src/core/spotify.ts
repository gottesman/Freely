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
}

export interface SpotifySearchResult<T> { query: string; type: string; items: T[]; raw: any; }
export interface SpotifyArtist { id: string; name: string; url: string; genres: string[]; images: { url: string; width?: number; height?: number }[]; followers?: number; popularity?: number; }
export interface SpotifyAlbum { id: string; name: string; url: string; albumType: string; releaseDate: string; totalTracks: number; images: { url: string; width?: number; height?: number }[]; artists: SpotifyArtistRef[]; }
export interface SpotifyTrack { id: string; name: string; url: string; durationMs: number; explicit: boolean; trackNumber: number; discNumber: number; previewUrl?: string; popularity?: number; artists: SpotifyArtistRef[]; album?: SpotifyAlbumRef; }
export interface SpotifyArtistRef { id: string; name: string; url: string; }
export interface SpotifyAlbumRef { id: string; name: string; url: string; images?: { url: string; width?: number; height?: number }[]; }
export interface SpotifyPlaylist { id: string; name: string; url: string; images: { url: string; width?: number; height?: number }[]; description?: string; }

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

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
  constructor(cfg: SpotifyConfig = {}) { this.cfg = { market: env('SPOTIFY_DEFAULT_MARKET') || 'US', ...cfg }; }

  setCredentials(clientId: string, clientSecret: string){ this.cfg.clientId = clientId; this.cfg.clientSecret = clientSecret; }
  setAccessToken(token: string, expiresInSec = 3500){ this.cfg.accessToken = token; this.cfg.tokenExpiresAt = Date.now() + (expiresInSec * 1000); }

  private async ensureToken(){
    // Reuse cached token if still valid (1 min early refresh window)
    if (this.cfg.accessToken && this.cfg.tokenExpiresAt && Date.now() < this.cfg.tokenExpiresAt - 60_000) return;

    // Support external token endpoint for browser (no secret). Vite exposes only VITE_ prefixed vars.
    const externalEndpoint = env('VITE_SPOTIFY_TOKEN_ENDPOINT') || env('SPOTIFY_TOKEN_ENDPOINT');
    if (externalEndpoint){
      try {
        const r = await fetch(String(externalEndpoint), { headers: { 'Accept':'application/json' } });
        const ct = r.headers.get('content-type')||'';
        let raw = '';
        if(!r.ok){ raw = await safeReadText(r); throw new Error('token_http_'+r.status); }
        if(!/json/i.test(ct)){ raw = await safeReadText(r); throw new Error('token_ct:'+ct+' snippet:'+ raw.slice(0,40)); }
        const j = await r.json();
        if(!j.access_token) throw new Error('token_missing_access_token');
        const exp = Number(j.expires_in || 3600);
        this.setAccessToken(j.access_token, exp);
        return;
      } catch (e){
        // Fall through to client credentials attempt only if we actually have credentials
        const hasCreds = (this.cfg.clientId || env('SPOTIFY_CLIENT_ID')) && (this.cfg.clientSecret || env('SPOTIFY_CLIENT_SECRET'));
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
    this.setAccessToken(json.access_token, json.expires_in);
  }

  private async get(path: string, params?: Record<string,string|number|undefined>){
    await this.ensureToken();
    const search = params ? '?' + new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined) as any) : '';
    const url = API_BASE + path + search;
    const k = 'GET:' + url;
    const cached = this.cache.get(k);
    if (cached && Date.now() - cached.t < 60_000) return cached.v;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + this.cfg.accessToken } });
    if (!res.ok) throw new Error('Spotify HTTP ' + res.status);
    const json = await res.json();
    this.cache.set(k, { v: json, t: Date.now() });
    return json;
  }

  async searchAll(query: string, types: Array<'track'|'album'|'artist'> = ['track','album','artist']){
    const json = await this.get('/search', { q: query, type: types.join(','), market: this.cfg.market, limit: '5' });
    return json;
  }

  async searchTracks(query: string): Promise<SpotifySearchResult<SpotifyTrack>> {
    const json = await this.get('/search', { q: query, type: 'track', market: this.cfg.market, limit: '20' });
    const items = (json.tracks?.items || []).map(mapTrack);
    return { query, type: 'track', items, raw: json };
  }
  async searchAlbums(query: string): Promise<SpotifySearchResult<SpotifyAlbum>> {
    const json = await this.get('/search', { q: query, type: 'album', market: this.cfg.market, limit: '20' });
    const items = (json.albums?.items || []).map(mapAlbum);
    return { query, type: 'album', items, raw: json };
  }
  async searchArtists(query: string): Promise<SpotifySearchResult<SpotifyArtist>> {
    const json = await this.get('/search', { q: query, type: 'artist', market: this.cfg.market, limit: '20' });
    const items = (json.artists?.items || []).map(mapArtist);
    return { query, type: 'artist', items, raw: json };
  }
  async searchPlaylists(query: string): Promise<SpotifySearchResult<SpotifyPlaylist>> {
    const json = await this.get('/search', { q: query, type: 'playlist', market: this.cfg.market, limit: '20' });
    const items = (json.playlists?.items || []).map(mapPlaylist);
    return { query, type: 'playlist', items, raw: json } as any;
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

function mapArtist(a: any): SpotifyArtist { return { id: a.id, name: a.name, url: a.external_urls?.spotify, genres: a.genres || [], images: a.images || [], followers: a.followers?.total, popularity: a.popularity }; }
function mapArtistRef(a: any): SpotifyArtistRef { return { id: a.id, name: a.name, url: a.external_urls?.spotify }; }
function mapAlbum(a: any): SpotifyAlbum { return { id: a.id, name: a.name, url: a.external_urls?.spotify, albumType: a.album_type, releaseDate: a.release_date, totalTracks: a.total_tracks, images: a.images || [], artists: (a.artists||[]).map(mapArtistRef) }; }
function mapAlbumRef(a: any): SpotifyAlbumRef { return { id: a.id, name: a.name, url: a.external_urls?.spotify, images: a.images || [] }; }
function mapTrack(t: any): SpotifyTrack { return { id: t.id, name: t.name, url: t.external_urls?.spotify, durationMs: t.duration_ms, explicit: !!t.explicit, trackNumber: t.track_number, discNumber: t.disc_number, previewUrl: t.preview_url || undefined, popularity: t.popularity, artists: (t.artists||[]).map(mapArtistRef), album: t.album ? mapAlbumRef(t.album) : undefined }; }
function mapPlaylist(p: any): SpotifyPlaylist { return { id: p.id, name: p.name, url: p.external_urls?.spotify, images: p.images || [], description: p.description }; }

async function safeReadText(res: Response){ try { return await res.text(); } catch { return ''; } }

export default SpotifyClient;
