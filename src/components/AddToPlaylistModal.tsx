import React from 'react';
import { useI18n } from '../core/i18n';
import { usePlaylists } from '../core/playlists';
import { useAlerts } from '../core/alerts';

// Animation duration constants (in milliseconds)
// These should match the CSS custom properties in variables.css
const MODAL_ANIMATION_DURATION = {
  REGULAR: 150, // --modal-duration-regular: 0.15s
  BOTTOM_PLAYER: 100, // --modal-duration-bottom-player: 0.1s
} as const;

export interface AddToPlaylistModalProps {
  /** The track object to add to playlists */
  track: any;
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Callback when the modal should close */
  onClose: () => void;
  /** Optional callback when track is successfully added to a playlist */
  onAdded?: (playlistId: number, playlistName: string) => void;
  /** Whether the modal is opened from the bottom player (changes positioning) */
  fromBottomPlayer?: boolean;
  /** Custom animation durations (in seconds) */
  animationDurations?: {
    regular?: number;
    bottomPlayer?: number;
    backdrop?: number;
  };
}

export default function AddToPlaylistModal({ 
  track, 
  isOpen, 
  onClose, 
  onAdded, 
  fromBottomPlayer = false,
  animationDurations = {}
}: AddToPlaylistModalProps) {
  const { t } = useI18n();
  const { playlists, addTracks, createPlaylist, getPlaylistTrackIds, removeTrack } = usePlaylists();
  const { push: pushAlert } = useAlerts();
  const [searchQuery, setSearchQuery] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const [newPlaylistName, setNewPlaylistName] = React.useState('');
  const [addingToPlaylistId, setAddingToPlaylistId] = React.useState<number | null>(null);
  const [playlistTrackIds, setPlaylistTrackIds] = React.useState<Map<number, Set<string>>>(new Map());
  const [isClosing, setIsClosing] = React.useState(false);

  // Create CSS custom properties for animation durations
  const customDurations = {
    '--modal-duration-regular': `${animationDurations.regular || 0.25}s`,
    '--modal-duration-bottom-player': `${animationDurations.bottomPlayer || 0.2}s`,
    '--backdrop-duration': `${animationDurations.backdrop || 0.25}s`,
  } as React.CSSProperties;

  // Also create direct animation duration styles for better browser support
  const getAnimationStyle = (element: 'modal' | 'backdrop', isClosing: boolean) => {
    // Use constants instead of prop values
    const duration = element === 'backdrop' 
      ? MODAL_ANIMATION_DURATION.REGULAR / 1000  // Convert ms to seconds
      : fromBottomPlayer 
        ? MODAL_ANIMATION_DURATION.BOTTOM_PLAYER / 1000
        : MODAL_ANIMATION_DURATION.REGULAR / 1000;
    
    let animationName = '';
    let easing = '';
    
    if (element === 'backdrop') {
      animationName = isClosing ? 'fade-out' : 'fade-in';
      easing = 'ease';
    } else if (fromBottomPlayer) {
      animationName = isClosing ? 'modal-exit-bottom' : 'modal-enter-bottom';
      easing = isClosing ? 'cubic-bezier(0.36, 0, 0.66, -0.56)' : 'cubic-bezier(0.34, 1.56, 0.64, 1)';
    } else {
      animationName = isClosing ? 'modal-exit' : 'modal-enter';
      easing = isClosing ? 'cubic-bezier(0.36, 0, 0.66, -0.56)' : 'cubic-bezier(0.34, 1.56, 0.64, 1)';
    }
    
    return {
      ...customDurations,
      animation: `${animationName} ${duration}s ${easing}${isClosing ? ' forwards' : ''}`,
    } as React.CSSProperties;
  };

  // Debug: Log the custom durations to see if they're being set
  React.useEffect(() => {
    if (isOpen) {
      console.log('🎭 Modal animation durations:', {
        customDurations,
        modalStyle: getAnimationStyle('modal', isClosing),
        backdropStyle: getAnimationStyle('backdrop', isClosing),
        fromBottomPlayer,
        isClosing
      });
    }
  }, [isOpen, customDurations, fromBottomPlayer, isClosing]);

  // Filter playlists based on search query
  const filteredPlaylists = React.useMemo(() => {
    if (!searchQuery) return playlists;
    const query = searchQuery.toLowerCase();
    return playlists.filter(playlist => 
      playlist.name.toLowerCase().includes(query) ||
      playlist.tags.some(tag => tag.toLowerCase().includes(query))
    );
  }, [playlists, searchQuery]);

  // Reset state when modal opens/closes
  React.useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setIsCreating(false);
      setNewPlaylistName('');
      setAddingToPlaylistId(null);
      setPlaylistTrackIds(new Map());
      setIsClosing(false);
    }
  }, [isOpen]);

  // Handle close with fade-out animation
  const handleClose = () => {
    setIsClosing(true);
    const animationDuration = fromBottomPlayer 
      ? MODAL_ANIMATION_DURATION.BOTTOM_PLAYER
      : MODAL_ANIMATION_DURATION.REGULAR;
    setTimeout(() => {
      onClose();
    }, animationDuration);
  };

  // Load track IDs for all playlists when modal opens
  React.useEffect(() => {
    if (!isOpen || !playlists.length) return;
    
    const loadPlaylistTracks = async () => {
      const trackIdsMap = new Map<number, Set<string>>();
      
      for (const playlist of playlists) {
        try {
          const trackIds = await getPlaylistTrackIds(playlist.id);
          trackIdsMap.set(playlist.id, new Set(trackIds));
        } catch (error) {
          console.warn(`Failed to load tracks for playlist ${playlist.id}:`, error);
          trackIdsMap.set(playlist.id, new Set());
        }
      }
      
      setPlaylistTrackIds(trackIdsMap);
    };

    loadPlaylistTracks();
  }, [isOpen, playlists, getPlaylistTrackIds]);

  // Check if track is in a specific playlist
  const isTrackInPlaylist = (playlistId: number) => {
    if (!track?.id) return false;
    const trackIds = playlistTrackIds.get(playlistId);
    return trackIds ? trackIds.has(track.id) : false;
  };

  const handleToggleTrackInPlaylist = async (playlistId: number, playlistName: string) => {
    if (!track || addingToPlaylistId === playlistId) return;
    
    setAddingToPlaylistId(playlistId);
    const isInPlaylist = isTrackInPlaylist(playlistId);
    
    try {
      if (isInPlaylist) {
        // Remove track from playlist
        await removeTrack(playlistId, track.id);
        
        // Update local state to reflect the track was removed
        setPlaylistTrackIds(prev => {
          const updated = new Map(prev);
          const trackIds = updated.get(playlistId) || new Set();
          trackIds.delete(track.id);
          updated.set(playlistId, trackIds);
          return updated;
        });
        
        pushAlert(`Removed "${track.name}" from ${playlistName}`, 'info');
      } else {
        // Add the track with full metadata to the playlist
        await addTracks(playlistId, [track]);
        
        // Update local state to reflect the track was added
        setPlaylistTrackIds(prev => {
          const updated = new Map(prev);
          const trackIds = updated.get(playlistId) || new Set();
          trackIds.add(track.id);
          updated.set(playlistId, trackIds);
          return updated;
        });
        
        pushAlert(`Added "${track.name}" to ${playlistName}`, 'info');
      }
      
      onAdded?.(playlistId, playlistName);
      // Don't close modal - let user add/remove from multiple playlists
    } catch (error) {
      console.error('[AddToPlaylistModal] Failed to toggle track in playlist:', error);
      const action = isInPlaylist ? 'remove track from' : 'add track to';
      pushAlert(`Failed to ${action} ${playlistName}`, 'error');
      // Don't close the modal on error so user can try again
    } finally {
      setAddingToPlaylistId(null);
    }
  };

  const handleCreateNewPlaylist = async () => {
    const name = newPlaylistName.trim();
    if (!name || !track || addingToPlaylistId === -1) return;

    setAddingToPlaylistId(-1);
    console.log('[AddToPlaylistModal] Creating new playlist and adding track:', { name, track });
    
    try {
      const newPlaylistId = await createPlaylist(name);
      if (newPlaylistId) {
        // Add the track to the new playlist
        await addTracks(newPlaylistId, [track]);
        onAdded?.(newPlaylistId, name);
        handleClose();
      }
    } catch (error) {
      console.error('[AddToPlaylistModal] Failed to create playlist and add track:', error);
      pushAlert(`Failed to create playlist "${name}"`, 'error');
    } finally {
      setAddingToPlaylistId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div 
        className={`add-to-playlist-backdrop ${fromBottomPlayer ? 'from-bottom-player' : ''} ${isClosing ? 'closing' : ''}`} 
        onClick={handleClose}
        style={getAnimationStyle('backdrop', isClosing)}
         
      />

      {/* Modal */}
      <div 
        className={`add-to-playlist-modal ${fromBottomPlayer ? 'from-bottom-player' : ''} ${isClosing ? 'closing' : ''}`} 
        role="dialog" 
        aria-labelledby="add-to-playlist-title"
        style={getAnimationStyle('modal', isClosing)}
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
            <span className="material-symbols-rounded" style={{fontSize: 18}}>close</span>
          </button>
        </div>

        {track && (
          <div className="add-to-playlist-track-info">
            <div className="track-info-cover">
              {track.album?.images?.[0]?.url ? (
                <img src={track.album.images[0].url} alt="" />
              ) : (
                <span className="material-symbols-rounded" style={{fontSize: 18}}>music_note</span>
              )}
            </div>
            <div className="track-info-meta">
              <div className="track-info-name">{track.name}</div>
              <div className="track-info-artist">{track.artists?.map((a: any) => a.name).join(', ')}</div>
            </div>
          </div>
        )}

        <div className="add-to-playlist-search">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('addToPlaylist.search', 'Search playlists...')}
            className="add-to-playlist-search-input"
          />
        </div>

        <div className="add-to-playlist-list">
          {!isCreating && (
            <div className="add-to-playlist-item new-playlist-item" onClick={() => setIsCreating(true)}>
              <div className="playlist-item-icon">
                <span className="material-symbols-rounded" style={{fontSize: 18}}>add</span>
              </div>
              <div className="playlist-item-info">
                <div className="playlist-item-name">{t('addToPlaylist.createNew', 'Create New Playlist')}</div>
              </div>
            </div>
          )}

          {isCreating && (
            <div className="add-to-playlist-create">
              <input
                type="text"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                placeholder={t('addToPlaylist.newPlaylistName', 'New playlist name...')}
                className="add-to-playlist-create-input"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateNewPlaylist();
                  } else if (e.key === 'Escape') {
                    setIsCreating(false);
                    setNewPlaylistName('');
                  }
                }}
              />
              <div className="add-to-playlist-create-actions">
                <button 
                  type="button" 
                  className="np-pill create-cancel" 
                  onClick={() => {
                    setIsCreating(false);
                    setNewPlaylistName('');
                  }}
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button 
                  type="button" 
                  className="np-pill create-confirm" 
                  onClick={handleCreateNewPlaylist}
                  disabled={!newPlaylistName.trim() || addingToPlaylistId === -1}
                >
                  {addingToPlaylistId === -1 ? 'Creating...' : t('common.create', 'Create')}
                </button>
              </div>
            </div>
          )}

          {filteredPlaylists.map((playlist) => (
            <div 
              key={playlist.id} 
              className={
                `add-to-playlist-item${isTrackInPlaylist(playlist.id) ? ' in-playlist' : ''}${addingToPlaylistId === playlist.id ? ' is-loading' : ''}`
              }
              onClick={() => handleToggleTrackInPlaylist(playlist.id, playlist.name)}
            >
              <div className="playlist-item-icon">
                {playlist.system && playlist.code === 'favorites' ? (
                  <span className="material-symbols-rounded filled" style={{fontSize: 18}}>star</span>
                ) : (
                  <div className="playlist-item-thumb">
                    {playlist.name.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="playlist-item-info">
                <div className="playlist-item-name">
                  {playlist.system && playlist.code === 'favorites' 
                    ? t('pl.favorites', 'Favorites') 
                    : playlist.name
                  }
                </div>
                <div className="playlist-item-meta">
                  {(playlist.track_count || 0)} {t('pl.tracks', 'tracks')}
                  {playlist.tags.length > 0 && ` • ${playlist.tags.join(', ')}`}
                </div>
              </div>
              <button 
                type="button" 
                className="add-to-playlist-button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleTrackInPlaylist(playlist.id, playlist.name);
                }}
                disabled={addingToPlaylistId === playlist.id}
                aria-pressed={isTrackInPlaylist(playlist.id)}
                aria-label={
                  isTrackInPlaylist(playlist.id)
                    ? t('addToPlaylist.removeButton', `Remove from ${playlist.name}`)
                    : t('addToPlaylist.addButton', `Add to ${playlist.name}`)
                }
              >
                {addingToPlaylistId === playlist.id ? (
                  <span className="material-symbols-rounded" style={{fontSize: 16}}>hourglass_top</span>
                ) : isTrackInPlaylist(playlist.id) ? (
                  <span className="material-symbols-rounded filled" style={{fontSize: 16}}>check</span>
                ) : (
                  <span className="material-symbols-rounded" style={{fontSize: 16}}>add</span>
                )}
              </button>
            </div>
          ))}

          {filteredPlaylists.length === 0 && searchQuery && (
            <div className="add-to-playlist-empty">
              {t('addToPlaylist.noResults', 'No playlists found')}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
