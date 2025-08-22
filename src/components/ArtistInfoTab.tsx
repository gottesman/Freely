import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../core/i18n';
import SpotifyClient, { type SpotifyArtist, type SpotifyAlbum, type SpotifyTrack, type SpotifyPlaylist } from '../core/spotify';
import GeniusClient from '../core/musicdata';
import { usePlayback } from '../core/playback';
import TrackList from './TrackList';

function fmt(ms?: number){
  if(!ms && ms!==0) return '--:--';
  const total = Math.floor(ms/1000); const m = Math.floor(total/60); const s = total%60; return m+':' + (s<10?'0':'')+s;
}

export default function ArtistInfoTab({ artistId, onSelectAlbum, onSelectPlaylist, onSelectTrack }: { artistId?: string, onSelectAlbum?: (id: string)=>void, onSelectPlaylist?: (id: string)=>void, onSelectTrack?: (id: string)=>void }){
  const { t } = useI18n();
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
  const { enqueue, setQueue, queueIds, currentIndex, currentTrack } = usePlayback();

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
        else { const client = new SpotifyClient(); art = await client.getArtist(artistId); }
        if(!cancelled) setArtist(art);
      } catch {}
      finally { if(!cancelled) setLoadingArtist(false); }
    })();
    return ()=>{ cancelled = true; };
  }, [artistId]);

  // Load top tracks (limit 10)
  useEffect(()=>{
    let cancelled = false; setTopTracks(undefined);
    if(!artistId) return;
    (async()=>{
      setLoadingTop(true);
      const w:any = window; try {
        let tracks: SpotifyTrack[] | undefined;
        if(w.electron?.spotify?.getArtistTopTracks){ tracks = await w.electron.spotify.getArtistTopTracks(artistId); }
        else { const client = new SpotifyClient(); tracks = await client.getArtistTopTracks(artistId); }
        if(!cancelled && tracks) setTopTracks(tracks.slice(0,10));
      } finally { if(!cancelled) setLoadingTop(false); }
    })();
    return ()=>{ cancelled = true; };
  }, [artistId]);

  // Load recent releases (albums + singles)
  useEffect(()=>{
    let cancelled = false; setRecentAlbums(undefined);
    if(!artistId) return;
    (async()=>{
      setLoadingAlbums(true);
      const w:any = window; try {
        let albums: SpotifyAlbum[] | undefined;
        if(w.electron?.spotify?.getArtistAlbums){ const res = await w.electron.spotify.getArtistAlbums(artistId); albums = res.items || []; }
        else { const client = new SpotifyClient(); const res = await client.getArtistAlbums(artistId, { includeGroups:'album,single', fetchAll:false, limit:20 }); albums = res.items; }
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
  }, [artistId]);

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
        else { const client = new SpotifyClient(); const res = await client.searchPlaylists(name); items = res.items; }
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
  }, [artist?.name]);

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

  const heroImage = useMemo(()=> artist?.images?.[0]?.url || '/icon-192.png', [artist?.images]);
  // Column width handled within TrackList

  const playTopTracksNow = () => {
    if(!topTracks?.length) return;
    const currentSegment = queueIds.slice(currentIndex);
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

  return (
    <section className="now-playing" aria-labelledby="artist-heading">
      <header className="np-hero" style={{ ['--hero-image' as any]: `url(${heroImage})` }}>
        <div className="np-hero-inner">
          <h1 id="artist-heading" className="np-title">{ artist ? artist.name : (artistId ? t('np.loading'): t('np.noArtist')) }</h1>
          {artist && (
            <div className="np-meta-line">
              {artist.followers !== undefined && <><span className="np-album-trackcount">{Intl.NumberFormat().format(artist.followers)} {t('np.followers', undefined, { count: '' }).replace('{count}','')}</span></>}
            </div>
          )}
          <div className="np-extras">
            <div className="np-tags" aria-label={t('np.genresTags')}>{artist?.genres?.length? artist.genres.slice(0,5).map(g=> <span key={g} className="tag">{g}</span>) : <span className="tag">—</span>}</div>
            <div className="np-actions" aria-label={t('np.artistActions','Artist actions')}>
              <button className="np-icon" aria-label={t('np.like','Like')} disabled><span className="material-symbols-rounded">favorite</span></button>
            </div>
          </div>
        </div>
      </header>

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
                  <div className="cover" style={{width:'100%', aspectRatio:'1/1', backgroundSize:'cover', backgroundPosition:'center', borderRadius:'8px', backgroundImage:`url(${alb.images?.[0]?.url || '/icon-192.png'})`}} />
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
                  <div className="cover" style={{width:'100%', aspectRatio:'1/1', backgroundSize:'cover', backgroundPosition:'center', borderRadius:'8px', backgroundImage:`url(${pl.images?.[0]?.url || '/icon-192.png'})`}} />
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
