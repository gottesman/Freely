import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useI18n } from '../../core/i18n';
import { SpotifyArtist, SpotifyAlbum, SpotifyTrack, SpotifyPlaylist } from '../../core/SpotifyClient';
import useFollowedArtists from '../../core/Artists';
import { usePlaybackSelector } from '../../core/Playback';
import TrackList from '../Utilities/TrackList';
import InfoHeader from '../Utilities/InfoHeader';

import { 
  fmtMs, 
  useHeroImage, 
  useStableTabAPI,
  usePlaybackActions,
  navigationEvents,
  formatFollowerCount,
  processBioText
} from '../Utilities/Helpers';

// Constants for configuration
const ARTIST_CONFIG = {
  TOP_TRACKS_LIMIT: 10,
  ALBUMS_LIMIT: 20,
  ALBUMS_DISPLAY_LIMIT: 8,
  PLAYLISTS_DISPLAY_LIMIT: 8,
  PLAYLISTS_FALLBACK_LIMIT: 4,
  BIO_PREVIEW_LENGTH: 500,
} as const;

const GRID_STYLES = {
  albums: {
    listStyle: 'none' as const,
    margin: 0,
    padding: 0,
    display: 'grid' as const,
    gap: '12px',
    gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))',
  },
  playlists: {
    listStyle: 'none' as const,
    margin: 0,
    padding: 0,
    display: 'grid' as const,
    gap: '12px',
    gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))',
  },
} as const;

// Interfaces for state management
interface ArtistLoadingState {
  artist: boolean;
  topTracks: boolean;
  albums: boolean;
  playlists: boolean;
  bio: boolean;
}

interface ArtistData {
  artist?: SpotifyArtist;
  topTracks?: SpotifyTrack[];
  recentAlbums?: SpotifyAlbum[];
  playlists?: SpotifyPlaylist[];
}

interface BiographyState {
  bio?: string;
  bioErr?: string;
  bioExpanded: boolean;
  lastBioArtist?: string;
}

// Custom hook for Spotify API calls
function useSpotifyAPI() {
  return useStableTabAPI();
}

// Custom hook for managing artist data loading
function useArtistData(api: ReturnType<typeof useSpotifyAPI>, artistId?: string) {
  const [data, setData] = useState<ArtistData>({});
  const [loading, setLoading] = useState<ArtistLoadingState>({
    artist: false,
    topTracks: false,
    albums: false,
    playlists: false,
    bio: false,
  });

  // Load artist core info
  useEffect(() => {
    if (!artistId) {
      setData(prev => ({ ...prev, artist: undefined }));
      return;
    }

    let cancelled = false;
    setLoading(prev => ({ ...prev, artist: true }));
    setData(prev => ({ ...prev, artist: undefined }));

    api.getArtist(artistId)
      .then(artist => {
        if (!cancelled) {
          setData(prev => ({ ...prev, artist }));
        }
      })
      .catch(() => {
        // Ignore errors
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(prev => ({ ...prev, artist: false }));
        }
      });

    return () => { cancelled = true; };
  }, [artistId]); // Removed api from dependencies

  // Load top tracks
  useEffect(() => {
    if (!artistId) {
      setData(prev => ({ ...prev, topTracks: undefined }));
      return;
    }

    let cancelled = false;
    setLoading(prev => ({ ...prev, topTracks: true }));
    setData(prev => ({ ...prev, topTracks: undefined }));

    api.getArtistTopTracks(artistId)
      .then(tracks => {
        if (!cancelled && tracks) {
          setData(prev => ({ 
            ...prev, 
            topTracks: tracks.slice(0, ARTIST_CONFIG.TOP_TRACKS_LIMIT) 
          }));
        }
      })
      .catch(() => {
        // Ignore errors
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(prev => ({ ...prev, topTracks: false }));
        }
      });

    return () => { cancelled = true; };
  }, [artistId]); // Removed api from dependencies

  // Load recent albums
  useEffect(() => {
    if (!artistId) {
      setData(prev => ({ ...prev, recentAlbums: undefined }));
      return;
    }

    let cancelled = false;
    setLoading(prev => ({ ...prev, albums: true }));
    setData(prev => ({ ...prev, recentAlbums: undefined }));

    api.getArtistAlbums(artistId)
      .then(albums => {
        if (!cancelled && albums) {
          // Sort descending by release date
          albums.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
          
          // Deduplicate by album name
          const seen = new Set<string>();
          const dedup: SpotifyAlbum[] = [];
          for (const alb of albums) {
            if (!seen.has(alb.name.toLowerCase())) {
              dedup.push(alb);
              seen.add(alb.name.toLowerCase());
            }
          }
          
          setData(prev => ({ 
            ...prev, 
            recentAlbums: dedup.slice(0, ARTIST_CONFIG.ALBUMS_DISPLAY_LIMIT) 
          }));
        }
      })
      .catch(() => {
        // Ignore errors
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(prev => ({ ...prev, albums: false }));
        }
      });

    return () => { cancelled = true; };
  }, [artistId]); // Removed api from dependencies

  // Load playlists containing artist
  useEffect(() => {
    if (!data.artist?.name) {
      setData(prev => ({ ...prev, playlists: undefined }));
      return;
    }

    let cancelled = false;
    const name = data.artist.name;
    setLoading(prev => ({ ...prev, playlists: true }));
    setData(prev => ({ ...prev, playlists: undefined }));

    api.searchPlaylists(name)
      .then(items => {
        if (!cancelled && items) {
          // Filter those whose name or description mention the artist
          const lower = name.toLowerCase();
          const filtered = items.filter(p => 
            (p.name || '').toLowerCase().includes(lower) || 
            (p.description || '').toLowerCase().includes(lower)
          );
          
          const result = filtered.length 
            ? filtered.slice(0, ARTIST_CONFIG.PLAYLISTS_DISPLAY_LIMIT)
            : items.slice(0, ARTIST_CONFIG.PLAYLISTS_FALLBACK_LIMIT);
            
          setData(prev => ({ ...prev, playlists: result }));
        }
      })
      .catch(() => {
        // Ignore errors
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(prev => ({ ...prev, playlists: false }));
        }
      });

    return () => { cancelled = true; };
  }, [data.artist?.name]); // Removed api from dependencies

  return { ...data, loading };
}

