import React, { useState } from 'react';
import GeniusClient, { SongDetails } from '../core/musicdata';
import SpotifyClient from '../core/spotify';

function useApis(){
  const win: any = typeof window !== 'undefined' ? window : {};
  return {
    geniusProxy: win.electron?.genius,
    spotifyProxy: win.electron?.spotify,
    geniusDirect: new GeniusClient(),
    spotifyDirect: new SpotifyClient()
  };
}

type LogEntry = { ts:number; label:string; data:any };

export default function APIsTests(){
  const { geniusProxy, spotifyProxy, geniusDirect, spotifyDirect } = useApis();
  // Shared state
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  // Genius inputs
  const [gQuery, setGQuery] = useState('Bohemian Rhapsody');
  const [gSongId, setGSongId] = useState('');
  const [gArtistId, setGArtistId] = useState('');
  const [gAlbumId, setGAlbumId] = useState('');

  // Spotify inputs
  const [sQuery, setSQuery] = useState('Muse Uprising');
  const [sTrackId, setSTrackId] = useState('');
  const [sArtistId, setSArtistId] = useState('');
  const [sAlbumId, setSAlbumId] = useState('');
  const [sTypes, setSTypes] = useState<string[]>(['track']);

  function append(label:string, data:any){ setLog(l => [{ ts:Date.now(), label, data }, ...l.slice(0,199)]); }

  /* ---------------- Genius Actions ---------------- */
  async function gSearch(){
    if(!gQuery.trim()) return;
    setLoading(true);
    try {
      const res = geniusProxy?.search ? await geniusProxy.search(gQuery) : await geniusDirect.search(gQuery);
      append('genius:search', { query: gQuery, result: res });
      if(res?.hits?.[0]) setGSongId(String(res.hits[0].id));
    } catch(e:any){ append('genius:search:error', { query: gQuery, error: e.message||String(e) }); }
    finally { setLoading(false); }
  }
  async function gGetSong(){ if(!gSongId) return; setLoading(true); try { const id = Number(gSongId); const res: SongDetails = geniusProxy?.getSong ? await geniusProxy.getSong(id) : await geniusDirect.getSong(id); append('genius:getSong', res); } catch(e:any){ append('genius:getSong:error', e.message||String(e)); } finally { setLoading(false); } }
  async function gLyrics(){ if(!gSongId) return; setLoading(true); try { const id = Number(gSongId); const lyr = geniusProxy?.getLyrics ? await geniusProxy.getLyrics(id) : await geniusDirect.getLyricsForSong(id); append('genius:lyrics', lyr); } catch(e:any){ append('genius:lyrics:error', e.message||String(e)); } finally { setLoading(false); } }
  async function gArtist(){ if(!gArtistId) return; setLoading(true); try { const data = geniusProxy?.getArtist ? await geniusProxy.getArtist(Number(gArtistId)) : await geniusDirect.getArtist(Number(gArtistId)); append('genius:getArtist', data); } catch(e:any){ append('genius:getArtist:error', e.message||String(e)); } finally { setLoading(false); } }
  async function gAlbum(){ if(!gAlbumId) return; setLoading(true); try { const data = geniusProxy?.getAlbum ? await geniusProxy.getAlbum(Number(gAlbumId)) : await geniusDirect.getAlbum(Number(gAlbumId)); append('genius:getAlbum', data); } catch(e:any){ append('genius:getAlbum:error', e.message||String(e)); } finally { setLoading(false); } }

  /* ---------------- Spotify Actions ---------------- */
  async function sSearch(){
    if(!sQuery.trim()) return;
    setLoading(true);
    try {
      const res = spotifyProxy?.search ? await spotifyProxy.search(sQuery, sTypes) : await spotifyDirect.searchTracks(sQuery);
      append('spotify:search', { query: sQuery, types: sTypes, result: res }); // seed ids
      if(Array.isArray(res.results?.track) && res.results.track[0]) setSTrackId(res.results.track[0].id);
      if(Array.isArray(res.results?.album) && res.results.album[0]) setSAlbumId(res.results.album[0].id);
      if(Array.isArray(res.results?.artist) && res.results.artist[0]) setSArtistId(res.results.artist[0].id);
    } catch(e:any){ append('spotify:search:error', { query: sQuery, types: sTypes, error: e.message||String(e) }); }
    finally { setLoading(false); }
  }
  async function sGetTrack(){ if(!sTrackId) return; setLoading(true); try { const data = spotifyProxy?.getTrack ? await spotifyProxy.getTrack(sTrackId) : await spotifyDirect.getTrack(sTrackId); append('spotify:getTrack', data); } catch(e:any){ append('spotify:getTrack:error', e.message||String(e)); } finally { setLoading(false); } }
  async function sGetArtist(){ if(!sArtistId) return; setLoading(true); try { const data = spotifyProxy?.getArtist ? await spotifyProxy.getArtist(sArtistId) : await spotifyDirect.getArtist(sArtistId); append('spotify:getArtist', data); } catch(e:any){ append('spotify:getArtist:error', e.message||String(e)); } finally { setLoading(false); } }
  async function sGetAlbum(){ if(!sAlbumId) return; setLoading(true); try { const data = spotifyProxy?.getAlbum ? await spotifyProxy.getAlbum(sAlbumId) : await spotifyDirect.getAlbum(sAlbumId); append('spotify:getAlbum', data); } catch(e:any){ append('spotify:getAlbum:error', e.message||String(e)); } finally { setLoading(false); } }

  return (
    <section className="genius-tests" aria-label="tests">
      <h2 className="np-sec-title" style={{marginTop:0}}>Logs</h2>
      <div className="gt-log" aria-label="Results log" >
        {log.length === 0 && <div className="gt-empty">Empty log.</div>}
        {log.map(entry => (
          <details key={entry.ts} open>
            <summary><strong>{new Date(entry.ts).toLocaleTimeString()} — {entry.label}</strong></summary>
            <pre className="gt-pre">{JSON.stringify(entry.data, null, 2)}</pre>
          </details>
        ))}
      </div>
      <h2 className="np-sec-title" style={{marginTop:0}}>APIs Tests</h2>
      {/* Genius Section */}
      <h3 className="mini-title" style={{margin:'6px 0 4px'}}>Genius API</h3>
      <div className="gt-grid">
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Search</h4>
          <input className="tb-search" value={gQuery} onChange={e=>setGQuery(e.target.value)} placeholder="Genius query" />
          <button className="np-pill" disabled={loading} onClick={gSearch}>Search</button>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Song ID</h4>
          <input className="tb-search" value={gSongId} onChange={e=>setGSongId(e.target.value)} placeholder="Song ID" />
          <div className="gt-actions">
            <button className="np-pill" disabled={loading} onClick={gGetSong}>Get Song</button>
            <button className="np-pill" disabled={loading} onClick={gLyrics}>Lyrics</button>
          </div>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Artist ID</h4>
          <input className="tb-search" value={gArtistId} onChange={e=>setGArtistId(e.target.value)} placeholder="Artist ID" />
          <button className="np-pill" disabled={loading} onClick={gArtist}>Get Artist</button>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Album ID</h4>
          <input className="tb-search" value={gAlbumId} onChange={e=>setGAlbumId(e.target.value)} placeholder="Album ID" />
          <button className="np-pill" disabled={loading} onClick={gAlbum}>Get Album</button>
        </div>
      </div>

      {/* Spotify Section */}
      <h3 className="mini-title" style={{margin:'28px 0 4px'}}>Spotify API</h3>
      <div className="gt-grid">
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Search</h4>
          <input className="tb-search" value={sQuery} onChange={e=>setSQuery(e.target.value)} placeholder="Spotify query" />
          <div className="gt-actions">
            <select
              className="multi-select"
              value={sTypes}
              multiple
              onChange={e=>{
                const opts = Array.from(e.target.selectedOptions).map(o=>o.value);
                setSTypes(opts.length?opts:['track']);
              }}
            >
              <option value="track">Tracks</option>
              <option value="album">Albums</option>
              <option value="artist">Artists</option>
            </select>
            <button className="np-pill" disabled={loading} onClick={sSearch}>Search</button>
          </div>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Track ID</h4>
          <input className="tb-search" value={sTrackId} onChange={e=>setSTrackId(e.target.value)} placeholder="Track ID" />
          <button className="np-pill" disabled={loading} onClick={sGetTrack}>Get Track</button>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Artist ID</h4>
          <input className="tb-search" value={sArtistId} onChange={e=>setSArtistId(e.target.value)} placeholder="Artist ID" />
          <button className="np-pill" disabled={loading} onClick={sGetArtist}>Get Artist</button>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Album ID</h4>
          <input className="tb-search" value={sAlbumId} onChange={e=>setSAlbumId(e.target.value)} placeholder="Album ID" />
          <button className="np-pill" disabled={loading} onClick={sGetAlbum}>Get Album</button>
        </div>
      </div>

    </section>
  );
}
