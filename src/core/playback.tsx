import React, { createContext, useEffect, useState, ReactNode, useMemo, useCallback, useReducer } from 'react';
import { runTauriCommand, isTauriUnavailable } from './TauriCommands';
import { SpotifyTrack, createCachedSpotifyClient } from './SpotifyClient';
import { useDB } from './Database';
import AudioSourceProvider from './audioSource';
import { startPlaybackWithSource } from './audioCache';

// Performance constants - consolidated and optimized
const CONFIG = {
  QUEUE: {
    DEFAULT_INDEX: 0,
    PREFETCH_SIZE: 3, // Reduced from 5 for better performance
    TEST_TRACKS: ['3n3Ppam7vgaVa1iaRUc9Lp', '7ouMYWpwJ422jRcDASZB7P', '6EJiVf7U0p1BBfs0qqeb1f']
  },
  SEEK: {
    DEBOUNCE_MS: 180,
    MIN_INTERVAL_MS: 120
  },
  VOLUME: {
    DEFAULT: 0.4
  }
} as const;

// Settings keys for persistence
const SETTINGS_KEYS = {
  VOLUME: 'audio_volume',
  MUTED: 'audio_muted'
} as const;

// Consolidated event constants
const EVENTS = {
  SET_QUEUE: 'freely:playback:setQueue',
  ENQUEUE: 'freely:playback:enqueue',
  PLAY_AT: 'freely:playback:playAt',
  PLAY_TRACK: 'freely:playback:playTrack',
  PLAY_NOW: 'freely:playback:playNow',
  REORDER_QUEUE: 'freely:playback:reorderQueue',
  NEXT: 'freely:playback:next',
  PREV: 'freely:playback:prev',
  REMOVE_TRACK: 'freely:playback:removeTrack',
  TRACK_CHANGED: 'freely:playback:trackChanged',
  QUEUE_POSITION_CHANGED: 'freely:playback:queuePositionChanged',
  SOURCE_CHANGED: 'freely:track:sourceChanged'
} as const;

// Simplified utility functions - removed unnecessary class abstractions
const queueUtils = {
  safeIndex: (index: number, length: number) => Math.max(0, Math.min(index, length - 1)),
  nextIndex: (current: number, length: number) => length > 0 ? (current + 1) % length : 0,
  prevIndex: (current: number, length: number) => length > 0 ? (current - 1 + length) % length : 0,
  removeDuplicates: (ids: string[]) => Array.from(new Set(ids)),
  prependToQueue: (newIds: string[], existing: string[]) => [
    ...newIds, 
    ...existing.filter(id => !newIds.includes(id))
  ]
};

const eventUtils = {
  extractDetail: (event: Event) => (event as CustomEvent).detail || {},
  extractIds: (detail: Record<string, any>) => {
    const { ids, id } = detail;
    return Array.isArray(ids) ? ids : (id ? [String(id)] : []);
  }
};

// Consolidated state management with useReducer for better performance
interface PlaybackState {
  // Track state
  trackId: string;
  currentTrack?: SpotifyTrack;
  loading: boolean;
  error?: string;
  
  // Queue state
  queueIds: string[];
  currentIndex: number;
  trackCache: Record<string, SpotifyTrack | undefined>;
  
  // Playback state
  playbackUrl?: string;
  playing: boolean;
  duration: number;
  position: number;
  codec?: string;
  sampleRate?: number;
  bitsPerSample?: number;
  
  // Volume state
  volume: number;
  muted: boolean;
  
  // Playback transition state
  isTransitioning: boolean;
  transitioningToTrackId?: string;
  awaitingBackendConfirmation: boolean;
  
  // Cache and control state
  cacheStatus: {
    isCaching: boolean;
    cacheProgress?: number;
    cachedSize?: number;
    totalSize?: number;
  };
  fetchInProgress: string | null;
  sourceLoadAttempted: Set<string>;
  shouldForcePlay: boolean;
}

type PlaybackAction =
  | { type: 'SET_TRACK_ID'; trackId: string }
  | { type: 'SET_CURRENT_TRACK'; track?: SpotifyTrack }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error?: string }
  | { type: 'SET_QUEUE'; queueIds: string[]; currentIndex: number }
  | { type: 'SET_CURRENT_INDEX'; index: number }
  | { type: 'UPDATE_TRACK_CACHE'; trackId: string; track: SpotifyTrack }
  | { type: 'SET_PLAYBACK_URL'; url?: string }
  | { type: 'SET_PLAYING'; playing: boolean }
  | { type: 'SET_POSITION'; position: number }
  | { type: 'SET_DURATION'; duration: number }
  | { type: 'SET_CODEC'; codec?: string }
  | { type: 'SET_SAMPLE_RATE'; sampleRate?: number }
  | { type: 'SET_BITS_PER_SAMPLE'; bitsPerSample?: number }
  | { type: 'SET_VOLUME'; volume: number; muted?: boolean }
  | { type: 'SET_CACHE_STATUS'; status: Partial<PlaybackState['cacheStatus']> }
  | { type: 'SET_FETCH_IN_PROGRESS'; trackId: string | null }
  | { type: 'ADD_SOURCE_LOAD_ATTEMPTED'; trackId: string }
  | { type: 'CLEAR_SOURCE_LOAD_ATTEMPTED' }
  | { type: 'SET_SHOULD_FORCE_PLAY'; shouldPlay: boolean }
  | { type: 'SET_TRANSITIONING'; isTransitioning: boolean; trackId?: string }
  | { type: 'SET_AWAITING_BACKEND'; awaiting: boolean };

const initialState: PlaybackState = {
  trackId: CONFIG.QUEUE.TEST_TRACKS[0],
  loading: false,
  queueIds: [...CONFIG.QUEUE.TEST_TRACKS], // Create mutable copy
  currentIndex: CONFIG.QUEUE.DEFAULT_INDEX,
  trackCache: {},
  playing: false,
  duration: 0,
  position: 0,
  volume: CONFIG.VOLUME.DEFAULT,
  muted: false,
  isTransitioning: false,
  awaitingBackendConfirmation: false,
  cacheStatus: { isCaching: false },
  fetchInProgress: null,
  sourceLoadAttempted: new Set(),
  shouldForcePlay: false
};

function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'SET_TRACK_ID':
      return { ...state, trackId: action.trackId };
    case 'SET_CURRENT_TRACK':
      return { ...state, currentTrack: action.track };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SET_QUEUE':
      return { ...state, queueIds: action.queueIds, currentIndex: action.currentIndex };
    case 'SET_CURRENT_INDEX':
      return { ...state, currentIndex: action.index };
    case 'UPDATE_TRACK_CACHE':
      return {
        ...state,
        trackCache: { ...state.trackCache, [action.trackId]: action.track }
      };
    case 'SET_PLAYBACK_URL':
      return { ...state, playbackUrl: action.url };
    case 'SET_PLAYING':
      return { ...state, playing: action.playing };
    case 'SET_POSITION':
      return { ...state, position: action.position };
    case 'SET_DURATION':
      return { ...state, duration: action.duration };
    case 'SET_CODEC':
      return { ...state, codec: action.codec };
    case 'SET_SAMPLE_RATE':
      return { ...state, sampleRate: action.sampleRate };
    case 'SET_BITS_PER_SAMPLE':
      return { ...state, bitsPerSample: action.bitsPerSample };
    case 'SET_VOLUME':
      return { 
        ...state, 
        volume: action.volume, 
        ...(action.muted !== undefined && { muted: action.muted })
      };
    case 'SET_CACHE_STATUS':
      return { ...state, cacheStatus: { ...state.cacheStatus, ...action.status } };
    case 'SET_FETCH_IN_PROGRESS':
      return { ...state, fetchInProgress: action.trackId };
    case 'ADD_SOURCE_LOAD_ATTEMPTED':
      return {
        ...state,
        sourceLoadAttempted: new Set(state.sourceLoadAttempted).add(action.trackId)
      };
    case 'CLEAR_SOURCE_LOAD_ATTEMPTED':
      return { ...state, sourceLoadAttempted: new Set() };
    case 'SET_SHOULD_FORCE_PLAY':
      return { ...state, shouldForcePlay: action.shouldPlay };
    case 'SET_TRANSITIONING':
      return { 
        ...state, 
        isTransitioning: action.isTransitioning,
        ...(action.trackId !== undefined && { transitioningToTrackId: action.trackId })
      };
    case 'SET_AWAITING_BACKEND':
      return { ...state, awaitingBackendConfirmation: action.awaiting };
    default:
      return state;
  }
}

