import React, { createContext, useContext, useEffect, useState } from 'react'
type AnyDB = any
type DBContext = {
  db: AnyDB | null
  ready: boolean
  exportJSON: () => Promise<string>
  importJSON: (json: string) => Promise<void>
  exportDB: () => Promise<Uint8Array | null>
  importDB: (data: Uint8Array | ArrayBuffer) => Promise<void>
}

const ctx = createContext<DBContext>({ db: null, ready: false, exportJSON: async () => '[]', importJSON: async () => {}, exportDB: async () => null, importDB: async () => {} })

export const DBProvider: React.FC<{ children: React.ReactNode, dbPath?: string }> = ({ children, dbPath }) => {
  const [db, setDb] = useState<AnyDB | null>(null)
  const [ready, setReady] = useState(false)
  const sqlRef = React.useRef<any>(null)
  const pathRef = React.useRef<string | null>(null)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      // Use sql.js (WASM) via local `src/database/sql-wasm.js` for consistent multi-platform behavior.
      try {
  // load sql.js from the installed npm package
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js')
  // serve the wasm from the public/ root at /sql-wasm.wasm (copied there by scripts/copy-sql-wasm.js)
  const SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' })

        const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node)
        let resolvedPath: string | null = null
        let database: any

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
            // ensure schema
            const schema = `
              CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE);
              CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT, played_at INTEGER);
              CREATE TABLE IF NOT EXISTS favorites (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT);
              CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT);
              CREATE TABLE IF NOT EXISTS playlist_items (playlist_id INTEGER, track_id TEXT, title TEXT);
              CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY, manifest TEXT);
              CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
            `
            database.exec(schema)
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
            // also save on SIGINT
            process && process.on && process.on('SIGINT', () => { saveToDisk(); process.exit() })
          } catch (e) {
            // fallback to in-memory sql.js DB
            database = new SQL.Database()
            sqlRef.current = SQL
            const schema = `
              CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE);
              CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT, played_at INTEGER);
              CREATE TABLE IF NOT EXISTS favorites (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT);
              CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT);
              CREATE TABLE IF NOT EXISTS playlist_items (playlist_id INTEGER, track_id TEXT, title TEXT);
              CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY, manifest TEXT);
              CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
            `
            database.exec(schema)
            if (mounted) { setDb(database); setReady(true) }
          }
          } else {
          // Browser / React Native: in-memory sql.js DB (can be extended to persist via IndexedDB)
            database = new SQL.Database()
            sqlRef.current = SQL
            const schema = `
            CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE);
            CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT, played_at INTEGER);
            CREATE TABLE IF NOT EXISTS favorites (id INTEGER PRIMARY KEY, track_id TEXT, title TEXT);
            CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE IF NOT EXISTS playlist_items (playlist_id INTEGER, track_id TEXT, title TEXT);
            CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY, manifest TEXT);
            CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
          `
          database.exec(schema)
            if (mounted) { setDb(database); setReady(true) }
        }
      } catch (err) {
        // If loading sql-wasm fails, leave db null
      }
    })()
    return () => { mounted = false }
  }, [])

  async function exportJSON() {
    if (!db) return '{}'
    const res: any = {}
    const tables = ['users','plays','favorites','playlists','playlist_items','plugins','settings']
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
      CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS playlist_items (playlist_id INTEGER, track_id TEXT, title TEXT);
      CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY, manifest TEXT);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
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

  return <ctx.Provider value={{ db, ready, exportJSON, importJSON, exportDB, importDB }}>{children}</ctx.Provider>
}

export function useDB() {
  return useContext(ctx)
}
