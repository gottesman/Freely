import React, { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react'

// Types and constants
type AnyDB = IDBDatabase;

type DBContext = {
  db: AnyDB | null;
  ready: boolean;
  exportJSON: () => Promise<string>;
  importJSON: (json: string) => Promise<void>;
  exportDB: () => Promise<Uint8Array | null>;
  importDB: (data: Uint8Array | ArrayBuffer) => Promise<void>;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  getApiCache: (key: string) => Promise<any | null>;
  setApiCache: (key: string, data: any) => Promise<void>;
  clearCache: () => Promise<void>;
  clearLocalData: () => Promise<void>;
  saveNow: () => Promise<void>;
  addPlay: (trackId: string, startedAt?: number) => Promise<number>;
  getPlayCountForTrack: (trackId: string) => Promise<number>;
  getRecentPlays: (limit?: number) => Promise<Array<{ id: number; track_id: string; played_at: number }>>;
  getTopPlayed: (limit?: number) => Promise<Array<{ track_id: string; count: number }>>;
};

// Database configuration
const DB_CONFIG = {
  NAME: 'freely-db',
  VERSION: 3,
  STORES: ['users', 'plays', 'favorites', 'playlists', 'playlist_items', 'plugins', 'settings', 'api_cache'] as const
} as const;

type StoreName = typeof DB_CONFIG.STORES[number];

// Store configurations for automated setup
const STORE_CONFIGS = {
  users: { keyPath: 'id', autoIncrement: true },
  plays: { 
    keyPath: 'id', 
    autoIncrement: true,
    indexes: [
      { name: 'played_at', keyPath: 'played_at' },
      { name: 'track_id', keyPath: 'track_id' }
    ]
  },
  favorites: { keyPath: 'id', autoIncrement: true },
  playlists: { 
    keyPath: 'id', 
    autoIncrement: true,
    indexes: [
      { name: 'code', keyPath: 'code', unique: true }
    ]
  },
  playlist_items: { 
    autoIncrement: true,
    indexes: [
      { name: 'playlist_id', keyPath: 'playlist_id' }
    ]
  },
  plugins: { keyPath: 'id', autoIncrement: true },
  settings: { keyPath: 'k' },
  api_cache: { keyPath: 'cache_key' },
  followed_artists: { 
    keyPath: 'id',
    indexes: [
      { name: 'followed_at', keyPath: 'followed_at' }
    ]
  }
} as const;

// Default context with no-ops
const DEFAULT_CONTEXT: DBContext = {
  db: null,
  ready: false,
  exportJSON: async () => '{}',
  importJSON: async () => {},
  exportDB: async () => null,
  importDB: async () => {},
  getSetting: async () => null,
  setSetting: async () => {},
  getApiCache: async () => null,
  setApiCache: async () => {},
  clearCache: async () => {},
  clearLocalData: async () => {},
  saveNow: async () => {},
  addPlay: async () => 0,
  getPlayCountForTrack: async () => 0,
  getRecentPlays: async () => [],
  getTopPlayed: async () => []
};

const ctx = createContext<DBContext>(DEFAULT_CONTEXT);

// Optimized database setup helpers
const DatabaseSetup = {
  createStore: (db: IDBDatabase, name: keyof typeof STORE_CONFIGS, transaction?: IDBTransaction) => {
    if (db.objectStoreNames.contains(name)) return null;
    
    const config = STORE_CONFIGS[name];
    const store = db.createObjectStore(name, config);
    
    if ('indexes' in config && config.indexes) {
      config.indexes.forEach(index => {
        store.createIndex(index.name, index.keyPath, { unique: index.unique || false });
      });
    }
    
    return store;
  },

  createIndex: (store: IDBObjectStore, name: string, keyPath: string, unique = false) => {
    if (!store.indexNames.contains(name)) {
      store.createIndex(name, keyPath, { unique });
    }
  },

  ensureDefaultData: (transaction: IDBTransaction) => {
    try {
      const playlistStore = transaction.objectStore('playlists');
      const codeIndex = playlistStore.index('code');
      
      codeIndex.get('favorites').onsuccess = (e) => {
        const result = (e.target as IDBRequest).result;
        if (!result) {
          playlistStore.add({
            name: 'Favorites',
            code: 'favorites',
            system: 1,
            created_at: Date.now()
          });
        }
      };
    } catch (e) {
      console.warn('Failed to ensure default data:', e);
    }
  }
};

// Optimized provider
export const DBProvider = React.memo<{ children: React.ReactNode; dbPath?: string }>(({ children }) => {
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    const request = indexedDB.open(DB_CONFIG.NAME, DB_CONFIG.VERSION);

    request.onupgradeneeded = (event) => {
      try {
        const dbInstance = (event.target as IDBOpenDBRequest).result;
        const transaction = (event.target as IDBOpenDBRequest).transaction!;

        // Create all stores using configuration
        Object.keys(STORE_CONFIGS).forEach(storeName => {
          const name = storeName as keyof typeof STORE_CONFIGS;
          
          if (!dbInstance.objectStoreNames.contains(name)) {
            DatabaseSetup.createStore(dbInstance, name, transaction);
          } else {
            // Handle existing stores that need index updates
            try {
              const store = transaction.objectStore(name);
              const config = STORE_CONFIGS[name];
              
              if ('indexes' in config && config.indexes) {
                config.indexes.forEach(index => {
                  DatabaseSetup.createIndex(store, index.name, index.keyPath, index.unique);
                });
              }
            } catch (e) {
              console.warn(`Failed to update indexes for ${name}:`, e);
            }
          }
        });

        // Ensure default system data
        DatabaseSetup.ensureDefaultData(transaction);
        
      } catch (err) {
        console.error('Database upgrade error:', err);
      }
    };

    request.onblocked = () => {
      console.warn('IndexedDB upgrade blocked by another connection');
    };

    request.onsuccess = () => {
      if (mounted) {
        const dbInst = request.result;
        
        try {
          dbInst.onversionchange = () => {
            try { 
              dbInst.close(); 
            } catch (_) {}
          };
        } catch (e) {
          console.warn('Version change handler setup failed:', e);
        }
        
        setDb(dbInst);
        setReady(true);
      }
    };

    request.onerror = () => {
      console.error('IndexedDB initialization error:', request.error);
    };

    return () => {
      mounted = false;
      if (db) {
        try {
          db.close();
        } catch (e) {
          console.warn('Database close error:', e);
        }
      }
    };
  }, []);

  // Optimized transaction helper
  const performTx = useCallback(<T,>(
    storeName: StoreName | readonly StoreName[], 
    mode: IDBTransactionMode, 
    action: (stores: Record<string, IDBObjectStore>) => Promise<T>
  ): Promise<T> => {
    return new Promise((resolve, reject) => {
      if (!db) return reject(new Error('Database not ready'));
      
      try {
        const storeNames = Array.isArray(storeName) ? storeName : [storeName];
        const tx = db.transaction(storeNames, mode);
        const stores: Record<string, IDBObjectStore> = {};
        
        storeNames.forEach(name => {
          stores[name] = tx.objectStore(name);
        });

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
  }, [db]);

  const promisifyRequest = useCallback(<T,>(request: IDBRequest<T>): Promise<T> => {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }, []);

  // Memoized API methods
  const getSetting = useCallback((key: string): Promise<string | null> => 
    performTx('settings', 'readonly', async ({ settings }) => {
      const res = await promisifyRequest(settings.get(key));
      return res ? res.v : null;
    }), [performTx, promisifyRequest]);

  const setSetting = useCallback((key: string, value: string): Promise<void> => 
    performTx('settings', 'readwrite', async ({ settings }) => {
      await promisifyRequest(settings.put({ k: key, v: value }));
    }), [performTx, promisifyRequest]);

  const getApiCache = useCallback((key: string): Promise<any | null> => 
    performTx('api_cache', 'readonly', async ({ api_cache }) => {
      const res = await promisifyRequest(api_cache.get(key));
      if (!res) return null;
      try {
        return JSON.parse(res.response_data);
      } catch {
        return null;
      }
    }), [performTx, promisifyRequest]);

  const setApiCache = useCallback((key: string, data: any): Promise<void> => 
    performTx('api_cache', 'readwrite', async ({ api_cache }) => {
      const jsonStr = JSON.stringify(data);
      await promisifyRequest(api_cache.put({ 
        cache_key: key, 
        response_data: jsonStr, 
        cached_at: Date.now() 
      }));
    }), [performTx, promisifyRequest]);

  const clearCache = useCallback((): Promise<void> => 
    performTx('api_cache', 'readwrite', async ({ api_cache }) => {
      await promisifyRequest(api_cache.clear());
    }), [performTx, promisifyRequest]);

  const clearLocalData = useCallback((): Promise<void> => {
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
  }, [performTx, promisifyRequest]);

  const exportJSON = useCallback(async (): Promise<string> => {
    const data: Record<string, any> = {};
    await performTx(DB_CONFIG.STORES, 'readonly', async (stores) => {
      for (const name of DB_CONFIG.STORES) {
        data[name] = await promisifyRequest(stores[name].getAll());
      }
    });
    return JSON.stringify(data);
  }, [performTx, promisifyRequest]);

  const importJSON = useCallback(async (json: string): Promise<void> => {
    const data = JSON.parse(json);
    await performTx(DB_CONFIG.STORES, 'readwrite', async (stores) => {
      for (const name of DB_CONFIG.STORES) {
        if (data[name] && Array.isArray(data[name])) {
          await promisifyRequest(stores[name].clear());
          for (const record of data[name]) {
            await promisifyRequest(stores[name].put(record));
          }
        }
      }
    });
  }, [performTx, promisifyRequest]);

  const exportDB = useCallback(async (): Promise<Uint8Array | null> => {
    try {
      const json = await exportJSON();
      return new TextEncoder().encode(json);
    } catch (e) {
      console.error("Failed to export DB:", e);
      return null;
    }
  }, [exportJSON]);

  const importDB = useCallback(async (data: Uint8Array | ArrayBuffer): Promise<void> => {
    try {
      const json = new TextDecoder().decode(data);
      await importJSON(json);
    } catch (e) {
      console.error("Failed to import DB:", e);
      throw new Error("Import failed. Data may be corrupt.");
    }
  }, [importJSON]);

  const saveNow = useCallback(async (): Promise<void> => {
    // No-op for IndexedDB as transactions are committed automatically
    return Promise.resolve();
  }, []);

  // Play history operations
  const addPlay = useCallback((trackId: string, startedAt: number = Date.now()): Promise<number> =>
    performTx('plays', 'readwrite', async ({ plays }) => {
      const record = { track_id: trackId, played_at: startedAt } as any;
      const key = await promisifyRequest(plays.add(record) as IDBRequest<number>);
      return key as number;
    }), [performTx, promisifyRequest]);

  const getPlayCountForTrack = useCallback((trackId: string): Promise<number> =>
    performTx('plays', 'readonly', async ({ plays }) => {
      try {
        const index = plays.index('track_id');
        const range = IDBKeyRange.only(trackId);
        const count = await promisifyRequest(index.count(range) as IDBRequest<number>);
        return count || 0;
      } catch (e) {
        // Fallback: scan all plays
        let count = 0;
        const cursorReq = plays.openCursor();
        await new Promise<void>((resolve, reject) => {
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              if (cursor.value?.track_id === trackId) count++;
              cursor.continue();
            } else resolve();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
        return count;
      }
    }), [performTx, promisifyRequest]);

  const getRecentPlays = useCallback((limit: number = 50): Promise<Array<{ id: number; track_id: string; played_at: number }>> =>
    performTx('plays', 'readonly', async ({ plays }) => {
      const result: Array<any> = [];
      try {
        const index = plays.index('played_at');
        const cursorReq = index.openCursor(null, 'prev');
        await new Promise<void>((resolve, reject) => {
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              result.push(cursor.value);
              if (result.length >= limit) return resolve();
              cursor.continue();
            } else resolve();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
      } catch (e) {
        // Fallback: get all and sort
        const all = await promisifyRequest(plays.getAll());
        all.sort((a: any, b: any) => b.played_at - a.played_at);
        return all.slice(0, limit);
      }
      return result;
    }), [performTx, promisifyRequest]);

  const getTopPlayed = useCallback((limit: number = 20): Promise<Array<{ track_id: string; count: number }>> =>
    performTx('plays', 'readonly', async ({ plays }) => {
      const all = await promisifyRequest(plays.getAll()) as any[];
      const countMap = new Map<string, number>();
      
      for (const play of all) {
        if (!play?.track_id) continue;
        const trackId = String(play.track_id);
        countMap.set(trackId, (countMap.get(trackId) || 0) + 1);
      }
      
      const sorted = Array.from(countMap.entries())
        .map(([track_id, count]) => ({ track_id, count }))
        .sort((a, b) => b.count - a.count);
        
      return sorted.slice(0, limit);
    }), [performTx, promisifyRequest]);

  // Memoized context value
  const contextValue = useMemo<DBContext>(() => ({
    db,
    ready,
    exportJSON,
    importJSON,
    exportDB,
    importDB,
    getSetting,
    setSetting,
    getApiCache,
    setApiCache,
    clearCache,
    clearLocalData,
    saveNow,
    addPlay,
    getPlayCountForTrack,
    getRecentPlays,
    getTopPlayed
  }), [
    db, ready, exportJSON, importJSON, exportDB, importDB,
    getSetting, setSetting, getApiCache, setApiCache,
    clearCache, clearLocalData, saveNow,
    addPlay, getPlayCountForTrack, getRecentPlays, getTopPlayed
  ]);

  return <ctx.Provider value={contextValue}>{children}</ctx.Provider>;
});

DBProvider.displayName = 'DBProvider';

export function useDB(): DBContext {
  return useContext(ctx);
}