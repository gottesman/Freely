import React from 'react';
import { useDB } from './db';
import type { SpotifyArtist } from './spotify';

type StoredArtistRow = { id: string; name: string; data: string; followed_at: number };

// --- Pub/Sub (mirrors playlists implementation) ---
const artistSubscribers = new Set<() => void>();
const LEGACY_EVENT = 'freely:followed-artists-changed';
// Global in-memory cache so multiple hook instances (possibly initialized at different times) stay in sync
let lastKnownArtists: SpotifyArtist[] = [];
function setCache(list: SpotifyArtist[]){
  lastKnownArtists = list;
}
function notifyArtistSubscribers(){
  try { console.log('[artists-debug] notifyArtistSubscribers called, subscribers=', artistSubscribers.size, 'cache length=', lastKnownArtists.length); } catch(_){ }
  artistSubscribers.forEach(fn=>{ try { fn(); } catch(err){ console.warn('[artists-debug] subscriber error', err); } });
  // Also emit legacy window event for any older code still listening. Attach the current cache as detail so legacy listeners can adopt immediately.
  try { window.dispatchEvent(new CustomEvent(LEGACY_EVENT, { detail: { artists: lastKnownArtists } })); } catch(e){ console.warn('[artists-debug] dispatch legacy event failed', e); }
  try { console.log('[artists-debug] notifyArtistSubscribers completed dispatch to', artistSubscribers.size, 'subscribers'); } catch(_){ }
}
// External broadcaster so other modules can force refresh (e.g., after migrations)
export function broadcastFollowedArtistsChanged(){ notifyArtistSubscribers(); }

function ensureTable(db: any){
  if(!db) return;
  try { db.exec?.("CREATE TABLE IF NOT EXISTS followed_artists (id TEXT PRIMARY KEY, name TEXT, data TEXT, followed_at INTEGER)"); } catch(e){ console.warn('ensureTable exec failed', e); }
  try { if(typeof db.run === 'function') db.run?.("CREATE TABLE IF NOT EXISTS followed_artists (id TEXT PRIMARY KEY, name TEXT, data TEXT, followed_at INTEGER)"); } catch(e){ console.warn('ensureTable run failed', e); }
}

async function readAllFromDB(db: any): Promise<SpotifyArtist[]> {
  if(!db) return [];
  ensureTable(db);
  try{
    if(typeof db.exec === 'function'){
      const res = db.exec("SELECT id, name, data, followed_at FROM followed_artists ORDER BY followed_at DESC");
  if(!res || !res[0] || !res[0].values) return [];
      const vals: any[] = res[0].values;
      return vals.map(v => {
        const row: StoredArtistRow = { id: v[0], name: v[1], data: v[2], followed_at: v[3] } as any;
        try { return JSON.parse(row.data) as SpotifyArtist; } catch(_) { return { id: row.id, name: row.name, url:'', genres: [], images: [] } as SpotifyArtist }
      });
    }
    if(typeof db.all === 'function'){
      return await new Promise<SpotifyArtist[]>((resolve) => {
        try{
          db.all('SELECT id, name, data, followed_at FROM followed_artists ORDER BY followed_at DESC', [], (err: any, rows: StoredArtistRow[])=>{
    if(err || !rows) { console.warn('readAllFromDB db.all returned error or no rows', err); return resolve([]); }
    const out = rows.map(r => { try { return JSON.parse(r.data) as SpotifyArtist } catch(e){ console.warn('readAllFromDB parse row.data failed', e); return { id: r.id, name: r.name, url:'', genres: [], images: [] } as SpotifyArtist } });
    resolve(out);
          });
        }catch(e){ resolve([]); }
      });
    }
  }catch(e){ console.warn('readAllFromDB failed', e); }
  return [];
}

