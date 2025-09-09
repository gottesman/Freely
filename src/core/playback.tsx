import React, { createContext, useEffect, useState, ReactNode, useMemo, useCallback } from 'react';
import { runTauriCommand, isTauriError, isTauriUnavailable } from './tauriCommands';
import SpotifyClient, { SpotifyTrack } from './spotify';
import { createCachedSpotifyClient } from './spotify-client';
// This import correctly points to the new IndexedDB provider.
import { useDB } from './dbIndexed';
import AudioSourceProvider, { resolveAudioSource, AudioSourceSpec } from './audioSource';
import { startPlaybackWithCache, isCacheableUrl } from './audioCache';

// Performance constants
const PERFORMANCE_CONSTANTS = {
  DEFAULT_QUEUE_INDEX: 0,
  INITIAL_TRACK_INDEX: 0,
  EMPTY_QUEUE_LENGTH: 0,
  PREFETCH_BATCH_SIZE: 5
} as const;

const TEST_TRACK_IDS: string[] = [
  '5AZGbqiIK5t1jrWSPT7k8X', // existing sample
  '3n3Ppam7vgaVa1iaRUc9Lp', // lose yourself (example popular track)
  '7ouMYWpwJ422jRcDASZB7P', // numb
  '0eGsygTp906u18L0Oimnem', // enter sandman
  '11dFghVXANMlKmJXsNCbNl'  // spotify api sample track
];

// Event type constants
const PLAYBACK_EVENTS = {
  SET_QUEUE: 'freely:playback:setQueue',
  ENQUEUE: 'freely:playback:enqueue',
  PLAY_AT: 'freely:playback:playAt',
  PLAY_TRACK: 'freely:playback:playTrack',
  PLAY_NOW: 'freely:playback:playNow',
  REORDER_QUEUE: 'freely:playback:reorderQueue',
  NEXT: 'freely:playback:next',
  PREV: 'freely:playback:prev',
  REMOVE_TRACK: 'freely:playback:removeTrack'
} as const;

// Utility classes for better organization
class QueueManager {
  /**
   * Safely get index within queue bounds
   */
  static getSafeIndex(index: number, queueLength: number): number {
    return Math.min(Math.max(0, index), queueLength - 1);
  }

  /**
   * Get next index with wraparound
   */
  static getNextIndex(currentIndex: number, queueLength: number): number {
    return queueLength > 0 ? (currentIndex + 1) % queueLength : 0;
  }

  /**
   * Get previous index with wraparound
   */
  static getPrevIndex(currentIndex: number, queueLength: number): number {
    return queueLength > 0 ? (currentIndex - 1 + queueLength) % queueLength : 0;
  }

  /**
   * Remove duplicates while preserving order
   */
  static removeDuplicates(ids: string[]): string[] {
    return Array.from(new Set(ids));
  }

  /**
   * Prepend items to queue with deduplication
   */
  static prependToQueue(newIds: string[], existingQueue: string[]): string[] {
    const filtered = existingQueue.filter(id => !newIds.includes(id));
    return [...newIds, ...filtered];
  }
}

class PlaybackEventManager {
  /**
   * Create standardized event detail
   */
  static createEventDetail(data: Record<string, any>): CustomEventInit {
    return { detail: data };
  }

  /**
   * Safely extract event detail with defaults
   */
  static extractEventDetail(event: Event): Record<string, any> {
    return (event as CustomEvent).detail || {};
  }

  /**
   * Normalize IDs from event detail
   */
  static extractIds(detail: Record<string, any>): string[] {
    const { ids, id } = detail;
    return Array.isArray(ids) ? ids : (id ? [String(id)] : []);
  }
}

interface PlaybackContextValue {
  currentTrack?: SpotifyTrack;
  loading: boolean;
  error?: string;
  trackId?: string;
  setTrackId: (id: string) => void;
  refresh: () => Promise<void>;
  // Queue
  queueIds: string[];
  currentIndex: number;
  setQueue: (ids: string[], startIndex?: number) => void;
  enqueue: (ids: string | string[]) => void;
  next: () => void;
  prev: () => void;
  playAt: (index: number) => void;
  playTrack: (id: string) => void;
  // Prepend a track to the front of the queue (deduplicated) and play it
  playNow: (id: string | string[]) => void;
  trackCache: Record<string, SpotifyTrack | undefined>;
  reorderQueue: (nextIds: string[]) => void;
  removeFromQueue: (id: string) => void;
  // Resolved playback
  playbackUrl?: string;
  playing: boolean;
  duration: number; // seconds
  position: number; // seconds
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
}

