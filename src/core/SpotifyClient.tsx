import { useMemo } from 'react';
import { env } from './AccessEnv';
import { useDB } from './Database'

// Performance and configuration constants
const SPOTIFY_CONSTANTS = {
  LIMITS: {
    DEFAULT_SEARCH_LIMIT: 20,
    MAX_SEARCH_LIMIT: 50,
    MIN_SEARCH_LIMIT: 1,
    MAX_TRACK_BATCH: 50,
    MAX_ALBUM_TRACKS: 50,
    MAX_PLAYLIST_PAGES: 20,
    MAX_ARTIST_PAGES: 5,
    MAX_RECOMMENDATIONS: 100,
    MAX_ENRICHMENT_TRACKS: 10,
    DEFAULT_TRACK_LIMIT: 10,
    MAX_TRACK_LIMIT: 50
  },
  TIMING: {
    TOKEN_BUFFER_MS: 60_000,
    MEMORY_CACHE_TTL_MS: 60_000,
    FETCH_TIMEOUT_MS: 10_000
  },
  SEARCH_TYPES: {
    TRACK: 'track',
    ALBUM: 'album', 
    ARTIST: 'artist',
    PLAYLIST: 'playlist'
  } as const,
  GLOBAL_KEYS: {
    WARMED_CLIENT: '__freelySpotifyClient'
  }
} as const;

// Log prefixes for consistent debugging output
const LOG_PREFIXES = {
  CLIENT: '🔧',
  FALLBACK: '🚨',
  DATABASE: '💾',
  SEARCH: '🔍',
  PRELOAD: '⚡',
  WAITING: '⏳'
} as const;

// TypeScript interfaces for better type safety
interface DatabaseCache {
  getApiCache: (key: string) => Promise<any | null>;
  setApiCache: (key: string, data: any) => Promise<void>;
}

interface SearchOptions {
  limit?: number;
}

interface SearchResult {
  query: string;
  types: string[];
  results: Record<string, any>;
}

interface SpotifySearchResponse {
  items: any[];
}

type SearchType = typeof SPOTIFY_CONSTANTS.SEARCH_TYPES[keyof typeof SPOTIFY_CONSTANTS.SEARCH_TYPES];
type SearchTypes = SearchType | SearchType[];

// Utility class for client caching management
class SpotifyClientCache {
  private static cachedClient: SpotifyClient | null = null;

  /**
   * Get the cached client instance, checking for pre-warmed client first
   */
  static getClient(): SpotifyClient | null {
    // Check for pre-warmed client from startup process
    if (!this.cachedClient && (window as any)[SPOTIFY_CONSTANTS.GLOBAL_KEYS.WARMED_CLIENT]) {
      this.cachedClient = (window as any)[SPOTIFY_CONSTANTS.GLOBAL_KEYS.WARMED_CLIENT];
      console.log(`${LOG_PREFIXES.CLIENT} Using pre-warmed SpotifyClient instance`);
    }
    
    return this.cachedClient;
  }

  /**
   * Create and cache a fallback client if needed
   */
  static createFallbackClient(dbCache?: DatabaseCache): SpotifyClient {
    if (!this.cachedClient) {
      this.cachedClient = new SpotifyClient();
      console.log(`${LOG_PREFIXES.FALLBACK} Created fallback SpotifyClient instance`);
      
      if (dbCache) {
        this.cachedClient.setDatabaseCache(dbCache);
        console.log(`${LOG_PREFIXES.DATABASE} Injected database cache into fallback SpotifyClient`);
      }
    }
    
    return this.cachedClient;
  }

  /**
   * Set the cached client instance
   */
  static setClient(client: SpotifyClient): void {
    this.cachedClient = client;
  }
}

// Utility class for search operations
class SpotifySearchManager {
  /**
   * Normalize search types to array format
   */
  static normalizeSearchTypes(typeOrTypes: SearchTypes): string[] {
    return Array.isArray(typeOrTypes) 
      ? typeOrTypes 
      : String(typeOrTypes).split(',').map(s => s.trim()).filter(Boolean);
  }

  /**
   * Validate and normalize search limit
   */
  static normalizeLimit(limit?: number): number {
    const { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, MIN_SEARCH_LIMIT } = SPOTIFY_CONSTANTS.LIMITS;
    const requestedLimit = limit ?? DEFAULT_SEARCH_LIMIT;
    return Math.min(MAX_SEARCH_LIMIT, Math.max(MIN_SEARCH_LIMIT, requestedLimit));
  }

  /**
   * Check if preload search is available
   */
  static isPreloadSearchAvailable(): boolean {
    const w: any = window as any;
    return Boolean(w.electron?.spotify?.search);
  }

  /**
   * Perform search via electron preload if available
   */
  static async searchViaPreload(query: string, types: SearchTypes, options?: SearchOptions): Promise<SearchResult> {
    const w: any = window as any;
    return await w.electron.spotify.search(query, types, options);
  }

  /**
   * Check if client supports multi-search
   */
  static supportsMultiSearch(client: SpotifyClient): boolean {
    return typeof (client as any).searchMulti === 'function';
  }

  /**
   * Perform multi-search on client
   */
  static async performMultiSearch(client: SpotifyClient, query: string, types: string[], limit: number): Promise<SearchResult> {
    const multi = await (client as any).searchMulti(query, types, limit);
    return { query, types, results: multi.results };
  }
}

/**
 * Hook to get a SpotifyClient instance with database caching enabled.
 * Now uses the pre-warmed client from the app startup process.
 */
