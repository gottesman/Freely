import React, { createContext, useContext, useEffect, useState } from 'react'

// The public API remains unchanged.
type AnyDB = IDBDatabase // Internally, we know it's an IDBDatabase instance.
type DBContext = {
  db: AnyDB | null
  ready: boolean
  exportJSON: () => Promise<string>
  importJSON: (json: string) => Promise<void>
  exportDB: () => Promise<Uint8Array | null>
  importDB: (data: Uint8Array | ArrayBuffer) => Promise<void>
  getSetting: (key: string) => Promise<string | null>
  setSetting: (key: string, value: string) => Promise<void>
  getApiCache: (key: string) => Promise<any | null>
  setApiCache: (key: string, data: any) => Promise<void>
  clearCache: () => Promise<void>
  clearLocalData: () => Promise<void>
  saveNow: () => Promise<void>
  // play history helpers
  addPlay: (trackId: string, startedAt?: number) => Promise<number>
  getPlayCountForTrack: (trackId: string) => Promise<number>
  getRecentPlays: (limit?: number) => Promise<Array<{ id: number; track_id: string; played_at: number }>>
  getTopPlayed: (limit?: number) => Promise<Array<{ track_id: string; count: number }>>
}

// Default context values are no-ops, as before.
const ctx = createContext<DBContext>({ db: null, ready: false, exportJSON: async () => '{}', importJSON: async () => { }, exportDB: async () => null, importDB: async () => { }, getSetting: async () => null, setSetting: async () => { }, getApiCache: async () => null, setApiCache: async () => { }, clearCache: async () => { }, clearLocalData: async () => { }, saveNow: async () => { }, addPlay: async () => 0, getPlayCountForTrack: async () => 0, getRecentPlays: async () => [], getTopPlayed: async () => [] })

const DB_NAME = 'freely-db'
// Bump this when changing object stores or indexes so onupgradeneeded runs
// Bump when changing object stores or indexes so onupgradeneeded runs
const DB_VERSION = 3
const STORE_NAMES = ['users', 'plays', 'favorites', 'playlists', 'playlist_items', 'plugins', 'settings', 'api_cache'] as const
type StoreName = typeof STORE_NAMES[number];


