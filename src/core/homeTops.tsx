import { env } from './accessEnv';

// Performance constants
const CHARTS_ENV_KEY = 'CHARTS_SPOTIFY_ENDPOINT';
const WARNING_MESSAGE = '⚠️ CHARTS_SPOTIFY_ENDPOINT not set - weekly charts will be unavailable';

// Spotify URI patterns
const SPOTIFY_URI_PATTERNS = {
  PREFIX: 'spotify',
  MIN_PARTS: 3,
  SEPARATOR: ':'
} as const;

// Metadata field mappings for normalization
const METADATA_FIELDS = {
  TRACK: {
    primary: ['trackMetadata', 'track_metadata'],
    name: ['trackName', 'name'],
    image: ['displayImageUri', 'imageUri'],
    uri: ['trackUri', 'track_uri']
  },
  ALBUM: {
    primary: ['albumMetadata', 'album_metadata'],
    name: ['albumName', 'name'],
    image: ['displayImageUri', 'imageUri'],
    uri: ['albumUri', 'album_uri']
  },
  ARTIST: {
    primary: ['artistMetadata', 'artist_metadata'],
    name: ['artistName', 'name'],
    image: ['displayImageUri', 'imageUri'],
    uri: ['artistUri', 'artist_uri']
  }
} as const;

// Artist field variations for normalization
const ARTIST_URI_FIELDS = [
  'spotifyUri', 'spotify_uri', 'uri', 'spotifyUriString', 
  'spotify_uri_string'
] as const;

const ARTIST_NAME_FIELDS = ['name', 'artistName'] as const;

// Cached charts URL with memoization
let _chartsUrlCached: string | null = null;

const chartsUrl = async (): Promise<string> => {
  if (_chartsUrlCached !== null) return _chartsUrlCached;
  
  const remote = await env(CHARTS_ENV_KEY) || '';
  _chartsUrlCached = remote || '';
  
  if (_chartsUrlCached === '') {
    console.warn(WARNING_MESSAGE);
  }
  
  return _chartsUrlCached;
};

// Utility classes for better organization
class SpotifyUriParser {
  static parse(uri: string | null | undefined): { type: string; id: string } | null {
    if (!uri || typeof uri !== 'string') return null;
    
    const parts = uri.split(SPOTIFY_URI_PATTERNS.SEPARATOR);
    if (parts.length < SPOTIFY_URI_PATTERNS.MIN_PARTS || parts[0] !== SPOTIFY_URI_PATTERNS.PREFIX) {
      return null;
    }
    
    return { 
      type: parts[1], 
      id: parts.slice(2).join(SPOTIFY_URI_PATTERNS.SEPARATOR) 
    };
  }
}

class ArtistNormalizer {
  static getFieldValue(obj: any, fields: readonly string[]): string {
    for (const field of fields) {
      const value = obj[field];
      if (value) return value;
    }
    return '';
  }

  static normalizeArray(arr: any[]): Array<{ name: string; id: string | null; uri: string | null }> {
    if (!Array.isArray(arr)) return [];
    
    return arr.map(artist => {
      const spotifyUri = this.getFieldValue(artist, ARTIST_URI_FIELDS);
      const parsed = SpotifyUriParser.parse(spotifyUri);
      
      return {
        name: this.getFieldValue(artist, ARTIST_NAME_FIELDS),
        uri: spotifyUri || null,
        id: parsed ? parsed.id : null,
      };
    });
  }
}

class MetadataExtractor {
  static getMetadataValue(metadata: any, fields: readonly string[]): string {
    for (const field of fields) {
      const value = metadata[field];
      if (value) return value;
    }
    return '';
  }

  static extractFromEntry(entry: any) {
    const rank = entry?.chartEntryData?.currentRank ?? null;
    
    // Check each metadata type in order of preference
    for (const [type, config] of Object.entries(METADATA_FIELDS)) {
      for (const primaryField of config.primary) {
        const metadata = entry[primaryField];
        if (metadata) {
          return MetadataExtractor.processMetadata(metadata, config, entry, rank, type.toLowerCase());
        }
      }
    }
    
    // Fallback processing for unknown shapes
    return MetadataExtractor.processFallbackMetadata(entry, rank);
  }

