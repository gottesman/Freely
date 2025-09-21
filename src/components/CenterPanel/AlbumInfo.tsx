import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../core/i18n';
import { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../../core/SpotifyClient';
import { usePlaybackSelector } from '../../core/Playback';
import InfoHeader from '../Utilities/InfoHeader';
import TrackList from '../Utilities/TrackList';
import { 
  fmtMs, 
  useHeroImage, 
  extractReleaseYear,
  useStableTabAPI,
  usePlaybackActions,
  navigationEvents
} from '../Utilities/Helpers';

// Constants for better maintainability
const API_CONFIG = {
  TRACK_LIMIT: 50,
  FETCH_ALL: false,
} as const;

// Consolidated state interface
interface AlbumState {
  album?: SpotifyAlbum;
  tracks?: SpotifyTrack[];
  primaryArtist?: SpotifyArtist;
  loading: {
    album: boolean;
    tracks: boolean;
    artist: boolean;
  };
}

// Custom hook for Spotify API calls
function useSpotifyAPI() {
  return useStableTabAPI();
}

// Custom hook for album data management
function useAlbumData(api: ReturnType<typeof useSpotifyAPI>, albumId?: string) {
  const [state, setState] = useState<AlbumState>({
    loading: { album: false, tracks: false, artist: false }
  });

  // Generic async data fetcher
  const fetchData = useCallback(async (
    key: keyof AlbumState['loading'],
    dataKey: keyof Omit<AlbumState, 'loading'>,
    fetcher: () => Promise<any>
  ) => {
    setState(prev => ({
      ...prev,
      loading: { ...prev.loading, [key]: true },
      [dataKey]: undefined
    }));

    try {
      const result = await fetcher();
      setState(prev => ({
        ...prev,
        [dataKey]: result,
        loading: { ...prev.loading, [key]: false }
      }));
    } catch (error) {
      console.warn(`Failed to fetch ${key}:`, error);
      setState(prev => ({
        ...prev,
        loading: { ...prev.loading, [key]: false }
      }));
    }
  }, []);

  // Load album data
  useEffect(() => {
    if (!albumId) {
      setState({ loading: { album: false, tracks: false, artist: false } });
      return;
    }

    fetchData('album', 'album', () => api.getAlbum(albumId));
  }, [albumId, api, fetchData]);

  // Load tracks data
  useEffect(() => {
    if (!albumId) return;
    fetchData('tracks', 'tracks', () => api.getAlbumTracks(albumId));
  }, [albumId, api, fetchData]);

  // Load primary artist data
  useEffect(() => {
    const artistId = state.album?.artists?.[0]?.id;
    if (!artistId) return;
    fetchData('artist', 'primaryArtist', () => api.getArtist(artistId));
  }, [state.album?.artists, api, fetchData]);

  return state;
}

// Memoized components for better performance
const AlbumMeta = React.memo<{
  album: SpotifyAlbum;
  releaseYear?: string;
  t: (key: string, fallback?: string, options?: any) => string;
  onArtistClick: (artistId: string) => void;
}>(({ album, releaseYear, t, onArtistClick }) => (
  <div className="np-meta-line">
    <span className="np-artists">
      {album.artists.map((a, i) => (
        <React.Fragment key={a.id || a.name}>
          {i > 0 && <span className="np-sep">, </span>}
          <button 
            type="button" 
            className="np-link artist" 
            onClick={() => onArtistClick(a.id)}
          >
            {a.name}
          </button>
        </React.Fragment>
      ))}
    </span>
    {releaseYear && (
      <>
        <span className="np-dot" />
        <span className="np-album-year">{releaseYear}</span>
      </>
    )}
    <span className="np-dot" />
    <span className="np-album-trackcount">
      {t('np.tracks', undefined, { count: album.totalTracks })}
    </span>
  </div>
));

const AlbumCredits = React.memo<{
  album?: SpotifyAlbum;
  loading: boolean;
  t: (key: string, fallback?: string) => string;
}>(({ album, loading, t }) => (
  <div className="np-section np-track-credits" aria-label={t('np.albumCredits', 'Album credits')}>
    <h4 className="np-sec-title">{t('np.albumCredits', 'Credits')}</h4>
    {loading && <p className="np-hint">{t('np.loading')}</p>}
    {album && (
      <ul className="credits-list">
        <li>
          <span className="cl-label">{t('np.artists', 'Artists')}</span>: 
          <span className="cl-value">{album.artists.map(a => a.name).join(', ')}</span>
        </li>
        {album.releaseDate && (
          <li>
            <span className="cl-label">{t('np.releaseDate', 'Release Date')}</span>: 
            <span className="cl-value">{album.releaseDate}</span>
          </li>
        )}
        {album.label && (
          <li>
            <span className="cl-label">{t('np.label', 'Label')}</span>: 
            <span className="cl-value">{album.label}</span>
          </li>
        )}
        {album.copyrights?.[0] && (
          <li>
            <span className="cl-label">{t('np.copyright', 'Copyright')}</span>: 
            <span className="cl-value">{album.copyrights[0]}</span>
          </li>
        )}
      </ul>
    )}
  </div>
));

export default function AlbumInfoTab({ albumId }: { albumId?: string }) {
  const { t } = useI18n();
  const queueIds = usePlaybackSelector(s => s.queueIds ?? []);
  const currentIndex = usePlaybackSelector(s => s.currentIndex ?? 0);
  const playbackActions = usePlaybackActions();
  
  const api = useSpotifyAPI();
  const { album, tracks, primaryArtist, loading } = useAlbumData(api, albumId);

  // Memoized computed values
  const heroImage = useMemo(() => 
    useHeroImage(album?.images, 0), 
    [album?.images]
  );
  
  const releaseYear = useMemo(() => 
    extractReleaseYear(album?.releaseDate), 
    [album?.releaseDate]
  );
  
  const genres = useMemo(() => 
    primaryArtist?.genres ?? [], 
    [primaryArtist?.genres]
  );

  // Optimized event handlers
  const handleArtistClick = useCallback((artistId: string) => {
    if (artistId) {
      navigationEvents.selectArtist(artistId, 'album-info');
    }
  }, []);

  const handlePlayAlbum = useCallback(() => {
    if (!tracks?.length) return;
    const trackIds = tracks.map(t => t.id).filter(Boolean);
    playbackActions.playTracks(trackIds, queueIds, currentIndex);
  }, [tracks, queueIds, currentIndex, playbackActions]);

  const handleAddToQueue = useCallback(() => {
    if (!tracks?.length) return;
    const trackIds = tracks.map(t => t.id).filter(Boolean);
    playbackActions.addToQueue(trackIds, queueIds);
  }, [tracks, queueIds, playbackActions]);

  // Memoized header actions
  const headerActions = useMemo(() => [
    <button 
      key="add" 
      className="np-icon" 
      aria-label={t('player.addPlaylist')} 
      disabled
    >
      <span className="material-symbols-rounded">playlist_add</span>
    </button>,
    <button
      key="play"
      className="np-icon"
      aria-label={t('player.playAlbum')}
      disabled={!tracks?.length}
      onClick={handlePlayAlbum}
    >
      <span className="material-symbols-rounded filled">play_arrow</span>
    </button>,
    <button
      key="queue"
      className="np-icon"
      aria-label={t('player.addToQueue')}
      disabled={!tracks?.length}
      onClick={handleAddToQueue}
    >
      <span className="material-symbols-rounded">queue</span>
    </button>
  ], [t, tracks?.length, handlePlayAlbum, handleAddToQueue]);

  // Memoized meta content
  const metaNode = useMemo(() => {
    if (album) {
      return (
        <AlbumMeta 
          album={album}
          releaseYear={releaseYear}
          t={t}
          onArtistClick={handleArtistClick}
        />
      );
    }
    return albumId ? t('np.loading') : t('np.noTrack');
  }, [album, releaseYear, t, albumId, handleArtistClick]);

  const currentPlayingTrackId = queueIds[currentIndex];

  return (
    <section className="center-tab" aria-labelledby="album-heading">
      <InfoHeader 
        id="album-heading" 
        title={album ? album.name : metaNode} 
        meta={album ? metaNode : undefined} 
        tags={genres} 
        actions={headerActions} 
        heroImage={heroImage} 
        ariaActionsLabel={t('np.albumActions', 'Album actions')} 
      />
      
      <div className="np-section np-album-tracks" aria-label={t('np.albumTrackList', 'Album track list')}>
        <h4 className="np-sec-title">{t('np.tracksList', 'Tracks')}</h4>
        {loading.tracks && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {!loading.tracks && !tracks && albumId && <p className="np-hint">{t('np.loading')}</p>}
        {!loading.tracks && tracks && (
          <TrackList 
            tracks={tracks} 
            playingTrackId={currentPlayingTrackId} 
            showPlayButton 
          />
        )}
      </div>
      
      <AlbumCredits 
        album={album}
        loading={loading.album}
        t={t}
      />
    </section>
  );
}
