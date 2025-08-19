import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import SpotifyClient, { SpotifyTrack } from './spotify';

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
  trackCache: Record<string, SpotifyTrack | undefined>;
  reorderQueue: (nextIds: string[]) => void;
}

const PlaybackContext = createContext<PlaybackContextValue | undefined>(undefined);

// Static test track IDs used to seed an initial queue for development/testing
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
        const client = new SpotifyClient();
        track = await client.getTrack(id);
      }
      setCurrentTrack(track);
      setTrackCache(c => ({ ...c, [id]: track }));
    } catch (e: any) {
      setError(e?.message || String(e));
      setCurrentTrack(undefined);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchTrack(trackId); }, [trackId]);

  // Keep current index in sync if trackId changes externally
  useEffect(()=>{
    const idx = queueIds.indexOf(trackId);
    if(idx !== -1 && idx !== currentIndex) setCurrentIndex(idx);
  }, [trackId, queueIds]);

  // Trim any tracks that appear before the current one so items "above" the
  // playing track are removed automatically after navigation or reordering.
  useEffect(() => {
    if(currentIndex > 0){
      setQueueIds(q => {
        // safeguard if index out of range
        if(currentIndex >= q.length) return q;
        const currentId = q[currentIndex];
        const trimmed = q.slice(currentIndex); // keep current and everything after it
        setCurrentIndex(0); // current track now at position 0
        // trackId already points at currentId; no need to update unless defensive
        return trimmed;
      });
    }
  }, [currentIndex]);

  // Lazy-load metadata for queue items (shallow prefetch)
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
            } else { const client = new SpotifyClient(); t = await client.getTrack(id); }
            if(!cancelled) setTrackCache(c => ({ ...c, [id]: t }));
          } catch { /* ignore prefetch errors */ }
        }
      }
    })();
    return ()=> { cancelled = true; };
  }, [queueIds]);

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
      setQueueIds(q => [...q, id]);
      setCurrentIndex(queueIds.length); // will point to new last after state flush
    } else {
      setCurrentIndex(idx);
    }
    setTrackId(id);
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
    trackCache
  ,reorderQueue
  };

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider');
  return ctx;
}

export default PlaybackProvider;
