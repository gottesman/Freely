import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { frontendLogger } from '../../core/FrontendLogger';
import { useI18n } from '../../core/i18n';
import { usePlaylists } from '../../core/Playlists';
import { useAlerts } from '../../core/Alerts';

// Constants for better performance and maintainability
const MODAL_CONFIG = {
  ANIMATION_DURATIONS: {
    REGULAR: 150, // ms
    BOTTOM_PLAYER: 100, // ms
  },
  ICON_SIZES: {
    SMALL: 16,
    MEDIUM: 18,
  },
  EASING: {
    ENTER: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    EXIT: 'cubic-bezier(0.36, 0, 0.66, -0.56)',
    BACKDROP: 'ease',
  },
} as const;

// Type definitions
interface PlaylistTrackState {
  searchQuery: string;
  isCreating: boolean;
  newPlaylistName: string;
  addingToPlaylistId: number | null;
  playlistTrackIds: Map<number, Set<string>>;
  isClosing: boolean;
}

export interface AddToPlaylistModalProps {
  track: any;
  isOpen: boolean;
  onClose: () => void;
  onAdded?: (playlistId: number, playlistName: string) => void;
  fromBottomPlayer?: boolean;
  animationDurations?: {
    regular?: number;
    bottomPlayer?: number;
    backdrop?: number;
  };
}

// Custom hooks for better organization
function useModalState(): [PlaylistTrackState, {
  setSearchQuery: (query: string) => void;
  setIsCreating: (creating: boolean) => void;
  setNewPlaylistName: (name: string) => void;
  setAddingToPlaylistId: (id: number | null) => void;
  setPlaylistTrackIds: (trackIds: Map<number, Set<string>>) => void;
  updatePlaylistTrackIds: (updater: (prev: Map<number, Set<string>>) => Map<number, Set<string>>) => void;
  setIsClosing: (closing: boolean) => void;
  resetState: () => void;
}] {
  const [state, setState] = useState<PlaylistTrackState>({
    searchQuery: '',
    isCreating: false,
    newPlaylistName: '',
    addingToPlaylistId: null,
    playlistTrackIds: new Map(),
    isClosing: false,
  });

  const actions = useMemo(() => ({
    setSearchQuery: (searchQuery: string) => 
      setState(prev => ({ ...prev, searchQuery })),
    
    setIsCreating: (isCreating: boolean) => 
      setState(prev => ({ ...prev, isCreating, ...(isCreating ? {} : { newPlaylistName: '' }) })),
    
    setNewPlaylistName: (newPlaylistName: string) => 
      setState(prev => ({ ...prev, newPlaylistName })),
    
    setAddingToPlaylistId: (addingToPlaylistId: number | null) => 
      setState(prev => ({ ...prev, addingToPlaylistId })),
    
    setPlaylistTrackIds: (playlistTrackIds: Map<number, Set<string>>) => 
      setState(prev => ({ ...prev, playlistTrackIds })),
    
    updatePlaylistTrackIds: (updater: (prev: Map<number, Set<string>>) => Map<number, Set<string>>) => 
      setState(prev => ({ ...prev, playlistTrackIds: updater(prev.playlistTrackIds) })),
    
    setIsClosing: (isClosing: boolean) => 
      setState(prev => ({ ...prev, isClosing })),

    resetState: () => setState({
      searchQuery: '',
      isCreating: false,
      newPlaylistName: '',
      addingToPlaylistId: null,
      playlistTrackIds: new Map(),
      isClosing: false,
    }),
  }), []);

  return [state, actions];
}

// Optimized animation style hook
function useAnimationStyles(fromBottomPlayer: boolean, isClosing: boolean) {
  return useMemo(() => {
    const duration = fromBottomPlayer 
      ? MODAL_CONFIG.ANIMATION_DURATIONS.BOTTOM_PLAYER / 1000
      : MODAL_CONFIG.ANIMATION_DURATIONS.REGULAR / 1000;

    const getStyle = (element: 'modal' | 'backdrop') => {
      let animationName = '';
      let easing = '';
      
      if (element === 'backdrop') {
        animationName = isClosing ? 'fade-out' : 'fade-in';
        easing = MODAL_CONFIG.EASING.BACKDROP;
      } else if (fromBottomPlayer) {
        animationName = isClosing ? 'modal-exit-bottom' : 'modal-enter-bottom';
        easing = isClosing ? MODAL_CONFIG.EASING.EXIT : MODAL_CONFIG.EASING.ENTER;
      } else {
        animationName = isClosing ? 'modal-exit' : 'modal-enter';
        easing = isClosing ? MODAL_CONFIG.EASING.EXIT : MODAL_CONFIG.EASING.ENTER;
      }
      
      return {
        animation: `${animationName} ${duration}s ${easing}${isClosing ? ' forwards' : ''}`,
      } as React.CSSProperties;
    };

    return {
      modal: getStyle('modal'),
      backdrop: getStyle('backdrop'),
    };
  }, [fromBottomPlayer, isClosing]);
}

