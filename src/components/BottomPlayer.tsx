import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaybackSelector } from '../core/playback';
import { useI18n } from '../core/i18n';
import { useAlerts } from '../core/alerts';
import { usePlaylists } from '../core/playlists';

// Constants for performance optimization
const RAF_THROTTLE_MS = 200; // Throttle state updates to reduce re-renders
const DEFAULT_VOLUME = 40;
const SEEK_PRECISION = 1000; // Milliseconds precision for seeking

// Combined state interface for better performance
interface PlayerState {
  volume: number;
  isPlaying: boolean;
  positionMs: number;
  isTrackInAnyPlaylist: boolean;
}

const initialPlayerState: PlayerState = {
  volume: DEFAULT_VOLUME,
  isPlaying: true,
  positionMs: 0,
  isTrackInAnyPlaylist: false
};

// Utility functions
const formatTime = (ms?: number): string => {
  if (ms === undefined || isNaN(ms)) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + s.toString().padStart(2, '0');
};

const createPlaybackEvent = (type: string) => () => 
  window.dispatchEvent(new Event(`freely:playback:${type}`));

const createCustomEvent = (type: string, detail: any) => 
  window.dispatchEvent(new CustomEvent(type, { detail }));

type Props = {
  lyricsOpen?: boolean;
  onToggleLyrics?: () => void;
  onToggleQueueTab?: () => void;
  queueActive?: boolean;
};

