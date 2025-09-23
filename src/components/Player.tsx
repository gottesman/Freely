import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaybackSelector, usePlayback, useCacheStatus } from '../core/Playback';
import { useI18n } from '../core/i18n';
import { useAlerts } from '../core/Alerts';
import { usePlaylists } from '../core/Playlists';
import { useDB } from '../core/Database';
import { formatIcon } from './Utilities/Helpers';
import {
  formatTime,
  createPlaybackEvent,
  createCustomEvent,
  createPlayerRefs,
  RAF_THROTTLE_MS,
  useTrackMetadata,
  useLoadingState,
  useNoSourceState,
  useProgressCalculation
} from './Utilities/PlayerUtils';

type PlayerVariant = 'main' | 'small';

type Props = {
  variant: PlayerVariant;
  // Main player specific props
  lyricsOpen?: boolean;
  onToggleLyrics?: () => void;
  onToggleQueueTab?: () => void;
  onToggleDownloads?: () => void;
  queueActive?: boolean;
  downloadsActive?: boolean;
  // Small player specific props
  onPIPtoggle?: (pip: boolean) => void;
};

export default function Player({
  variant,
  lyricsOpen,
  onToggleLyrics,
  onToggleQueueTab,
  onToggleDownloads,
  queueActive,
  downloadsActive,
  onPIPtoggle
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
  const backendPosition = usePlaybackSelector(s => s.position);
  const backendDuration = usePlaybackSelector(s => s.duration);
  const codec = usePlaybackSelector(s => s.codec);
  const sampleRate = usePlaybackSelector(s => s.sampleRate);
  const bitsPerSample = usePlaybackSelector(s => s.bitsPerSample);
  const playbackCtx = usePlayback();
  const backendSeek = playbackCtx.seek;

  // Volume controls from playback context
  const volume = playbackCtx.volume;
  const muted = playbackCtx.muted;
  const setVolume = playbackCtx.setVolume;
  const toggleMute = playbackCtx.toggleMute;

  // Hooks
  const { t } = useI18n();
  const { push: pushAlert, alerts } = useAlerts();
  const { playlists, getPlaylistTrackIds } = usePlaylists();
  const { getRecentPlays } = useDB();

  // State management
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreviewMs, setSeekPreviewMs] = useState<number | null>(null);
  const [showSourcePopup, setShowSourcePopup] = useState(false);
  const [isTrackInAnyPlaylist, setIsTrackInAnyPlaylist] = useState(false);
  const [positionMs, setPositionMs] = useState(0);

  const barRef = useRef<HTMLDivElement | null>(null);
  const dragInfoRef = useRef<{ rect: DOMRect; duration: number } | null>(null);

  // Optimized refs
  const refs = useRef(createPlayerRefs());

  // Computed states using utilities
  const noSource = useNoSourceState(currentTrack, playbackUrl);
  const isTrackLoading = useLoadingState(trackLoading, currentTrack, noSource, backendPosition, backendDuration, playbackUrl);
  const trackMetadata = useTrackMetadata(currentTrack, isTrackLoading, t);
  const progress = useProgressCalculation(isSeeking, seekPreviewMs, backendPosition, backendDuration, trackMetadata.durationMs);

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

  // Volume CSS variable update
  useEffect(() => {
    if (refs.current.volume) {
      refs.current.volume.style.setProperty('--vol', `${volume * 100}%`);
    }
  }, [volume]);

  // Optimized volume handler
  const onVolume = useCallback((v: number) => {
    const volumePercent = v / 100;
    setVolume(volumePercent);
  }, [setVolume]);

  // Alert on playback errors
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
    setPositionMs(0);
  }, [currentTrack?.id, trackMetadata.durationMs]);

  // Source popup management
  useEffect(() => {
    if (noSource && currentTrack?.id) {
      setShowSourcePopup(true);
    } else if (!noSource) {
      setShowSourcePopup(false);
    }
  }, [noSource, currentTrack?.id]);

  // Playlist membership checking
  useEffect(() => {
    let cancelled = false;

    const checkPlaylistMembership = async () => {
      if (!currentTrack?.id || !playlists?.length) {
        if (!cancelled) {
          setIsTrackInAnyPlaylist(false);
        }
        return;
      }

      try {
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

        setIsTrackInAnyPlaylist(isInAnyPlaylist);
      } catch {
        if (!cancelled) {
          setIsTrackInAnyPlaylist(false);
        }
      }
    };

    checkPlaylistMembership();
    return () => { cancelled = true; };
  }, [currentTrack?.id, playlists, getPlaylistTrackIds]);

  // RAF-driven progress updater
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

    const duration = trackMetadata.durationMs;
    refs.current.duration = duration;
    refs.current.position = Math.min(refs.current.position, duration);
    setPositionMs(refs.current.position);

    // If no source available or track is loading, freeze progress at 0
    if (noSource || isTrackLoading) {
      refs.current.position = 0;
      setPositionMs(0);
      return;
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

      refs.current.position = Math.min(refs.current.duration, refs.current.position + dt);

      if (!refs.current.autoNextTriggered && refs.current.position >= refs.current.duration) {
        refs.current.autoNextTriggered = true;
        setPositionMs(refs.current.duration);

        setTimeout(() => {
          try {
            playbackControls.next();
          } catch {
            // Ignore errors
          }
        }, 0);
        return;
      }

      if (now - refs.current.lastStateUpdate >= RAF_THROTTLE_MS) {
        refs.current.lastStateUpdate = now;
        setPositionMs(Math.floor(refs.current.position));
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

  // Event handlers
  const togglePlay = useCallback(() => {
    if (noSource) {
      setShowSourcePopup(true);
      return;
    }
    if (isTrackLoading) {
      return;
    }
    playbackCtx.toggle();
  }, [noSource, isTrackLoading, playbackCtx]);

  const handlePrevious = useCallback(async () => {
    const currentPositionSeconds = backendPosition || 0;

    if (currentPositionSeconds > 10) {
      try {
        backendSeek(0);
        setPositionMs(0);
      } catch (error) {
        console.error('Failed to seek to start:', error);
      }
      return;
    }

    try {
      const recentPlays = await getRecentPlays(10);
      const previousPlay = recentPlays.find(play => play.track_id !== currentTrack?.id);

      if (previousPlay) {
        playbackCtx.playNow([previousPlay.track_id]);
      } else {
        playbackControls.prev();
      }
    } catch (error) {
      console.error('Failed to get previous track from history:', error);
      playbackControls.prev();
    }
  }, [backendPosition, backendSeek, currentTrack?.id, getRecentPlays, playbackCtx, playbackControls.prev]);

  const beginSeek = useCallback((clientX: number) => {
    if (!trackMetadata.durationMs || noSource || isTrackLoading) return;
    if (!barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    dragInfoRef.current = { rect, duration: trackMetadata.durationMs };
    setIsSeeking(true);
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
      refs.current.position = preview;
      setPositionMs(preview);
      try { backendSeek(preview / 1000); } catch {/* ignore */ }
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

  const getFormatDetails = useCallback(() => {
    if (!codec && !sampleRate && !bitsPerSample) return null;
    const sample = (sampleRate ? `${Math.round(sampleRate / 100) / 10} kHz` : '') + 
      (sampleRate && bitsPerSample ? ' • ' : '') + 
      (bitsPerSample ? `${bitsPerSample}-bit` : '');
    return (
      <div className="format-info">
        {codec && formatIcon({ icon: codec })}
        <span title={sample} className={`custom-icon format-details ${
          (sampleRate > 96000 && bitsPerSample > 16) ? 'high' : 
          (sampleRate > 41000 && bitsPerSample > 16) ? 'medium' : 'normal'
        } ${(codec === 'flac' || codec === 'alac' || codec === 'wav' || codec === 'dsd') ? ' lossless' : ''}`}>
          {sample}
        </span>
      </div>
    );
  }, [codec, sampleRate, bitsPerSample]);

  // Render common elements
  const renderControls = () => (
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
          <div className="no-source-popup" role="alert">
            <div className="message">{t('player.selectSource', 'Select a source to play this track')}</div>
            <button
              type="button"
              className="action-button"
              onClick={() => {
                try {
                  createCustomEvent('freely:selectTrack', { 
                    trackId: currentTrack.id, 
                    source: 'bottom-player-no-source' 
                  });
                } catch { /* ignore */ }
              }}
            >
              {t('player.goSelectSource', 'Open track info')}
            </button>
          </div>
        )}
      </div>

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
  );

  const renderVolumeControls = () => (
    <>
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
        value={volume * 100}
        onChange={(e) => onVolume(Number(e.target.value))}
        onWheel={(e) => {
          e.preventDefault();
          const delta = e.deltaY > 0 ? -5 : 5;
          const newVolume = Math.max(0, Math.min(100, volume * 100 + delta));
          onVolume(newVolume);
        }}
        style={{ ['--vol' as any]: `${volume * 100}%` }}
        aria-label={t('player.volume', 'Volume')}
      />
    </>
  );

  const renderMetadata = () => (
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
        {variant === 'main' && (
          <div
            className="album-cover"
            role="img"
            aria-label={trackMetadata.album || t('np.noAlbum', 'No album')}
            title={trackMetadata.album || ''}
            style={trackMetadata.cover ? { backgroundImage: `url(${trackMetadata.cover})` } : undefined}
          />
        )}
        <div className="meta-text">
          <div className="song-title overflow-ellipsis">{trackMetadata.title}</div>
          <div className="song-artist overflow-ellipsis">
            {currentTrack?.artists?.map((artist: any, index: number) => (
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
          style={{ color: isTrackInAnyPlaylist ? 'var(--accent)' : undefined }}
        >
          {isTrackInAnyPlaylist ? 'check_circle' : 'add_circle'}
        </span>
      </button>
      {(codec || sampleRate || bitsPerSample) && getFormatDetails()}
    </div>
  );

  // Variant-specific rendering
  if (variant === 'small') {
    return (
      <div className="bottom-player main-panels">
        <div
          className="album-cover"
          role="img"
          aria-label={trackMetadata.album || t('np.noAlbum', 'No album')}
          title={trackMetadata.album || ''}
          style={trackMetadata.cover ? { ['--cover-image' as any]: `url(${trackMetadata.cover})` } : undefined}
        />
        <div className="track-player">
          {renderControls()}
          <div className="extras">
            {renderVolumeControls()}
            <button
              className="small player-icons player-icons-mini"
              onClick={() => onPIPtoggle?.(false)}
              aria-label={t('player.mini')}
            >
              <span className="material-symbols-rounded">pip_exit</span>
            </button>
          </div>
        </div>
        {renderMetadata()}
      </div>
    );
  }

  // Main player variant
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
        {renderMetadata()}
        {renderControls()}
        <div className="extras">
          <button
            className={`small player-icons player-icons-download ${downloadsActive ? 'active' : ''}`}
            title={t('player.download')}
            aria-label={t('player.download')}
            onClick={onToggleDownloads}
          >
            <span className="material-symbols-rounded">downloading</span>
          </button>
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
          {renderVolumeControls()}
          <button
            className="small player-icons player-icons-mini"
            aria-label={t('player.mini')}
            onClick={() => onPIPtoggle?.(true)}
          >
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