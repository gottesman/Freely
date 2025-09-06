import React, { createContext, useEffect, useState, ReactNode } from 'react';
import SpotifyClient, { SpotifyTrack } from './spotify';
import { createCachedSpotifyClient } from './spotify-client';
// This import correctly points to the new IndexedDB provider.
import { useDB } from './dbIndexed';
import AudioSourceProvider, { resolveAudioSource, AudioSourceSpec } from './audioSource';

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
  const [playbackUrlCache, setPlaybackUrlCache] = useState<Record<string, string | undefined>>({});
  
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
      // best-effort: resolve a playback URL from known metadata (custom source)
      (async () => {
        try {
          const sourceMeta = (track as any).source;
          if (sourceMeta && sourceMeta.type && sourceMeta.value) {
            const spec: AudioSourceSpec = { type: sourceMeta.type, value: sourceMeta.value, meta: sourceMeta.meta };
            const url = await resolveAudioSource(spec);
            setPlaybackUrlCache(p => ({ ...p, [id]: url }));
            return;
          }
        } catch (e) {
          // ignore resolution errors
        }
      })();
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
        // if we have a cached track object and no playback URL yet, try to resolve
        if(trackCache[id] && !playbackUrlCache[id]){
          try {
            const tr = trackCache[id] as any;
            const preview = tr?.preview_url;
            if(preview){
              const url = await resolveAudioSource({ type: 'http', value: preview });
              setPlaybackUrlCache(p => ({ ...p, [id]: url }));
            }
          } catch {}
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

  function removeFromQueue(id: string){
    if(!id) return;
    setQueueIds(q => {
      const idx = q.indexOf(id);
      if(idx === -1) return q; // nothing
      const next = q.filter(t => t !== id);
      if(!next.length){
        // queue empty
        setCurrentIndex(0);
        setTrackId('');
        setCurrentTrack(undefined);
        return [];
      }
      if(trackId === id){
        // choose successor or last element
        const newIndex = idx < next.length ? idx : next.length - 1;
        setCurrentIndex(newIndex);
        setTrackId(next[newIndex]);
      } else {
        // Ensure currentIndex remains correct relative to new queue ordering
        const newCurIdx = next.indexOf(trackId || '');
        if(newCurIdx !== -1) setCurrentIndex(newCurIdx);
      }
      return next;
    });
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
  reorderQueue,
  removeFromQueue
  };

  // Memoize actions object so its identity is stable for action-only consumers
  // Actions object removed with legacy hook API (usePlaybackActions) deprecation.

  // Keep a snapshot and notify selector subscribers when relevant state changes
  useEffect(() => {
    const snap: PlaybackStateSnapshot = { currentTrack, loading, error, trackId, queueIds, currentIndex, trackCache };
    playbackSnapshot = snap;
    notifyPlaybackSubscribers(snap);
  }, [currentTrack, loading, error, trackId, queueIds, currentIndex, trackCache]);

  // --- Custom Event Bridge (event-driven playback actions) ---
  useEffect(() => {
    function onSetQueue(ev: Event) {
      const d = (ev as CustomEvent).detail || {};
      if(Array.isArray(d.queueIds)) setQueue(d.queueIds, d.startIndex ?? 0);
    }
    function onEnqueue(ev: Event) {
      const d = (ev as CustomEvent).detail || {};
      const ids: string[] = Array.isArray(d.ids) ? d.ids : (d.id ? [d.id] : []);
      if(ids.length) enqueue(ids);
    }
    function onPlayAt(ev: Event) {
      const d = (ev as CustomEvent).detail || {};
      if(typeof d.index === 'number') playAt(d.index);
    }
    function onPlayTrack(ev: Event) {
      const d = (ev as CustomEvent).detail || {};
      if(d.id) playTrack(String(d.id));
    }
    function onPlayNow(ev: Event) {
      const d = (ev as CustomEvent).detail || {};
      const ids: string[] = Array.isArray(d.ids) ? d.ids : (d.id ? [d.id] : []);
      if(ids.length) playNow(ids);
    }
    function onReorder(ev: Event) {
      const d = (ev as CustomEvent).detail || {};
      if(Array.isArray(d.queueIds)) reorderQueue(d.queueIds);
    }
    function onNext() { next(); }
    function onPrev() { prev(); }
    function onRemoveTrack(ev: Event){
      const d = (ev as CustomEvent).detail || {};
      const id = d.id || d.trackId;
      if(id) removeFromQueue(String(id));
    }

    window.addEventListener('freely:playback:setQueue', onSetQueue as any);
    window.addEventListener('freely:playback:enqueue', onEnqueue as any);
    window.addEventListener('freely:playback:playAt', onPlayAt as any);
    window.addEventListener('freely:playback:playTrack', onPlayTrack as any);
    window.addEventListener('freely:playback:playNow', onPlayNow as any);
    window.addEventListener('freely:playback:reorderQueue', onReorder as any);
    window.addEventListener('freely:playback:next', onNext as any);
    window.addEventListener('freely:playback:prev', onPrev as any);
    window.addEventListener('freely:playback:removeTrack', onRemoveTrack as any);
    return () => {
      window.removeEventListener('freely:playback:setQueue', onSetQueue as any);
      window.removeEventListener('freely:playback:enqueue', onEnqueue as any);
      window.removeEventListener('freely:playback:playAt', onPlayAt as any);
      window.removeEventListener('freely:playback:playTrack', onPlayTrack as any);
      window.removeEventListener('freely:playback:playNow', onPlayNow as any);
      window.removeEventListener('freely:playback:reorderQueue', onReorder as any);
      window.removeEventListener('freely:playback:next', onNext as any);
      window.removeEventListener('freely:playback:prev', onPrev as any);
      window.removeEventListener('freely:playback:removeTrack', onRemoveTrack as any);
    };
  }, [setQueue, enqueue, playAt, playTrack, playNow, reorderQueue, next, prev, removeFromQueue]);

  return (
    <AudioSourceProvider>
      <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>
    </AudioSourceProvider>
  );
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