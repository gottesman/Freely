import React from 'react';
import { useDB } from './dbIndexed'; // Using the new provider

// --- Pub/Sub Logic (Unchanged) ---
const playlistSubscribers = new Set<() => void>();
function notifyPlaylistSubscribers(){
  try { console.log('[playlists-debug] notify subscribers count=', playlistSubscribers.size); } catch(_) {}
  playlistSubscribers.forEach(fn => { try { fn(); } catch(err) { console.warn('[playlists-debug] subscriber error', err); } });
}
export function broadcastPlaylistsChanged(){
  notifyPlaylistSubscribers();
}

// --- Interfaces (Unchanged) ---
export interface PlaylistRecord {
  id: number;
  name: string;
  code?: string;
  system?: number;
  artist_id?: string | null;
  tags: string[];
  created_at?: number;
  track_count?: number;
}
type PlaylistItemRecord = {
  playlist_id: number;
  track_id: string;
  title: string;
  added_at: number;
  track_data: string; // JSON string of the full track object
};

function normalizeTags(raw?: string): string[] {
  if(!raw) return [];
  return raw.split(',').map(t=>t.trim()).filter(Boolean);
}

// --- The React Hook ---
export function usePlaylists(){
  const { db, ready } = useDB();
  const [playlists, setPlaylists] = React.useState<PlaylistRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string|undefined>();
  const pendingRef = React.useRef<PlaylistRecord[]>([]);

  const refresh = React.useCallback(async () => {
    if(!db) return;
    try {
      console.log('[playlists-debug] refresh() start');
      setLoading(true); setError(undefined);

      // In IndexedDB, this SELECT with a subquery becomes two separate queries.
      const tx = db.transaction(['playlists', 'playlist_items'], 'readonly');
      const playlistsStore = tx.objectStore('playlists');
      const itemsStore = tx.objectStore('playlist_items');
      const itemsIndex = itemsStore.index('playlist_id');

      // 1. Fetch all playlists
      const fetchedPlaylists = await new Promise<PlaylistRecord[]>((resolve, reject) => {
        const req = playlistsStore.getAll();
        req.onsuccess = () => resolve(req.result.map(r => ({ ...r, tags: normalizeTags(r.tags) })));
        req.onerror = () => reject(req.error);
      });

      // 2. Fetch track counts for each playlist in parallel
      const counts = await Promise.all(
        fetchedPlaylists.map(p => new Promise<number>((resolve, reject) => {
          const countReq = itemsIndex.count(p.id);
          countReq.onsuccess = () => resolve(countReq.result);
          countReq.onerror = () => reject(countReq.error);
        }))
      );

      // 3. Combine playlists with their track counts
      let fetched: PlaylistRecord[] = fetchedPlaylists.map((p, i) => ({
        ...p,
        track_count: counts[i]
      })).sort((a, b) => {
        if (a.system && !b.system) return -1;
        if (!a.system && b.system) return 1;
        return a.name.localeCompare(b.name);
      });
      
      console.log('[playlists-debug] refresh() fetched rows=', fetched.length, fetched.map(f=>({id:f.id,name:f.name,code:f.code,tracks:f.track_count})));

      // Reconciliation logic for optimistic updates remains the same
      if(pendingRef.current.length){
        pendingRef.current = pendingRef.current.filter(p=> !fetched.some(f=> f.id===p.id || (f.name===p.name && f.created_at===p.created_at)));
      }
      const merged = [...fetched, ...pendingRef.current];

      console.log('[playlists-debug] refresh() merged list size=', merged.length, merged.map(m=>({id:m.id,name:m.name,temp:m.id<0})));
      setPlaylists(merged);
      console.log('[playlists-debug] refresh() end');
    } catch(e:any){ setError(e.message||String(e)); }
    finally { setLoading(false); }
  }, [db]);

  React.useEffect(()=>{ if(ready) refresh(); }, [ready, refresh]);

  React.useEffect(()=>{
    const listener = () => { refresh() };
    playlistSubscribers.add(listener);
    return () => { playlistSubscribers.delete(listener); };
  }, [refresh]);

  const createPlaylist = React.useCallback(async (name: string, tags: string[] = [], opts?: { artistId?: string; code?: string; system?: boolean }): Promise<number|undefined> => {
    if(!db) return undefined;
    console.log('[playlists-debug] createPlaylist called name=', name);
    const created = Date.now();

    const optimisticPlaylist: PlaylistRecord = {
      id: -Date.now(), name, tags, artist_id: opts?.artistId,
      code: opts?.code, system: opts?.system ? 1 : 0, created_at: created, track_count: 0,
    };
    pendingRef.current.push(optimisticPlaylist);
    setPlaylists(current => [...current, optimisticPlaylist]);

    let newId: number | undefined;
    try {
      const tx = db.transaction('playlists', 'readwrite');
      const store = tx.objectStore('playlists');
      const newPlaylistRecord = {
        name, tags: tags.join(','), created_at: created,
        artist_id: opts?.artistId || null, code: opts?.code || null,
        system: opts?.system ? 1 : 0
      };
      
      newId = await new Promise<number>((resolve, reject) => {
        // `add` with an auto-incrementing key returns the new key on success.
        const req = store.add(newPlaylistRecord);
        req.onsuccess = () => resolve(req.result as number);
        req.onerror = () => reject(req.error);
      });
      console.log('[playlists-debug] createPlaylist insert complete newId=', newId);
    } catch(e){ console.warn('createPlaylist outer error', e); }
    finally {
      refresh();
      notifyPlaylistSubscribers();
    }
    return newId;
  }, [db, refresh]);

  const updatePlaylist = React.useCallback(async (id: number, patch: { name?: string; tags?: string[] }) => {
    if(!db) return;
    const p = playlists.find(pl => pl.id === id);
    if(p?.system && patch.name) delete patch.name;
    if (!patch.name && !patch.tags) return;
    
    try {
      const tx = db.transaction('playlists', 'readwrite');
      const store = tx.objectStore('playlists');
      const record = await new Promise<any>((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      if (record) {
        if(patch.name !== undefined) record.name = patch.name;
        if(patch.tags !== undefined) record.tags = patch.tags.join(',');
        await new Promise<void>((resolve, reject) => {
          const req = store.put(record);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      }
      refresh();
      notifyPlaylistSubscribers();
    } catch(e){ console.warn('updatePlaylist failed', e); }
  }, [db, refresh, playlists]);

  const deletePlaylist = React.useCallback(async (id: number) => {
    if(!db) return;
    const p = playlists.find(pl => pl.id === id);
    if(p?.system) return;

    try {
      const tx = db.transaction(['playlists', 'playlist_items'], 'readwrite');
      const playlistsStore = tx.objectStore('playlists');
      const itemsStore = tx.objectStore('playlist_items');
      const itemsIndex = itemsStore.index('playlist_id');

      // 1. Delete the playlist record itself
      playlistsStore.delete(id);

      // 2. Delete all associated tracks
      const cursorReq = itemsIndex.openKeyCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          itemsStore.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });

      refresh();
      notifyPlaylistSubscribers();
    } catch(e){ console.warn('deletePlaylist failed', e); }
  }, [db, refresh, playlists]);

  const addTracks = React.useCallback(async (playlistId: number, trackData: any[]) => {
    if(!db || !trackData.length) return;
    
    try {
      const tx = db.transaction('playlist_items', 'readwrite');
      const store = tx.objectStore('playlist_items');
      const now = Date.now();

      for (const item of trackData) {
        const isObject = typeof item === 'object' && item?.id;
        const record: Omit<PlaylistItemRecord, 'id'> = {
          playlist_id: playlistId,
          track_id: isObject ? item.id : item,
          title: isObject ? (item.name || '') : '',
          added_at: now,
          track_data: isObject ? JSON.stringify(item) : '',
        };
        store.add(record);
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      refresh();
      notifyPlaylistSubscribers();
    } catch(e){ 
      console.warn('addTracks error:', e); 
      throw e;
    }
  }, [db, refresh]);

  const createPlaylistWithTracks = React.useCallback(async (name: string, tracks: any[], tags: string[] = [], opts?: { artistId?: string; code?: string; system?: boolean }): Promise<number|undefined> => {
    if(!db) return undefined;

    let newId: number | undefined;
    try {
      const tx = db.transaction(['playlists', 'playlist_items'], 'readwrite');
      const playlistsStore = tx.objectStore('playlists');
      const itemsStore = tx.objectStore('playlist_items');

      // 1. Create the playlist and get its new ID
      newId = await new Promise<number>((resolve, reject) => {
        const newPlaylistRecord = {
          name, tags: tags.join(','), created_at: Date.now(),
          artist_id: opts?.artistId || null, code: opts?.code || null,
          system: opts?.system ? 1 : 0
        };
        const req = playlistsStore.add(newPlaylistRecord);
        req.onsuccess = () => resolve(req.result as number);
        req.onerror = reject;
      });

      // 2. Add all tracks using the new ID
      if (newId && tracks.length) {
        const now = Date.now();
        for (const track of tracks) {
          if(!track?.id) continue;
          itemsStore.add({
            playlist_id: newId, track_id: track.id, title: track.name || '',
            added_at: now, track_data: JSON.stringify(track)
          });
        }
      }
    } catch(e){ 
      console.error('createPlaylistWithTracks outer error', e); 
    }
    finally {
      refresh();
      notifyPlaylistSubscribers();
    }
    return newId;
  }, [db, refresh]);

  const removeTrack = React.useCallback(async (playlistId: number, trackId: string) => {
    if(!db) return;
    try {
      const tx = db.transaction('playlist_items', 'readwrite');
      const store = tx.objectStore('playlist_items');
      const index = store.index('playlist_id');

      // Find the primary key of the item to delete
      const keyToDelete = await new Promise<IDBValidKey | undefined>((resolve, reject) => {
        const cursorReq = index.openCursor(IDBKeyRange.only(playlistId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            if (cursor.value.track_id === trackId) {
              resolve(cursor.primaryKey);
              return; // Found it, stop iterating
            }
            cursor.continue();
          } else {
            resolve(undefined); // Not found
          }
        };
        cursorReq.onerror = reject;
      });

      if (keyToDelete !== undefined) {
        store.delete(keyToDelete);
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = reject;
        });
        refresh();
        notifyPlaylistSubscribers();
      } else {
        console.warn('removeTrack: track not found in playlist.');
      }
    } catch(e){ 
      console.error('removeTrack failed:', e); 
      throw e;
    }
  }, [db, refresh]);

  // !! BREAKING CHANGE: These methods are now ASYNCHRONOUS and return a Promise !!
  const getPlaylistTracks = React.useCallback(async (playlistId: number): Promise<any[]> => {
    if(!db) return [];
    try {
      const tx = db.transaction('playlist_items', 'readonly');
      const store = tx.objectStore('playlist_items');
      const index = store.index('playlist_id');
      const items = await new Promise<PlaylistItemRecord[]>((resolve, reject) => {
        const req = index.getAll(playlistId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = reject;
      });
      
      return items.sort((a,b) => a.added_at - b.added_at)
        .map(item => {
          try {
            return item.track_data ? JSON.parse(item.track_data) : { id: item.track_id };
          } catch {
            return { id: item.track_id };
          }
        });
    } catch(e) {
      console.warn('getPlaylistTracks failed:', e);
      return [];
    }
  }, [db]);

  const getPlaylistTrackIds = React.useCallback(async (playlistId: number): Promise<string[]> => {
    const tracks = await getPlaylistTracks(playlistId);
    return tracks.map(t => t.id).filter(Boolean);
  }, [getPlaylistTracks]);

  return { playlists, loading, error, refresh, createPlaylist, createPlaylistWithTracks, updatePlaylist, deletePlaylist, addTracks, removeTrack, getPlaylistTracks, getPlaylistTrackIds };
}