import React from 'react';
import { useDB } from './dbIndexed'; // Ensure this path is correct
import type { SpotifyArtist } from './spotify';

// The type for the object stored in IndexedDB
type StoredArtistRow = { id: string; name: string; data: string; followed_at: number };

// --- Pub/Sub and global cache (This logic is DB-agnostic and remains unchanged) ---
const artistSubscribers = new Set<() => void>();
const LEGACY_EVENT = 'freely:followed-artists-changed';
let lastKnownArtists: SpotifyArtist[] = [];

function setCache(list: SpotifyArtist[]){
  lastKnownArtists = list;
}

function notifyArtistSubscribers(){
  try { console.log('[artists-debug] notifyArtistSubscribers called, subscribers=', artistSubscribers.size, 'cache length=', lastKnownArtists.length); } catch(_){ }
  artistSubscribers.forEach(fn=>{ try { fn(); } catch(err){ console.warn('[artists-debug] subscriber error', err); } });
  try { window.dispatchEvent(new CustomEvent(LEGACY_EVENT, { detail: { artists: lastKnownArtists } })); } catch(e){ console.warn('[artists-debug] dispatch legacy event failed', e); }
  try { console.log('[artists-debug] notifyArtistSubscribers completed dispatch to', artistSubscribers.size, 'subscribers'); } catch(_){ }
}

export function broadcastFollowedArtistsChanged(){ notifyArtistSubscribers(); }

// --- IndexedDB Helper Functions ---
// NOTE: These functions assume the `DBProvider` has already created the 'followed_artists'
// object store with a `keyPath` of 'id' and an index on 'followed_at'.

/**
 * Reads all artists from IndexedDB, sorted by followed_at descending.
 */
async function readAllFromDB(db: IDBDatabase): Promise<SpotifyArtist[]> {
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const artists: SpotifyArtist[] = [];
    const tx = db.transaction('followed_artists', 'readonly');
    const store = tx.objectStore('followed_artists');
    const index = store.index('followed_at');

    // Open a cursor to iterate in reverse order (newest first)
    const cursorRequest = index.openCursor(null, 'prev');

    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const row = cursor.value as StoredArtistRow;
        try {
          // The full artist object is stored in the 'data' field as a JSON string
          artists.push(JSON.parse(row.data));
        } catch (_) {
          // Fallback for corrupted data
          artists.push({ id: row.id, name: row.name, url:'', genres: [], images: [] } as SpotifyArtist);
        }
        cursor.continue();
      } else {
        // Cursor finished
        resolve(artists);
      }
    };

    cursorRequest.onerror = () => {
      console.warn('readAllFromDB cursor failed', cursorRequest.error);
      reject(cursorRequest.error);
    };
  });
}

/**
 * Inserts or updates an artist in IndexedDB.
 */
async function insertArtistToDB(db: IDBDatabase, artist: SpotifyArtist): Promise<void> {
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('followed_artists', 'readwrite');
    const store = tx.objectStore('followed_artists');
    const record: StoredArtistRow = {
      id: artist.id,
      name: artist.name || '',
      data: JSON.stringify(artist),
      followed_at: Date.now(),
    };
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.warn('insertArtistToDB failed', request.error);
      reject(request.error);
    };
  });
}

/**
 * Removes an artist from IndexedDB by their ID.
 */
async function removeArtistFromDB(db: IDBDatabase, id: string): Promise<void> {
  if (!db) return;
  try { console.log('[artists-debug] removeArtistFromDB called id=', id); } catch(_){}
  return new Promise((resolve, reject) => {
    const tx = db.transaction('followed_artists', 'readwrite');
    const store = tx.objectStore('followed_artists');
    const request = store.delete(id);
    request.onsuccess = () => {
      try { console.log('[artists-debug] removeArtistFromDB DB operation completed for id=', id); } catch(_){}
      resolve();
    };
    request.onerror = () => {
      console.warn('removeArtistFromDB failed', request.error);
      reject(request.error);
    };
  });
}


// --- The React Hook (Largely unchanged logic, just calls new DB functions) ---

