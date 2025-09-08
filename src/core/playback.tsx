import React, { createContext, useEffect, useState, ReactNode, useMemo, useCallback } from 'react';
import SpotifyClient, { SpotifyTrack } from './spotify';
import { createCachedSpotifyClient } from './spotify-client';
// This import correctly points to the new IndexedDB provider.
import { useDB } from './dbIndexed';
import AudioSourceProvider, { resolveAudioSource, AudioSourceSpec } from './audioSource';

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
  
  const { getApiCache, setApiCache, addPlay, ready } = useDB();

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
  }, [spotifyClient]);

  // Extract URL resolution to separate function
  const resolvePlaybackUrl = useCallback(async (track: SpotifyTrack, id: string) => {
    try {
      const sourceMeta = (track as any).source;
      if (sourceMeta && sourceMeta.type && sourceMeta.value) {
        const spec: AudioSourceSpec = { 
          type: sourceMeta.type, 
          value: sourceMeta.value, 
          meta: sourceMeta.meta 
        };
        const url = await resolveAudioSource(spec);
        setPlaybackUrlCache(prev => ({ ...prev, [id]: url }));
      }
    } catch (e) {
      // Ignore resolution errors silently
    }
  }, []);

  // Optimize main track fetch effect
  useEffect(() => { 
    fetchTrack(trackId); 
  }, [trackId, fetchTrack]);

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
        
        // Prefetch playback URL
        if (trackCache[id] && !playbackUrlCache[id]) {
          try {
            const track = trackCache[id] as any;
            const preview = track?.preview_url;
            if (preview) {
              const url = await resolveAudioSource({ type: 'http', value: preview });
              if (!cancelled) {
                setPlaybackUrlCache(prev => ({ ...prev, [id]: url }));
              }
            }
          } catch {
            // Ignore URL resolution errors
          }
        }
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
    removeFromQueue
  }), [
    currentTrack, loading, error, trackId, queueIds, currentIndex, trackCache,
    fetchTrack, setQueue, enqueue, next, prev, playAt, playTrack, playNow, reorderQueue, removeFromQueue
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
      trackCache 
    };
    playbackSnapshot = snap;
    notifyPlaybackSubscribers(snap);
  }, [currentTrack, loading, error, trackId, queueIds, currentIndex, trackCache]);

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
      { event: PLAYBACK_EVENTS.REMOVE_TRACK, handler: handleRemoveTrack }
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
    handlePlayNow, handleReorder, next, prev, handleRemoveTrack
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