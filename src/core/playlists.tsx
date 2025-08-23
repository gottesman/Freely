import React from 'react';
import { useDB } from './db';

// Simple module-level pub/sub so multiple components using usePlaylists stay in sync
const playlistSubscribers = new Set<() => void>();
function notifyPlaylistSubscribers(){
  // Debug: how many subscribers will be notified
  try { console.log('[playlists-debug] notify subscribers count=', playlistSubscribers.size); } catch(_) {}
  playlistSubscribers.forEach(fn => { try { fn(); } catch(err) { console.warn('[playlists-debug] subscriber error', err); } });
}
// External helper: allow other modules (e.g., Settings after destructive operations)
// to force all playlist hooks to refresh without directly mutating internals.
export function broadcastPlaylistsChanged(){
  notifyPlaylistSubscribers();
}

export interface PlaylistRecord {
  id: number;
  name: string;
  code?: string; // stable identifier for system playlists (e.g., 'favorites')
  system?: number; // 1 if system (immutable name / undeletable)
  artist_id?: string | null;
  tags: string[];
  created_at?: number;
  track_count?: number;
}

function normalizeTags(raw?: string): string[] {
  if(!raw) return [];
  return raw.split(',').map(t=>t.trim()).filter(Boolean);
}

/** Helper: robustly extract last insert id from db.exec results (sql.js) */
function extractLastInsertId(execResult: any[] | undefined): number | undefined {
  try {
    if (!execResult || !execResult[0] || !execResult[0].values) return undefined;
    // result.values is array of rows; first row first column is the id
    const v = execResult[0].values?.[0]?.[0];
    if (typeof v === 'number') return v;
    // sometimes sql.js returns numbers as strings
    if (typeof v === 'string' && /^[0-9]+$/.test(v)) return parseInt(v, 10);
  } catch (_) {}
  return undefined;
}

