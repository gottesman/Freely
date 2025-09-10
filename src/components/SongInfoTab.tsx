import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useI18n } from '../core/i18n';
import { usePlaybackSelector } from '../core/playback';
import { type SpotifyAlbum, type SpotifyArtist, type SpotifyTrack } from '../core/spotify';
import TrackList from './TrackList';
import TrackSources from './TrackSources';
import InfoHeader from './InfoHeader';
import { 
  fmtMs, 
  useHeroImage, 
  extractReleaseYear, 
  calculateArtistColWidth,
  useStableTabAPI,
  usePlaybackActions,
  navigationEvents,
  playbackEvents,
  extractWritersFromGenius
} from './tabHelpers';

type Props = {
  trackId?: string;
};

// Consolidated state interface
interface SongInfoState {
  selectedTrackId: string | undefined;
  track: SpotifyTrack | undefined;
  album: SpotifyAlbum | undefined;
  primaryArtist: SpotifyArtist | undefined;
  albumTracks: SpotifyTrack[] | undefined;
  tracksLoading: boolean;
  writers: string[] | undefined;
  writersLoading: boolean;
}

// Custom hook for playback selectors
function usePlaybackData(trackId?: string) {
  const isUsingPlayback = trackId === undefined;
  
  const playingTrackId = usePlaybackSelector(
    s => isUsingPlayback ? s.trackId : undefined, 
    [isUsingPlayback]
  ) as string | undefined;
  
  const playbackTrack = usePlaybackSelector(
    s => isUsingPlayback ? s.currentTrack : undefined, 
    [isUsingPlayback]
  ) as SpotifyTrack | undefined;
  
  const currentIndex = usePlaybackSelector(
    s => isUsingPlayback ? s.currentIndex : undefined, 
    [isUsingPlayback]
  ) as number | undefined;
  
  const queueIds = usePlaybackSelector(
    s => isUsingPlayback ? s.queueIds : undefined, 
    [isUsingPlayback]
  ) as string[] | undefined;

  return { playingTrackId, playbackTrack, currentIndex, queueIds };
}

// Custom hook for API methods (stable reference)
function useStableAPI() {
  return useStableTabAPI();
}