const PlaybackContext = createContext<PlaybackContextValue | undefined>(undefined);


// --- Selector pub/sub for fine-grained subscriptions ---
type PlaybackStateSnapshot = {
  currentTrack?: SpotifyTrack;
  loading: boolean;
  error?: string;
  trackId?: string;
  queueIds: string[];
  currentIndex: number;
  trackCache: Record<string, SpotifyTrack | undefined>;
  playbackUrl?: string;
  playing: boolean;
  duration: number;
  position: number;
};

let playbackSnapshot: PlaybackStateSnapshot | null = null;
let subscriberId = 0;
const playbackSubscribers = new Map<number, { selector: (s: PlaybackStateSnapshot) => any; last: any; cb: (v: any) => void }>();

function notifyPlaybackSubscribers(snapshot: PlaybackStateSnapshot) {
  playbackSubscribers.forEach((entry) => {
    try {
      const next = entry.selector(snapshot);
      if (!Object.is(next, entry.last)) {
        entry.last = next;
        entry.cb(next);
      }
    } catch (err) {
      console.warn('[playback-debug] subscriber error', err);
    }
  });
}

export function subscribePlaybackSelector<T>(selector: (s: PlaybackStateSnapshot) => T, cb: (v: T) => void) {
  const id = ++subscriberId;
  const initial = playbackSnapshot ? selector(playbackSnapshot) : undefined;
  playbackSubscribers.set(id, { selector: selector as any, last: initial, cb: cb as any });
  return () => { playbackSubscribers.delete(id); };
}

// Global cache control for debugging/testing
let globalPlaybackCacheClear: (() => void) | null = null;
export function clearPlaybackUrlCache() {
  if (globalPlaybackCacheClear) {
    console.log('[playback] Clearing playback URL cache globally');
    globalPlaybackCacheClear();
  } else {
    console.warn('[playback] Cache clear function not available - playback provider not mounted');
  }
}