// Memoized components for better performance
const TrackInfo = React.memo<{ track: any; iconSize: number }>(({ track, iconSize }) => (
  <div className="add-to-playlist-track-info">
    <div className="track-info-cover">
      {track.album?.images?.[0]?.url ? (
        <img src={track.album.images[0].url} alt="" />
      ) : (
        <span className="material-symbols-rounded" style={{ fontSize: iconSize }}>music_note</span>
      )}
    </div>
    <div className="track-info-meta">
      <div className="track-info-name overflow-ellipsis">{track.name}</div>
      <div className="track-info-artist overflow-ellipsis">
        {track.artists?.map((a: any) => a.name).join(', ')}
      </div>
    </div>
  </div>
));

const PlaylistIcon = React.memo<{ playlist: any; iconSize: number; t: (key: string, fallback?: string) => string }>(
  ({ playlist, iconSize, t }) => (
    <div className="playlist-item-icon">
      {playlist.system && playlist.code === 'favorites' ? (
        <span className="material-symbols-rounded filled" style={{ fontSize: iconSize }}>star</span>
      ) : (
        <div className="playlist-item-thumb">
          {playlist.name.slice(0, 2).toUpperCase()}
        </div>
      )}
    </div>
  )
);

const PlaylistButton = React.memo<{
  isInPlaylist: boolean;
  isLoading: boolean;
  playlistName: string;
  onToggle: () => void;
  t: (key: string, fallback?: string) => string;
}>(({ isInPlaylist, isLoading, playlistName, onToggle, t }) => (
  <button 
    type="button" 
    className="add-to-playlist-button"
    onClick={(e) => {
      e.stopPropagation();
      onToggle();
    }}
    disabled={isLoading}
    aria-pressed={isInPlaylist}
    aria-label={
      isInPlaylist
        ? t('addToPlaylist.removeButton', `Remove from ${playlistName}`)
        : t('addToPlaylist.addButton', `Add to ${playlistName}`)
    }
  >
    {isLoading ? (
      <span className="material-symbols-rounded" style={{ fontSize: MODAL_CONFIG.ICON_SIZES.SMALL }}>hourglass_top</span>
    ) : isInPlaylist ? (
      <span className="material-symbols-rounded filled" style={{ fontSize: MODAL_CONFIG.ICON_SIZES.SMALL }}>check</span>
    ) : (
      <span className="material-symbols-rounded" style={{ fontSize: MODAL_CONFIG.ICON_SIZES.SMALL }}>add</span>
    )}
  </button>
));

