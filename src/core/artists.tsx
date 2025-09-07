import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDB } from './dbIndexed';
import type { SpotifyArtist } from './spotify';

// Types for better performance and maintainability
type StoredArtistRow = { 
  id: string; 
  name: string; 
  data: string; 
  followed_at: number; 
};

// Constants
const LEGACY_EVENT = 'freely:followed-artists-changed';
const DEBUG_ENABLED = process.env.NODE_ENV === 'development';

// Global state management - simplified
const artistSubscribers = new Set<() => void>();
let globalArtistsCache: SpotifyArtist[] = [];

// Optimized debug logging
const debugLog = (message: string, ...args: any[]) => {
  if (DEBUG_ENABLED) {
    console.log(`[artists] ${message}`, ...args);
  }
};

// Simplified cache management
const updateGlobalCache = (artists: SpotifyArtist[]) => {
  globalArtistsCache = artists;
};

// Consolidated notification system
const notifySubscribers = () => {
  debugLog('Notifying subscribers', { 
    subscriberCount: artistSubscribers.size, 
    cacheLength: globalArtistsCache.length 
  });

  // Notify React subscribers
  artistSubscribers.forEach(fn => {
    try { 
      fn(); 
    } catch (err) { 
      console.warn('[artists] Subscriber error:', err); 
    }
  });

  // Legacy event for backwards compatibility
  try { 
    window.dispatchEvent(new CustomEvent(LEGACY_EVENT, { 
      detail: { artists: globalArtistsCache } 
    })); 
  } catch (err) { 
    console.warn('[artists] Legacy event dispatch failed:', err); 
  }
};

// Public API for external components
export const broadcastFollowedArtistsChanged = () => notifySubscribers();

// Database operations - optimized and simplified
class ArtistDB {
  /**
   * Reads all artists from IndexedDB, sorted by followed_at descending.
   */
  static async readAll(db: IDBDatabase): Promise<SpotifyArtist[]> {
    if (!db) return [];
    
    return new Promise((resolve, reject) => {
      const artists: SpotifyArtist[] = [];
      const tx = db.transaction('followed_artists', 'readonly');
      const store = tx.objectStore('followed_artists');
      const index = store.index('followed_at');
      const cursorRequest = index.openCursor(null, 'prev');

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const row = cursor.value as StoredArtistRow;
          try {
            artists.push(JSON.parse(row.data));
          } catch {
            // Fallback for corrupted data
            artists.push({
              id: row.id,
              name: row.name,
              url: '',
              genres: [],
              images: []
            } as SpotifyArtist);
          }
          cursor.continue();
        } else {
          resolve(artists);
        }
      };

      cursorRequest.onerror = () => {
        console.warn('[artists] Failed to read from DB:', cursorRequest.error);
        reject(cursorRequest.error);
      };
    });
  }

  /**
   * Inserts or updates an artist in IndexedDB.
   */
  static async insert(db: IDBDatabase, artist: SpotifyArtist): Promise<void> {
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
        console.warn('[artists] Failed to insert artist:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Removes an artist from IndexedDB by their ID.
   */
  static async remove(db: IDBDatabase, id: string): Promise<void> {
    if (!db) return;
    
    return new Promise((resolve, reject) => {
      const tx = db.transaction('followed_artists', 'readwrite');
      const store = tx.objectStore('followed_artists');
      const request = store.delete(id);
      
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.warn('[artists] Failed to remove artist:', request.error);
        reject(request.error);
      };
    });
  }
}

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
      const list = await ArtistDB.readAll(db);

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
      updateGlobalCache(base);
    } catch(e:any){ setError(e.message||String(e)); }
    finally { setLoading(false); }
  }, [db]);

  React.useEffect(()=>{ if(ready) refresh(); }, [ready, refresh]);

  React.useEffect(()=>{
    const listener = () => { 
      try { 
        console.log('[artists-debug] artist subscriber listener invoked, cached=', globalArtistsCache.length);
        const removalIds = pendingRemovalsRef.current;
        let base = globalArtistsCache.filter(a => !removalIds.has(a.id));
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
    console.log('[artists-debug] followArtist called', artist?.id, 'db ready=', !!db, 'current cache length=', globalArtistsCache.length);
    if(artist && !globalArtistsCache.some(a=> a.id === artist.id)){
      pendingAddsRef.current.push(artist);
      const next = [artist, ...globalArtistsCache.filter(a=> a.id !== artist.id)];
      updateGlobalCache(next);
      setArtists(next);
      console.log('[artists-debug] followArtist local state updated, next=', next.length);
    } else {
      console.log('[artists-debug] followArtist skipped - artist already in cache or invalid artist');
    }
    
    notifySubscribers();
    
    if(!db){
      try { console.log('[artists-debug] followArtist: no db -> returning after notification'); } catch(_){}
      return;
    }
    try { 
      // Calls the new IndexedDB-specific function
      await ArtistDB.insert(db, artist); 
    } catch(e){ 
      console.warn('followArtist insert failed', e); 
    }
    finally { 
      try { 
        console.log('[artists-debug] followArtist: DB path finished -> notifySubscribers again'); 
        notifySubscribers(); 
      } catch(_){}
    }
  }, [db]);

  const unfollowArtist = React.useCallback(async (id: string) => {
    console.log('[artists-debug] unfollowArtist called', id, 'db ready=', !!db, 'current cache length=', globalArtistsCache.length);
    pendingRemovalsRef.current.add(id);
    const next = globalArtistsCache.filter(a => a.id !== id);
    updateGlobalCache(next);
    setArtists(next);
    console.log('[artists-debug] unfollowArtist local state updated, next=', next.length);
    
    notifySubscribers();
    
    if(!db){
      try { console.log('[artists-debug] unfollowArtist: no db -> returning after notification'); } catch(_){}
      return;
    }
    try { 
      // Calls the new IndexedDB-specific function
      await ArtistDB.remove(db, id); 
    } catch(e){ 
      console.warn('unfollowArtist remove failed', e); 
    }
    try { console.log('[artists-debug] unfollowArtist: after removeArtistFromDB await for id=', id); } catch(_){}
    finally { 
      try { 
        console.log('[artists-debug] unfollowArtist: DB path finished -> notifySubscribers again'); 
        notifySubscribers(); 
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