export function useSpotifyClient(): SpotifyClient {
  const { getApiCache, setApiCache, ready } = useDB();
  
  // Memoize database cache object to prevent unnecessary recreations
  const dbCache = useMemo(() => ({ getApiCache, setApiCache }), [getApiCache, setApiCache]);
  
  // Memoize client creation logic
  const client = useMemo(() => {
    // Try to get cached client first
    let currentClient = SpotifyClientCache.getClient();
    
    // Create fallback if needed
    if (!currentClient) {
      currentClient = SpotifyClientCache.createFallbackClient(ready ? dbCache : undefined);
    }
    
    if (!ready) {
      console.log(`${LOG_PREFIXES.WAITING} Database not ready yet for SpotifyClient`);
    }
    
    return currentClient;
  }, [ready, dbCache]);
  
  return client;
}

/**
 * Create a SpotifyClient instance with database caching.
 * Use this in components that can't use hooks.
 */
export function createCachedSpotifyClient(dbCache?: DatabaseCache): SpotifyClient {
  const client = new SpotifyClient();
  if (dbCache) {
    client.setDatabaseCache(dbCache);
    console.log(`${LOG_PREFIXES.DATABASE} Database cache injected into new SpotifyClient`);
  }
  return client;
}

/**
 * Cross-environment search helper.
 * - In Electron renderer with preload: forwards to `window.electron.spotify.search`.
 * - Otherwise uses the pre-warmed `SpotifyClient` instance or creates a short-lived client.
 * Returns { query, types, results } to match IPC response shape.
 */
export async function search(query: string, typeOrTypes: SearchTypes = SPOTIFY_CONSTANTS.SEARCH_TYPES.TRACK, options?: SearchOptions): Promise<SearchResult> {
  // Early return for invalid queries
  if (!query || !String(query).trim()) {
    return { query, types: [], results: {} };
  }

  const normalizedTypes = SpotifySearchManager.normalizeSearchTypes(typeOrTypes);
  const normalizedLimit = SpotifySearchManager.normalizeLimit(options?.limit);

  // Try electron preload first (keeps auth server-side)
  if (SpotifySearchManager.isPreloadSearchAvailable()) {
    try {
      console.log(`${LOG_PREFIXES.PRELOAD} Using electron preload search`);
      return await SpotifySearchManager.searchViaPreload(query, typeOrTypes, options);
    } catch (error) {
      console.warn(`${LOG_PREFIXES.PRELOAD} Preload search failed, falling back to direct client:`, error);
    }
  }

  // Fallback to direct client search
  console.log(`${LOG_PREFIXES.SEARCH} Using direct SpotifyClient search`);
  const client = SpotifyClientCache.getClient() || new SpotifyClient();

  // Try multi-search if supported
  if (SpotifySearchManager.supportsMultiSearch(client)) {
    try {
      console.log(`${LOG_PREFIXES.SEARCH} Using multi-search API`);
      return await SpotifySearchManager.performMultiSearch(client, query, normalizedTypes, normalizedLimit);
    } catch (error) {
      console.warn(`${LOG_PREFIXES.SEARCH} Multi-search failed, falling back to individual calls:`, error);
    }
  }

  // Fallback: individual search calls per type
  console.log(`${LOG_PREFIXES.SEARCH} Using individual search calls`);
  return await performIndividualSearches(client, query, normalizedTypes, normalizedLimit);
}

/**
 * Perform individual search calls for each type (fallback method)
 */
async function performIndividualSearches(client: SpotifyClient, query: string, types: string[], limit: number): Promise<SearchResult> {
  const results: Record<string, any> = {};
  const { SEARCH_TYPES } = SPOTIFY_CONSTANTS;

  // Map of search functions for each type
  const searchFunctions: Record<string, () => Promise<SpotifySearchResponse>> = {
    [SEARCH_TYPES.TRACK]: () => client.searchTracks(query, limit),
    [SEARCH_TYPES.ALBUM]: () => client.searchAlbums(query, limit),
    [SEARCH_TYPES.ARTIST]: () => client.searchArtists(query, limit),
    [SEARCH_TYPES.PLAYLIST]: () => client.searchPlaylists(query, limit)
  };

  // Execute searches for requested types in parallel
  const searchPromises = types
    .filter(type => searchFunctions[type])
    .map(type => handleSearchCall(searchFunctions[type], type, results));

  await Promise.all(searchPromises);
  return { query, types, results };
}

/**
 * Handle individual search call with error handling
 */
async function handleSearchCall(
  searchFn: () => Promise<SpotifySearchResponse>,
  type: string,
  results: Record<string, any>
): Promise<void> {
  try {
    const response = await searchFn();
    results[type] = response.items || [];
  } catch (error) {
    console.warn(`${LOG_PREFIXES.SEARCH} Search failed for type "${type}":`, error);
    results[type] = [];
  }
}

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
export interface SpotifyAlbum { id: string; name: string; url?: string; albumType?: string; releaseDate?: string; totalTracks?: number; images?: { url: string; width?: number; height?: number }[]; artists?: SpotifyArtistRef[]; label?: string; copyrights?: string[]; }
export interface SpotifyTrack {
  id: string;
  name: string;
  url: string;
  durationMs: number;
  explicit: boolean;
  trackNumber: number;
  discNumber: number;
  previewUrl?: string;
  popularity?: number;
  artists: SpotifyArtistRef[];
  album: SpotifyAlbum;
  linked_from?: { id: string; type: string; uri: string; };
}
export interface SpotifyArtistRef { id: string; name: string; url: string; }
export interface SpotifyPlaylist { id: string; name: string; url: string; images: { url: string; width?: number; height?: number }[]; description?: string; ownerName?: string; totalTracks?: number; }

const API_BASE = 'https://api.spotify.com/v1';
const RECCO_BASE = 'https://api.reccobeats.com/v1';

// Module-level shared state
const SharedState = {
  token: { accessToken: '', tokenExpiresAt: 0 },
  tokenInflight: undefined as Promise<void> | undefined,
  locale: undefined as string | undefined,
  reccoCache: new Map<string, Promise<{ tracks: SpotifyTrack[]; seeds: any[]; raw: any }>>()
};

