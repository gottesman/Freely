import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import SpotifyClient, { SpotifyTrack } from './spotify';

interface PlaybackContextValue {
  currentTrack?: SpotifyTrack;
  loading: boolean;
  error?: string;
  trackId?: string;
  setTrackId: (id: string) => void;
  refresh: () => Promise<void>;
}

const PlaybackContext = createContext<PlaybackContextValue | undefined>(undefined);

// Static test track ID provided
const TEST_TRACK_ID = '6suU8oBlW4O2pg88tOXgHo';

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [trackId, setTrackId] = useState<string>(TEST_TRACK_ID);
  const [currentTrack, setCurrentTrack] = useState<SpotifyTrack | undefined>();
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | undefined>();

  const fetchTrack = async (id: string) => {
    if (!id) return;
    setLoading(true); setError(undefined);
    try {
      const w: any = typeof window !== 'undefined' ? window : {};
      let track: SpotifyTrack;
      if (w.electron?.spotify?.getTrack) {
        track = await w.electron.spotify.getTrack(id);
      } else {
        const client = new SpotifyClient();
        track = await client.getTrack(id);
      }
      setCurrentTrack(track);
    } catch (e: any) {
      setError(e?.message || String(e));
      setCurrentTrack(undefined);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchTrack(trackId); }, [trackId]);

  const value: PlaybackContextValue = {
    currentTrack,
    loading,
    error,
    trackId,
    setTrackId,
    refresh: () => fetchTrack(trackId)
  };

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider');
  return ctx;
}

export default PlaybackProvider;
