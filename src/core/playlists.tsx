import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { useDB } from './Database'; // Using the new provider

// Performance constants
const SUBSCRIBER_DEBOUNCE_MS = 25;
const NOTIFICATION_DELAY_MS = 20;

// Database operation configurations
const DB_STORES = {
  PLAYLISTS: 'playlists',
  PLAYLIST_ITEMS: 'playlist_items'
} as const;

const DB_INDICES = {
  PLAYLIST_ID: 'playlist_id'
} as const;

const DB_OPERATIONS = {
  READ_ONLY: 'readonly' as IDBTransactionMode,
  READ_WRITE: 'readwrite' as IDBTransactionMode
} as const;

// --- Optimized Pub/Sub Logic ---
const playlistSubscribers = new Set<() => void>();
let notifyScheduled = false;
const subscriberTimers = new Map<() => void, number>();

const scheduleSubscriberCall = (fn: () => void) => {
  if (subscriberTimers.has(fn)) return;
  const id = setTimeout(() => {
    subscriberTimers.delete(fn);
    try { fn(); } catch (err) { console.warn('[playlists-debug] subscriber error', err); }
  }, SUBSCRIBER_DEBOUNCE_MS) as unknown as number;
  subscriberTimers.set(fn, id);
};

const notifyPlaylistSubscribers = () => {
  if (notifyScheduled) return;
  notifyScheduled = true;
  setTimeout(() => {
    notifyScheduled = false;
    //try { console.log('[playlists-debug] notify subscribers count=', playlistSubscribers.size); } catch(_) {}
    playlistSubscribers.forEach(fn => scheduleSubscriberCall(fn));
  }, NOTIFICATION_DELAY_MS);
};

export const broadcastPlaylistsChanged = () => {
  notifyPlaylistSubscribers();
};

// --- Types & Interfaces ---
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

interface PlaylistItemRecord {
  playlist_id: number;
  track_id: string;
  title: string;
  added_at: number;
  track_data: string; // JSON string of the full track object
}

interface PlaylistState {
  playlists: PlaylistRecord[];
  loading: boolean;
  error?: string;
}

// --- Database Operation Helpers ---
class DatabaseOperations {
  static async executeQuery<T>(
    store: IDBObjectStore, 
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = operation(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  static async executeIndexQuery<T>(
    index: IDBIndex, 
    operation: (index: IDBIndex) => IDBRequest<T>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = operation(index);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  static async executeTransaction(
    db: IDBDatabase,
    storeNames: string | string[],
    mode: IDBTransactionMode,
    operations: (tx: IDBTransaction) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      operations(tx);
    });
  }

  static async getAllPlaylistsWithCounts(db: IDBDatabase): Promise<PlaylistRecord[]> {
    const tx = db.transaction([DB_STORES.PLAYLISTS, DB_STORES.PLAYLIST_ITEMS], DB_OPERATIONS.READ_ONLY);
    const playlistsStore = tx.objectStore(DB_STORES.PLAYLISTS);
    const itemsStore = tx.objectStore(DB_STORES.PLAYLIST_ITEMS);
    const itemsIndex = itemsStore.index(DB_INDICES.PLAYLIST_ID);

    const fetchedPlaylists = await this.executeQuery(playlistsStore, store => store.getAll());
    
    const normalizedPlaylists = fetchedPlaylists.map((r: any) => ({ 
      ...r, 
      tags: PlaylistUtils.normalizeTags(r.tags) 
    }));

    const counts = await Promise.all(
      normalizedPlaylists.map(p => this.executeIndexQuery(itemsIndex, index => index.count(p.id)))
    );

    return normalizedPlaylists
      .map((p, i) => ({ ...p, track_count: counts[i] }))
      .sort(PlaylistUtils.compareForSort);
  }
}

class PlaylistUtils {
  static normalizeTags(raw?: string): string[] {
    if (!raw) return [];
    return raw.split(',').map(t => t.trim()).filter(Boolean);
  }

