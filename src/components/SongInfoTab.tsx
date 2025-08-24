import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';
import { usePlayback } from '../core/playback';
import SpotifyClient, { type SpotifyAlbum, type SpotifyArtist, type SpotifyTrack } from '../core/spotify';
import { useSpotifyClient } from '../core/spotify-client';
import TrackList from './TrackList';
import GeniusClient from '../core/musicdata';

function fmt(ms?: number){
  if(!ms && ms!==0) return '--:--';
  const total = Math.floor(ms/1000); const m = Math.floor(total/60); const s = total%60; return m+':' + (s<10?'0':'')+s;
}

export default function SongInfoTab({ trackId, onSelectArtist, onSelectAlbum, onSelectTrack }: { trackId?: string, onSelectArtist?: (id: string)=>void, onSelectAlbum?: (id: string)=>void, onSelectTrack?: (id: string)=>void }){
  const { t } = useI18n();
  const spotifyClient = useSpotifyClient();
  // Playback context (avoid calling hook inside handlers)
  const { currentTrack: playbackTrack, trackId: playingTrackId, queueIds, setQueue, enqueue, currentIndex } = usePlayback();
  const [track, setTrack] = useState<SpotifyTrack | undefined>();
  const [album, setAlbum] = useState<SpotifyAlbum|undefined>();
  const [primaryArtist, setPrimaryArtist] = useState<SpotifyArtist|undefined>();
  const [albumTracks, setAlbumTracks] = useState<SpotifyTrack[]|undefined>();
  const [tracksLoading, setTracksLoading] = useState(false);
  // (Removed artist biography display; we now show track credits instead.)
  const [writers, setWriters] = useState<string[]|undefined>();
  const [writersLoading, setWritersLoading] = useState(false);
  const effectiveTrackId = trackId || playingTrackId;
  
  // Scroll position preservation
  const containerRef = useRef<HTMLElement>(null);
  const scrollPositionRef = useRef<number>(0);

  // Load (or reuse) track details
  useEffect(()=>{
    let cancelled = false;
    async function load(){
      console.log('🎵 SongInfoTab: Track loading started for ID:', effectiveTrackId);
      setTrack(undefined);
      if(!effectiveTrackId) {
        console.log('🎵 SongInfoTab: No effective track ID, skipping track load');
        return;
      }
      if(playbackTrack && playbackTrack.id === effectiveTrackId){ 
        console.log('🎵 SongInfoTab: Using playback track:', playbackTrack.name);
        setTrack(playbackTrack); 
        return; 
      }
      const w:any = window;
      try {
        if(w.electron?.spotify?.getTrack){
          console.log('🎵 SongInfoTab: Loading track via Electron API');
          const tr: SpotifyTrack = await w.electron.spotify.getTrack(effectiveTrackId);
          if(!cancelled) {
            console.log('🎵 SongInfoTab: Track loaded via Electron:', tr?.name);
            setTrack(tr);
          }
        } else {
          console.log('🎵 SongInfoTab: Loading track via Spotify Client');
          try {
            console.log('🎵 SongInfoTab: About to call spotifyClient.getTrack()');
            const tr = await spotifyClient.getTrack(effectiveTrackId);
            console.log('🎵 SongInfoTab: spotifyClient.getTrack() completed:', tr?.name);
            if(!cancelled) {
              console.log('🎵 SongInfoTab: Track loaded via Client:', tr?.name);
              setTrack(tr);
            } else {
              console.log('🎵 SongInfoTab: Track load cancelled, not setting track');
            }
          } catch (error) {
            console.log('🎵 SongInfoTab: spotifyClient.getTrack() threw error:', error);
          }
        }
      } catch (error) { 
        console.log('🎵 SongInfoTab: Track loading failed:', error);
      }
    }
    load();
    return ()=> { cancelled = true; };
  }, [effectiveTrackId, playbackTrack?.id, spotifyClient]);

  // Preserve scroll position during track transitions
  useEffect(() => {
    // Save current scroll position before track changes
    if (containerRef.current) {
      scrollPositionRef.current = containerRef.current.scrollTop;
    }
  }, [effectiveTrackId]);

  // Restore scroll position after content loads
  useEffect(() => {
    if (containerRef.current && track) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = scrollPositionRef.current;
        }
      });
    }
  }, [track, albumTracks]);

  // Album + primary artist
  useEffect(()=>{
    let cancelled = false;
    async function run(){
      console.log('🎵 SongInfoTab: Album/Artist loading started for track:', track?.id);
      if(!track?.id || !track.album?.id || !track.artists?.[0]?.id) {
        console.log('🎵 SongInfoTab: No track data available, skipping album/artist load');
        return;
      }
      
      // Only clear state when we have a valid track to load
      setAlbum(undefined); setPrimaryArtist(undefined);
      
      const w:any = window;
      const albumId = track.album?.id; const artistId = track.artists?.[0]?.id;
      console.log('🎵 SongInfoTab: Loading album:', albumId, 'artist:', artistId);
      
      const albumPromise = (async()=>{ 
        if(!albumId) return; 
        try { 
          if(w.electron?.spotify?.getAlbum) return await w.electron.spotify.getAlbum(albumId); 
          return await spotifyClient.getAlbum(albumId);
        } catch{} 
      })();
      const artistPromise = (async()=>{ 
        if(!artistId) return; 
        try { 
          if(w.electron?.spotify?.getArtist) return await w.electron.spotify.getArtist(artistId); 
          return await spotifyClient.getArtist(artistId);
        } catch{} 
      })();
      const [alb, art] = await Promise.all([albumPromise, artistPromise]);
      console.log('🎵 SongInfoTab: Album/Artist loaded:', !!alb, !!art);
      if(cancelled) {
        console.log('🎵 SongInfoTab: Album/Artist load cancelled');
        return;
      }
      if(alb) {
        console.log('🎵 SongInfoTab: Setting album:', alb.name);
        setAlbum(alb);
      }
      if(art) {
        console.log('🎵 SongInfoTab: Setting primary artist:', art.name);
        setPrimaryArtist(art);
      }
    }
    run();
    return ()=>{ cancelled = true; };
  }, [track?.album?.id, track?.artists?.[0]?.id, spotifyClient]);

  // Album tracks
  useEffect(()=>{
    let cancelled = false;
    async function loadTracks(){
      console.log('🎵 SongInfoTab: Album tracks loading started for album:', track?.album?.id);
      if(!track?.album?.id) {
        console.log('🎵 SongInfoTab: No album ID, skipping tracks load');
        return;
      }
      
      // Only clear album tracks state when we have a valid album to load
      setAlbumTracks(undefined);
      const w:any = window; setTracksLoading(true);
      try {
        let items: SpotifyTrack[] | undefined;
        if(w.electron?.spotify?.getAlbumTracks){ 
          const res = await w.electron.spotify.getAlbumTracks(track.album.id); 
          items = res.items || []; 
          console.log('🎵 SongInfoTab: Album tracks loaded via Electron:', items?.length);
        }
        else { 
          try { 
            const res = await spotifyClient.getAlbumTracks(track.album.id, { fetchAll:false, limit:50 }); 
            items = res.items; 
            console.log('🎵 SongInfoTab: Album tracks loaded via API:', items?.length);
          } catch{
            console.log('🎵 SongInfoTab: Album tracks API call failed');
          } 
        }
        if(!cancelled && items) {
          console.log('🎵 SongInfoTab: Setting album tracks:', items.length);
          setAlbumTracks(items);
        }
      } finally { 
        if(!cancelled) {
          console.log('🎵 SongInfoTab: Setting tracks loading false');
          setTracksLoading(false); 
        }
      }
    }
    loadTracks();
    return ()=>{ cancelled = true; };
  }, [track?.id, spotifyClient]);

  // Credits: no extra async call needed; we derive from existing track/album/artist data.
  // Add writers via Genius (best-effort)
  useEffect(()=>{
    let cancelled = false;
    async function loadWriters(){
      setWriters(undefined);
      if(!track?.name) return;
      if(!primaryArtist?.name) return; // need artist context to disambiguate
      const query = `${track.name} ${primaryArtist.name}`;
      try {
        setWritersLoading(true);
        const w:any = window; const hasIpc = !!(w.electron?.genius?.search && w.electron?.genius?.getSong);
        let searchRes: any; if(hasIpc) searchRes = await w.electron.genius.search(query); else { const gc = new GeniusClient(); searchRes = await gc.search(query); }
        const hits = searchRes?.hits || [];
        const lowerArtist = primaryArtist.name.toLowerCase();
        const target = hits.find((h:any)=> h.primaryArtist?.name?.toLowerCase() === lowerArtist) || hits[0];
        const songId = target?.id;
        if(!songId){ return; }
        let songDetails: any; if(hasIpc && w.electron.genius.getSong) songDetails = await w.electron.genius.getSong(songId); else { const gc = new GeniusClient(); songDetails = await gc.getSong(songId); }
        const writerArtists: any[] = songDetails?.writerArtists || songDetails?.writer_artists || songDetails?.raw?.writer_artists || [];
        const names = (writerArtists || []).map((wa:any)=> wa.name).filter(Boolean);
        if(!cancelled && names.length){
          // Deduplicate preserving order
            const seen = new Set<string>();
            const unique = names.filter(n=> { if(seen.has(n.toLowerCase())) return false; seen.add(n.toLowerCase()); return true; });
            setWriters(unique);
        }
      } catch { /* ignore errors silently */ }
      finally { if(!cancelled) setWritersLoading(false); }
    }
    loadWriters();
    return ()=> { cancelled = true; };
  }, [track?.name, primaryArtist?.name]);

  const heroImage = useMemo(()=> album?.images?.[0]?.url || track?.album?.images?.[0]?.url || '', [album, track?.album?.images]);
  const releaseYear = album?.releaseDate ? (album.releaseDate.split('-')[0]) : undefined;
  const genres = primaryArtist?.genres?.slice(0,3) || [];
  const artistColWidth = useMemo(()=>{ if(!albumTracks?.length) return undefined; const names = albumTracks.map(t=> t.artists?.[0]?.name || ''); const longest = names.reduce((a,b)=> b.length>a.length? b:a,''); if(!longest) return undefined; const avgCharPx=7.2; const padding=28; return Math.min(240, Math.max(80, Math.round(longest.length*avgCharPx+padding))); }, [albumTracks]);

  return (
    <section ref={containerRef} className="now-playing" aria-labelledby="np-heading">
      <header className="np-hero" style={{ ['--hero-image' as any]: `url(${heroImage})` }}>
        <div className="np-hero-inner">
          <h1 id="np-heading" className="np-title">{ track ? track.name : (effectiveTrackId ? t('np.loading') : t('np.noTrack')) }</h1>
          {track && (
            <div className="np-meta-line">
              <span className="np-artists">
                {track.artists.map((a,i)=>(<React.Fragment key={a.id||a.name}>{i>0 && <span className="np-sep">, </span>}<button type="button" className="np-link artist" onClick={()=> { if(onSelectArtist && a.id) onSelectArtist(a.id); else if(a.url) window.open(a.url,'_blank'); }}>{a.name}</button></React.Fragment>))}
              </span>
              {track.album?.name && (
                <>
                  <span className="np-dot" />
                  {track.album.id && onSelectAlbum ? (
                    <button type="button" className="np-link np-album" onClick={()=> onSelectAlbum && track.album?.id && onSelectAlbum(track.album.id)}>
                      {track.album.name}
                    </button>
                  ) : (
                    <span className="np-album">{track.album.name}</span>
                  )}
                </>
              )}
            </div>
          )}
          <div className="np-extras">
            <div className="np-tags" aria-label={t('np.genresTags')}>{genres.length? genres.map(g=> <span key={g} className="tag">{g}</span>) : <span className="tag">—</span>}</div>
            <div className="np-actions" aria-label={t('np.trackActions')}>
              <button className="np-icon" aria-label={t('player.addPlaylist')} disabled><span className="material-symbols-rounded">add_circle</span></button>
              <button className="np-icon" aria-label={t('np.like','Like')} disabled><span className="material-symbols-rounded">favorite</span></button>
              <button
                className="np-icon"
                aria-label={t('player.playTrack')}
                disabled={!track?.id}
                onClick={()=>{
                  if(!track?.id) return;
                  const currentSegment = queueIds.slice(currentIndex);
                  const trackIds = [track.id];
                  const dedupSet = new Set(trackIds);
                  const filteredCurrent = currentSegment.filter(id => !dedupSet.has(id));
                  const newQueue = [...trackIds, ...filteredCurrent];
                  setQueue(newQueue, 0);
                }}
              >
                <span className="material-symbols-rounded filled">play_arrow</span>
              </button>
              <button
                className="np-icon"
                aria-label={t('player.addToQueue')}
                disabled={!track?.id}
                onClick={()=>{
                  if(!track?.id) return;
                  const trackIds = [track.id];
                  const existing = new Set(queueIds);
                  const toAppend = trackIds.filter(id => !existing.has(id));
                  if(toAppend.length) enqueue(toAppend);
                }}
              >
                <span className="material-symbols-rounded">queue</span>
              </button>
            </div>
          </div>
        </div>
      </header>
      <div className="np-section np-album-tracks" aria-label={t('np.albumTrackList','Album track list')}>
        <h4 className="np-sec-title">{t('np.fromSameAlbum')}</h4>
        {album && (<div className="np-album-heading"><span className="np-album-name" title={album.name}>{album.name}</span><span className="np-album-trackcount">{t('np.tracks', undefined, { count: album.totalTracks })}</span></div>)}
        {!track && effectiveTrackId && !albumTracks && <p className="np-hint">{t('np.loading')}</p>}
        {!effectiveTrackId && <p className="np-hint">{t('np.selectTrackHint')}</p>}
        {tracksLoading && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {albumTracks && (
          <TrackList
            tracks={albumTracks}
            selectedTrackId={track?.id}
            playingTrackId={playingTrackId}
            showPlayButton
            onSelectTrack={onSelectTrack}
          />
        )}
        {!tracksLoading && !albumTracks && track?.album && <p className="np-hint">{t('np.albumUnavailable')}</p>}
      </div>
      <div className="np-section np-track-credits" aria-label={t('np.trackCredits','Track credits')}>
        <h4 className="np-sec-title">{t('np.trackCredits','Credits')}</h4>
        {!track && <p className="np-hint">{t('np.noTrack')}</p>}
        {track && (
          <ul className="credits-list">
            <li><span className="cl-label">{t('np.primaryArtist','Primary Artist')}</span>: <span className="cl-value">{primaryArtist?.name || track.artists?.[0]?.name || '—'}</span></li>
            {track.artists && track.artists.length > 1 && (
              <li><span className="cl-label">{t('np.featuring','Featuring')}</span>: <span className="cl-value">{track.artists.slice(1).map(a=>a.name).join(', ')}</span></li>
            )}
            {album && (
              <li><span className="cl-label">{t('np.album','Album')}</span>: <span className="cl-value">{album.name}{album.releaseDate?` (${album.releaseDate.split('-')[0]})`:''}</span></li>
            )}
            {album && (
              <li><span className="cl-label">{t('np.trackNumber','Track')}</span>: <span className="cl-value">{track.trackNumber}{album.totalTracks?` / ${album.totalTracks}`:''}{track.discNumber>1?` · Disc ${track.discNumber}`:''}</span></li>
            )}
            <li><span className="cl-label">{t('np.duration','Duration')}</span>: <span className="cl-value">{fmt(track.durationMs)}</span></li>
            {typeof track.explicit === 'boolean' && (
              <li><span className="cl-label">{t('np.explicit','Explicit')}</span>: <span className="cl-value">{track.explicit ? t('np.yes','Yes') : t('np.no','No')}</span></li>
            )}
            {writersLoading && (
              <li className="loading"><span className="cl-label">{t('np.writers','Writers')}</span>: <span className="cl-value">{t('np.loading','Loading')}</span></li>
            )}
            {!writersLoading && writers && writers.length>0 && (
              <li><span className="cl-label">{t('np.writers','Writers')}</span>: <span className="cl-value">{writers.join(', ')}</span></li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