// Custom hook for biography management
function useBiography(artistName?: string) {
  const [bioState, setBioState] = useState<BiographyState>({
    bioExpanded: false,
  });
  const [loading, setLoading] = useState(false);
  const api = useStableTabAPI();

  useEffect(() => {
    const artistNameRaw = artistName?.trim();
    if (!artistNameRaw || artistNameRaw === bioState.lastBioArtist) return;

    let cancelled = false;
    setLoading(true);
    setBioState(prev => ({ 
      ...prev, 
      bio: undefined, 
      bioErr: undefined 
    }));

    (async () => {
      try {        
        const searchRes = await api.geniusSearch(artistNameRaw);
        
        const hits = searchRes?.hits || [];
        const target = hits.find((h: any) => 
          h.primaryArtist?.name && 
          h.primaryArtist.name.toLowerCase() === artistNameRaw.toLowerCase()
        ) || hits[0];
        
        const artistId = target?.primaryArtist?.id;
        if (!artistId) throw new Error('No matching Genius artist');
        
        const ga = await api.geniusGetArtist(artistId);
        
        if (cancelled) return;
        
        const html: string | undefined = ga?.description?.html || 
          ga?.descriptionPlain || 
          ga?.description?.plain;
          
        setBioState(prev => ({ 
          ...prev, 
          bio: html || undefined, 
          lastBioArtist: artistNameRaw 
        }));
      } catch (e: any) {
        if (!cancelled) {
          setBioState(prev => ({ 
            ...prev, 
            bioErr: e?.message || 'Bio unavailable' 
          }));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [artistName, bioState.lastBioArtist]);

  const toggleExpanded = useCallback(() => {
    setBioState(prev => ({ ...prev, bioExpanded: !prev.bioExpanded }));
  }, []);

  return { ...bioState, loading, toggleExpanded };
}

// Custom hook for follow functionality
function useFollowManagement(artist?: SpotifyArtist) {
  const { followArtist, unfollowArtist, isFollowing } = useFollowedArtists();
  const [localFollowing, setLocalFollowing] = useState(false);
  const optimisticUpdateRef = useRef<{ id: string; following: boolean } | null>(null);
  const legacyEventHandledRef = useRef<boolean>(false);

  // Sync local following state
  useEffect(() => {
    if (artist?.id) {
      const optimistic = optimisticUpdateRef.current;
      if (optimistic && optimistic.id === artist.id) {
        return; // Don't override optimistic updates
      } else if (legacyEventHandledRef.current) {
        return; // Don't override if legacy event handled
      } else {
        const actualFollowing = isFollowing(artist.id);
        setLocalFollowing(actualFollowing);
      }
    } else {
      setLocalFollowing(false);
      legacyEventHandledRef.current = false;
    }
  }, [artist?.id, isFollowing]);

  // Listen to legacy global artist change events
  useEffect(() => {
    const handler = (event: any) => {
      if (artist?.id) {
        const eventArtists = event?.detail?.artists;
        if (eventArtists && Array.isArray(eventArtists)) {
          const isInEventList = eventArtists.some((a: any) => a.id === artist.id);
          setLocalFollowing(isInEventList);
          legacyEventHandledRef.current = true;
          
          if (optimisticUpdateRef.current?.id === artist.id) {
            optimisticUpdateRef.current = null;
          }
        } else if (!optimisticUpdateRef.current || optimisticUpdateRef.current.id !== artist.id) {
          const actualFollowing = isFollowing(artist.id);
          setLocalFollowing(actualFollowing);
          legacyEventHandledRef.current = true;
        }
      }
    };
    
    window.addEventListener('freely:followed-artists-changed', handler);
    return () => window.removeEventListener('freely:followed-artists-changed', handler);
  }, [artist?.id, isFollowing]);

  const toggleFollow = useCallback(async () => {
    if (!artist) return;
    
    const id = artist.id;
    const currently = localFollowing;
    
    legacyEventHandledRef.current = false;
    
    const newFollowingState = !currently;
    optimisticUpdateRef.current = { id, following: newFollowingState };
    setLocalFollowing(newFollowingState);
    
    try {
      if (currently) {
        await unfollowArtist(id);
      } else {
        await followArtist(artist);
      }
    } catch (e) {
      console.warn('follow toggle failed', e);
      optimisticUpdateRef.current = null;
      legacyEventHandledRef.current = false;
      setLocalFollowing(currently);
    }
  }, [artist, localFollowing, followArtist, unfollowArtist]);

  return { localFollowing, toggleFollow };
}

// Memoized components for better performance
const ArtistGrid = React.memo<{
  items: SpotifyAlbum[] | SpotifyPlaylist[];
  type: 'albums' | 'playlists';
  onItemClick: (id: string, type: 'album' | 'playlist') => void;
  t: (key: string, fallback?: string, options?: any) => string;
}>(({ items, type, onItemClick, t }) => (
  <ul className="artist-grid" role="list" style={GRID_STYLES[type]}>
    {items.map(item => (
      <li key={item.id} className="artist-grid-item" title={item.name}>
        <button 
          type="button" 
          className="card-btn" 
          style={{ display: 'flex', flexDirection: 'column', width: '100%', textAlign: 'left' }}
          onClick={() => onItemClick(item.id, type === 'albums' ? 'album' : 'playlist')}
        >
          <div 
            className="cover" 
            style={{
              width: '100%', 
              aspectRatio: '1/1', 
              backgroundSize: 'cover', 
              backgroundPosition: 'center', 
              borderRadius: '8px', 
              backgroundImage: `url(${(window as any).imageRes?.(item.images, 1) || ''})`
            }} 
          />
          <div className="info" style={{ marginTop: '6px' }}>
            <div 
              className="overflow-ellipsis" 
              title={item.name} 
              style={{ fontSize: '0.85rem', fontWeight: 500 }}
            >
              {item.name}
            </div>
            <div className="meta" style={{ opacity: 0.7, fontSize: '0.7rem' }}>
              {type === 'albums' 
                ? (item as SpotifyAlbum).releaseDate?.split('-')[0] || ''
                : typeof (item as SpotifyPlaylist).totalTracks === 'number' 
                  ? t('np.tracks', undefined, { count: (item as SpotifyPlaylist).totalTracks })
                  : ''
              }
            </div>
          </div>
        </button>
      </li>
    ))}
  </ul>
));

const BiographySection = React.memo<{
  bio?: string;
  bioErr?: string;
  bioExpanded: boolean;
  loading: boolean;
  onToggleExpanded: () => void;
  t: (key: string, fallback?: string) => string;
}>(({ bio, bioErr, bioExpanded, loading, onToggleExpanded, t }) => (
  <div className="np-section np-artist-info" aria-label={t('np.artistBio', 'Artist biography')}>
    <h4 className="np-sec-title">{t('np.bio.title', 'Biography')}</h4>
    {loading && <p className="np-hint">{t('np.bio.loading')}</p>}
    {!loading && bioErr && <p className="np-error" role="alert">{bioErr}</p>}
    {!loading && !bioErr && !bio && <p className="np-hint">{t('np.bio.notFound', 'No biography found')}</p>}
    {!loading && bio && (
      <div className={`artist-bio ${bioExpanded ? 'expanded' : 'collapsed'}`}>
        <div className="bio-content">
          <div 
            className="np-bio-text" 
            dangerouslySetInnerHTML={{ __html: bio }} 
          />
        </div>
        <button 
          type="button" 
          className="bio-toggle np-link" 
          onClick={onToggleExpanded}
        >
          {bioExpanded ? t('np.bio.showLess') : t('np.bio.readMore')}
        </button>
      </div>
    )}
  </div>
));

export default function ArtistInfoTab({ artistId }: { artistId?: string }) {
  const { t } = useI18n();
  const queueIds = usePlaybackSelector(s => s.queueIds ?? []);
  const currentIndex = usePlaybackSelector(s => s.currentIndex ?? 0);
  const currentTrack = usePlaybackSelector(s => s.currentTrack);
  const playbackActions = usePlaybackActions();

  const api = useSpotifyAPI();
  const { artist, topTracks, recentAlbums, playlists, loading } = useArtistData(api, artistId);
  const { bio, bioErr, bioExpanded, loading: bioLoading, toggleExpanded } = useBiography(artist?.name);
  const { localFollowing, toggleFollow } = useFollowManagement(artist);

  // Memoized computed values
  const heroImage = useMemo(() => 
    useHeroImage(artist?.images, 0), 
    [artist?.images]
  );

  const genres = useMemo(() => 
    artist?.genres ?? [], 
    [artist?.genres]
  );

  const followersMeta = useMemo(() => {
    if (artist && artist.followers !== undefined) {
      const count = formatFollowerCount(artist.followers);
      const label = t('np.followers', undefined, { count: '' }).replace('{count', '');
      return `${count} ${label}`;
    }
    return undefined;
  }, [artist, t]);

  // Optimized event handlers
  const handleItemClick = useCallback((id: string, type: 'album' | 'playlist') => {
    if (type === 'album') {
      navigationEvents.selectAlbum(id, 'artist-info');
    } else {
      navigationEvents.selectPlaylist(id, 'artist-info');
    }
  }, []);

  // Memoized header actions
  const headerActions = useMemo(() => [
    <button 
      key="follow" 
      className={`np-icon ${artist && localFollowing ? 'active' : ''}`} 
      aria-pressed={artist ? localFollowing : false} 
      aria-label={t('np.like', 'Like')} 
      onClick={toggleFollow}
    >
      <span className={`material-symbols-rounded${artist && localFollowing ? ' filled' : ''}`}>
        favorite
      </span>
    </button>
  ], [artist, localFollowing, t, toggleFollow]);

  return (
    <section className="center-tab" aria-labelledby="artist-heading">
      <InfoHeader
        id="artist-heading"
        title={artist ? artist.name : (artistId ? t('np.loading') : t('np.noArtist'))}
        meta={followersMeta ? <span className="np-album-trackcount">{followersMeta}</span> : undefined}
        tags={genres}
        actions={headerActions}
        heroImage={heroImage}
        ariaActionsLabel={t('np.artistActions', 'Artist actions')}
      />

      {/* Top Tracks */}
      <div className="np-section" aria-label={t('np.topTracks', 'Top tracks')}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 className="np-sec-title">{t('np.topTracks', 'Top Tracks')}</h4>
        </div>
        {loading.topTracks && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {!loading.topTracks && !topTracks && artistId && <p className="np-hint">{t('np.loading')}</p>}
        {!loading.topTracks && topTracks && (
          <TrackList
            tracks={topTracks}
            playingTrackId={currentTrack?.id}
            showPlayButton
          />
        )}
      </div>

      {/* Recent releases */}
      <div className="np-section" aria-label={t('np.recentReleases', 'Recent releases')}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 className="np-sec-title">{t('np.recentReleases', 'Recent Releases')}</h4>
          <button 
            type="button" 
            className="np-link" 
            disabled={!artist} 
            onClick={() => {/* Placeholder for full discography action */}}
          >
            {t('np.viewDiscography', 'See all')}
          </button>
        </div>
        {loading.albums && <p className="np-hint">{t('np.loadingAlbums', 'Loading albums')}</p>}
        {!loading.albums && recentAlbums && recentAlbums.length === 0 && (
          <p className="np-hint">{t('np.noAlbums', 'No releases')}</p>
        )}
        {!loading.albums && recentAlbums && recentAlbums.length > 0 && (
          <ArtistGrid 
            items={recentAlbums} 
            type="albums" 
            onItemClick={handleItemClick} 
            t={t} 
          />
        )}
      </div>

      {/* Playlists containing artist */}
      <div className="np-section" aria-label={t('np.playlistsFeaturing', 'Playlists featuring artist')}>
        <h4 className="np-sec-title">{t('np.playlistsFeaturing', 'Playlists Featuring')}</h4>
        {loading.playlists && <p className="np-hint">{t('np.loadingPlaylists', 'Loading playlists')}</p>}
        {!loading.playlists && playlists && playlists.length === 0 && (
          <p className="np-hint">{t('np.noPlaylists', 'No playlists found')}</p>
        )}
        {!loading.playlists && playlists && playlists.length > 0 && (
          <ArtistGrid 
            items={playlists} 
            type="playlists" 
            onItemClick={handleItemClick} 
            t={t} 
          />
        )}
      </div>

      {/* Biography */}
      <BiographySection
        bio={bio}
        bioErr={bioErr}
        bioExpanded={bioExpanded}
        loading={bioLoading}
        onToggleExpanded={toggleExpanded}
        t={t}
      />
    </section>
  );
}
