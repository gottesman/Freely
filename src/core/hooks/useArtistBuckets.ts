import { useEffect, useState } from 'react';
import { SpotifyAlbum, SpotifyPlaylist, useSpotifyClient } from '../SpotifyClient';
import { useAlerts } from '../Alerts';
import { ArtistBuckets } from '../../components/RightPanel/MoreFromArtist';
import { usePlaybackSelector } from '../Playback';

export function useArtistBuckets() {
  const currentTrack = usePlaybackSelector(s => s.currentTrack);
  const primaryArtistId = currentTrack?.artists?.[0]?.id;
  const [deferredArtistId, setDeferredArtistId] = useState<string | undefined>();
  const [buckets, setBuckets] = useState<ArtistBuckets>({ singles: [], albums: [], playlists: [], loading: false, fetched: false });
  const { push: pushAlert, alerts } = useAlerts();
  const spotifyClient = useSpotifyClient(); // Cached client with DB caching

  // Defer setting artist id slightly to allow track metadata to settle
  useEffect(() => {
    let t: any;
    if (primaryArtistId) {
      setBuckets({ singles: [], albums: [], playlists: [], loading: true, fetched: false });
      t = setTimeout(() => setDeferredArtistId(primaryArtistId), 250);
    } else {
      setDeferredArtistId(undefined);
      setBuckets({ singles: [], albums: [], playlists: [], loading: false, fetched: false });
    }
    return () => { if (t) clearTimeout(t); };
  }, [primaryArtistId, currentTrack?.id]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!deferredArtistId) { return; }
      //console.log('🎵 useArtistBuckets: Loading data for artist ID:', deferredArtistId);
      const w: any = window;
      setBuckets(b => ({ ...b, loading: true, error: undefined, fetched: false }));
      try {
        let albumsResp: any;
        if (w.electron?.spotify?.getArtistAlbums) {
          //console.log('🖥️ Using Electron Spotify API');
          const resp = await w.electron.spotify.getArtistAlbums(deferredArtistId, { includeGroups: 'album,single', fetchAll: false, limit: 20 });
          if (resp && resp.error) throw new Error(resp.error);
          albumsResp = resp;
        } else {
          //console.log('🌐 Using SpotifyClient for albums');
          try {
            albumsResp = await spotifyClient.getArtistAlbums(deferredArtistId, { includeGroups: 'album,single', fetchAll: false, limit: 20 });
            //console.log('✅ Albums response:', albumsResp);
          } catch (e) { 
            console.error('❌ Albums request failed:', e);
            /* fallback failed */ 
          }
        }
        if (!albumsResp) { throw new Error('Artist albums unavailable'); }
        const rawAlbums: any[] = albumsResp.items || [];
        const normAlbums: SpotifyAlbum[] = rawAlbums.map(a => {
          const albumType = (a as any).albumType || (a as any).album_type;
          return { ...a, albumType } as SpotifyAlbum;
        });
        const singlesAll = normAlbums.filter(a => a.albumType === 'single');
        const albumsAll = normAlbums.filter(a => a.albumType !== 'single');
        const singles = singlesAll.slice(0, 6);
        const realAlbums = albumsAll.slice(0, 6);
        let playlists: SpotifyPlaylist[] = [];
        if (w.electron?.spotify?.searchPlaylists && currentTrack?.artists?.[0]?.name) {
          //console.log('🖥️ Using Electron for playlist search');
          try {
            const pl = await w.electron.spotify.searchPlaylists(currentTrack.artists[0].name);
            if (pl && pl.error) throw new Error(pl.error);
            const plItems = (pl.items || pl.playlists?.items || []).filter(Boolean);
            playlists = plItems.slice(0, 6);
          } catch (err) { console.warn('Playlist proxy search failed', err); }
        } else if (currentTrack?.artists?.[0]?.name) {
          //console.log('🌐 Using SpotifyClient for playlist search, artist:', currentTrack.artists[0].name);
          try {
            const pl = await spotifyClient.searchPlaylists(currentTrack.artists[0].name);
            //console.log('✅ Playlists response:', pl);
            const plItems = (pl.items || (pl as any).playlists?.items || []).filter(Boolean);
            playlists = plItems.slice(0, 6) as any;
          } catch (err) { 
            console.error('❌ Playlist search failed:', err);
            console.warn('Playlist local search failed', err); 
          }
        }
        if (cancelled) return;
        //console.log('🎯 Setting buckets - Singles:', singles.length, 'Albums:', realAlbums.length, 'Playlists:', playlists.length);
        setBuckets({ singles, albums: realAlbums, playlists, loading: false, fetched: true });
      } catch (e: any) {
        console.error('❌ useArtistBuckets error:', e);
        if (!cancelled) {
          const msg = e?.message || 'Failed to load artist releases';
            setBuckets({ singles: [], albums: [], playlists: [], loading: false, fetched: true, error: msg });
            if (!alerts.some(a => a.msg === msg)) pushAlert(msg, 'error');
            console.warn('Artist releases load error', e);
        }
      }
    }
    load();
    return () => { cancelled = true; };
  // Include currentTrack?.id so we refetch when the playing track changes
  // but the primary artist remains the same (previous implementation stalled in loading state).
  }, [deferredArtistId, currentTrack?.id]);

  return { buckets, currentTrack };
}

export default useArtistBuckets;
