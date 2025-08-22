import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../core/i18n';
import SpotifyClient, { type SpotifyPlaylist, type SpotifyTrack } from '../core/spotify';
import { usePlaylists } from '../core/playlists';
import { useDB } from '../core/db';
import { usePlayback } from '../core/playback';
import TrackList from './TrackList';

function fmt(ms?: number){ // track-level mm:ss
  if(ms === undefined) return '--:--';
  const total = Math.floor(ms/1000); const m = Math.floor(total/60); const s = total%60; return m+':' + (s<10?'0':'')+s;
}
function fmtTotal(ms?: number){ // playlist-level formatting per spec
  if(ms === undefined) return '--';
  const totalSec = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if(h >= 1) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

export default function PlaylistInfoTab({ playlistId }: { playlistId?: string }){
  const { t } = useI18n();
  const [playlist, setPlaylist] = useState<SpotifyPlaylist|undefined>();
  const [tracks, setTracks] = useState<SpotifyTrack[]|undefined>();
  const [loading, setLoading] = useState(false);
  const { queueIds, setQueue, enqueue, currentIndex } = usePlayback();
  const { playlists, getPlaylistTrackIds, updatePlaylist, deletePlaylist, refresh } = usePlaylists();
  const { db } = useDB();

  // Determine if current playlist is a local (favorites or user-created) playlist so we can adjust UI (e.g., hide add button)
  const isLocalPlaylist = useMemo(()=>{
    if(!playlistId) return false;
    if(playlistId === 'favorites') return true;
    if(playlistId.startsWith('local:')) return true;
    // Numeric fallback treated as local (Spotify playlist IDs are base62, not purely numeric)
    if(/^\d+$/.test(playlistId)) return true;
    return false;
  }, [playlistId]);

  const isFavorites = playlistId === 'favorites';

  // Resolve local playlist record if applicable for edit/delete operations
  const localPlaylistRecord = useMemo(()=>{
    if(!isLocalPlaylist || !playlistId) return undefined;
    if(playlistId === 'favorites') return playlists.find(p=> p.code === 'favorites');
    if(playlistId.startsWith('local:')){
      const numeric = Number(playlistId.slice('local:'.length));
      return playlists.find(p=> p.id === numeric);
    }
    if(/^\d+$/.test(playlistId)){
      const numeric = Number(playlistId);
      return playlists.find(p=> p.id === numeric);
    }
    return undefined;
  }, [isLocalPlaylist, playlistId, playlists]);

  const canModify = !!localPlaylistRecord && !localPlaylistRecord.system && !isFavorites;

  useEffect(()=>{
    let cancelled = false; setPlaylist(undefined); setTracks(undefined);
  if(!playlistId){ setLoading(false); return; }
    async function run(){
      setLoading(true);
      try {
  // Local playlist detection: 'favorites' system code OR 'local:<numericId>' OR plain numeric id string.
  const isNumeric = !!playlistId && /^\d+$/.test(playlistId);
  if(playlistId && (playlistId === 'favorites' || playlistId.startsWith('local:') || isNumeric)){
          // Local playlist
          const lookupId = playlistId;
          const localRec = playlists.find(p => (
            lookupId === 'favorites'
              ? p.code === 'favorites'
              : lookupId.startsWith('local:')
                ? ('local:'+p.id) === lookupId
                : String(p.id) === lookupId
          ));
          if(!localRec){ setLoading(false); return; }
          // Minimal playlist object shim
          const shim: SpotifyPlaylist = { id: playlistId, name: localRec.code==='favorites' ? t('pl.favorites','Favorites') : localRec.name, images: [], totalTracks: localRec.track_count || 0 } as any;
          // Fetch track metadata for stored ids
          const ids = getPlaylistTrackIds(localRec.id);
          const w:any = window;
          const out: SpotifyTrack[] = [];
          for(const id of ids){
            if(cancelled) break;
            try {
              let tr: SpotifyTrack|undefined;
              if(w.electron?.spotify?.getTrack){
                tr = await w.electron.spotify.getTrack(id);
              } else {
                const client = new SpotifyClient();
                tr = await client.getTrack(id);
              }
              if(tr) out.push(tr);
            } catch { /* ignore individual */ }
          }
          if(cancelled) return; setPlaylist(shim); setTracks(out); setLoading(false); return;
        }
        // Spotify remote playlist
        const w:any = window;
        if(w.electron?.spotify?.getPlaylist){
          const pll = await w.electron.spotify.getPlaylist(playlistId!);
          if(cancelled) return; setPlaylist(pll.playlist); setTracks(pll.tracks);
        } else {
          const client = new SpotifyClient();
          const pll = await client.getPlaylist(playlistId!);
          if(cancelled) return; setPlaylist(pll.playlist); setTracks(pll.tracks);
        }
      } catch { /* ignore */ }
      finally { if(!cancelled) setLoading(false); }
    }
    run();
    return ()=>{ cancelled = true; };
  }, [playlistId, playlists, getPlaylistTrackIds, t]);

  const heroImage = useMemo(()=> playlist?.images?.[0]?.url || '', [playlist]);
  const totalDuration = useMemo(()=> tracks?.reduce((a,b)=> a + (b.durationMs||0),0) || 0, [tracks]);
  // artist col width handled by TrackList

  return (
    <section className="now-playing" aria-labelledby="playlist-heading">
      <header className="np-hero" style={{ ['--hero-image' as any]: `url(${heroImage})` }}>
        <div className="np-hero-inner">
          <h1 id="playlist-heading" className="np-title" style={{display:'flex', alignItems:'center'}}>
            {playlist && isFavorites && (
              <span className="material-symbols-rounded filled" aria-hidden="true" style={{fontSize:31, display:'inline-flex', alignItems:'center', justifyContent:'center'}}>star</span>
            )}
            { playlist ? (
              <>
                {playlist.name}
              </>
            ) : (playlistId ? t('np.loading') : t('np.noTrack')) }
          </h1>          
            <div className="np-meta-line">
                {playlist && (
                  <>
                    {playlist.totalTracks !== undefined && <><span className="np-album-trackcount">{t('np.tracks', undefined, { count: playlist.totalTracks })}</span></>}
                    <span className="np-dot" />
                    <span className="np-album-year">{fmtTotal(totalDuration)}</span>
                  </>
                )}
            </div>
          <div className="np-extras">
            <div className="np-tags disabled" aria-label={t('pl.playlistType','Playlist Type')}>{playlist && <span className="tag">{ isLocalPlaylist ? t('pl.local','Local playlist') : t('pl.remote','Remote playlist')}</span>}</div>
            <div className="np-actions" aria-label={t('np.playlistActions','Playlist actions')}>
              {!isLocalPlaylist && (
                <button className="np-icon" aria-label={t('player.addPlaylist')} disabled>
                  <span className="material-symbols-rounded">add_circle</span>
                </button>
              )}
              {canModify && (
                <>
                  <button
                    className="np-icon"
                    aria-label={t('pl.editPlaylist','Edit playlist')}
                    onClick={()=>{
                      if(!localPlaylistRecord) return;
                      const newName = prompt(t('pl.renamePlaylist','Rename playlist'), localPlaylistRecord.name || '');
                      if(!newName) return;
                      const trimmed = newName.trim();
                      if(trimmed && trimmed !== localPlaylistRecord.name){
                        updatePlaylist(localPlaylistRecord.id, { name: trimmed });
                      }
                    }}
                  >
                    <span className="material-symbols-rounded filled" aria-hidden="true">edit</span>
                  </button>
                  <button
                    className="np-icon"
                    aria-label={t('pl.deletePlaylist','Delete playlist')}
                    onClick={()=>{
                      if(!localPlaylistRecord) return;
                      if(confirm(t('pl.deleteConfirm','Delete playlist?'))){
                        deletePlaylist(localPlaylistRecord.id);
                        // Clear current view since playlist is gone
                        setPlaylist(undefined); setTracks(undefined); refresh();
                      }
                    }}
                  >
                    <span className="material-symbols-rounded filled" aria-hidden="true">delete</span>
                  </button>
                </>
              )}
                <button
                    className="np-icon"
                    aria-label={t('player.playPlaylist')}
                    disabled={!tracks?.length}
                    onClick={()=>{
                    if(!tracks?.length) return;
                    const currentSegment = queueIds.slice(currentIndex); // trimmed queue (playback may already trim older items)
                    const trackIds = tracks.map(t=> t.id).filter(Boolean);
                    // Avoid duplicating: remove any of these ids already in current segment before prepending
                    const dedupSet = new Set(trackIds);
                    const filteredCurrent = currentSegment.filter(id => !dedupSet.has(id));
                    const newQueue = [...trackIds, ...filteredCurrent];
                    setQueue(newQueue, 0);
                    }}
                >
                    <span className="material-symbols-rounded filled" aria-hidden="true">play_arrow</span>
                </button>
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
                >
                    <span className="material-symbols-rounded" aria-hidden="true">queue</span>
                </button>
            </div>
          </div>
        </div>
      </header>
      <div className="np-section np-album-tracks" aria-label={t('np.playlistTrackList','Playlist track list')}>
        <h4 className="np-sec-title">{t('np.tracksList','Tracks')}</h4>
        {loading && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {!loading && !tracks && playlistId && <p className="np-hint">{t('np.loading')}</p>}
        {!loading && tracks && (
          <TrackList tracks={tracks} playingTrackId={queueIds[currentIndex]} />
        )}
      </div>
    </section>
  );
}
