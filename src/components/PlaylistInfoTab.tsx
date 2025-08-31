import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../core/i18n';
import { SpotifyTrack, SpotifyPlaylist } from '../core/spotify'
import { useSpotifyClient } from '../core/spotify-client'
import { usePlaylists } from '../core/playlists';
import { usePlaybackActions, usePlaybackSelector } from '../core/playback';
import TrackList from './TrackList';
import { usePrompt } from '../core/PromptContext';
import { useAlerts } from '../core/alerts';

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

export default function PlaylistInfoTab({ playlistId, onSelectPlaylist, onSelectTrack }: { playlistId?: string; onSelectPlaylist?: (id: string) => void; onSelectTrack?: (id: string) => void }){
  const { t } = useI18n();
  const [playlist, setPlaylist] = useState<SpotifyPlaylist|undefined>();
  const [tracks, setTracks] = useState<SpotifyTrack[]|undefined>();
  const [loading, setLoading] = useState(false);
  const { setQueue, enqueue } = usePlaybackActions();
  const queueIds = usePlaybackSelector(s => s.queueIds ?? []);
  const currentIndex = usePlaybackSelector(s => s.currentIndex ?? 0);
  const { playlists, getPlaylistTracks, getPlaylistTrackIds, updatePlaylist, deletePlaylist, removeTrack, refresh, createPlaylistWithTracks } = usePlaylists();
  const spotifyClient = useSpotifyClient();
  const prompt = usePrompt();
  const { push: pushAlert } = useAlerts();

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
    let cancelled = false; 
    
    setPlaylist(undefined); setTracks(undefined);
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
          
          if(!localRec){ 
            setLoading(false); 
            return; 
          }
          // Minimal playlist object shim
          const shim: SpotifyPlaylist = { id: playlistId, name: localRec.code==='favorites' ? t('pl.favorites','Favorites') : localRec.name, images: [], totalTracks: localRec.track_count || 0 } as any;
          
          // Get stored tracks with metadata (no API calls needed!)
          const storedTracks = await getPlaylistTracks(localRec.id);

          // Check if we have stored metadata or need to fetch from API (legacy support)
          if(storedTracks.length > 0 && storedTracks[0]?.name) {
            // We have stored metadata, use it directly
            if(cancelled) return; 
            setPlaylist(shim); 
            setTracks(storedTracks); 
            setLoading(false); 
            return;
          }

          // Legacy fallback: fetch track metadata for stored ids (for old playlists without stored metadata)
          const ids = await getPlaylistTrackIds(localRec.id);
          if(ids.length === 0) {
            // Empty playlist
            if(cancelled) return; 
            setPlaylist(shim); 
            setTracks([]); 
            setLoading(false); 
            return;
          }
          
          const w:any = window;
          const out: SpotifyTrack[] = [];
          for(const id of ids){
            if(cancelled) break;
            try {
              let tr: SpotifyTrack|undefined;
              if(w.electron?.spotify?.getTrack){
                tr = await w.electron.spotify.getTrack(id);
              } else {
                tr = await spotifyClient.getTrack(id);
              }
              if(tr) out.push(tr);
            } catch { /* ignore individual */ }
          }
          if(cancelled) return; setPlaylist(shim); setTracks(out); setLoading(false); return;
        }
        // Spotify remote playlist - try to load metadata first so header (title + cover) can render
        const w:any = window;
        try {
          // Electron helpers (prefer metadata + tracks split if available)
          if (w.electron?.spotify?.getPlaylistMetadata) {
            const meta = await w.electron.spotify.getPlaylistMetadata(playlistId!);
            if (cancelled) return;
            setPlaylist(meta);
            // Now fetch tracks (try electron helper or fallback to full getPlaylist)
            let tr: any[] = [];
            if (w.electron?.spotify?.getPlaylistTracks) {
              tr = await w.electron.spotify.getPlaylistTracks(playlistId!);
            } else if (w.electron?.spotify?.getPlaylist) {
              const pll = await w.electron.spotify.getPlaylist(playlistId!);
              tr = pll.tracks || [];
            }
            if (cancelled) return; setTracks(tr);
          } else if ((spotifyClient as any).getPlaylistMetadata) {
            // spotifyClient helpers (metadata then tracks)
            const meta = await (spotifyClient as any).getPlaylistMetadata(playlistId!);
            if (cancelled) return;
            setPlaylist(meta);
            let tr: any[] = [];
            if ((spotifyClient as any).getPlaylistTracks) {
              tr = await (spotifyClient as any).getPlaylistTracks(playlistId!);
            } else {
              const pll = await spotifyClient.getPlaylist(playlistId!);
              tr = pll.tracks || [];
            }
            if (cancelled) return; setTracks(tr);
          } else {
            // Fallback to existing combined call
            if(w.electron?.spotify?.getPlaylist){
              const pll = await w.electron.spotify.getPlaylist(playlistId!);
              if(cancelled) return; setPlaylist(pll.playlist); setTracks(pll.tracks);
            } else {
              const pll = await spotifyClient.getPlaylist(playlistId!);
              if(cancelled) return; setPlaylist(pll.playlist); setTracks(pll.tracks);
            }
          }
        } catch (e) {
          // If any of the split calls fail, fallback to the combined fetch
          try {
            if(w.electron?.spotify?.getPlaylist){
              const pll = await w.electron.spotify.getPlaylist(playlistId!);
              if(cancelled) return; setPlaylist(pll.playlist); setTracks(pll.tracks);
            } else {
              const pll = await spotifyClient.getPlaylist(playlistId!);
              if(cancelled) return; setPlaylist(pll.playlist); setTracks(pll.tracks);
            }
          } catch (_) { /* ignore */ }
        }
      } catch { /* ignore */ }
      finally { if(!cancelled) setLoading(false); }
    }
    run();
    return ()=>{ cancelled = true; };
  }, [playlistId, playlists, getPlaylistTracks, getPlaylistTrackIds, t]);

  const heroImage = useMemo(()=> playlist?.images?.[0]?.url || '', [playlist]);
  const totalDuration = useMemo(()=> tracks?.reduce((a,b)=> a + (b.durationMs||0),0) || 0, [tracks]);
  // artist col width handled by TrackList

  // Delete track handler for local playlists
  const handleDeleteTrack = React.useCallback(async (trackId: string) => {
    if (!isLocalPlaylist || !localPlaylistRecord) {
      console.log('❌ Delete track failed: not a local playlist or no record', { isLocalPlaylist, localPlaylistRecord });
      return;
    }
    
    console.log('🗑️ Delete track called:', trackId, 'from playlist:', localPlaylistRecord.id);
    
    // Confirm deletion
    if (confirm(t('pl.removeTrackConfirm', 'Remove track from playlist?'))) {
      console.log('🗑️ User confirmed deletion, calling removeTrack');
      
      try {
        // Call the database operation
        await removeTrack(localPlaylistRecord.id, trackId);
        console.log('🗑️ Track successfully removed from database');
        
      } catch (error) {
        console.error('🗑️ Failed to remove track:', error);
        // Show error to user or refresh to show current state
        refresh();
      }
    }
  }, [isLocalPlaylist, localPlaylistRecord, removeTrack, t, refresh]);

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
                <button
                  className="np-icon"
                  aria-label={t('player.addPlaylist')}
                  disabled={!playlist || !tracks?.length}
                    onClick={async ()=>{
                    if(isLocalPlaylist || !playlist) return;
                    const defaultName = playlist.name || t('pl.new.item','New Playlist');
                    const name = (await prompt.prompt(t('pl.clonePrompt','Save playlist as'), defaultName))?.trim();
                    if(!name) return;
                    // Pass the full track objects instead of just IDs
                    const trackObjects = tracks || [];
                    try {
                      const newId = await createPlaylistWithTracks(name, trackObjects);
                      if(newId && onSelectPlaylist) {
                        setTimeout(() => { onSelectPlaylist(`local:${newId}`); }, 50);
                      }
                      pushAlert(t('pl.created','Playlist created'), 'info');
                    } catch(error) {
                      console.error('Error during playlist cloning:', error);
                      pushAlert(t('pl.createFailed','Failed to create playlist'), 'error');
                    }
                  }}
                >
                  <span className="material-symbols-rounded">add_circle</span>
                </button>
              )}
              {canModify && (
                <>
                  <button
                    className="np-icon"
                    aria-label={t('pl.editPlaylist','Edit playlist')}
                    onClick={async ()=>{
                      if(!localPlaylistRecord) return;
                      const newName = await prompt.prompt(t('pl.renamePlaylist','Rename playlist'), localPlaylistRecord.name || '');
                      if(!newName) return;
                      const trimmed = newName.trim();
                      if(trimmed && trimmed !== localPlaylistRecord.name){
                        await updatePlaylist(localPlaylistRecord.id, { name: trimmed });
                        pushAlert(t('pl.updated','Playlist renamed'), 'info');
                      }
                    }}
                  >
                    <span className="material-symbols-rounded filled" aria-hidden="true">edit</span>
                  </button>
                  <button
                    className="np-icon"
                    aria-label={t('pl.deletePlaylist','Delete playlist')}
                    onClick={async ()=>{
                      if(!localPlaylistRecord) return;
                      const ok = await prompt.confirm(t('pl.deleteConfirm','Delete playlist?'));
                      if(!ok) return;
                      try { window.dispatchEvent(new CustomEvent('freely:localDataCleared')); } catch(_) {}
                      try {
                        await deletePlaylist(localPlaylistRecord.id);
                        pushAlert(t('pl.deleted','Playlist deleted'), 'info');
                      } catch(e) { console.warn('deletePlaylist failed', e); pushAlert(t('pl.deleteFailed','Failed to delete playlist'), 'error'); }
                      setPlaylist(undefined); setTracks(undefined); refresh();
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
                    const currentSegment = (queueIds || []).slice(currentIndex || 0); // trimmed queue (playback may already trim older items)
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
          <TrackList 
            tracks={tracks} 
            playingTrackId={(queueIds || [])[currentIndex || 0]} 
            showPlayButton
            onSelectTrack={onSelectTrack}
            onDeleteTrack={isLocalPlaylist ? handleDeleteTrack : undefined}
          />
        )}
      </div>
    </section>
  );
}