export const DBProvider: React.FC<{ children: React.ReactNode, dbPath?: string }> = ({ children }) => {
  const [db, setDb] = useState<IDBDatabase | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let mounted = true
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      try {
        const dbInstance = (event.target as IDBOpenDBRequest).result;
        // Helper to safely access an object store during upgrade
        const upgradeTx = (event.target as IDBOpenDBRequest).transaction!;

        if (!dbInstance.objectStoreNames.contains('users')) {
          dbInstance.createObjectStore('users', { keyPath: 'id', autoIncrement: true });
        }
        if (!dbInstance.objectStoreNames.contains('plays')) {
          dbInstance.createObjectStore('plays', { keyPath: 'id', autoIncrement: true });
          // Use the upgrade transaction's object store; creating a new transaction here can conflict.
          const store = upgradeTx.objectStore('plays');
          store.createIndex('played_at', 'played_at');
          // index by track id makes counting plays per track efficient
          store.createIndex('track_id', 'track_id');
        } else {
          try {
            const existingPlays = upgradeTx.objectStore('plays');
            if (!existingPlays.indexNames.contains('track_id')) {
              existingPlays.createIndex('track_id', 'track_id');
            }
          } catch (e) {
            // ignore if transaction access fails
          }
        }
      if (!dbInstance.objectStoreNames.contains('favorites')) {
        dbInstance.createObjectStore('favorites', { keyPath: 'id', autoIncrement: true });
      }
      // Ensure playlists store exists and has a 'code' index
      if (!dbInstance.objectStoreNames.contains('playlists')) {
        const store = dbInstance.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
        store.createIndex('code', 'code', { unique: true });
      } else {
        try {
          const existingStore = upgradeTx.objectStore('playlists');
          if (!existingStore.indexNames.contains('code')) {
            existingStore.createIndex('code', 'code', { unique: true });
          }
        } catch (e) {
          // ignore - if transaction access fails here, the store will be created above when needed
        }
      }
      // Ensure playlist_items store exists and has playlist_id index
      if (!dbInstance.objectStoreNames.contains('playlist_items')) {
        const store = dbInstance.createObjectStore('playlist_items', { autoIncrement: true });
        // This index is ESSENTIAL for finding tracks by playlist ID.
        store.createIndex('playlist_id', 'playlist_id');
      } else {
        try {
          const existingItemsStore = upgradeTx.objectStore('playlist_items');
          if (!existingItemsStore.indexNames.contains('playlist_id')) {
            existingItemsStore.createIndex('playlist_id', 'playlist_id');
          }
        } catch (e) {
          // ignore
        }
      }
      if (!dbInstance.objectStoreNames.contains('plugins')) dbInstance.createObjectStore('plugins', { keyPath: 'id', autoIncrement: true });
      if (!dbInstance.objectStoreNames.contains('settings')) dbInstance.createObjectStore('settings', { keyPath: 'k' });
      if (!dbInstance.objectStoreNames.contains('api_cache')) dbInstance.createObjectStore('api_cache', { keyPath: 'cache_key' });
      if (!dbInstance.objectStoreNames.contains('followed_artists')) {
        const store = dbInstance.createObjectStore('followed_artists', { keyPath: 'id' });
        // This index is crucial for sorting by date efficiently.
        store.createIndex('followed_at', 'followed_at');
      }

      // ensure default system playlist (favorites) exists with stable code
      const tx = (event.target as IDBOpenDBRequest).transaction!;
      try {
        const playlistStore = tx.objectStore('playlists');
        const codeIndex = playlistStore.index('code');
        codeIndex.get('favorites').onsuccess = (e) => {
          const res = (e.target as IDBRequest).result
          if (!res) {
            playlistStore.add({ name: 'Favorites', code: 'favorites', system: 1, created_at: Date.now() });
          }
        }
      } catch (e) {
        // If indexes aren't available or the store isn't present, skip gracefully.
        console.warn('IndexedDB upgrade partial failure:', e);
      }
      } catch (err) {
        // If the upgrade handler throws, log and allow the request to continue.
        console.error('onupgradeneeded error:', err);
      }
    }

    // If another connection is holding the old version, this will be called.
    request.onblocked = () => {
      console.warn('IndexedDB upgrade blocked by another connection');
    }

  // (db.onversionchange handled on success) - no-op here

    request.onsuccess = () => {
      if (mounted) {
        const dbInst = request.result
        // Close this connection if another tab tries to upgrade the DB version.
        try {
          dbInst.onversionchange = () => { try { dbInst.close() } catch (_) { } };
        } catch (e) { /* ignore if not supported */ }
        setDb(dbInst)
        setReady(true)
      }
    }

    request.onerror = () => {
      console.error('IndexedDB init error:', request.error)
    }

    return () => {
      mounted = false
      if (db) {
        db.close()
      }
    }
  }, []) // dbPath is unused but kept in props for API compatibility

  // --- Helper function for transactions ---
  const performTx = <T,>(storeName: StoreName | readonly StoreName[], mode: IDBTransactionMode, action: (stores: Record<string, IDBObjectStore>) => Promise<T>): Promise<T> => {
    return new Promise((resolve, reject) => {
      if (!db) return reject(new Error('DB not ready'));
      try {
        const storeNames = Array.isArray(storeName) ? storeName : [storeName];
        const tx = db.transaction(storeNames, mode);
        const stores: Record<string, IDBObjectStore> = {};
        storeNames.forEach(name => { stores[name] = tx.objectStore(name) });

        let result: T | undefined;
        action(stores).then(res => {
          result = res;
        }).catch(err => {
          tx.abort();
          reject(err);
        });

        tx.oncomplete = () => resolve(result!);
        tx.onerror = () => reject(tx.error);
      } catch (error) {
        reject(error);
      }
    });
  };

  const promisifyRequest = <T,>(request: IDBRequest<T>): Promise<T> => {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // --- API Implementation ---

  const getSetting = (key: string): Promise<string | null> => performTx('settings', 'readonly', async ({ settings }) => {
    const res = await promisifyRequest(settings.get(key));
    return res ? res.v : null;
  });

  const setSetting = (key: string, value: string): Promise<void> => performTx('settings', 'readwrite', async ({ settings }) => {
    await promisifyRequest(settings.put({ k: key, v: value }));
  });

  const getApiCache = (key: string): Promise<any | null> => performTx('api_cache', 'readonly', async ({ api_cache }) => {
    const res = await promisifyRequest(api_cache.get(key));
    if (!res) return null;
    try {
      return JSON.parse(res.response_data);
    } catch {
      return null;
    }
  });

  const setApiCache = (key: string, data: any): Promise<void> => performTx('api_cache', 'readwrite', async ({ api_cache }) => {
    const jsonStr = JSON.stringify(data);
    await promisifyRequest(api_cache.put({ cache_key: key, response_data: jsonStr, cached_at: Date.now() }));
  });

  const clearCache = (): Promise<void> => performTx('api_cache', 'readwrite', async ({ api_cache }) => {
    await promisifyRequest(api_cache.clear());
  });

  const clearLocalData = (): Promise<void> => {
    const storesToClear: StoreName[] = ['users', 'plays', 'favorites', 'playlist_items', 'plugins'];
    return performTx([...storesToClear, 'playlists'], 'readwrite', async (stores) => {
      // Clear simple stores
      for (const storeName of storesToClear) {
        await promisifyRequest(stores[storeName].clear());
      }
      // Selectively clear non-system playlists
      const playlistStore = stores.playlists;
      const cursorReq = playlistStore.openCursor();
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            if (!cursor.value.system) {
              cursor.delete();
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    });
  };

  const exportJSON = async (): Promise<string> => {
    const data: Record<string, any> = {};
    await performTx(STORE_NAMES, 'readonly', async (stores) => {
      for (const name of STORE_NAMES) {
        data[name] = await promisifyRequest(stores[name].getAll());
      }
    });
    return JSON.stringify(data);
  };

  const importJSON = async (json: string): Promise<void> => {
    const data = JSON.parse(json);
    await performTx(STORE_NAMES, 'readwrite', async (stores) => {
      for (const name of STORE_NAMES) {
        if (data[name] && Array.isArray(data[name])) {
          await promisifyRequest(stores[name].clear());
          for (const record of data[name]) {
            // Using put is safer than add for imports
            await promisifyRequest(stores[name].put(record));
          }
        }
      }
    });
  };

  const exportDB = async (): Promise<Uint8Array | null> => {
    try {
      const json = await exportJSON();
      return new TextEncoder().encode(json);
    } catch (e) {
      console.error("Failed to export DB:", e);
      return null;
    }
  };

  const importDB = async (data: Uint8Array | ArrayBuffer): Promise<void> => {
    try {
      const json = new TextDecoder().decode(data);
      await importJSON(json);
    } catch (e) {
      console.error("Failed to import DB:", e);
      throw new Error("Import failed. Data may be corrupt.");
    }
  };

  const saveNow = async (): Promise<void> => {
    // No-op for IndexedDB as transactions are committed automatically.
    return Promise.resolve();
  };

  // --- Play history helpers ---
  // Record that a track started playing at a given timestamp (ms since epoch).
  const addPlay = (trackId: string, startedAt: number = Date.now()): Promise<number> =>
    performTx('plays', 'readwrite', async ({ plays }) => {
      const rec = { track_id: trackId, played_at: startedAt } as any;
      const key = await promisifyRequest(plays.add(rec) as IDBRequest<number>);
      return key as number;
    });

  // Return how many times a track has been played (counts entries with matching track_id)
  const getPlayCountForTrack = (trackId: string): Promise<number> =>
    performTx('plays', 'readonly', async ({ plays }) => {
      // Use the track_id index if present
      try {
        const idx = plays.index('track_id');
        const range = IDBKeyRange.only(trackId);
        // Count request
        const cntReq = idx.count(range);
        const cnt = await promisifyRequest(cntReq as IDBRequest<number>);
        return cnt || 0;
      } catch (e) {
        // Fallback: scan all plays (should be rare)
        let count = 0;
        const cursorReq = plays.openCursor();
        await new Promise<void>((resolve, reject) => {
          cursorReq.onsuccess = () => {
            const cur = cursorReq.result;
            if (cur) {
              if (cur.value && cur.value.track_id === trackId) count++;
              cur.continue();
            } else resolve();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
        return count;
      }
    });

  // Return recent plays ordered by played_at desc. limit optional.
  const getRecentPlays = (limit: number = 50): Promise<Array<{ id: number; track_id: string; played_at: number }>> =>
    performTx('plays', 'readonly', async ({ plays }) => {
      const res: Array<any> = [];
      // Use played_at index to iterate backward
      try {
        const idx = plays.index('played_at');
        const cursorReq = idx.openCursor(null, 'prev');
        await new Promise<void>((resolve, reject) => {
          cursorReq.onsuccess = () => {
            const cur = cursorReq.result;
            if (cur) {
              res.push(cur.value);
              if (res.length >= limit) return resolve();
              cur.continue();
            } else resolve();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
      } catch (e) {
        // Fallback: getAll and sort
        const all = await promisifyRequest(plays.getAll());
        all.sort((a: any, b: any) => b.played_at - a.played_at);
        return all.slice(0, limit);
      }
      return res;
    });

  // Return top-played tracks by scanning plays and aggregating counts.
  // This is a simple in-memory aggregation; for very large play tables you may want an aggregated store.
  const getTopPlayed = (limit: number = 20): Promise<Array<{ track_id: string; count: number }>> =>
    performTx('plays', 'readonly', async ({ plays }) => {
      // Fetch all plays (could be large); we fetch all and then aggregate in JS.
      const all = await promisifyRequest(plays.getAll()) as any[];
      const map = new Map<string, number>();
      for (const p of all) {
        if (!p || !p.track_id) continue;
        const key = String(p.track_id);
        map.set(key, (map.get(key) || 0) + 1);
      }
      const arr = Array.from(map.entries()).map(([track_id, count]) => ({ track_id, count }));
      arr.sort((a, b) => b.count - a.count);
      return arr.slice(0, limit);
    });


  const value: DBContext = {
    db, ready, exportJSON, importJSON, exportDB, importDB,
    getSetting, setSetting, getApiCache, setApiCache,
  clearCache, clearLocalData, saveNow,
  // play history
  addPlay, getPlayCountForTrack, getRecentPlays, getTopPlayed
  }

  return <ctx.Provider value={value}>{children}</ctx.Provider>
}

export function useDB() {
  return useContext(ctx)
}