import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useI18n } from '../core/i18n';
import { usePlaybackSelector } from '../core/playback';
import { type SpotifyAlbum, type SpotifyArtist, type SpotifyTrack } from '../core/spotify';
import { useSpotifyClient } from '../core/spotify-client';
import TrackList from './TrackList';
import GeniusClient from '../core/musicdata';
import TrackSources from './TrackSources';
import InfoHeader from './InfoHeader';
import { fmtMs, useHeroImage } from './tabHelpers';

type Props = {
  trackId?: string;
};

export default function SongInfoTab({ trackId }: Props) {
  const { t } = useI18n();
  const spotifyClient = useSpotifyClient();
  // Use selector to avoid re-rendering on unrelated playback changes
  const playingTrackId = usePlaybackSelector(s => (trackId === undefined ? s.trackId : undefined), [trackId]) as string | undefined;
  const playbackTrack = usePlaybackSelector(s => (trackId === undefined ? s.currentTrack : undefined), [trackId]) as any;
  // actions for play/queue
  const openPlaylistModal = (track: any) => {
    window.dispatchEvent(new CustomEvent('freely:openAddToPlaylistModal',{ detail:{ track } }));
  };
  const currentIndex = usePlaybackSelector(s => (trackId === undefined ? s.currentIndex : undefined), [trackId]) as number | undefined;
  const queueIds = usePlaybackSelector(s => (trackId === undefined ? s.queueIds : undefined), [trackId]) as string[] | undefined;

  // Selected track id prefers prop then playing track id
  const [selectedTrackId, setSelectedTrackId] = useState<string | undefined>(() => trackId ?? playingTrackId);

  useEffect(() => {
    if (trackId !== undefined && trackId !== selectedTrackId) {
      setSelectedTrackId(trackId);
    }
  }, [trackId, selectedTrackId]);

  // Data states
  const [track, setTrack] = useState<SpotifyTrack | undefined>();
  const [album, setAlbum] = useState<SpotifyAlbum | undefined>();
  const [primaryArtist, setPrimaryArtist] = useState<SpotifyArtist | undefined>();
  const [albumTracks, setAlbumTracks] = useState<SpotifyTrack[] | undefined>();
  const [tracksLoading, setTracksLoading] = useState(false);
  const [writers, setWriters] = useState<string[] | undefined>();
  const [writersLoading, setWritersLoading] = useState(false);

  // Refs for preserving scroll position and container
  const containerRef = useRef<HTMLElement | null>(null);

  // Helpers: unified spotify and genius accessors
  const api = useMemo(() => {
    return {
      async getTrack(id: string) {
        return spotifyClient.getTrack(id);
      },
      async getAlbum(id: string) {
        return spotifyClient.getAlbum(id);
      },
      async getArtist(id: string) {
        return spotifyClient.getArtist(id);
      },
      async getAlbumTracks(id: string) {
        return spotifyClient.getAlbumTracks(id, { fetchAll: false, limit: 50 });
      },
      async geniusSearch(query: string) {
        const gc = new GeniusClient();
        return gc.search(query);
      },
      async geniusGetSong(id: number) {
        const gc = new GeniusClient();
        return gc.getSong(id);
      },
    };
  }, [spotifyClient]);

  // Keep a stable mounted flag for cancellation
  const mountedRef = useRef(true);
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
      setTrack(undefined);
      if (!selectedTrackId) return;
      // Prefer playbackTrack if it matches
      if (playbackTrack && playbackTrack.id === selectedTrackId) {
        if (mountedRef.current && active) setTrack(playbackTrack);
        return;
      }
      try {
        const tr = await api.getTrack(selectedTrackId);
        if (!active || !mountedRef.current) return;
        if (tr) setTrack(tr);
      } catch {
        // keep silent on errors to preserve original behavior
      }
    }
    loadTrack();
    return () => {
      active = false;
    };
  }, [selectedTrackId, playbackTrack, api]);

  // Load album and primary artist for the current track
  useEffect(() => {
    let active = true;
    async function loadAlbumAndArtist() {
      if (!track?.id || !track.album?.id || !track.artists?.[0]?.id) {
        // clear dependent state when track lacks details
        if (mountedRef.current && active) {
          setAlbum(undefined);
          setPrimaryArtist(undefined);
        }
        return;
      }
      const albumId = track.album.id;
      const artistId = track.artists[0].id;

      try {
        const [alb, art] = await Promise.all([api.getAlbum(albumId), api.getArtist(artistId)]);
        if (!active || !mountedRef.current) return;
        if (alb) setAlbum(alb);
        if (art) setPrimaryArtist(art);
      } catch {
        // ignore errors
      }
    }
    loadAlbumAndArtist();
    return () => {
      active = false;
    };
  }, [track?.album?.id, track?.artists?.[0]?.id, api]);

  // Load album tracks
  useEffect(() => {
    let active = true;
    async function loadAlbumTracks() {
      if (!track?.album?.id) {
        if (mountedRef.current && active) {
          setAlbumTracks(undefined);
          setTracksLoading(false);
        }
        return;
      }
      setTracksLoading(true);
      setAlbumTracks(undefined);
      try {
        const res = await api.getAlbumTracks(track.album.id);
        const items = res?.items ?? [];
        if (!active || !mountedRef.current) return;
        setAlbumTracks(items);
      } catch {
        // ignore
      } finally {
        if (mountedRef.current && active) setTracksLoading(false);
      }
    }
    loadAlbumTracks();
    return () => {
      active = false;
    };
  }, [track?.album?.id, api]);

  // Load writers (Genius)
  useEffect(() => {
    let active = true;
    async function loadWriters() {
      setWriters(undefined);
      if (!track?.name || !primaryArtist?.name) {
        setWritersLoading(false);
        return;
      }
      const query = `${track.name} ${primaryArtist.name}`;
      setWritersLoading(true);
      try {
        const searchRes = await api.geniusSearch(query);
        const hits = searchRes?.hits ?? [];
        const lowerArtist = primaryArtist.name.toLowerCase();
        const target = hits.find((h: any) => h.primaryArtist?.name?.toLowerCase() === lowerArtist) || hits[0];
        const songId = target?.id;
        if (!songId) return;
        const songDetails = await api.geniusGetSong(songId);
        const writerArtists: any[] = songDetails?.writerArtists || songDetails?.writerArtists || songDetails?.raw?.writerArtists || [];
        const names = (writerArtists || []).map((wa: any) => wa.name).filter(Boolean);
        if (!active || !mountedRef.current) return;
        if (names.length) {
          const seen = new Set<string>();
          const unique = names.filter((n: string) => {
            const key = n.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setWriters(unique);
        }
      } catch {
        // ignore
      } finally {
        if (mountedRef.current && active) setWritersLoading(false);
      }
    }
    loadWriters();
    return () => {
      active = false;
    };
  }, [track?.name, primaryArtist?.name, api]);

  /*
  // Wheel / smooth scroll behavior: run once
  useEffect(() => {
    const tabsBody = document.querySelector('.tabs-body') as HTMLElement | null;
    if (!tabsBody) return;

    const refs = {
      wheelAccum: 0,
      scrollTriggered: false,
      animating: false,
    };

    const threshold = 1;

    function smoothScrollTo(element: HTMLElement, target: number, duration = 1200) {
      const start = element.scrollTop;
      const change = target - start;
      const startTime = performance.now();
      refs.animating = true;

      function animateScroll(currentTime: number) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // easeInOutCubic
        const ease = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        element.scrollTop = start + change * ease;
        if (progress < 1) {
          requestAnimationFrame(animateScroll);
        } else {
          refs.scrollTriggered = true;
          refs.animating = false;
        }
      }
      requestAnimationFrame(animateScroll);
    }

    const onWheel = (e: Event) => {
      const wheelEvent = e as WheelEvent;
      if (wheelEvent.deltaY > 0) {
        if (refs.animating) {
          e.stopPropagation();
          return;
        }
        refs.wheelAccum += wheelEvent.deltaY;
        const npAudio = document.querySelector('.np-audio-sources') as HTMLElement | null;
        const targetOffset = npAudio?.offsetTop;
        if (typeof targetOffset === 'number') {
          if (!refs.scrollTriggered && tabsBody.scrollTop < targetOffset && refs.wheelAccum >= threshold) {
            refs.wheelAccum = 0;
            smoothScrollTo(tabsBody, targetOffset, 1200);
          }
          if (tabsBody.scrollTop < (targetOffset - 10)) {
            refs.scrollTriggered = false;
          }
        }
      } else {
        refs.wheelAccum = 0;
      }
    };
    

    tabsBody.addEventListener('wheel', onWheel as EventListener, { passive: true });
    return () => {
      tabsBody.removeEventListener('wheel', onWheel as EventListener);
    };
  }, []);
  */
  // Derived values (memoized)
  const heroImage = useMemo(() => useHeroImage(album?.images ?? track?.album?.images, 0), [album?.images, track?.album?.images]);

  const releaseYear = useMemo(() => (album?.releaseDate ? album.releaseDate.split('-')[0] : undefined), [album?.releaseDate]);

  const genres = useMemo(() => primaryArtist?.genres ?? [], [primaryArtist?.genres]);

  const artistColWidth = useMemo(() => {
    if (!albumTracks?.length) return undefined;
    const names = albumTracks.map((t) => t.artists?.[0]?.name ?? '');
    const longest = names.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (!longest) return undefined;
    const avgCharPx = 7.2;
    const padding = 28;
    return Math.min(240, Math.max(80, Math.round(longest.length * avgCharPx + padding)));
  }, [albumTracks]);

  // Play / queue handlers (stable callbacks)
  const handlePlayTrack = useCallback(() => {
    if (!track?.id) return;
  const currentSegment = (queueIds || []).slice(currentIndex || 0);
    const trackIds = [track.id];
    const dedupSet = new Set(trackIds);
  const filteredCurrent = currentSegment.filter((id: string) => !dedupSet.has(id));
    const newQueue = [...trackIds, ...filteredCurrent];
  window.dispatchEvent(new CustomEvent('freely:playback:setQueue',{ detail:{ queueIds:newQueue, startIndex:0 } }));
  }, [track?.id, queueIds, currentIndex]);

  const handleAddToQueue = useCallback(() => {
    if (!track?.id) return;
    const trackIds = [track.id];
  const existing = new Set(queueIds || []);
  const toAppend = trackIds.filter((id: string) => !existing.has(id));
  if (toAppend.length) window.dispatchEvent(new CustomEvent('freely:playback:enqueue',{ detail:{ ids: toAppend } }));
  }, [track?.id, queueIds]);

  const onAddToPlaylist = useCallback(() => {
    if (!track) return;
    openPlaylistModal(track);
  }, [track, openPlaylistModal]);

  const headerActions = [
  <button key="add-playlist" className="np-icon" aria-label={t('player.addPlaylist')} disabled={!track?.id} onClick={onAddToPlaylist}>
      <span className="material-symbols-rounded">add_circle</span>
    </button>,
    <button key="play" className="np-icon" aria-label={t('player.playTrack')} disabled={!track?.id} onClick={handlePlayTrack}>
      <span className="material-symbols-rounded filled">play_arrow</span>
    </button>,
    <button key="queue" className="np-icon" aria-label={t('player.addToQueue')} disabled={!track?.id} onClick={handleAddToQueue}>
      <span className="material-symbols-rounded">queue</span>
    </button>
  ];

  return (
    <section ref={containerRef} className="now-playing" aria-labelledby="np-heading">
      <InfoHeader
        id="np-heading"
        title={track ? track.name : selectedTrackId ? t('np.loading') : t('np.noTrack')}
        meta={track ? (
          <>
            <span className="np-artists">
              {track.artists.map((a, i) => (
                <React.Fragment key={a.id ?? a.name}>
                  {i > 0 && <span className="np-sep">, </span>}
                  <button
                    type="button"
                    className="np-link artist"
                    onClick={() => {
                      if (a.id) window.dispatchEvent(new CustomEvent('freely:selectArtist',{ detail:{ artistId:a.id, source:'song-info' } }));
                      else if (a.url) window.open(a.url, '_blank');
                    }}
                  >
                    {a.name}
                  </button>
                </React.Fragment>
              ))}
            </span>
            {track.album?.name && (
              <>
                <span className="np-dot" />
                {track.album.id ? (
                  <button type="button" className="np-link np-album" onClick={() => { if(track.album?.id) window.dispatchEvent(new CustomEvent('freely:selectAlbum',{ detail:{ albumId: track.album.id, source:'song-info' } })); }}>{track.album.name}</button>
                ) : (
                  <span className="np-album">{track.album.name}</span>
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
      <TrackSources track={track} album={album} primaryArtist={primaryArtist} />

      <div className="np-section np-album-tracks" aria-label={t('np.albumTrackList', 'Album track list')}>
        <h4 className="np-sec-title">{t('np.fromSameAlbum')}</h4>
        {album && (
          <div className="np-album-heading">
            <span className="np-album-name" title={album.name}>{album.name}</span>
            <span className="np-album-trackcount">{t('np.tracks', undefined, { count: album.totalTracks })}</span>
          </div>
        )}

        {!track && selectedTrackId && !albumTracks && <p className="np-hint">{t('np.loading')}</p>}
        {!selectedTrackId && <p className="np-hint">{t('np.selectTrackHint')}</p>}
        {tracksLoading && <p className="np-hint">{t('np.loadingTracks')}</p>}

        {albumTracks && (
          <TrackList
            tracks={albumTracks}
            selectedTrackId={track?.id}
            playingTrackId={playingTrackId}
            showPlayButton
          />
        )}

        {!tracksLoading && !albumTracks && track?.album && <p className="np-hint">{t('np.albumUnavailable')}</p>}
      </div>

      <div className="np-section np-track-credits" aria-label={t('np.trackCredits', 'Track credits')}>
        <h4 className="np-sec-title">{t('np.trackCredits', 'Credits')}</h4>
        {!track && <p className="np-hint">{t('np.noTrack')}</p>}
        {track && (
          <ul className="credits-list">
            <li>
              <span className="cl-label">{t('np.primaryArtist', 'Primary Artist')}</span>:
              <span className="cl-value">{primaryArtist?.name || track.artists?.[0]?.name || '—'}</span>
            </li>

            {track.artists && track.artists.length > 1 && (
              <li>
                <span className="cl-label">{t('np.featuring', 'Featuring')}</span>:
                <span className="cl-value">{track.artists.slice(1).map((a) => a.name).join(', ')}</span>
              </li>
            )}

            {album && (
              <li>
                <span className="cl-label">{t('np.album', 'Album')}</span>:
                <span className="cl-value">
                  {album.name}
                  {releaseYear ? ` (${releaseYear})` : ''}
                </span>
              </li>
            )}

            {album && (
              <li>
                <span className="cl-label">{t('np.trackNumber', 'Track')}</span>:
                <span className="cl-value">
                  {track.trackNumber}
                  {album.totalTracks ? ` / ${album.totalTracks}` : ''}
                  {track.discNumber > 1 ? ` · Disc ${track.discNumber}` : ''}
                </span>
              </li>
            )}

            <li>
              <span className="cl-label">{t('np.duration', 'Duration')}</span>:
              <span className="cl-value">{fmtMs(track.durationMs)}</span>
            </li>

            {typeof track.explicit === 'boolean' && (
              <li>
                <span className="cl-label">{t('np.explicit', 'Explicit')}</span>:
                <span className="cl-value">{track.explicit ? t('np.yes', 'Yes') : t('np.no', 'No')}</span>
              </li>
            )}

            {writersLoading && (
              <li className="loading">
                <span className="cl-label">{t('np.writers', 'Writers')}</span>:
                <span className="cl-value">{t('np.loading', 'Loading')}</span>
              </li>
            )}

            {!writersLoading && writers && writers.length > 0 && (
              <li>
                <span className="cl-label">{t('np.writers', 'Writers')}</span>:
                <span className="cl-value">{writers.join(', ')}</span>
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  );
}