export default function SongInfoTab({ trackId }: Props) {
  const { t } = useI18n();
  const { playingTrackId, playbackTrack, currentIndex, queueIds } = usePlaybackData(trackId);
  const playbackActions = usePlaybackActions();
  
  // Consolidated state
  const [state, setState] = useState<SongInfoState>(() => ({
    selectedTrackId: trackId ?? playingTrackId,
    track: undefined,
    album: undefined,
    primaryArtist: undefined,
    albumTracks: undefined,
    tracksLoading: false,
    writers: undefined,
    writersLoading: false,
  }));

  // Refs for preserving scroll position and container
  const containerRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(true);

  // Stable API reference
  const api = useStableAPI();

  // State update helpers
  const updateState = useCallback((updates: Partial<SongInfoState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  // Update selected track ID when trackId prop changes
  useEffect(() => {
    if (trackId !== undefined && trackId !== state.selectedTrackId) {
      updateState({ selectedTrackId: trackId });
    }
  }, [trackId, state.selectedTrackId, updateState]);

  // Keep a stable mounted flag for cancellation
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load track when selectedTrackId changes (or use playbackTrack if matches)
  useEffect(() => {
    let active = true;
    async function loadTrack() {
      updateState({ track: undefined });
      if (!state.selectedTrackId) return;
      
      // Prefer playbackTrack if it matches
      if (playbackTrack && playbackTrack.id === state.selectedTrackId) {
        if (mountedRef.current && active) {
          updateState({ track: playbackTrack });
        }
        return;
      }
      
      try {
        const tr = await api.getTrack(state.selectedTrackId);
        if (!active || !mountedRef.current) return;
        if (tr) {
          updateState({ track: tr });
        }
      } catch {
        // keep silent on errors to preserve original behavior
      }
    }
    loadTrack();
    return () => {
      active = false;
    };
  }, [state.selectedTrackId, playbackTrack, api, updateState]);

  // Load album and primary artist for the current track
  useEffect(() => {
    let active = true;
    async function loadAlbumAndArtist() {
      if (!state.track?.id || !state.track.album?.id || !state.track.artists?.[0]?.id) {
        // clear dependent state when track lacks details
        if (mountedRef.current && active) {
          updateState({ album: undefined, primaryArtist: undefined });
        }
        return;
      }
      const albumId = state.track.album.id;
      const artistId = state.track.artists[0].id;

      try {
        const [alb, art] = await Promise.all([api.getAlbum(albumId), api.getArtist(artistId)]);
        if (!active || !mountedRef.current) return;
        updateState({ 
          album: alb || undefined, 
          primaryArtist: art || undefined 
        });
      } catch {
        // ignore errors
      }
    }
    loadAlbumAndArtist();
    return () => {
      active = false;
    };
  }, [state.track?.album?.id, state.track?.artists?.[0]?.id, api, updateState]);

  // Load album tracks
  useEffect(() => {
    let active = true;
    async function loadAlbumTracks() {
      if (!state.track?.album?.id) {
        if (mountedRef.current && active) {
          updateState({ albumTracks: undefined, tracksLoading: false });
        }
        return;
      }
      updateState({ tracksLoading: true, albumTracks: undefined });
      try {
        const tracks = await api.getAlbumTracks(state.track.album.id);
        if (!active || !mountedRef.current) return;
        updateState({ albumTracks: tracks });
      } catch {
        // ignore
      } finally {
        if (mountedRef.current && active) {
          updateState({ tracksLoading: false });
        }
      }
    }
    loadAlbumTracks();
    return () => {
      active = false;
    };
  }, [state.track?.album?.id, api, updateState]);

  // Load writers (Genius)
  useEffect(() => {
    let active = true;
    async function loadWriters() {
      updateState({ writers: undefined });
      if (!state.track?.name || !state.primaryArtist?.name) {
        updateState({ writersLoading: false });
        return;
      }
      const query = `${state.track.name} ${state.primaryArtist.name}`;
      updateState({ writersLoading: true });
      try {
        const searchRes = await api.geniusSearch(query);
        const hits = searchRes?.hits ?? [];
        const lowerArtist = state.primaryArtist.name.toLowerCase();
        const target = hits.find((h: any) => h.primaryArtist?.name?.toLowerCase() === lowerArtist) || hits[0];
        const songId = target?.id;
        if (!songId) return;
        const songDetails = await api.geniusGetSong(songId);
        if (!active || !mountedRef.current) return;
        const writers = extractWritersFromGenius(songDetails);
        if (writers.length > 0) {
          updateState({ writers });
        }
      } catch {
        // ignore
      } finally {
        if (mountedRef.current && active) {
          updateState({ writersLoading: false });
        }
      }
    }
    loadWriters();
    return () => {
      active = false;
    };
  }, [state.track?.name, state.primaryArtist?.name, api, updateState]);

  // Derived values (memoized)
  const heroImage = useMemo(() => useHeroImage(state.album?.images ?? state.track?.album?.images, 0), [state.album?.images, state.track?.album?.images]);

  const releaseYear = useMemo(() => extractReleaseYear(state.album?.releaseDate), [state.album?.releaseDate]);

  const genres = useMemo(() => state.primaryArtist?.genres ?? [], [state.primaryArtist?.genres]);

  const artistColWidth = useMemo(() => calculateArtistColWidth(state.albumTracks), [state.albumTracks]);

  // Play / queue handlers (stable callbacks)
  const handlePlayTrack = useCallback(() => {
    if (!state.track?.id) return;
    // Use optimized playNow event for immediate playback
    playbackEvents.playNow([state.track.id]);
  }, [state.track?.id]);

  const handleAddToQueue = useCallback(() => {
    if (!state.track?.id) return;
    playbackActions.addToQueue([state.track.id], queueIds);
  }, [state.track?.id, queueIds, playbackActions]);

  const onAddToPlaylist = useCallback(() => {
    if (!state.track) return;
    playbackActions.addToPlaylist(state.track);
  }, [state.track, playbackActions]);

  const headerActions = useMemo(() => [
    <button key="add-playlist" className="np-icon" aria-label={t('player.addPlaylist')} disabled={!state.track?.id} onClick={onAddToPlaylist}>
      <span className="material-symbols-rounded">add_circle</span>
    </button>,
    <button key="play" className="np-icon" aria-label={t('player.playTrack')} disabled={!state.track?.id} onClick={handlePlayTrack}>
      <span className="material-symbols-rounded filled">play_arrow</span>
    </button>,
    <button key="queue" className="np-icon" aria-label={t('player.addToQueue')} disabled={!state.track?.id} onClick={handleAddToQueue}>
      <span className="material-symbols-rounded">queue</span>
    </button>
  ], [t, state.track?.id, onAddToPlaylist, handlePlayTrack, handleAddToQueue]);

  return (
    <section ref={containerRef} className="center-tab" aria-labelledby="np-heading">
      <InfoHeader
        id="np-heading"
        title={state.track ? state.track.name : state.selectedTrackId ? t('np.loading') : t('np.noTrack')}
        meta={state.track ? (
          <>
            <span className="np-artists">
              {state.track.artists.map((a, i) => (
                <React.Fragment key={a.id ?? a.name}>
                  {i > 0 && <span className="np-sep">, </span>}
                  <button
                    type="button"
                    className="np-link artist"
                    onClick={() => {
                      if (a.id) navigationEvents.selectArtist(a.id, 'song-info');
                      else if (a.url) window.open(a.url, '_blank');
                    }}
                  >
                    {a.name}
                  </button>
                </React.Fragment>
              ))}
            </span>
            {state.track.album?.name && (
              <>
                <span className="np-dot" />
                {state.track.album.id ? (
                  <button type="button" className="np-link np-album" onClick={() => { if (state.track?.album?.id) navigationEvents.selectAlbum(state.track.album.id, 'song-info'); }}>{state.track.album.name}</button>
                ) : (
                  <span className="np-album">{state.track.album.name}</span>
                )}
              </>
            )}
          </>
        ) : undefined}
        tags={genres}
        actions={headerActions}
        heroImage={heroImage}
        ariaActionsLabel={t('np.trackActions')}
      />

      {/* Audio source chooser */}
      <TrackSources track={state.track} album={state.album} primaryArtist={state.primaryArtist} />

      <div className="np-section np-album-tracks" aria-label={t('np.albumTrackList', 'Album track list')}>
        <h4 className="np-sec-title">{t('np.fromSameAlbum')}</h4>
        {state.album && (
          <div className="np-album-heading">
            <span className="np-album-name" title={state.album.name}>{state.album.name}</span>
            <span className="np-album-trackcount">{t('np.tracks', undefined, { count: state.album.totalTracks })}</span>
          </div>
        )}

        {!state.track && state.selectedTrackId && !state.albumTracks && <p className="np-hint">{t('np.loading')}</p>}
        {!state.selectedTrackId && <p className="np-hint">{t('np.selectTrackHint')}</p>}
        {state.tracksLoading && <p className="np-hint">{t('np.loadingTracks')}</p>}

        {state.albumTracks && (
          <TrackList
            tracks={state.albumTracks}
            selectedTrackId={state.track?.id}
            playingTrackId={playingTrackId}
            showPlayButton
          />
        )}

        {!state.tracksLoading && !state.albumTracks && state.track?.album && <p className="np-hint">{t('np.albumUnavailable')}</p>}
      </div>

      <div className="np-section np-track-credits" aria-label={t('np.trackCredits', 'Track credits')}>
        <h4 className="np-sec-title">{t('np.trackCredits', 'Credits')}</h4>
        {!state.track && <p className="np-hint">{t('np.noTrack')}</p>}
        {state.track && (
          <ul className="credits-list">
            <li>
              <span className="cl-label">{t('np.primaryArtist', 'Primary Artist')}</span>:
              <span className="cl-value">{state.primaryArtist?.name || state.track.artists?.[0]?.name || '—'}</span>
            </li>

            {state.track.artists && state.track.artists.length > 1 && (
              <li>
                <span className="cl-label">{t('np.featuring', 'Featuring')}</span>:
                <span className="cl-value">{state.track.artists.slice(1).map((a) => a.name).join(', ')}</span>
              </li>
            )}

            {state.album && (
              <li>
                <span className="cl-label">{t('np.album', 'Album')}</span>:
                <span className="cl-value">
                  {state.album.name}
                  {releaseYear ? ` (${releaseYear})` : ''}
                </span>
              </li>
            )}

            {state.album && (
              <li>
                <span className="cl-label">{t('np.trackNumber', 'Track')}</span>:
                <span className="cl-value">
                  {state.track.trackNumber}
                  {state.album.totalTracks ? ` / ${state.album.totalTracks}` : ''}
                  {state.track.discNumber > 1 ? ` · Disc ${state.track.discNumber}` : ''}
                </span>
              </li>
            )}

            <li>
              <span className="cl-label">{t('np.duration', 'Duration')}</span>:
              <span className="cl-value">{fmtMs(state.track.durationMs)}</span>
            </li>

            {typeof state.track.explicit === 'boolean' && (
              <li>
                <span className="cl-label">{t('np.explicit', 'Explicit')}</span>:
                <span className="cl-value">{state.track.explicit ? t('np.yes', 'Yes') : t('np.no', 'No')}</span>
              </li>
            )}

            {state.writersLoading && (
              <li className="loading">
                <span className="cl-label">{t('np.writers', 'Writers')}</span>:
                <span className="cl-value">{t('np.loading', 'Loading')}</span>
              </li>
            )}

            {!state.writersLoading && state.writers && state.writers.length > 0 && (
              <li>
                <span className="cl-label">{t('np.writers', 'Writers')}</span>:
                <span className="cl-value">{state.writers.join(', ')}</span>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
