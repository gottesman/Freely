import { useCallback, useMemo } from 'react';
import { type SpotifyAlbum, type SpotifyArtist, type SpotifyTrack } from '../core/spotify';
import { useSpotifyClient } from '../core/spotify-client';
import GeniusClient from '../core/musicdata';

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
  
  return useMemo(() => {
    const geniusClient = new GeniusClient();
    const w = window as any;
    
    return {
      // Legacy compatibility - hasElectron check for existing HomeTab code
      hasElectron: !!w.electron?.spotify,
      
      // Image resolution helper for legacy compatibility
      imageRes: (images?: Array<{url?: string}>, idx = 1) => {
        if (typeof w.imageRes === 'function') return w.imageRes(images, idx);
        if (!images || !images.length) return null;
        return images[Math.min(idx, images.length - 1)]?.url || images[0]?.url || null;
      },
      
      // Spotify API methods with electron fallback
      getTrack: async (id: string): Promise<SpotifyTrack | undefined> => {
        try {
          if (w.electron?.spotify?.getTrack) {
            return await w.electron.spotify.getTrack(id);
          }
          return await spotifyClient.getTrack(id);
        } catch (error) {
          console.warn('Failed to fetch track:', error);
          return undefined;
        }
      },
      
      getTracks: async (ids: string[]): Promise<SpotifyTrack[]> => {
        try {
          if (w.electron?.spotify?.getTracks) {
            return await w.electron.spotify.getTracks(ids);
          }
          return await spotifyClient.getTracks(ids);
        } catch (error) {
          console.warn('Failed to fetch tracks:', error);
          return [];
        }
      },
      
      getPlaylist: async (id: string): Promise<any> => {
        try {
          if (w.electron?.spotify?.getPlaylist) {
            return await w.electron.spotify.getPlaylist(id);
          }
          return await spotifyClient.getPlaylist(id);
        } catch (error) {
          console.warn('Failed to fetch playlist:', error);
          return undefined;
        }
      },
      
      getAlbum: async (id: string): Promise<SpotifyAlbum | undefined> => {
        try {
          if (w.electron?.spotify?.getAlbum) {
            return await w.electron.spotify.getAlbum(id);
          }
          return await spotifyClient.getAlbum(id);
        } catch (error) {
          console.warn('Failed to fetch album:', error);
          return undefined;
        }
      },
      
      getArtist: async (id: string): Promise<SpotifyArtist | undefined> => {
        try {
          if (w.electron?.spotify?.getArtist) {
            return await w.electron.spotify.getArtist(id);
          }
          return await spotifyClient.getArtist(id);
        } catch (error) {
          console.warn('Failed to fetch artist:', error);
          return undefined;
        }
      },
      
      getAlbumTracks: async (id: string, options?: { fetchAll?: boolean; limit?: number }): Promise<SpotifyTrack[]> => {
        try {
          if (w.electron?.spotify?.getAlbumTracks) {
            const res = await w.electron.spotify.getAlbumTracks(id);
            return res?.items || [];
          }
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
          if (w.electron?.spotify?.getArtistTopTracks) {
            return await w.electron.spotify.getArtistTopTracks(id, options);
          }
          return await spotifyClient.getArtistTopTracks(id, options);
        } catch (error) {
          console.warn('Failed to fetch artist top tracks:', error);
          return [];
        }
      },
      
      getArtistAlbums: async (id: string, options?: any): Promise<SpotifyAlbum[]> => {
        try {
          if (w.electron?.spotify?.getArtistAlbums) {
            const res = await w.electron.spotify.getArtistAlbums(id, options);
            return res?.items || [];
          }
          const res = await spotifyClient.getArtistAlbums(id, options);
          return res?.items || [];
        } catch (error) {
          console.warn('Failed to fetch artist albums:', error);
          return [];
        }
      },
      
      getRecommendations: async (options: any): Promise<any> => {
        try {
          if (w.electron?.spotify?.getRecommendations) {
            return await w.electron.spotify.getRecommendations(options);
          }
          return await spotifyClient.getRecommendations(options);
        } catch (error) {
          console.warn('Failed to get recommendations:', error);
          return null;
        }
      },
      
      searchPlaylists: async (query: string): Promise<any[]> => {
        try {
          if (w.electron?.spotify?.searchPlaylists) {
            const res = await w.electron.spotify.searchPlaylists(query);
            return res?.items || res?.playlists?.items || [];
          }
          const res = await spotifyClient.searchPlaylists(query);
          return res?.items || [];
        } catch (error) {
          console.warn('Failed to search playlists:', error);
          return [];
        }
      },
      
      // Genius API methods
      geniusSearch: async (query: string): Promise<any> => {
        try {
          if (w.electron?.genius?.search) {
            return await w.electron.genius.search(query);
          }
          return await geniusClient.search(query);
        } catch (error) {
          console.warn('Failed to search Genius:', error);
          return null;
        }
      },
      
      geniusGetSong: async (id: number): Promise<any> => {
        try {
          if (w.electron?.genius?.getSong) {
            return await w.electron.genius.getSong(id);
          }
          return await geniusClient.getSong(id);
        } catch (error) {
          console.warn('Failed to get Genius song:', error);
          return null;
        }
      },
      
      geniusGetArtist: async (id: number): Promise<any> => {
        try {
          if (w.electron?.genius?.getArtist) {
            return await w.electron.genius.getArtist(id);
          }
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
