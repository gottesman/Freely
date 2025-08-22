import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../core/i18n';
import { usePlayback } from '../core/playback';
import SpotifyClient, { type SpotifyAlbum, type SpotifyArtist, type SpotifyTrack } from '../core/spotify';
import TrackList from './TrackList';
import GeniusClient from '../core/musicdata';

function fmt(ms?: number){
  if(!ms && ms!==0) return '--:--';
  const total = Math.floor(ms/1000); const m = Math.floor(total/60); const s = total%60; return m+':' + (s<10?'0':'')+s;
}

export default function SongInfoTab({ trackId, onSelectArtist, onSelectAlbum, onSelectTrack }: { trackId?: string, onSelectArtist?: (id: string)=>void, onSelectAlbum?: (id: string)=>void, onSelectTrack?: (id: string)=>void }){
  const { t } = useI18n();
  // Playback context (avoid calling hook inside handlers)
  const { currentTrack: playbackTrack, queueIds, setQueue, enqueue, currentIndex } = usePlayback();
  const [track, setTrack] = useState<SpotifyTrack | undefined>();
  const [album, setAlbum] = useState<SpotifyAlbum|undefined>();
  const [primaryArtist, setPrimaryArtist] = useState<SpotifyArtist|undefined>();
  const [albumTracks, setAlbumTracks] = useState<SpotifyTrack[]|undefined>();
  const [tracksLoading, setTracksLoading] = useState(false);
  // (Removed artist biography display; we now show track credits instead.)
  const [writers, setWriters] = useState<string[]|undefined>();
  const [writersLoading, setWritersLoading] = useState(false);
  const effectiveTrackId = trackId || playbackTrack?.id;

  // Load (or reuse) track details
  useEffect(()=>{
    let cancelled = false;
    async function load(){
      setTrack(undefined);
      if(!effectiveTrackId) return;
      if(playbackTrack && playbackTrack.id === effectiveTrackId){ setTrack(playbackTrack); return; }
      const w:any = window;
      try {
        if(w.electron?.spotify?.getTrack){
          const tr: SpotifyTrack = await w.electron.spotify.getTrack(effectiveTrackId);
          if(!cancelled) setTrack(tr);
        } else {
          const client = new SpotifyClient();
          const tr = await client.getTrack(effectiveTrackId);
          if(!cancelled) setTrack(tr);
        }
      } catch { /* ignore */ }
    }
    load();
    return ()=> { cancelled = true; };
  }, [effectiveTrackId, playbackTrack?.id]);

  // Album + primary artist
  useEffect(()=>{
    let cancelled = false;
    async function run(){
      setAlbum(undefined); setPrimaryArtist(undefined); setAlbumTracks(undefined);
      if(!track) return;
      const w:any = window;
      const client = (!w.electron?.spotify?.getAlbum || !w.electron?.spotify?.getArtist) ? new SpotifyClient() : null;
      const albumId = track.album?.id; const artistId = track.artists?.[0]?.id;
      const albumPromise = (async()=>{ if(!albumId) return; try { if(w.electron?.spotify?.getAlbum) return await w.electron.spotify.getAlbum(albumId); if(client) return await client.getAlbum(albumId);} catch{} })();
      const artistPromise = (async()=>{ if(!artistId) return; try { if(w.electron?.spotify?.getArtist) return await w.electron.spotify.getArtist(artistId); if(client) return await client.getArtist(artistId);} catch{} })();
      const [alb, art] = await Promise.all([albumPromise, artistPromise]);
      if(cancelled) return; if(alb) setAlbum(alb); if(art) setPrimaryArtist(art);
    }
    run();
    return ()=>{ cancelled = true; };
  }, [track?.id]);

  // Album tracks
  useEffect(()=>{
    let cancelled = false;
    async function loadTracks(){
      setAlbumTracks(undefined);
      if(!track?.album?.id) return;
      const w:any = window; setTracksLoading(true);
      try {
        let items: SpotifyTrack[] | undefined;
        if(w.electron?.spotify?.getAlbumTracks){ const res = await w.electron.spotify.getAlbumTracks(track.album.id); items = res.items || []; }
        else { try { const client = new SpotifyClient(); const res = await client.getAlbumTracks(track.album.id, { fetchAll:false, limit:50 }); items = res.items; } catch{} }
        if(!cancelled && items) setAlbumTracks(items);
      } finally { if(!cancelled) setTracksLoading(false); }
    }
    loadTracks();
    return ()=>{ cancelled = true; };
  }, [track?.album?.id]);

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

  const heroImage = useMemo(()=> album?.images?.[0]?.url || track?.album?.images?.[0]?.url || '/icon-192.png', [album, track?.album?.images]);
  const releaseYear = album?.releaseDate ? (album.releaseDate.split('-')[0]) : undefined;
  const genres = primaryArtist?.genres?.slice(0,3) || [];
  const artistColWidth = useMemo(()=>{ if(!albumTracks?.length) return undefined; const names = albumTracks.map(t=> t.artists?.[0]?.name || ''); const longest = names.reduce((a,b)=> b.length>a.length? b:a,''); if(!longest) return undefined; const avgCharPx=7.2; const padding=28; return Math.min(240, Math.max(80, Math.round(longest.length*avgCharPx+padding))); }, [albumTracks]);

  return (
    <section className="now-playing" aria-labelledby="np-heading">
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
        {!track && effectiveTrackId && <p className="np-hint">{t('np.loading')}</p>}
        {!effectiveTrackId && <p className="np-hint">{t('np.selectTrackHint')}</p>}
        {tracksLoading && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {albumTracks && (
          <TrackList
            tracks={albumTracks}
            selectedTrackId={track?.id}
            playingTrackId={playbackTrack?.id}
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
