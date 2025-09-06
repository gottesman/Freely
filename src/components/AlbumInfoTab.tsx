import React, { useEffect, useMemo, useState, useCallback } from 'react';
import InfoHeader from './InfoHeader';
import { useI18n } from '../core/i18n';
import SpotifyClient, { type SpotifyAlbum, type SpotifyArtist, type SpotifyTrack } from '../core/spotify';
import { useSpotifyClient } from '../core/spotify-client';
import { usePlaybackSelector } from '../core/playback';
import TrackList from './TrackList';
import { fmtMs, useHeroImage } from './tabHelpers';

// use fmtMs from shared helpers

export default function AlbumInfoTab({ albumId }: { albumId?: string }){
  const { t } = useI18n();
  const spotifyClient = useSpotifyClient();
  const [album, setAlbum] = useState<SpotifyAlbum|undefined>();
  const [tracks, setTracks] = useState<SpotifyTrack[]|undefined>();
  const [primaryArtist, setPrimaryArtist] = useState<SpotifyArtist|undefined>();
  const [loadingAlbum, setLoadingAlbum] = useState(false);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [loadingArtist, setLoadingArtist] = useState(false);
  const queueIds = usePlaybackSelector(s => s.queueIds ?? []);
  const currentIndex = usePlaybackSelector(s => s.currentIndex ?? 0);

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

  const heroImage = useMemo(() => useHeroImage(album?.images, 0), [album?.images]);
  const releaseYear = album?.releaseDate ? album.releaseDate.split('-')[0] : undefined;
  const genres = useMemo(() => primaryArtist?.genres ?? [], [primaryArtist?.genres]);
  // artist col width handled by TrackList

  const headerActions = [
    <button key="add" className="np-icon" aria-label={t('player.addPlaylist')} disabled><span className="material-symbols-rounded">add_circle</span></button>,
    <button
      key="play"
      className="np-icon"
      aria-label={t('player.playAlbum')}
      disabled={!tracks?.length}
      onClick={() => {
        if (!tracks?.length) return;
        const currentSegment = (queueIds || []).slice(currentIndex || 0);
        const trackIds = tracks.map((t) => t.id).filter(Boolean);
        const dedupSet = new Set(trackIds);
        const filteredCurrent = currentSegment.filter((id) => !dedupSet.has(id));
  const newQueue = [...trackIds, ...filteredCurrent];
  window.dispatchEvent(new CustomEvent('freely:playback:setQueue',{ detail:{ queueIds:newQueue, startIndex:0 } }));
      }}
    ><span className="material-symbols-rounded filled">play_arrow</span></button>,
    <button
      key="queue"
      className="np-icon"
      aria-label={t('player.addToQueue')}
      disabled={!tracks?.length}
      onClick={() => {
        if (!tracks?.length) return;
        const trackIds = tracks.map((t) => t.id).filter(Boolean);
        const existing = new Set(queueIds);
        const toAppend = trackIds.filter((id) => !existing.has(id));
  if (toAppend.length) window.dispatchEvent(new CustomEvent('freely:playback:enqueue',{ detail:{ ids: toAppend } }));
      }}
    ><span className="material-symbols-rounded">queue</span></button>
  ];

  const metaNode = album ? (
    <div className="np-meta-line">
      <span className="np-artists">
        {album.artists.map((a, i) => (
          <React.Fragment key={a.id || a.name}>{i > 0 && <span className="np-sep">, </span>}<button type="button" className="np-link artist" onClick={() => { if (a.id) window.dispatchEvent(new CustomEvent('freely:selectArtist',{ detail:{ artistId:a.id, source:'album-info' } })); else if (a.url) window.open(a.url, '_blank'); }}>{a.name}</button></React.Fragment>
        ))}
      </span>
      {releaseYear && <><span className="np-dot" /><span className="np-album-year">{releaseYear}</span></>}
      <span className="np-dot" /><span className="np-album-trackcount">{t('np.tracks', undefined, { count: album.totalTracks })}</span>
    </div>
  ) : (albumId ? t('np.loading') : t('np.noTrack'));

  return (
    <section className="now-playing" aria-labelledby="album-heading">
      <InfoHeader id="album-heading" title={album ? album.name : metaNode} meta={album ? metaNode : undefined} tags={genres} actions={headerActions} heroImage={heroImage} ariaActionsLabel={t('np.albumActions','Album actions')} />
      <div className="np-section np-album-tracks" aria-label={t('np.albumTrackList','Album track list')}>
        <h4 className="np-sec-title">{t('np.tracksList','Tracks')}</h4>
        {loadingTracks && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {!loadingTracks && !tracks && albumId && <p className="np-hint">{t('np.loading')}</p>}
        {!loadingTracks && tracks && (
          <TrackList tracks={tracks} playingTrackId={(queueIds || [])[currentIndex || 0]} showPlayButton />
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
