import SpotifyClient, { SpotifyTrack } from './spotify';

// Performance constants for Spotify helpers
const SPOTIFY_HELPERS_CONSTANTS = {
  LIMITS: {
    DEFAULT_TRACK_LIMIT: 10,
    MAX_TRACK_LIMIT: 50
  },
  GLOBAL_KEYS: {
    WARMED_CLIENT: '__freelySpotifyClient'
  },
  ELECTRON_APIS: {
    GET_ALBUM_TRACKS: 'getAlbumTracks',
    GET_PLAYLIST_TRACKS: 'getPlaylistTracks', 
    GET_ARTIST_TOP_TRACKS: 'getArtistTopTracks'
  }
} as const;

// Log prefixes for consistent debugging output
const LOG_PREFIXES = {
  CLIENT: '🔧',
  FETCH: '📥',
  ERROR: '❌',
  PRELOAD: '⚡'
} as const;

// Enhanced TypeScript interfaces
interface SimpleTrack {
  id: string;
  name: string;
  artists?: { name: string }[];
  album?: { 
    name?: string; 
    images?: { url: string }[] 
  };
}

interface FetchOptions {
  limit?: number;
}

interface ElectronSpotifyAPI {
  getAlbumTracks?: (albumId: string, options: any) => Promise<any>;
  getPlaylistTracks?: (playlistId: string) => Promise<any>;
  getArtistTopTracks?: (artistId: string) => Promise<any>;
}

interface WindowWithElectron extends Window {
  electron?: {
    spotify?: ElectronSpotifyAPI;
  };
  __freelySpotifyClient?: SpotifyClient;
}

// Type-safe window casting
const getWindow = (): WindowWithElectron => window as WindowWithElectron;

// Utility class for client management
class SpotifyClientManager {
  /**
   * Get a Spotify client instance, preferring pre-warmed client
   */
  static async getClient(): Promise<SpotifyClient> {
    const w = getWindow();
    
    // Prefer pre-warmed client if available
    if (w[SPOTIFY_HELPERS_CONSTANTS.GLOBAL_KEYS.WARMED_CLIENT]) {
      console.log(`${LOG_PREFIXES.CLIENT} Using pre-warmed SpotifyClient`);
      return w[SPOTIFY_HELPERS_CONSTANTS.GLOBAL_KEYS.WARMED_CLIENT];
    }
    
    // Create short-lived client as fallback
    try {
      console.log(`${LOG_PREFIXES.CLIENT} Creating fallback SpotifyClient`);
      return new SpotifyClient();
    } catch (error) {
      console.warn(`${LOG_PREFIXES.ERROR} Failed to create SpotifyClient, retrying:`, error);
      return new SpotifyClient();
    }
  }
}

// Utility class for data transformation
class TrackMapper {
  /**
   * Map Spotify track data to simplified format
   */
  static mapToSimple(track: any): SimpleTrack | null {
    if (!track) return null;
    
    return {
      id: String(track.id),
      name: track.name,
      artists: (track.artists || []).map((artist: any) => ({ name: artist.name })),
      album: track.album ? { 
        name: track.album.name, 
        images: track.album.images || [] 
      } : undefined
    };
  }

  /**
   * Filter and limit track results with array validation
   */
  static processTrackResults(tracks: any, limit: number): SimpleTrack[] {
    // Ensure tracks is an array
    const trackArray = Array.isArray(tracks) ? tracks : [];
    
    return trackArray
      .slice(0, limit)
      .map(TrackMapper.mapToSimple)
      .filter((track): track is SimpleTrack => track !== null);
  }
}

// Utility class for electron preload detection
class ElectronAPIManager {
  /**
   * Check if electron preload API is available
   */
  static isAvailable(): boolean {
    const w = getWindow();
    return Boolean(w.electron?.spotify);
  }

  /**
   * Get electron spotify API if available
   */
  static getAPI(): ElectronSpotifyAPI | null {
    const w = getWindow();
    return w.electron?.spotify || null;
  }
}

// Utility class for fetch operations
class SpotifyFetcher {
  /**
   * Normalize and validate fetch options
   */
  static normalizeOptions(options: FetchOptions = {}): { limit: number } {
    const limit = Math.min(
      SPOTIFY_HELPERS_CONSTANTS.LIMITS.MAX_TRACK_LIMIT,
      Math.max(1, options.limit || SPOTIFY_HELPERS_CONSTANTS.LIMITS.DEFAULT_TRACK_LIMIT)
    );
    return { limit };
  }

