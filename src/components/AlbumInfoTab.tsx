import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../core/i18n';
import SpotifyClient, { type SpotifyAlbum, type SpotifyArtist, type SpotifyTrack } from '../core/spotify';
import { useSpotifyClient } from '../core/spotify-client';
import { usePlayback } from '../core/playback';
import TrackList from './TrackList';

function fmt(ms?: number){
  if(!ms && ms!==0) return '--:--';
  const total = Math.floor(ms/1000); const m = Math.floor(total/60); const s = total%60; return m+':' + (s<10?'0':'')+s;
}

export default function AlbumInfoTab({ albumId, onSelectArtist, onSelectTrack }: { albumId?: string, onSelectArtist?: (id: string)=>void, onSelectTrack?: (id: string)=>void }){
  const { t } = useI18n();
  const spotifyClient = useSpotifyClient();
  const [album, setAlbum] = useState<SpotifyAlbum|undefined>();
  const [tracks, setTracks] = useState<SpotifyTrack[]|undefined>();
  const [primaryArtist, setPrimaryArtist] = useState<SpotifyArtist|undefined>();
  const [loadingAlbum, setLoadingAlbum] = useState(false);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [loadingArtist, setLoadingArtist] = useState(false);
  const { queueIds, setQueue, enqueue, currentIndex } = usePlayback();

  // Load album
  useEffect(()=>{
    let cancelled = false; setAlbum(undefined); setTracks(undefined); setPrimaryArtist(undefined);
    if(!albumId) return;
  async function run(){
      setLoadingAlbum(true);
      const w:any = window;
      try {
        let alb: SpotifyAlbum | undefined;
    if(!albumId) return; // safety
    if(w.electron?.spotify?.getAlbum){ alb = await w.electron.spotify.getAlbum(albumId); }
    else { alb = await spotifyClient.getAlbum(albumId); }
        if(cancelled) return; setAlbum(alb);
      } catch { /* ignore */ }
      finally { if(!cancelled) setLoadingAlbum(false); }
    }
    run();
    return ()=>{ cancelled = true; };
  }, [albumId, spotifyClient]);

  // Load tracks
  useEffect(()=>{
    let cancelled = false; setTracks(undefined);
    if(!albumId) return;
  async function run(){
      setLoadingTracks(true);
      const w:any = window;
      try {
    if(!albumId) return; // safety
        if(w.electron?.spotify?.getAlbumTracks){
          const res = await w.electron.spotify.getAlbumTracks(albumId); if(!cancelled) setTracks(res.items || []);
        } else {
      try { const res = await spotifyClient.getAlbumTracks(albumId, { fetchAll:false, limit:50 }); if(!cancelled) setTracks(res.items); } catch {}
        }
      } finally { if(!cancelled) setLoadingTracks(false); }
    }
    run();
    return ()=>{ cancelled = true; };
  }, [albumId, spotifyClient]);

  // Load primary artist (first) for extra metadata
  useEffect(()=>{
    let cancelled = false; setPrimaryArtist(undefined);
    if(!album?.artists?.[0]?.id) return;
    async function run(){
      setLoadingArtist(true);
      const artistId = album?.artists?.[0]?.id; if(!artistId){ setLoadingArtist(false); return; }
      const w:any = window;
      try {
        let art: SpotifyArtist | undefined;
        if(w.electron?.spotify?.getArtist){ art = await w.electron.spotify.getArtist(artistId); }
        else { art = await spotifyClient.getArtist(artistId); }
        if(cancelled) return; setPrimaryArtist(art);
      } catch { }
      finally { if(!cancelled) setLoadingArtist(false); }
    }
    run();
    return ()=>{ cancelled = true; };
  }, [album?.artists?.[0]?.id, spotifyClient]);

  const heroImage = (window as any).imageRes?.(album?.images, 0);
  const releaseYear = album?.releaseDate ? album.releaseDate.split('-')[0] : undefined;
  const genres = primaryArtist?.genres?.slice(0,3) || [];
  // artist col width handled by TrackList

  return (
    <section className="now-playing" aria-labelledby="album-heading">
      <header className="np-hero" style={{ ['--hero-image' as any]: `url(${heroImage})` }}>
        <div className="np-hero-inner">
          <h1 id="album-heading" className="np-title">{ album ? album.name : (albumId ? t('np.loading') : t('np.noTrack')) }</h1>
          {album && (
            <div className="np-meta-line">
              <span className="np-artists">
                {album.artists.map((a,i)=>(<React.Fragment key={a.id||a.name}>{i>0 && <span className="np-sep">, </span>}<button type="button" className="np-link artist" onClick={()=> { if(onSelectArtist && a.id) onSelectArtist(a.id); else if(a.url) window.open(a.url,'_blank'); }}>{a.name}</button></React.Fragment>))}
              </span>
              {releaseYear && <><span className="np-dot" /><span className="np-album-year">{releaseYear}</span></>}
              <span className="np-dot" /><span className="np-album-trackcount">{t('np.tracks', undefined, { count: album.totalTracks })}</span>
            </div>
          )}
          <div className="np-extras">
            <div className="np-tags" aria-label={t('np.genresTags')}>{genres.length? genres.map(g=> <span key={g} className="tag">{g}</span>) : <span className="tag">—</span>}</div>
            <div className="np-actions" aria-label={t('np.albumActions','Album actions')}>
                <button className="np-icon" aria-label={t('player.addPlaylist')} disabled><span className="material-symbols-rounded">add_circle</span></button>
                <button
                    className="np-icon"
                    aria-label={t('player.playAlbum')}
                    disabled={!tracks?.length}
                    onClick={()=>{
                        if(!tracks?.length) return;
                        const currentSegment = queueIds.slice(currentIndex);
                        const trackIds = tracks.map(t=> t.id).filter(Boolean);
                        const dedupSet = new Set(trackIds);
                        const filteredCurrent = currentSegment.filter(id => !dedupSet.has(id));
                        const newQueue = [...trackIds, ...filteredCurrent];
                        setQueue(newQueue, 0);
                    }}
                ><span className="material-symbols-rounded filled">play_arrow</span></button>
                <button
                    className="np-icon"
                    aria-label={t('player.addToQueue')}
                    disabled={!tracks?.length}
                    onClick={()=>{
                        if(!tracks?.length) return;
                        const trackIds = tracks.map(t=> t.id).filter(Boolean);
                        const existing = new Set(queueIds);
                        const toAppend = trackIds.filter(id => !existing.has(id));
                        if(toAppend.length) enqueue(toAppend);
                    }}
                ><span className="material-symbols-rounded">queue</span></button>
            </div>
          </div>
        </div>
      </header>
      <div className="np-section np-album-tracks" aria-label={t('np.albumTrackList','Album track list')}>
        <h4 className="np-sec-title">{t('np.tracksList','Tracks')}</h4>
        {loadingTracks && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {!loadingTracks && !tracks && albumId && <p className="np-hint">{t('np.loading')}</p>}
        {!loadingTracks && tracks && (
          <TrackList tracks={tracks} playingTrackId={queueIds[currentIndex]} showPlayButton onSelectTrack={onSelectTrack} />
        )}
      </div>
      <div className="np-section np-track-credits" aria-label={t('np.albumCredits','Album credits')}>
        <h4 className="np-sec-title">{t('np.albumCredits','Credits')}</h4>
        {!album && loadingAlbum && <p className="np-hint">{t('np.loading')}</p>}
        {album && (
          <ul className="credits-list">
            <li><span className="cl-label">{t('np.artists','Artists')}</span>: <span className="cl-value">{album.artists.map(a=> a.name).join(', ')}</span></li>
            {album.releaseDate && (
              <li><span className="cl-label">{t('np.releaseDate','Release Date')}</span>: <span className="cl-value">{album.releaseDate}</span></li>
            )}
            {album.label && (
              <li><span className="cl-label">{t('np.label','Label')}</span>: <span className="cl-value">{album.label}</span></li>
            )}
            {album.copyrights && album.copyrights.length>0 && (
              <li><span className="cl-label">{t('np.copyright','Copyright')}</span>: <span className="cl-value">{album.copyrights[0]}</span></li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
