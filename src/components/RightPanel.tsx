import React, { useEffect, useState } from 'react'
import { usePlayback } from '../core/playback'
import type { SpotifyAlbum, SpotifyPlaylist } from '../core/spotify'
import SpotifyClient from '../core/spotify'
import { useAlerts } from '../core/alerts'

interface ArtistBuckets {
  singles: SpotifyAlbum[];
  albums: SpotifyAlbum[];
  playlists: SpotifyPlaylist[];
  loading: boolean;
  error?: string;
  fetched?: boolean; // true once a load attempt finished (success or error)
}

export default function RightPanel({ collapsed, onToggle, width, activeRightTab, onRightTabChange }: { collapsed: boolean, onToggle: () => void, width?: number, activeRightTab?: string, onRightTabChange?: (t: string)=>void }){
  const [internalTab, setInternalTab] = useState('artist');
  const tab = activeRightTab || internalTab;
  const setTab = (t: string) => { if(onRightTabChange) onRightTabChange(t); if(!activeRightTab) setInternalTab(t); };
  const { currentTrack } = usePlayback();
  const [buckets, setBuckets] = useState<ArtistBuckets>({ singles: [], albums: [], playlists: [], loading: false, fetched: false });
  const primaryArtistId = currentTrack?.artists?.[0]?.id;
  // Defer artist id we actually use for fetching to ensure playback track fully resolved
  const [deferredArtistId, setDeferredArtistId] = useState<string | undefined>(undefined);
  const { push: pushAlert, alerts } = useAlerts();

  useEffect(()=>{
    // When track changes, clear existing data (optimistically) and start a timer to set deferred id
    let t: any;
    if(primaryArtistId){
  // Reset buckets and show loading immediately; defer a short time to let track metadata settle
  setBuckets({ singles:[], albums:[], playlists:[], loading:true, fetched:false });
  t = setTimeout(()=> setDeferredArtistId(primaryArtistId), 250); // shorter defer to reduce missed loads
    } else {
      setDeferredArtistId(undefined);
  setBuckets({ singles:[], albums:[], playlists:[], loading:false, fetched:false });
    }
    return ()=> { if(t) clearTimeout(t); };
  }, [primaryArtistId, currentTrack?.id]);

  useEffect(()=>{
    let cancelled = false;
    async function load(){
      if(!deferredArtistId){ return; }
      const w:any = window;
      setBuckets(b => ({ ...b, loading: true, error: undefined, fetched:false }));
      try {
        let albumsResp: any;
        if(w.electron?.spotify?.getArtistAlbums){
          albumsResp = await w.electron.spotify.getArtistAlbums(deferredArtistId, { includeGroups: 'album,single', fetchAll: false, limit: 20 });
        } else {
          // Fallback to local client (will need env creds)
          try {
            const client = new SpotifyClient();
            albumsResp = await client.getArtistAlbums(deferredArtistId, { includeGroups: 'album,single', fetchAll: false, limit: 20 });
          } catch(e){ /* fallback failed */ }
        }
        if(!albumsResp){ throw new Error('Artist albums unavailable'); }
        // Normalize album_type -> albumType and then bucket
        const rawAlbums: any[] = albumsResp.items || [];
        const normAlbums: SpotifyAlbum[] = rawAlbums.map(a => {
          const albumType = (a as any).albumType || (a as any).album_type; // support raw + mapped
          return { ...a, albumType } as SpotifyAlbum;
        });
        // Filter BEFORE slicing so we don't lose singles if they appear later in the first page
        const singlesAll = normAlbums.filter(a=> a.albumType === 'single');
        const albumsAll = normAlbums.filter(a=> a.albumType !== 'single');
        const singles = singlesAll.slice(0,6);
        const realAlbums = albumsAll.slice(0,6);
        // Basic playlist discovery: search artist name + " official" (placeholder heuristic)
        let playlists: SpotifyPlaylist[] = [];
        if(w.electron?.spotify?.searchPlaylists && currentTrack?.artists?.[0]?.name){
          try {
            const pl = await w.electron.spotify.searchPlaylists(currentTrack.artists[0].name);
            const plItems = (pl.items || pl.playlists?.items || []);
            playlists = plItems.slice(0,6);
          } catch(err){ /* ignore but surface in debug */ console.warn('Playlist proxy search failed', err); }
        } else if(currentTrack?.artists?.[0]?.name){
          // fallback playlist search via local client (approx by searching artist name)
          try {
            const client = new SpotifyClient();
            const pl = await client.searchPlaylists(currentTrack.artists[0].name);
            const plItems = (pl.items || (pl as any).playlists?.items || []);
            playlists = plItems.slice(0,6) as any;
          } catch(err){ console.warn('Playlist local search failed', err); }
        }
        if(cancelled) return;
        setBuckets({ singles, albums: realAlbums, playlists, loading:false, fetched:true });
      } catch(e:any){
        if(!cancelled){
          const msg = e?.message || 'Failed to load artist releases';
          setBuckets({ singles:[], albums:[], playlists:[], loading:false, fetched:true, error: msg });
          if(!alerts.some(a=>a.msg === msg)) pushAlert(msg, 'error');
          console.warn('Artist releases load error', e);
        }
      }
    }
    load();
    return ()=> { cancelled = true; };
  }, [deferredArtistId]);

  function listSection(title: string, kind: keyof ArtistBuckets){
    if(kind==='loading' || kind==='error') return null;
    const arr = buckets[kind] as (SpotifyAlbum|SpotifyPlaylist)[];
    if(!arr.length) return null;
    return (
      <div className="artist-shelf">
        <h5 className="shelf-title">{title}</h5>
        <ul className="shelf-cards" role="list">
          {arr.map(item => (
            <li key={item.id} className="shelf-card" title={item.name}>
              <button type="button" className="card-btn">
                <div className="card-img-wrap"><img src={(item as any).images?.[0]?.url || '/icon-192.png'} alt={item.name} loading="lazy" /></div>
                <div className="card-meta">
                  <div className="card-name">{item.name}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <aside className={`main-panels right-panel ${collapsed ? 'collapsed' : ''}`} style={!collapsed && width ? { width } : undefined}>
      <div className="panel-collapse-toggle right-panel-toggle" onClick={onToggle}>{collapsed ? '◀' : '▶'}</div>
      <div className="right-tabs">
        <div className="right-tabs-body">
          {tab === 'artist' && (
            <div className="rt-panel" role="tabpanel" aria-label="Artist suggestions">
              <div className="rt-header">
                <h4 className="rt-title">More from</h4>
                <div className="rt-subheading">
                  <span className="rt-artist-name">{currentTrack?.artists?.[0]?.name || 'Artist'}</span>
                </div>
              </div>
              {buckets.loading && <div className="rt-placeholder">Loading artist releases…</div>}
              {/* Error moved to global alerts system */}
              {buckets.fetched && !buckets.loading && !buckets.error && !buckets.albums.length && !buckets.singles.length && <div className="rt-placeholder">No releases found.</div>}
              {listSection('Singles', 'singles')}
              {listSection('Albums', 'albums')}
              {listSection('Playlists', 'playlists')}
            </div>
          )}
          {tab === 'queue' && (
            <div className="rt-panel" role="tabpanel">
              <div className="rt-placeholder">(Current play queue)</div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}