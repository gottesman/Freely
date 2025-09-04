import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useI18n } from '../core/i18n';
import { type SpotifyArtist, type SpotifyAlbum, type SpotifyTrack, type SpotifyPlaylist } from '../core/spotify';
import { useSpotifyClient } from '../core/spotify-client';
import GeniusClient from '../core/musicdata';
import { usePlaybackActions, usePlaybackSelector } from '../core/playback';
import TrackList from './TrackList';
import InfoHeader from './InfoHeader';
import useFollowedArtists from '../core/artists';

import { fmtMs, useHeroImage } from './tabHelpers';

export default function ArtistInfoTab({ artistId, onSelectAlbum, onSelectPlaylist, onSelectTrack }: { artistId?: string, onSelectAlbum?: (id: string)=>void, onSelectPlaylist?: (id: string)=>void, onSelectTrack?: (id: string)=>void }){
  const { t } = useI18n();
  const spotifyClient = useSpotifyClient();
  const [artist, setArtist] = useState<SpotifyArtist | undefined>();
  const [topTracks, setTopTracks] = useState<SpotifyTrack[] | undefined>();
  const [recentAlbums, setRecentAlbums] = useState<SpotifyAlbum[] | undefined>();
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[] | undefined>();
  const [loadingArtist, setLoadingArtist] = useState(false);
  const [loadingTop, setLoadingTop] = useState(false);
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [bio, setBio] = useState<string | undefined>();
  const [bioErr, setBioErr] = useState<string | undefined>();
  const [bioLoading, setBioLoading] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [lastBioArtist, setLastBioArtist] = useState<string | undefined>();
  const { enqueue, setQueue } = usePlaybackActions();
  const queueIds = usePlaybackSelector(s => s.queueIds ?? []);
  const currentIndex = usePlaybackSelector(s => s.currentIndex ?? 0);
  const currentTrack = usePlaybackSelector(s => s.currentTrack);
  const { followArtist, unfollowArtist, isFollowing, artists: followedArtists } = useFollowedArtists();
  const [localFollowing, setLocalFollowing] = useState<boolean>(false);
  const optimisticUpdateRef = useRef<{ id: string; following: boolean } | null>(null);
  const legacyEventHandledRef = useRef<boolean>(false); // Track if legacy event has handled the state

  // Load artist core info
  useEffect(()=>{
    let cancelled = false; setArtist(undefined);
    if(!artistId) return;
    (async()=>{
      setLoadingArtist(true);
      const w:any = window;
      try {
        let art: SpotifyArtist | undefined;
        if(w.electron?.spotify?.getArtist){ art = await w.electron.spotify.getArtist(artistId); }
        else { art = await spotifyClient.getArtist(artistId); }
        if(!cancelled) setArtist(art);
      } catch {}
      finally { if(!cancelled) setLoadingArtist(false); }
    })();
    return ()=>{ cancelled = true; };
  }, [artistId, spotifyClient]);

  // Load top tracks (limit 10)
  useEffect(()=>{
    let cancelled = false; setTopTracks(undefined);
    if(!artistId) return;
    (async()=>{
      setLoadingTop(true);
      const w:any = window; try {
        let tracks: SpotifyTrack[] | undefined;
        if(w.electron?.spotify?.getArtistTopTracks){ tracks = await w.electron.spotify.getArtistTopTracks(artistId); }
        else { tracks = await spotifyClient.getArtistTopTracks(artistId); }
        if(!cancelled && tracks) setTopTracks(tracks.slice(0,10));
      } finally { if(!cancelled) setLoadingTop(false); }
    })();
    return ()=>{ cancelled = true; };
  }, [artistId, spotifyClient]);

  // Load recent releases (albums + singles)
  useEffect(()=>{
    let cancelled = false; setRecentAlbums(undefined);
    if(!artistId) return;
    (async()=>{
      setLoadingAlbums(true);
      const w:any = window; try {
        let albums: SpotifyAlbum[] | undefined;
        if(w.electron?.spotify?.getArtistAlbums){ const res = await w.electron.spotify.getArtistAlbums(artistId); albums = res.items || []; }
        else { const res = await spotifyClient.getArtistAlbums(artistId, { includeGroups:'album,single', fetchAll:false, limit:20 }); albums = res.items; }
        if(albums){
          // Sort descending by release date
          albums.sort((a,b)=> (b.releaseDate || '').localeCompare(a.releaseDate || ''));
          // Deduplicate by album name (Spotify often returns deluxe/duplicate versions) keep first
          const seen = new Set<string>();
          const dedup: SpotifyAlbum[] = [];
          for(const alb of albums){ if(!seen.has(alb.name.toLowerCase())){ dedup.push(alb); seen.add(alb.name.toLowerCase()); } }
          if(!cancelled) setRecentAlbums(dedup.slice(0,8));
        }
      } finally { if(!cancelled) setLoadingAlbums(false); }
    })();
    return ()=>{ cancelled = true; };
  }, [artistId, spotifyClient]);

  // Load playlists containing artist (approximation via search, since requires broader user auth for full). We'll do a search by artist name.
  useEffect(()=>{
    let cancelled = false; setPlaylists(undefined);
    if(!artist?.name) return;
    const name = artist.name;
    (async()=>{
      setLoadingPlaylists(true);
      try {
        const w:any = window; let items: SpotifyPlaylist[] | undefined;
        if(w.electron?.spotify?.searchPlaylists){ const res = await w.electron.spotify.searchPlaylists(name); items = res.items || res.playlists?.items || []; }
        else { const res = await spotifyClient.searchPlaylists(name); items = res.items; }
        if(!cancelled && items){
          // Filter those whose name or description mention the artist
          const lower = name.toLowerCase();
          const filtered = items.filter(p=> (p.name||'').toLowerCase().includes(lower) || (p.description||'').toLowerCase().includes(lower));
          if(filtered.length) setPlaylists(filtered.slice(0,8)); else setPlaylists(items.slice(0,4));
        }
      } catch{}
      finally { if(!cancelled) setLoadingPlaylists(false); }
    })();
    return ()=>{ cancelled = true; };
  }, [artist?.name, spotifyClient]);

  // Load biography via Genius (similar to SongInfoTab)
  useEffect(()=>{
    const artistNameRaw = artist?.name?.trim();
    if(!artistNameRaw || artistNameRaw === lastBioArtist) return;
    const artistName = artistNameRaw; let cancelled = false;
    (async()=>{
      setBio(undefined); setBioErr(undefined); setBioLoading(true);
      try {
        const w:any = window; const hasIpc = !!(w.electron?.genius?.search && w.electron?.genius?.getArtist);
        let searchRes: any; if(hasIpc) searchRes = await w.electron.genius.search(artistName); else { const gc = new GeniusClient(); searchRes = await gc.search(artistName); }
        const hits = searchRes?.hits || []; let target = hits.find((h:any)=> h.primaryArtist?.name && h.primaryArtist.name.toLowerCase() === artistName.toLowerCase()) || hits[0];
        const artistId = target?.primaryArtist?.id; if(!artistId) throw new Error('No matching Genius artist');
        let ga: any; if(hasIpc) ga = await w.electron.genius.getArtist(artistId); else { const gc = new GeniusClient(); ga = await gc.getArtist(artistId); }
        if(cancelled) return; const html: string | undefined = ga?.description?.html || ga?.descriptionPlain || ga?.description?.plain;
        setBio(html || undefined); setLastBioArtist(artistName);
      } catch(e:any){ if(!cancelled) setBioErr(e?.message || 'Bio unavailable'); }
      finally { if(!cancelled) setBioLoading(false); }
    })();
    return ()=> { cancelled = true; };
  }, [artist?.name, lastBioArtist]);

  const heroImage = useMemo(() => useHeroImage(artist?.images, 0), [artist?.images]);
  // Column width handled within TrackList

  const genres = useMemo(() => artist?.genres ?? [], [artist?.genres]);

  const playTopTracksNow = () => {
    if(!topTracks?.length) return;
  const currentSegment = (queueIds || []).slice(currentIndex || 0);
    const trackIds = topTracks.map(t=> t.id).filter(Boolean);
    const dedupSet = new Set(trackIds);
    const filteredCurrent = currentSegment.filter(id => !dedupSet.has(id));
    const newQueue = [...trackIds, ...filteredCurrent];
    setQueue(newQueue, 0);
  };
  const addTopTracksToQueue = () => {
    if(!topTracks?.length) return;
    const trackIds = topTracks.map(t=> t.id).filter(Boolean);
    const existing = new Set(queueIds);
    const toAppend = trackIds.filter(id => !existing.has(id));
    if(toAppend.length) enqueue(toAppend);
  };

  // Keep a local optimistic state so the UI updates immediately when toggling follow/unfollow.
  useEffect(() => {
    console.log('[artists-debug] ArtistInfoTab useEffect triggered - artist?.id=', artist?.id, 'followedArtists.length=', followedArtists.length, 'legacyEventHandled=', legacyEventHandledRef.current);
    if (artist?.id) {
      // Check if we have an optimistic update for this artist
      const optimistic = optimisticUpdateRef.current;
      if (optimistic && optimistic.id === artist.id) {
        console.log('[artists-debug] Using optimistic state:', optimistic.following, '(ignoring actual state)');
        // Don't override optimistic updates from useEffect
        return;
      } 
      // Don't override if legacy event has already handled this
      else if (legacyEventHandledRef.current) {
        console.log('[artists-debug] Skipping useEffect update - legacy event already handled');
        return;
      } 
      else {
        const actualFollowing = isFollowing(artist.id);
        console.log('[artists-debug] Using actual following state:', actualFollowing);
        setLocalFollowing(actualFollowing);
      }
    } else {
      setLocalFollowing(false);
      legacyEventHandledRef.current = false; // Reset when no artist
    }
  }, [artist?.id, isFollowing]); // Removed followedArtists dependency

  // Listen to legacy global artist change event to refresh localFollowing immediately when other components trigger changes
  useEffect(()=>{
    const handler = (event: any) => { 
      console.log('[artists-debug] ArtistInfoTab legacy event handler triggered for artist:', artist?.id);
      if(artist?.id) {
        // Use the event detail if available, otherwise fall back to isFollowing
        const eventArtists = event?.detail?.artists;
        if(eventArtists && Array.isArray(eventArtists)) {
          const isInEventList = eventArtists.some((a: any) => a.id === artist.id);
          console.log('[artists-debug] Using event detail, isInEventList:', isInEventList);
          setLocalFollowing(isInEventList);
          
          // Mark that legacy event has handled the state
          legacyEventHandledRef.current = true;
          
          // Clear optimistic update only after we've set the new state from event detail
          if (optimisticUpdateRef.current?.id === artist.id) {
            console.log('[artists-debug] Clearing optimistic update for artist:', artist.id);
            optimisticUpdateRef.current = null;
          }
        } else {
          // Only use isFollowing fallback if no optimistic update is active
          if (!optimisticUpdateRef.current || optimisticUpdateRef.current.id !== artist.id) {
            const actualFollowing = isFollowing(artist.id);
            console.log('[artists-debug] Using isFollowing fallback:', actualFollowing);
            setLocalFollowing(actualFollowing);
            legacyEventHandledRef.current = true;
          } else {
            console.log('[artists-debug] Skipping isFollowing fallback due to active optimistic update');
          }
        }
      }
    };
    window.addEventListener('freely:followed-artists-changed', handler);
    return () => window.removeEventListener('freely:followed-artists-changed', handler);
  }, [artist?.id, isFollowing]);

  const onToggleFollow = async () => {
    if(!artist) return;
    const id = artist.id;
    // Use localFollowing instead of isFollowing to get the current UI state
    const currently = localFollowing;
    console.log('[artists-debug] onToggleFollow clicked id=', id, 'currentlyFollowing=', currently, 'localFollowing=', localFollowing, 'isFollowing=', isFollowing(id));
    
    // Reset legacy event flag when starting new operation
    legacyEventHandledRef.current = false;
    
    // Set optimistic update
    const newFollowingState = !currently;
    console.log('[artists-debug] Setting optimistic state to:', newFollowingState);
    optimisticUpdateRef.current = { id, following: newFollowingState };
    setLocalFollowing(newFollowingState);
    
    try{
      if(currently) {
        console.log('[artists-debug] Calling unfollowArtist');
        await unfollowArtist(id);
      } else {
        console.log('[artists-debug] Calling followArtist');
        await followArtist(artist);
      }
      console.log('[artists-debug] Follow/unfollow operation completed');
    }catch(e){
      console.warn('follow toggle failed', e);
      // revert optimistic change on error
      optimisticUpdateRef.current = null;
      legacyEventHandledRef.current = false;
      setLocalFollowing(currently);
    }
  };

  const headerActions = [
    <button key="follow" className={`np-icon ${artist && localFollowing ? 'active' : ''}`} aria-pressed={artist ? localFollowing : false} aria-label={t('np.like','Like')} onClick={onToggleFollow}><span className={`material-symbols-rounded${artist && localFollowing ? ' filled' : ''}`}>favorite</span></button>
  ];

  return (
    <section className="now-playing" aria-labelledby="artist-heading">
      <InfoHeader
        id="artist-heading"
        title={artist ? artist.name : (artistId ? t('np.loading') : t('np.noArtist'))}
        meta={artist && artist.followers !== undefined ? <span className="np-album-trackcount">{Intl.NumberFormat().format(artist.followers)} {t('np.followers', undefined, { count: '' }).replace('{count','')}</span> : undefined}
        tags={genres}
        actions={headerActions}
        heroImage={heroImage}
        ariaActionsLabel={t('np.artistActions','Artist actions')}
      />

      {/* Top Tracks */}
      <div className="np-section" aria-label={t('np.topTracks','Top tracks')}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <h4 className="np-sec-title">{t('np.topTracks','Top Tracks')}</h4>
        </div>
        {loadingTop && <p className="np-hint">{t('np.loadingTracks')}</p>}
        {!loadingTop && !topTracks && artistId && <p className="np-hint">{t('np.loading')}</p>}
        {!loadingTop && topTracks && (
          <TrackList
            tracks={topTracks}
            playingTrackId={currentTrack?.id}
            showPlayButton
            onSelectTrack={onSelectTrack}
          />
        )}
      </div>

      {/* Recent releases */}
      <div className="np-section" aria-label={t('np.recentReleases','Recent releases')}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <h4 className="np-sec-title">{t('np.recentReleases','Recent Releases')}</h4>
          <button type="button" className="np-link" disabled={!artist} onClick={()=> {/* Placeholder for full discography action */}}>{t('np.viewDiscography','See all')}</button>
        </div>
        {loadingAlbums && <p className="np-hint">{t('np.loadingAlbums','Loading albums')}</p>}
        {!loadingAlbums && recentAlbums && recentAlbums.length === 0 && <p className="np-hint">{t('np.noAlbums','No releases')}</p>}
        {!loadingAlbums && recentAlbums && recentAlbums.length>0 && (
          <ul className="artist-grid" role="list" style={{listStyle:'none', margin:0, padding:0, display:'grid', gap:'12px', gridTemplateColumns:'repeat(auto-fill,minmax(120px,1fr))'}}>
            {recentAlbums.map(alb=>(
              <li key={alb.id} className="artist-grid-item" title={alb.name}>
                <button type="button" className="card-btn" style={{display:'flex',flexDirection:'column',width:'100%',textAlign:'left'}} onClick={()=> onSelectAlbum && onSelectAlbum(alb.id)}>
                  <div className="cover" style={{width:'100%', aspectRatio:'1/1', backgroundSize:'cover', backgroundPosition:'center', borderRadius:'8px', backgroundImage:`url(${(window as any).imageRes?.(alb.images,1) || ''})`}} />
                  <div className="info" style={{marginTop:'6px'}}><div className="name ellipsis" title={alb.name} style={{fontSize:'0.85rem', fontWeight:500}}>{alb.name}</div><div className="meta" style={{opacity:0.7, fontSize:'0.7rem'}}>{alb.releaseDate?.split('-')[0] || ''}</div></div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Playlists containing artist */}
      <div className="np-section" aria-label={t('np.playlistsFeaturing','Playlists featuring artist')}>
        <h4 className="np-sec-title">{t('np.playlistsFeaturing','Playlists Featuring')}</h4>
        {loadingPlaylists && <p className="np-hint">{t('np.loadingPlaylists','Loading playlists')}</p>}
        {!loadingPlaylists && playlists && playlists.length===0 && <p className="np-hint">{t('np.noPlaylists','No playlists found')}</p>}
        {!loadingPlaylists && playlists && playlists.length>0 && (
          <ul className="artist-grid" role="list" style={{listStyle:'none', margin:0, padding:0, display:'grid', gap:'12px', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))'}}>
            {playlists.map(pl=>(
              <li key={pl.id} className="artist-grid-item" title={pl.name}>
                <button type="button" className="card-btn" style={{display:'flex',flexDirection:'column',width:'100%',textAlign:'left'}} onClick={()=> onSelectPlaylist && onSelectPlaylist(pl.id)}>
                  <div className="cover" style={{width:'100%', aspectRatio:'1/1', backgroundSize:'cover', backgroundPosition:'center', borderRadius:'8px', backgroundImage:`url(${(window as any).imageRes?.(pl.images,1) || ''})`}} />
                  <div className="info" style={{marginTop:'6px'}}>
                    <div className="name ellipsis" title={pl.name} style={{fontSize:'0.85rem', fontWeight:500}}>{pl.name}</div>
                    <div className="meta" style={{opacity:0.7, fontSize:'0.7rem'}}>{typeof pl.totalTracks === 'number' ? t('np.tracks', undefined, { count: pl.totalTracks }) : ''}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Biography */}
      <div className="np-section np-artist-info" aria-label={t('np.artistBio','Artist biography')}>
        <h4 className="np-sec-title">{t('np.bio.title','Biography')}</h4>
        {bioLoading && <p className="np-hint">{t('np.bio.loading')}</p>}
        {!bioLoading && bioErr && <p className="np-error" role="alert">{bioErr}</p>}
        {!bioLoading && !bioErr && !bio && <p className="np-hint">{t('np.bio.notFound','No biography found')}</p>}
        {!bioLoading && bio && (
          <div className={`artist-bio ${bioExpanded ? 'expanded' : 'collapsed'}`}>
            <div className="bio-content">
              <div className="np-bio-text" dangerouslySetInnerHTML={{ __html: bioExpanded ? bio : (()=>{ const txt = bio.replace(/<[^>]+>/g,''); const short = txt.slice(0,500); return `<p>${short.replace(/&/g,'&amp;').replace(/</g,'&lt;')}${txt.length>500?'…':''}</p>`; })() }} />
            </div>
            <button type="button" className="bio-toggle np-link" onClick={()=> setBioExpanded(v=>!v)}>{bioExpanded? t('np.bio.showLess'):t('np.bio.readMore')}</button>
          </div>
        )}
      </div>
    </section>
  );
}
