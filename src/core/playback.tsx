import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
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

const TEST_TRACK_IDS = [
  '6suU8oBlW4O2pg88tOXgHo', // existing sample
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
            const w:any = typeof window !== 'undefined' ? window : {};
            let t: SpotifyTrack;
            if (w.electron?.spotify?.getTrack) {
              const resp = await w.electron.spotify.getTrack(id);
              if (resp && (resp as any).error) throw new Error((resp as any).error);
              t = resp as any;
            } else { t = await spotifyClient.getTrack(id); }
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

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider');
  return ctx;
}

export default PlaybackProvider;