  static compareForSort(a: PlaylistRecord, b: PlaylistRecord): number {
    if (a.system && !b.system) return -1;
    if (!a.system && b.system) return 1;
    return a.name.localeCompare(b.name);
  }

  static createOptimisticPlaylist(
    name: string, 
    tags: string[] = [], 
    opts?: { artistId?: string; code?: string; system?: boolean }
  ): PlaylistRecord {
    return {
      id: -Date.now(),
      name,
      tags,
      artist_id: opts?.artistId,
      code: opts?.code,
      system: opts?.system ? 1 : 0,
      created_at: Date.now(),
      track_count: 0,
    };
  }

  static createPlaylistRecord(
    name: string,
    tags: string[],
    opts?: { artistId?: string; code?: string; system?: boolean }
  ) {
    return {
      name,
      tags: tags.join(','),
      created_at: Date.now(),
      artist_id: opts?.artistId || null,
      code: opts?.code || null,
      system: opts?.system ? 1 : 0
    };
  }
}

// --- Utility functions ---
const normalizeTags = (raw?: string): string[] => {
  if(!raw) return [];
  return raw.split(',').map(t=>t.trim()).filter(Boolean);
};

// --- Single shared playlist store ---
const shared: PlaylistState = { 
  playlists: [], 
  loading: false, 
  error: undefined 
};
let inFlightRefresh: Promise<void> | null = null;
let pendingShared: PlaylistRecord[] = [];

// --- Optimized refresh function ---
const refreshShared = async (db: IDBDatabase) => {
  if (!db) return;
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    try {
      //console.log('[playlists-debug] refreshShared() called');
      shared.loading = true;
      shared.error = undefined;

      const fetchedPlaylists = await DatabaseOperations.getAllPlaylistsWithCounts(db);

      // Reconcile pending optimistic items
      if (pendingShared.length) {
        pendingShared = pendingShared.filter(p => 
          !fetchedPlaylists.some(f => 
            f.id === p.id || (f.name === p.name && f.created_at === p.created_at)
          )
        );
      }
      
      shared.playlists = [...fetchedPlaylists, ...pendingShared];

    } catch (e: any) {
      shared.error = e?.message || String(e);
      console.warn('[playlists-debug] refreshShared error', e);
    } finally {
      shared.loading = false;
      inFlightRefresh = null;
      notifyPlaylistSubscribers();
    }
  })();

  return inFlightRefresh;
};

