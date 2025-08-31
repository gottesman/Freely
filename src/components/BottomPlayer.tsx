import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaybackActions, usePlaybackSelector } from '../core/playback';
import { useI18n } from '../core/i18n';
import { useAlerts } from '../core/alerts';
import { useGlobalAddToPlaylistModal } from '../core/AddToPlaylistModalContext';
import { usePlaylists } from '../core/playlists';

type Props = {
  lyricsOpen?: boolean;
  onToggleLyrics?: () => void;
  onActivateSongInfo?: () => void;
  onToggleQueueTab?: () => void;
  queueActive?: boolean;
  onSelectArtist?: (id: string) => void;
};

export default function BottomPlayer({
  lyricsOpen,
  onToggleLyrics,
  onActivateSongInfo,
  onToggleQueueTab,
  queueActive,
  onSelectArtist,
}: Props) {
  const { next, prev } = usePlaybackActions();
  const currentTrack = usePlaybackSelector(s => s.currentTrack);
  const trackLoading = usePlaybackSelector(s => s.loading);
  const error = usePlaybackSelector(s => s.error);
  const { t } = useI18n();
  const { push: pushAlert, alerts } = useAlerts();
  const { openModal: openPlaylistModal } = useGlobalAddToPlaylistModal();
  const { playlists, getPlaylistTrackIds } = usePlaylists();

  // volume state + ref for slider DOM & CSS var
  const [volume, setVolume] = useState<number>(40);
  const volRef = useRef<HTMLInputElement | null>(null);

  // playback UI state
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [positionMs, setPositionMs] = useState<number>(0);
  const [isTrackInAnyPlaylist, setIsTrackInAnyPlaylist] = useState<boolean>(false);

  // refs for RAF loop & position tracking (avoid stale closures)
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const positionRef = useRef<number>(0);
  const durationRef = useRef<number>(0);
  const autoNextTriggeredRef = useRef<boolean>(false);

  // keep track of mount for safety
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Update CSS var for volume whenever it changes or ref becomes available
  useEffect(() => {
    if (volRef.current) {
      volRef.current.style.setProperty('--vol', `${volume}%`);
    }
  }, [volume]);

  const onVolume = useCallback((v: number) => {
    setVolume(v);
    if (volRef.current) volRef.current.style.setProperty('--vol', `${v}%`);
  }, []);

  // Alert on playback errors (dedupe by message)
  useEffect(() => {
    if (error && !alerts.some((a) => a.msg === error)) {
      pushAlert(error, 'error');
    }
  }, [error, alerts, pushAlert]);

  // Reset position & RAF when track changes
  useEffect(() => {
    positionRef.current = 0;
    setPositionMs(0);
    lastFrameTimeRef.current = null;
    autoNextTriggeredRef.current = false;
    // update durationRef
    durationRef.current = currentTrack?.durationMs || 0;
  }, [currentTrack?.id, currentTrack?.durationMs]);

  // Check if current track exists in any playlist.
  // Runs in parallel (limited handling via Promise.allSettled), faster than sequential loop.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!currentTrack?.id || !playlists?.length) {
        if (!cancelled) setIsTrackInAnyPlaylist(false);
        return;
      }
      try {
        const checks = playlists.map((pl) =>
          getPlaylistTrackIds(pl.id).then((ids) => ({ ok: true, found: ids.includes(currentTrack.id) })).catch(() => ({ ok: false, found: false }))
        );
        const settled = await Promise.allSettled(checks);
        if (cancelled || !mountedRef.current) return;
        const found = settled.some((s) => {
          if (s.status !== 'fulfilled') return false;
          const val = s.value as any;
          return !!val?.found;
        });
        setIsTrackInAnyPlaylist(found);
      } catch {
        if (!cancelled) setIsTrackInAnyPlaylist(false);
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id, playlists, getPlaylistTrackIds]);

  // RAF driven progress updater (efficient)
  useEffect(() => {
    // cleanup any existing RAF
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    // no duration or not playing => do not start RAF
    const duration = currentTrack?.durationMs || 0;
    durationRef.current = duration;
    positionRef.current = Math.min(positionRef.current, duration);
    setPositionMs(positionRef.current);

    if (!isPlaying || duration <= 0) {
      return;
    }

    lastFrameTimeRef.current = null;
    autoNextTriggeredRef.current = false;

    const throttleMs = 200; // update state at most every 200ms to reduce renders
    let lastSetTime = performance.now();

    const loop = (now: number) => {
      if (!mountedRef.current) return;
      if (lastFrameTimeRef.current == null) lastFrameTimeRef.current = now;
      const dt = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;

      // advance positionRef by dt milliseconds
      positionRef.current = Math.min(durationRef.current, positionRef.current + dt);

      // if track ended, trigger next once
      if (!autoNextTriggeredRef.current && positionRef.current >= durationRef.current) {
        autoNextTriggeredRef.current = true;
        // snap to end and call next on next tick to avoid interfering with RAF calculations
        setPositionMs(durationRef.current);
        setTimeout(() => {
          try {
            next();
          } catch {
            /* ignore errors from playback next */
          }
        }, 0);
        return; // stop RAF (we don't schedule another frame)
      }

      // throttle React state updates to reduce re-renders
      if (now - lastSetTime >= throttleMs) {
        lastSetTime = now;
        setPositionMs(Math.floor(positionRef.current));
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameTimeRef.current = null;
    };
  }, [isPlaying, currentTrack?.id, next]);

  // toggle play/pause
  const togglePlay = useCallback(() => {
    setIsPlaying((p) => !p);
  }, []);

  // format milliseconds into M:SS
  const fmt = useCallback((ms?: number) => {
    if (ms === undefined || isNaN(ms)) return '--:--';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ':' + s.toString().padStart(2, '0');
  }, []);

  const durationMs = currentTrack?.durationMs || 0;
  const progress = durationMs ? Math.min(1, positionMs / durationMs) : 0;

  // seek implementation (click to seek)
  const onSeek = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      if (!durationMs) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.min(1, Math.max(0, x / rect.width));
      const newPos = Math.floor(ratio * durationMs);
      positionRef.current = newPos;
      setPositionMs(newPos);
      // if we were paused, keep paused state; if playing, RAF will continue from new position
    },
    [durationMs]
  );

  // derived metadata (memoized)
  const title = currentTrack?.name || (trackLoading ? t('np.loading') : t('np.noTrack'));
  const artist = useMemo(() => currentTrack?.artists?.map((a) => a.name).join(', ') || '', [currentTrack?.artists]);
  const album = currentTrack?.album?.name || '';
  const cover = useMemo(() => (window as any).imageRes?.(currentTrack?.album?.images, 0) || '', [currentTrack?.album?.images]);

  // open playlist modal handler
  const onAddToPlaylist = useCallback(() => {
    if (!currentTrack) return;
    openPlaylistModal(currentTrack, true);
  }, [currentTrack, openPlaylistModal]);

  // click handlers that were previously inline
  const onMetaActivate = useCallback(
    (e?: React.MouseEvent | React.KeyboardEvent) => {
      if (e) {
        e.stopPropagation();
        if ('preventDefault' in e) e.preventDefault();
      }
      if (onActivateSongInfo) onActivateSongInfo();
    },
    [onActivateSongInfo]
  );

  const onArtistClick = useCallback(
    (e: React.MouseEvent, a: any) => {
      e.stopPropagation();
      if (onSelectArtist && a.id) onSelectArtist(a.id);
      else if (a.url) window.open(a.url, '_blank');
    },
    [onSelectArtist]
  );

  return (
    <div className="bottom-player main-panels">
      <div className="track-progress">
        <div className="time current">{fmt(positionMs)}</div>

        <div
          className="bar"
          onClick={onSeek}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-valuenow={positionMs}
          aria-label={t('np.trackPosition', 'Track position')}
        >
          <div className="fill" style={{ width: `${progress * 100}%` }} />
          <div className="handle" style={{ left: `${progress * 100}%` }} />
        </div>

        <div className="time total">{fmt(durationMs)}</div>
      </div>

      <div className="track-player">
        <div className="meta-block">
          <div
            className="meta"
            role="button"
            title={title + (artist ? ` - ${artist}` : '') + (album ? ` (${album})` : '')}
            tabIndex={0}
            aria-label={t('np.showDetails', 'Show song details')}
            onClick={onMetaActivate}
            onKeyDown={(e) => {
              if ((e as React.KeyboardEvent).key === 'Enter' || (e as React.KeyboardEvent).key === ' ') {
                (e as React.KeyboardEvent).preventDefault();
                onMetaActivate();
              }
            }}
          >
            <img className="album-cover" src={cover} alt={album} />
            <div className="meta-text">
              <div className="song-title overflow-ellipsis">{title}</div>
              <div className="song-artist overflow-ellipsis">
                {currentTrack?.artists?.map((a, i) => (
                  <React.Fragment key={a.id || a.name}>
                    {i > 0 ? ', ' : ''}
                    <button
                      type="button"
                      className="np-link artist inline"
                      onClick={(e) => onArtistClick(e, a)}
                    >
                      {a.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>
              <div className="song-album overflow-ellipsis">{album}</div>
            </div>
          </div>

          <button
            className="small player-icons player-icons-add-playlist"
            title={t('player.addPlaylist')}
            aria-label={t('player.addPlaylist')}
            onClick={onAddToPlaylist}
            disabled={!currentTrack}
          >
            <span className="material-symbols-rounded" style={{ color: isTrackInAnyPlaylist ? 'var(--accent)' : undefined }}>
              {isTrackInAnyPlaylist ? 'check_circle' : 'add_circle'}
            </span>
          </button>
        </div>

        <div className="controls">
          <button className="small player-icons player-icons-shuffle" aria-label={t('player.shuffle')}>
            <span className="material-symbols-rounded filled">shuffle</span>
          </button>

          <button className="player-icons player-icons-prev" aria-label={t('player.previous')} onClick={prev}>
            <span className="material-symbols-rounded filled">skip_previous</span>
          </button>

          <button className="play player-icons player-icons-play" aria-label={isPlaying ? t('player.pause') : t('player.play')} onClick={togglePlay}>
            <span className="material-symbols-rounded filled">{isPlaying ? 'pause_circle' : 'play_circle'}</span>
          </button>

          <button className="player-icons player-icons-next" aria-label={t('player.next')} onClick={next}>
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
            ref={volRef}
            className="volume-range"
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={(e) => onVolume(Number(e.target.value))}
            style={{ ['--vol' as any]: `${volume}%` }}
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