async function insertArtistToDB(db: any, artist: SpotifyArtist){
  if(!db) return;
  ensureTable(db);
  const now = Date.now();
  const data = JSON.stringify(artist).replace(/'/g, "''");
  const name = (artist.name || '').replace(/'/g, "''");
  try{
    if(typeof db.run === 'function'){
      // sqlite3 style
      await new Promise<void>((resolve)=>{
        try{ db.run('INSERT OR REPLACE INTO followed_artists(id,name,data,followed_at) VALUES(?,?,?,?)', [artist.id, artist.name||'', JSON.stringify(artist), now], ()=>{ resolve(); }); }catch(e){ console.warn('insertArtistToDB run path failed', e); resolve(); }
      });
      return;
    }
    if(typeof db.exec === 'function'){
      try{ db.exec(`INSERT OR REPLACE INTO followed_artists(id,name,data,followed_at) VALUES ('${artist.id.replace(/'/g,"''")}','${name}','${data}',${now})`); }catch(e){ console.warn('insertArtistToDB exec path failed', e); }
      return;
    }
  }catch(e){ console.warn('insertArtistToDB error', e); }
}

async function removeArtistFromDB(db: any, id: string){
  if(!db) return;
  ensureTable(db);
  try{
    try { console.log('[artists-debug] removeArtistFromDB called id=', id); } catch(_){}
    if(typeof db.run === 'function'){
      await new Promise<void>((resolve)=>{ try{ db.run('DELETE FROM followed_artists WHERE id=?', [id], ()=>{ resolve(); }); }catch(e){ console.warn('removeArtistFromDB run path failed', e); resolve(); } });
      try { console.log('[artists-debug] removeArtistFromDB run path completed for id=', id); } catch(_){}
      return;
    }
    if(typeof db.exec === 'function'){
      try{ db.exec(`DELETE FROM followed_artists WHERE id='${id.replace(/'/g,"''")}'`); try { console.log('[artists-debug] removeArtistFromDB exec path completed for id=', id); } catch(_){} }catch(e){ console.warn('removeArtistFromDB exec path failed', e); }
      return;
    }
  }catch(e){ console.warn('removeArtistFromDB error', e); }
}

export function useFollowedArtists(){
  const { db, ready } = useDB();
  const [artists, setArtists] = React.useState<SpotifyArtist[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string|undefined>();
  // Keep a ref of optimistic (pending) adds/removes to reconcile
  const pendingAddsRef = React.useRef<SpotifyArtist[]>([]);
  const pendingRemovalsRef = React.useRef<Set<string>>(new Set());

  // Add hook instance logging
  React.useEffect(()=>{
    console.log('[artists-debug] useFollowedArtists hook instance created');
  }, []);

  const refresh = React.useCallback(async ()=>{
    if(!db) return;
    setLoading(true); setError(undefined);
    try {
      const list = await readAllFromDB(db);
      // Reconcile pending operations: remove any that were pending removal; ensure optimistic adds present if still not in list
      const removalIds = pendingRemovalsRef.current;
      let base = list.filter(a=> !removalIds.has(a.id));
  if(pendingAddsRef.current.length){
        for(const a of pendingAddsRef.current){
          if(!base.some(b=> b.id===a.id)) base = [a, ...base]; // maintain roughly newest-first
        }
        // Drop any optimistic adds now confirmed (present in DB list)
        pendingAddsRef.current = pendingAddsRef.current.filter(a=> !list.some(l=> l.id===a.id));
      }
      // If DB now reflects removals, clear them
      for(const id of Array.from(removalIds)){
        if(!list.some(l=> l.id===id)) removalIds.delete(id);
      }
      setArtists(base);
  setCache(base);
    } catch(e:any){ setError(e.message||String(e)); }
    finally { setLoading(false); }
  }, [db]);

  React.useEffect(()=>{ if(ready) refresh(); }, [ready, refresh]);

  // Subscribe to pub/sub (playlist-style)
  React.useEffect(()=>{
    const listener = () => { 
      try { 
        console.log('[artists-debug] artist subscriber listener invoked, cached=', lastKnownArtists.length);
        // Update from cache but reconcile with our own pending operations
        const removalIds = pendingRemovalsRef.current;
        let base = lastKnownArtists.filter(a => !removalIds.has(a.id));
        
        // Add any optimistic adds that aren't in the cache yet
        if(pendingAddsRef.current.length){
          for(const a of pendingAddsRef.current){
            if(!base.some(b => b.id === a.id)) {
              base = [a, ...base]; // maintain roughly newest-first
            }
          }
        }
        
        setArtists(base);
      } catch(err){
        console.warn('[artists-debug] artist subscriber listener failed', err); 
      } 
    };
    artistSubscribers.add(listener);
    return () => { artistSubscribers.delete(listener); };
  }, []); // Remove refresh from dependencies to avoid recreating listener

  const followArtist = React.useCallback(async (artist: SpotifyArtist) => {
    console.log('[artists-debug] followArtist called', artist?.id, 'db ready=', !!db, 'current cache length=', lastKnownArtists.length);
    // Optimistic add if not already present in the global cache
    if(artist && !lastKnownArtists.some(a=> a.id === artist.id)){
      pendingAddsRef.current.push(artist);
      const existing = lastKnownArtists.filter(a=> a.id !== artist.id);
      const next = [artist, ...existing];
      
      // Update cache first, then state
      setCache(next);
      setArtists(next);
      
      console.log('[artists-debug] followArtist local state updated, next=', next.length);
    } else {
      console.log('[artists-debug] followArtist skipped - artist already in cache or invalid artist');
    }
    
    // Always notify subscribers for immediate UI updates across components
    notifyArtistSubscribers();
    
    if(!db){
      // Still notify so other hook instances optimistically reflect
      try { console.log('[artists-debug] followArtist: no db -> returning after notification'); } catch(_){}
      return;
    }
    try { await insertArtistToDB(db, artist); } catch(e){ console.warn('followArtist insert failed', e); }
    finally { 
      try { 
        console.log('[artists-debug] followArtist: DB path finished -> notifyArtistSubscribers again'); 
        notifyArtistSubscribers(); 
      } catch(_){}
    }
  }, [db, artists]);

  const unfollowArtist = React.useCallback(async (id: string) => {
    console.log('[artists-debug] unfollowArtist called', id, 'db ready=', !!db, 'current cache length=', lastKnownArtists.length);
    // Optimistic removal
    if(!pendingRemovalsRef.current.has(id)) pendingRemovalsRef.current.add(id);
    
    const next = lastKnownArtists.filter(a => a.id !== id);
    // Update global cache first, then state
    setCache(next);
    setArtists(next);
    
    console.log('[artists-debug] unfollowArtist local state updated, next=', next.length);
    
    // Always notify subscribers for immediate UI updates across components
    notifyArtistSubscribers();
    
    if(!db){
      try { console.log('[artists-debug] unfollowArtist: no db -> returning after notification'); } catch(_){}
      return;
    }
    try { await removeArtistFromDB(db, id); } catch(e){ console.warn('unfollowArtist remove failed', e); }
    try { console.log('[artists-debug] unfollowArtist: after removeArtistFromDB await for id=', id); } catch(_){}
    finally { 
      try { 
        console.log('[artists-debug] unfollowArtist: DB path finished -> notifyArtistSubscribers again'); 
        notifyArtistSubscribers(); 
      } catch(_){}
    }
  }, [db]);
  

  const isFollowing = React.useCallback((id?: string) => {
    if(!id) return false;
    return artists.some(a=> a.id === id);
  }, [artists]);

  return { artists, loading, error, refresh, followArtist, unfollowArtist, isFollowing };
}

export default useFollowedArtists;