  static processMetadata(metadata: any, config: any, entry: any, rank: number | null, type: string) {
    const name = MetadataExtractor.getMetadataValue(metadata, config.name);
    const image = MetadataExtractor.getMetadataValue(metadata, config.image);
    const uri = MetadataExtractor.getMetadataValue(metadata, config.uri);
    const artists = type === 'artist' ? [] : ArtistNormalizer.normalizeArray(metadata.artists || entry.artists || []);
    
    const parsed = SpotifyUriParser.parse(uri);
    
    return {
      rank,
      type: parsed ? parsed.type : null,
      id: parsed ? parsed.id : null,
      name,
      image,
      uri,
      artists,
      raw: entry
    };
  }

  static processFallbackMetadata(entry: any, rank: number | null) {
    const metaKeys = ['trackMetadata', 'albumMetadata', 'artistMetadata', 'track_metadata', 'album_metadata', 'artist_metadata'];
    const meta = metaKeys.reduce((acc, key) => acc || entry[key], null) || {};
    
    const nameFields = ['trackName', 'albumName', 'artistName', 'name'];
    const imageFields = ['displayImageUri', 'imageUri', 'display_image_uri'];
    const uriFields = ['trackUri', 'albumUri', 'artistUri', 'track_uri', 'album_uri', 'artist_uri'];
    
    const name = MetadataExtractor.getMetadataValue(meta, nameFields);
    const image = MetadataExtractor.getMetadataValue(meta, imageFields);
    const uri = MetadataExtractor.getMetadataValue(meta, uriFields);
    const artists = ArtistNormalizer.normalizeArray(meta.artists || entry.artists || []);
    
    const parsed = SpotifyUriParser.parse(uri);
    
    return {
      rank,
      type: parsed ? parsed.type : null,
      id: parsed ? parsed.id : null,
      name,
      image,
      uri,
      artists,
      raw: entry
    };
  }
}

// Chart processing utilities
class ChartProcessor {
  static parseGroup(chartGroup: any, limit?: number): any[] {
    if (!chartGroup || !Array.isArray(chartGroup.entries)) return [];
    
    const list = chartGroup.entries.map(MetadataExtractor.extractFromEntry);
    
    return typeof limit === 'number' ? list.slice(0, limit) : list;
  }

  static async fetchChartsData(url: string): Promise<any> {
    // Prefer IPC if available (Electron environment)
    if (typeof (window as any).charts === 'object' && 
        typeof (window as any).charts.getWeeklyTops === 'function') {
      return await (window as any).charts.getWeeklyTops({ url });
    }
    
    // Fallback to direct fetch
    const res = await fetch(url);
    if (!res.ok) throw new Error(`charts fetch failed: ${res.status}`);
    return await res.json();
  }

  static processApiResponse(json: any, limit?: number) {
    // Support both naming conventions
    const groups = json?.chartEntryViewResponses || json?.chart_entry_view_responses || [];
    
    // Expected order: [songs, albums, artists]
    const [songsGroup = {}, albumsGroup = {}, artistsGroup = {}] = groups;
    
    return {
      songs: this.parseGroup(songsGroup, limit),
      albums: this.parseGroup(albumsGroup, limit),
      artists: this.parseGroup(artistsGroup, limit),
      raw: json,
    };
  }
}

/**
 * Fetch weekly charts and return normalized lists for songs, albums and artists.
 * Returns { songs: [], albums: [], artists: [] }
 * limit - optional number to limit each list
 */
export const getWeeklyTops = async ({ limit }: { limit?: number } = {}): Promise<{
  songs: any[];
  albums: any[];
  artists: any[];
  raw: any;
}> => {
  try {
    const url = await chartsUrl();
    if (url === '') {
      throw new Error('CHARTS_SPOTIFY_ENDPOINT not set');
    }

    const json = await ChartProcessor.fetchChartsData(url);
    return ChartProcessor.processApiResponse(json, limit);
    
  } catch (e) {
    console.warn('getWeeklyTops error', e);
    return { 
      songs: [], 
      albums: [], 
      artists: [], 
      raw: null 
    };
  }
};

// Optimized export - clean interface
export default {
  chartsUrl,
  getWeeklyTops
};