// Context interface definition
interface PlaybackContextValue {
  // Basic state
  currentTrack?: SpotifyTrack;
  loading: boolean;
  error?: string;
  trackId: string;
  setTrackId: (id: string) => void;
  refresh: () => Promise<void>;
  
  // Queue management
  queueIds: string[];
  currentIndex: number;
  setQueue: (ids: string[], startIndex?: number, shouldPlay?: boolean) => void;
  enqueue: (ids: string | string[]) => void;
  next: () => void;
  prev: () => void;
  playAt: (index: number) => void;
  playTrack: (id: string) => void;
  playNow: (id: string | string[]) => void;
  trackCache: Record<string, SpotifyTrack | undefined>;
  reorderQueue: (nextIds: string[]) => void;
  removeFromQueue: (id: string) => void;
  
  // Playback control
  playbackUrl?: string;
  playing: boolean;
  duration: number;
  position: number;
  codec?: string;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  
  // Volume control
  volume: number;
  muted: boolean;
  setVolume: (volume: number) => void;
  setMute: (muted: boolean) => void;
  toggleMute: () => void;
  
  // Cache status
  cacheStatus: {
    isCaching: boolean;
    cacheProgress?: number;
    cachedSize?: number;
    totalSize?: number;
  };
}

const PlaybackContext = createContext<PlaybackContextValue | undefined>(undefined);

// Selector-based subscription system for performance
type PlaybackStateSnapshot = {
  currentTrack?: SpotifyTrack;
  loading: boolean;
  error?: string;
  trackId: string;
  queueIds: string[];
  currentIndex: number;
  trackCache: Record<string, SpotifyTrack | undefined>;
  playbackUrl?: string;
  playing: boolean;
  duration: number;
  position: number;
  codec?: string;
  sampleRate?: number;
  bitsPerSample?: number;
  cacheStatus: PlaybackState['cacheStatus'];
  isTransitioning: boolean;
  awaitingBackendConfirmation: boolean;
};

let playbackSnapshot: PlaybackStateSnapshot | null = null;
let subscriberId = 0;
const playbackSubscribers = new Map<number, { 
  selector: (s: PlaybackStateSnapshot) => any; 
  last: any; 
  cb: (v: any) => void 
}>();

function notifyPlaybackSubscribers(snapshot: PlaybackStateSnapshot) {
  playbackSubscribers.forEach((entry) => {
    try {
      const next = entry.selector(snapshot);
      if (!Object.is(next, entry.last)) {
        entry.last = next;
        entry.cb(next);
      }
    } catch (err) {
      console.warn('[playback] subscriber error', err);
    }
  });
}

export function subscribePlaybackSelector<T>(
  selector: (s: PlaybackStateSnapshot) => T, 
  cb: (v: T) => void
) {
  const id = ++subscriberId;
  const initial = playbackSnapshot ? selector(playbackSnapshot) : undefined;
  playbackSubscribers.set(id, { selector: selector as any, last: initial, cb: cb as any });
  return () => playbackSubscribers.delete(id);
}

