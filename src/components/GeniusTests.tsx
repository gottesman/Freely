import React, { useState } from 'react';
import GeniusClient, { SongDetails } from '../core/musicdata';

function useGenius() {
  const proxy = (window as any)?.electron?.genius;
  const direct = new GeniusClient();
  return { proxy, direct };
}

type LogEntry = { ts:number; label:string; data:any };

export default function GeniusTests(){
  const { proxy, direct } = useGenius();
  const [query, setQuery] = useState('Bohemian Rhapsody');
  const [songId, setSongId] = useState('');
  const [artistId, setArtistId] = useState('');
  const [albumId, setAlbumId] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  function append(label:string, data:any){
    setLog(l => [{ ts:Date.now(), label, data }, ...l.slice(0,199)]);
  }

  async function runSearch(){
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = proxy?.search ? await proxy.search(query) : await direct.search(query);
      append('search', res);
      if (res?.hits?.[0]) setSongId(String(res.hits[0].id));
    } catch(e){ append('search:error', String(e)); }
    finally { setLoading(false); }
  }

  async function runGetSong(){
    if (!songId) return; setLoading(true);
    try {
      const id = Number(songId);
      const w = window as any;
      const res: SongDetails = w?.electron?.genius?.getSong ? await w.electron.genius.getSong(id) : await direct.getSong(id);
      append('getSong', res);
    } catch(e){ append('getSong:error', String(e)); }
    finally { setLoading(false); }
  }

  async function runLyrics(){
    if (!songId) return; setLoading(true);
    try {
      const id = Number(songId);
      const w = window as any;
      const lyr = w?.electron?.genius?.getLyrics ? await w.electron.genius.getLyrics(id) : await direct.getLyricsForSong(id);
      append('lyrics', lyr);
    } catch(e){ append('lyrics:error', String(e)); }
    finally { setLoading(false); }
  }

  async function runArtist(){
    if (!artistId) return; setLoading(true);
    try {
      const w = window as any;
      const data = w?.electron?.genius?.getArtist ? await w.electron.genius.getArtist(Number(artistId)) : await direct.getArtist(Number(artistId));
      append('artist', data);
    } catch(e){ append('artist:error', String(e)); } finally { setLoading(false); }
  }

  async function runAlbum(){
    if (!albumId) return; setLoading(true);
    try {
      const w = window as any;
      const data = w?.electron?.genius?.getAlbum ? await w.electron.genius.getAlbum(Number(albumId)) : await direct.getAlbum(Number(albumId));
      append('album', data);
    } catch(e){ append('album:error', String(e)); } finally { setLoading(false); }
  }

  return (
    <section className="genius-tests" aria-label="Genius API test harness">
      <h2 className="np-sec-title" style={{marginTop:0}}>Genius API Tests</h2>
      <div className="gt-grid">
        <div className="gt-block">
          <h3 className="mini-title">Search</h3>
          <input className="tb-search" placeholder="Song or query" value={query} onChange={e=>setQuery(e.target.value)} />
          <button className="np-pill" disabled={loading} onClick={runSearch}>Search</button>
        </div>
        <div className="gt-block">
          <h3 className="mini-title">Song (ID)</h3>
          <input className="tb-search" placeholder="Song ID" value={songId} onChange={e=>setSongId(e.target.value)} />
          <div className="gt-actions">
            <button className="np-pill" disabled={loading} onClick={runGetSong}>Get Song</button>
            <button className="np-pill" disabled={loading} onClick={runLyrics}>Lyrics</button>
          </div>
        </div>
        <div className="gt-block">
          <h3 className="mini-title">Artist (ID)</h3>
          <input className="tb-search" placeholder="Artist ID" value={artistId} onChange={e=>setArtistId(e.target.value)} />
          <button className="np-pill" disabled={loading} onClick={runArtist}>Get Artist</button>
        </div>
        <div className="gt-block">
          <h3 className="mini-title">Album (ID)</h3>
          <input className="tb-search" placeholder="Album ID" value={albumId} onChange={e=>setAlbumId(e.target.value)} />
          <button className="np-pill" disabled={loading} onClick={runAlbum}>Get Album</button>
        </div>
      </div>
      <div className="gt-log" aria-label="Results log">
        {log.length === 0 && <div className="gt-empty">No results yet. Run a test.</div>}
        {log.map(entry => (
          <details key={entry.ts} open>
            <summary><strong>{new Date(entry.ts).toLocaleTimeString()} — {entry.label}</strong></summary>
            <pre className="gt-pre">{JSON.stringify(entry.data, null, 2)}</pre>
          </details>
        ))}
      </div>
    </section>
  );
}