export function usePlaylists(){
  const { db, ready } = useDB();
  const [playlists, setPlaylists] = React.useState<PlaylistRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string|undefined>();
  // Hold optimistic (pending) playlists not yet confirmed by DB
  const pendingRef = React.useRef<PlaylistRecord[]>([]);

  const refresh = React.useCallback(()=> {
    if(!db) return;
    try {
  console.log('[playlists-debug] refresh() start');
      setLoading(true); setError(undefined);

      // opportunistic migrations
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN created_at INTEGER"); } catch(_){ }
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN tags TEXT"); } catch(_){ }
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN code TEXT"); } catch(_){ }
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN system INTEGER DEFAULT 0"); } catch(_){ }
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN artist_id TEXT"); } catch(_){ }

      // NEW: ensure playlist_items columns exist
      try { db.exec?.("ALTER TABLE playlist_items ADD COLUMN added_at INTEGER"); } catch(_){ /* already present or not needed */ }
      try { db.exec?.("ALTER TABLE playlist_items ADD COLUMN track_data TEXT"); } catch(_){ /* already present or not needed */ }

      const rows: any[] = [];
      try {
        const stmt = db.prepare?.('SELECT p.id, p.name, p.code, p.system, p.artist_id, p.tags, p.created_at, (SELECT COUNT(1) FROM playlist_items pi WHERE pi.playlist_id = p.id) as track_count FROM playlists p ORDER BY p.system DESC, p.name ASC');
        if(stmt){ while(stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); }
      } catch(e){ console.warn('refresh query failed', e); }
  const fetched: PlaylistRecord[] = rows.map(r=> ({ id: r.id, name: r.name, code: r.code || undefined, system: r.system, artist_id: r.artist_id, tags: normalizeTags(r.tags), created_at: r.created_at, track_count: r.track_count }));
  console.log('[playlists-debug] refresh() fetched rows=', fetched.length, fetched.map(f=>({id:f.id,name:f.name,code:f.code,tracks:f.track_count})));
      // Reconcile pending optimistic entries: if a pending matches by name & created_at (or code) adopt DB id and drop duplicate
      if(pendingRef.current.length){
        for(const p of pendingRef.current){
          const match = fetched.find(f=> (p.code && f.code && f.code===p.code) || (f.name===p.name && f.created_at===p.created_at));
          if(match){
            // Replace temp id with real id
            p.id = match.id;
          }
        }
        // Remove any pending entries now present in fetched (by id or name+created_at)
        pendingRef.current = pendingRef.current.filter(p=> !fetched.some(f=> f.id===p.id || (f.name===p.name && f.created_at===p.created_at)));
      }
      const merged = [...fetched];
      // Append remaining pending entries (with negative temp IDs) if not already included
      for(const p of pendingRef.current){
        if(!merged.some(m=> m.id===p.id || (m.name===p.name && m.created_at===p.created_at))){
          merged.push(p);
        }
      }
  console.log('[playlists-debug] refresh() merged list size=', merged.length, merged.map(m=>({id:m.id,name:m.name,temp:m.id<0})));
  setPlaylists(merged);
  console.log('[playlists-debug] refresh() end');
    } catch(e:any){ setError(e.message||String(e)); }
    finally { setLoading(false); }
  }, [db]);

  React.useEffect(()=>{ if(ready) refresh(); }, [ready, refresh]);

  // Subscribe to external playlist change notifications
  React.useEffect(()=>{
    const listener = () => refresh();
    playlistSubscribers.add(listener);
    return () => { playlistSubscribers.delete(listener); };
  }, [refresh]);

  async function getLastInsertedPlaylistId(): Promise<number | undefined> {
    if(!db) return undefined;
    try {
      // try last_insert_rowid() first
      const rows = db.exec?.('SELECT last_insert_rowid() as id');
      const id = extractLastInsertId(rows);
      if(id) return id;
    } catch(_) {}
    try {
      const rows2 = db.exec?.('SELECT id FROM playlists ORDER BY id DESC LIMIT 1');
      const id2 = extractLastInsertId(rows2);
      if(id2) return id2;
    } catch(_) {}
    return undefined;
  }

  const createPlaylist = React.useCallback(async (name: string, tags: string[] = [], opts?: { artistId?: string; code?: string; system?: boolean }): Promise<number|undefined> => {
    if(!db) return undefined;
    console.log('[playlists-debug] createPlaylist called name=', name, 'tags=', tags, 'opts=', opts);
    const created = Date.now();
    // Optimistic update
    const tempId = -Date.now();
    const optimisticPlaylist: PlaylistRecord = {
      id: tempId,
      name,
      tags,
      artist_id: opts?.artistId,
      code: opts?.code,
      system: opts?.system ? 1 : 0,
      created_at: created,
      track_count: 0,
    };
    pendingRef.current.push(optimisticPlaylist);
    setPlaylists(current => [...current, optimisticPlaylist]); // Immediately update UI

    let newId: number | undefined;
    const tagStr = tags.join(',');
    try {
      if(db.run){
        console.log('[playlists-debug] using sqlite3 run() path');
        // Ensure columns exist for sqlite3 (run) path too
        const ensureCols = ['created_at INTEGER', 'tags TEXT', 'code TEXT', 'system INTEGER DEFAULT 0', 'artist_id TEXT'];
        for(const col of ensureCols){
          try { db.run?.(`ALTER TABLE playlists ADD COLUMN ${col}`, [], ()=>{}); } catch(_) {}
        }
        // Detect existing columns via PRAGMA
        let existingCols: string[] = [];
        try {
          db.all?.('PRAGMA table_info(playlists)', [], (err: any, rows: any[])=>{ if(!err && rows) existingCols = rows.map(r=> r.name); });
        } catch(_) {}
        // Build dynamic insert depending on available columns
        const wantCols = [
          {name:'name', value:name},
          {name:'tags', value:tagStr},
          {name:'created_at', value:created},
          {name:'artist_id', value:opts?.artistId||null},
          {name:'code', value:opts?.code||null},
          {name:'system', value:opts?.system?1:0}
        ];
        const usable = existingCols.length ? wantCols.filter(c=> existingCols.includes(c.name)) : wantCols; // if pragma failed assume all
        const colNames = usable.map(c=> c.name).join(', ');
        const placeholders = usable.map(()=> '?').join(',');
        const values = usable.map(c=> c.value);
        console.log('[playlists-debug] insert columns=', colNames);
        await new Promise<void>((resolve, reject)=>{
          db.run(`INSERT INTO playlists(${colNames}) VALUES (${placeholders})`, values, function(this: any, err?: any){
            console.log('[playlists-debug] sqlite3 run callback fired err=', err, 'lastID=', this?.lastID);
            if(err){
              console.warn('createPlaylist db.run error primary insert', err);
              // Fallback minimal insert (name only)
              if(colNames !== 'name'){
                db.run('INSERT INTO playlists(name) VALUES (?)', [name], function(this: any, err2?: any){
                  console.log('[playlists-debug] fallback name-only insert err=', err2, 'lastID=', this?.lastID);
                  if(!err2 && typeof this?.lastID === 'number') newId = this.lastID;
                  resolve();
                });
                return;
              }
              reject(err); return;
            }
            try { if(typeof this?.lastID === 'number') newId = this.lastID; } catch(_) {}
            resolve();
          });
        });
        // Post-update additional columns if fallback path used
        if(newId && existingCols.length && !existingCols.includes('tags') && tagStr){
          try { db.run('UPDATE playlists SET tags=? WHERE id=?', [tagStr, newId], ()=>{}); } catch(_) {}
        }
      } else if(db.exec){
        console.log('[playlists-debug] using sql.js exec() path');
        const escName = name.replace(/'/g, "''");
        const escTags = tagStr.replace(/'/g, "''");
        const artistId = opts?.artistId ? `'${opts.artistId.replace(/'/g,"''")}'` : 'NULL';
        const code = opts?.code ? `'${opts.code.replace(/'/g,"''")}'` : 'NULL';
        const system = opts?.system ? 1 : 0;
        try { db.exec(`INSERT INTO playlists(name, tags, created_at, artist_id, code, system) VALUES ('${escName}','${escTags}',${created},${artistId},${code},${system})`); }
        catch(e){ console.warn('createPlaylist exec INSERT failed', e); }
        // fetch latest id deterministically
        try {
          const idRows = db.exec?.('SELECT id FROM playlists ORDER BY id DESC LIMIT 1');
          const cand = extractLastInsertId(idRows);
          if(cand) newId = cand;
        } catch(_) {}
      }
      console.log('[playlists-debug] createPlaylist insert complete newId=', newId);
    } catch(e){ console.warn('createPlaylist outer error', e); }
    finally {
      // Always refresh exactly like deletePlaylist does
      try { refresh(); } catch(_) {}
      try { notifyPlaylistSubscribers(); } catch(_) {}
      console.log('[playlists-debug] createPlaylist finalize refresh triggered');
    }
    return newId;
  }, [db, refresh]);

  const updatePlaylist = React.useCallback(async (id: number, patch: { name?: string; tags?: string[] }) => {
    if(!db) return;
    // Prevent renaming system playlists
    const p = playlists.find(pl => pl.id === id);
    if(p?.system && patch.name) delete patch.name;
    const sets: string[] = [];
    if(patch.name !== undefined) sets.push(`name='${patch.name.replace(/'/g, "''")}'`);
    if(patch.tags !== undefined) sets.push(`tags='${patch.tags.join(',').replace(/'/g, "''")}'`);
    if(!sets.length) return;
    try { db.exec?.(`UPDATE playlists SET ${sets.join(', ')} WHERE id=${id}`); refresh(); notifyPlaylistSubscribers(); } catch(e){ console.warn('updatePlaylist failed', e); }
  }, [db, refresh, playlists]);

  const deletePlaylist = React.useCallback(async (id: number) => {
    if(!db) return;
    const p = playlists.find(pl => pl.id === id);
    if(p?.system) return; // cannot delete system playlists
    try { db.exec?.(`DELETE FROM playlist_items WHERE playlist_id=${id}`); db.exec?.(`DELETE FROM playlists WHERE id=${id}`); refresh(); notifyPlaylistSubscribers(); } catch(e){ console.warn('deletePlaylist failed', e); }
  }, [db, refresh, playlists]);

  const addTracks = React.useCallback(async (playlistId: number, trackData: string[] | any[]) => {
    if(!db || !trackData.length) return;
    
    const now = Date.now();
    
    // Support both legacy track ID arrays and new track object arrays
    const isTrackObjects = trackData.length > 0 && typeof trackData[0] === 'object' && trackData[0]?.id;
    
    try {
      // Use db.exec for more reliable execution
      if (db.exec) {
        // Build insert statements
        const stmts = trackData.map(item => {
          if(!!isTrackObjects && !item?.id) return null;
          if(!isTrackObjects && !item) return null;
          
          const trackId = !!isTrackObjects ? item.id : item;
          const trackTitle = !!isTrackObjects ? (item.name || '') : '';
          const trackDataJson = !!isTrackObjects ? JSON.stringify(item) : '';
          
          const escId = trackId.replace(/'/g, "''");
          const escTitle = trackTitle.replace(/'/g, "''");
          const escData = trackDataJson.replace(/'/g, "''");
          return `INSERT INTO playlist_items(playlist_id, track_id, title, added_at, track_data) VALUES (${playlistId}, '${escId}', '${escTitle}', ${now}, '${escData}')`;
        }).filter(Boolean);
        
        const sql = `BEGIN; ${stmts.join('; ')}; COMMIT;`;
        db.exec(sql); 
      } else if (db.run) {
        // Fallback to db.run method
        for (const item of trackData) {
          if(!!isTrackObjects && !item?.id) continue;
          if(!isTrackObjects && !item) continue;
          
          const trackId = !!isTrackObjects ? item.id : item;
          const trackTitle = !!isTrackObjects ? (item.name || '') : '';
          const trackDataJson = !!isTrackObjects ? JSON.stringify(item) : '';
          
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Database operation timed out'));
            }, 5000);
            
            db.run(`INSERT INTO playlist_items(playlist_id, track_id, title, added_at, track_data) VALUES (?,?,?,?,?)`, [playlistId, trackId, trackTitle, now, trackDataJson], function(this: any, err?: any){
              clearTimeout(timeout);
              if(err) return reject(err);
              resolve();
            });
          });
        }
      } else {
        throw new Error('No database execution method available');
      }
      
      // Refresh to update the UI after database operations
      refresh();
      notifyPlaylistSubscribers();
    } catch(e){ 
      console.warn('addTracks error:', e); 
      throw e;
    }
  }, [db, refresh]);

  // Atomic helper: create a playlist and insert tracks with full metadata before a single refresh/notify.
  const createPlaylistWithTracks = React.useCallback(async (name: string, tracks: any[], tags: string[] = [], opts?: { artistId?: string; code?: string; system?: boolean }): Promise<number|undefined> => {
    if(!db) return undefined;
    
    const created = Date.now();
    const tagStr = tags.join(',');
    let newId: number | undefined;
    
    try {
      // Check if we're in a browser environment - sql.js db.run doesn't work reliably in browsers
      const isInBrowser = typeof window !== 'undefined';
      
      // Force db.exec path for browsers, even if db.run exists
      if(db.run && !isInBrowser){
        // Node.js/Electron path
        await new Promise<void>((resolve, reject)=> {
          db.run('INSERT INTO playlists(name, tags, created_at, artist_id, code, system) VALUES (?,?,?,?,?,?)', [name, tagStr, created, opts?.artistId||null, opts?.code||null, opts?.system?1:0], function(this: any, err?: any){
            if(err){ console.error('createPlaylistWithTracks db.run insert playlist error', err); reject(err); return; }
            try { 
              if(typeof this?.lastID === 'number') {
                newId = this.lastID;
              }
            } catch(e) {
              console.error('Error getting lastID:', e);
            }
            resolve();
          });
        });
        // Insert tracks with metadata (sequentially)
        if(newId && tracks?.length){
          const now = Date.now();
          let insertedCount = 0;
          for(const track of tracks){
            if(!track?.id) continue;
            try {
              const trackDataJson = JSON.stringify(track);
              await new Promise<void>((resolve, reject) => {
                db.run(`INSERT INTO playlist_items(playlist_id, track_id, title, added_at, track_data) VALUES (?,?,?,?,?)`, [newId, track.id, track.name || '', now, trackDataJson], function(this: any, err?: any){
                  if(err){ console.error('createPlaylistWithTracks db.run insert track error for', track.id, ':', err); return reject(err); }
                  insertedCount++;
                  resolve();
                });
              });
            } catch(e) {
              console.error('Failed to insert track', track.id, ':', e);
            }
          }
        }
      } else if(db.exec){
        // Browser/sql.js path
        const escName = name.replace(/'/g, "''");
        const escTags = tagStr.replace(/'/g, "''");
        const artistId = opts?.artistId ? `'${opts?.artistId.replace(/'/g,"''")}'` : 'NULL';
        const code = opts?.code ? `'${opts?.code.replace(/'/g,"''")}'` : 'NULL';
        const system = opts?.system ? 1 : 0;
        
        // Create playlist first
        let transactionSql = `BEGIN;`;
        transactionSql += `INSERT INTO playlists(name, tags, created_at, artist_id, code, system) VALUES ('${escName}','${escTags}',${created},${artistId},${code},${system});`;
        transactionSql += `COMMIT;`;
        
        try {
          db.exec(transactionSql);
          newId = await getLastInsertedPlaylistId();
          
          // Insert tracks with metadata in batches to avoid SQL limits
          if(newId && tracks?.length){
            const now = Date.now();
            const batchSize = 20; // Increased batch size for better performance
            let insertedCount = 0;
            
            for(let i = 0; i < tracks.length; i += batchSize) {
              const batch = tracks.slice(i, i + batchSize);
              const batchStmts = batch.map(track => {
                if(!track?.id) return null;
                const escId = track.id.replace(/'/g, "''");
                const escTitle = (track.name || '').replace(/'/g, "''");
                const trackDataJson = JSON.stringify(track).replace(/'/g, "''");
                return `INSERT INTO playlist_items(playlist_id, track_id, title, added_at, track_data) VALUES (${newId}, '${escId}', '${escTitle}', ${now}, '${trackDataJson}')`;
              }).filter(Boolean);
              
              if(batchStmts.length === 0) continue;
              
              const batchSql = `BEGIN; ${batchStmts.join('; ')}; COMMIT;`;
              
              try {
                db.exec(batchSql);
                insertedCount += batch.filter(t => t?.id).length;
              } catch(e) {
                console.error('Failed to insert batch starting at index', i, ':', e);
                // Continue with next batch instead of failing completely
              }
            }
          }
        } catch(e){ 
          console.error('createPlaylistWithTracks exec transaction failed', e);
          // Fallback: separate operations
          try {
            db.exec(`INSERT INTO playlists(name, tags, created_at, artist_id, code, system) VALUES ('${escName}','${escTags}',${created},${artistId},${code},${system})`);
            newId = await getLastInsertedPlaylistId();
            
            if(newId && tracks?.length){
              const now = Date.now();
              const stmts = tracks.map(track => {
                if(!track?.id) return null;
                const escId = track.id.replace(/'/g, "''");
                const escTitle = (track.name || '').replace(/'/g, "''");
                const trackDataJson = JSON.stringify(track).replace(/'/g, "''");
                return `INSERT INTO playlist_items(playlist_id, track_id, title, added_at, track_data) VALUES (${newId}, '${escId}', '${escTitle}', ${now}, '${trackDataJson}')`;
              }).filter(Boolean);
              const trackSql = `BEGIN; ${stmts.join('; ')}; COMMIT;`;
              db.exec(trackSql);
            }
          } catch(e2) {
            console.error('createPlaylistWithTracks fallback also failed', e2);
          }
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
    console.log('🗑️ removeTrack called:', { playlistId, trackId });
    try { 
      // First, let's see what tracks actually exist in this playlist
      const listQuery = `SELECT track_id FROM playlist_items WHERE playlist_id=${playlistId}`;
      console.log('🗑️ Listing all tracks in playlist:', listQuery);
      const listStmt = db.prepare?.(listQuery);
      if (listStmt) {
        const existingTracks = [];
        while(listStmt.step()) {
          const row = listStmt.getAsObject();
          existingTracks.push(row.track_id);
        }
        console.log('🗑️ Existing track IDs in playlist:', existingTracks);
        console.log('🗑️ Track ID to delete:', trackId);
        console.log('🗑️ Track ID exists in list:', existingTracks.includes(trackId));
        listStmt.free();
      }
      
      // First, check if the track exists
      const checkQuery = `SELECT COUNT(*) as count FROM playlist_items WHERE playlist_id=${playlistId} AND track_id='${trackId.replace(/'/g,"''")}'`;
      console.log('🗑️ Checking if track exists:', checkQuery);
      const checkStmt = db.prepare?.(checkQuery);
      if (checkStmt) {
        checkStmt.step();
        const beforeCount = checkStmt.getAsObject().count;
        console.log('🗑️ Tracks found before delete:', beforeCount);
        checkStmt.free();
      }
      
      const query = `DELETE FROM playlist_items WHERE playlist_id=${playlistId} AND track_id='${trackId.replace(/'/g,"''")}'`;
      console.log('🗑️ Executing query:', query);
      const result = db.exec?.(query); 
      console.log('🗑️ Delete query result:', result);
      
      // Check if the track was actually deleted
      const checkQuery2 = `SELECT COUNT(*) as count FROM playlist_items WHERE playlist_id=${playlistId} AND track_id='${trackId.replace(/'/g,"''")}'`;
      console.log('🗑️ Checking if track still exists:', checkQuery2);
      const checkStmt2 = db.prepare?.(checkQuery2);
      if (checkStmt2) {
        checkStmt2.step();
        const afterCount = checkStmt2.getAsObject().count;
        console.log('🗑️ Tracks found after delete:', afterCount);
        checkStmt2.free();
      }
      
      console.log('🗑️ Track successfully deleted from database');
      // The track count will be recalculated automatically by the subquery in refresh()
      refresh();
      notifyPlaylistSubscribers(); 
    } catch(e){ 
      console.error('🗑️ removeTrack failed:', e); 
      throw e; // Re-throw so the calling component knows about the error
    }
  }, [db, refresh]);

  const getPlaylistTracks = React.useCallback((playlistId: number): any[] => {
    if(!db) return [];
    try {
      const rows: any[] = [];
      const stmt = db.prepare?.(`SELECT track_id, track_data FROM playlist_items WHERE playlist_id=${playlistId} ORDER BY added_at ASC`)
            || db.prepare?.(`SELECT track_id, track_data FROM playlist_items WHERE playlist_id=${playlistId} ORDER BY rowid ASC`);
      if(stmt){ 
        while(stmt.step()) {
          const row = stmt.getAsObject();
          if(row.track_data) {
            try {
              // Parse stored track metadata
              const trackData = JSON.parse(row.track_data);
              rows.push(trackData);
            } catch(e) {
              // Fallback to minimal track object if JSON parsing fails
              rows.push({ id: row.track_id, name: '', durationMs: 0, artists: [], album: null });
            }
          } else {
            // Legacy data without track_data - return minimal object
            rows.push({ id: row.track_id, name: '', durationMs: 0, artists: [], album: null });
          }
        }
        stmt.free(); 
      }
      return rows;
    } catch(_){
      // Fallback simple query
      try {
        const rows: any[] = [];
        const stmt2 = db.prepare?.(`SELECT track_id, track_data FROM playlist_items WHERE playlist_id=${playlistId}`);
        if(stmt2){ 
          while(stmt2.step()) {
            const row = stmt2.getAsObject();
            if(row.track_data) {
              try {
                const trackData = JSON.parse(row.track_data);
                rows.push(trackData);
              } catch(e) {
                rows.push({ id: row.track_id, name: '', durationMs: 0, artists: [], album: null });
              }
            } else {
              rows.push({ id: row.track_id, name: '', durationMs: 0, artists: [], album: null });
            }
          }
          stmt2.free(); 
        }
        return rows;
      } catch(__){ return []; }
    }
  }, [db]);

  const getPlaylistTrackIds = React.useCallback((playlistId: number): string[] => {
    if(!db) return [];
    // Order preference: added_at if present, else rowid (insertion order)
    const orderExpr = 'added_at';
    try {
      const rows: any[] = [];
      const stmt = db.prepare?.(`SELECT track_id FROM playlist_items WHERE playlist_id=${playlistId} ORDER BY ${orderExpr} ASC`)
            || db.prepare?.(`SELECT track_id FROM playlist_items WHERE playlist_id=${playlistId} ORDER BY rowid ASC`);
      if(stmt){ while(stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); }
      return rows.map(r=> r.track_id).filter(Boolean);
    } catch(_){
      // Fallback simple query
      try {
        const rows: any[] = [];
        const stmt2 = db.prepare?.(`SELECT track_id FROM playlist_items WHERE playlist_id=${playlistId}`);
        if(stmt2){ while(stmt2.step()) rows.push(stmt2.getAsObject()); stmt2.free(); }
        return rows.map(r=> r.track_id).filter(Boolean);
      } catch(__){ return []; }
    }
  }, [db]);

  return { playlists, loading, error, refresh, createPlaylist, createPlaylistWithTracks, updatePlaylist, deletePlaylist, addTracks, removeTrack, getPlaylistTracks, getPlaylistTrackIds };
}