export function useFollowedArtists(){
  const { db, ready } = useDB();
  const [artists, setArtists] = React.useState<SpotifyArtist[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string|undefined>();
  const pendingAddsRef = React.useRef<SpotifyArtist[]>([]);
  const pendingRemovalsRef = React.useRef<Set<string>>(new Set());

  React.useEffect(()=>{
    console.log('[artists-debug] useFollowedArtists hook instance created');
  }, []);

  const refresh = React.useCallback(async ()=>{
    // The DB instance from the context must be an IDBDatabase or null
    if(!db) return;
    setLoading(true); setError(undefined);
    try {
      // Calls the new IndexedDB-specific function
      const list = await readAllFromDB(db);

      // Reconciliation logic remains identical
      const removalIds = pendingRemovalsRef.current;
      let base = list.filter(a=> !removalIds.has(a.id));
      if(pendingAddsRef.current.length){
        for(const a of pendingAddsRef.current){
          if(!base.some(b=> b.id===a.id)) base = [a, ...base];
        }
        pendingAddsRef.current = pendingAddsRef.current.filter(a=> !list.some(l=> l.id===a.id));
      }
      for(const id of Array.from(removalIds)){
        if(!list.some(l=> l.id===id)) removalIds.delete(id);
      }
      setArtists(base);
      setCache(base);
    } catch(e:any){ setError(e.message||String(e)); }
    finally { setLoading(false); }
  }, [db]);

  React.useEffect(()=>{ if(ready) refresh(); }, [ready, refresh]);

  React.useEffect(()=>{
    const listener = () => { 
      try { 
        console.log('[artists-debug] artist subscriber listener invoked, cached=', lastKnownArtists.length);
        const removalIds = pendingRemovalsRef.current;
        let base = lastKnownArtists.filter(a => !removalIds.has(a.id));
        if(pendingAddsRef.current.length){
          for(const a of pendingAddsRef.current){
            if(!base.some(b => b.id === a.id)) base = [a, ...base];
          }
        }
        setArtists(base);
      } catch(err){ console.warn('[artists-debug] artist subscriber listener failed', err); } 
    };
    artistSubscribers.add(listener);
    return () => { artistSubscribers.delete(listener); };
  }, []);

  const followArtist = React.useCallback(async (artist: SpotifyArtist) => {
    console.log('[artists-debug] followArtist called', artist?.id, 'db ready=', !!db, 'current cache length=', lastKnownArtists.length);
    if(artist && !lastKnownArtists.some(a=> a.id === artist.id)){
      pendingAddsRef.current.push(artist);
      const next = [artist, ...lastKnownArtists.filter(a=> a.id !== artist.id)];
      setCache(next);
      setArtists(next);
      console.log('[artists-debug] followArtist local state updated, next=', next.length);
    } else {
      console.log('[artists-debug] followArtist skipped - artist already in cache or invalid artist');
    }
    
    notifyArtistSubscribers();
    
    if(!db){
      try { console.log('[artists-debug] followArtist: no db -> returning after notification'); } catch(_){}
      return;
    }
    try { 
      // Calls the new IndexedDB-specific function
      await insertArtistToDB(db, artist); 
    } catch(e){ 
      console.warn('followArtist insert failed', e); 
    }
    finally { 
      try { 
        console.log('[artists-debug] followArtist: DB path finished -> notifyArtistSubscribers again'); 
        notifyArtistSubscribers(); 
      } catch(_){}
    }
  }, [db]);

  const unfollowArtist = React.useCallback(async (id: string) => {
    console.log('[artists-debug] unfollowArtist called', id, 'db ready=', !!db, 'current cache length=', lastKnownArtists.length);
    pendingRemovalsRef.current.add(id);
    const next = lastKnownArtists.filter(a => a.id !== id);
    setCache(next);
    setArtists(next);
    console.log('[artists-debug] unfollowArtist local state updated, next=', next.length);
    
    notifyArtistSubscribers();
    
    if(!db){
      try { console.log('[artists-debug] unfollowArtist: no db -> returning after notification'); } catch(_){}
      return;
    }
    try { 
      // Calls the new IndexedDB-specific function
      await removeArtistFromDB(db, id); 
    } catch(e){ 
      console.warn('unfollowArtist remove failed', e); 
    }
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
    // The artists state is now used, so this automatically updates.
    return artists.some(a=> a.id === id);
  }, [artists]);

  return { artists, loading, error, refresh, followArtist, unfollowArtist, isFollowing };
}

export default useFollowedArtists;