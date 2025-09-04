import React, { createContext, useContext, useEffect, useState, ReactNode, useMemo } from 'react';
import SpotifyClient, { SpotifyTrack } from './spotify';
import { createCachedSpotifyClient } from './spotify-client';
// This import correctly points to the new IndexedDB provider.
import { useDB } from './dbIndexed';

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
}

const PlaybackContext = createContext<PlaybackContextValue | undefined>(undefined);

// --- Playback actions context (stable callbacks) ---
const PlaybackActionsContext = createContext<PlaybackContextValue | undefined>(undefined);

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

const TEST_TRACK_IDS = [
  '5AZGbqiIK5t1jrWSPT7k8X', // existing sample
  '3n3Ppam7vgaVa1iaRUc9Lp', // lose yourself (example popular track)
  '7ouMYWpwJ422jRcDASZB7P', // numb
  '0eGsygTp906u18L0Oimnem', // enter sandman
  '11dFghVXANMlKmJXsNCbNl'  // spotify api sample track
];

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [trackId, setTrackId] = useState<string>(TEST_TRACK_IDS[0]);
  const [currentTrack, setCurrentTrack] = useState<SpotifyTrack | undefined>();
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | undefined>();
  const [queueIds, setQueueIds] = useState<string[]>(TEST_TRACK_IDS);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [trackCache, setTrackCache] = useState<Record<string, SpotifyTrack | undefined>>({});
  
  const { getApiCache, setApiCache, ready } = useDB();
  const { addPlay, getPlayCountForTrack } = useDB();

  const spotifyClient = ready ? createCachedSpotifyClient({ getApiCache, setApiCache }) : new SpotifyClient();

  const fetchTrack = async (id: string) => {
    if (!id) return;
    setLoading(true); setError(undefined);
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
      setTrackCache(c => ({ ...c, [id]: track }));
    } catch (e: any) {
      setError(e?.message || String(e));
      setCurrentTrack(undefined);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchTrack(trackId); }, [trackId]);

  // Record play history when a new trackId is set (track started)
  useEffect(() => {
    if (!trackId) return;
    let mounted = true;
    (async () => {
      try {
        // best-effort: record when playback switches to a track
        await addPlay(trackId, Date.now());
      } catch (e) {
        // ignore DB errors
        console.warn('Failed to record play:', e);
      }
    })();
    return () => { mounted = false; };
  }, [trackId, addPlay]);

  useEffect(()=>{
    const idx = queueIds.indexOf(trackId);
    if(idx !== -1 && idx !== currentIndex) setCurrentIndex(idx);
  }, [trackId, queueIds]);

  useEffect(() => {
    if(currentIndex > 0){
      setQueueIds(q => {
        if(currentIndex >= q.length) return q;
        const trimmed = q.slice(currentIndex);
        setCurrentIndex(0);
        return trimmed;
      });
    }
  }, [currentIndex]);

  useEffect(()=>{
    let cancelled = false;
    (async () => {
      for(const id of queueIds){
        if(cancelled) return;
        if(!trackCache[id]){
          try {
            let t = await spotifyClient.getTrack(id);
            if(!cancelled) setTrackCache(c => ({ ...c, [id]: t }));
          } catch { /* ignore prefetch errors */ }
        }
      }
    })();
    return ()=> { cancelled = true; };
  }, [queueIds, spotifyClient]); // spotifyClient added as dependency for correctness

  function setQueue(ids: string[], startIndex: number = 0){
    setQueueIds(ids);
    if(ids.length){
      const safeIndex = Math.min(Math.max(0, startIndex), ids.length-1);
      setCurrentIndex(safeIndex);
      setTrackId(ids[safeIndex]);
    }
  }

  function enqueue(ids: string | string[]){
    const arr = Array.isArray(ids) ? ids : [ids];
    setQueueIds(q => [...q, ...arr]);
  }

  function playAt(index: number){
    if(index < 0 || index >= queueIds.length) return;
    setCurrentIndex(index);
    setTrackId(queueIds[index]);
  }

  function playTrack(id: string){
    const idx = queueIds.indexOf(id);
    if(idx === -1){
      const newQueue = [...queueIds, id];
      setQueueIds(newQueue);
      setCurrentIndex(newQueue.length - 1);
    } else {
      setCurrentIndex(idx);
    }
    setTrackId(id);
  }
  
  function playNow(ids: string | string[]){
    const idsArr = Array.isArray(ids) ? ids.filter(Boolean) : (ids ? [ids] : []);
    if(!idsArr.length) return;
    setQueueIds(prev => {
      const filtered = prev.filter(p => !idsArr.includes(p));
      return [...idsArr, ...filtered];
    });
    setCurrentIndex(0);
    setTrackId(idsArr[0]);
  }

  function next(){
    if(!queueIds.length) return;
    const nextIndex = (currentIndex + 1) % queueIds.length;
    playAt(nextIndex);
  }

  function prev(){
    if(!queueIds.length) return;
    const prevIndex = (currentIndex - 1 + queueIds.length) % queueIds.length;
    playAt(prevIndex);
  }

  function reorderQueue(nextIds: string[]){
    if(!nextIds.length) return;
    const currentId = trackId;
    setQueueIds(nextIds);
    const newIndex = nextIds.indexOf(currentId || '');
    if(newIndex !== -1) setCurrentIndex(newIndex);
  }

  const value: PlaybackContextValue = {
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
    reorderQueue
  };

  // Memoize actions object so its identity is stable for action-only consumers
  const actions = useMemo(() => ({
    setTrackId,
    refresh: () => fetchTrack(trackId),
    setQueue,
    enqueue,
    next,
    prev,
    playAt,
    playTrack,
    playNow,
    reorderQueue
  }), [setTrackId, setQueue, enqueue, next, prev, playAt, playTrack, playNow, reorderQueue, trackId]);

  // Keep a snapshot and notify selector subscribers when relevant state changes
  useEffect(() => {
    const snap: PlaybackStateSnapshot = { currentTrack, loading, error, trackId, queueIds, currentIndex, trackCache };
    playbackSnapshot = snap;
    notifyPlaybackSubscribers(snap);
  }, [currentTrack, loading, error, trackId, queueIds, currentIndex, trackCache]);

  return (
    <PlaybackActionsContext.Provider value={actions as any}>
      <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>
    </PlaybackActionsContext.Provider>
  );
}

export function usePlaybackActions() {
  const ctx = useContext(PlaybackActionsContext) as any;
  if (!ctx) throw new Error('usePlaybackActions must be used within PlaybackProvider');
  return ctx;
}
export interface TrackData {
  id: string;
  name: string;
  artists: { name: string }[];
  album: {
    images: any[]; // Or a more specific type if you have one
  };
}

export default { PlaybackProvider };