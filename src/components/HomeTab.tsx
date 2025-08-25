import React, { useRef, useEffect, useState } from 'react'
import { useI18n } from '../core/i18n'
import { getWeeklyTops } from '../core/homeTops';
import useFollowedArtists from '../core/artists';
import { useSpotifyClient } from '../core/spotify-client';
import { usePlayback } from '../core/playback';
import { fetchAlbumTracks, fetchArtistTracks, fetchPlaylistTracks } from '../core/spotify-helpers';

type TopArtist = { rank?: number | null; id?: string | null; name?: string; image?: string | null };
type TopAlbum = { rank?: number | null; id?: string | null; name?: string; image?: string | null; artists?: Array<{ name?:string }>; };
type TopSong = { rank?: number | null; id?: string | null; name?: string; image?: string | null; artists?: Array<{ name?:string }>; };

export default function HomeTab({ onSelectArtist, onSelectAlbum, onSelectTrack }: { onSelectArtist?: (id: string)=>void; onSelectAlbum?: (id: string)=>void; onSelectTrack?: (id: string)=>void }){
  const { t } = useI18n();
  // Immediate render-time log to help debug missing effect logs
  try { console.log('HomeTab: render - followedArtists=', (useFollowedArtists && typeof useFollowedArtists === 'function') ? undefined : undefined); } catch(e){}
  const { playNow } = usePlayback();
  const heroImage = '..'
  const [tops, setTops] = useState<{ songs: TopSong[]; albums: TopAlbum[]; artists: TopArtist[] }>({ songs: [], albums: [], artists: [] });
  const { artists: followedArtists } = useFollowedArtists();
  const spotifyClient = useSpotifyClient();
  const [latestReleases, setLatestReleases] = useState<TopAlbum[]>([]);
  const [recommended, setRecommended] = useState<TopSong[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await getWeeklyTops({ limit: 20 });
        if (!alive) return;
        setTops({ songs: res.songs || [], albums: res.albums || [], artists: res.artists || [] });
      } catch (e) {
        console.warn('HomeTab getWeeklyTops failed', e);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Fetch latest release for each followed artist when running in Electron (main process will handle CORS)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!followedArtists || !followedArtists.length) {
        setLatestReleases([]);
        return;
      }

      // Wait for a usable spotify client or electron proxy before proceeding
      const needs = { albums: true };
      let hasElectronProxy = Boolean((window as any).electron?.spotify?.getArtistAlbums);
      let hasSpotifyClient = Boolean(spotifyClient && typeof (spotifyClient as any).getArtistAlbums === 'function');
      // Retry a few times if neither is ready yet
      for (let attempt = 0; attempt < 3 && !hasElectronProxy && !hasSpotifyClient; attempt++) {
        console.log('HomeTab: waiting for spotify client/proxy (attempt)', attempt + 1);
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!alive) return;
        hasElectronProxy = Boolean((window as any).electron?.spotify?.getArtistAlbums);
        hasSpotifyClient = Boolean(spotifyClient && typeof (spotifyClient as any).getArtistAlbums === 'function');
      }
      if (!hasElectronProxy && !hasSpotifyClient) {
        console.warn('HomeTab: Spotify client/proxy not available after retries; skipping latest releases load');
        return;
      }

      (async () => {
        const maxArtists = 10; // limit API usage
        const toQuery = followedArtists.slice(0, maxArtists);
        const results: TopAlbum[] = [];
        for (const a of toQuery) {
          if (!a || !a.id) continue;
          try {
            // Prefer Electron IPC path (main process spotify proxy)
            if ((window as any).electron?.spotify?.getArtistAlbums) {
              console.log('HomeTab: using electron proxy getArtistAlbums for', a.id);
              const resp = await (window as any).electron.spotify.getArtistAlbums(a.id, { includeGroups: 'album,single', limit: 5, fetchAll: false });
              const items = (resp && resp.items) ? resp.items : [];
              if (items && items.length) {
                // pick most recent by releaseDate
                items.sort((x: any, y: any) => {
                  const dx = x.releaseDate || '';
                  const dy = y.releaseDate || '';
                  return (dy.localeCompare(dx));
                });
                const pick = items[0];
                results.push({ id: pick.id, name: pick.name, image: (window as any).imageRes?.(pick.images, 1) || null, artists: pick.artists || [], rank: undefined });
              }
      } else if (spotifyClient && typeof (spotifyClient as any).getArtistAlbums === 'function') {
              // Fallback to in-browser Spotify client (uses client credentials/token endpoint)
              try {
        console.log('HomeTab: using spotifyClient.getArtistAlbums for', a.id);
        const resp = await (spotifyClient as any).getArtistAlbums(a.id, { includeGroups: 'album,single', limit: 5, fetchAll: false });
                const items = (resp && resp.items) ? resp.items : [];
                if (items && items.length) {
                  items.sort((x: any, y: any) => { const dx = x.releaseDate || ''; const dy = y.releaseDate || ''; return (dy.localeCompare(dx)); });
                  const pick = items[0];
                  results.push({ id: pick.id, name: pick.name, image: (window as any).imageRes?.(pick.images, 1) || null, artists: pick.artists || [], rank: undefined });
                }
              } catch (e) {
                console.warn('spotifyClient.getArtistAlbums failed for', a.id, e);
              }
            }
          } catch (e) {
            console.warn('Failed to fetch artist albums for', a.id, e);
          }
        }
  if (!alive) return;
        // Deduplicate by album id and limit displayed
        const seen = new Set<string>();
        const deduped: TopAlbum[] = [];
        for (const al of results) {
          if (!al || !al.id) continue;
          if (seen.has(al.id)) continue;
          seen.add(al.id);
          deduped.push(al);
          if (deduped.length >= 10) break;
        }
        setLatestReleases(deduped);
      })();
    })();
    return () => { alive = false; };
  // include spotifyClient so effect re-runs when the client becomes available
  }, [followedArtists, spotifyClient]);

  // Fetch recommendations based on followed artists (seed_artists) or fallback seeds
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Derive seed track ids by fetching a top track per followed artist (up to 5)
        const artistIds = (followedArtists || []).map(a => a && a.id).filter(Boolean).slice(0,5) as string[];
        if (!artistIds.length) { setRecommended([]); return; }

        // Ensure a spotify client or electron proxy is available before proceeding
        let hasElectronProxy = Boolean((window as any).electron?.spotify?.getArtistTopTracks);
        let hasSpotifyClient = Boolean(spotifyClient && typeof (spotifyClient as any).getArtistTopTracks === 'function');
        for (let attempt = 0; attempt < 3 && !hasElectronProxy && !hasSpotifyClient; attempt++) {
          console.log('HomeTab: waiting for spotify client/proxy for recommendations (attempt)', attempt + 1);
          await new Promise(resolve => setTimeout(resolve, 500));
          if (!alive) return;
          hasElectronProxy = Boolean((window as any).electron?.spotify?.getArtistTopTracks);
          hasSpotifyClient = Boolean(spotifyClient && typeof (spotifyClient as any).getArtistTopTracks === 'function');
        }
        if (!hasElectronProxy && !hasSpotifyClient) {
          console.warn('HomeTab: Spotify client/proxy not available for recommendations after retries; skipping');
          return;
        }

        const seedTracks: string[] = [];
        for (const aid of artistIds) {
          try {
            let topResp: any;
            if ((window as any).electron?.spotify?.getArtistTopTracks) {
              topResp = await (window as any).electron.spotify.getArtistTopTracks(aid, undefined);
            } else if (spotifyClient && typeof (spotifyClient as any).getArtistTopTracks === 'function') {
              topResp = await (spotifyClient as any).getArtistTopTracks(aid, undefined);
            } else {
              topResp = null;
            }
            // Normalize possible shapes: array or { tracks: [...] } or { items: [...] }
            let topArray: any[] = [];
            if (Array.isArray(topResp)) topArray = topResp;
            else if (topResp && Array.isArray(topResp.tracks)) topArray = topResp.tracks;
            else if (topResp && Array.isArray(topResp.items)) topArray = topResp.items;
            if (topArray && topArray.length) seedTracks.push(topArray[0].id);
          } catch (e) { /* ignore */ }
        }
        if (!seedTracks.length) { setRecommended([]); return; }

        let recResp: any;
        if ((window as any).electron?.spotify?.getRecommendations) {
          recResp = await (window as any).electron.spotify.getRecommendations({ seed_tracks: seedTracks.slice(0,5), limit: 8 });
        } else if (spotifyClient && typeof (spotifyClient as any).getRecommendations === 'function') {
          recResp = await (spotifyClient as any).getRecommendations({ seed_tracks: seedTracks.slice(0,5), limit: 8, market: undefined });
        } else {
          recResp = null;
        }
        const items = (recResp && Array.isArray(recResp)) ? recResp : (recResp && Array.isArray(recResp.tracks) ? recResp.tracks : []);
        if (!alive) return;
        const mapped: TopSong[] = items.map((t: any) => ({ id: t.id, name: t.name, image: (window as any).imageRes?.(t.album?.images, 1) || null, artists: (t.artists || []).map((a:any)=>({ name: a.name })) }));
        setRecommended(mapped);
      } catch (e) {
        console.warn('getRecommendations failed', e);
        setRecommended([]);
      }
    })();
    return () => { alive = false; };
  }, [followedArtists, spotifyClient]);
  // generic horizontal scroll helpers
  const makeScroller = (ref: React.RefObject<HTMLDivElement>) => ({
    left: () => {
      const el = ref.current; if(!el) return;
      const children = Array.from(el.children) as HTMLElement[];
      if(!children.length) return;
      const positions = children.map(c => c.offsetLeft);
      const current = el.scrollLeft;
      // find index of leftmost item (last whose start <= current)
      let idx = 0; for(let i=0;i<positions.length;i++){ if(positions[i] <= current + 1) idx = i; else break; }
      const prevIdx = Math.max(0, idx - 1);
      const target = positions[prevIdx];
      el.scrollTo({ left: target, behavior:'smooth' });
    },
    right: () => {
      const el = ref.current; if(!el) return;
      const children = Array.from(el.children) as HTMLElement[];
      if(!children.length) return;
      const positions = children.map(c => c.offsetLeft);
      const current = el.scrollLeft;
      // index of leftmost item
      let idx = 0; for(let i=0;i<positions.length;i++){ if(positions[i] <= current + 1) idx = i; else break; }
      const nextIdx = Math.min(positions.length - 1, idx + 1);
      const target = positions[nextIdx];
      if(target !== current) el.scrollTo({ left: target, behavior:'smooth' });
    }
  });

  const refLatest = useRef<HTMLDivElement>(null);
  const refRecommended = useRef<HTMLDivElement>(null);
  const refTrending = useRef<HTMLDivElement>(null);
  const refArtists = useRef<HTMLDivElement>(null);

  const scLatest = makeScroller(refLatest);
  const scRecommended = makeScroller(refRecommended);
  const scTrending = makeScroller(refTrending);
  const scArtists = makeScroller(refArtists);

  const scrollTolerance = 6;

  // Lazy-loading cache for fetched collections (artist/album/playlist -> simple track array)
  const [collectionCache, setCollectionCache] = useState<Record<string, any[] | undefined>>({});

  function addPlayButton(tracks: any[] | undefined) {
    if (!tracks || tracks.length === 0) return null;
    const ids = tracks.map(t => String(t.id)).filter(Boolean);
    if (!ids.length) return null;
    return (
      <div
        className='media-play-overlay'
        role="button"
        aria-label={t('player.play','Play')}
        onClick={(e) => { e.stopPropagation(); playNow(ids); }}
      >
        <span className="material-symbols-rounded filled">play_arrow</span>
      </div>
    );
  }

  const loadCollection = async (kind: 'album'|'artist'|'playlist', id?: string | number) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    if (collectionCache[key] !== undefined) return; // already loaded (could be undefined if failed)
    try {
      let tracks: any[] | undefined;
      if (kind === 'album') tracks = await fetchAlbumTracks(id, { limit: 10 }) as any;
      else if (kind === 'artist') tracks = await fetchArtistTracks(id, { limit: 10 }) as any;
      else tracks = await fetchPlaylistTracks(id, { limit: 10 }) as any;
      setCollectionCache(prev => ({ ...prev, [key]: tracks }));
    } catch (e) {
      setCollectionCache(prev => ({ ...prev, [key]: undefined }));
    }
  }

  const renderCollectionPlay = (kind: 'album'|'artist'|'playlist'|'track', id?: string | number) => {
    if (!id) return null;
    if (kind === 'track') {
      return (
        <div
          className='media-play-overlay'
          role="button"
          aria-label={t('player.play','Play')}
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
        aria-label={t('player.play','Play')}
        onMouseEnter={() => loadCollection(kind, id)}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            let res: any[] | undefined;
            if (kind === 'album') res = await fetchAlbumTracks(id as any, { limit: 50 }) as any;
            else if (kind === 'artist') res = await fetchArtistTracks(id as any, { limit: 50 }) as any;
            else res = await fetchPlaylistTracks(id as any, { limit: 50 }) as any;
            if (res && res.length) {
              playNow(res.map(r => String((r as any).id)));
              setCollectionCache(prev => ({ ...prev, [key]: res }));
            }
          } catch (err) {
            console.warn('play collection failed', err);
          }
        }}
      >
        <span className="material-symbols-rounded filled">play_arrow</span>
      </div>
    );
  }

  // manage overflow classes on wrappers depending on scroll position
  useEffect(()=>{
    const rows: Array<React.RefObject<HTMLDivElement>> = [refLatest, refRecommended, refTrending, refArtists];
    const observers: ResizeObserver[] = [];

    function update(row: HTMLDivElement){
      const wrap = row.parentElement; if(!wrap) return;
      const { scrollLeft, scrollWidth, clientWidth } = row;
      const canScroll = scrollWidth > clientWidth + scrollTolerance; // tolerance
      const atStart = scrollLeft <= scrollTolerance;
      const atEnd = scrollLeft + clientWidth >= scrollWidth - scrollTolerance;
      wrap.classList.remove('media-row-overflow-right','media-row-overflow-left','media-row-overflow-both');
      if(!canScroll) return; // no class
      if(atStart && !atEnd) wrap.classList.add('media-row-overflow-right');
      else if(!atStart && atEnd) wrap.classList.add('media-row-overflow-left');
      else if(!atStart && !atEnd) wrap.classList.add('media-row-overflow-both');
    }

    function attach(ref: React.RefObject<HTMLDivElement>){
      const el = ref.current; if(!el) return;
      const onScroll = () => update(el);
      el.addEventListener('scroll', onScroll, { passive: true });
      const ro = new ResizeObserver(()=> update(el));
      ro.observe(el);
      observers.push(ro);
      // initial
      requestAnimationFrame(()=> update(el));
      return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
    }

  // reset scroll to left on mount for consistent stick behavior
  rows.forEach(r => { if(r.current) r.current.scrollLeft = 0; });
  const cleanups = rows.map(r => attach(r)).filter(Boolean) as Array<() => void>;
    const onWinResize = () => rows.forEach(r => { if(r.current) update(r.current); });
    window.addEventListener('resize', onWinResize);
    return () => { cleanups.forEach(fn=>fn()); window.removeEventListener('resize', onWinResize); observers.forEach(o=>o.disconnect()); };
  }, []);

  return (
  <section className="home-page" aria-label={t('home.pageLabel','Browse and personalized content')}>
      {/* Hero / Welcome */}
      <div className="home-hero" style={{ ['--hero-image' as any]: `url(${heroImage})` }}>
        <div className="home-hero-overlay" />
        <div className="home-hero-body">
          <h1 className="home-hero-title">{t('home.welcome')}</h1>
          <p className="home-hero-sub">{t('home.subtitle')}</p>
          <div className="home-hero-actions">
            <button className="np-icon" type="button" aria-label={t('home.cta.playDailyMix')}><span className="material-symbols-rounded filled">play_arrow</span></button>
            <button className="np-icon" type="button" aria-label={t('home.cta.shuffleAll')}><span className="material-symbols-rounded filled">shuffle</span></button>
            <button className="np-icon" type="button" aria-label={t('home.cta.openQueue')}><span className="material-symbols-rounded filled">queue_music</span></button>
          </div>
        </div>
      </div>

      {/* Latest Releases */}
  <HomeSection id="latest" title={t('home.section.latest')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scLatest.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refLatest} className="media-row scroll-x">
          {latestReleases && latestReleases.length ? (
            latestReleases.map((al, i) => (
              <div key={String(al.id || i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if(onSelectAlbum && al.id) onSelectAlbum(String(al.id)); }}>
                <div className="media-cover square">
                  <div className="media-cover-inner">
                    <img src={al.image || ''} alt={al.name || ''} />
                  </div>
                  {renderCollectionPlay('album', al.id ?? undefined)}
                </div>
                <h3 className="media-title">{al.name}</h3>
                <div className="media-meta">{(al.artists && al.artists.map(a=>a.name).join(', ')) || ''}</div>
              </div>
            ))
          ) : (
            Array.from({length:10}).map((_,i)=> (
              <div key={i} className="media-card compact" role="button">
                <div className="media-cover square">
                  <div className="media-cover-inner"><img src="" alt="" /></div>
                </div>
                <h3 className="media-title">New Release {i+1}</h3>
                <div className="media-meta">Artist • {(2025)}</div>
              </div>
            ))
          )}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scLatest.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Recommended For You */}
  <HomeSection id="recommended" title={t('home.section.recommended')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scRecommended.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refRecommended} className="media-row scroll-x">
          {recommended && recommended.length ? (
            recommended.map((s, i) => (
              <div key={String(s.id || i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if(onSelectTrack && s.id) onSelectTrack(String(s.id)); }}>
                <div className="media-cover square">
                  <div className="media-cover-inner"><img src={s.image || ''} alt={s.name || ''} /></div>
                  {renderCollectionPlay('track', s.id ?? undefined)}
                </div>
                <h3 className="media-title">{s.name}</h3>
                <div className="media-meta">{(s.artists && s.artists.map(a=>a.name).join(', ')) || ''}</div>
              </div>
            ))
          ) : (
            Array.from({length:8}).map((_,i)=> (
              <div key={i} className="media-card compact" role="button">
                <div className="media-cover square"><div className="media-cover-inner"><img src="" alt="" /></div></div>
                <h3 className="media-title">Mix #{i+1}</h3>
                <div className="media-meta">Eclectic · Auto Mix</div>
              </div>
            ))
          )}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scRecommended.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Trending Now */}
  <HomeSection id="trending" title={t('home.section.trending')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scTrending.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refTrending} className="media-row scroll-x dense">
          {tops.songs.map((s: TopSong, i) => (
            <div key={String(s.id||i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if(onSelectTrack && s.id) onSelectTrack(String(s.id)); }}>
              <div className="media-cover square" aria-hidden="true">
                <div className="media-cover-inner"><img src={s.image || ''} alt="" /></div>
                {renderCollectionPlay('track', s.id ?? undefined)}
              </div>
              <h3 className="media-title">{s.name}</h3>
              <p className="media-meta">{(s.artists && s.artists.map((a:{name?:string})=>a.name).join(', ')) || ''}</p>
            </div>
          ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scTrending.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Top Artists */}
  <HomeSection id="artists" title={t('home.section.artists')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scArtists.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refArtists} className="media-row scroll-x artists">
          {tops.artists.map((a: TopArtist, i) => (
            <div key={String(a.id||i)} className="media-card compact" role="button" tabIndex={0} onClick={() => { if(onSelectArtist && a.id) onSelectArtist(String(a.id)); }}>
              <div className="media-cover circle" aria-hidden="true">
                <div className="media-cover-inner"><img src={a.image || ''} alt="" /></div>
                {renderCollectionPlay('artist', a.id ?? undefined)}
              </div>
              <h3 className="media-title">{a.name}</h3>
              <p className="media-meta">{a.rank ? `#${a.rank}` : ''}</p>
            </div>
          ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scArtists.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Genres & Moods */}
  <HomeSection id="genres" title={t('home.section.genres')} more>
        <div className="chip-grid">
          {['Electronic','Chill','Focus','Gaming','Workout','Jazz','Classical','Hip-Hop','Ambient','Indie'].map(tag => (
            <button key={tag} className="chip" type="button">{tag}</button>
          ))}
        </div>
      </HomeSection>
    </section>
  )
}

/* --- Internal compositional components (lightweight) --- */
interface HomeSectionProps { id:string; title:string; children: React.ReactNode; more?:boolean }
function HomeSection({id,title,children,more}:HomeSectionProps){
  const { t } = useI18n();
  return (
    <section className="home-section" aria-labelledby={`${id}-title`}>
      <header className="home-sec-head">
        <h2 id={`${id}-title`} className="home-sec-title">{title}</h2>
        {more && <button className="np-link home-sec-more" type="button">{t('home.section.seeAll')}</button>}
      </header>
      {children}
    </section>
  )
}

interface MediaCardProps { children:React.ReactNode; kind?:string; progress?:boolean; compact?:boolean; circle?:boolean }
function MediaCard({children, progress, compact, circle}:MediaCardProps){
  const cls = ["media-card", progress && 'has-progress', compact && 'compact', circle && 'is-circle'].filter(Boolean).join(' ')
  return <article className={cls}>{children}</article>
}