  /**
   * Generic fetch pattern for Spotify data
   */
  static async fetchWithFallback<T>(
    resourceId: string,
    electronAPIMethod: keyof ElectronSpotifyAPI,
    clientMethod: (client: SpotifyClient, id: string, options: any) => Promise<any>,
    dataExtractor: (response: any) => any[],
    options: FetchOptions = {},
    resourceType: string = 'resource'
  ): Promise<SimpleTrack[] | undefined> {
    const { limit } = this.normalizeOptions(options);
    const stringId = String(resourceId);

    try {
      // Try electron preload first
      const electronAPI = ElectronAPIManager.getAPI();
      if (electronAPI && electronAPI[electronAPIMethod]) {
        console.log(`${LOG_PREFIXES.PRELOAD} Fetching ${resourceType} via electron preload`);
        const response = await (electronAPI[electronAPIMethod] as any)(stringId, { fetchAll: false, limit });
        const tracks = dataExtractor(response);
        return TrackMapper.processTrackResults(tracks, limit);
      }

      // Fallback to direct client
      console.log(`${LOG_PREFIXES.FETCH} Fetching ${resourceType} via SpotifyClient`);
      const client = await SpotifyClientManager.getClient();
      const response = await clientMethod(client, stringId, { fetchAll: false, limit });
      const tracks = dataExtractor(response);
      return TrackMapper.processTrackResults(tracks, limit);

    } catch (error) {
      console.warn(`${LOG_PREFIXES.ERROR} fetch${resourceType} error:`, error);
      return undefined;
    }
  }
}

/**
 * Fetch album tracks with optimized fallback pattern
 */
export async function fetchAlbumTracks(albumId: string | number, options: FetchOptions = {}): Promise<SimpleTrack[] | undefined> {
  return SpotifyFetcher.fetchWithFallback(
    String(albumId),
    SPOTIFY_HELPERS_CONSTANTS.ELECTRON_APIS.GET_ALBUM_TRACKS,
    async (client, id, opts) => client.getAlbumTracks(id, opts),
    (response) => {
      // Handle different response formats
      if (Array.isArray(response)) {
        return response;
      }
      if (response && Array.isArray(response.items)) {
        return response.items;
      }
      // Fallback to empty array
      return [];
    },
    options,
    'album tracks'
  );
}

/**
 * Fetch playlist tracks with optimized fallback pattern
 */
export async function fetchPlaylistTracks(playlistId: string | number, options: FetchOptions = {}): Promise<SimpleTrack[] | undefined> {
  return SpotifyFetcher.fetchWithFallback(
    String(playlistId),
    SPOTIFY_HELPERS_CONSTANTS.ELECTRON_APIS.GET_PLAYLIST_TRACKS,
    async (client, id, opts) => {
      const response = await client.getPlaylist(id);
      return { items: response.tracks || [] };
    },
    (response) => {
      // Handle both electron preload format and direct client format
      if (Array.isArray(response)) {
        return response;
      }
      if (response && Array.isArray(response.items)) {
        const items = response.items;
        return items.map((item: any) => item.track || item);
      }
      if (response && Array.isArray(response.tracks)) {
        return response.tracks;
      }
      // Fallback to empty array
      return [];
    },
    options,
    'playlist tracks'
  );
}

/**
 * Fetch artist top tracks with optimized fallback pattern
 */
export async function fetchArtistTracks(artistId: string | number, options: FetchOptions = {}): Promise<SimpleTrack[] | undefined> {
  return SpotifyFetcher.fetchWithFallback(
    String(artistId),
    SPOTIFY_HELPERS_CONSTANTS.ELECTRON_APIS.GET_ARTIST_TOP_TRACKS,
    async (client, id, opts) => {
      const response = await client.getArtistTopTracks(id);
      return { items: response || [] };
    },
    (response) => {
      // Handle different response formats
      if (Array.isArray(response)) {
        return response;
      }
      if (response && Array.isArray(response.items)) {
        return response.items;
      }
      if (response && Array.isArray(response.tracks)) {
        return response.tracks;
      }
      // Fallback to empty array
      return [];
    },
    options,
    'artist tracks'
  );
}

// Export default object with all helper functions
export default { 
  fetchAlbumTracks, 
  fetchPlaylistTracks, 
  fetchArtistTracks 
};
