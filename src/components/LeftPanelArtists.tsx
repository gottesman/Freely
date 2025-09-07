import React, { useCallback, useMemo } from 'react';
import { useI18n } from '../core/i18n';
import useFollowedArtists from '../core/artists';

// Interfaces for better type safety
interface SpotifyImage {
  url: string;
  width?: number;
  height?: number;
}

interface Artist {
  id: string;
  name: string;
  images?: SpotifyImage[];
  genres?: string[];
}

interface LeftPanelArtistsProps {
  activeArtistId?: string;
  activeArtistVisible?: boolean;
}

// Memoized ArtistRow component for better performance
const ArtistRow = React.memo(({ 
  artist, 
  isActive, 
  onSelectArtist 
}: { 
  artist: Artist; 
  isActive: boolean; 
  onSelectArtist: (artistId: string) => void;
}) => {
  // Memoize image resolution to avoid repeated calls
  const artistImage = useMemo(() => 
    (window as any).imageRes?.(artist.images, 3), 
    [artist.images]
  );

  // Memoize genres display
  const genresDisplay = useMemo(() => 
    artist.genres?.slice(0, 2).join(', ') || '', 
    [artist.genres]
  );

  // Stable click handler
  const handleClick = useCallback(() => {
    onSelectArtist(artist.id);
  }, [artist.id, onSelectArtist]);

  return (
    <button
      type="button"
      className={`artist-row card-btn ${isActive ? 'active' : ''}`}
      onClick={handleClick}
    >
      <div className='artist-avatar'>
        {artistImage ? (
          <img src={artistImage} alt="" />
        ) : (
          <span className="material-symbols-rounded">person</span>
        )}
      </div>
      <div className='artist-text'>
        <div className='artist-name'>{artist.name}</div>
        <div className='artist-genres'>{genresDisplay}</div>
      </div>
    </button>
  );
});

ArtistRow.displayName = 'ArtistRow';

const LeftPanelArtists = React.memo(({ 
  activeArtistId, 
  activeArtistVisible 
}: LeftPanelArtistsProps) => {
  const { t } = useI18n();
  const { artists, loading } = useFollowedArtists();

  // Stable artist selection handler
  const handleSelectArtist = useCallback((artistId: string) => {
    try {
      window.dispatchEvent(new CustomEvent('freely:selectArtist', { 
        detail: { artistId, source: 'left-panel' } 
      }));
    } catch (e) {
      console.warn('LeftPanelArtists selectArtist failed', e);
    }
  }, []);

  // Memoized loading state
  const loadingContent = useMemo(() => (
    <div className='left-artists'>
      <div className="left-artists-loading">
        {t('common.loading', 'Loading…')}
      </div>
    </div>
  ), [t]);

  // Memoized empty state
  const emptyContent = useMemo(() => (
    <div className='left-artists'>
      <div className='left-artists-empty'>
        {t('ar.placeholder', 'No followed artists found')}
      </div>
    </div>
  ), [t]);

  // Memoized artists list with optimized rendering
  const artistsList = useMemo(() => {
    if (!artists?.length) return null;

    return artists.map(artist => {
      const isActive = activeArtistVisible && 
        String(artist.id) === String(activeArtistId || '');
      
      return (
        <ArtistRow
          key={artist.id}
          artist={artist}
          isActive={isActive}
          onSelectArtist={handleSelectArtist}
        />
      );
    });
  }, [artists, activeArtistVisible, activeArtistId, handleSelectArtist]);

  // Early returns for loading and empty states
  if (loading) return loadingContent;
  if (!artists?.length) return emptyContent;

  return (
    <div className='left-artists'>
      {artistsList}
    </div>
  );
});

LeftPanelArtists.displayName = 'LeftPanelArtists';

export default LeftPanelArtists;
