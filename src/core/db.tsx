import React, { createContext, useContext, useEffect, useState } from 'react'
type AnyDB = any
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
}

const ctx = createContext<DBContext>({ db: null, ready: false, exportJSON: async () => '[]', importJSON: async () => {}, exportDB: async () => null, importDB: async () => {}, getSetting: async () => null, setSetting: async () => {}, getApiCache: async () => null, setApiCache: async () => {}, clearCache: async () => {}, clearLocalData: async () => {}, saveNow: async () => {} })

export const DBProvider: React.FC<{ children: React.ReactNode, dbPath?: string }> = ({ children, dbPath }) => {
  const [db, setDb] = useState<AnyDB | null>(null)
  const [ready, setReady] = useState(false)
  const sqlRef = React.useRef<any>(null)
  const pathRef = React.useRef<string | null>(null)

  useEffect(() => {
    let mounted = true
    let cleanupFunctions: (() => void)[] = [];
    
    ;(async () => {
      // Initialize sql.js (WASM). Try to support both CJS (require) and ESM (dynamic import).
      try {
        // prefer require when available (Node), otherwise dynamic import
        let initSqlJs: any = null
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          initSqlJs = require('sql.js')
        } catch (_) {
          const mod = await import('sql.js')
          initSqlJs = mod && (mod.default || mod)
        }

        if (!initSqlJs) throw new Error('sql.js not available')
        const locateFile = (file: string) => {
          // If running in a browser/renderer (including Electron), resolve
          // the wasm relative to the current document location so file://
          // points to the built `dist` folder where sql-wasm.wasm is copied.
          try {
            if (typeof window !== 'undefined' && window.location) {
              // base directory containing index.html
              const href = window.location.href.split('#')[0].split('?')[0]
              const base = href.substring(0, href.lastIndexOf('/') + 1)
              return base + file
            }
          } catch (e) {}

          // Fallback: try using import.meta if available (module-relative)
          try {
            if (typeof import.meta !== 'undefined') {
              return new URL(`./${file}`, import.meta.url).href
            }
          } catch (e) {}

          // Fallback Node path resolution
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const path = require('path')
            return path.join(process.cwd(), file)
          } catch (e) {
            return file
          }
        }

        const SQL = await initSqlJs({ locateFile })

        const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node)
        let resolvedPath: string | null = null
        let database: any

        const ensureSchema = (dbInstance: any) => {
          const schema = `
            CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE);
            CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT, played_at INTEGER);
            CREATE TABLE IF NOT EXISTS favorites (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT);
            CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT, code TEXT UNIQUE, system INTEGER DEFAULT 0, artist_id TEXT, created_at INTEGER, tags TEXT);
            CREATE TABLE IF NOT EXISTS playlist_items (playlist_id INTEGER, track_id TEXT, title TEXT, added_at INTEGER, track_data TEXT);
            CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY, manifest TEXT);
            CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
            CREATE TABLE IF NOT EXISTS api_cache (cache_key TEXT PRIMARY KEY, response_data TEXT, cached_at INTEGER);
          `
          dbInstance.exec(schema)
          // lightweight migrations: attempt to add missing columns (errors ignored)
          const alters = [
            "ALTER TABLE playlists ADD COLUMN code TEXT",
            "ALTER TABLE playlists ADD COLUMN system INTEGER DEFAULT 0",
            "ALTER TABLE playlists ADD COLUMN artist_id TEXT",
            "ALTER TABLE playlists ADD COLUMN created_at INTEGER",
            "ALTER TABLE playlists ADD COLUMN tags TEXT",
            "ALTER TABLE playlist_items ADD COLUMN added_at INTEGER",
            "ALTER TABLE playlist_items ADD COLUMN track_data TEXT"
          ];
          alters.forEach(sql => { try { dbInstance.exec(sql); } catch(_){} });
          // ensure default system playlist (favorites) exists with stable code
          try {
            const res = dbInstance.exec("SELECT id FROM playlists WHERE code='favorites' LIMIT 1");
            const exists = res && res[0] && res[0].values && res[0].values.length;
            if(!exists){
              const now = Date.now();
              dbInstance.exec(`INSERT INTO playlists(name, code, system, created_at) VALUES ('Favorites','favorites',1,${now})`);
            }
          } catch(_){}
        }

        if (isNode) {
          // Try to open a file DB if present
          try {
            const fs = require('fs')
            const path = require('path')
            resolvedPath = dbPath || process.env.FREELY_DB_PATH || path.join(process.cwd(), 'freely.db')
            if (fs.existsSync(resolvedPath)) {
              const data = fs.readFileSync(resolvedPath)
              const uint8 = new Uint8Array(data)
              database = new SQL.Database(uint8)
            } else {
              database = new SQL.Database()
            }
            ensureSchema(database)
            if (mounted) {
              setDb(database)
              setReady(true)
            }
            // persist resolved path for later importDB usage
            pathRef.current = resolvedPath
            sqlRef.current = SQL

            // write back on unload to persist changes
            const saveToDisk = () => {
              try {
                const data = database.export()
                const buffer = Buffer.from(data)
                fs.writeFileSync(resolvedPath, buffer)
              } catch (e) { /* ignore */ }
            }
            process && process.on && process.on('exit', saveToDisk)
            process && process.on && process.on('SIGINT', () => { saveToDisk(); process.exit() })
          } catch (e) {
            // fallback to in-memory sql.js DB
            database = new SQL.Database()
            sqlRef.current = SQL
            ensureSchema(database)
            if (mounted) { setDb(database); setReady(true) }
          }
        } else {
          // Browser: attempt persistence via Cache Storage API
          sqlRef.current = SQL
          let loadedFromCache = false;
          const cacheDBKey = 'freely.db';
          const cacheName = 'freely-db-v1';
          async function loadFromCache(){
            if(typeof caches === 'undefined') return;
            try {
              console.log('💾 Loading database from cache...');
              const cache = await caches.open(cacheName);
              const resp = await cache.match(cacheDBKey);
              if(resp){
                const buf = await resp.arrayBuffer();
                const uint = new Uint8Array(buf);
                database = new SQL.Database(uint);
                loadedFromCache = true;
                console.log('💾 Database loaded from cache successfully');
              } else {
                console.log('💾 No cached database found, creating new one');
              }
            } catch(e){
              console.warn('💾 Failed to load database from cache:', e);
            }
          }
          await loadFromCache();
          if(!loadedFromCache){
            database = new SQL.Database();
          }
          ensureSchema(database);

          // Persistence helpers
            let saveTimer: any = null;
            const scheduleSave = () => {
              if(typeof caches === 'undefined') return; // no-op
              if(saveTimer) clearTimeout(saveTimer);
              saveTimer = setTimeout(()=>{ saveNow(); }, 500); // Reduced from 1200ms to 500ms for more responsive saves
            };
            const saveNow = async () => {
              if(!database) return;
              if(typeof caches === 'undefined') return;
              try {
                console.log('💾 Saving database to cache...');
                const data = database.export();
                const cache = await caches.open(cacheName);
                const blob = new Blob([data], { type: 'application/octet-stream' });
                const resp = new Response(blob, { 
                  headers: { 
                    'Content-Type':'application/octet-stream', 
                    'X-DB-Version':'1',
                    'X-Saved-At': Date.now().toString()
                  }
                });
                await cache.put(cacheDBKey, resp);
                console.log('💾 Database saved to cache successfully');
              } catch(e){
                console.warn('💾 Failed to save database to cache:', e);
              }
            };

            // Monkey-patch mutating methods to schedule saves (best-effort)
            try {
              const mutating = /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|BEGIN|COMMIT)/i;
              const origExec = database.exec.bind(database);
              database.exec = (sql: string, params?: any) => { 
                const result = origExec(sql, params);
                try { 
                  if(mutating.test(sql.trim())) {
                    console.log('💾 DB mutation detected via exec:', sql.substring(0, 50) + (sql.length > 50 ? '...' : ''));
                    scheduleSave(); 
                  }
                } catch(_){}
                return result;
              };
              const origRun = database.run?.bind(database);
              if(origRun){
                database.run = (sql: string, params?: any, callback?: any) => { 
                  const result = origRun(sql, params, callback);
                  try { 
                    if(mutating.test(sql.trim())) {
                      console.log('💾 DB mutation detected via run:', sql.substring(0, 50) + (sql.length > 50 ? '...' : ''));
                      scheduleSave(); 
                    }
                  } catch(_){}
                  return result;
                };
              }
              
              // Add scheduleSave as a property so other methods can access it
              (database as any)._scheduleSave = scheduleSave;
              (database as any)._saveNow = saveNow;
            } catch(_){ 
              console.warn('💾 Failed to monkey-patch database methods for auto-save');
            }

            // Save on visibility change/unload and periodically
            let periodicTimer: any = null;
            try {
              const saveOnHide = () => { 
                console.log('💾 Saving database due to visibility change/unload'); 
                saveNow(); 
              };
              document.addEventListener('visibilitychange', () => { 
                if(document.visibilityState === 'hidden') saveOnHide(); 
              });
              window.addEventListener('beforeunload', saveOnHide);
              window.addEventListener('pagehide', saveOnHide);
              
              // Also save periodically as a backup (every 30 seconds) - only one timer
              if (periodicTimer) clearInterval(periodicTimer);
              periodicTimer = setInterval(() => {
                if(database && mounted) {
                  console.log('💾 Periodic database save');
                  saveNow();
                }
              }, 30000);
              
              // Clean up timer when component unmounts
              const cleanup = () => {
                if (periodicTimer) {
                  clearInterval(periodicTimer);
                  periodicTimer = null;
                }
              };
              cleanupFunctions.push(cleanup);
            } catch(_){ 
              console.warn('💾 Failed to set up auto-save event listeners');
            }

          if (mounted) { setDb(database); setReady(true) }
        }
      } catch (err) {
        // If loading sql-wasm fails, leave db null
      }
    })()
    return () => { 
      mounted = false;
      // Run all cleanup functions
      cleanupFunctions.forEach(cleanup => {
        try {
          cleanup();
        } catch (e) {
          console.warn('💾 Error during cleanup:', e);
        }
      });
    }
  }, [dbPath])

  async function getSetting(key: string) {
    if (!db) return null
    try {
      // sqlite3 style API
      if (typeof db.get === 'function') {
        return await new Promise<string | null>((resolve) => {
          try {
            db.get('SELECT v FROM settings WHERE k = ?', [key], (err: any, row: any) => {
              if (err || !row) return resolve(null)
              resolve(row.v)
            })
          } catch (e) { resolve(null) }
        })
      }

      // sql.js style API
      if (typeof db.exec === 'function') {
        try {
          const res = db.exec(`SELECT v FROM settings WHERE k = '${key.replace(/'/g, "''")}'`)
          if (res && res.length && res[0].values && res[0].values.length) return res[0].values[0][0]
        } catch (e) {}
        return null
      }
    } catch (e) { return null }
    return null
  }

  async function setSetting(key: string, value: string) {
    if (!db) return
    try {
      if (typeof db.run === 'function') {
        // sqlite3 style
        return await new Promise<void>((resolve, reject) => {
          try {
            db.run('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)', [key, value], function (err: any) {
              if (err) return reject(err)
              resolve()
            })
          } catch (e) { resolve() }
        })
      }

      if (typeof db.exec === 'function') {
        try {
          const k = key.replace(/'/g, "''")
          const v = String(value).replace(/'/g, "''")
          db.exec(`INSERT OR REPLACE INTO settings(k,v) VALUES ('${k}','${v}')`)
          
          // Trigger cache save for browser
          if (typeof window !== 'undefined' && typeof caches !== 'undefined') {
            console.log('💾 Settings updated, triggering cache save');
            // Access the scheduleSave function through a custom property we'll add
            if ((db as any)._scheduleSave) {
              (db as any)._scheduleSave();
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  async function exportJSON() {
    if (!db) return '{}'
    const res: any = {}
    const tables = ['users','plays','favorites','playlists','playlist_items','plugins','settings','api_cache']
    for (const t of tables) {
      res[t] = await new Promise<any[]>((resolve) => {
        try {
          db.all(`SELECT * FROM ${t}`, (err: any, rows: any[]) => {
            if (err) return resolve([])
            resolve(rows || [])
          })
        } catch (e) { resolve([]) }
      })
    }
    return JSON.stringify(res)
  }

  async function exportDB() {
    if (!db || !sqlRef.current) return null
    try {
      // sql.js exposes export() which returns Uint8Array
      const data = db.export()
      return data
    } catch (e) { return null }
  }

  async function importJSON(json: string) {
    if (!db) return
    const payload = JSON.parse(json)
    const runAsync = (sql: string, params: any[] = []) => new Promise<void>((resolve, reject) => {
      try {
        db.run(sql, params, function (err: any) {
          if (err) return reject(err)
          resolve()
        })
      } catch (e) { reject(e) }
    })

    try {
      await runAsync('BEGIN')
      for (const t of Object.keys(payload)) {
        const rows = payload[t]
        if (!Array.isArray(rows)) continue
        await runAsync(`DELETE FROM ${t}`)
        if (rows.length === 0) continue
        const cols = Object.keys(rows[0])
        const q = `INSERT INTO ${t}(${cols.join(',')}) VALUES (${cols.map(_ => '?').join(',')})`
        for (const r of rows) {
          await runAsync(q, Object.values(r))
        }
      }
      await runAsync('COMMIT')
    } catch (e) {
      try { await runAsync('ROLLBACK') } catch (_) {}
      throw e
    }
  }

  async function importDB(data: Uint8Array | ArrayBuffer) {
    if (!sqlRef.current) throw new Error('sql.js not initialized')
    const SQL = sqlRef.current
    // construct a new DB from binary, replace current db
    const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    const newdb = new SQL.Database(arr)
    // ensure schema exists (no-op if present)
    const schema = `
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT, played_at INTEGER);
      CREATE TABLE IF NOT EXISTS favorites (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT);
      CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT, code TEXT UNIQUE, system INTEGER DEFAULT 0, artist_id TEXT, created_at INTEGER, tags TEXT);
      CREATE TABLE IF NOT EXISTS playlist_items (playlist_id INTEGER, track_id TEXT, title TEXT, added_at INTEGER, track_data TEXT);
      CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY, manifest TEXT);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS api_cache (cache_key TEXT PRIMARY KEY, response_data TEXT, cached_at INTEGER);
    `
    newdb.exec(schema)
    setDb(newdb)
    // if running on Node and we have a path, persist it
    if (pathRef.current) {
      try {
        const fs = require('fs')
        const buffer = Buffer.from(newdb.export())
        fs.writeFileSync(pathRef.current, buffer)
      } catch (e) {}
    }
  }

  async function getApiCache(key: string) {
    console.log('🔍 getApiCache called with key:', key);
    if (!db) {
      console.log('🔍 getApiCache: no db instance');
      return null;
    }
    try {
      // sqlite3 style API
      if (typeof db.get === 'function') {
        console.log('🔍 getApiCache: using sqlite3 style API');
        return await new Promise<any | null>((resolve) => {
          try {
            db.get('SELECT response_data FROM api_cache WHERE cache_key = ?', [key], (err: any, row: any) => {
              if (err) {
                console.log('🔍 getApiCache sqlite3 error:', err);
                return resolve(null);
              }
              if (!row) {
                console.log('🔍 getApiCache sqlite3: no row found for key:', key);
                return resolve(null);
              }
              try {
                const parsed = JSON.parse(row.response_data);
                console.log('🔍 getApiCache sqlite3: found cached data for key:', key);
                resolve(parsed);
              } catch (e) {
                console.log('🔍 getApiCache sqlite3 JSON parse error:', e);
                resolve(null);
              }
            })
          } catch (e) { 
            console.log('🔍 getApiCache sqlite3 outer error:', e);
            resolve(null);
          }
        })
      }

      // sql.js style API
      if (typeof db.exec === 'function') {
        console.log('🔍 getApiCache: using sql.js style API');
        try {
          const res = db.exec(`SELECT response_data FROM api_cache WHERE cache_key = '${key.replace(/'/g, "''")}'`)
          if (res && res.length && res[0].values && res[0].values.length) {
            const jsonStr = res[0].values[0][0]
            try {
              const parsed = JSON.parse(jsonStr);
              console.log('🔍 getApiCache sql.js: found cached data for key:', key);
              return parsed;
            } catch (e) {
              console.log('🔍 getApiCache sql.js JSON parse error:', e);
              return null;
            }
          } else {
            console.log('🔍 getApiCache sql.js: no results for key:', key);
          }
        } catch (e) {
          console.log('🔍 getApiCache sql.js error:', e);
        }
        return null
      }
      console.log('🔍 getApiCache: no supported API found on db object');
    } catch (e) { 
      console.log('🔍 getApiCache outer error:', e);
      return null;
    }
    return null
  }

  async function setApiCache(key: string, data: any) {
    console.log('💾 setApiCache called with key:', key);
    if (!db) {
      console.log('💾 setApiCache: no db instance');
      return;
    }
    try {
      const jsonStr = JSON.stringify(data)
      const now = Date.now()
      
      if (typeof db.run === 'function') {
        console.log('💾 setApiCache: using sqlite3 style API');
        // sqlite3 style
        return await new Promise<void>((resolve, reject) => {
          try {
            db.run('INSERT OR REPLACE INTO api_cache(cache_key, response_data, cached_at) VALUES(?,?,?)', [key, jsonStr, now], function (err: any) {
              if (err) {
                console.log('💾 setApiCache sqlite3 error:', err);
                return reject(err);
              }
              console.log('💾 setApiCache sqlite3: stored data for key:', key);
              resolve();
            })
          } catch (e) { 
            console.log('💾 setApiCache sqlite3 outer error:', e);
            resolve();
          }
        })
      }

      if (typeof db.exec === 'function') {
        console.log('💾 setApiCache: using sql.js style API');
        try {
          const k = key.replace(/'/g, "''")
          const v = jsonStr.replace(/'/g, "''")
          db.exec(`INSERT OR REPLACE INTO api_cache(cache_key, response_data, cached_at) VALUES ('${k}','${v}',${now})`)
          console.log('💾 setApiCache sql.js: stored data for key:', key);
          
          // Trigger cache save for browser
          if (typeof window !== 'undefined' && typeof caches !== 'undefined') {
            console.log('💾 API cache updated, triggering cache save');
            if ((db as any)._scheduleSave) {
              (db as any)._scheduleSave();
            }
          }
        } catch (e) {
          console.log('💾 setApiCache sql.js error:', e);
        }
      }
    } catch (e) {}
  }

  const clearCache = async () => {
    if (!db) return;
    try {
      console.log('🗑️ Clearing API cache...');
      
      const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
      
      if (isNode) {
        // Node.js - using sqlite3 style API
        db.run('DELETE FROM api_cache', function(err: any) {
          if (err) {
            console.error('🗑️ Error clearing cache:', err);
            throw err;
          }
          console.log('🗑️ Cache cleared successfully');
        });
      } else {
        // Browser - using sql.js style API
        db.exec('DELETE FROM api_cache');
        console.log('🗑️ Cache cleared successfully');
        
        // Trigger cache save for browser
        if (typeof window !== 'undefined' && typeof caches !== 'undefined') {
          console.log('💾 API cache cleared, triggering cache save');
          if ((db as any)._scheduleSave) {
            (db as any)._scheduleSave();
          }
        }
      }
    } catch (e) {
      console.error('🗑️ Error clearing cache:', e);
      throw e;
    }
  };

  const clearLocalData = async () => {
    if (!db) return;
    try {
      console.log('🗑️ Clearing local data (preserving Favorites playlist shell)...');

      const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

      // Tables to clear fully
      const tablesFullClear = ['users', 'plays', 'favorites', 'playlist_items', 'plugins'];

      // We'll clear user-created playlists but keep (or recreate) the system 'favorites' playlist row.
      if (isNode) {
        for (const table of tablesFullClear) {
          db.run(`DELETE FROM ${table}`, function(err: any) {
            if (err) { console.error(`🗑️ Error clearing table ${table}:`, err); throw err; }
          });
        }
        // Delete all non-system playlists (system=0) but keep system ones (favorites). Then reset track counts implicitly.
        db.run(`DELETE FROM playlists WHERE system IS NULL OR system=0`, function(err: any){ if(err){ console.error('🗑️ Error pruning playlists:', err); }});
      } else {
        for (const table of tablesFullClear) { db.exec(`DELETE FROM ${table}`); }
        db.exec(`DELETE FROM playlists WHERE system IS NULL OR system=0`);
      }

      // Ensure favorites playlist exists
      try {
        const now = Date.now();
        if (isNode) {
          db.run(`INSERT OR IGNORE INTO playlists(name, code, system, created_at) VALUES ('Favorites','favorites',1,?)`, [now], (err: any)=>{ if(err) console.warn('🗑️ favorites ensure failed', err); });
        } else {
          db.exec(`INSERT OR IGNORE INTO playlists(name, code, system, created_at) VALUES ('Favorites','favorites',1,${now})`);
        }
      } catch (e) { console.warn('🗑️ Could not ensure favorites playlist exists:', e); }

      console.log('🗑️ Local data cleared successfully (favorites preserved)');
      
      // Trigger cache save for browser
      if (!isNode && typeof window !== 'undefined' && typeof caches !== 'undefined') {
        console.log('💾 Local data cleared, triggering cache save');
        if ((db as any)._scheduleSave) {
          (db as any)._scheduleSave();
        }
      }
    } catch (e) {
      console.error('🗑️ Error clearing local data:', e);
      throw e;
    }
  };

  // Manual save function for external use
  const saveNow = async () => {
    if (!db) return;
    
    const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
    
    if (isNode && pathRef.current) {
      // Node.js - save to file
      try {
        const fs = require('fs');
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(pathRef.current, buffer);
        console.log('💾 Database saved to file:', pathRef.current);
      } catch (e) {
        console.warn('💾 Failed to save database to file:', e);
      }
    } else if (!isNode && typeof window !== 'undefined' && typeof caches !== 'undefined') {
      // Browser - save to cache
      if ((db as any)._saveNow) {
        await (db as any)._saveNow();
      }
    }
  };

  return <ctx.Provider value={{ db, ready, exportJSON, importJSON, exportDB, importDB, getSetting, setSetting, getApiCache, setApiCache, clearCache, clearLocalData, saveNow }}>{children}</ctx.Provider>
}

export function useDB() {
  return useContext(ctx)
}
