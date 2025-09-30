import { useCallback, useMemo } from 'react';
import { SpotifyAlbum, SpotifyArtist, SpotifyTrack, useSpotifyClient } from '../../core/SpotifyClient';
import { useDB } from '../../core/Database';
import GeniusClient from '../../core/Genius';

// Shared helpers for tabs/components (time formatting, etc.)
export function fmtMs(ms?: number){
  if (ms === undefined || ms === null) return '--:--';
  const total = Math.floor(ms/1000);
  const m = Math.floor(total/60);
  const s = total%60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

export function fmtTotalMs(ms?: number){
  if (ms === undefined || ms === null) return '--';
  const totalSec = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

// Parse human-readable sizes like "3.4 MB" into bytes
export function parseByteSizeString(size?: string): number | undefined {
  if (!size) return undefined;
  const m = String(size).match(/([0-9.]+)\s*(kb|mb|gb|tb|b)/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return undefined;
  switch (m[2].toLowerCase()) {
    case 'b': return Math.round(n);
    case 'kb': return Math.round(n * 1024);
    case 'mb': return Math.round(n * 1024 * 1024);
    case 'gb': return Math.round(n * 1024 * 1024 * 1024);
    case 'tb': return Math.round(n * 1024 * 1024 * 1024 * 1024);
    default: return undefined;
  }
}

// Format bytes into human-friendly string
export function formatBytes(bytes?: number, decimals = 1): string {
  if (bytes === undefined || bytes === null || isNaN(bytes as any)) return '0 B';
  const b = Math.max(0, Number(bytes));
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = b / 1024;
  let unit = 0;
  while (val >= 1024 && unit < units.length - 1) {
    val /= 1024;
    unit++;
  }
  const fixed = val.toFixed(decimals);
  return `${Number(fixed)} ${units[unit]}`;
}

// Helper to safely resolve a hero image URL from spotify-style images array
export function useHeroImage(images?: Array<{url?: string}>, idx = 0){
  // Consumers should call this inside useMemo to keep hook-free
  try { return (window as any).imageRes?.(images, idx) ?? '' } catch { return '' }
}

// Extract release year from date string (YYYY-MM-DD -> YYYY)
export function extractReleaseYear(releaseDate?: string): string | undefined {
  return releaseDate ? releaseDate.split('-')[0] : undefined;
}

// Calculate optimal column width for artist names in track lists
export function calculateArtistColWidth(tracks?: SpotifyTrack[]): number | undefined {
  if (!tracks?.length) return undefined;
  const names = tracks.map((t) => t.artists?.[0]?.name ?? '');
  const longest = names.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (!longest) return undefined;
  const avgCharPx = 7.2;
  const padding = 28;
  return Math.min(240, Math.max(80, Math.round(longest.length * avgCharPx + padding)));
}

// Format follower count for display
export function formatFollowerCount(followers?: number): string {
  if (!followers) return '0';
  if (followers >= 1000000) {
    const mil = (followers / 1000000).toFixed(1);
    return `${mil}M`;
  }
  if (followers >= 1000) {
    const k = (followers / 1000).toFixed(1);
    return `${k}K`;
  }
  return followers.toString();
}

// Common event dispatcher helper
export const dispatchFreelyEvent = (eventType: string, detail?: any) => {
  window.dispatchEvent(new CustomEvent(eventType, { detail }));
};

// Navigation event helpers
export const navigationEvents = {
  selectArtist: (artistId: string, source = 'tab') =>
    dispatchFreelyEvent('freely:selectArtist', { artistId, source }),
  
  selectAlbum: (albumId: string, source = 'tab') =>
    dispatchFreelyEvent('freely:selectAlbum', { albumId, source }),
  
  selectPlaylist: (playlistId: string, source = 'tab') =>
    dispatchFreelyEvent('freely:selectPlaylist', { playlistId, source }),
  
  selectTrack: (trackId: string, source = 'tab') =>
    dispatchFreelyEvent('freely:selectTrack', { trackId, source }),
};

// Playback event helpers
export const playbackEvents = {
  setQueue: (queueIds: string[], startIndex = 0, shouldPlay = false) =>
    dispatchFreelyEvent('freely:playback:setQueue', { queueIds, startIndex, shouldPlay }),
  
  enqueue: (ids: string[]) =>
    dispatchFreelyEvent('freely:playback:enqueue', { ids }),
  
  reorderQueue: (queueIds: string[]) =>
    dispatchFreelyEvent('freely:playback:reorderQueue', { queueIds }),
  
  removeTrack: (id: string) =>
    dispatchFreelyEvent('freely:playback:removeTrack', { id }),
  
  // Optimized event for immediate playback
  playNow: (ids: string | string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    dispatchFreelyEvent('freely:playback:playNow', { ids: arr });
  },
  
  openAddToPlaylistModal: (track: SpotifyTrack) =>
    dispatchFreelyEvent('freely:openAddToPlaylistModal', { track }),
};

// Queue deduplication helper
export function deduplicateQueue(newTrackIds: string[], existingQueue: string[] = [], currentIndex = 0): string[] {
  const currentSegment = existingQueue.slice(currentIndex);
  const dedupSet = new Set(newTrackIds);
  const filteredCurrent = currentSegment.filter((id: string) => !dedupSet.has(id));
  return [...newTrackIds, ...filteredCurrent];
}

// Filter tracks for queueing (remove already existing)
export function filterNewTracks(trackIds: string[], existingQueue: string[] = []): string[] {
  const existing = new Set(existingQueue);
  return trackIds.filter((id: string) => !existing.has(id));
}

// Custom hook for creating stable API reference with both Spotify and Genius clients
export function useStableTabAPI() {
  const spotifyClient = useSpotifyClient();
  const { getTrack } = useDB();
  
  return useMemo(() => {
  const geniusClient = new GeniusClient();
  const w = window as any;
    
    return {
  // Explicitly no electron in this app variant
  hasElectron: false,
      
      // Image resolution helper for legacy compatibility
      imageRes: (images?: Array<{url?: string}>, idx = 1) => {
        if (typeof w.imageRes === 'function') return w.imageRes(images, idx);
        if (!images || !images.length) return null;
        return images[Math.min(idx, images.length - 1)]?.url || images[0]?.url || null;
      },
      
      // Spotify API methods (no electron fallback)
      getTrack: async (id: string): Promise<SpotifyTrack | undefined> => {
        try {
          // Prefer DB single source for UI; DB.getTrack will self-populate via Spotify when missing
          const rec = await getTrack(id);
          if (rec?.spotify) return rec.spotify as unknown as SpotifyTrack;
          // Final fallback to direct call
          return await spotifyClient.getTrack(id);
        } catch (error) {
          console.warn('Failed to fetch track:', error);
          return undefined;
        }
      },
      
      getTracks: async (ids: string[]): Promise<SpotifyTrack[]> => {
        try {
          return await spotifyClient.getTracks(ids);
        } catch (error) {
          console.warn('Failed to fetch tracks:', error);
          return [];
        }
      },
      
      getPlaylist: async (id: string): Promise<any> => {
        try {
          return await spotifyClient.getPlaylist(id);
        } catch (error) {
          console.warn('Failed to fetch playlist:', error);
          return undefined;
        }
      },
      
      getAlbum: async (id: string): Promise<SpotifyAlbum | undefined> => {
        try {
          return await spotifyClient.getAlbum(id);
        } catch (error) {
          console.warn('Failed to fetch album:', error);
          return undefined;
        }
      },
      
      getArtist: async (id: string): Promise<SpotifyArtist | undefined> => {
        try {
          return await spotifyClient.getArtist(id);
        } catch (error) {
          console.warn('Failed to fetch artist:', error);
          return undefined;
        }
      },
      
      getAlbumTracks: async (id: string, options?: { fetchAll?: boolean; limit?: number }): Promise<SpotifyTrack[]> => {
        try {
          const res = await spotifyClient.getAlbumTracks(id, { 
            fetchAll: false, 
            limit: 50, 
            ...options 
          });
          return res?.items || [];
        } catch (error) {
          console.warn('Failed to fetch album tracks:', error);
          return [];
        }
      },
      
      getArtistTopTracks: async (id: string, options?: any): Promise<SpotifyTrack[]> => {
        try {
          return await spotifyClient.getArtistTopTracks(id, options);
        } catch (error) {
          console.warn('Failed to fetch artist top tracks:', error);
          return [];
        }
      },
      
      getArtistAlbums: async (id: string, options?: any): Promise<SpotifyAlbum[]> => {
        try {
          const res = await spotifyClient.getArtistAlbums(id, options);
          return res?.items || [];
        } catch (error) {
          console.warn('Failed to fetch artist albums:', error);
          return [];
        }
      },
      
      getRecommendations: async (options: any): Promise<any> => {
        try {
          return await spotifyClient.getRecommendations(options);
        } catch (error) {
          console.warn('Failed to get recommendations:', error);
          return null;
        }
      },
      
      searchPlaylists: async (query: string): Promise<any[]> => {
        try {
          const res = await spotifyClient.searchPlaylists(query);
          return res?.items || [];
        } catch (error) {
          console.warn('Failed to search playlists:', error);
          return [];
        }
      },
      
      // Genius API methods (no electron fallback)
      geniusSearch: async (query: string): Promise<any> => {
        try {
          return await geniusClient.search(query);
        } catch (error) {
          console.warn('Failed to search Genius:', error);
          return null;
        }
      },
      
      geniusGetSong: async (id: number): Promise<any> => {
        try {
          return await geniusClient.getSong(id);
        } catch (error) {
          console.warn('Failed to get Genius song:', error);
          return null;
        }
      },
      
      geniusGetArtist: async (id: number): Promise<any> => {
        try {
          return await geniusClient.getArtist(id);
        } catch (error) {
          console.warn('Failed to get Genius artist:', error);
          return null;
        }
      },
    };
  }, [spotifyClient]);
}

// Common playback action handlers
export function usePlaybackActions() {
  return useMemo(() => ({
    playTrack: (trackId: string, queueIds: string[] = [], currentIndex = 0) => {
      // Use the optimized playNow event for immediate playback
      const newQueue = deduplicateQueue([trackId], queueIds, currentIndex);
      playbackEvents.playNow(newQueue);
    },
    
    playTracks: (trackIds: string[], queueIds: string[] = [], currentIndex = 0) => {
      const newQueue = deduplicateQueue(trackIds, queueIds, currentIndex);
      // Use the optimized playNow event for immediate playback
      if (newQueue.length > 0) {
        playbackEvents.playNow(newQueue);
      }
    },
    
    addToQueue: (trackIds: string[], queueIds: string[] = []) => {
      const toAdd = filterNewTracks(trackIds, queueIds);
      if (toAdd.length > 0) {
        playbackEvents.enqueue(toAdd);
      }
    },
    
    addToPlaylist: (track: SpotifyTrack) => {
      playbackEvents.openAddToPlaylistModal(track);
    },
  }), []);
}

// Extract unique writers from Genius data
export function extractWritersFromGenius(songDetails: any): string[] {
  if (!songDetails) return [];
  
  const writerArtists: any[] = songDetails?.writerArtists || 
                               songDetails?.raw?.writerArtists || 
                               [];
  
  const names = writerArtists.map((wa: any) => wa.name).filter(Boolean);
  
  if (!names.length) return [];
  
  // Remove duplicates (case-insensitive)
  const seen = new Set<string>();
  return names.filter((name: string) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Bio text processing helper
export function processBioText(bio?: string, maxLength = 300): { preview: string; full: string; needsExpansion: boolean } {
  if (!bio) return { preview: '', full: '', needsExpansion: false };
  
  const cleanBio = bio.replace(/<[^>]*>/g, ''); // Strip HTML tags
  const needsExpansion = cleanBio.length > maxLength;
  const preview = needsExpansion ? cleanBio.slice(0, maxLength) + '...' : cleanBio;
  
  return {
    preview,
    full: cleanBio,
    needsExpansion,
  };
}

export function customIcon(options: { text: string, bgColor?: string, color?: string, size?: number }) {
  return <span
    className="custom-icon"
    title={options.text}
    style={{
      backgroundColor: options.bgColor || 'transparent',
      color: options.color || 'inherit',
      fontSize: options.size ? `${options.size}px` : '16px',
    }}
  >{options.text}</span>;
}

export function formatIcon(options: { icon: string, size?: number }) {
  const formats={
    'mp3':  { bgColor: 'hsl(204deg 89% 39%)' },

    'm4a':  { bgColor: 'hsl(197deg 84% 34%)' },
    'mp4':  { bgColor: 'hsl(197deg 84% 34%)' },

    'ogg':  { bgColor: 'hsl(179deg 79% 29%)' },
    'opus': { bgColor: 'hsl(179deg 79% 29%)' },

    'webm': { bgColor: 'hsl(30deg 79% 50%)' },

    'aac':  { bgColor: 'hsl(0deg 84% 50%)' },

    'flac': { bgColor: 'hsl(290deg 40% 40%)' },
    'wav':  { bgColor: 'hsl(290deg 40% 40%)' },

    'dsd':  { bgColor: 'hsl(48deg 89% 50%)' },
    'dxd':  { bgColor: 'hsl(48deg 89% 50)' },

    'default': { bgColor: 'hsl(0deg 0% 20%)'},
  }
  return customIcon({
    text: options.icon.toUpperCase(),
    size: options.size || 10,
    bgColor: formats[options.icon.toLowerCase()]?.bgColor || formats['default'].bgColor,
    color: 'white',
  });
}