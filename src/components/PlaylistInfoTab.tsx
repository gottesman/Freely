import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useI18n } from '../core/i18n';
import { SpotifyTrack, SpotifyPlaylist } from '../core/spotify'
import { usePlaylists } from '../core/playlists';
import { usePlaybackSelector } from '../core/playback';
import TrackList from './TrackList';
import InfoHeader from './InfoHeader';
import { usePrompt } from '../core/PromptContext';
import { useAlerts } from '../core/alerts';

import { 
  fmtMs, 
  fmtTotalMs, 
  useHeroImage, 
  useStableTabAPI,
  usePlaybackActions,
  navigationEvents,
  playbackEvents,
  dispatchFreelyEvent
} from './tabHelpers';

// Types for better organization
interface PlaylistState {
  playlist?: SpotifyPlaylist;
  tracks?: SpotifyTrack[];
  loading: boolean;
}

interface PlaylistInfo {
  isLocal: boolean;
  isFavorites: boolean;
  canModify: boolean;
  localRecord?: any;
}

// Utility functions
const isLocalPlaylistId = (playlistId?: string): boolean => {
  if (!playlistId) return false;
  if (playlistId === 'favorites') return true;
  if (playlistId.startsWith('local:')) return true;
  // Numeric fallback treated as local (Spotify playlist IDs are base62, not purely numeric)
  if (/^\d+$/.test(playlistId)) return true;
  return false;
};

const findLocalPlaylistRecord = (playlistId: string, playlists: any[]): any => {
  if (playlistId === 'favorites') {
    return playlists.find(p => p.code === 'favorites');
  }
  if (playlistId.startsWith('local:')) {
    const numeric = Number(playlistId.slice('local:'.length));
    return playlists.find(p => p.id === numeric);
  }
  if (/^\d+$/.test(playlistId)) {
    const numeric = Number(playlistId);
    return playlists.find(p => p.id === numeric);
  }
  return undefined;
};

const createPlaylistShim = (playlistId: string, localRecord: any, t: any): SpotifyPlaylist => ({
  id: playlistId,
  name: localRecord.code === 'favorites' ? t('pl.favorites', 'Favorites') : localRecord.name,
  images: [],
  totalTracks: localRecord.track_count || 0
} as SpotifyPlaylist);

// Custom hook for playlist operations
const usePlaylistOperations = () => {
  const { createPlaylistWithTracks, updatePlaylist, deletePlaylist, removeTrack, refresh } = usePlaylists();
  const prompt = usePrompt();
  const { push: pushAlert } = useAlerts();
  const { t } = useI18n();

  const clonePlaylist = useCallback(async (playlist: SpotifyPlaylist, tracks: SpotifyTrack[]) => {
    const defaultName = playlist.name || t('pl.new.item', 'New Playlist');
    const name = (await prompt.prompt(t('pl.clonePrompt', 'Save playlist as'), defaultName))?.trim();
    if (!name) return;

    try {
      const newId = await createPlaylistWithTracks(name, tracks);
      if (newId) {
        try {
          window.dispatchEvent(new CustomEvent('freely:selectPlaylist', {
            detail: { playlistId: `local:${newId}`, source: 'playlist-clone' }
          }));
        } catch (_) {}
      }
      pushAlert(t('pl.created', 'Playlist created'), 'info');
    } catch (error) {
      console.error('Error during playlist cloning:', error);
      pushAlert(t('pl.createFailed', 'Failed to create playlist'), 'error');
    }
  }, [createPlaylistWithTracks, prompt, pushAlert, t]);

  const editPlaylist = useCallback(async (localRecord: any) => {
    const newName = await prompt.prompt(t('pl.renamePlaylist', 'Rename playlist'), localRecord.name || '');
    if (!newName) return;
    
    const trimmed = newName.trim();
    if (trimmed && trimmed !== localRecord.name) {
      await updatePlaylist(localRecord.id, { name: trimmed });
      pushAlert(t('pl.updated', 'Playlist renamed'), 'info');
    }
  }, [updatePlaylist, prompt, pushAlert, t]);

  const deletePlaylistWithConfirm = useCallback(async (localRecord: any) => {
    const ok = await prompt.confirm(t('pl.deleteConfirm', 'Delete playlist?'));
    if (!ok) return;

    try {
      window.dispatchEvent(new CustomEvent('freely:localDataCleared'));
    } catch (_) {}

    try {
      await deletePlaylist(localRecord.id);
      pushAlert(t('pl.deleted', 'Playlist deleted'), 'info');
    } catch (e) {
      console.warn('deletePlaylist failed', e);
      pushAlert(t('pl.deleteFailed', 'Failed to delete playlist'), 'error');
    }
    refresh();
  }, [deletePlaylist, prompt, pushAlert, t, refresh]);

  const removeTrackWithConfirm = useCallback(async (localRecord: any, trackId: string) => {
    if (confirm(t('pl.removeTrackConfirm', 'Remove track from playlist?'))) {
      try {
        await removeTrack(localRecord.id, trackId);
      } catch (error) {
        console.error('Failed to remove track:', error);
        refresh();
      }
    }
  }, [removeTrack, t, refresh]);

  return {
    clonePlaylist,
    editPlaylist,
    deletePlaylistWithConfirm,
    removeTrackWithConfirm
  };
};