export function usePlaybackSelector<T>(
  selector: (s: PlaybackStateSnapshot) => T, 
  deps: any[] = []
): T | undefined {
  const [val, setVal] = useState<T | undefined>(() => 
    playbackSnapshot ? selector(playbackSnapshot) : undefined
  );
  
  useEffect(() => {
    let mounted = true;
    const unsub = subscribePlaybackSelector(selector, (v: T) => {
      if (mounted) setVal(v);
    });
    
    if (playbackSnapshot) {
      const cur = selector(playbackSnapshot);
      if (!Object.is(cur, val)) setVal(cur);
    }
    
    return () => { mounted = false; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  
  return val;
}

// Optimized cache status hook
export function useCacheStatus() {
  return usePlaybackSelector(state => state.cacheStatus, []);
}

// Hook to check if playback is transitioning (for loading indicators)
export function usePlaybackTransition() {
  return usePlaybackSelector(state => ({
    isTransitioning: state.isTransitioning,
    awaitingBackend: state.awaitingBackendConfirmation,
    loading: state.loading
  }), []);
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(playbackReducer, initialState);
  const { getApiCache, setApiCache, addPlay, ready, getSetting, setSetting } = useDB();
  
  // Refs for performance optimization
  const seekDebounceRef = React.useRef<any>(null);
  const lastSeekSentRef = React.useRef<number>(0);
  const pendingSeekRef = React.useRef<number | null>(null);

  // Memoize Spotify client
  const spotifyClient = useMemo(() => {
    return ready ? createCachedSpotifyClient({ getApiCache, setApiCache }) : null;
  }, [ready, getApiCache, setApiCache]);

  // Optimized track fetching with consolidated state management
  const fetchTrack = useCallback(async (id: string) => {
    if (!id) return;
    
    // Prevent concurrent fetches
    if (state.fetchInProgress === id) {
      console.log('[playback] Fetch already in progress for:', id);
      return;
    }
    
    console.log('[playback] Fetching track:', id, 'ready:', ready);
    dispatch({ type: 'SET_FETCH_IN_PROGRESS', trackId: id });
    dispatch({ type: 'SET_LOADING', loading: true });
    dispatch({ type: 'SET_ERROR', error: undefined });
    
    try {
      const w: any = typeof window !== 'undefined' ? window : {};
      let track: SpotifyTrack;
      
      if (w.electron?.spotify?.getTrack) {
        const resp = await w.electron.spotify.getTrack(id);
        if (resp && (resp as any).error) throw new Error((resp as any).error);
        track = resp as any;
      } else if (spotifyClient) {
        track = await spotifyClient.getTrack(id);
      } else {
        throw new Error('No Spotify client available');
      }

      // Load and attach selected source from database if available
      if (ready && getSetting) {
        try {
          const savedSource = await getSetting(`source:selected:${id}`);
          console.log('[playback] Loaded source for track:', id, savedSource ? 'found' : 'not found');
          
          if (savedSource && savedSource.trim()) {
            const parsedSource = JSON.parse(savedSource);
            
            // Determine the correct value based on source type
            let sourceValue: string = '';
            if (parsedSource.type === 'youtube') {
              sourceValue = parsedSource.id || parsedSource.value || '';
            } else if (parsedSource.type === 'torrent') {
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
                  title: parsedSource.title,
                  fileIndex: parsedSource.fileIndex
                }
              };
              console.log('[playback] Attached source to track:', id, (track as any).source);

              // Proactively query cache for format metadata (helps UI show codec/rate/bits early)
              try {
                const cacheResult = await runTauriCommand('cache_get_file', {
                  trackId: id,
                  sourceType: (track as any).source.type,
                  sourceHash: (track as any).source.value,
                  fileIndex: (track as any).source?.meta?.fileIndex
                });
                if (cacheResult && cacheResult.cached_path) {
                  const { codec, sampleRate, bitsPerSample } = cacheResult as any;
                  if (typeof codec === 'string') dispatch({ type: 'SET_CODEC', codec });
                  if (typeof sampleRate === 'number') dispatch({ type: 'SET_SAMPLE_RATE', sampleRate });
                  if (typeof bitsPerSample === 'number') dispatch({ type: 'SET_BITS_PER_SAMPLE', bitsPerSample });
                }
              } catch (e) {
                // Non-critical
                console.debug('[playback] Cache prefetch for format failed/ignored:', e);
              }
            }
          }
        } catch (e) {
          console.warn('Failed to load track source:', e);
        }
        dispatch({ type: 'ADD_SOURCE_LOAD_ATTEMPTED', trackId: id });
      } else {
        console.log('[playback] Database not ready, skipping source loading for:', id);
      }
      
      console.log('[playback] Setting currentTrack for:', id, 'hasSource:', !!(track as any).source);
      // Only update currentTrack if this fetch is still for the current trackId
      if (id === state.trackId) {
        dispatch({ type: 'SET_CURRENT_TRACK', track });
      } else {
        console.log('[playback] Skipping currentTrack update - fetch result for old track:', id, 'current:', state.trackId);
      }
      dispatch({ type: 'UPDATE_TRACK_CACHE', trackId: id, track });
    } catch (e: any) {
      console.error('[playback] Track fetch failed:', e);
      dispatch({ type: 'SET_ERROR', error: e?.message || String(e) });
      // Only clear currentTrack if this fetch was for the current trackId
      if (id === state.trackId) {
        dispatch({ type: 'SET_CURRENT_TRACK', track: undefined });
      } else {
        console.log('[playback] Skipping currentTrack clear - fetch error for old track:', id, 'current:', state.trackId);
      }
    } finally { 
      console.log('[playback] Track fetch completed for:', id);
      dispatch({ type: 'SET_FETCH_IN_PROGRESS', trackId: null });
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  }, [spotifyClient, ready, getSetting, state.fetchInProgress, state.trackId]);

  // Main track fetch effect - optimized with reduced dependencies
  useEffect(() => { 
    if (!state.trackId) return;
    if (!ready) return;
    
    if (state.fetchInProgress === state.trackId) {
      console.log('[playback] Fetch already in progress for:', state.trackId);
      return;
    }
    
    // Check if we already have this track with source data
    const existingTrack = state.currentTrack?.id === state.trackId ? state.currentTrack : state.trackCache[state.trackId];
    if (existingTrack && (existingTrack as any).source) {
      console.log('[playback] Track with source already available, skipping fetch:', state.trackId);
      return;
    }
    
    if (existingTrack && state.sourceLoadAttempted.has(state.trackId)) {
      console.log('[playback] Already attempted to load source for track, skipping fetch:', state.trackId);
      return;
    }
    
    console.log('[playback] Triggering track fetch for:', state.trackId);
    fetchTrack(state.trackId); 
  }, [state.trackId, fetchTrack, ready]);

  // Clear cache status when track changes
  useEffect(() => {
    dispatch({ type: 'SET_CACHE_STATUS', status: { isCaching: false } });
  }, [state.trackId]);

  // Clear source load attempts when track changes to allow retrying
  useEffect(() => {
    dispatch({ type: 'CLEAR_SOURCE_LOAD_ATTEMPTED' });
  }, [state.trackId]);

  // Start backend playback when playbackUrl set; stop when cleared
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      if (!state.playbackUrl) {
        // Only attempt to stop if something might be playing
        if (state.playing || state.position > 0) {
          try {
            const stopResult = await runTauriCommand('playback_stop');
            if (!stopResult.success) {
              console.warn('[playback] Stop failed:', stopResult.error);
            }
          } catch (e) {
            console.warn('[playback] Stop failed:', e);
          }
        }
        dispatch({ type: 'SET_PLAYING', playing: false });
        dispatch({ type: 'SET_POSITION', position: 0 });
        dispatch({ type: 'SET_DURATION', duration: 0 });
        dispatch({ type: 'SET_CACHE_STATUS', status: { isCaching: false } });
        return;
      }
      
      // Set loading state when starting URL resolution
      if (state.playbackUrl === 'source-based-playback') {
        dispatch({ type: 'SET_LOADING', loading: true });
      }
      
      try {
        console.log('[playback] Starting playback for URL:', state.playbackUrl);

        // Get source information for the current track
        const track = (state.currentTrack?.id === state.trackId ? state.currentTrack : state.trackCache[state.trackId]) || state.currentTrack;
        const sourceMeta = (track as any)?.source;

        console.log('[playback] Source metadata for playback:', { trackId: state.trackId, sourceMeta, hasTrack: !!track, playbackUrl: state.playbackUrl });

        // Use source-based playback system
        let result;
        if (state.trackId && sourceMeta && state.playbackUrl === 'source-based-playback') {
          console.log('[playback] Using source-based playback for track:', state.trackId, 'with source:', sourceMeta);

          // Validate source metadata before starting playback
          if (!sourceMeta.type || !sourceMeta.value) {
            console.error('[playback] Invalid source metadata:', sourceMeta);
            if (!cancelled) {
              dispatch({ type: 'SET_PLAYING', playing: false });
              dispatch({ type: 'SET_ERROR', error: 'Invalid source metadata' });
            }
            return;
          }

          // Use the backend's source resolution and hybrid caching
          result = await startPlaybackWithSource(
            state.trackId,
            sourceMeta.type,
            sourceMeta.value,
            true, // prefer cache
            sourceMeta.meta
          );
          console.log('[playback] Source-based playback call completed (invoke or ack):', result);

          // The audioCache.startPlaybackWithSource now may return either:
          // - a full invoke result { success, data } (immediate playback info), OR
          // - an ack-like payload from the event listener (e.g., { trackId, sourceHash, async: true })
          // - a short timeout placeholder { timeout: true } when no ack was received quickly
          // Normalize these shapes so downstream logic treats ack/timeout as non-fatal
          if (result && typeof result === 'object' && (result.timeout || result.listen_error || result.async)) {
            // Treat as successful spawn of background playback; we'll set loading/awaiting state
            result = { success: true, data: { cache_used: false, streaming_started: true } };
          }
        } else if (state.playbackUrl && state.playbackUrl !== 'source-based-playback') {
          console.log('[playback] Using direct playback with URL:', state.playbackUrl);
          // Only use direct playback for actual URLs, not for placeholder values
          result = await runTauriCommand('playback_start', { url: state.playbackUrl });
        } else {
          console.error('[playback] No valid playback method available:', { trackId: state.trackId, sourceMeta, playbackUrl: state.playbackUrl });
          if (!cancelled) {
            dispatch({ type: 'SET_PLAYING', playing: false });
            dispatch({ type: 'SET_ERROR', error: 'No valid playback method available' });
          }
          return;
        }

        console.log('[playback] Start result:', result);

        // Handle the response from the hybrid system
        if (result.success && result.data) {
          console.log('[playback] Playback started successfully:', result.data);
          
          // The backend will return duration and other info
          if (typeof result.data.duration === 'number') {
            console.log('[playback] Setting duration from backend:', result.data.duration);
            dispatch({ type: 'SET_DURATION', duration: result.data.duration });
          }

          // Check if cache was used immediately
          if (result.data.cache_used === true) {
            console.log('[playback] Started playback using cached file immediately');
            dispatch({ type: 'SET_CACHE_STATUS', status: { isCaching: false } });
          } else if (result.data.streaming_started === true) {
            console.log('[playback] Started streaming playback, caching in background');
            dispatch({ type: 'SET_CACHE_STATUS', status: { isCaching: true } });
          }
          
          if (!cancelled) {
            dispatch({ type: 'SET_PLAYING', playing: true });
          }
        } else {
          console.error('[playback] Playback start failed:', result);
          if (!cancelled) {
            dispatch({ type: 'SET_PLAYING', playing: false });
            dispatch({ type: 'SET_ERROR', error: result.error || 'Unknown playback error' });
          }
        }
      } catch (error) {
        console.error('[playback] Failed to start:', error);
        if (error.message?.includes('invoke not available')) {
          dispatch({ type: 'SET_ERROR', error: 'Audio playback requires the desktop app. Please open the Tauri application window instead of the browser.' });
        } else {
          dispatch({ type: 'SET_ERROR', error: `Playback failed: ${error}` });
        }
        if (!cancelled) {
          dispatch({ type: 'SET_PLAYING', playing: false });
        }
      } finally {
        // Clear loading state after URL resolution completes
        if (state.playbackUrl === 'source-based-playback') {
          dispatch({ type: 'SET_LOADING', loading: false });
        }
      }
    };
    start();
    return () => { cancelled = true; };
  }, [state.playbackUrl]);

  // When track changes, prepare source metadata for playback
  useEffect(() => {
    if (!state.trackId) {
      dispatch({ type: 'SET_PLAYBACK_URL', url: undefined });
      return;
    }

    // Prioritize currentTrack if it matches the trackId, as it's more likely to have fresh source data
    const track = (state.currentTrack?.id === state.trackId ? state.currentTrack : state.trackCache[state.trackId]) || state.currentTrack;
    if (!track) {
      console.log('[playback] No track found for ID:', state.trackId);
      dispatch({ type: 'SET_PLAYBACK_URL', url: undefined });
      return;
    }

    const sourceMeta = (track as any).source;

    if (sourceMeta) {
      console.log('[playback] Source metadata available, ready for source-based playback');
      
      // Check if we're transitioning to this track and waiting for source
      if (state.isTransitioning && state.transitioningToTrackId === state.trackId && state.awaitingBackendConfirmation) {
        console.log('[playback] Track became ready during transition, continuing synchronous switch');
        // Trigger the completion of synchronous switch - we'll handle this in a separate effect
        dispatch({ type: 'SET_SHOULD_FORCE_PLAY', shouldPlay: true });
        return;
      }
      
      // Don't auto-start if we already have an active playback URL - prevents double-starting
      if (state.playbackUrl === 'source-based-playback' && !state.shouldForcePlay) {
        console.log('[playback] Source-based playback already active, skipping auto-start');
        return;
      }
      
      // Start playback automatically if:
      // 1. We were already playing something, OR
      // 2. This is a user-initiated track change (shouldForcePlay flag), OR
      // 3. We're transitioning and user wants to play
      if (state.playing || state.playbackUrl || state.shouldForcePlay || 
          (state.isTransitioning && state.transitioningToTrackId === state.trackId)) {
        dispatch({ type: 'SET_PLAYBACK_URL', url: 'source-based-playback' });
        if (state.shouldForcePlay) {
          dispatch({ type: 'SET_SHOULD_FORCE_PLAY', shouldPlay: false });
          console.log('[playback] Force-starting playback due to user action');
        } else if (state.isTransitioning && state.transitioningToTrackId === state.trackId) {
          console.log('[playback] Auto-starting playback due to ongoing transition');
        }
      } else {
        console.log('[playback] Track ready but not auto-starting (no active playback)');
      }
    } else {
      console.log('[playback] No source meta found - track has no selected source for:', state.trackId);
      dispatch({ type: 'SET_PLAYBACK_URL', url: undefined });
      
      // Only clear transition state if this wasn't a user-initiated play action
      // If shouldForcePlay is true, we should wait for the source to load
      if (state.isTransitioning && state.transitioningToTrackId === state.trackId && !state.shouldForcePlay) {
        console.log('[playback] Clearing transition state - no source available and not user-initiated');
        dispatch({ type: 'SET_TRANSITIONING', isTransitioning: false });
        dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
        dispatch({ type: 'SET_LOADING', loading: false });
      } else if (state.shouldForcePlay) {
        console.log('[playback] No source yet but user wants to play - keeping transition state and waiting');
      }
    }
  }, [state.trackId, state.currentTrack, state.isTransitioning, state.transitioningToTrackId, state.awaitingBackendConfirmation, state.shouldForcePlay, state.playing, state.playbackUrl]);

  // Optimized control helpers with dispatch pattern
  const play = useCallback(async () => { 
    console.log('[playback] Play button clicked, playbackUrl:', state.playbackUrl);
    
    // If no playback URL but we have a ready track, set it up for source-based playback
    if (!state.playbackUrl) {
      const track = (state.currentTrack?.id === state.trackId ? state.currentTrack : state.trackCache[state.trackId]) || state.currentTrack;
      const sourceMeta = (track as any)?.source;
      
      if (state.trackId && sourceMeta) {
        console.log('[playback] Setting up source-based playback for ready track');
        dispatch({ type: 'SET_PLAYBACK_URL', url: 'source-based-playback' });
        return;
      } else {
        console.log('[playback] No playback URL available and no ready track, cannot play');
        return; 
      }
    }
    
    try {
      console.log('[playback] Resuming playback');
      const result = await runTauriCommand('playback_resume');
      console.log('[playback] Resume result:', result);
      if (!result.success) {
        console.error('[playback] Resume failed:', result.error);
        dispatch({ type: 'SET_PLAYING', playing: false });
      }
    } catch (error) {
      console.error('[playback] Resume failed:', error);
      dispatch({ type: 'SET_PLAYING', playing: false });
    }
  }, [state.playbackUrl, state.trackId, state.currentTrack, state.trackCache]);
  
  const pause = useCallback(async () => { 
    try {
      console.log('[playback] Pausing playback');
      const result = await runTauriCommand('playback_pause');
      if (!result.success) {
        console.error('[playback] Pause failed:', result.error);
      }
    } catch (error) {
      console.error('[playback] Pause failed:', error);
    }
  }, []);
  
  const toggle = useCallback(() => { 
    if (state.playing) pause(); 
    else play(); 
  }, [state.playing, play, pause]);
  
  const seek = useCallback((time: number) => {
    if (!state.playbackUrl) return;
    console.log('[playback] Seeking to:', time);
    
    const originalPosition = state.position;
    dispatch({ type: 'SET_POSITION', position: time }); // optimistic UI update
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
          } else if (reason === 'streaming_limitation' || reason === 'invalid_position') {
            console.warn('[playback] Seek not supported or invalid position, rolling back');
            dispatch({ type: 'SET_POSITION', position: originalPosition });
          } else {
            console.warn('[playback] General seek error, rolling back');
            dispatch({ type: 'SET_POSITION', position: originalPosition });
          }
        } else {
          const seekPosition = result.data?.position || val;
          console.log('[playback] Seek successful to:', seekPosition);
        }
        
        lastSeekSentRef.current = Date.now();
        pendingSeekRef.current = null;
      } catch (error) {
        console.warn('[playback] Seek failed:', error);
        dispatch({ type: 'SET_POSITION', position: originalPosition });
      }
    };
    
    // If enough time passed since last send, send immediately
    if (now - lastSeekSentRef.current > CONFIG.SEEK.MIN_INTERVAL_MS) {
      if (seekDebounceRef.current) { 
        clearTimeout(seekDebounceRef.current); 
        seekDebounceRef.current = null; 
      }
      send();
      return;
    }
    
    // Otherwise debounce
    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current);
    seekDebounceRef.current = setTimeout(() => {
      send();
      seekDebounceRef.current = null;
    }, CONFIG.SEEK.DEBOUNCE_MS);
  }, [state.playbackUrl, state.position]);

  // Synchronous track switching implementation following the required steps
  const switchToTrackSynchronously = useCallback(async (newTrackId: string) => {
    console.log('[playback] Starting synchronous track switch to:', newTrackId);
    
    // Step 1: Stop current track from playing (if any)
    console.log('[playback] Step 1: Stopping current track');
    dispatch({ type: 'SET_TRANSITIONING', isTransitioning: true, trackId: newTrackId });
    
    if (state.playing || state.playbackUrl) {
      try {
        const stopResult = await runTauriCommand('playback_stop');
        if (!stopResult.success) {
          console.warn('[playback] Stop failed:', stopResult.error);
        }
      } catch (e) {
        console.warn('[playback] Stop failed:', e);
      }
      
      // Clear playback state
      dispatch({ type: 'SET_PLAYING', playing: false });
      dispatch({ type: 'SET_PLAYBACK_URL', url: undefined });
      dispatch({ type: 'SET_POSITION', position: 0 });
      dispatch({ type: 'SET_DURATION', duration: 0 });
    }
    
    // Step 2: Check if the new current track has a "selected source"
    console.log('[playback] Step 2: Checking selected source for track:', newTrackId);
    const track = state.trackCache[newTrackId];
    const sourceMeta = (track as any)?.source;
    
    // Step 2.1: Check if there is a source selected for the track
    if (!sourceMeta || !sourceMeta.type || !sourceMeta.value) {
      console.log('[playback] Step 2.1: No source selected, showing loading status');
      dispatch({ type: 'SET_LOADING', loading: true });
      dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: true });
      dispatch({ type: 'SET_SHOULD_FORCE_PLAY', shouldPlay: true }); // Mark as user-initiated
      
      // Track will be switched but we'll wait for source to be available
      // The fetchTrack effect will handle loading the source
      return;
    }
    
    console.log('[playback] Step 2.1: Source found:', sourceMeta);
    
    // Step 2.2: Check if there is cache for the selected source
    console.log('[playback] Step 2.2: Checking cache for selected source');
    let hasCachedFile = false;
    try {
      const cacheResult = await runTauriCommand('cache_get_file', {
        trackId: newTrackId,
        sourceType: sourceMeta.type,
        sourceHash: sourceMeta.value,
        fileIndex: sourceMeta?.meta?.fileIndex
      });
      hasCachedFile = !!(cacheResult && cacheResult.cached_path);
      // If cached and format metadata is available, surface it immediately to the UI
      if (hasCachedFile) {
        const { codec, sampleRate, bitsPerSample } = cacheResult as any;
        if (typeof codec === 'string') dispatch({ type: 'SET_CODEC', codec });
        if (typeof sampleRate === 'number') dispatch({ type: 'SET_SAMPLE_RATE', sampleRate });
        if (typeof bitsPerSample === 'number') dispatch({ type: 'SET_BITS_PER_SAMPLE', bitsPerSample });
      }
      console.log('[playback] Cache check result:', { hasCachedFile, cacheResult });
    } catch (e) {
      console.warn('[playback] Cache check failed:', e);
    }
    
    // Step 2.3: If there is no source or no cache, show "loading" status for the player
    if (!hasCachedFile) {
      console.log('[playback] Step 2.3: No cache available, showing loading status');
      dispatch({ type: 'SET_LOADING', loading: true });
      dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: true });
    }
    
    // Step 3: Start backend audio playback and wait for confirmation
    console.log('[playback] Step 3: Starting backend audio playback');
    try {
        let result = await startPlaybackWithSource(
          newTrackId,
          sourceMeta.type,
          sourceMeta.value,
          true, // prefer cache
          sourceMeta.meta
        );
        
        console.log('[playback] Backend playback start result (invoke or ack):', result);
        if (result && typeof result === 'object' && (result.timeout || result.listen_error || result.async)) {
          // Normalize quick ack into a friendly success shape
          // so the UI doesn't treat the short-race outcome as an error
          (result as any) = { success: true, data: { cache_used: false, streaming_started: true } };
        }
      
      if (result.success && result.data) {
        // Step 4: Wait for backend audio playback to start before removing loading status
        console.log('[playback] Step 4: Backend confirmed playback start');
        
        // Set duration if provided
        if (typeof result.data.duration === 'number') {
          dispatch({ type: 'SET_DURATION', duration: result.data.duration });
        }
        
        // Update cache status
        if (result.data.cache_used === true) {
          console.log('[playback] Playback started using cached file');
          dispatch({ type: 'SET_CACHE_STATUS', status: { isCaching: false } });
        } else if (result.data.streaming_started === true) {
          console.log('[playback] Playback started streaming, caching in background');
          dispatch({ type: 'SET_CACHE_STATUS', status: { isCaching: true } });
        }
        
        // Clear loading status
        dispatch({ type: 'SET_LOADING', loading: false });
        dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
        dispatch({ type: 'SET_PLAYING', playing: true });
        dispatch({ type: 'SET_PLAYBACK_URL', url: 'source-based-playback' });
        
        console.log('[playback] Track switch completed successfully');
      } else {
        console.error('[playback] Backend playback start failed:', result);
        dispatch({ type: 'SET_ERROR', error: result.error || 'Playback start failed' });
        dispatch({ type: 'SET_LOADING', loading: false });
        dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
      }
    } catch (error) {
      console.error('[playback] Failed to start backend playback:', error);
      dispatch({ type: 'SET_ERROR', error: `Playback failed: ${error}` });
      dispatch({ type: 'SET_LOADING', loading: false });
      dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
    } finally {
      dispatch({ type: 'SET_TRANSITIONING', isTransitioning: false });
    }
  }, [state.playing, state.playbackUrl, state.trackCache]);

  // Effect to continue synchronous switching when track becomes ready during transition
  useEffect(() => {
    if (state.isTransitioning && 
        state.transitioningToTrackId === state.trackId && 
        state.awaitingBackendConfirmation &&
        state.shouldForcePlay) {
      
      const track = state.trackCache[state.trackId];
      const sourceMeta = (track as any)?.source;
      
      if (sourceMeta) {
        console.log('[playback] Continuing synchronous switch for ready track:', state.trackId);
        
        // Continue from step 2.2 (cache check) since we now have the source
        const continueSync = async () => {
          console.log('[playback] Step 2.2: Checking cache for selected source');
          
          try {
            // Check cache
            let hasCachedFile = false;
            try {
              const cacheResult = await runTauriCommand('cache_get_file', {
                trackId: state.trackId,
                sourceType: sourceMeta.type,
                sourceHash: sourceMeta.value,
                fileIndex: sourceMeta?.meta?.fileIndex
              });
              hasCachedFile = !!(cacheResult && cacheResult.cached_path);
              // If cached and format metadata is available, surface it immediately to the UI
              if (hasCachedFile) {
                const { codec, sampleRate, bitsPerSample } = cacheResult as any;
                if (typeof codec === 'string') dispatch({ type: 'SET_CODEC', codec });
                if (typeof sampleRate === 'number') dispatch({ type: 'SET_SAMPLE_RATE', sampleRate });
                if (typeof bitsPerSample === 'number') dispatch({ type: 'SET_BITS_PER_SAMPLE', bitsPerSample });
              }
              console.log('[playback] Cache check result:', { hasCachedFile, cacheResult });
            } catch (e) {
              console.warn('[playback] Cache check failed:', e);
            }
            
            if (!hasCachedFile) {
              console.log('[playback] Step 2.3: No cache available, showing loading status');
              dispatch({ type: 'SET_LOADING', loading: true });
              dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: true });
            }
            
            console.log('[playback] Step 3: Starting backend audio playback');
            let result = await startPlaybackWithSource(
              state.trackId,
              sourceMeta.type,
              sourceMeta.value,
              true, // prefer cache
              sourceMeta.meta
            );
            
            console.log('[playback] Backend playback start result (invoke or ack):', result);
            if (result && typeof result === 'object' && (result.timeout || result.listen_error || result.async)) {
              (result as any) = { success: true, data: { cache_used: false, streaming_started: true } };
            }

            if (result.success) {
              console.log('[playback] Step 4: Backend confirmed playback start');
              // Set playback URL to indicate active playback (only if not already set)
              if (state.playbackUrl !== 'source-based-playback') {
                dispatch({ type: 'SET_PLAYBACK_URL', url: 'source-based-playback' });
              }
              dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
              dispatch({ type: 'SET_TRANSITIONING', isTransitioning: false });
              dispatch({ type: 'SET_SHOULD_FORCE_PLAY', shouldPlay: false });
              console.log('[playback] Track switch completed successfully');
            } else {
              console.error('[playback] Backend playback failed:', result);
              dispatch({ type: 'SET_ERROR', error: 'Playback failed' });
              dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
              dispatch({ type: 'SET_TRANSITIONING', isTransitioning: false });
              dispatch({ type: 'SET_SHOULD_FORCE_PLAY', shouldPlay: false });
            }
          } catch (error) {
            console.error('[playback] Error during synchronous switch continuation:', error);
            dispatch({ type: 'SET_ERROR', error: 'Synchronous switch failed' });
            dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
            dispatch({ type: 'SET_TRANSITIONING', isTransitioning: false });
            dispatch({ type: 'SET_SHOULD_FORCE_PLAY', shouldPlay: false });
          }
        };
        
        continueSync();
      }
    }
  }, [state.isTransitioning, state.transitioningToTrackId, state.trackId, state.awaitingBackendConfirmation, 
      state.shouldForcePlay, state.trackCache, switchToTrackSynchronously]);

  // Safety timeout to clear stuck transitions
  useEffect(() => {
    if (state.isTransitioning) {
      const timeout = setTimeout(() => {
        console.warn('[playback] Transition timeout - clearing stuck transition state');
        dispatch({ type: 'SET_TRANSITIONING', isTransitioning: false });
        dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
        dispatch({ type: 'SET_LOADING', loading: false });
        // Don't clear shouldForcePlay - preserve user intent for when source becomes available
        console.log('[playback] Preserving shouldForcePlay flag for delayed source loading');
      }, 10000); // 10 second timeout
      
      return () => clearTimeout(timeout);
    }
  }, [state.isTransitioning]);

  // Volume control methods - optimized with dispatch
  const setVolume = useCallback(async (newVolume: number) => {
    const clampedVolume = Math.max(0, Math.min(1, newVolume));
    dispatch({ type: 'SET_VOLUME', volume: clampedVolume });
    
    try {
      const result = await runTauriCommand('playback_set_volume', { volume: clampedVolume });
      if (result?.success && result.data) {
        dispatch({ type: 'SET_VOLUME', volume: result.data.volume || clampedVolume, muted: result.data.muted || false });
      }
      
      // Save to database
      if (ready) {
        try {
          await setSetting(SETTINGS_KEYS.VOLUME, clampedVolume.toString());
        } catch (e) {
          console.warn('Failed to save volume setting:', e);
        }
      }
    } catch (e) {
      console.warn('Failed to set volume:', e);
    }
  }, [ready, setSetting]);

  const setMute = useCallback(async (shouldMute: boolean) => {
    try {
      const result = await runTauriCommand('playback_set_mute', { muted: shouldMute });
      if (result?.success && result.data) {
        dispatch({ type: 'SET_VOLUME', volume: result.data.volume || state.volume, muted: result.data.muted || false });
      }
      
      // Save to database
      if (ready) {
        try {
          await setSetting(SETTINGS_KEYS.MUTED, shouldMute.toString());
        } catch (e) {
          console.warn('Failed to save mute setting:', e);
        }
      }
    } catch (e) {
      console.warn('Failed to set mute:', e);
    }
  }, [state.volume, ready, setSetting]);

  const toggleMute = useCallback(async () => {
    try {
      const result = await runTauriCommand('playback_toggle_mute');
      if (result?.success && result.data) {
        dispatch({ type: 'SET_VOLUME', volume: result.data.volume || state.volume, muted: result.data.muted || false });
      }
      
      // Save to database
      if (ready && result?.success && result.data) {
        try {
          await setSetting(SETTINGS_KEYS.MUTED, (result.data.muted || false).toString());
        } catch (e) {
          console.warn('Failed to save mute setting:', e);
        }
      }
    } catch (e) {
      console.warn('Failed to toggle mute:', e);
    }
  }, [state.volume, ready, setSetting]);

  // Optimize play history recording
  useEffect(() => {
    if (!state.trackId || !ready) return;
    
    const recordPlay = async () => {
      try {
        await addPlay(state.trackId, Date.now());
      } catch (e) {
        console.warn('Failed to record play:', e);
      }
    };
    
    recordPlay();
  }, [state.trackId, addPlay, ready]);

  // Initialize volume from database and backend
  useEffect(() => {
    const initVolume = async () => {
      try {
        // First try to load from database
        let savedVolume: number = CONFIG.VOLUME.DEFAULT;
        let savedMuted = false;
        let hasSavedSettings = false;

        if (ready) {
          try {
            const volumeStr = await getSetting(SETTINGS_KEYS.VOLUME);
            const mutedStr = await getSetting(SETTINGS_KEYS.MUTED);
            
            if (volumeStr) {
              const parsed = parseFloat(volumeStr);
              if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
                savedVolume = parsed;
                hasSavedSettings = true;
              }
            }
            
            if (mutedStr) {
              savedMuted = mutedStr === 'true';
              hasSavedSettings = true;
            }
          } catch (e) {
            console.warn('Failed to load saved volume settings:', e);
          }
        }

        // Get current backend volume
        const result = await runTauriCommand('playback_get_volume');
        
        let finalVolume = savedVolume;
        let finalMuted = savedMuted;
        
        if (result?.success && result.data) {
          // Only use backend values if we don't have saved settings
          if (!hasSavedSettings) {
            finalVolume = result.data.volume || CONFIG.VOLUME.DEFAULT;
            finalMuted = result.data.muted || false;
          }
          
          // Update state with final values
          dispatch({ type: 'SET_VOLUME', volume: finalVolume, muted: finalMuted });
          
          // Sync backend with our final values if they differ
          if (result.data.volume !== finalVolume) {
            await runTauriCommand('playback_set_volume', { volume: finalVolume });
          }
          if (result.data.muted !== finalMuted) {
            await runTauriCommand('playback_set_mute', { muted: finalMuted });
          }
        } else {
          // Backend failed, use our saved/default values
          dispatch({ type: 'SET_VOLUME', volume: finalVolume, muted: finalMuted });
        }
      } catch (e) {
        console.warn('Failed to get initial volume:', e);
      }
    };
    
    initVolume();
  }, [ready, getSetting]);

  // Optimize queue index synchronization
  useEffect(() => {
    const idx = state.queueIds.indexOf(state.trackId);
    if (idx !== -1 && idx !== state.currentIndex) {
      dispatch({ type: 'SET_CURRENT_INDEX', index: idx });
    }
  }, [state.trackId, state.queueIds, state.currentIndex]);

  // Optimize queue trimming - simplified
  useEffect(() => {
    if (state.currentIndex > CONFIG.QUEUE.DEFAULT_INDEX) {
      const trimmed = state.queueIds.slice(state.currentIndex);
      dispatch({ type: 'SET_QUEUE', queueIds: trimmed, currentIndex: CONFIG.QUEUE.DEFAULT_INDEX });
    }
  }, [state.currentIndex, state.queueIds]);

  // Optimize track prefetching with better batching
  useEffect(() => {
    let cancelled = false;
    
    const prefetchTracks = async () => {
      for (const id of state.queueIds.slice(0, CONFIG.QUEUE.PREFETCH_SIZE)) {
        if (cancelled) return;
        
        // Prefetch track metadata
        if (!state.trackCache[id] && spotifyClient) {
          try {
            const track = await spotifyClient.getTrack(id);
            if (!cancelled) {
              dispatch({ type: 'UPDATE_TRACK_CACHE', trackId: id, track });
            }
          } catch {
            // Ignore prefetch errors
          }
        }
      }
    };
    
    prefetchTracks();
    return () => { cancelled = true; };
  }, [state.queueIds, state.trackCache, spotifyClient]);

  // Optimize queue management functions with dispatch pattern
  const setQueue = useCallback((ids: string[], startIndex: number = CONFIG.QUEUE.DEFAULT_INDEX, shouldPlay: boolean = false) => {
    console.log('[playback] setQueue called:', { ids, startIndex, currentTrackId: state.trackId, shouldPlay });
    
    if (ids.length) {
      const safeIndex = queueUtils.safeIndex(startIndex, ids.length);
      console.log('[playback] Setting current index to:', safeIndex, 'track:', ids[safeIndex]);
      
      dispatch({ type: 'SET_QUEUE', queueIds: ids, currentIndex: safeIndex });
      dispatch({ type: 'SET_TRACK_ID', trackId: ids[safeIndex] });
      
      if (shouldPlay) {
        dispatch({ type: 'SET_SHOULD_FORCE_PLAY', shouldPlay: true });
      }
    }
  }, [state.trackId]);

  const enqueue = useCallback((ids: string | string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    dispatch({ type: 'SET_QUEUE', queueIds: [...state.queueIds, ...arr], currentIndex: state.currentIndex });
  }, [state.queueIds, state.currentIndex]);

  const playAt = useCallback((index: number) => {
    if (index < 0 || index >= state.queueIds.length) return;
    
    // Use immediate UI update event for queue position changes
    const detail = { queueIds: state.queueIds, currentIndex: index, shouldPlay: true };
    window.dispatchEvent(new CustomEvent(EVENTS.QUEUE_POSITION_CHANGED, { detail }));
  }, [state.queueIds]);

  const playTrack = useCallback((id: string) => {
    const idx = state.queueIds.indexOf(id);
    if (idx === -1) {
      // Track not in queue, add it and play
      const newQueue = [...state.queueIds, id];
      const detail = { 
        queueIds: newQueue, 
        currentIndex: newQueue.length - 1, 
        shouldPlay: true 
      };
      window.dispatchEvent(new CustomEvent(EVENTS.QUEUE_POSITION_CHANGED, { detail }));
    } else {
      // Track already in queue, just play it at its current position
      const detail = { 
        queueIds: state.queueIds, 
        currentIndex: idx, 
        shouldPlay: true 
      };
      window.dispatchEvent(new CustomEvent(EVENTS.QUEUE_POSITION_CHANGED, { detail }));
    }
  }, [state.queueIds]);
  
  const playNow = useCallback((ids: string | string[]) => {
    const idsArr = eventUtils.extractIds({ ids });
    if (!idsArr.length) return;
    
    const newQueue = queueUtils.prependToQueue(idsArr, state.queueIds);
    
    // Use the new event system to trigger immediate UI update and playback
    const detail = { 
      queueIds: newQueue, 
      currentIndex: CONFIG.QUEUE.DEFAULT_INDEX, 
      shouldPlay: true 
    };
    window.dispatchEvent(new CustomEvent(EVENTS.QUEUE_POSITION_CHANGED, { detail }));
  }, [state.queueIds]);

  const next = useCallback(() => {
    if (!state.queueIds.length) return;
    const nextIndex = queueUtils.nextIndex(state.currentIndex, state.queueIds.length);
    playAt(nextIndex);
  }, [state.queueIds.length, state.currentIndex, playAt]);

  const prev = useCallback(() => {
    if (!state.queueIds.length) return;
    const prevIndex = queueUtils.prevIndex(state.currentIndex, state.queueIds.length);
    playAt(prevIndex);
  }, [state.queueIds.length, state.currentIndex, playAt]);

  // Listen for playback status events (replaces polling)
  useEffect(() => {
    let mounted = true;

    const handlePlaybackStatus = async (event: any) => {
      if (!mounted) return;

      try {
        const result = event.payload || event;
        const status = result?.data || result;

        if (!status) return;

        // During transitions, we still want to surface format info immediately,
        // but avoid fragile state changes like playing/position when awaiting ack.
        const inTransition = state.isTransitioning;

        // Update UI state based on actual backend state
        const wasPlaying = state.playing;
        const isPlaying = !!status.playing;

        // Only update playing state if not awaiting backend confirmation and not during a seek
        if (!state.awaitingBackendConfirmation && pendingSeekRef.current === null && !inTransition) {
          dispatch({ type: 'SET_PLAYING', playing: isPlaying });
        }

        // Update position and duration from backend (but not during transitions or pending seeks)
        if (typeof status.position === 'number' && !state.awaitingBackendConfirmation && pendingSeekRef.current === null && !inTransition) {
          dispatch({ type: 'SET_POSITION', position: status.position });
        }
        if (typeof status.duration === 'number') {
          dispatch({ type: 'SET_DURATION', duration: status.duration });
        }
        // Always accept format fields (codec/sampleRate/bits) even in transition
        if (typeof status.codec === 'string') {
          dispatch({ type: 'SET_CODEC', codec: status.codec });
        }
        if (typeof status.sampleRate === 'number') {
          dispatch({ type: 'SET_SAMPLE_RATE', sampleRate: status.sampleRate });
        }
        if (typeof status.bitsPerSample === 'number') {
          dispatch({ type: 'SET_BITS_PER_SAMPLE', bitsPerSample: status.bitsPerSample });
        }

        // If we were awaiting backend confirmation and now we have playing status, clear the flag
        // But don't treat seek responses as playback confirmation
        if (state.awaitingBackendConfirmation && isPlaying && pendingSeekRef.current === null) {
          console.log('[playback] Backend confirmed playback, clearing awaiting flag');
          dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
          dispatch({ type: 'SET_LOADING', loading: false });
        }

        // Update cache status if provided by backend
        if (status.cache_status) {
          dispatch({ type: 'SET_CACHE_STATUS', status: {
            isCaching: status.cache_status.is_caching || false,
            cacheProgress: status.cache_status.progress,
            cachedSize: status.cache_status.cached_bytes,
            totalSize: status.cache_status.total_bytes
          }});
        } else if (status.cache_used === true) {
          // If cache was used but no detailed status, mark as not caching
          dispatch({ type: 'SET_CACHE_STATUS', status: { isCaching: false } });
        }

        // Handle errors from backend
        if (status.error) {
          // Don't treat seek errors as critical playback errors
          if (status.error.includes('BASS_ERROR_NOTAVAIL')) {
            // This is likely a seek error, don't stop playback or show persistent error
            console.debug('[playback] Backend seek error (not critical):', status.error);
          } else {
            console.warn('[playback] Backend error:', status.error);
            dispatch({ type: 'SET_ERROR', error: status.error });
            dispatch({ type: 'SET_PLAYING', playing: false });
            // Clear transition flags on error
            dispatch({ type: 'SET_TRANSITIONING', isTransitioning: false });
            dispatch({ type: 'SET_AWAITING_BACKEND', awaiting: false });
          }
        } else {
          // Clear error if playback is working
          if (isPlaying && state.error) {
            dispatch({ type: 'SET_ERROR', error: undefined });
          }
        }

        // Auto advance queue when track ends (do not depend on prior playing/url flags)
        if (status.ended && !state.isTransitioning && !state.awaitingBackendConfirmation) {
          console.log('[playback] Track ended, advancing to next');
          next();
        }

        // Debug logging when state changes
        if (wasPlaying !== isPlaying) {
          console.log('[playback] State changed:', { wasPlaying, isPlaying, url: status.url });
        }

      } catch (error) {
        console.warn('[playback] Status event error:', error);
      }
    };

    // Set up event listener
    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen('playback:status', handlePlaybackStatus);

        // Cleanup function
        return () => {
          try { unlisten(); } catch {}
        };
      } catch (e) {
        // Tauri not available in browser preview
        if (process.env.NODE_ENV !== 'production') {
          console.debug('[playback] Event API unavailable, status events disabled');
        }
        return () => {};
      }
    };

    let cleanup: (() => void) | undefined;
    setupListener().then((c) => { cleanup = c; });

    return () => {
      mounted = false;
      if (cleanup) cleanup();
    };
  }, [state.playing, state.playbackUrl, state.error, state.isTransitioning, state.awaitingBackendConfirmation, next]);

  // Cleanup debounce timer on unmount
  useEffect(() => () => { 
    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current); 
  }, []);

  const reorderQueue = useCallback((nextIds: string[]) => {
    if (!nextIds.length) return;
    const currentId = state.trackId;
    const newIndex = nextIds.indexOf(currentId || '');
    dispatch({ type: 'SET_QUEUE', queueIds: nextIds, currentIndex: newIndex !== -1 ? newIndex : state.currentIndex });
  }, [state.trackId, state.currentIndex]);

  const removeFromQueue = useCallback((id: string) => {
    if (!id) return;
    
    const idx = state.queueIds.indexOf(id);
    if (idx === -1) return;
    
    const next = state.queueIds.filter(t => t !== id);
    if (!next.length) {
      dispatch({ type: 'SET_QUEUE', queueIds: [], currentIndex: CONFIG.QUEUE.DEFAULT_INDEX });
      dispatch({ type: 'SET_TRACK_ID', trackId: '' });
      dispatch({ type: 'SET_CURRENT_TRACK', track: undefined });
      return;
    }
    
    if (state.trackId === id) {
      const newIndex = idx < next.length ? idx : next.length - 1;
      dispatch({ type: 'SET_QUEUE', queueIds: next, currentIndex: newIndex });
      dispatch({ type: 'SET_TRACK_ID', trackId: next[newIndex] });
    } else {
      const newCurIdx = next.indexOf(state.trackId || '');
      dispatch({ type: 'SET_QUEUE', queueIds: next, currentIndex: newCurIdx !== -1 ? newCurIdx : state.currentIndex });
    }
  }, [state.queueIds, state.trackId, state.currentIndex]);

  // Optimized context value with state destructuring
  const setTrackId = useCallback((id: string) => {
    dispatch({ type: 'SET_TRACK_ID', trackId: id });
  }, []);

  const value: PlaybackContextValue = useMemo(() => ({
    // Basic state
    currentTrack: state.currentTrack,
    loading: state.loading,
    error: state.error,
    trackId: state.trackId,
    setTrackId,
    refresh: () => fetchTrack(state.trackId),
    
    // Queue management
    queueIds: state.queueIds,
    currentIndex: state.currentIndex,
    setQueue,
    enqueue,
    next,
    prev,
    playAt,
    playTrack,
    playNow,
    trackCache: state.trackCache,
    reorderQueue,
    removeFromQueue,
    
    // Playback control
    playbackUrl: state.playbackUrl,
    playing: state.playing,
    duration: state.duration,
    position: state.position,
    codec: state.codec,
    sampleRate: state.sampleRate,
    bitsPerSample: state.bitsPerSample,
    play,
    pause,
    toggle,
    seek,
    
    // Volume control
    volume: state.volume,
    muted: state.muted,
    setVolume,
    setMute,
    toggleMute,
    
    // Cache status
    cacheStatus: state.cacheStatus
  }), [
    state.currentTrack, state.loading, state.error, state.trackId, state.queueIds, 
    state.currentIndex, state.trackCache, state.playbackUrl, state.playing, 
    state.duration, state.position, state.codec, state.volume, state.muted, state.cacheStatus,
    setTrackId, fetchTrack, setQueue, enqueue, next, prev, playAt, playTrack, 
    playNow, reorderQueue, removeFromQueue, play, pause, toggle, seek, 
    setVolume, setMute, toggleMute
  ]);

  // Optimize playback snapshot updates with state-based updates
  useEffect(() => {
    const snap: PlaybackStateSnapshot = { 
      currentTrack: state.currentTrack,
      loading: state.loading,
      error: state.error,
      trackId: state.trackId,
      queueIds: state.queueIds,
      currentIndex: state.currentIndex,
      trackCache: state.trackCache,
      playbackUrl: state.playbackUrl,
      playing: state.playing,
      duration: state.duration,
      position: state.position,
      codec: state.codec,
      sampleRate: state.sampleRate,
      bitsPerSample: state.bitsPerSample,
      cacheStatus: state.cacheStatus,
      isTransitioning: state.isTransitioning,
      awaitingBackendConfirmation: state.awaitingBackendConfirmation
    };
    playbackSnapshot = snap;
    notifyPlaybackSubscribers(snap);
  }, [
    state.currentTrack, state.loading, state.error, state.trackId, state.queueIds, 
    state.currentIndex, state.trackCache, state.playbackUrl, state.playing, 
    state.duration, state.position, state.codec, state.sampleRate, state.bitsPerSample, state.cacheStatus, state.isTransitioning, state.awaitingBackendConfirmation
  ]);

  // Consolidated event handlers using the optimized event utilities
  const eventHandlers = useMemo(() => {
    const handleSetQueue = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      console.log('[playback] handleSetQueue event:', detail);
      if (Array.isArray(detail.queueIds)) {
        setQueue(detail.queueIds, detail.startIndex ?? CONFIG.QUEUE.DEFAULT_INDEX, detail.shouldPlay ?? false);
      }
    };

    const handleEnqueue = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      const ids = eventUtils.extractIds(detail);
      if (ids.length) enqueue(ids);
    };

    const handlePlayAt = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      if (typeof detail.index === 'number') playAt(detail.index);
    };

    const handlePlayTrack = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      if (detail.id) playTrack(String(detail.id));
    };

    const handlePlayNow = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      const ids = eventUtils.extractIds(detail);
      if (ids.length) playNow(ids);
    };

    const handleReorder = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      if (Array.isArray(detail.queueIds)) reorderQueue(detail.queueIds);
    };

    const handleRemoveTrack = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      const id = detail.id || detail.trackId;
      if (id) removeFromQueue(String(id));
    };

  const handleSourceChanged = async (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      const changedTrackId = detail.trackId;

      // If the source changed for the current track, stop/reset and optionally autoplay
      if (changedTrackId && changedTrackId === state.trackId) {
    const shouldAutoplay = !!state.playing; // remember if we were playing

        // Stop and reset local playback state; clearing the URL triggers backend stop via effect
        dispatch({ type: 'SET_PLAYBACK_URL', url: undefined });
        dispatch({ type: 'SET_PLAYING', playing: false });
        dispatch({ type: 'SET_POSITION', position: 0 });
        dispatch({ type: 'SET_DURATION', duration: 0 });

  // Re-fetch the track to attach the newly selected source from DB (await to ensure order)
  await fetchTrack(state.trackId);

  // If it was playing, mark as user-initiated so it autoplays with the new source
  // If it wasn't playing, ensure no autoplay
  dispatch({ type: 'SET_SHOULD_FORCE_PLAY', shouldPlay: shouldAutoplay });
      }
    };

    // New synchronous track switching handlers
    const handleTrackChanged = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      const newTrackId = detail.trackId;
      const shouldPlay = detail.shouldPlay || false;
      
      if (newTrackId && newTrackId !== state.trackId) {
        console.log('[playback] Track change request:', { from: state.trackId, to: newTrackId, shouldPlay });
        
        // Update track ID and cache immediately for UI responsiveness
        dispatch({ type: 'SET_TRACK_ID', trackId: newTrackId });
        const cachedTrack = state.trackCache[newTrackId];
        if (cachedTrack) {
          dispatch({ type: 'SET_CURRENT_TRACK', track: cachedTrack });
        }
        
        if (shouldPlay) {
          // Use synchronous track switching
          switchToTrackSynchronously(newTrackId);
        }
      }
    };

    const handleQueuePositionChanged = (ev: Event) => {
      const detail = eventUtils.extractDetail(ev);
      const newQueueIds = detail.queueIds;
      const newCurrentIndex = detail.currentIndex;
      const shouldPlay = detail.shouldPlay || false;
      
      if (Array.isArray(newQueueIds) && typeof newCurrentIndex === 'number') {
        console.log('[playback] Queue position change request:', { queueIds: newQueueIds, currentIndex: newCurrentIndex, shouldPlay });
        
        // Update queue and position immediately
        dispatch({ type: 'SET_QUEUE', queueIds: newQueueIds, currentIndex: newCurrentIndex });
        
        if (newQueueIds.length > newCurrentIndex) {
          const newTrackId = newQueueIds[newCurrentIndex];
          dispatch({ type: 'SET_TRACK_ID', trackId: newTrackId });
          
          // Update cached track for immediate UI response
          const cachedTrack = state.trackCache[newTrackId];
          if (cachedTrack) {
            dispatch({ type: 'SET_CURRENT_TRACK', track: cachedTrack });
          }
          
          if (shouldPlay) {
            // Use synchronous track switching
            switchToTrackSynchronously(newTrackId);
          }
        }
      }
    };

    return [
      { event: EVENTS.SET_QUEUE, handler: handleSetQueue },
      { event: EVENTS.ENQUEUE, handler: handleEnqueue },
      { event: EVENTS.PLAY_AT, handler: handlePlayAt },
      { event: EVENTS.PLAY_TRACK, handler: handlePlayTrack },
      { event: EVENTS.PLAY_NOW, handler: handlePlayNow },
      { event: EVENTS.REORDER_QUEUE, handler: handleReorder },
      { event: EVENTS.NEXT, handler: next },
      { event: EVENTS.PREV, handler: prev },
      { event: EVENTS.REMOVE_TRACK, handler: handleRemoveTrack },
      { event: EVENTS.TRACK_CHANGED, handler: handleTrackChanged },
      { event: EVENTS.QUEUE_POSITION_CHANGED, handler: handleQueuePositionChanged },
      { event: EVENTS.SOURCE_CHANGED, handler: handleSourceChanged }
    ];
  }, [
    setQueue, enqueue, playAt, playTrack, playNow, reorderQueue, next, prev, 
    removeFromQueue, fetchTrack, switchToTrackSynchronously, state.trackId, state.trackCache, state.playing
  ]);

  // Optimize event listeners registration
  useEffect(() => {
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
  }, [eventHandlers]);

  return (
    <AudioSourceProvider>
      <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>
    </AudioSourceProvider>
  );
}

// Optimized hook for consuming components
export function usePlayback() {
  const context = React.useContext(PlaybackContext);
  if (!context) {
    throw new Error('usePlayback must be used within a PlaybackProvider');
  }
  return context;
}

export default { PlaybackProvider };