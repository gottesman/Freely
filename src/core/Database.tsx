import React, { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react'

// Types and constants
type AnyDB = IDBDatabase;

// Structured per-track cache types
export type TrackSource = {
  type: 'youtube' | 'torrent' | 'http' | 'local' | string;
  // Standardized fields (legacy fields removed)
  url?: string | null;        // resolved URL (http stream, magnet URI, youtube stream, local path if preferred)
  hash?: string | null;       // Stable identifier (infoHash for torrents, video id for youtube, etc.)
  file_path?: string | null;  // Absolute file path if cached/local
  file_size?: number | null;  // Size in bytes when known
  file_index?: number | null; // Torrent file index when applicable
  title?: string | null;      // Human-friendly label
  selected?: boolean;         // Exactly one true across sources array
};

export type TrackLyrics = {
  genius_html?: string;                       // rendered HTML from Genius
  musixmatch_plain?: string;                  // plain lyrics text
  musixmatch_richsync?: any;                  // normalized synced lyrics object
  musixmatch_offset_ms?: number;              // user-applied offset for richsync
  source?: 'genius' | 'musixmatch' | 'none';  // last used source
};

// Subset of Spotify track metadata we persist for fast UI without re-fetching
// Persist a full snapshot shaped like SpotifyTrack for zero-copy UI usage
export type TrackMeta = {
  id: string;
  name: string;
  url: string;
  durationMs: number;
  explicit: boolean;
  trackNumber: number;
  discNumber: number;
  previewUrl?: string;
  popularity?: number;
  artists: { id: string; name: string; url: string }[];
  album: { id: string; name: string; url?: string; albumType?: string; releaseDate?: string; totalTracks?: number; images?: { url: string; width?: number; height?: number }[]; artists?: { id: string; name: string; url: string }[] };
  linked_from?: { id: string; type: string; uri: string };
  infoSource?: 'album' | 'track';
};

export type TrackRecord = {
  track_id: string;
  updated_at: number;
  times_played: number;
  last_played_at?: number;
  sources?: TrackSource[]; // replaces selected_source
  lyrics?: TrackLyrics;
  spotify?: TrackMeta; // cached spotify metadata snapshot
};

type DBContext = {
  db: AnyDB | null;
  ready: boolean;
  exportJSON: () => Promise<string>;
  importJSON: (json: string) => Promise<void>;
  exportDB: () => Promise<Uint8Array | null>;
  importDB: (data: Uint8Array | ArrayBuffer) => Promise<void>;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  getSource: (key: string) => Promise<string | null>;
  setSource: (key: string, value: string) => Promise<void>;
  getApiCache: (key: string) => Promise<any | null>;
  setApiCache: (key: string, data: any) => Promise<void>;
  clearCache: () => Promise<void>;
  clearLocalData: () => Promise<void>;
  saveNow: () => Promise<void>;
  addPlay: (trackId: string, startedAt?: number) => Promise<number>;
  getPlayCountForTrack: (trackId: string) => Promise<number>;
  getRecentPlays: (limit?: number) => Promise<Array<{ id: number; track_id: string; played_at: number }>>;
  getTopPlayed: (limit?: number) => Promise<Array<{ track_id: string; count: number }>>;
  // Per-track structured cache
  getTrack: (trackId: string) => Promise<TrackRecord | null>;
  upsertTrack: (trackId: string, patch: Partial<TrackRecord>) => Promise<void>;
  setTrackSources: (trackId: string, sources: TrackSource[]) => Promise<void>;
  selectTrackSource: (trackId: string, source: TrackSource | null) => Promise<void>;
  setTrackLyrics: (trackId: string, lyrics: Partial<TrackLyrics> & { updated_at?: number }) => Promise<void>;
};

// Database configuration
const DB_CONFIG = {
  NAME: 'freely-db',
  VERSION: 4,
  STORES: ['users', 'plays', 'favorites', 'playlists', 'playlist_items', 'plugins', 'settings', 'sources', 'api_cache', 'followed_artists', 'tracks'] as const
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
  sources: { keyPath: 'k' },
  api_cache: { keyPath: 'cache_key' },
  followed_artists: { 
    keyPath: 'id',
    indexes: [
      { name: 'followed_at', keyPath: 'followed_at' }
    ]
  },
  tracks: {
    keyPath: 'track_id',
    indexes: [
      { name: 'updated_at', keyPath: 'updated_at' }
    ]
  },
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
  getSource: async () => null,
  setSource: async () => {},
  getApiCache: async () => null,
  setApiCache: async () => {},
  clearCache: async () => {},
  clearLocalData: async () => {},
  saveNow: async () => {},
  addPlay: async () => 0,
  getPlayCountForTrack: async () => 0,
  getRecentPlays: async () => [],
  getTopPlayed: async () => [],
  getTrack: async () => null,
  upsertTrack: async () => {},
  setTrackSources: async () => {},
  selectTrackSource: async () => {},
  setTrackLyrics: async () => {},
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
        
        // No migrations in the new implementation
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

  const getSource = useCallback((key: string): Promise<string | null> => 
    performTx('sources', 'readonly', async ({ sources }) => {
      const res = await promisifyRequest(sources.get(key));
      return res ? res.v : null;
    }), [performTx, promisifyRequest]);

  const setSource = useCallback((key: string, value: string): Promise<void> => 
    performTx('sources', 'readwrite', async ({ sources }) => {
      await promisifyRequest(sources.put({ k: key, v: value }));
    }), [performTx, promisifyRequest]);

  // Track-level structured cache API

  const upsertTrack = useCallback((trackId: string, patch: Partial<TrackRecord>): Promise<void> =>
    performTx('tracks', 'readwrite', async ({ tracks }) => {
      const existing = await promisifyRequest(tracks.get(trackId)) as any;
      // Merge spotify snapshot with upgrade-only policy (album -> track)
      let mergedSpotify = existing?.spotify as TrackMeta | undefined;
      const incomingSpotify = patch.spotify as TrackMeta | undefined;
      if (incomingSpotify) {
        const existingSource = mergedSpotify?.infoSource;
        const incomingSource = incomingSpotify.infoSource;
        if (existingSource === 'track' && incomingSource === 'album') {
          // Do not downgrade; keep existing full track snapshot
        } else {
          // Accept incoming (track replaces album or fills when empty; album sets when none)
          mergedSpotify = incomingSpotify;
        }
      }

      const next: TrackRecord = {
        track_id: trackId,
        updated_at: Date.now(),
        times_played: existing?.times_played || 0,
        last_played_at: existing?.last_played_at || undefined,
        sources: patch.sources ?? existing?.sources ?? [],
        lyrics: existing?.lyrics || undefined,
        spotify: mergedSpotify ?? existing?.spotify ?? undefined,
        ...patch,
      } as TrackRecord;
      await promisifyRequest(tracks.put(next));
    }), [performTx, promisifyRequest]);

  // Replace entire sources array
  const setTrackSources = useCallback((trackId: string, sources: TrackSource[]): Promise<void> =>
    upsertTrack(trackId, { sources }), [upsertTrack]);

  // Select exactly one source; add/update it and clear others' selected flags
  const selectTrackSource = useCallback(async (trackId: string, source: TrackSource | null): Promise<void> => {
    return performTx('tracks', 'readwrite', async ({ tracks }) => {
      const existing = await promisifyRequest(tracks.get(trackId)) as TrackRecord | null;
      const current = existing?.sources ? [...existing.sources] : [] as TrackSource[];

  const clearSelection = () => current.map(s => ({ ...s, selected: false as boolean }));

      let nextSources: TrackSource[];
      if (source === null) {
        nextSources = clearSelection();
      } else {
        const incoming: TrackSource = {
          type: source.type,
          url: source.url ?? null,
          hash: source.hash ?? null,
          file_path: source.file_path ?? null,
          file_size: source.file_size ?? null,
          file_index: source.file_index ?? null,
          title: source.title ?? null,
          selected: true,
        };

        const matchBy = (s: TrackSource) =>
          (incoming.hash && s.hash && s.hash === incoming.hash) ||
          (incoming.file_path && s.file_path && s.file_path === incoming.file_path) ||
          (incoming.url && s.url && s.url === incoming.url);

        const idx = current.findIndex(matchBy);
        const cleared = clearSelection();
        if (idx >= 0) {
          cleared[idx] = { ...cleared[idx], ...incoming, selected: true };
          nextSources = cleared;
        } else {
          nextSources = [...cleared, incoming];
        }
      }

      const next: TrackRecord = {
        track_id: trackId,
        updated_at: Date.now(),
        times_played: existing?.times_played || 0,
        last_played_at: existing?.last_played_at || undefined,
        sources: nextSources,
        lyrics: existing?.lyrics,
        spotify: existing?.spotify,
      } as TrackRecord;
      await promisifyRequest(tracks.put(next));
    });
  }, [performTx, promisifyRequest]);

  const setTrackLyrics = useCallback((trackId: string, lyrics: Partial<TrackLyrics> & { updated_at?: number }): Promise<void> =>
    performTx('tracks', 'readwrite', async ({ tracks }) => {
      const existing = await promisifyRequest(tracks.get(trackId)) as any;
      const mergedLyrics: TrackLyrics | undefined = (() => {
        const current: TrackLyrics | undefined = existing?.lyrics;
        const next = { ...(current || {}), ...lyrics } as TrackLyrics;
        return next;
      })();
      const next: TrackRecord = {
        track_id: trackId,
        updated_at: Date.now(),
        times_played: existing?.times_played || 0,
        last_played_at: existing?.last_played_at || undefined,
        sources: existing?.sources || [],
        lyrics: mergedLyrics,
        spotify: existing?.spotify,
      };
      await promisifyRequest(tracks.put(next));
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

  const getTrack = useCallback(async (trackId: string): Promise<TrackRecord | null> => {
    // First try local store
    const local = await performTx('tracks', 'readonly', async ({ tracks }) => {
      const res = await promisifyRequest(tracks.get(trackId));
      return (res as any) || null;
    });
    // If we have a record but it's missing spotify snapshot, try to enrich it
    if (local && !local.spotify) {
      try {
        const mod: any = await import('./SpotifyClient');
        const client: any = (mod.createCachedSpotifyClient
          ? mod.createCachedSpotifyClient({ getApiCache, setApiCache, upsertTrack })
          : new mod.SpotifyClient());
        await client.getTrack(String(trackId));
        // Re-read after enrichment attempt
        return await performTx('tracks', 'readonly', async ({ tracks }) => {
          const res = await promisifyRequest(tracks.get(trackId));
          return (res as any) || local;
        });
      } catch (e) {
        console.warn('[DB] getTrack enrich fetch failed:', e);
        return local; // return what we have
      }
    }
    if (local) return local;
    // If missing, best-effort fetch from Spotify and upsert via SpotifyClient
    try {
      const mod: any = await import('./SpotifyClient');
      const client: any = (mod.createCachedSpotifyClient
        ? mod.createCachedSpotifyClient({ getApiCache, setApiCache, upsertTrack })
        : new mod.SpotifyClient());
      await client.getTrack(String(trackId));
    } catch (e) {
      console.warn('[DB] getTrack fallback fetch failed:', e);
    }
    // Read again
    return await performTx('tracks', 'readonly', async ({ tracks }) => {
      const res = await promisifyRequest(tracks.get(trackId));
      return (res as any) || null;
    });
  }, [performTx, promisifyRequest, getApiCache, setApiCache, upsertTrack]);

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
    performTx(['plays', 'tracks'], 'readwrite', async ({ plays, tracks }) => {
      const record = { track_id: trackId, played_at: startedAt } as any;
      const key = await promisifyRequest(plays.add(record) as IDBRequest<number>);
      // Update aggregate on tracks store (keeps a lightweight counter)
      try {
        const existing = await promisifyRequest(tracks.get(trackId)) as any;
        const times_played = (existing?.times_played || 0) + 1;
        const next: TrackRecord = {
          track_id: trackId,
          updated_at: Date.now(),
          times_played,
          last_played_at: startedAt,
          sources: existing?.sources || [],
          lyrics: existing?.lyrics,
          spotify: existing?.spotify,
        };
        await promisifyRequest(tracks.put(next));
      } catch (e) {
        console.warn('[DB] Failed updating track aggregate play count:', e);
      }
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
    getSource,
    setSource,
    getTrack,
    upsertTrack,
    setTrackSources,
    selectTrackSource,
    setTrackLyrics,
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
    getSetting, setSetting, getSource, setSource, getTrack, upsertTrack, setTrackSources, selectTrackSource, setTrackLyrics, getApiCache, setApiCache,
    clearCache, clearLocalData, saveNow,
    addPlay, getPlayCountForTrack, getRecentPlays, getTopPlayed
  ]);

  return <ctx.Provider value={contextValue}>{children}</ctx.Provider>;
});

DBProvider.displayName = 'DBProvider';

export function useDB(): DBContext {
  return useContext(ctx);
}