export class SpotifyClient {
  private cfg: SpotifyConfig;
  private cache = new Map<string, any>();
  private tokenInflight?: Promise<void>; // de-dupe concurrent token fetches
  private db?: { getApiCache: (key: string) => Promise<any | null>; setApiCache: (key: string, data: any) => Promise<void> }; // database cache

  constructor(cfg: SpotifyConfig = {}) {
    this.cfg = { market: '', ...cfg };
    this.setMarket();
  }

  async setMarket() { return this.cfg.market = await env('SPOTIFY_DEFAULT_MARKET'); }

  // Inject database cache functions
  setDatabaseCache(db: { getApiCache: (key: string) => Promise<any | null>; setApiCache: (key: string, data: any) => Promise<void> }) {
    this.db = db;
  }

  // Helper to build per-entity cache keys
  private entityCacheKey(kind: 'TRACK' | 'ALBUM' | 'ARTIST', id: string) {
    return `SPOTIFY:${kind}:${id}`;
  }

  // Extract a Spotify id (22 alnum chars) from a spotify uri or url if present
  private extractSpotifyId(href?: string) {
    if (!href || typeof href !== 'string') return undefined;
    const m = href.match(/(?:open\.spotify\.com\/(?:track|tracks)\/|spotify:track:|spotify:)([A-Za-z0-9]{22})/i);
    return m ? m[1] : undefined;
  }

  setCredentials(clientId: string, clientSecret: string) { this.cfg.clientId = clientId; this.cfg.clientSecret = clientSecret; }
  setAccessToken(token: string, expiresInSec = 3600) {
    const exp = Date.now() + (expiresInSec * 1000);
    this.cfg.accessToken = token; 
    this.cfg.tokenExpiresAt = exp;
    SharedState.token.accessToken = token; 
    SharedState.token.tokenExpiresAt = exp;
  }

  // Public helper: tells if current token is valid with buffer
  public isTokenValid(bufferMs: number = SPOTIFY_CONSTANTS.TIMING.TOKEN_BUFFER_MS): boolean {
    const exp = this.cfg.tokenExpiresAt || SharedState.token.tokenExpiresAt || 0;
    const token = this.cfg.accessToken || SharedState.token.accessToken || '';
    const hasToken = Boolean(token);
    const isNotExpired = Date.now() < (exp - bufferMs);
    const isValid = hasToken && isNotExpired;
    
    console.log('🔍 Token validation check:', {
      hasToken,
      expiresAt: exp,
      now: Date.now(),
      timeUntilExpiry: exp - Date.now(),
      bufferMs,
      isNotExpired,
      isValid
    });
    
    return isValid;
  }

  // Public helper: ensure we have a valid token (fetch if needed)
  public async ensureAccessToken(): Promise<void> {
    await this.ensureToken();
  }

  // Public helper: clear invalid cached tokens
  public clearTokenCache(): void {
    console.log('🧹 Clearing Spotify token cache');
    this.cfg.accessToken = undefined;
    this.cfg.tokenExpiresAt = undefined;
    SharedState.token.accessToken = '';
    SharedState.token.tokenExpiresAt = 0;
  }

  // Public helper: get token status for debugging
  public getTokenStatus(): { hasToken: boolean; expiresAt: number; timeUntilExpiry: number; source: string } {
    const instanceToken = this.cfg.accessToken;
    const sharedToken = SharedState.token.accessToken;
    const instanceExp = this.cfg.tokenExpiresAt || 0;
    const sharedExp = SharedState.token.tokenExpiresAt || 0;
    
    const effectiveToken = instanceToken || sharedToken;
    const effectiveExp = instanceExp || sharedExp;
    
    return {
      hasToken: Boolean(effectiveToken),
      expiresAt: effectiveExp,
      timeUntilExpiry: effectiveExp - Date.now(),
      source: instanceToken ? 'instance' : sharedToken ? 'shared' : 'none'
    };
  }

  private async ensureToken() {
    // Prefer instance token if valid
    const bufferTime = SPOTIFY_CONSTANTS.TIMING.TOKEN_BUFFER_MS;
    if (this.cfg.accessToken && this.cfg.tokenExpiresAt && Date.now() < this.cfg.tokenExpiresAt - bufferTime) return;
    if (this.cfg.accessToken && !this.cfg.tokenExpiresAt) return; // static injected
    
    // Try shared token if instance lacks/expired
    const { token } = SharedState;
    if (!this.cfg.accessToken && token.accessToken && token.tokenExpiresAt && Date.now() < token.tokenExpiresAt - bufferTime) {
      this.cfg.accessToken = token.accessToken; 
      this.cfg.tokenExpiresAt = token.tokenExpiresAt; 
      return;
    }
    
    // Await shared inflight if present
    if (SharedState.tokenInflight) {
      await SharedState.tokenInflight;
      if (this.cfg.accessToken && this.cfg.tokenExpiresAt && Date.now() < this.cfg.tokenExpiresAt - bufferTime) return;
      if (token.accessToken) { 
        this.cfg.accessToken = token.accessToken; 
        this.cfg.tokenExpiresAt = token.tokenExpiresAt; 
      }
      return;
    }
    
    // Start new fetch
    SharedState.tokenInflight = this.tokenInflight = this.fetchNewToken();

    try { 
      await this.tokenInflight; 
    } finally { 
      this.tokenInflight = undefined; 
      SharedState.tokenInflight = undefined; 
    }
  }

  private async fetchNewToken(): Promise<void> {
    const externalEndpoint = await env('SPOTIFY_TOKEN_ENDPOINT');
    
    if (externalEndpoint) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SPOTIFY_CONSTANTS.TIMING.FETCH_TIMEOUT_MS);

