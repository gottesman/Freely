import { useMemo, useCallback } from 'react';
import SpotifyClient from './spotify'
import { useDB } from './dbIndexed'

// Performance constants for Spotify client operations
const SPOTIFY_CLIENT_CONSTANTS = {
  LIMITS: {
    DEFAULT_SEARCH_LIMIT: 20,
    MAX_SEARCH_LIMIT: 50,
    MIN_SEARCH_LIMIT: 1
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

type SearchType = typeof SPOTIFY_CLIENT_CONSTANTS.SEARCH_TYPES[keyof typeof SPOTIFY_CLIENT_CONSTANTS.SEARCH_TYPES];
type SearchTypes = SearchType | SearchType[];

// Utility class for client caching management
class SpotifyClientCache {
  private static cachedClient: SpotifyClient | null = null;

  /**
   * Get the cached client instance, checking for pre-warmed client first
   */
  static getClient(): SpotifyClient | null {
    // Check for pre-warmed client from startup process
    if (!this.cachedClient && (window as any)[SPOTIFY_CLIENT_CONSTANTS.GLOBAL_KEYS.WARMED_CLIENT]) {
      this.cachedClient = (window as any)[SPOTIFY_CLIENT_CONSTANTS.GLOBAL_KEYS.WARMED_CLIENT];
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
    const { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, MIN_SEARCH_LIMIT } = SPOTIFY_CLIENT_CONSTANTS.LIMITS;
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
export async function search(query: string, typeOrTypes: SearchTypes = SPOTIFY_CLIENT_CONSTANTS.SEARCH_TYPES.TRACK, options?: SearchOptions): Promise<SearchResult> {
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
  const { SEARCH_TYPES } = SPOTIFY_CLIENT_CONSTANTS;

  // Create search promises for requested types only
  const searchPromises: Promise<void>[] = [];

  if (types.includes(SEARCH_TYPES.TRACK)) {
    searchPromises.push(
      handleSearchCall(
        () => client.searchTracks(query, limit),
        SEARCH_TYPES.TRACK,
        results
      )
    );
  }

  if (types.includes(SEARCH_TYPES.ALBUM)) {
    searchPromises.push(
      handleSearchCall(
        () => client.searchAlbums(query, limit),
        SEARCH_TYPES.ALBUM,
        results
      )
    );
  }

  if (types.includes(SEARCH_TYPES.ARTIST)) {
    searchPromises.push(
      handleSearchCall(
        () => client.searchArtists(query, limit),
        SEARCH_TYPES.ARTIST,
        results
      )
    );
  }

  if (types.includes(SEARCH_TYPES.PLAYLIST)) {
    searchPromises.push(
      handleSearchCall(
        () => client.searchPlaylists(query, limit),
        SEARCH_TYPES.PLAYLIST,
        results
      )
    );
  }

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
