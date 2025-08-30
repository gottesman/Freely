import SpotifyClient from './spotify'
import { useDB } from './dbIndexed'

// Global cached client instance - now initialized during warmup
let cachedClient: SpotifyClient | null = null

/**
 * Hook to get a SpotifyClient instance with database caching enabled.
 * Now uses the pre-warmed client from the app startup process.
 */
export function useSpotifyClient(): SpotifyClient {
  const { getApiCache, setApiCache, ready } = useDB()
  
  // Check if we have a pre-warmed client from the startup process
  if (!cachedClient && (window as any).__freelySpotifyClient) {
    cachedClient = (window as any).__freelySpotifyClient;
    console.log('🔧 Using pre-warmed SpotifyClient instance');
  }
  
  // Fallback: create new client if warmup didn't happen (shouldn't occur in normal flow)
  if (!cachedClient) {
    cachedClient = new SpotifyClient()
    console.log('� Created fallback SpotifyClient instance');
    
    // Inject database cache if DB is ready
    if (ready) {
      cachedClient.setDatabaseCache({ getApiCache, setApiCache })
      console.log('💾 Injected database cache into fallback SpotifyClient')
    }
  }
  
  if (!ready) {
    console.log('⏳ Database not ready yet for SpotifyClient')
  }
  
  return cachedClient
}

/**
 * Create a SpotifyClient instance with database caching.
 * Use this in components that can't use hooks.
 */
export function createCachedSpotifyClient(dbCache?: { getApiCache: (key: string) => Promise<any | null>; setApiCache: (key: string, data: any) => Promise<void> }): SpotifyClient {
  const client = new SpotifyClient()
  if (dbCache) {
    client.setDatabaseCache(dbCache)
  }
  return client
}

/**
 * Cross-environment search helper.
 * - In Electron renderer with preload: forwards to `window.electron.spotify.search`.
 * - Otherwise uses the pre-warmed `SpotifyClient` instance or creates a short-lived client.
 * Returns { query, types, results } to match IPC response shape.
 */
export async function search(query: string, typeOrTypes: string | string[] = 'track', options?: { limit?: number }){
  if (!query || !String(query).trim()) return { query, types: [], results: {} };
  const w: any = window as any;

  // If electron preload provides a direct search, use it (keeps auth server-side)
  try {
    if (w.electron?.spotify?.search) {
      // Pass through options where supported by preload
      return await w.electron.spotify.search(query, typeOrTypes, options);
    }
  } catch (e) {
    console.warn('spotify-client: preload search failed, falling back to direct client', e);
  }

  // Normalize types
  const types = Array.isArray(typeOrTypes) ? typeOrTypes : String(typeOrTypes).split(',').map(s=>s.trim()).filter(Boolean);
  const client: SpotifyClient = cachedClient || new SpotifyClient();

  const results: Record<string, any> = {};
  // If the client implements searchMulti, use a single /search call with comma-separated types.
  try {
    if (typeof (client as any).searchMulti === 'function') {
      const lim = options?.limit ?? 20;
      const multi = await (client as any).searchMulti(query, types, Math.min(50, Math.max(1, lim)));
      // multi.results already contains mapped items per key
      return { query, types, results: multi.results };
    }
  } catch (e) {
    console.warn('spotify-client: searchMulti failed, falling back to per-type calls', e);
  }

  // Fallback: Only call the types requested to save API calls (older client)
  const promises: Promise<void>[] = [];
  const lim = Math.min(50, Math.max(1, options?.limit ?? 20));
  if (types.includes('track')) promises.push((async ()=> { try { const r = await client.searchTracks(query, lim); results.track = r.items; } catch(e){ results.track = []; } })());
  if (types.includes('album')) promises.push((async ()=> { try { const r = await client.searchAlbums(query, lim); results.album = r.items; } catch(e){ results.album = []; } })());
  if (types.includes('artist')) promises.push((async ()=> { try { const r = await client.searchArtists(query, lim); results.artist = r.items; } catch(e){ results.artist = []; } })());
  if (types.includes('playlist')) promises.push((async ()=> { try { const r = await client.searchPlaylists(query, lim); results.playlist = r.items; } catch(e){ results.playlist = []; } })());

  await Promise.all(promises);
  return { query, types, results };
}