        const r = await fetch(String(externalEndpoint), {
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        });
        clearTimeout(timeout);

        const ct = r.headers.get('content-type') || '';
        
        if (!r.ok) {
          const raw = await safeReadText(r);
          console.error('❌ Token endpoint HTTP error:', r.status, raw);
          throw new Error('token_http_' + r.status);
        }
        
        if (!/json/i.test(ct)) {
          const raw = await safeReadText(r);
          console.error('❌ Token endpoint content-type error:', ct, 'body:', raw.slice(0, 40));
          throw new Error('token_ct:' + ct + ' snippet:' + raw.slice(0, 40));
        }
        
        const j = await r.json();
        
        if (!j.access_token) throw new Error('token_missing_access_token');
        
        // Calculate expiry time
        let expiresInSec: number;
        if (j.expires_at_unix) {
          const absMs = Number(j.expires_at_unix) * 1000;
          const diff = Math.floor((absMs - Date.now()) / 1000);
          expiresInSec = isFinite(diff) ? Math.max(1, diff) : 3600;
        } else {
          expiresInSec = Number(j.expires_in || 3600);
        }
        
        this.setAccessToken(j.access_token, expiresInSec);
        return;
      } catch (e) {
        throw new Error('❌ External token endpoint failed: ' + (e as any)?.message);
      }
    }
    
    throw new Error('No method available to obtain Spotify access token');
  }

  private async get(path: string, params?: Record<string, string | number | undefined>) {
    await this.ensureToken();
    
    // Merge locale if not explicitly provided
    const merged: Record<string, string | number | undefined> = { ...(params || {}) };
    if (merged.locale === undefined) {
      const loc = this.cfg.locale || SharedState.locale || defaultLocale();
      if (loc) merged.locale = loc;
    }
    
    const key = CacheHelper.createCacheKey('GET', path, merged);

    // Check database cache first (persistent, indefinite)
    const dbCached = await CacheHelper.checkDatabaseCache(this.db, key, path);
    if (dbCached) return dbCached;

    // Fallback to in-memory cache (TTL for current session)
    const memoryCached = CacheHelper.checkMemoryCache(this.cache, key, path);
    if (memoryCached) return memoryCached;

    if (!this.cfg.accessToken) throw new Error('No Spotify access token available');
    
    // Make API call
    const url = API_BASE + path + (Object.keys(merged).length ? '?' + new URLSearchParams(
      Object.entries(merged).filter(([, v]) => v !== undefined) as any
    ) : '');
    
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + this.cfg.accessToken } });
    if (!res.ok) throw new Error('Spotify HTTP ' + res.status);
    const json = await res.json();

    // Store in both caches
    await CacheHelper.storeInCaches(this.cache, this.db, key, json, path);

    return json;
  }

  /**
   * Perform a single /search request for multiple types (comma-separated) and map results.
   * Returns an object with mapped arrays under keys: track, album, artist, playlist when present.
   */
  async searchMulti(query: string, types: Array<'track' | 'album' | 'artist' | 'playlist'> = ['track', 'album', 'artist', 'playlist'], limit: number = 20) {
    // limit is applied per-type by the Spotify API (max 50)
    const json = await this.get('/search', { q: query, type: types.join(','), market: this.cfg.market, limit: String(limit) });
    const results: Record<string, any[]> = {};
    if (json.tracks && Array.isArray(json.tracks.items)) results.track = (json.tracks.items || []).map(SpotifyMapper.mapTrack);
    if (json.albums && Array.isArray(json.albums.items)) results.album = (json.albums.items || []).map(SpotifyMapper.mapAlbum);
    if (json.artists && Array.isArray(json.artists.items)) results.artist = (json.artists.items || []).map(SpotifyMapper.mapArtist);
    if (json.playlists && Array.isArray(json.playlists.items)) results.playlist = (json.playlists.items || []).filter(Boolean).map(SpotifyMapper.mapPlaylist);
    return { query, types, results, raw: json };
  }

  async searchTracks(query: string, limit: number = 20): Promise<SpotifySearchResult<SpotifyTrack>> {
    const json = await this.get('/search', { q: query, type: 'track', market: this.cfg.market, limit: String(limit) });
    const items = (json.tracks?.items || []).map(SpotifyMapper.mapTrack);
    return { query, type: 'track', items, raw: json };
  }

  async searchAlbums(query: string, limit: number = 20): Promise<SpotifySearchResult<SpotifyAlbum>> {
    const json = await this.get('/search', { q: query, type: 'album', market: this.cfg.market, limit: String(limit) });
    const items = (json.albums?.items || []).map(SpotifyMapper.mapAlbum);
    return { query, type: 'album', items, raw: json };
  }

  async searchArtists(query: string, limit: number = 20): Promise<SpotifySearchResult<SpotifyArtist>> {
    const json = await this.get('/search', { q: query, type: 'artist', market: this.cfg.market, limit: String(limit) });
    const items = (json.artists?.items || []).map(SpotifyMapper.mapArtist);
    return { query, type: 'artist', items, raw: json };
  }

  async searchPlaylists(query: string, limit: number = 20): Promise<SpotifySearchResult<SpotifyPlaylist>> {
    const json = await this.get('/search', { q: query, type: 'playlist', market: this.cfg.market, limit: String(limit) });
    const items = (json.playlists?.items || []).filter(Boolean).map(SpotifyMapper.mapPlaylist);
    return { query, type: 'playlist', items, raw: json } as any;
  }
  async getPlaylist(id: string): Promise<{ playlist: SpotifyPlaylist; tracks: SpotifyTrack[]; raw: any }> {
    // Initial fetch (includes first page of tracks). Spotify max limit per request for playlist items is 100.
    const first = await this.get('/playlists/' + id, { limit: '100' });
    const playlist = SpotifyMapper.mapPlaylist(first);
    const total = first.tracks?.total || 0;
    const collected: SpotifyTrack[] = (first.tracks?.items || [])
      .map((it: any) => it?.track ? SpotifyMapper.mapTrack(it.track) : null)
      .filter(Boolean) as SpotifyTrack[];
    const raws: any[] = [first];
    let offset = collected.length;
    
    // Safety cap to avoid runaway (e.g., 10k tracks). We'll cap at 2,000 tracks (20 pages * 100) unless total smaller.
    const maxPages = SPOTIFY_CONSTANTS.LIMITS.MAX_PLAYLIST_PAGES;
    let page = 1; // first already fetched
    
    while (offset < total && page < maxPages) {
      const next = await this.get('/playlists/' + id + '/tracks', { limit: '100', offset: String(offset) });
      raws.push(next);
      const pageTracks: SpotifyTrack[] = (next.items || [])
        .map((it: any) => it?.track ? SpotifyMapper.mapTrack(it.track) : null)
        .filter(Boolean) as SpotifyTrack[];
      collected.push(...pageTracks);
      offset += pageTracks.length;
      page++;
      if (pageTracks.length === 0) break; // defensive break
    }
    
    return { playlist, tracks: collected, raw: raws };
  }

  async getTrack(id: string): Promise<SpotifyTrack> {
    // Check DB for cached track first
    if (this.db) {
      try {
        const key = this.entityCacheKey('TRACK', id);
        const cached = await this.db.getApiCache(key);
        if (cached) {
          // cached is the raw API shape
          return SpotifyMapper.mapTrack(cached);
        }
      } catch (e) {
        // ignore cache errors and fall back to network
      }
    }
    const json = await this.get('/tracks/' + id, { market: this.cfg.market });
    // Persist to DB (best-effort)
    if (this.db && json && json.id) {
      try {
        this.db.setApiCache(this.entityCacheKey('TRACK', String(json.id)), json).catch(() => {});
        // Also persist nested album and artists when available
        try {
          if (json.album && json.album.id) {
            this.db.setApiCache(this.entityCacheKey('ALBUM', String(json.album.id)), json.album).catch(() => {});
          }
        } catch {}

        // Persist any linked_from id(s) so lookups by redirected id hit the cache
        try {
          const linked = (json as any).linked_from?.id || (json as any).linked_from?.uri || undefined;
          const linkedId = this.extractSpotifyId(String(linked)) || (typeof linked === 'string' ? linked : undefined);
          if (linkedId && String(linkedId) !== String(json.id)) {
            this.db.setApiCache(this.entityCacheKey('TRACK', String(linkedId)), json).catch(() => {});
          }
        } catch {}
      } catch { /* ignore */ }
    }
    return SpotifyMapper.mapTrack(json);
  }
  /**
   * Fetch multiple tracks by id. Handles batching (Spotify max 50 ids per request)
   * Returns an array of SpotifyTrack in the same order as requested (skips missing/nulls).
   */
  async getTracks(ids: string[] | string): Promise<SpotifyTrack[]> {
    const arr = Array.isArray(ids) ? ids.map(String).filter(Boolean) : String(ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!arr.length) return [];

    const MAX_BATCH = 50;
    const out: SpotifyTrack[] = [];

    for (let i = 0; i < arr.length; i += MAX_BATCH) {
      const batch = arr.slice(i, i + MAX_BATCH);
      const batchResults = await this.getTracksBatch(batch);
      out.push(...batchResults);
    }

    return out;
  }

  /**
   * Get a batch of tracks with optimized caching
   */
  private async getTracksBatch(ids: string[]): Promise<SpotifyTrack[]> {
    // Try to get from cache first
    const { cached, missing } = await this.getCachedTracks(ids);

    // Fetch missing tracks from API
    let apiTracks: SpotifyTrack[] = [];
    if (missing.length > 0) {
      try {
        const json = await this.get('/tracks', { ids: missing.join(','), market: this.cfg.market });
        apiTracks = (json.tracks || []).filter(Boolean).map(SpotifyMapper.mapTrack);

        // Cache the fetched tracks
        await this.cacheTracksBatch(apiTracks);
      } catch (e) {
        console.warn('getTracks batch failed:', e);
      }
    }

    // Combine cached and API results in requested order
    return this.mergeTrackResults(ids, cached, apiTracks);
  }

  /**
   * Get cached tracks and return cached and missing IDs
   */
  private async getCachedTracks(ids: string[]): Promise<{ cached: Map<string, SpotifyTrack>; missing: string[] }> {
    const cached = new Map<string, SpotifyTrack>();
    const missing: string[] = [];

    if (!this.db) {
      return { cached, missing: ids };
    }

    try {
      const cachePromises = ids.map(id => this.db!.getApiCache(this.entityCacheKey('TRACK', id)).catch(() => null));
      const cacheResults = await Promise.all(cachePromises);

      ids.forEach((id, index) => {
        const cachedData = cacheResults[index];
        if (cachedData) {
          try {
            cached.set(id, SpotifyMapper.mapTrack(cachedData));
          } catch {
            missing.push(id);
          }
        } else {
          missing.push(id);
        }
      });
    } catch {
      // On cache failure, treat all as missing
      missing.push(...ids);
    }

    return { cached, missing };
  }

  /**
   * Cache a batch of tracks and their related entities
   */
  private async cacheTracksBatch(tracks: SpotifyTrack[]): Promise<void> {
    if (!this.db || !tracks.length) return;

    const cachePromises = tracks.map(async (track) => {
      try {
        // Cache the track
        await this.db.setApiCache(this.entityCacheKey('TRACK', track.id), track).catch(() => {});

        // Cache linked track if different
        const linkedId = (track as any).linked_from?.id;
        if (linkedId && linkedId !== track.id) {
          await this.db.setApiCache(this.entityCacheKey('TRACK', linkedId), track).catch(() => {});
        }

        // Cache album
        if (track.album?.id) {
          await this.db.setApiCache(this.entityCacheKey('ALBUM', track.album.id), track.album).catch(() => {});
        }

        // Cache artists
        if (track.artists) {
          for (const artist of track.artists) {
            if (artist.id) {
              await this.db.setApiCache(this.entityCacheKey('ARTIST', artist.id), artist).catch(() => {});
            }
          }
        }
      } catch { /* ignore cache errors */ }
    });

    await Promise.all(cachePromises);
  }

  /**
   * Merge cached and API results in the requested order
   */
  private mergeTrackResults(requestedIds: string[], cached: Map<string, SpotifyTrack>, apiTracks: SpotifyTrack[]): SpotifyTrack[] {
    const result = new Map<string, SpotifyTrack>();

    // Add cached tracks
    for (const [id, track] of cached) {
      result.set(id, track);
    }

    // Add API tracks (including linked_from variants)
    for (const track of apiTracks) {
      result.set(track.id, track);
      const linkedId = (track as any).linked_from?.id;
      if (linkedId) {
        result.set(linkedId, track);
      }
    }

    // Return in requested order
    return requestedIds.map(id => result.get(id)).filter(Boolean) as SpotifyTrack[];
  }
  async getAlbum(id: string): Promise<SpotifyAlbum> {
    if (this.db) {
      try {
        const key = this.entityCacheKey('ALBUM', id);
        const cached = await this.db.getApiCache(key);
        if (cached) return SpotifyMapper.mapAlbum(cached);
      } catch (e) {
        // ignore
      }
    }
    const json = await this.get('/albums/' + id, { market: this.cfg.market });
    if (this.db && json && json.id) {
      try {
        this.db.setApiCache(this.entityCacheKey('ALBUM', String(json.id)), json).catch(() => {});
        // Persist nested artists from the album record
        try {
          if (Array.isArray(json.artists)) {
            for (const a of json.artists) {
              if (a && a.id) this.db.setApiCache(this.entityCacheKey('ARTIST', String(a.id)), a).catch(() => {});
            }
          }
        } catch {}
      } catch { }
    }
    return SpotifyMapper.mapAlbum(json);
  }
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
    // Fetch album metadata once so tracks (which lack album payload in this endpoint) can reference it
    let albumMeta: SpotifyAlbum | undefined;
    try { albumMeta = await this.getAlbum(id); } catch { /* non-critical */ }
    do {
      const json = await this.get(`/albums/${id}/tracks`, { market, limit: String(limit), offset: String(offset) });
      total = json.total ?? total;
      const tracks = (json.items || []).map((t: any) => SpotifyMapper.mapTrack(t, albumMeta));
      items.push(...tracks);
      raws.push(json);
      offset += tracks.length;
      page++;
      if (!fetchAll) break;
    } while (offset < total && page < maxPages);
    return { albumId: id, total, items, raw: raws };
  }
  async getArtist(id: string): Promise<SpotifyArtist> {
    if (this.db) {
      try {
        const key = this.entityCacheKey('ARTIST', id);
        const cached = await this.db.getApiCache(key);
        if (cached) return SpotifyMapper.mapArtist(cached);
      } catch (e) {
        // ignore
      }
    }
    const json = await this.get('/artists/' + id);
    if (this.db && json && json.id) {
      try { this.db.setApiCache(this.entityCacheKey('ARTIST', String(json.id)), json).catch(() => {}); } catch { }
    }
    return SpotifyMapper.mapArtist(json);
  }

  /** Fetch an artist's top tracks (market required by API; uses configured market). */
  async getArtistTopTracks(id: string, market?: string): Promise<SpotifyTrack[]> {
    const json = await this.get(`/artists/${id}/top-tracks`, { market: market || this.cfg.market });
    const items: SpotifyTrack[] = (json.tracks || []).map((t: any) => SpotifyMapper.mapTrack(t));
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
      const albums = (json.items || []).map(SpotifyMapper.mapAlbum);
      items.push(...albums); raws.push(json);
      offset += albums.length; page++;
      if (!fetchAll) break;
    } while (offset < total && page < maxPages);
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
    const size = Math.min(Math.max(opts.limit ?? 20, 1), SPOTIFY_CONSTANTS.LIMITS.MAX_RECOMMENDATIONS);

    // Normalize seeds to array of Spotify track IDs
    let seedsArray = await this.normalizeSeedsArray(opts);
    
    if (seedsArray.length < 1 || seedsArray.length > 5) {
      throw new Error('getRecommendations requires 1 to 5 valid Spotify track IDs in opts.seeds (or seed_tracks)');
    }

    const key = `${size}|${seedsArray.join(',')}`;
    
    // Return cached Promise if present
    if (SharedState.reccoCache.has(key)) return SharedState.reccoCache.get(key)!;

    // Store the inflight Promise so concurrent callers get the same result
    const inflight = this.fetchRecommendations(size, seedsArray);
    SharedState.reccoCache.set(key, inflight);
    return inflight;
  }

  private async normalizeSeedsArray(opts: any): Promise<string[]> {
    let seedsArray: string[] = [];
    
    // Priority: explicit array in opts.seeds
    if (Array.isArray(opts.seeds) && opts.seeds.length) {
      seedsArray = opts.seeds.map(String);
    } else if (opts.seed_tracks) {
      seedsArray = Array.isArray(opts.seed_tracks) 
        ? opts.seed_tracks.map(String) 
        : String(opts.seed_tracks).split(',').map(s => s.trim()).filter(Boolean);
    } else if (opts.seed_artists) {
      // Convert artist IDs to track IDs by getting top tracks
      return await this.convertArtistSeedsToTracks(opts.seed_artists, opts.market);
    }

    // Normalize and validate seed IDs
    return seedsArray
      .map(s => String(s).trim())
      .filter(Boolean)
      .map(s => {
        // If looks like a full spotify url or uri, try extract
        if (!/^[A-Za-z0-9]{22}$/.test(s)) {
          const ext = this.extractSpotifyId(s);
          return ext || s;
        }
        return s;
      })
      .filter(s => /^[A-Za-z0-9]{22}$/.test(s))
      .slice(0, 5);
  }

  private async convertArtistSeedsToTracks(seedArtists: string | string[], market?: string): Promise<string[]> {
    const artistIds = Array.isArray(seedArtists) 
      ? seedArtists.map(String) 
      : String(seedArtists).split(',').map(s => s.trim()).filter(Boolean);
    
    const seedsArray: string[] = [];
    
    // Try to get one top track per artist (best-effort)
    for (const aid of artistIds.slice(0, 5)) {
      try {
        const top = await this.get(`/artists/${aid}/top-tracks`, { market: market || this.cfg.market });
        const first = Array.isArray(top.tracks) && top.tracks.length ? top.tracks[0] : null;
        if (first && first.id) seedsArray.push(first.id);
      } catch (e) { 
        /* ignore per-artist failures */ 
      }
    }
    
    return seedsArray;
  }

  private async fetchRecommendations(size: number, seedsArray: string[]): Promise<{ tracks: SpotifyTrack[]; seeds: any[]; raw: any }> {
    const params = new URLSearchParams();
    params.set('size', String(size));
    for (const s of seedsArray) params.append('seeds', s);

    const url = `${RECCO_BASE}/track/recommendation?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch (e) { bodyText = String(e); }
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

    // Map into SpotifyTrack-like objects using SpotifyMapper
    const mapped: SpotifyTrack[] = rawList.map((it: any) => {
      // Reshape into a Spotify-ish object so SpotifyMapper can process consistently
      const url = it.external_urls?.spotify || it.href || it.url;
      const id = this.extractSpotifyId(url);
      const obj = {
        id,
        name: it.name || it.title || it.trackTitle || '',
        external_urls: { spotify: url },
        duration_ms: it.duration_ms || it.duration || it.durationMs,
        explicit: !!it.explicit,
        track_number: it.track_number || it.trackNumber || 0,
        disc_number: it.disc_number || it.discNumber || 0,
        preview_url: it.preview_url || it.previewUrl,
        popularity: it.popularity ?? it.score,
        artists: (Array.isArray(it.artists) ? it.artists : (Array.isArray(it.artist) ? it.artist : [])).map((a: any) => ({
          id: this.extractSpotifyId(a.external_urls?.spotify || a.href || a.url),
          name: a.name || a.artistName || '',
          external_urls: { spotify: a.external_urls?.spotify || a.href || a.url }
        })),
        album: it.album || it.albumInfo || it.album_ref || undefined
      };
      return SpotifyMapper.mapTrack(obj);
    });

    // Best-effort: enrich mapped tracks by fetching Spotify track details for items
    // that lack album images. This helps provide cover art when ReccoBeats doesn't include it.
    try {
      const idsToFetch = mapped
        .filter(t => (!!t.id) && (!(t.album && Array.isArray(t.album.images) && t.album.images.length)))
        .map(t => t.id) as string[];
      const uniqueIds = Array.from(new Set(idsToFetch)).slice(0, SPOTIFY_CONSTANTS.LIMITS.MAX_ENRICHMENT_TRACKS);
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
    }

    return { tracks: mapped, seeds: seedsArray, raw: json };
  }
}

/** Set global locale for all SpotifyClient instances (format like en-US). */
export function setSpotifyLocale(locale: string) {
  if (typeof locale === 'string' && locale) {
    SharedState.locale = locale;
  }
}

function defaultLocale() {
  try {
    // @ts-ignore
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const l = (nav?.language || nav?.languages?.[0]) as string | undefined;
    if (l) return normalizeLocale(l);
  } catch { }
  return 'en-US';
}

function normalizeLocale(l: string) {
  if (!l) return 'en-US';
  // Ensure pattern xx-YY
  const parts = l.replace('_', '-').split('-');
  if (parts.length === 1) {
    const map: Record<string, string> = { en: 'US', es: 'ES' };
    const region = map[parts[0].toLowerCase()] || parts[0].toUpperCase();
    return parts[0].toLowerCase() + '-' + region;
  }
  return parts[0].toLowerCase() + '-' + parts[1].toUpperCase();
}

// Utility classes for optimization
class SpotifyMapper {
  static mapArtist(a: any): SpotifyArtist {
    return {
      id: a.id,
      name: a.name,
      url: a.external_urls?.spotify,
      genres: a.genres || [],
      images: a.images || [],
      followers: a.followers?.total,
      popularity: a.popularity
    };
  }

  static mapArtistRef(a: any): SpotifyArtistRef {
    return {
      id: a.id,
      name: a.name,
      url: a.external_urls?.spotify
    };
  }

  static mapAlbum(a: any): SpotifyAlbum {
    return {
      id: a.id,
      name: a.name,
      url: a.external_urls?.spotify,
      albumType: a.album_type,
      releaseDate: a.release_date,
      totalTracks: a.total_tracks,
      images: a.images || [],
      artists: (a.artists || []).map(SpotifyMapper.mapArtistRef),
      label: a.label,
      copyrights: (a.copyrights || []).map((c: any) => c.text).filter(Boolean)
    };
  }

  static mapTrack(t: any, fallbackAlbum?: SpotifyAlbum): SpotifyTrack {
    let album: SpotifyAlbum | undefined;
    if (t.album) {
      try {
        album = SpotifyMapper.mapAlbum(t.album);
      } catch { /* ignore malformed album */ }
    }
    
    if (!album) {
      // Create minimal album data from alternative fields or fallback
      const altId = t.album_id || t.albumId || fallbackAlbum?.id || (t.id ? 'album-' + t.id : 'album-unknown');
      const altName = t.album_name || t.albumName || fallbackAlbum?.name || '(Unknown Album)';
      const altImages = fallbackAlbum?.images || [];
      album = { id: String(altId), name: String(altName), images: altImages } as SpotifyAlbum;
    }
    
    return {
      id: t.id,
      name: t.name,
      url: t.external_urls?.spotify,
      durationMs: t.duration_ms,
      explicit: !!t.explicit,
      trackNumber: t.track_number,
      discNumber: t.disc_number,
      previewUrl: t.preview_url || undefined,
      popularity: t.popularity,
      artists: (t.artists || []).map(SpotifyMapper.mapArtistRef),
      album,
      linked_from: t.linked_from || undefined
    };
  }

  static mapPlaylist(p: any): SpotifyPlaylist {
    return {
      id: p.id,
      name: p.name,
      url: p.external_urls?.spotify,
      images: p.images || [],
      description: p.description,
      ownerName: p.owner?.display_name || p.owner?.id,
      totalTracks: p.tracks?.total
    };
  }
}

class CacheHelper {
  static createCacheKey(method: string, path: string, params?: Record<string, any>): string {
    const search = params ? '?' + new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined) as any
    ) : '';
    return `${method}:${API_BASE}${path}${search}`;
  }

  static async checkDatabaseCache(db: any, key: string, path: string): Promise<any | null> {
    if (!db) return null;
    
    try {
      const cachedData = await db.getApiCache(key);
      if (cachedData) {
        return cachedData;
      }
    } catch (e) {
      // ignore cache errors
    }
    
    return null;
  }

  static checkMemoryCache(cache: Map<string, any>, key: string, path: string, ttl = SPOTIFY_CONSTANTS.TIMING.MEMORY_CACHE_TTL_MS): any | null {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.t < ttl) {
      return cached.v;
    }
    return null;
  }

  static async storeInCaches(cache: Map<string, any>, db: any, key: string, data: any, path: string): Promise<void> {
    // Store in memory cache
    cache.set(key, { v: data, t: Date.now() });
    
    // Store in database cache (non-blocking)
    if (db) {
      db.setApiCache(key, data).then(() => {
      }).catch((e: any) => {
      });
    }
  }
}

async function safeReadText(res: Response) { try { return await res.text(); } catch { return ''; } }

// ============================================================================
// Helper Functions for Simplified Track Fetching
// ============================================================================

/**
 * Simplified track interface for UI components
 */
export interface SimpleTrack {
  id: string;
  name: string;
  artists?: { name: string }[];
  album?: {
    name?: string;
    images?: { url: string }[];
  };
}

/**
 * Options for track fetching operations
 */
export interface FetchTrackOptions {
  limit?: number;
}

/**
 * Fetch album tracks with simplified interface
 */
export async function fetchAlbumTracks(albumId: string | number, options: FetchTrackOptions = {}): Promise<SimpleTrack[] | undefined> {
  try {
    const client = SpotifyClientCache.getClient() || new SpotifyClient();
    const limit = Math.min(SPOTIFY_CONSTANTS.LIMITS.MAX_TRACK_LIMIT, Math.max(1, options.limit || SPOTIFY_CONSTANTS.LIMITS.DEFAULT_TRACK_LIMIT));

    const response = await client.getAlbumTracks(String(albumId), { fetchAll: false, limit });
    return mapTracksToSimple(response.items);
  } catch (error) {
    console.warn('fetchAlbumTracks error:', error);
    return undefined;
  }
}

/**
 * Fetch playlist tracks with simplified interface
 */
export async function fetchPlaylistTracks(playlistId: string | number, options: FetchTrackOptions = {}): Promise<SimpleTrack[] | undefined> {
  try {
    const client = SpotifyClientCache.getClient() || new SpotifyClient();
    const limit = Math.min(SPOTIFY_CONSTANTS.LIMITS.MAX_TRACK_LIMIT, Math.max(1, options.limit || SPOTIFY_CONSTANTS.LIMITS.DEFAULT_TRACK_LIMIT));

    const response = await client.getPlaylist(String(playlistId));
    const tracks = response.tracks.slice(0, limit);
    return mapTracksToSimple(tracks);
  } catch (error) {
    console.warn('fetchPlaylistTracks error:', error);
    return undefined;
  }
}

/**
 * Fetch artist top tracks with simplified interface
 */
export async function fetchArtistTracks(artistId: string | number, options: FetchTrackOptions = {}): Promise<SimpleTrack[] | undefined> {
  try {
    const client = SpotifyClientCache.getClient() || new SpotifyClient();
    const limit = Math.min(SPOTIFY_CONSTANTS.LIMITS.MAX_TRACK_LIMIT, Math.max(1, options.limit || SPOTIFY_CONSTANTS.LIMITS.DEFAULT_TRACK_LIMIT));

    const tracks = await client.getArtistTopTracks(String(artistId));
    return mapTracksToSimple(tracks.slice(0, limit));
  } catch (error) {
    console.warn('fetchArtistTracks error:', error);
    return undefined;
  }
}

/**
 * Map SpotifyTrack array to SimpleTrack array
 */
function mapTracksToSimple(tracks: SpotifyTrack[]): SimpleTrack[] {
  return tracks
    .filter(track => track && track.id)
    .map(track => ({
      id: track.id,
      name: track.name,
      artists: track.artists?.map(artist => ({ name: artist.name })),
      album: track.album ? {
        name: track.album.name,
        images: track.album.images
      } : undefined
    }));
}