export default function AddToPlaylistModal({ 
  track, 
  isOpen, 
  onClose, 
  onAdded, 
  fromBottomPlayer = false 
}: AddToPlaylistModalProps) {
  const { t } = useI18n();
  const { playlists, addTracks, createPlaylist, getPlaylistTrackIds, removeTrack } = usePlaylists();
  const { push: pushAlert } = useAlerts();
  
  const [state, actions] = useModalState();
  const animationStyles = useAnimationStyles(fromBottomPlayer, state.isClosing);

  // Memoized filtered playlists
  const filteredPlaylists = useMemo(() => {
    if (!state.searchQuery) return playlists;
    const query = state.searchQuery.toLowerCase();
    return playlists.filter(playlist => 
      playlist.name.toLowerCase().includes(query) ||
      playlist.tags.some(tag => tag.toLowerCase().includes(query))
    );
  }, [playlists, state.searchQuery]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      actions.resetState();
    }
  }, [isOpen]); // Removed actions from dependencies

  // Optimized close handler
  const handleClose = useCallback(() => {
    actions.setIsClosing(true);
    const duration = fromBottomPlayer 
      ? MODAL_CONFIG.ANIMATION_DURATIONS.BOTTOM_PLAYER
      : MODAL_CONFIG.ANIMATION_DURATIONS.REGULAR;
    setTimeout(onClose, duration);
  }, [fromBottomPlayer, onClose]); // Removed actions from dependencies

  // Optimized keyboard handler
  useEffect(() => {
    if (!isOpen) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (state.isCreating) {
          actions.setIsCreating(false);
        } else {
          e.stopPropagation();
          handleClose();
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, state.isCreating, handleClose]); // Removed actions from dependencies

  // Load playlist tracks efficiently
  useEffect(() => {
    if (!isOpen || !playlists.length) return;
    
    const loadPlaylistTracks = async () => {
      const trackIdsMap = new Map<number, Set<string>>();
      
      // Use Promise.allSettled for better error handling
      const results = await Promise.allSettled(
        playlists.map(async (playlist) => {
          const trackIds = await getPlaylistTrackIds(playlist.id);
          return { playlistId: playlist.id, trackIds };
        })
      );
      
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          trackIdsMap.set(result.value.playlistId, new Set(result.value.trackIds));
        }
      });
      
      actions.setPlaylistTrackIds(trackIdsMap);
    };

    loadPlaylistTracks();
  }, [isOpen, playlists, getPlaylistTrackIds]); // Removed actions from dependencies

  // Optimized track check
  const isTrackInPlaylist = useCallback((playlistId: number) => {
    if (!track?.id) return false;
    return state.playlistTrackIds.get(playlistId)?.has(track.id) ?? false;
  }, [track?.id, state.playlistTrackIds]);

  // Optimized playlist track toggle
  const handleToggleTrackInPlaylist = useCallback(async (playlistId: number, playlistName: string) => {
    if (!track || state.addingToPlaylistId === playlistId) return;
    
    actions.setAddingToPlaylistId(playlistId);
    const isInPlaylist = isTrackInPlaylist(playlistId);
    
    try {
      if (isInPlaylist) {
        await removeTrack(playlistId, track.id);
        pushAlert(`Removed "${track.name}" from ${playlistName}`, 'info');
      } else {
        await addTracks(playlistId, [track]);
        pushAlert(`Added "${track.name}" to ${playlistName}`, 'info');
      }
      
      // Update local state efficiently
      actions.updatePlaylistTrackIds(prev => {
        const updated = new Map(prev);
        const trackIds = updated.get(playlistId) || new Set();
        if (isInPlaylist) {
          trackIds.delete(track.id);
        } else {
          trackIds.add(track.id);
        }
        updated.set(playlistId, trackIds);
        return updated;
      });
      
      onAdded?.(playlistId, playlistName);
    } catch (error) {
      frontendLogger.error('[AddToPlaylistModal] Failed to toggle track:', error);
      const action = isInPlaylist ? 'remove track from' : 'add track to';
      pushAlert(`Failed to ${action} ${playlistName}`, 'error');
    } finally {
      actions.setAddingToPlaylistId(null);
    }
  }, [track, state.addingToPlaylistId, isTrackInPlaylist, removeTrack, addTracks, pushAlert, onAdded]); // Removed actions from dependencies

  // Optimized playlist creation
  const handleCreateNewPlaylist = useCallback(async () => {
    const name = state.newPlaylistName.trim();
    if (!name || !track || state.addingToPlaylistId === -1) return;

    actions.setAddingToPlaylistId(-1);
    
    try {
      const newPlaylistId = await createPlaylist(name);
      if (newPlaylistId) {
        await addTracks(newPlaylistId, [track]);
        onAdded?.(newPlaylistId, name);
        handleClose();
      }
    } catch (error) {
      frontendLogger.error('[AddToPlaylistModal] Failed to create playlist:', error);
      pushAlert(`Failed to create playlist "${name}"`, 'error');
    } finally {
      actions.setAddingToPlaylistId(null);
    }
  }, [state.newPlaylistName, state.addingToPlaylistId, track, createPlaylist, addTracks, onAdded, handleClose, pushAlert]); // Removed actions from dependencies

  if (!isOpen) return null;

  return (
    <>
      <div 
        className={`add-to-playlist-backdrop ${fromBottomPlayer ? 'from-bottom-player' : ''} ${state.isClosing ? 'closing' : ''}`} 
        onClick={handleClose}
        style={animationStyles.backdrop}
      />

      <div 
        className={`add-to-playlist-modal ${fromBottomPlayer ? 'from-bottom-player' : ''} ${state.isClosing ? 'closing' : ''}`} 
        role="dialog" 
        aria-labelledby="add-to-playlist-title"
        style={animationStyles.modal}
      >
        <div className="add-to-playlist-header">
          <h3 id="add-to-playlist-title" className="add-to-playlist-title">
            {t('addToPlaylist.title', 'Add to Playlist')}
          </h3>
          <button 
            type="button" 
            className="add-to-playlist-close" 
            onClick={handleClose}
            aria-label={t('modal.close', 'Close')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: MODAL_CONFIG.ICON_SIZES.MEDIUM }}>
              close
            </span>
          </button>
        </div>

        {track && <TrackInfo track={track} iconSize={MODAL_CONFIG.ICON_SIZES.MEDIUM} />}

        <div className="add-to-playlist-search">
          <input
            type="text"
            value={state.searchQuery}
            onChange={(e) => actions.setSearchQuery(e.target.value)}
            placeholder={t('addToPlaylist.search', 'Search playlists...')}
            className="add-to-playlist-search-input"
          />
        </div>

        <div className="add-to-playlist-list">
          {!state.isCreating && (
            <div className="add-to-playlist-item new-playlist-item" onClick={() => actions.setIsCreating(true)}>
              <div className="playlist-item-icon">
                <span className="material-symbols-rounded" style={{ fontSize: MODAL_CONFIG.ICON_SIZES.MEDIUM }}>
                  add
                </span>
              </div>
              <div className="playlist-item-info">
                <div className="playlist-item-name overflow-ellipsis">
                  {t('addToPlaylist.createNew', 'Create New Playlist')}
                </div>
              </div>
            </div>
          )}

          {state.isCreating && (
            <div className="add-to-playlist-create">
              <input
                type="text"
                value={state.newPlaylistName}
                onChange={(e) => actions.setNewPlaylistName(e.target.value)}
                placeholder={t('addToPlaylist.newPlaylistName', 'New playlist name...')}
                className="add-to-playlist-create-input"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateNewPlaylist();
                  } else if (e.key === 'Escape') {
                    actions.setIsCreating(false);
                  }
                }}
              />
              <div className="add-to-playlist-create-actions">
                <button 
                  type="button" 
                  className="np-pill create-cancel" 
                  onClick={() => actions.setIsCreating(false)}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button 
                  type="button" 
                  className="np-pill create-confirm" 
                  onClick={handleCreateNewPlaylist}
                  disabled={!state.newPlaylistName.trim() || state.addingToPlaylistId === -1}
                >
                  {state.addingToPlaylistId === -1 ? 'Creating...' : t('common.create', 'Create')}
                </button>
              </div>
            </div>
          )}

          {filteredPlaylists.map((playlist) => {
            const isInPlaylist = isTrackInPlaylist(playlist.id);
            const isLoading = state.addingToPlaylistId === playlist.id;
            
            return (
              <div 
                key={playlist.id} 
                className={`add-to-playlist-item${isInPlaylist ? ' in-playlist' : ''}${isLoading ? ' is-loading' : ''}`}
                onClick={() => handleToggleTrackInPlaylist(playlist.id, playlist.name)}
              >
                <PlaylistIcon playlist={playlist} iconSize={MODAL_CONFIG.ICON_SIZES.MEDIUM} t={t} />
                <div className="playlist-item-info">
                  <div className="playlist-item-name">
                    {playlist.system && playlist.code === 'favorites' 
                      ? t('pl.favorites', 'Favorites') 
                      : playlist.name
                    }
                  </div>
                  <div className="playlist-item-meta overflow-ellipsis">
                    {(playlist.track_count || 0)} {t('pl.tracks', 'tracks')}
                    {playlist.tags.length > 0 && ` • ${playlist.tags.join(', ')}`}
                  </div>
                </div>
                <PlaylistButton
                  isInPlaylist={isInPlaylist}
                  isLoading={isLoading}
                  playlistName={playlist.name}
                  onToggle={() => handleToggleTrackInPlaylist(playlist.id, playlist.name)}
                  t={t}
                />
              </div>
            );
          })}

          {filteredPlaylists.length === 0 && state.searchQuery && (
            <div className="add-to-playlist-empty">
              {t('addToPlaylist.noResults', 'No playlists found')}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