const PlaylistInfoTab = React.memo(({ playlistId }: { playlistId?: string }) => {
  const { t } = useI18n();
  const [state, setState] = useState<PlaylistState>({
    playlist: undefined,
    tracks: undefined,
    loading: false
  });

  const queueIds = usePlaybackSelector(s => s.queueIds ?? []);
  const currentIndex = usePlaybackSelector(s => s.currentIndex ?? 0);
  const { playlists, getPlaylistTracks, getPlaylistTrackIds } = usePlaylists();
  const api = useStableTabAPI();
  const playbackActions = usePlaybackActions();
  const playlistOps = usePlaylistOperations();

  // Memoized playlist information
  const playlistInfo = useMemo((): PlaylistInfo => {
    const isLocal = isLocalPlaylistId(playlistId);
    const isFavorites = playlistId === 'favorites';
    const localRecord = isLocal && playlistId ? findLocalPlaylistRecord(playlistId, playlists) : undefined;
    const canModify = !!localRecord && !localRecord.system && !isFavorites;

    return { isLocal, isFavorites, canModify, localRecord };
  }, [playlistId, playlists]);

  // Memoized derived values
  const heroImage = useMemo(() => 
    useHeroImage(state.playlist?.images, 0), 
    [state.playlist?.images]
  );

  const totalDuration = useMemo(() => 
    state.tracks?.reduce((a, b) => a + (b.durationMs || 0), 0) || 0, 
    [state.tracks]
  );

  const playingTrackId = useMemo(() => 
    queueIds[currentIndex] || '', 
    [queueIds, currentIndex]
  );

  // Stable state updaters
  const stateActions = useMemo(() => ({
    setPlaylist: (playlist?: SpotifyPlaylist) => 
      setState(prev => ({ ...prev, playlist })),
    setTracks: (tracks?: SpotifyTrack[]) => 
      setState(prev => ({ ...prev, tracks })),
    setLoading: (loading: boolean) => 
      setState(prev => ({ ...prev, loading })),
    reset: () => 
      setState({ playlist: undefined, tracks: undefined, loading: false })
  }), []);

  // Optimized useEffect with better organization
  useEffect(() => {
    let cancelled = false;

    const loadPlaylist = async () => {
      if (!playlistId) {
        stateActions.reset();
        return;
      }

      stateActions.setLoading(true);

      try {
        if (playlistInfo.isLocal) {
          await loadLocalPlaylist();
        } else {
          await loadRemotePlaylist();
        }
      } catch (error) {
        console.error('Error loading playlist:', error);
      } finally {
        if (!cancelled) {
          stateActions.setLoading(false);
        }
      }
    };

    const loadLocalPlaylist = async () => {
      const { localRecord } = playlistInfo;
      if (!localRecord || cancelled) return;

      const shim = createPlaylistShim(playlistId!, localRecord, t);
      const storedTracks = await getPlaylistTracks(localRecord.id);

      if (cancelled) return;

      if (storedTracks.length > 0 && storedTracks[0]?.name) {
        // We have stored metadata
        stateActions.setPlaylist(shim);
        stateActions.setTracks(storedTracks);
        return;
      }

      // Legacy fallback: fetch track metadata for stored ids
      const ids = await getPlaylistTrackIds(localRecord.id);
      if (ids.length === 0) {
        stateActions.setPlaylist(shim);
        stateActions.setTracks([]);
        return;
      }

      const tracks = await fetchTracksById(ids);
      if (!cancelled) {
        stateActions.setPlaylist(shim);
        stateActions.setTracks(tracks);
      }
    };

    const loadRemotePlaylist = async () => {
      const w: any = window;

      try {
        // Try split metadata + tracks approach first
        if (w.electron?.spotify?.getPlaylistMetadata) {
          const meta = await w.electron.spotify.getPlaylistMetadata(playlistId!);
          if (cancelled) return;
          stateActions.setPlaylist(meta);

          let tracks: any[] = [];
          if (w.electron?.spotify?.getPlaylistTracks) {
            tracks = await w.electron.spotify.getPlaylistTracks(playlistId!);
          } else if (w.electron?.spotify?.getPlaylist) {
            const pll = await w.electron.spotify.getPlaylist(playlistId!);
            tracks = pll.tracks || [];
          }
          if (!cancelled) stateActions.setTracks(tracks);
          return;
        }

        // Fallback to combined call
        const pll = await api.getPlaylist(playlistId!);

        if (!cancelled) {
          stateActions.setPlaylist(pll.playlist);
          stateActions.setTracks(pll.tracks);
        }
      } catch (error) {
        console.error('Failed to load remote playlist:', error);
      }
    };

    const fetchTracksById = async (ids: string[]): Promise<SpotifyTrack[]> => {
      const w: any = window;
      const tracks: SpotifyTrack[] = [];

      for (const id of ids) {
        if (cancelled) break;
        try {
          const track = w.electron?.spotify?.getTrack 
            ? await w.electron.spotify.getTrack(id)
            : await api.getTrack(id);
          if (track) tracks.push(track);
        } catch (error) {
          console.warn('Failed to fetch track:', id, error);
        }
      }

      return tracks;
    };

    loadPlaylist();
    return () => { cancelled = true; };
  }, [playlistId, playlistInfo, stateActions, getPlaylistTracks, getPlaylistTrackIds, api, t]);

  // Event handlers
  const handleDeleteTrack = useCallback(async (trackId: string) => {
    const { isLocal, localRecord } = playlistInfo;
    if (!isLocal || !localRecord) return;
    
    await playlistOps.removeTrackWithConfirm(localRecord, trackId);
  }, [playlistInfo, playlistOps]);

  // Memoized action buttons
  const actionButtons = useMemo(() => {
    const actions: React.ReactNode[] = [];

    // Clone button for remote playlists
    if (!playlistInfo.isLocal && state.playlist && state.tracks?.length) {
      actions.push(
        <button 
          key="clone" 
          className="np-icon" 
          aria-label={t('player.addPlaylist')} 
          onClick={() => playlistOps.clonePlaylist(state.playlist!, state.tracks!)}
        >
          <span className="material-symbols-rounded">add_circle</span>
        </button>
      );
    }

    // Edit and delete buttons for modifiable local playlists
    if (playlistInfo.canModify && playlistInfo.localRecord) {
      actions.push(
        <button 
          key="edit" 
          className="np-icon" 
          aria-label={t('pl.editPlaylist', 'Edit playlist')} 
          onClick={() => playlistOps.editPlaylist(playlistInfo.localRecord!)}
        >
          <span className="material-symbols-rounded filled" aria-hidden="true">edit</span>
        </button>
      );

      actions.push(
        <button 
          key="delete" 
          className="np-icon" 
          aria-label={t('pl.deletePlaylist', 'Delete playlist')} 
          onClick={async () => {
            await playlistOps.deletePlaylistWithConfirm(playlistInfo.localRecord!);
            stateActions.reset();
          }}
        >
          <span className="material-symbols-rounded filled" aria-hidden="true">delete</span>
        </button>
      );
    }

    // Play button
    actions.push(
      <button 
        key="play" 
        className="np-icon" 
        aria-label={t('player.playPlaylist')} 
        disabled={!state.tracks?.length} 
        onClick={() => handlePlayPlaylist()}
      >
        <span className="material-symbols-rounded filled" aria-hidden="true">play_arrow</span>
      </button>
    );

    // Queue button
    actions.push(
      <button 
        key="queue" 
        className="np-icon" 
        aria-label={t('player.addToQueue')} 
        disabled={!state.tracks?.length} 
        onClick={() => handleAddToQueue()}
      >
        <span className="material-symbols-rounded" aria-hidden="true">queue</span>
      </button>
    );

    return actions;
  }, [playlistInfo, state.playlist, state.tracks, t, playlistOps, stateActions]);

  const handlePlayPlaylist = useCallback(() => {
    if (!state.tracks?.length) return;
    
    const currentSegment = queueIds.slice(currentIndex);
    const trackIds = state.tracks.map(t => t.id).filter(Boolean);
    const dedupSet = new Set(trackIds);
    const filteredCurrent = currentSegment.filter(id => !dedupSet.has(id));
    const newQueue = [...trackIds, ...filteredCurrent];
    
    window.dispatchEvent(new CustomEvent('freely:playback:setQueue', {
      detail: { queueIds: newQueue, startIndex: 0 }
    }));
  }, [state.tracks, queueIds, currentIndex]);

  const handleAddToQueue = useCallback(() => {
    if (!state.tracks?.length) return;
    
    const trackIds = state.tracks.map(t => t.id).filter(Boolean);
    const existing = new Set(queueIds);
    const toAppend = trackIds.filter(id => !existing.has(id));
    
    if (toAppend.length) {
      window.dispatchEvent(new CustomEvent('freely:playback:enqueue', {
        detail: { ids: toAppend }
      }));
    }
  }, [state.tracks, queueIds]);

  // Memoized playlist title
  const playlistTitle = useMemo(() => {
    if (!state.playlist) {
      return playlistId ? t('np.loading') : t('np.noTrack');
    }
    
    if (playlistInfo.isFavorites) {
      return (
        <>
          <span 
            className="material-symbols-rounded filled" 
            aria-hidden="true" 
            style={{ fontSize: 31, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            star
          </span>
          {' '}
          {state.playlist.name}
        </>
      );
    }
    
    return state.playlist.name;
  }, [state.playlist, playlistId, playlistInfo.isFavorites, t]);

  // Memoized playlist meta
  const playlistMeta = useMemo(() => {
    if (!state.playlist) return undefined;
    
    return (
      <>
        <span className="np-album-trackcount">
          {t('np.tracks', undefined, { count: state.playlist.totalTracks ?? 0 })}
        </span>
        <span className="np-dot" />
        <span className="np-album-year">{fmtTotalMs(totalDuration)}</span>
      </>
    );
  }, [state.playlist, totalDuration, t]);

  // Memoized tags
  const playlistTags = useMemo(() => {
    if (!state.playlist) return [];
    return playlistInfo.isLocal ? [t('pl.local', 'Local')] : [t('pl.remote', 'Remote')];
  }, [state.playlist, playlistInfo.isLocal, t]);

  return (
    <section className="now-playing" aria-labelledby="playlist-heading">
      <InfoHeader
        id="playlist-heading"
        title={playlistTitle}
        meta={playlistMeta}
        tags={playlistTags}
        actions={actionButtons}
        heroImage={heroImage}
        ariaActionsLabel={t('np.playlistActions','Playlist actions')}
      />
      <div className="np-section np-album-tracks" aria-label={t('np.playlistTrackList','Playlist track list')}>
        <h4 className="np-sec-title">{t('np.tracksList','Tracks')}</h4>
        {state.loading && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {!state.loading && !state.tracks && playlistId && <p className="np-hint">{t('np.loading')}</p>}
        {!state.loading && state.tracks && (
          <TrackList 
            tracks={state.tracks} 
            playingTrackId={(queueIds || [])[currentIndex || 0]} 
            showPlayButton
            onDeleteTrack={playlistInfo.isLocal}
          />
        )}
      </div>
    </section>
  );
});

export default PlaylistInfoTab;
