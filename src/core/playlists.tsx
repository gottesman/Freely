import React from 'react';
import { useDB } from './db';

// Simple module-level pub/sub so multiple components using usePlaylists stay in sync
const playlistSubscribers = new Set<() => void>();
function notifyPlaylistSubscribers(){
  playlistSubscribers.forEach(fn => { try { fn(); } catch(_) { /* ignore */ } });
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

export function usePlaylists(){
  const { db, ready } = useDB();
  const [playlists, setPlaylists] = React.useState<PlaylistRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string|undefined>();

  const refresh = React.useCallback(()=>{
    if(!db) return;
    try {
      setLoading(true); setError(undefined);
      // opportunistic migrations
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN created_at INTEGER"); } catch(_){}
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN tags TEXT"); } catch(_){}
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN code TEXT"); } catch(_){}
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN system INTEGER DEFAULT 0"); } catch(_){}
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN artist_id TEXT"); } catch(_){}
      const rows: any[] = [];
      try {
        const stmt = db.prepare?.('SELECT p.id, p.name, p.code, p.system, p.artist_id, p.tags, p.created_at, (SELECT COUNT(1) FROM playlist_items pi WHERE pi.playlist_id = p.id) as track_count FROM playlists p ORDER BY p.system DESC, p.name ASC');
        if(stmt){
          while(stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
        }
      } catch(e){ /* ignore */ }
      setPlaylists(rows.map(r=> ({ id: r.id, name: r.name, code: r.code, system: r.system, artist_id: r.artist_id, tags: normalizeTags(r.tags), created_at: r.created_at, track_count: r.track_count })));
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

  const createPlaylist = React.useCallback(async (name: string, tags: string[] = [], opts?: { artistId?: string; code?: string; system?: boolean }) => {
    if(!db) return;
    const created = Date.now();
    const tagStr = tags.join(',');
    try {
      if(db.run){
        db.run('INSERT INTO playlists(name, tags, created_at, artist_id, code, system) VALUES (?,?,?,?,?,?)', [name, tagStr, created, opts?.artistId||null, opts?.code||null, opts?.system?1:0]);
      } else if(db.exec){
        const escName = name.replace(/'/g, "''");
        const escTags = tagStr.replace(/'/g, "''");
        const artistId = opts?.artistId ? `'${opts.artistId.replace(/'/g,"''")}'` : 'NULL';
        const code = opts?.code ? `'${opts.code.replace(/'/g,"''")}'` : 'NULL';
        const system = opts?.system ? 1 : 0;
        db.exec(`INSERT INTO playlists(name, tags, created_at, artist_id, code, system) VALUES ('${escName}','${escTags}',${created},${artistId},${code},${system})`);
      }
  refresh();
  notifyPlaylistSubscribers();
    } catch(e){ /* ignore */ }
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
  try { db.exec?.(`UPDATE playlists SET ${sets.join(', ')} WHERE id=${id}`); refresh(); notifyPlaylistSubscribers(); } catch(_){}
  }, [db, refresh, playlists]);

  const deletePlaylist = React.useCallback(async (id: number) => {
    if(!db) return;
    const p = playlists.find(pl => pl.id === id);
    if(p?.system) return; // cannot delete system playlists
  try { db.exec?.(`DELETE FROM playlist_items WHERE playlist_id=${id}`); db.exec?.(`DELETE FROM playlists WHERE id=${id}`); refresh(); notifyPlaylistSubscribers(); } catch(_){}
  }, [db, refresh, playlists]);

  const addTracks = React.useCallback(async (playlistId: number, trackIds: string[]) => {
    if(!db || !trackIds.length) return;
    const now = Date.now();
    try {
      trackIds.forEach(tid => {
        const escTid = tid.replace(/'/g, "''");
        db.exec?.(`INSERT INTO playlist_items(playlist_id, track_id, title, added_at) VALUES (${playlistId}, '${escTid}', '', ${now})`);
      });
  refresh();
  notifyPlaylistSubscribers();
    } catch(_){ }
  }, [db, refresh]);

  const removeTrack = React.useCallback(async (playlistId: number, trackId: string) => {
    if(!db) return;
  try { db.exec?.(`DELETE FROM playlist_items WHERE playlist_id=${playlistId} AND track_id='${trackId.replace(/'/g,"''")}'`); refresh(); notifyPlaylistSubscribers(); } catch(_){ }
  }, [db, refresh]);

  const getPlaylistTrackIds = React.useCallback((playlistId: number): string[] => {
    if(!db) return [];
    try {
      const rows: any[] = [];
      const stmt = db.prepare?.(`SELECT track_id FROM playlist_items WHERE playlist_id=${playlistId} ORDER BY id ASC`);
      if(stmt){ while(stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); }
      return rows.map(r=> r.track_id).filter(Boolean);
    } catch(_){ return []; }
  }, [db]);

  return { playlists, loading, error, refresh, createPlaylist, updatePlaylist, deletePlaylist, addTracks, removeTrack, getPlaylistTrackIds };
}
