import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InfoHeader from './InfoHeader';
import { useI18n } from '../core/i18n';
import { getWeeklyTops } from '../core/homeTops';
import useFollowedArtists from '../core/artists';
import { useSpotifyClient } from '../core/spotify-client';
import { usePlaybackActions } from '../core/playback';
import { useDB } from '../core/dbIndexed';
import { fetchAlbumTracks, fetchArtistTracks, fetchPlaylistTracks } from '../core/spotify-helpers';

type TopArtist = { rank?: number | null; id?: string | null; name?: string; image?: string | null };
type TopAlbum = { rank?: number | null; id?: string | null; name?: string; image?: string | null; artists?: Array<{ name?: string }>; };
type TopSong = { rank?: number | null; id?: string | null; name?: string; image?: string | null; artists?: Array<{ name?: string }>; };

export default function HomeTab({ onSelectArtist, onSelectAlbum, onSelectTrack }: { onSelectArtist?: (id: string) => void; onSelectAlbum?: (id: string) => void; onSelectTrack?: (id: string) => void; }) {
  const { t } = useI18n();
  const { playNow } = usePlaybackActions();
  const spotifyClient = useSpotifyClient();
  const { artists: followedArtists } = useFollowedArtists();

  // UI data
  const [tops, setTops] = useState<{ songs: TopSong[]; albums: TopAlbum[]; artists: TopArtist[] }>({ songs: [], albums: [], artists: [] });
  const [latestReleases, setLatestReleases] = useState<TopAlbum[]>([]);
  const [recommended, setRecommended] = useState<TopSong[]>([]);
  const { getTopPlayed } = useDB();
  const [mostPlayed, setMostPlayed] = useState<Array<{ track_id: string; count: number; info?: any }>>([]);

  // lightweight mounted ref to avoid stale setState
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Small helper: unified API accessor (electron proxy vs in-browser spotify client)
  const api = useMemo(() => {
    const w = (window as any);
    const electron = w?.electron;
    return {
      hasElectron: !!electron?.spotify,
      imageRes: (images: any, idx = 1) => {
        if (typeof w.imageRes === 'function') return w.imageRes(images, idx);
        if (!images || !images.length) return null;
        return images[Math.min(idx, images.length - 1)]?.url || images[0]?.url || null;
      },
      getArtistAlbums: (id: string, opts?: any) => {
        if (electron?.spotify?.getArtistAlbums) return electron.spotify.getArtistAlbums(id, opts);
        if (spotifyClient && typeof (spotifyClient as any).getArtistAlbums === 'function') return (spotifyClient as any).getArtistAlbums(id, opts);
        return Promise.reject(new Error('No spotify API available'));
      },
      getArtistTopTracks: (id: string, opts?: any) => {
        if (electron?.spotify?.getArtistTopTracks) return electron.spotify.getArtistTopTracks(id, opts);
        if (spotifyClient && typeof (spotifyClient as any).getArtistTopTracks === 'function') return (spotifyClient as any).getArtistTopTracks(id, opts);
        return Promise.reject(new Error('No spotify API available'));
      },
      getRecommendations: (opts: any) => {
        if (electron?.spotify?.getRecommendations) return electron.spotify.getRecommendations(opts);
        if (spotifyClient && typeof (spotifyClient as any).getRecommendations === 'function') return (spotifyClient as any).getRecommendations(opts);
        return Promise.reject(new Error('No spotify API available'));
      },
    };
  }, [spotifyClient]);

  // ---- Most played and Weekly Tops ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tops = await getTopPlayed(10);
        if (cancelled || !mountedRef.current) return;
        if (!tops || !tops.length) return;
        // fetch metadata for these tracks
        const ids = tops.map(t => t.track_id).filter(Boolean);
        let tracksData: any[] = [];
        try {
          if (ids.length && spotifyClient && typeof (spotifyClient as any).getTracks === 'function') {
            const resp = await (spotifyClient as any).getTracks(ids);
            tracksData = Array.isArray(resp) ? resp : (resp?.tracks || []);
            console.log('Fetched tracks data for most played', {ids,tracksData} );
          }
        } catch { /* ignore metadata fetch failures */ }
        const mapped = tops.map(t => ({
          ...t,
          info: tracksData.find((tr: any) => {
            try {
              if (!tr) return false;
              if (String(tr.id) === String(t.track_id)) return true;
              const linked = tr.linked_from || tr.linked_from || null;
              if (linked) {
                if (linked.id && String(linked.id) === String(t.track_id)) return true;
                if (linked.uri && String(linked.uri).includes(String(t.track_id))) return true;
              }
            } catch (e) {
              // ignore and continue
            }
            return false;
          })
        }));
        if (!cancelled && mountedRef.current) setMostPlayed(mapped);
      } catch (e) {
        // ignore
      }
      try {
        const res = await getWeeklyTops({ limit: 20 });
        if (cancelled || !mountedRef.current) return;
        setTops({
          songs: res.songs || [],
          albums: res.albums || [],
          artists: res.artists || [],
        });
      } catch {
        if (!cancelled && mountedRef.current) {
          // keep default empty state on error
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Helper: wait for api readiness (electron or spotify client)
  const waitForApi = useCallback(async (checkFn: () => boolean, attempts = 3, delayMs = 500) => {
    for (let i = 0; i < attempts; i++) {
      if (checkFn()) return true;
      // wait
      await new Promise(res => setTimeout(res, delayMs));
      if (!mountedRef.current) return false;
    }
    return checkFn();
  }, []);

  // ---- Latest releases for followed artists ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!followedArtists || followedArtists.length === 0) {
        if (!cancelled && mountedRef.current) setLatestReleases([]);
        return;
      }

      const ready = await waitForApi(() => !!(api.hasElectron || (spotifyClient && typeof (spotifyClient as any).getArtistAlbums === 'function')), 3, 500);
      if (!ready || !mountedRef.current || cancelled) return;

      const maxArtists = 10;
      const toQuery = followedArtists.slice(0, maxArtists).filter(a => !!a?.id);

      // simple concurrency limiter
      const concurrency = 4;
      const results: TopAlbum[] = [];
      const queue = toQuery.map(a => async () => {
        if (cancelled || !mountedRef.current) return;
        const aid = a!.id!;
        try {
          const resp: any = await api.getArtistAlbums(aid, { includeGroups: 'album,single', limit: 5, fetchAll: false });
          const items = resp?.items ?? [];
          if (!items || !items.length) return;
          // pick most recent by releaseDate (string compare on ISO-like YYYY-MM-DD)
          items.sort((x: any, y: any) => {
            const dx = x.releaseDate || '';
            const dy = y.releaseDate || '';
            return dy.localeCompare(dx);
          });
          const pick = items[0];
          if (pick) {
            results.push({
              id: pick.id,
              name: pick.name,
              image: api.imageRes(pick.images, 1),
              artists: pick.artists || [],
              rank: undefined,
            });
          }
        } catch {
          // ignore per-item failures
        }
      });

      // run promise queue with limited concurrency
      const workers: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i++) {
        const worker = (async () => {
          while (queue.length && mountedRef.current && !cancelled) {
            const job = queue.shift();
            if (!job) break;
            await job();
          }
        })();
        workers.push(worker);
      }
      await Promise.all(workers);

      if (cancelled || !mountedRef.current) return;

      // deduplicate by album id and trim
      const seen = new Set<string>();
      const deduped: TopAlbum[] = [];
      for (const al of results) {
        if (!al?.id) continue;
        if (seen.has(al.id)) continue;
        seen.add(al.id);
        deduped.push(al);
        if (deduped.length >= 10) break;
      }
      if (!cancelled && mountedRef.current) setLatestReleases(deduped);
    })();
    return () => { cancelled = true; };
  }, [followedArtists, spotifyClient, api, waitForApi]);

  // ---- Recommendations (derive seed tracks and fetch recommendations) ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const artistIds = (followedArtists || []).map(a => a?.id).filter(Boolean).slice(0, 5) as string[];
      if (!artistIds.length) {
        if (!cancelled && mountedRef.current) setRecommended([]);
        return;
      }

      const ready = await waitForApi(() => !!(api.hasElectron || (spotifyClient && typeof (spotifyClient as any).getArtistTopTracks === 'function')), 3, 500);
      if (!ready || cancelled || !mountedRef.current) return;

      // fetch top tracks for each seed artist concurrently (with limited concurrency)
      const concurrency = 4;
      const seedTracks: string[] = [];
      const tasks = artistIds.map(aid => async () => {
        if (cancelled || !mountedRef.current) return;
        try {
          const topResp: any = await api.getArtistTopTracks(aid, undefined);
          let arr: any[] = [];
          if (Array.isArray(topResp)) arr = topResp;
          else if (topResp?.tracks && Array.isArray(topResp.tracks)) arr = topResp.tracks;
          else if (topResp?.items && Array.isArray(topResp.items)) arr = topResp.items;
          if (arr && arr.length) seedTracks.push(String(arr[0]?.id));
        } catch {
          // ignore
        }
      });

      // run with concurrency
      const workers: Promise<void>[] = [];
      const queue = tasks.slice();
      for (let i = 0; i < concurrency; i++) {
        const worker = (async () => {
          while (queue.length && mountedRef.current && !cancelled) {
            const job = queue.shift();
            if (!job) break;
            await job();
          }
        })();
        workers.push(worker);
      }
      await Promise.all(workers);

      if (!seedTracks.length) {
        if (!cancelled && mountedRef.current) setRecommended([]);
        return;
      }

      try {
        const recResp: any = await api.getRecommendations({ seed_tracks: seedTracks.slice(0, 5), limit: 8 });
        const items = (Array.isArray(recResp) ? recResp : (recResp?.tracks && Array.isArray(recResp.tracks) ? recResp.tracks : [])) || [];
        if (!cancelled && mountedRef.current) {
          const mapped: TopSong[] = items.map((t: any) => ({
            id: t.id,
            name: t.name,
            image: api.imageRes(t.album?.images, 1),
            artists: (t.artists || []).map((a: any) => ({ name: a.name })),
            rank: undefined,
          }));
          setRecommended(mapped);
        }
      } catch {
        if (!cancelled && mountedRef.current) setRecommended([]);
      }
    })();
    return () => { cancelled = true; };
  }, [followedArtists, spotifyClient, api, waitForApi]);

  // ---- Horizontal scroller helpers (stable per ref) ----
  const makeScroller = useCallback((ref: React.RefObject<HTMLDivElement>) => {
    const left = () => {
      const el = ref.current;
      if (!el) return;
      const children = Array.from(el.children) as HTMLElement[];
      if (!children.length) return;
      const positions = children.map(c => c.offsetLeft);
      const current = el.scrollLeft;
      let idx = 0;
      for (let i = 0; i < positions.length; i++) {
        if (positions[i] <= current + 1) idx = i;
        else break;
      }
      const prevIdx = Math.max(0, idx - 1);
      const target = positions[prevIdx];
      el.scrollTo({ left: target, behavior: 'smooth' });
    };
    const right = () => {
      const el = ref.current;
      if (!el) return;
      const children = Array.from(el.children) as HTMLElement[];
      if (!children.length) return;
      const positions = children.map(c => c.offsetLeft);
      const current = el.scrollLeft;
      let idx = 0;
      for (let i = 0; i < positions.length; i++) {
        if (positions[i] <= current + 1) idx = i;
        else break;
      }
      const nextIdx = Math.min(positions.length - 1, idx + 1);
      const target = positions[nextIdx];
      if (target !== current) el.scrollTo({ left: target, behavior: 'smooth' });
    };
    return { left, right };
  }, []);

  const refLatest = useRef<HTMLDivElement | null>(null);
  const refRecommended = useRef<HTMLDivElement | null>(null);
  const refTrending = useRef<HTMLDivElement | null>(null);
  const refMostPlayed = useRef<HTMLDivElement | null>(null);
  const refArtists = useRef<HTMLDivElement | null>(null);

  const scLatest = useMemo(() => makeScroller(refLatest), [makeScroller]);
  const scRecommended = useMemo(() => makeScroller(refRecommended), [makeScroller]);
  const scTrending = useMemo(() => makeScroller(refTrending), [makeScroller]);
  const scMostPlayed = useMemo(() => makeScroller(refMostPlayed), [makeScroller]);
  const scArtists = useMemo(() => makeScroller(refArtists), [makeScroller]);

  const scrollTolerance = 6;

  // collection cache: lazy-loaded track arrays for album/artist/playlist
  const [collectionCache, setCollectionCache] = useState<Record<string, any[] | undefined>>({});

  const loadCollection = useCallback(async (kind: 'album' | 'artist' | 'playlist', id?: string | number) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    // already loaded (including failed undefined)
    if (collectionCache[key] !== undefined) return;
    try {
      let tracks: any[] | undefined;
      if (kind === 'album') tracks = await fetchAlbumTracks(id, { limit: 10 }) as any;
      else if (kind === 'artist') tracks = await fetchArtistTracks(id, { limit: 10 }) as any;
      else tracks = await fetchPlaylistTracks(id, { limit: 10 }) as any;
      setCollectionCache(prev => ({ ...prev, [key]: tracks }));
    } catch {
      setCollectionCache(prev => ({ ...prev, [key]: undefined }));
    }
  }, [collectionCache]);

  const addPlayButton = useCallback((tracks: any[] | undefined) => {
    if (!tracks || tracks.length === 0) return null;
    const ids = tracks.map(t => String(t.id)).filter(Boolean);
    if (!ids.length) return null;
    return (
      <div
        className='media-play-overlay'
        role="button"
        aria-label={t('player.play', 'Play')}
        onClick={(e) => { e.stopPropagation(); playNow(ids); }}
      >
        <span className="material-symbols-rounded filled">play_arrow</span>
      </div>
    );
  }, [playNow, t]);

  const renderCollectionPlay = useCallback((kind: 'album' | 'artist' | 'playlist' | 'track', id?: string | number) => {
    if (!id) return null;
    if (kind === 'track') {
      return (
        <div
          className='media-play-overlay'
          role="button"
          aria-label={t('player.play', 'Play')}
          onClick={(e) => { e.stopPropagation(); playNow([String(id)]); }}
        >
          <span className="material-symbols-rounded filled">play_arrow</span>
        </div>
      );
    }
    const key = `${kind}:${id}`;
    const cached = collectionCache[key];
    if (cached && cached.length) return addPlayButton(cached);

    return (
      <div
        className='media-play-overlay'
        role="button"
        aria-label={t('player.play', 'Play')}
        onMouseEnter={() => loadCollection(kind, id)}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            let res: any[] | undefined;
            if (kind === 'album') res = await fetchAlbumTracks(id as any, { limit: 50 }) as any;
            else if (kind === 'artist') res = await fetchArtistTracks(id as any, { limit: 50 }) as any;
            else res = await fetchPlaylistTracks(id as any, { limit: 50 }) as any;
            if (res && res.length) {
              playNow(res.map(r => String(r.id)));
              setCollectionCache(prev => ({ ...prev, [key]: res }));
            }
          } catch {
            // ignore play failure
          }
        }}
      >
        <span className="material-symbols-rounded filled">play_arrow</span>
      </div>
    );
  }, [collectionCache, addPlayButton, loadCollection, playNow, t]);

  // overflow class management for media rows (attach listeners & ResizeObserver)
  useEffect(() => {
    const rows: Array<React.RefObject<HTMLDivElement>> = [refLatest, refRecommended, refTrending, refArtists, refMostPlayed];
    const observers: ResizeObserver[] = [];
    const cleanups: Array<() => void> = [];

    function update(row: HTMLDivElement) {
      const wrap = row.parentElement;
      if (!wrap) return;
      const { scrollLeft, scrollWidth, clientWidth } = row;
      const canScroll = scrollWidth > clientWidth + scrollTolerance;
      const atStart = scrollLeft <= scrollTolerance;
      const atEnd = scrollLeft + clientWidth >= scrollWidth - scrollTolerance;
      wrap.classList.remove('media-row-overflow-right', 'media-row-overflow-left', 'media-row-overflow-both');
      if (!canScroll) return;
      if (atStart && !atEnd) wrap.classList.add('media-row-overflow-right');
      else if (!atStart && atEnd) wrap.classList.add('media-row-overflow-left');
      else if (!atStart && !atEnd) wrap.classList.add('media-row-overflow-both');
    }

    function attach(ref: React.RefObject<HTMLDivElement>) {
      const el = ref.current;
      if (!el) return;
      // reset scroll to left for consistent UX
      el.scrollLeft = 0;
      const onScroll = () => update(el);
      el.addEventListener('scroll', onScroll, { passive: true });
      const ro = new ResizeObserver(() => update(el));
      ro.observe(el);
      observers.push(ro);
      requestAnimationFrame(() => update(el));
      cleanups.push(() => { el.removeEventListener('scroll', onScroll); ro.disconnect(); });
    }

    rows.forEach(attach);
    const onWinResize = () => rows.forEach(r => r.current && update(r.current));
    window.addEventListener('resize', onWinResize);
    return () => {
      cleanups.forEach(fn => fn());
      window.removeEventListener('resize', onWinResize);
      observers.forEach(o => o.disconnect());
    };
  }, []);

  return (
    <section className="home-page" aria-label={t('home.pageLabel', 'Browse and personalized content')}>
      {/* Hero / Welcome as InfoHeader */}
      <InfoHeader
        id="home-hero"
        title={<><span className="home-hero-title">{t('home.welcome')}</span><p className="home-hero-sub">{t('home.subtitle')}</p></>}
        meta={null}
        initialShrink={1}
        titleColor="var(--accent)"
        actions={[
          <button key="play" className="np-icon" type="button" aria-label={t('home.cta.playDailyMix')}><span className="material-symbols-rounded filled">play_arrow</span></button>,
          <button key="shuffle" className="np-icon" type="button" aria-label={t('home.cta.shuffleAll')}><span className="material-symbols-rounded filled">shuffle</span></button>,
          <button key="queue" className="np-icon" type="button" aria-label={t('home.cta.openQueue')}><span className="material-symbols-rounded filled">queue_music</span></button>
        ]}
      />

      {/* Latest Releases */}
      <HomeSection id="latest" title={t('home.section.latest')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft', 'Scroll left')} className="np-icon scroll-btn left" onClick={scLatest.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refLatest} className="media-row scroll-x">
            {latestReleases && latestReleases.length ? (
              latestReleases.map((al, i) => (
                <div key={String(al.id || i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if (onSelectAlbum && al.id) onSelectAlbum(String(al.id)); }}>
                  <div className="media-cover square">
                    <div className="media-cover-inner">
                      <img src={al.image || ''} alt={al.name || ''} />
                    </div>
                    {renderCollectionPlay('album', al.id ?? undefined)}
                  </div>
                  <h3 className="media-title">{al.name}</h3>
                  <div className="media-meta">{(al.artists && al.artists.map(a => a.name).join(', ')) || ''}</div>
                </div>
              ))
            ) : (
              <div className="np-hint">{t('home.notAvailable', 'Not available for now')}</div>
            )}
          </div>
          <button type="button" aria-label={t('home.scrollRight', 'Scroll right')} className="np-icon scroll-btn right" onClick={scLatest.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Recommended For You */}
      <HomeSection id="recommended" title={t('home.section.recommended')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft', 'Scroll left')} className="np-icon scroll-btn left" onClick={scRecommended.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refRecommended} className="media-row scroll-x">
            {recommended && recommended.length ? (
              recommended.map((s, i) => (
                <div key={String(s.id || i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if (onSelectTrack && s.id) onSelectTrack(String(s.id)); }}>
                  <div className="media-cover square">
                    <div className="media-cover-inner"><img src={s.image || ''} alt={s.name || ''} /></div>
                    {renderCollectionPlay('track', s.id ?? undefined)}
                  </div>
                  <h3 className="media-title">{s.name}</h3>
                  <div className="media-meta">{(s.artists && s.artists.map(a => a.name).join(', ')) || ''}</div>
                </div>
              ))
            ) : (
              <div className="np-hint">{t('home.notAvailable', 'Not available for now')}</div>
            )}
          </div>
          <button type="button" aria-label={t('home.scrollRight', 'Scroll right')} className="np-icon scroll-btn right" onClick={scRecommended.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Trending Now */}
      <HomeSection id="trending" title={t('home.section.trending')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft', 'Scroll left')} className="np-icon scroll-btn left" onClick={scTrending.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refTrending} className="media-row scroll-x dense">
            {tops.songs.map((s: TopSong, i) => (
              <div key={String(s.id || i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if (onSelectTrack && s.id) onSelectTrack(String(s.id)); }}>
                <div className="media-cover square" aria-hidden="true">
                  <div className="media-cover-inner"><img src={s.image || ''} alt="" /></div>
                  {renderCollectionPlay('track', s.id ?? undefined)}
                </div>
                <h3 className="media-title">{s.name}</h3>
                <p className="media-meta">{(s.artists && s.artists.map((a: { name?: string }) => a.name).join(', ')) || ''}</p>
              </div>
            ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight', 'Scroll right')} className="np-icon scroll-btn right" onClick={scTrending.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Top Artists */}
      <HomeSection id="artists" title={t('home.section.artists')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft', 'Scroll left')} className="np-icon scroll-btn left" onClick={scArtists.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refArtists} className="media-row scroll-x artists">
            {tops.artists.map((a: TopArtist, i) => (
              <div key={String(a.id || i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if (onSelectArtist && a.id) onSelectArtist(String(a.id)); }}>
                <div className="media-cover circle" aria-hidden="true">
                  <div className="media-cover-inner"><img src={a.image || ''} alt="" /></div>
                  {renderCollectionPlay('artist', a.id ?? undefined)}
                </div>
                <h3 className="media-title">{a.name}</h3>
                <p className="media-meta">{a.rank ? `#${a.rank}` : ''}</p>
              </div>
            ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight', 'Scroll right')} className="np-icon scroll-btn right" onClick={scArtists.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Most Played */}
      <HomeSection id="most-played" title={t('home.section.mostPlayed' , 'Your most played')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft', 'Scroll left')} className="np-icon scroll-btn left" onClick={scMostPlayed.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refMostPlayed} className="media-row scroll-x dense">
            {mostPlayed && mostPlayed.length ? (
              mostPlayed.map((m, i) => {
                const info = m.info;
                const name = info?.name || 'Unknown';
                const img = info?.album?.images ? api.imageRes(info.album.images, 1) : null;
                const artists = (info?.artists || []).map((a: any) => a.name).join(', ');
                return (
                  <div key={String(m.track_id || i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if (onSelectTrack && m.track_id) onSelectTrack(String(m.track_id)); }}>
                    <div className="media-cover square" aria-hidden="true">
                      <div className="media-cover-inner"><img src={img || ''} alt={name} /></div>
                      {renderCollectionPlay('track', m.track_id ?? undefined)}
                    </div>
                    <h3 className="media-title">{name}</h3>
                    <p className="media-meta">{artists}</p>
                  </div>
                );
              })
            ) : (
              <div className="np-hint">{t('home.notAvailable', 'Not available for now')}</div>
            )}
          </div>
          <button type="button" aria-label={t('home.scrollRight', 'Scroll right')} className="np-icon scroll-btn right" onClick={scMostPlayed.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Genres & Moods */}
      <HomeSection id="genres" title={t('home.section.genres')} more>
        <div className="chip-grid">
          {['Electronic', 'Chill', 'Focus', 'Gaming', 'Workout', 'Jazz', 'Classical', 'Hip-Hop', 'Ambient', 'Indie'].map(tag => (
            <button key={tag} className="chip" type="button">{tag}</button>
          ))}
        </div>
      </HomeSection>
    </section>
  );
}

/* --- Internal compositional components --- */
interface HomeSectionProps { id: string; title: string; children: React.ReactNode; more?: boolean }
function HomeSection({ id, title, children, more }: HomeSectionProps) {
  const { t } = useI18n();
  return (
    <section className="home-section" aria-labelledby={`${id}-title`}>
      <header className="home-sec-head">
        <h2 id={`${id}-title`} className="home-sec-title">{title}</h2>
        {more && <button className="np-link home-sec-more" type="button">{t('home.section.seeAll')}</button>}
      </header>
      {children}
    </section>
  );
}

interface MediaCardProps { children: React.ReactNode; kind?: string; progress?: boolean; compact?: boolean; circle?: boolean }
function MediaCard({ children, progress, compact, circle }: MediaCardProps) {
  const cls = ["media-card", progress && 'has-progress', compact && 'compact', circle && 'is-circle'].filter(Boolean).join(' ');
  return <article className={cls}>{children}</article>;
}
