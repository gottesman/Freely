import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../core/i18n';
import GeniusClient, { SongDetails } from '../core/musicdata';
import SpotifyClient from '../core/spotify';
import { useAlerts, LogEntry as AlertLogEntry } from '../core/alerts';
import ApiCacheTest from './ApiCacheTest';
import AddToPlaylistDemo from './AddToPlaylistDemo';
// Torrent search runs in Node (server/Electron). Avoid importing node-only modules in client bundle.
// We'll use window.electron.torrent (preload) or a server endpoint if available.

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

function serializeError(err: any){
  if(!err) return { message: 'Unknown error', raw: String(err) };
  const base: any = {
    name: err.name || undefined,
    message: err.message || String(err),
    stack: err.stack || undefined,
  };
  // Include common fields if present
  if(typeof err.status !== 'undefined') base.status = err.status;
  if(typeof err.statusText !== 'undefined') base.statusText = err.statusText;
  if(typeof err.code !== 'undefined') base.code = err.code;
  // Copy enumerable own props (shallow) up to a limit
  try {
    Object.keys(err).slice(0,20).forEach(k=>{
      if(base[k] !== undefined) return;
      const v = (err as any)[k];
      if(v == null) base[k] = v;
      else if(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') base[k] = v;
      else if(Array.isArray(v)) base[k] = v.slice(0,5);
      else if(typeof v === 'object') base[k] = Object.keys(v).slice(0,10);
    });
  } catch(_){}
  return base;
}

export default function APIsTests(){
  const { t } = useI18n();
  const { geniusProxy, spotifyProxy, geniusDirect, spotifyDirect } = useApis();
  const { addLogListener } = useAlerts();
  // Shared state
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  // Torrent search test state
  const [tQuery, setTQuery] = useState('');
  const [tProvider, setTProvider] = useState('all');
  const [tPage, setTPage] = useState(1);
  const [tResults, setTResults] = useState<any[]>([]);
  const [scrapers, setScrapers] = useState<Array<{id:string,name:string}>>([]);

  useEffect(()=>{
    const w:any = window;
    if(w.electron?.torrent?.listScrapers){
      (async()=> setScrapers(await w.electron.torrent.listScrapers()))();
    } else {
      // no electron torrent API available in renderer; leave scrapers empty or optionally fetch a server endpoint
      setScrapers([]);
    }
  }, []);

  async function runTorrentSearch(){
    if(!tQuery.trim()) return;
    setLoading(true);
    try {
      const w:any = window;
      let results:any[] = [];
      if(w.electron?.torrent?.search){
        results = await w.electron.torrent.search({ query: tQuery, page: tPage });
      } else {
        // fallback: try server API (if implemented)
        try {
          const resp = await fetch(`http://localhost:9000/api/torrent-search?q=${encodeURIComponent(tQuery)}&page=${tPage}`);
          if(resp.ok) results = await resp.json();
        } catch(err) {
          // ignore
        }
      }
      const filtered = tProvider==='all' ? results : results.filter((r:any)=> r.source === tProvider);
      setTResults(filtered);
      append('torrent:search', { query: tQuery, results: filtered.slice(0,50) });
    } catch(e:any){ append('torrent:search:error', { error: e && e.message ? e.message : String(e) }); }
    finally { setLoading(false); }
  }

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

  // Auto-diagnostic once to ensure something appears in log
  const didAuto = useRef(false);
  useEffect(()=>{
    if(didAuto.current) return;
    didAuto.current = true;
    // Record environment first
    append('tests:init', { geniusProxy: !!geniusProxy, spotifyProxy: !!spotifyProxy });
    // Kick off searches (non-blocking) to populate log; ignore errors (they'll be logged by existing handlers)
    setTimeout(()=>{ if(gQuery) gSearch(); if(sQuery) sSearch(); }, 50);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to alert logs
  useEffect(()=>{
    const off = addLogListener((entry: AlertLogEntry) => {
      setLog(l => [{ ts: entry.ts, label: 'alert:'+entry.severity, data: { msg: entry.msg, meta: entry.meta } }, ...l.slice(0,199)]);
    });
    return off;
  }, [addLogListener]);

  function append(label:string, data:any){ setLog(l => [{ ts:Date.now(), label, data }, ...l.slice(0,199)]); }

  /* ---------------- Genius Actions ---------------- */
  async function gSearch(){
    if(!gQuery.trim()) return;
    setLoading(true);
    try {
      const res = geniusProxy?.search ? await geniusProxy.search(gQuery) : await geniusDirect.search(gQuery);
      append('genius:search', { query: gQuery, result: res });
      if(res?.hits?.[0]) setGSongId(String(res.hits[0].id));
  } catch(e:any){ append('genius:search:error', { query: gQuery, error: serializeError(e) }); }
    finally { setLoading(false); }
  }
  async function gGetSong(){ if(!gSongId) return; setLoading(true); try { const id = Number(gSongId); const res: SongDetails = geniusProxy?.getSong ? await geniusProxy.getSong(id) : await geniusDirect.getSong(id); append('genius:getSong', res); } catch(e:any){ append('genius:getSong:error', serializeError(e)); } finally { setLoading(false); } }
  async function gLyrics(){ if(!gSongId) return; setLoading(true); try { const id = Number(gSongId); const lyr = geniusProxy?.getLyrics ? await geniusProxy.getLyrics(id) : await geniusDirect.getLyricsForSong(id); append('genius:lyrics', lyr); } catch(e:any){ append('genius:lyrics:error', serializeError(e)); } finally { setLoading(false); } }
  async function gArtist(){ if(!gArtistId) return; setLoading(true); try { const data = geniusProxy?.getArtist ? await geniusProxy.getArtist(Number(gArtistId)) : await geniusDirect.getArtist(Number(gArtistId)); append('genius:getArtist', data); } catch(e:any){ append('genius:getArtist:error', serializeError(e)); } finally { setLoading(false); } }
  async function gAlbum(){ if(!gAlbumId) return; setLoading(true); try { const data = geniusProxy?.getAlbum ? await geniusProxy.getAlbum(Number(gAlbumId)) : await geniusDirect.getAlbum(Number(gAlbumId)); append('genius:getAlbum', data); } catch(e:any){ append('genius:getAlbum:error', serializeError(e)); } finally { setLoading(false); } }

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
  } catch(e:any){ append('spotify:search:error', { query: sQuery, types: sTypes, error: serializeError(e) }); }
    finally { setLoading(false); }
  }
  async function sGetTrack(){ if(!sTrackId) return; setLoading(true); try { const data = spotifyProxy?.getTrack ? await spotifyProxy.getTrack(sTrackId) : await spotifyDirect.getTrack(sTrackId); append('spotify:getTrack', data); } catch(e:any){ append('spotify:getTrack:error', serializeError(e)); } finally { setLoading(false); } }
  async function sGetArtist(){ if(!sArtistId) return; setLoading(true); try { const data = spotifyProxy?.getArtist ? await spotifyProxy.getArtist(sArtistId) : await spotifyDirect.getArtist(sArtistId); append('spotify:getArtist', data); } catch(e:any){ append('spotify:getArtist:error', serializeError(e)); } finally { setLoading(false); } }
  async function sGetAlbum(){ if(!sAlbumId) return; setLoading(true); try { const data = spotifyProxy?.getAlbum ? await spotifyProxy.getAlbum(sAlbumId) : await spotifyDirect.getAlbum(sAlbumId); append('spotify:getAlbum', data); } catch(e:any){ append('spotify:getAlbum:error', serializeError(e)); } finally { setLoading(false); } }

  // Token status (diagnostics)
  async function sTokenStatus(){
    setLoading(true);
    try {
      if(!spotifyProxy?.tokenStatus){ append('spotify:tokenStatus:error', { message: 'No spotify IPC tokenStatus available' }); return; }
      const status = await spotifyProxy.tokenStatus();
      append('spotify:tokenStatus', status);
      if(status?.lastClassified){ append('spotify:tokenStatus:classified', { classification: status.lastClassified, hint: classificationHint(status.lastClassified) }); }
    } catch(e:any){ append('spotify:tokenStatus:error', serializeError(e)); }
    finally { setLoading(false); }
  }

  function classificationHint(c:string){
    switch(c){
      case 'cloudflare_challenge_or_block': return 'Server likely behind Cloudflare returning challenge HTML instead of JSON. Ensure token PHP bypasses challenges or use a backend environment.';
      case 'captcha_challenge': return 'A captcha page was returned. Disable captcha for the token endpoint or whitelist your server.';
      case 'not_found_html': return '404 HTML page. Verify SPOTIFY_TOKEN_ENDPOINT URL path and file existence.';
      case 'html_error_page': return 'Generic HTML error page. Check server/PHP error logs.';
      case 'host_injected_script': return 'Host inserted script (e.g., free hosting platform). Might be injecting encryption/ads breaking JSON. Consider moving endpoint to clean host.';
      default: return 'Unrecognized classification.';
    }
  }

  return (
    <section className="genius-tests" aria-label="tests">
  <h2 className="np-sec-title" style={{marginTop:0}}>{t('tests.logs')}</h2>
      <div className="gt-log" aria-label="Results log" >
  {log.length === 0 && <div className="gt-empty">{t('tests.emptyLog')}</div>}
        {log.map(entry => (
          <details key={entry.ts} open>
            <summary><strong>{new Date(entry.ts).toLocaleTimeString()} — {entry.label}</strong></summary>
            <pre className="gt-pre">{JSON.stringify(entry.data, null, 2)}</pre>
          </details>
        ))}
      </div>
  <h2 className="np-sec-title" style={{marginTop:0}}>{t('tests.apis')}</h2>
      {/* Genius Section */}
  <h3 className="mini-title" style={{margin:'6px 0 4px'}}>{t('tests.genius.api')}</h3>
      <div className="gt-grid">
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>{t('tests.search')}</h4>
          <input className="tb-search" value={gQuery} onChange={e=>setGQuery(e.target.value)} placeholder="Genius query" />
          <button className="np-pill" disabled={loading} onClick={gSearch}>{t('tests.search')}</button>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>{t('tests.songId')}</h4>
          <input className="tb-search" value={gSongId} onChange={e=>setGSongId(e.target.value)} placeholder={t('tests.songId')} />
          <div className="gt-actions">
            <button className="np-pill" disabled={loading} onClick={gGetSong}>{t('tests.getSong')}</button>
            <button className="np-pill" disabled={loading} onClick={gLyrics}>{t('tests.lyrics')}</button>
          </div>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>{t('tests.artistId')}</h4>
          <input className="tb-search" value={gArtistId} onChange={e=>setGArtistId(e.target.value)} placeholder={t('tests.artistId')} />
          <button className="np-pill" disabled={loading} onClick={gArtist}>{t('tests.getArtist')}</button>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>{t('tests.albumId')}</h4>
          <input className="tb-search" value={gAlbumId} onChange={e=>setGAlbumId(e.target.value)} placeholder={t('tests.albumId')} />
          <button className="np-pill" disabled={loading} onClick={gAlbum}>{t('tests.getAlbum')}</button>
        </div>
      </div>

      {/* Spotify Section */}
  <h3 className="mini-title" style={{margin:'28px 0 4px'}}>{t('tests.spotify.api')}</h3>
      <div className="gt-grid">
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>{t('tests.search')}</h4>
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
              <option value="track">{t('tests.tracks')}</option>
              <option value="album">{t('tests.albums')}</option>
              <option value="artist">{t('tests.artists')}</option>
            </select>
            <button className="np-pill" disabled={loading} onClick={sSearch}>{t('tests.search')}</button>
            <button className="np-pill" disabled={loading} onClick={sTokenStatus}>Token Status</button>
          </div>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>{t('tests.trackId','Track ID')}</h4>
          <input className="tb-search" value={sTrackId} onChange={e=>setSTrackId(e.target.value)} placeholder={t('tests.trackId','Track ID')} />
          <button className="np-pill" disabled={loading} onClick={sGetTrack}>{t('tests.getTrack')}</button>
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

      {/* API Cache Test Section */}
      <h3 className="mini-title" style={{margin:'28px 0 4px'}}>API Cache Test</h3>
      <ApiCacheTest />

      {/* Add to Playlist Demo Section */}
      <h3 className="mini-title" style={{margin:'28px 0 4px'}}>Add to Playlist Modal Demo</h3>
      <AddToPlaylistDemo />

      {/* Torrent Search Test Section */}
      <h3 className="mini-title" style={{margin:'28px 0 4px'}}>Torrent Search</h3>
      <div className="gt-grid">
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Query</h4>
          <input className="tb-search" value={tQuery} onChange={e=>setTQuery(e.target.value)} placeholder="Search torrents" />
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Provider</h4>
          <select className="tb-search" value={tProvider} onChange={e=>setTProvider(e.target.value)}>
            <option value="all">All</option>
            {scrapers.map(s=> (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
        </div>
        <div className="gt-block">
          <h4 className="mini-title" style={{marginTop:0}}>Page</h4>
          <input className="tb-search" type="number" value={tPage} onChange={e=>setTPage(Number(e.target.value))} min={1} />
        </div>
        <div className="gt-block">
          <div style={{display:'flex', gap:8, alignItems:'center'}}>
            <button className="np-pill" disabled={loading || !tQuery.trim()} onClick={runTorrentSearch}>Search</button>
            <button className="np-pill" onClick={()=>{ setTResults([]); }}>{'Clear'}</button>
          </div>
        </div>
      </div>

      <div style={{marginTop:12}}>
        {tResults.length===0 && <p className="np-hint">No torrent results</p>}
        {tResults.map((r, idx)=>(
          <div key={idx} style={{display:'flex', justifyContent:'space-between', gap:12, alignItems:'center', padding:'8px 10px', borderRadius:8, background:'var(--surface-1)', border:'1px solid var(--border-subtle)', marginBottom:8}}>
            <div style={{minWidth:0}}>
              <div style={{fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{r.title}</div>
              <div style={{fontSize:12, opacity:.75}}>{r.size || ''} · {r.seeders ?? 0}▲ · {r.leechers ?? 0}▼ · {r.source}</div>
            </div>
            <div style={{display:'flex', gap:8}}>
              {r.magnetURI && <button className="btn" onClick={()=> window.open(r.magnetURI, '_blank')}>Magnet</button>}
              {r.url && <button className="btn" onClick={()=> window.open(r.url, '_blank')}>Detail</button>}
            </div>
          </div>
        ))}
      </div>

    </section>
  );
}
