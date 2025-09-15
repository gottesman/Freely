import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaybackSelector, usePlayback, useCacheStatus } from '../core/playback';
import { useI18n } from '../core/i18n';
import { useAlerts } from '../core/alerts';
import { usePlaylists } from '../core/playlists';
import { useDB } from '../core/dbIndexed';

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
  const playbackUrl = usePlaybackSelector(s => s.playbackUrl);
  const playingFlag = usePlaybackSelector(s => s.playing);
  const backendPosition = usePlaybackSelector(s => s.position); // Position in seconds from BASS
  const backendDuration = usePlaybackSelector(s => s.duration); // Duration in seconds from BASS
  const playbackCtx = usePlayback(); // for real seek
  const backendSeek = playbackCtx.seek;
  const cacheStatus = useCacheStatus(); // Cache status for hybrid streaming
  
  // Volume controls from playback context
  const volume = playbackCtx.volume;
  const muted = playbackCtx.muted;
  const setVolume = playbackCtx.setVolume;
  const setMute = playbackCtx.setMute;
  const toggleMute = playbackCtx.toggleMute;
  
  // Hooks
  const { t } = useI18n();
  const { push: pushAlert, alerts } = useAlerts();
  const { playlists, getPlaylistTrackIds } = usePlaylists();
  const { getRecentPlays } = useDB();

  // Combined state for better performance
  const [playerState, setPlayerState] = useState<PlayerState>(initialPlayerState);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreviewMs, setSeekPreviewMs] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const dragInfoRef = useRef<{ rect: DOMRect; duration: number } | null>(null);
  
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

  // Detect if current track lacks a selected source (no explicit source meta & no resolved playback url)
  const noSource = useMemo(() => {
    if (!currentTrack) return false; // nothing selected yet
    const sourceMeta = (currentTrack as any).source;
    return !sourceMeta && !playbackUrl; // treat absence as needing selection
  }, [currentTrack, playbackUrl]);

  // Detect if track is loading - includes explicit loading state and cases where we have a source but no playback yet
  const isTrackLoading = useMemo(() => {
    if (trackLoading) {
      return true; // Explicit loading state
    }
    
    // If we have a current track with a source but no backend position/duration data and not playing, we're likely loading
    if (currentTrack && (currentTrack as any).source && !noSource) {
      const hasBackendData = backendPosition !== undefined || backendDuration !== undefined;
      const hasPlaybackUrl = playbackUrl && playbackUrl !== '';
      
      // Only consider it loading if we have started playback (have URL) but don't have backend data yet
      // If we don't have a playback URL, the track is ready but not started (not loading)
      if (hasPlaybackUrl && !hasBackendData && !playingFlag) {
        return true;
      }
    }
    
    return false;
  }, [trackLoading, currentTrack, noSource, backendPosition, backendDuration, playbackUrl, playingFlag]);

  // Memoized track metadata
  const trackMetadata = useMemo(() => {
    const title = currentTrack?.name || (isTrackLoading ? t('np.loading') : t('np.noTrack'));
    const artist = currentTrack?.artists?.map((a) => a.name).join(', ') || '';
    const album = currentTrack?.album?.name || '';
    const cover = (window as any).imageRes?.(currentTrack?.album?.images, 0) || '';
    const durationMs = currentTrack?.durationMs || 0;
    
    return { title, artist, album, cover, durationMs };
  }, [currentTrack, isTrackLoading, t]);

  const [showSourcePopup, setShowSourcePopup] = useState(false);

  // When track changes and has no source, show popup (persistent until user action or source appears)
  useEffect(() => {
    if (noSource && currentTrack?.id) {
      setShowSourcePopup(true);
    } else if (!noSource) {
      setShowSourcePopup(false);
    }
  }, [noSource, currentTrack?.id]);

  // Memoized progress calculation using real backend position
  const progress = useMemo(() => {
    // Prioritize backend duration over metadata duration
    const durationMs = backendDuration ? backendDuration * 1000 : trackMetadata.durationMs;
    if (!durationMs) return 0;
    
    // Use seek preview if seeking, otherwise use real backend position
    const positionMs = isSeeking && seekPreviewMs != null 
      ? seekPreviewMs 
      : (backendPosition ? backendPosition * 1000 : 0);
    
    return Math.min(1, positionMs / durationMs);
  }, [isSeeking, seekPreviewMs, backendPosition, backendDuration, trackMetadata.durationMs]);
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
      refs.current.volume.style.setProperty('--vol', `${volume * 100}%`);
    }
  }, [volume]);

  // Optimized volume handler
  const onVolume = useCallback((v: number) => {
    const volumePercent = v / 100; // Convert percentage to 0-1 range
    setVolume(volumePercent);
    setPlayerState(prev => ({ ...prev, volume: v })); // Keep UI state in sync
  }, [setVolume]);

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

  // RAF-driven progress updater (disabled when backend provides real position)
  useEffect(() => {
    // Cleanup any existing RAF
    if (refs.current.raf) {
      cancelAnimationFrame(refs.current.raf);
      refs.current.raf = null;
    }

    // If we have backend position data, don't use RAF animation
    if (backendPosition !== undefined && backendPosition !== null) {
      return;
    }

    // No duration or not playing => do not start RAF
    const duration = trackMetadata.durationMs;
    refs.current.duration = duration;
    refs.current.position = Math.min(refs.current.position, duration);
    
    setPlayerState(prev => ({ ...prev, positionMs: refs.current.position }));

    // If no source available or track is loading, freeze progress at 0
    if (noSource || isTrackLoading) {
      refs.current.position = 0;
      setPlayerState(prev => ({ ...prev, positionMs: 0 }));
      return; // do not start RAF
    }

    if (!playingFlag || duration <= 0) {
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
  }, [playingFlag, currentTrack?.id, trackMetadata.durationMs, playbackControls.next, noSource, isTrackLoading, backendPosition]);

  // Event handlers (memoized for performance)
  const togglePlay = useCallback(() => {
    if (noSource) {
      // re-trigger popup if user clicks while no source
      setShowSourcePopup(true);
      return;
    }
    if (isTrackLoading) {
      // Don't allow toggle while loading
      return;
    }
    // Use the actual playback context toggle method
    playbackCtx.toggle();
  }, [noSource, isTrackLoading, playbackCtx]);

  const handlePrevious = useCallback(async () => {
    // Get current position in seconds
    const currentPositionSeconds = backendPosition || 0;
    
    // If current position is over 10 seconds, rewind to start
    if (currentPositionSeconds > 10) {
      try {
        backendSeek(0);
        setPlayerState(prev => ({ ...prev, positionMs: 0 }));
      } catch (error) {
        console.error('Failed to seek to start:', error);
      }
      return;
    }
    
    // If current position is 10 seconds or less, get previously played track from history
    try {
      const recentPlays = await getRecentPlays(10); // Get last 10 plays
      
      // Find the most recent play that's not the current track
      const previousPlay = recentPlays.find(play => play.track_id !== currentTrack?.id);
      
      if (previousPlay) {
        // Use playNow to prepend this track to the queue and play it
        playbackCtx.playNow([previousPlay.track_id]);
      } else {
        // No previous track found, fall back to regular previous behavior
        playbackControls.prev();
      }
    } catch (error) {
      console.error('Failed to get previous track from history:', error);
      // Fall back to regular previous behavior
      playbackControls.prev();
    }
  }, [backendPosition, backendSeek, currentTrack?.id, getRecentPlays, playbackCtx, playbackControls.prev]);

  const beginSeek = useCallback((clientX: number) => {
    if (!trackMetadata.durationMs || noSource || isTrackLoading) return;
    if (!barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    dragInfoRef.current = { rect, duration: trackMetadata.durationMs };
    setIsSeeking(true);
    // initial preview update
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setSeekPreviewMs(Math.floor(ratio * trackMetadata.durationMs));
  }, [trackMetadata.durationMs, noSource, isTrackLoading]);

  const updateSeek = useCallback((clientX: number) => {
    const info = dragInfoRef.current;
    if (!info) return;
    const ratio = Math.min(1, Math.max(0, (clientX - info.rect.left) / info.rect.width));
    setSeekPreviewMs(Math.floor(ratio * info.duration));
  }, []);

  const endSeek = useCallback(() => {
    if (!isSeeking) return;
    const preview = seekPreviewMs;
    dragInfoRef.current = null;
    setIsSeeking(false);
    if (preview != null) {
      // Update local state
      refs.current.position = preview;
      setPlayerState(prev => ({ ...prev, positionMs: preview }));
      // Invoke backend seek (seconds)
      try { backendSeek(preview / 1000); } catch {/* ignore */}
    }
  }, [isSeeking, seekPreviewMs, backendSeek]);

  // Global mouse listeners for drag seek
  useEffect(() => {
    if (!isSeeking) return;
    const onMove = (e: MouseEvent) => { updateSeek(e.clientX); };
    const onUp = () => { endSeek(); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isSeeking, updateSeek, endSeek]);

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
        <div className="time current">{formatTime((backendPosition || 0) * 1000)}</div>

        <div
          ref={barRef}
          className={`bar${(noSource || isTrackLoading) ? ' disabled' : ''}`}
          onMouseDown={(e) => { if (noSource || isTrackLoading) return; beginSeek(e.clientX); }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={(backendDuration || trackMetadata.durationMs / 1000) * 1000}
          aria-valuenow={isSeeking && seekPreviewMs != null ? seekPreviewMs : (backendPosition || 0) * 1000}
          aria-label={t('np.trackPosition', 'Track position')}
          aria-disabled={(noSource || isTrackLoading) ? 'true' : 'false'}
          style={(noSource || isTrackLoading) ? { cursor: 'not-allowed', opacity: 0.5 } : undefined}
        >
          <div className="fill" style={{ width: `${progress * 100}%` }} />
          <div className="handle" style={{ left: `${progress * 100}%` }} />
        </div>

        <div className="time total">{formatTime((backendDuration ? backendDuration * 1000 : trackMetadata.durationMs))}</div>
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
            onClick={handlePrevious}
          >
            <span className="material-symbols-rounded filled">skip_previous</span>
          </button>

          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <button 
              className={`play player-icons player-icons-play ${(noSource || isTrackLoading) ? 'disabled' : ''}`} 
              aria-label={noSource ? t('player.noSource', 'No source selected') : isTrackLoading ? t('np.loading', 'Loading') : (playingFlag ? t('player.pause') : t('player.play'))} 
              onClick={togglePlay}
              disabled={noSource || isTrackLoading}
            >
              {(noSource || isTrackLoading) ? (
                <div className="loading-dots" style={{ width: 52, textAlign: 'center' }} aria-label={t('np.loading', 'Loading')}>
                  <span></span><span></span><span></span>
                </div>
              ) : (
                <span className="material-symbols-rounded filled">
                  {playingFlag ? 'pause_circle' : 'play_circle'}
                </span>
              )}
            </button>
            {noSource && showSourcePopup && currentTrack?.id && (
              <div
                className="no-source-popup"
                role="alert"
              >
                <div className="message">{t('player.selectSource', 'Select a source to play this track')}</div>
                <button
                  type="button"
                  className="action-button"
                  onClick={() => {
                    try {
                      createCustomEvent('freely:selectTrack', { trackId: currentTrack.id, source: 'bottom-player-no-source' });
                      // Don't close popup here; it will close automatically when a source is selected (noSource becomes false)
                    } catch { /* ignore */ }
                  }}
                >{t('player.goSelectSource', 'Open track info')}</button>
              </div>
            )}
          </div>

          {/* Cache status indicator */}
          {cacheStatus?.isCaching && (
            <div
              className="cache-status"
              style={{
                display: 'flex',
                alignItems: 'center',
                marginLeft: '8px',
                fontSize: '12px',
                color: 'var(--accent, #007acc)',
                opacity: 0.8
              }}
              title={cacheStatus.cacheProgress ? 
                `Caching: ${Math.round(cacheStatus.cacheProgress)}%` : 
                'Downloading to cache...'}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '16px', marginRight: '4px' }}>
                download
              </span>
              {cacheStatus.cacheProgress ? 
                `${Math.round(cacheStatus.cacheProgress)}%` : 
                'Caching...'}
            </div>
          )}

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

          <button 
            className="small player-icons player-icons-mute" 
            aria-label={muted ? t('player.unmute', 'Unmute') : t('player.mute', 'Mute')}
            onClick={toggleMute}
          >
            <span className="material-symbols-rounded filled">
              {muted ? 'volume_off' : (volume > 0.7 ? 'volume_up' : volume > 0.3 ? 'volume_down' : 'volume_mute')}
            </span>
          </button>

          <input
            ref={(el) => { refs.current.volume = el; }}
            className="volume-range"
            type="range"
            min={0}
            max={100}
            value={volume * 100} // Convert 0-1 range to percentage
            onChange={(e) => onVolume(Number(e.target.value))}
            onWheel={(e) => {
              e.preventDefault();
              const delta = e.deltaY > 0 ? -5 : 5; // Scroll up increases volume, scroll down decreases
              const newVolume = Math.max(0, Math.min(100, volume * 100 + delta));
              onVolume(newVolume);
            }}
            style={{ ['--vol' as any]: `${volume * 100}%` }}
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