export function usePlaybackSelector<T>(selector: (s: PlaybackStateSnapshot) => T, deps: any[] = []): T | undefined {
  const [val, setVal] = useState<T | undefined>(() => playbackSnapshot ? selector(playbackSnapshot) : undefined);
  useEffect(() => {
    let mounted = true;
    const unsub = subscribePlaybackSelector(selector, (v: T) => { if (mounted) setVal(v); });
    // also update once immediately in case snapshot changed before subscribe
    if (playbackSnapshot) {
      const cur = selector(playbackSnapshot);
      if (!Object.is(cur, val)) setVal(cur);
    }
    return () => { mounted = false; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return val;
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [trackId, setTrackId] = useState<string>(TEST_TRACK_IDS[PERFORMANCE_CONSTANTS.INITIAL_TRACK_INDEX]);
  const [currentTrack, setCurrentTrack] = useState<SpotifyTrack | undefined>();
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | undefined>();
  const [queueIds, setQueueIds] = useState<string[]>(TEST_TRACK_IDS);
  const [currentIndex, setCurrentIndex] = useState<number>(PERFORMANCE_CONSTANTS.DEFAULT_QUEUE_INDEX);
  const [trackCache, setTrackCache] = useState<Record<string, SpotifyTrack | undefined>>({});
  const [playbackUrlCache, setPlaybackUrlCache] = useState<Record<string, string | undefined>>({});
  const [playbackUrl, setPlaybackUrl] = useState<string | undefined>();
  const [playing, setPlaying] = useState<boolean>(false);
  const [duration, setDuration] = useState<number>(0); // duration unknown until we implement probing
  const [position, setPosition] = useState<number>(0);
  const pollRef = React.useRef<any>(null);
  // Seek debounce refs
  const seekDebounceRef = React.useRef<any>(null);
  const lastSeekSentRef = React.useRef<number>(0);
  const pendingSeekRef = React.useRef<number | null>(null);
  const SEEK_DEBOUNCE_MS = 180; // wait after last movement
  const SEEK_MIN_INTERVAL_MS = 120; // ensure not more often than this even while moving
  
  const { getApiCache, setApiCache, addPlay, ready, getSetting } = useDB();

  // Connect global cache clear function
  React.useEffect(() => {
    globalPlaybackCacheClear = () => {
      setPlaybackUrlCache({});
    };
    
    // Make it available on window for testing
    if (typeof window !== 'undefined') {
      (window as any).clearPlaybackCache = clearPlaybackUrlCache;
    }
    
    return () => {
      globalPlaybackCacheClear = null;
      if (typeof window !== 'undefined') {
        delete (window as any).clearPlaybackCache;
      }
    };
  }, []);

  // Memoize Spotify client to prevent recreation
  const spotifyClient = useMemo(() => {
    return ready ? createCachedSpotifyClient({ getApiCache, setApiCache }) : new SpotifyClient();
  }, [ready, getApiCache, setApiCache]);

  // Optimize track fetching with useCallback
  const fetchTrack = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true); 
    setError(undefined);
    
    try {
      const w: any = typeof window !== 'undefined' ? window : {};
      let track: SpotifyTrack;
      
      if (w.electron?.spotify?.getTrack) {
        const resp = await w.electron.spotify.getTrack(id);
        if (resp && (resp as any).error) throw new Error((resp as any).error);
        track = resp as any;
      } else {
        track = await spotifyClient.getTrack(id);
      }

      // Load and attach selected source from database if available
      if (ready && getSetting) {
        try {
          const savedSource = await getSetting(`source:selected:${id}`);
          
          if (savedSource && savedSource.trim()) {
            const parsedSource = JSON.parse(savedSource);
            
            // Determine the correct value based on source type
            let sourceValue: string = '';
            if (parsedSource.type === 'youtube') {
              // For YouTube, use the original video ID, not the playUrl (which is the proxy URL)
              sourceValue = parsedSource.id || parsedSource.value || '';
            } else if (parsedSource.type === 'torrent') {
              // For torrents, prefer infoHash over magnetURI for streaming
              sourceValue = parsedSource.infoHash || parsedSource.magnetURI || '';
            } else if (parsedSource.type === 'http') {
              sourceValue = parsedSource.playUrl || parsedSource.url || '';
            } else if (parsedSource.type === 'local') {
              sourceValue = parsedSource.playUrl || parsedSource.path || '';
            } else {
              sourceValue = parsedSource.playUrl || parsedSource.value || '';
            }

            if (sourceValue) {
              // Attach source metadata to track
              (track as any).source = {
                type: parsedSource.type,
                value: sourceValue,
                meta: {
                  id: parsedSource.id,
                  infoHash: parsedSource.infoHash,
                  magnetURI: parsedSource.magnetURI,
                  playUrl: parsedSource.playUrl,
                  title: parsedSource.title
                }
              };
            }
          }
        } catch (e) {
          // Ignore source loading errors - track will just not have a source
          console.warn('Failed to load track source:', e);
        }
      }
      
      setCurrentTrack(track);
      setTrackCache(prev => ({ ...prev, [id]: track }));
      
      // Async URL resolution
      resolvePlaybackUrl(track, id);
    } catch (e: any) {
      setError(e?.message || String(e));
      setCurrentTrack(undefined);
    } finally { 
      setLoading(false); 
    }
  }, [spotifyClient, ready, getSetting]);

  // Extract URL resolution to separate function
  const resolvePlaybackUrl = useCallback(async (track: SpotifyTrack, id: string) => {
    const sourceMeta = (track as any).source;
    console.log('[playback] Resolving playback URL for:', { id, sourceMeta });
    
    try {
      if (sourceMeta && sourceMeta.type && sourceMeta.value) {
        const spec: AudioSourceSpec = { 
          type: sourceMeta.type, 
          value: sourceMeta.value, 
          meta: sourceMeta.meta 
        };
        console.log('[playback] Resolving audio source with spec:', spec);
        const url = await resolveAudioSource(spec);
        console.log('[playback] Resolved audio URL:', { id, url });
        setPlaybackUrlCache(prev => ({ ...prev, [id]: url }));
        // If this is the currently focused track set playback url
        if (id === trackId) {
          console.log('[playback] Setting playback URL for current track:', url);
          setPlaybackUrl(url);
        }
      } else {
        console.log('[playback] Cannot resolve - missing source meta:', { id, sourceMeta });
      }
    } catch (e) {
      console.error('[playback] URL resolution failed:', { id, error: e });
      // Ignore resolution errors silently
    }
  }, [trackId]);

  // Optimize main track fetch effect
  useEffect(() => { 
    fetchTrack(trackId); 
  }, [trackId, fetchTrack]);

  // (moved) audio element setup placed after queue navigation callbacks

  // Start backend playback when playbackUrl set; stop when cleared
  useEffect(() => {
    console.log('[playback] Playback URL effect triggered, playbackUrl:', playbackUrl);
    let cancelled = false;
    const start = async () => {
      if (!playbackUrl) {
        console.log('[playback] No playbackUrl, stopping playback');
        try {
          const stopResult = await runTauriCommand('playback_stop');
          if (!stopResult.success) {
            console.warn('[playback] Stop failed:', stopResult.error);
          }
        } catch (e) {
          console.warn('[playback] Stop failed (might be browser):', e);
        }
        setPlaying(false); setPosition(0); setDuration(0); return;
      }
      try {
        console.log('[playback] Starting playback for URL:', playbackUrl);
        
        // Use cache-aware playback for supported URLs
        let result;
        if (trackId && isCacheableUrl(playbackUrl)) {
          console.log('[playback] Using cache-aware playback for track:', trackId);
          
          // Try to get original source information for better caching
          const track = (currentTrack?.id === trackId ? currentTrack : trackCache[trackId]) || currentTrack;
          const sourceMeta = (track as any)?.source;
          
          let sourceType: string | undefined;
          let sourceHash: string | undefined;
          
          if (sourceMeta?.type === 'youtube' && sourceMeta?.value) {
            sourceType = 'youtube';
            sourceHash = sourceMeta.value; // Use original YouTube video ID
            console.log('[playback] Using original YouTube video ID for cache:', sourceHash);
          }
          
          result = await startPlaybackWithCache(trackId, playbackUrl, true, sourceType, sourceHash);
        } else {
          console.log('[playback] Using direct playback (not cacheable)');
          result = await runTauriCommand('playback_start', { url: playbackUrl });
        }
        
        console.log('[playback] Start result:', result);
        
        // Don't set playing=true here - let the status polling handle it
        // The backend will return success info and duration
        if (result.success && result.data && typeof result.data.duration === 'number') {
          setDuration(result.data.duration);
        }
      } catch (error) {
        console.error('[playback] Failed to start:', error);
        if (error.message?.includes('invoke not available')) {
          setError('Audio playback requires the desktop app. Please open the Tauri application window instead of the browser.');
        } else {
          setError(`Playback failed: ${error}`);
        }
        if (!cancelled) {
          setPlaying(false);
        }
      }
    };
    start();
    return () => { cancelled = true; };
  }, [playbackUrl]);

  // When track changes, only use selected source (never preview_url)
  useEffect(() => {
    if (!trackId) {
      console.log('[playback] No trackId, clearing playback URL');
      setPlaybackUrl(undefined);
      return;
    }
    
    // Prioritize currentTrack if it matches the trackId, as it's more likely to have fresh source data
    const track = (currentTrack?.id === trackId ? currentTrack : trackCache[trackId]) || currentTrack;
    if (!track) {
      console.log('[playback] No track found for ID:', trackId);
      setPlaybackUrl(undefined);
      return;
    }
    
    const sourceMeta = (track as any).source;
    console.log('[playback] Track source meta:', { trackId, sourceMeta });
    
    if (sourceMeta) {
      // First, check if we have a cached audio file for this track
      const checkCachedFile = async () => {
        try {
          let sourceType = 'unknown';
          let sourceHash = '';
          
          if (sourceMeta.type === 'youtube' && sourceMeta.value) {
            sourceType = 'youtube';
            sourceHash = sourceMeta.value;
          }
          
          console.log('[playback] Checking for cached file:', { trackId, sourceType, sourceHash });
          
          const cacheResult = await runTauriCommand('cache_get_file', {
            trackId,
            sourceType,
            sourceHash
          });
          
          if (cacheResult && cacheResult.cached_path) {
            console.log('[playback] Found cached file, using local file:', cacheResult.cached_path);
            setPlaybackUrl(`file://${cacheResult.cached_path}`);
            return;
          }
          
          console.log('[playback] No cached file found, proceeding with URL resolution');
          proceedWithUrlResolution();
        } catch (error) {
          console.log('[playback] Cache check failed, proceeding with URL resolution:', error);
          proceedWithUrlResolution();
        }
      };
      
      const proceedWithUrlResolution = () => {
        // For YouTube sources, always re-resolve to get fresh direct CDN URLs
        const isYouTubeSource = sourceMeta.type === 'youtube';
        
        if (playbackUrlCache[trackId] && !isYouTubeSource) {
          console.log('[playback] Using cached playback URL for:', trackId, playbackUrlCache[trackId]);
          setPlaybackUrl(playbackUrlCache[trackId]);
        } else if (isYouTubeSource && playbackUrlCache[trackId]) {
          console.log('[playback] YouTube source found in cache, using cached URL:', trackId, playbackUrlCache[trackId]);
          setPlaybackUrl(playbackUrlCache[trackId]);
        } else {
          if (isYouTubeSource) {
            console.log('[playback] YouTube source detected, waiting for fresh resolution for:', trackId);
          } else {
            console.log('[playback] No cached URL, clearing until resolved for:', trackId);
          }
          // Clear until resolved
          setPlaybackUrl(undefined);
        }
      };
      
      // Start with cache check
      checkCachedFile();
    } else {
      console.log('[playback] No source meta found - track has no selected source for:', trackId);
      // No selected source meta => no playback
      setPlaybackUrl(undefined);
    }
  }, [trackId, currentTrack, trackCache, playbackUrlCache]);

  // Control helpers
  const play = useCallback(async () => { 
    if (!playbackUrl) return; 
    try {
      console.log('[playback] Resuming playback');
      const result = await runTauriCommand('playback_resume');
      if (!result.success) {
        console.error('[playback] Resume failed:', result.error);
        setPlaying(false);
      }
      // Don't set playing=true here - let status polling handle it
    } catch (error) {
      console.error('[playback] Resume failed:', error);
      setPlaying(false);
    }
  }, [playbackUrl]);
  
  const pause = useCallback(async () => { 
    try {
      console.log('[playback] Pausing playback');
      const result = await runTauriCommand('playback_pause');
      if (!result.success) {
        console.error('[playback] Pause failed:', result.error);
      }
      // Don't set playing=false here - let status polling handle it
    } catch (error) {
      console.error('[playback] Pause failed:', error);
    }
  }, []);
  
  const toggle = useCallback(() => { if (playing) pause(); else play(); }, [playing, play, pause]);
  const seek = useCallback((time: number) => {
    if (!playbackUrl) return;
    console.log('[playback] Seeking to:', time);
    
    const originalPosition = position; // Store original position for rollback
    setPosition(time); // optimistic UI update
    pendingSeekRef.current = time;
    const now = Date.now();
    
    const send = async () => {
      const val = pendingSeekRef.current;
      if (val == null) return;
      try {
        const result = await runTauriCommand('playback_seek', { position: val });
        
        if (!result?.success || result.data?.success === false) {
          const seekData = result?.data || result;
          const reason = seekData?.reason || 'unknown';
          const message = seekData?.message || 'Unknown error';
          
          console.warn('[playback] Seek failed:', reason, '-', message);
          
          // Handle different types of seek failures
          if (reason === 'data_not_available' || reason === 'not_buffered') {
            console.warn('[playback] Seek position not yet buffered, ignoring seek failure');
            // Don't rollback position for buffering issues - the UI position is aspirational
          } else if (reason === 'streaming_limitation' || reason === 'invalid_position') {
            console.warn('[playback] Seek not supported or invalid position, rolling back');
            setPosition(originalPosition); // Rollback for unsupported seeks
          } else {
            console.warn('[playback] General seek error, rolling back');
            setPosition(originalPosition); // Rollback for other errors
          }
        } else {
          const seekPosition = result.data?.position || val;
          console.log('[playback] Seek successful to:', seekPosition);
          // Position already optimistically updated, no need to change it
        }
        
        lastSeekSentRef.current = Date.now();
        pendingSeekRef.current = null;
      } catch (error) {
        console.warn('[playback] Seek failed:', error);
        // Rollback optimistic update on failure
        setPosition(originalPosition);
      }
    };
    // If enough time passed since last send, send immediately
    if (now - lastSeekSentRef.current > SEEK_MIN_INTERVAL_MS) {
      if (seekDebounceRef.current) { clearTimeout(seekDebounceRef.current); seekDebounceRef.current = null; }
      send();
      return;
    }
    // Otherwise debounce
    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current);
    seekDebounceRef.current = setTimeout(() => {
      send();
      seekDebounceRef.current = null;
    }, SEEK_DEBOUNCE_MS);
  }, [playbackUrl]);

  // Optimize play history recording - wait for database to be ready
  useEffect(() => {
    if (!trackId || !ready) return;
    
    const recordPlay = async () => {
      try {
        await addPlay(trackId, Date.now());
      } catch (e) {
        console.warn('Failed to record play:', e);
      }
    };
    
    recordPlay();
  }, [trackId, addPlay, ready]);

  // Optimize queue index synchronization
  useEffect(() => {
    const idx = queueIds.indexOf(trackId);
    if (idx !== -1 && idx !== currentIndex) {
      setCurrentIndex(idx);
    }
  }, [trackId, queueIds, currentIndex]);

  // Optimize queue trimming
  useEffect(() => {
    if (currentIndex > PERFORMANCE_CONSTANTS.DEFAULT_QUEUE_INDEX) {
      setQueueIds(q => {
        if (currentIndex >= q.length) return q;
        const trimmed = q.slice(currentIndex);
        setCurrentIndex(PERFORMANCE_CONSTANTS.DEFAULT_QUEUE_INDEX);
        return trimmed;
      });
    }
  }, [currentIndex]);

  // Optimize track prefetching with better batching
  useEffect(() => {
    let cancelled = false;
    
    const prefetchTracks = async () => {
      for (const id of queueIds.slice(0, PERFORMANCE_CONSTANTS.PREFETCH_BATCH_SIZE)) {
        if (cancelled) return;
        
        // Prefetch track metadata
        if (!trackCache[id]) {
          try {
            const track = await spotifyClient.getTrack(id);
            if (!cancelled) {
              setTrackCache(prev => ({ ...prev, [id]: track }));
            }
          } catch {
            // Ignore prefetch errors
          }
        }
        
  // (Removed) Do not prefetch preview_url; only real selected sources will populate cache
      }
    };
    
    prefetchTracks();
    return () => { cancelled = true; };
  }, [queueIds, trackCache, playbackUrlCache, spotifyClient]);

  // Optimize queue management functions with useCallback
  const setQueue = useCallback((ids: string[], startIndex: number = PERFORMANCE_CONSTANTS.DEFAULT_QUEUE_INDEX) => {
    setQueueIds(ids);
    if (ids.length) {
      const safeIndex = QueueManager.getSafeIndex(startIndex, ids.length);
      setCurrentIndex(safeIndex);
      setTrackId(ids[safeIndex]);
    }
  }, []);

  const enqueue = useCallback((ids: string | string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    setQueueIds(q => [...q, ...arr]);
  }, []);

  const playAt = useCallback((index: number) => {
    if (index < 0 || index >= queueIds.length) return;
    setCurrentIndex(index);
    setTrackId(queueIds[index]);
  }, [queueIds]);

  const playTrack = useCallback((id: string) => {
    const idx = queueIds.indexOf(id);
    if (idx === -1) {
      const newQueue = [...queueIds, id];
      setQueueIds(newQueue);
      setCurrentIndex(newQueue.length - 1);
    } else {
      setCurrentIndex(idx);
    }
    setTrackId(id);
  }, [queueIds]);
  
  const playNow = useCallback((ids: string | string[]) => {
    const idsArr = PlaybackEventManager.extractIds({ ids });
    if (!idsArr.length) return;
    
    setQueueIds(prev => QueueManager.prependToQueue(idsArr, prev));
    setCurrentIndex(PERFORMANCE_CONSTANTS.DEFAULT_QUEUE_INDEX);
    setTrackId(idsArr[PERFORMANCE_CONSTANTS.DEFAULT_QUEUE_INDEX]);
  }, []);

  const next = useCallback(() => {
    if (!queueIds.length) return;
    const nextIndex = QueueManager.getNextIndex(currentIndex, queueIds.length);
    playAt(nextIndex);
  }, [queueIds.length, currentIndex, playAt]);

  const prev = useCallback(() => {
    if (!queueIds.length) return;
    const prevIndex = QueueManager.getPrevIndex(currentIndex, queueIds.length);
    playAt(prevIndex);
  }, [queueIds.length, currentIndex, playAt]);

  // Poll backend playback status (only in Tauri app, not browser)
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    
    console.log('[playback] Setting up status polling interval');
    pollRef.current = setInterval(async () => {
      try {
        const result = await runTauriCommand('playback_status');
        
        // Check if Tauri is unavailable
        if (isTauriUnavailable(result)) {
          // Only log this occasionally to avoid spam
          if (Math.random() < 0.01) {
            console.log('[playback] Tauri not available, skipping status update');
          }
          return;
        }
        
        if (!result) {
          console.warn('[playback] Status command returned null - Tauri invoke may not be available');
          return;
        }
        
        if (!result.success) {
          console.warn('[playback] Status query failed:', result.error);
          return;
        }
        
        const status = result.data;
        
        // Update UI state based on actual backend state
        const wasPlaying = playing;
        const isPlaying = !!status.playing;
        setPlaying(isPlaying);
        
        // Update position and duration from backend
        if (typeof status.position === 'number') {
          setPosition(status.position);
        }
        if (typeof status.duration === 'number') {
          setDuration(status.duration);
        }
        
        // Handle errors from backend
        if (status.error) {
          // Don't treat seek errors as critical playback errors
          if (status.error.includes('BASS_ERROR_NOTAVAIL')) {
            // This is likely a seek error, don't stop playback or show persistent error
            console.debug('[playback] Backend seek error (not critical):', status.error);
          } else {
            console.warn('[playback] Backend error:', status.error);
            setError(status.error);
            setPlaying(false);
          }
        } else {
          // Clear error if playback is working
          if (isPlaying && error) {
            setError(undefined);
          }
        }
        
        // Auto advance queue when track ends
        if (status.ended && playbackUrl && wasPlaying) {
          console.log('[playback] Track ended, advancing to next');
          next();
        }
        
        // Debug logging when state changes
        if (wasPlaying !== isPlaying) {
          console.log('[playback] State changed:', { wasPlaying, isPlaying, url: status.url });
        }
        
      } catch (pollError) {
        // Don't spam console with polling errors, but log occasionally
        if (Math.random() < 0.1) {
          console.warn('[playback] Status polling error:', pollError);
        }
      }
    }, 500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [playing, playbackUrl, error, next]);

  // Cleanup debounce timer on unmount
  useEffect(()=>()=>{ if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current); }, []);

  const reorderQueue = useCallback((nextIds: string[]) => {
    if (!nextIds.length) return;
    const currentId = trackId;
    setQueueIds(nextIds);
    const newIndex = nextIds.indexOf(currentId || '');
    if (newIndex !== -1) setCurrentIndex(newIndex);
  }, [trackId]);

  const removeFromQueue = useCallback((id: string) => {
    if (!id) return;
    
    setQueueIds(q => {
      const idx = q.indexOf(id);
      if (idx === -1) return q;
      
      const next = q.filter(t => t !== id);
      if (!next.length) {
        setCurrentIndex(PERFORMANCE_CONSTANTS.DEFAULT_QUEUE_INDEX);
        setTrackId('');
        setCurrentTrack(undefined);
        return [];
      }
      
      if (trackId === id) {
        const newIndex = idx < next.length ? idx : next.length - 1;
        setCurrentIndex(newIndex);
        setTrackId(next[newIndex]);
      } else {
        const newCurIdx = next.indexOf(trackId || '');
        if (newCurIdx !== -1) setCurrentIndex(newCurIdx);
      }
      return next;
    });
  }, [trackId]);

  // Memoize context value to prevent unnecessary re-renders
  const value: PlaybackContextValue = useMemo(() => ({
    currentTrack,
    loading,
    error,
    trackId,
    setTrackId,
    refresh: () => fetchTrack(trackId),
    queueIds,
    currentIndex,
    setQueue,
    enqueue,
    next,
    prev,
    playAt,
    playTrack,
    playNow,
    trackCache,
    reorderQueue,
  removeFromQueue,
  playbackUrl,
  playing,
  duration,
  position,
  play,
  pause,
  toggle,
  seek
  }), [
    currentTrack, loading, error, trackId, queueIds, currentIndex, trackCache,
  fetchTrack, setQueue, enqueue, next, prev, playAt, playTrack, playNow, reorderQueue, removeFromQueue,
  playbackUrl, playing, duration, position, play, pause, toggle, seek
  ]);

  // Optimize playback snapshot updates
  useEffect(() => {
    const snap: PlaybackStateSnapshot = { 
      currentTrack, 
      loading, 
      error, 
      trackId, 
      queueIds, 
      currentIndex, 
    trackCache,
    playbackUrl,
    playing,
    duration,
    position
    };
    playbackSnapshot = snap;
    notifyPlaybackSubscribers(snap);
  }, [currentTrack, loading, error, trackId, queueIds, currentIndex, trackCache, playbackUrl, playing, duration, position]);

  // Optimize event handling with useCallback for event handlers
  const handleSetQueue = useCallback((ev: Event) => {
    const detail = PlaybackEventManager.extractEventDetail(ev);
    if (Array.isArray(detail.queueIds)) {
      setQueue(detail.queueIds, detail.startIndex ?? PERFORMANCE_CONSTANTS.DEFAULT_QUEUE_INDEX);
    }
  }, [setQueue]);

  const handleEnqueue = useCallback((ev: Event) => {
    const detail = PlaybackEventManager.extractEventDetail(ev);
    const ids = PlaybackEventManager.extractIds(detail);
    if (ids.length) enqueue(ids);
  }, [enqueue]);

  const handlePlayAt = useCallback((ev: Event) => {
    const detail = PlaybackEventManager.extractEventDetail(ev);
    if (typeof detail.index === 'number') playAt(detail.index);
  }, [playAt]);

  const handlePlayTrack = useCallback((ev: Event) => {
    const detail = PlaybackEventManager.extractEventDetail(ev);
    if (detail.id) playTrack(String(detail.id));
  }, [playTrack]);

  const handlePlayNow = useCallback((ev: Event) => {
    const detail = PlaybackEventManager.extractEventDetail(ev);
    const ids = PlaybackEventManager.extractIds(detail);
    if (ids.length) playNow(ids);
  }, [playNow]);

  const handleReorder = useCallback((ev: Event) => {
    const detail = PlaybackEventManager.extractEventDetail(ev);
    if (Array.isArray(detail.queueIds)) reorderQueue(detail.queueIds);
  }, [reorderQueue]);

  const handleRemoveTrack = useCallback((ev: Event) => {
    const detail = PlaybackEventManager.extractEventDetail(ev);
    const id = detail.id || detail.trackId;
    if (id) removeFromQueue(String(id));
  }, [removeFromQueue]);

  const handleSourceChanged = useCallback((ev: Event) => {
    const detail = PlaybackEventManager.extractEventDetail(ev);
    const changedTrackId = detail.trackId;
    
    // If the source changed for the currently playing track, refresh it
    if (changedTrackId && changedTrackId === trackId) {
      fetchTrack(trackId);
    }
  }, [trackId, fetchTrack]);

  // Optimize event listeners registration
  useEffect(() => {
    const eventHandlers = [
      { event: PLAYBACK_EVENTS.SET_QUEUE, handler: handleSetQueue },
      { event: PLAYBACK_EVENTS.ENQUEUE, handler: handleEnqueue },
      { event: PLAYBACK_EVENTS.PLAY_AT, handler: handlePlayAt },
      { event: PLAYBACK_EVENTS.PLAY_TRACK, handler: handlePlayTrack },
      { event: PLAYBACK_EVENTS.PLAY_NOW, handler: handlePlayNow },
      { event: PLAYBACK_EVENTS.REORDER_QUEUE, handler: handleReorder },
      { event: PLAYBACK_EVENTS.NEXT, handler: next },
      { event: PLAYBACK_EVENTS.PREV, handler: prev },
      { event: PLAYBACK_EVENTS.REMOVE_TRACK, handler: handleRemoveTrack },
      { event: 'freely:track:sourceChanged', handler: handleSourceChanged }
    ];

    // Register all event listeners
    eventHandlers.forEach(({ event, handler }) => {
      window.addEventListener(event, handler as any);
    });

    // Cleanup function
    return () => {
      eventHandlers.forEach(({ event, handler }) => {
        window.removeEventListener(event, handler as any);
      });
    };
  }, [
    handleSetQueue, handleEnqueue, handlePlayAt, handlePlayTrack, 
    handlePlayNow, handleReorder, next, prev, handleRemoveTrack, handleSourceChanged
  ]);

  return (
    <AudioSourceProvider>
      <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>
    </AudioSourceProvider>
  );
}

// Re-export hook for consuming components
export function usePlayback() {
  const context = React.useContext(PlaybackContext);
  if (!context) {
    throw new Error('usePlayback must be used within a PlaybackProvider');
  }
  return context;
}

export default { PlaybackProvider };