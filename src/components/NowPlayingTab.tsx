import React, { useEffect, useMemo, useState } from 'react';
import { usePlayback } from '../core/playback';
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../core/spotify';

// Utility: ms to m:ss
function fmt(ms?: number){
  if(!ms && ms!==0) return '--:--';
  const total = Math.floor(ms/1000); const m = Math.floor(total/60); const s = total%60; return m+':' + (s<10?'0':'')+s;
}

export default function NowPlayingTab(){
  const { currentTrack, loading, error } = usePlayback();
  const [album, setAlbum] = useState<SpotifyAlbum|undefined>();
  const [primaryArtist, setPrimaryArtist] = useState<SpotifyArtist|undefined>();
  const [albumTracks, setAlbumTracks] = useState<SpotifyTrack[]|undefined>();
  const [tracksLoading, setTracksLoading] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [geniusBio, setGeniusBio] = useState<string | undefined>();
  const [geniusBioLoading, setGeniusBioLoading] = useState(false);
  const [geniusBioErr, setGeniusBioErr] = useState<string | undefined>();
  const [lastGeniusArtist, setLastGeniusArtist] = useState<string | undefined>();

  // Fetch album + artist when track changes
  useEffect(()=>{
    let cancelled = false;
    async function run(){
      if(!currentTrack) { setAlbum(undefined); setPrimaryArtist(undefined); setAlbumTracks(undefined); return; }
      const w:any = window;
      try {
        if(currentTrack.album?.id && w.electron?.spotify?.getAlbum){
            const a: SpotifyAlbum = await w.electron.spotify.getAlbum(currentTrack.album.id);
            if(!cancelled) setAlbum(a);
        }
      } catch(_) { /* ignore */ }
      try {
        const first = currentTrack.artists?.[0];
        if(first?.id && w.electron?.spotify?.getArtist){
          const art: SpotifyArtist = await w.electron.spotify.getArtist(first.id);
          if(!cancelled) setPrimaryArtist(art);
        }
      } catch(_) { /* ignore */ }
    }
    run();
    return ()=>{ cancelled = true; };
  }, [currentTrack?.id]);

  // Fetch album tracks (optional) - use renderer fallback if exposed method exists or implement later.
  useEffect(()=>{
    let cancelled = false;
    async function loadTracks(){
      setAlbumTracks(undefined);
      if(!currentTrack?.album?.id) return;
      const w:any = window;
      if(w.electron?.spotify?.getAlbumTracks){
        setTracksLoading(true);
        try {
          const res = await w.electron.spotify.getAlbumTracks(currentTrack.album.id);
          if(!cancelled) setAlbumTracks(res.items || []);
        } catch { /* ignored */ }
        finally { if(!cancelled) setTracksLoading(false); }
      }
    }
    loadTracks();
    return ()=>{ cancelled = true; };
  }, [currentTrack?.album?.id]);

  // Fetch Genius biography for primary Spotify artist
  useEffect(()=>{
  const artistNameRaw = primaryArtist?.name?.trim();
  if(!artistNameRaw || artistNameRaw === lastGeniusArtist) return; // avoid repeat
  const artistName = artistNameRaw; // defined beyond this point
    let cancelled = false;
    async function loadBio(){
      setGeniusBio(undefined); setGeniusBioErr(undefined); setGeniusBioLoading(true);
      try {
        const w:any = window;
        if(!w.electron?.genius?.search || !w.electron?.genius?.getArtist){
          throw new Error('Genius IPC unavailable');
        }
  const res = await w.electron.genius.search(artistName);
        const hits = res?.hits || [];
        // Find hit whose primary artist matches exactly (case-insensitive); fallback to first
  let target = hits.find((h:any)=> h.primaryArtist?.name && h.primaryArtist.name.toLowerCase() === artistName.toLowerCase()) || hits[0];
        const artistId = target?.primaryArtist?.id;
        if(!artistId){ throw new Error('No matching Genius artist'); }
        const ga = await w.electron.genius.getArtist(artistId);
        if(cancelled) return;
  const html: string | undefined = ga?.description?.html || ga?.descriptionPlain || ga?.description?.plain;
  setGeniusBio(html || undefined);
  setLastGeniusArtist(artistName);
      } catch(e:any){ if(!cancelled){ setGeniusBioErr(e?.message || 'Bio unavailable'); } }
      finally { if(!cancelled) setGeniusBioLoading(false); }
    }
    loadBio();
    return ()=> { cancelled = true; };
  }, [primaryArtist?.name, lastGeniusArtist]);

  const heroImage = useMemo(()=>{
    return album?.images?.[0]?.url || currentTrack?.album?.images?.[0]?.url || '/icon-192.png';
  }, [album, currentTrack?.album?.images]);

  const releaseYear = album?.releaseDate ? (album.releaseDate.split('-')[0]) : undefined;
  const genres = primaryArtist?.genres?.slice(0,3) || [];
  // Dynamic artist column width (estimate based on longest primary artist name among album tracks)
  const artistColWidth = useMemo(()=>{
    if(!albumTracks || !albumTracks.length) return undefined;
    const names = albumTracks.map(t => (t.artists?.[0]?.name || ''));
    const longest = names.reduce((a,b)=> b.length > a.length ? b : a, '');
    if(!longest) return undefined;
    const avgCharPx = 7.2; // heuristic average width
    const padding = 28; // left/right interior + gap buffer
    const px = Math.min(240, Math.max(80, Math.round(longest.length * avgCharPx + padding)));
    return px;
  }, [albumTracks]);

  return (
    <section className="now-playing" aria-labelledby="np-heading">
      <header className="np-hero" style={{ ['--hero-image' as any]: `url(${heroImage})` }}>
        <div className="np-hero-inner">
          <h1 id="np-heading" className="np-title">
            { loading ? 'Loading…' : (currentTrack?.name || 'No track') }
          </h1>
          {error && <div className="np-error" role="alert">{error}</div>}
          {currentTrack && (
            <div className="np-meta-line">
              <span className="np-artists">
                {currentTrack.artists.map((a,i)=>(
                  <React.Fragment key={a.id||a.name}>
                    {i>0 && <span className="np-sep">, </span>}
                    <button type="button" className="np-link artist" onClick={()=> a.url && window.open(a.url,'_blank')}>{a.name}</button>
                  </React.Fragment>
                ))}
              </span>
              {currentTrack.album?.name && <><span className="np-dot" />
                <span className="np-album">{currentTrack.album.name}{releaseYear?` (${releaseYear})`:''}</span></>}
            </div>
          )}
          <div className="np-extras">
            <div className="np-tags" aria-label="Genres / tags">
              {genres.length? genres.map(g=> <span key={g} className="tag">{g}</span>) : <span className="tag">—</span>}
            </div>
            <div className="np-actions" aria-label="Track actions">
              <button className="np-icon" aria-label="Add to playlist" disabled><span className="material-symbols-rounded">add_circle</span></button>
              <button className="np-icon" aria-label="Like" disabled><span className="material-symbols-rounded">favorite</span></button>
              <button className="np-icon" aria-label="Share" onClick={()=> currentTrack?.url && navigator.clipboard?.writeText(currentTrack.url)}><span className="material-symbols-rounded">ios_share</span></button>
            </div>
          </div>
        </div>
      </header>

      <div className="np-section np-album-tracks" aria-label="Album track list">
        <h4 className="np-sec-title">From the same album</h4>
        {album && (
          <div className="np-album-heading">
            <span className="np-album-name" title={album.name}>{album.name}</span>
            <span className="np-album-trackcount">{album.totalTracks} tracks</span>
          </div>
        )}
        {!currentTrack && !loading && <p className="np-hint">Select a track to view its album.</p>}
        {tracksLoading && <p className="np-hint">Loading tracks…</p>}
        {albumTracks && (
          <ol className="np-tracklist" style={artistColWidth ? ({ ['--artist-col-width' as any]: artistColWidth + 'px' }) : undefined}>
            {albumTracks.map((t,i)=>(
              <li key={t.id} className={t.id===currentTrack?.id? 'current':''} aria-current={t.id===currentTrack?.id? 'true': undefined}>
                <span className="index">{i+1}</span>
                <span className="t-title" title={t.name}>{t.name}</span>
                <span className="t-artist-col" title={t.artists?.map(a=>a.name).join(', ') || ''}>{t.artists?.[0]?.name || '—'}</span>
                <span className="duration">{fmt(t.durationMs)}</span>
              </li>
            ))}
          </ol>
        )}
  {!tracksLoading && !albumTracks && currentTrack?.album && <p className="np-hint">Album tracks unavailable.</p>}
      </div>

      <div className="np-section np-artist-info" aria-label="Artist information">
        <h4 className="np-sec-title">Artist Info</h4>
        {primaryArtist ? (
          <div className="artist-header">
            <div className="artist-avatar-wrap" aria-hidden="true">
              {/* Spotify artist images vary; pick first if exists */}
              <img src={primaryArtist.images?.[0]?.url || '/icon-192.png'} alt={primaryArtist.name + ' avatar'} />
            </div>
            <div className="artist-primary">
              <h3 className="artist-name">{primaryArtist.name}</h3>
              <div className="artist-stats">
                {primaryArtist.followers !== undefined && <span><strong>{Intl.NumberFormat().format(primaryArtist.followers)}</strong> followers</span>}
                {primaryArtist.popularity !== undefined && <span><strong>{primaryArtist.popularity}</strong> popularity</span>}
                <button className="np-pill follow-btn" type="button" disabled>Follow</button>
              </div>
            </div>
          </div>
        ) : (
          <p className="np-hint">{currentTrack? 'Loading artist…':'No artist selected.'}</p>
        )}
        {primaryArtist && (
          <div className={`artist-bio ${bioExpanded ? 'expanded' : 'collapsed'}`}>
            <div className="bio-content">
              <p>Genres: {primaryArtist.genres.length? primaryArtist.genres.join(', '):'—'}</p>
              {geniusBioLoading && <p className="np-hint">Loading biography…</p>}
              {!geniusBioLoading && geniusBio && (
                <div className="np-bio-text" 
                  dangerouslySetInnerHTML={{
                    __html: bioExpanded 
                      ? geniusBio 
                      : (()=>{ const txt = geniusBio.replace(/<[^>]+>/g,''); const short = txt.slice(0,400); return `<p>${short.replace(/&/g,'&amp;').replace(/</g,'&lt;')}${txt.length>400?'…':''}</p>`; })()
                  }} />
              )}
              {!geniusBioLoading && !geniusBio && !geniusBioErr && (
                <p className="np-hint">Biography not found.</p>
              )}
              {geniusBioErr && !geniusBioLoading && <p className="np-error" role="alert">{geniusBioErr}</p>}
            </div>
            <button type="button" className="bio-toggle np-link" onClick={()=> setBioExpanded(v=>!v)}>
              {bioExpanded? 'Show less':'Read more'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