export default function BottomPlayer({
  lyricsOpen,
  onToggleLyrics,
  onToggleQueueTab,
  queueActive,
}: Props) {
  // Memoized playback control functions
  const playbackControls = useMemo(() => ({
    next: createPlaybackEvent('next'),
    prev: createPlaybackEvent('prev')
  }), []);

  // Playback selectors
  const currentTrack = usePlaybackSelector(s => s.currentTrack);
  const trackLoading = usePlaybackSelector(s => s.loading);
  const error = usePlaybackSelector(s => s.error);
  
  // Hooks
  const { t } = useI18n();
  const { push: pushAlert, alerts } = useAlerts();
  const { playlists, getPlaylistTrackIds } = usePlaylists();

  // Combined state for better performance
  const [playerState, setPlayerState] = useState<PlayerState>(initialPlayerState);
  
  // Optimized refs
  const refs = useRef({
    volume: null as HTMLInputElement | null,
    raf: null as number | null,
    lastFrameTime: null as number | null,
    position: 0,
    duration: 0,
    autoNextTriggered: false,
    mounted: true,
    lastStateUpdate: 0
  });

  // Memoized track metadata
  const trackMetadata = useMemo(() => {
    const title = currentTrack?.name || (trackLoading ? t('np.loading') : t('np.noTrack'));
    const artist = currentTrack?.artists?.map((a) => a.name).join(', ') || '';
    const album = currentTrack?.album?.name || '';
    const cover = (window as any).imageRes?.(currentTrack?.album?.images, 0) || '';
    const durationMs = currentTrack?.durationMs || 0;
    
    return { title, artist, album, cover, durationMs };
  }, [currentTrack, trackLoading, t]);

  // Memoized progress calculation
  const progress = useMemo(() => 
    trackMetadata.durationMs ? Math.min(1, playerState.positionMs / trackMetadata.durationMs) : 0,
    [playerState.positionMs, trackMetadata.durationMs]
  );
  // Cleanup effect
  useEffect(() => {
    refs.current.mounted = true;
    return () => {
      refs.current.mounted = false;
      if (refs.current.raf) {
        cancelAnimationFrame(refs.current.raf);
        refs.current.raf = null;
      }
    };
  }, []);

  // Volume CSS variable update (optimized)
  useEffect(() => {
    if (refs.current.volume) {
      refs.current.volume.style.setProperty('--vol', `${playerState.volume}%`);
    }
  }, [playerState.volume]);

  // Optimized volume handler
  const onVolume = useCallback((v: number) => {
    setPlayerState(prev => ({ ...prev, volume: v }));
    if (refs.current.volume) {
      refs.current.volume.style.setProperty('--vol', `${v}%`);
    }
  }, []);

  // Alert on playback errors (dedupe by message)
  useEffect(() => {
    if (error && !alerts.some((a) => a.msg === error)) {
      pushAlert(error, 'error');
    }
  }, [error, alerts, pushAlert]);

  // Reset position when track changes
  useEffect(() => {
    refs.current.position = 0;
    refs.current.lastFrameTime = null;
    refs.current.autoNextTriggered = false;
    refs.current.duration = trackMetadata.durationMs;
    
    setPlayerState(prev => ({ ...prev, positionMs: 0 }));
  }, [currentTrack?.id, trackMetadata.durationMs]);

  // Optimized playlist checking with better error handling
  useEffect(() => {
    let cancelled = false;
    
    const checkPlaylistMembership = async () => {
      if (!currentTrack?.id || !playlists?.length) {
        if (!cancelled) {
          setPlayerState(prev => ({ ...prev, isTrackInAnyPlaylist: false }));
        }
        return;
      }

      try {
        // Use Promise.allSettled for better error handling
        const results = await Promise.allSettled(
          playlists.map(async (playlist) => {
            const trackIds = await getPlaylistTrackIds(playlist.id);
            return trackIds.includes(currentTrack.id);
          })
        );

        if (cancelled || !refs.current.mounted) return;

        const isInAnyPlaylist = results.some(result => 
          result.status === 'fulfilled' && result.value
        );

        setPlayerState(prev => ({ ...prev, isTrackInAnyPlaylist: isInAnyPlaylist }));
      } catch {
        if (!cancelled) {
          setPlayerState(prev => ({ ...prev, isTrackInAnyPlaylist: false }));
        }
      }
    };

    checkPlaylistMembership();
    return () => { cancelled = true; };
  }, [currentTrack?.id, playlists, getPlaylistTrackIds]);

  // Optimized RAF-driven progress updater
  useEffect(() => {
    // Cleanup any existing RAF
    if (refs.current.raf) {
      cancelAnimationFrame(refs.current.raf);
      refs.current.raf = null;
    }

    // No duration or not playing => do not start RAF
    const duration = trackMetadata.durationMs;
    refs.current.duration = duration;
    refs.current.position = Math.min(refs.current.position, duration);
    
    setPlayerState(prev => ({ ...prev, positionMs: refs.current.position }));

    if (!playerState.isPlaying || duration <= 0) {
      return;
    }

    refs.current.lastFrameTime = null;
    refs.current.autoNextTriggered = false;
    refs.current.lastStateUpdate = performance.now();

    const loop = (now: number) => {
      if (!refs.current.mounted) return;
      
      if (refs.current.lastFrameTime == null) {
        refs.current.lastFrameTime = now;
      }
      
      const dt = now - refs.current.lastFrameTime;
      refs.current.lastFrameTime = now;

      // Advance position by dt milliseconds
      refs.current.position = Math.min(refs.current.duration, refs.current.position + dt);

      // If track ended, trigger next once
      if (!refs.current.autoNextTriggered && refs.current.position >= refs.current.duration) {
        refs.current.autoNextTriggered = true;
        setPlayerState(prev => ({ ...prev, positionMs: refs.current.duration }));
        
        // Use setTimeout to avoid interfering with RAF calculations
        setTimeout(() => {
          try {
            playbackControls.next();
          } catch {
            // Ignore errors from playback next
          }
        }, 0);
        return; // Stop RAF
      }

      // Throttle React state updates to reduce re-renders
      if (now - refs.current.lastStateUpdate >= RAF_THROTTLE_MS) {
        refs.current.lastStateUpdate = now;
        setPlayerState(prev => ({ ...prev, positionMs: Math.floor(refs.current.position) }));
      }

      refs.current.raf = requestAnimationFrame(loop);
    };

    refs.current.raf = requestAnimationFrame(loop);

    return () => {
      if (refs.current.raf) {
        cancelAnimationFrame(refs.current.raf);
        refs.current.raf = null;
      }
      refs.current.lastFrameTime = null;
    };
  }, [playerState.isPlaying, currentTrack?.id, trackMetadata.durationMs, playbackControls.next]);

  // Event handlers (memoized for performance)
  const togglePlay = useCallback(() => {
    setPlayerState(prev => ({ ...prev, isPlaying: !prev.isPlaying }));
  }, []);

  const onSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      if (!trackMetadata.durationMs) return;
      
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.min(1, Math.max(0, x / rect.width));
      const newPos = Math.floor(ratio * trackMetadata.durationMs);
      
      refs.current.position = newPos;
      setPlayerState(prev => ({ ...prev, positionMs: newPos }));
    },
    [trackMetadata.durationMs]
  );

  const onAddToPlaylist = useCallback(() => {
    if (!currentTrack) return;
    createCustomEvent('freely:openAddToPlaylistModal', { 
      track: currentTrack, 
      fromBottomPlayer: true 
    });
  }, [currentTrack]);

  const onMetaActivate = useCallback(
    (e?: React.MouseEvent | React.KeyboardEvent) => {
      if (e) {
        e.stopPropagation();
        if ('preventDefault' in e) e.preventDefault();
      }
      
      if (currentTrack?.id) {
        try {
          createCustomEvent('freely:selectTrack', { 
            trackId: currentTrack.id, 
            source: 'bottom-player' 
          });
        } catch {
          // Ignore errors
        }
      }
    },
    [currentTrack?.id]
  );

  const onArtistClick = useCallback(
    (e: React.MouseEvent, artist: any) => {
      e.stopPropagation();
      if (artist?.id) {
        try {
          createCustomEvent('freely:selectArtist', { 
            artistId: artist.id, 
            source: 'bottom-player' 
          });
        } catch {
          // Ignore errors
        }
      } else if (artist?.url) {
        window.open(artist.url, '_blank');
      }
    },
    []
  );

  return (
    <div className="bottom-player main-panels">
      <div className="track-progress">
        <div className="time current">{formatTime(playerState.positionMs)}</div>

        <div
          className="bar"
          onClick={onSeek}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={trackMetadata.durationMs}
          aria-valuenow={playerState.positionMs}
          aria-label={t('np.trackPosition', 'Track position')}
        >
          <div className="fill" style={{ width: `${progress * 100}%` }} />
          <div className="handle" style={{ left: `${progress * 100}%` }} />
        </div>

        <div className="time total">{formatTime(trackMetadata.durationMs)}</div>
      </div>

      <div className="track-player">
        <div className="meta-block">
          <div
            className="meta"
            role="button"
            title={`${trackMetadata.title}${trackMetadata.artist ? ` - ${trackMetadata.artist}` : ''}${trackMetadata.album ? ` (${trackMetadata.album})` : ''}`}
            tabIndex={0}
            aria-label={t('np.showDetails', 'Show song details')}
            onClick={onMetaActivate}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onMetaActivate();
              }
            }}
          >
            <div
              className="album-cover"
              role="img"
              aria-label={trackMetadata.album || t('np.noAlbum', 'No album')}
              title={trackMetadata.album || ''}
              style={trackMetadata.cover ? { backgroundImage: `url(${trackMetadata.cover})` } : undefined}
            />
            <div className="meta-text">
              <div className="song-title overflow-ellipsis">{trackMetadata.title}</div>
              <div className="song-artist overflow-ellipsis">
                {currentTrack?.artists?.map((artist, index) => (
                  <React.Fragment key={artist.id || artist.name}>
                    {index > 0 ? ', ' : ''}
                    <button
                      type="button"
                      className="np-link artist inline"
                      onClick={(e) => onArtistClick(e, artist)}
                    >
                      {artist.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>
              <div className="song-album overflow-ellipsis">{trackMetadata.album}</div>
            </div>
          </div>

          <button
            className="small player-icons player-icons-add-playlist"
            title={t('player.addPlaylist')}
            aria-label={t('player.addPlaylist')}
            onClick={onAddToPlaylist}
            disabled={!currentTrack}
          >
            <span 
              className="material-symbols-rounded" 
              style={{ color: playerState.isTrackInAnyPlaylist ? 'var(--accent)' : undefined }}
            >
              {playerState.isTrackInAnyPlaylist ? 'check_circle' : 'add_circle'}
            </span>
          </button>
        </div>

        <div className="controls">
          <button className="small player-icons player-icons-shuffle" aria-label={t('player.shuffle')}>
            <span className="material-symbols-rounded filled">shuffle</span>
          </button>

          <button 
            className="player-icons player-icons-prev" 
            aria-label={t('player.previous')} 
            onClick={playbackControls.prev}
          >
            <span className="material-symbols-rounded filled">skip_previous</span>
          </button>

          <button 
            className="play player-icons player-icons-play" 
            aria-label={playerState.isPlaying ? t('player.pause') : t('player.play')} 
            onClick={togglePlay}
          >
            <span className="material-symbols-rounded filled">
              {playerState.isPlaying ? 'pause_circle' : 'play_circle'}
            </span>
          </button>

          <button 
            className="player-icons player-icons-next" 
            aria-label={t('player.next')} 
            onClick={playbackControls.next}
          >
            <span className="material-symbols-rounded filled">skip_next</span>
          </button>

          <button className="small player-icons player-icons-repeat-off" aria-label={t('player.repeat')}>
            <span className="material-symbols-rounded filled">repeat</span>
          </button>
        </div>

        <div className="extras">
          <button
            className={`small player-icons player-icons-lyrics ${lyricsOpen ? 'active' : ''}`}
            aria-label={lyricsOpen ? t('player.hideLyrics') : t('player.showLyrics')}
            aria-pressed={lyricsOpen ? 'true' : 'false'}
            onClick={onToggleLyrics}
          >
            <span className="material-symbols-rounded">lyrics</span>
          </button>

          <button
            className={`small player-icons player-icons-queue ${queueActive ? 'active' : ''}`}
            aria-label={queueActive ? t('player.hideQueue') : t('player.showQueue')}
            aria-pressed={queueActive ? 'true' : 'false'}
            onClick={onToggleQueueTab}
          >
            <span className="material-symbols-rounded filled">line_weight</span>
          </button>

          <button className="small player-icons player-icons-mute" aria-label={t('player.mute')}>
            <span className="material-symbols-rounded filled">volume_up</span>
          </button>

          <input
            ref={(el) => { refs.current.volume = el; }}
            className="volume-range"
            type="range"
            min={0}
            max={100}
            value={playerState.volume}
            onChange={(e) => onVolume(Number(e.target.value))}
            style={{ ['--vol' as any]: `${playerState.volume}%` }}
            aria-label={t('player.volume', 'Volume')}
          />

          <button className="small player-icons player-icons-mini" aria-label={t('player.mini')}>
            <span className="material-symbols-rounded">pip</span>
          </button>

          <button className="small player-icons player-icons-fullscreen" aria-label={t('player.fullscreen')}>
            <span className="material-symbols-rounded filled">pan_zoom</span>
          </button>
        </div>
      </div>
    </div>
  );
}