// --- Memoized React Hook ---
export const usePlaylists = () => {
  const { db, ready } = useDB();
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>(shared.playlists);
  const [loading, setLoading] = useState<boolean>(shared.loading);
  const [error, setError] = useState<string | undefined>(shared.error);

  // Memoized state synchronizer
  const syncSharedState = useCallback(() => {
    setPlaylists(shared.playlists);
    setLoading(shared.loading);
    setError(shared.error);
  }, []);

  // Initial state sync and subscription
  useEffect(() => {
    syncSharedState();
    playlistSubscribers.add(syncSharedState);
    return () => { playlistSubscribers.delete(syncSharedState); };
  }, [syncSharedState]);

  // Database ready handler
  useEffect(() => {
    if (ready && db) {
      void refreshShared(db);
    }
  }, [ready, db]);

  // Memoized operations
  const refresh = useCallback(async () => {
    if (db) await refreshShared(db);
  }, [db]);

  // --- Optimized CRUD operations ---
  const createPlaylist = useCallback(async (
    name: string, 
    tags: string[] = [], 
    opts?: { artistId?: string; code?: string; system?: boolean }
  ): Promise<number | undefined> => {
    if (!db) return undefined;
    
    //console.log('[playlists-debug] createPlaylist called name=', name);
    
    // Optimistic update
    const optimisticPlaylist = PlaylistUtils.createOptimisticPlaylist(name, tags, opts);
    pendingShared.push(optimisticPlaylist);
    shared.playlists = [...shared.playlists, optimisticPlaylist];
    notifyPlaylistSubscribers();

    let newId: number | undefined;
    try {
      const newPlaylistRecord = PlaylistUtils.createPlaylistRecord(name, tags, opts);
      
      newId = await DatabaseOperations.executeQuery(
        db.transaction(DB_STORES.PLAYLISTS, DB_OPERATIONS.READ_WRITE).objectStore(DB_STORES.PLAYLISTS),
        store => store.add(newPlaylistRecord)
      ) as number;
      
      //console.log('[playlists-debug] createPlaylist insert complete newId=', newId);
    } catch (e) {
      console.warn('createPlaylist error', e);
    } finally {
      await refreshShared(db);
    }
    return newId;
  }, [db]);

  const updatePlaylist = useCallback(async (
    id: number, 
    patch: { name?: string; tags?: string[] }
  ) => {
    if (!db) return;
    
    const playlist = shared.playlists.find(pl => pl.id === id);
    if (playlist?.system && patch.name) delete patch.name;
    if (!patch.name && !patch.tags) return;

    try {
      await DatabaseOperations.executeTransaction(
        db,
        DB_STORES.PLAYLISTS,
        DB_OPERATIONS.READ_WRITE,
        (tx) => {
          const store = tx.objectStore(DB_STORES.PLAYLISTS);
          const getReq = store.get(id);
          getReq.onsuccess = () => {
            const record = getReq.result;
            if (record) {
              if (patch.name !== undefined) record.name = patch.name;
              if (patch.tags !== undefined) record.tags = patch.tags.join(',');
              store.put(record);
            }
          };
        }
      );
      await refreshShared(db);
    } catch (e) {
      console.warn('updatePlaylist failed', e);
    }
  }, [db]);

  const deletePlaylist = useCallback(async (id: number) => {
    if (!db) return;
    
    const playlist = shared.playlists.find(pl => pl.id === id);
    if (playlist?.system) return;

    try {
      await DatabaseOperations.executeTransaction(
        db,
        [DB_STORES.PLAYLISTS, DB_STORES.PLAYLIST_ITEMS],
        DB_OPERATIONS.READ_WRITE,
        (tx) => {
          const playlistsStore = tx.objectStore(DB_STORES.PLAYLISTS);
          const itemsStore = tx.objectStore(DB_STORES.PLAYLIST_ITEMS);
          const itemsIndex = itemsStore.index(DB_INDICES.PLAYLIST_ID);

          playlistsStore.delete(id);
          
          const cursorReq = itemsIndex.openKeyCursor(IDBKeyRange.only(id));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              itemsStore.delete(cursor.primaryKey);
              cursor.continue();
            }
          };
        }
      );
      await refreshShared(db);
    } catch (e) {
      console.warn('deletePlaylist failed', e);
    }
  }, [db]);

  const addTracks = useCallback(async (playlistId: number, trackData: any[]) => {
    if (!db || !trackData.length) return;

    try {
      await DatabaseOperations.executeTransaction(
        db,
        DB_STORES.PLAYLIST_ITEMS,
        DB_OPERATIONS.READ_WRITE,
        (tx) => {
          const store = tx.objectStore(DB_STORES.PLAYLIST_ITEMS);
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
        }
      );
      await refreshShared(db);
    } catch (e) {
      console.warn('addTracks error:', e);
      throw e;
    }
  }, [db]);

  const createPlaylistWithTracks = useCallback(async (
    name: string, 
    tracks: any[], 
    tags: string[] = [], 
    opts?: { artistId?: string; code?: string; system?: boolean }
  ): Promise<number | undefined> => {
    if (!db) return undefined;

    let newId: number | undefined;
    try {
      await DatabaseOperations.executeTransaction(
        db,
        [DB_STORES.PLAYLISTS, DB_STORES.PLAYLIST_ITEMS],
        DB_OPERATIONS.READ_WRITE,
        (tx) => {
          const playlistsStore = tx.objectStore(DB_STORES.PLAYLISTS);
          const itemsStore = tx.objectStore(DB_STORES.PLAYLIST_ITEMS);

          const newPlaylistRecord = PlaylistUtils.createPlaylistRecord(name, tags, opts);
          const addReq = playlistsStore.add(newPlaylistRecord);
          
          addReq.onsuccess = () => {
            newId = addReq.result as number;
            
            if (newId && tracks.length) {
              const now = Date.now();
              for (const track of tracks) {
                if (!track?.id) continue;
                itemsStore.add({
                  playlist_id: newId,
                  track_id: track.id,
                  title: track.name || '',
                  added_at: now,
                  track_data: JSON.stringify(track)
                });
              }
            }
          };
        }
      );
    } catch (e) {
      console.error('createPlaylistWithTracks error', e);
    } finally {
      await refreshShared(db);
    }
    return newId;
  }, [db]);

  const removeTrack = useCallback(async (playlistId: number, trackId: string) => {
    if (!db) return;
    
    try {
      await DatabaseOperations.executeTransaction(
        db,
        DB_STORES.PLAYLIST_ITEMS,
        DB_OPERATIONS.READ_WRITE,
        (tx) => {
          const store = tx.objectStore(DB_STORES.PLAYLIST_ITEMS);
          const index = store.index(DB_INDICES.PLAYLIST_ID);

          const cursorReq = index.openCursor(IDBKeyRange.only(playlistId));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              if (cursor.value.track_id === trackId) {
                store.delete(cursor.primaryKey);
                return;
              }
              cursor.continue();
            } else {
              console.warn('removeTrack: track not found in playlist.');
            }
          };
        }
      );
      await refreshShared(db);
    } catch (e) {
      console.error('removeTrack failed:', e);
      throw e;
    }
  }, [db]);

  // --- Optimized data readers ---
  const getPlaylistTracks = useCallback(async (playlistId: number): Promise<any[]> => {
    if (!db) return [];
    
    try {
      const tx = db.transaction(DB_STORES.PLAYLIST_ITEMS, DB_OPERATIONS.READ_ONLY);
      const store = tx.objectStore(DB_STORES.PLAYLIST_ITEMS);
      const index = store.index(DB_INDICES.PLAYLIST_ID);
      
      const items = await DatabaseOperations.executeIndexQuery(index, idx => idx.getAll(playlistId));
      
      return items
        .sort((a: PlaylistItemRecord, b: PlaylistItemRecord) => a.added_at - b.added_at)
        .map((item: PlaylistItemRecord) => {
          try {
            return item.track_data ? JSON.parse(item.track_data) : { id: item.track_id };
          } catch {
            return { id: item.track_id };
          }
        });
    } catch (e) {
      console.warn('getPlaylistTracks failed:', e);
      return [];
    }
  }, [db]);

  const getPlaylistTrackIds = useCallback(async (playlistId: number): Promise<string[]> => {
    const tracks = await getPlaylistTracks(playlistId);
    return tracks.map(t => t.id).filter(Boolean);
  }, [getPlaylistTracks]);

  // --- Memoized return value ---
  return useMemo(() => ({
    playlists,
    loading,
    error,
    refresh,
    createPlaylist,
    createPlaylistWithTracks,
    updatePlaylist,
    deletePlaylist,
    addTracks,
    removeTrack,
    getPlaylistTracks,
    getPlaylistTrackIds
  }), [
    playlists,
    loading,
    error,
    refresh,
    createPlaylist,
    createPlaylistWithTracks,
    updatePlaylist,
    deletePlaylist,
    addTracks,
    removeTrack,
    getPlaylistTracks,
    getPlaylistTrackIds
  ]);
};