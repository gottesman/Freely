import React from 'react';
import { useDB } from './db';

export interface PlaylistRecord {
  id: number;
  name: string;
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
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN created_at INTEGER"); } catch(_){}
      try { db.exec?.("ALTER TABLE playlists ADD COLUMN tags TEXT"); } catch(_){}
      const rows: any[] = [];
      try {
        const stmt = db.prepare?.('SELECT p.id, p.name, p.tags, p.created_at, (SELECT COUNT(1) FROM playlist_items pi WHERE pi.playlist_id = p.id) as track_count FROM playlists p ORDER BY p.name ASC');
        if(stmt){
          while(stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
        }
      } catch(e){ /* ignore */ }
      setPlaylists(rows.map(r=> ({ id: r.id, name: r.name, tags: normalizeTags(r.tags), created_at: r.created_at, track_count: r.track_count })));
    } catch(e:any){ setError(e.message||String(e)); }
    finally { setLoading(false); }
  }, [db]);

  React.useEffect(()=>{ if(ready) refresh(); }, [ready, refresh]);

  const createPlaylist = React.useCallback(async (name: string, tags: string[] = []) => {
    if(!db) return;
    const created = Date.now();
    const tagStr = tags.join(',');
    try {
      if(db.run){
        db.run('INSERT INTO playlists(name, tags, created_at) VALUES (?,?,?)', [name, tagStr, created]);
      } else if(db.exec){
        const escName = name.replace(/'/g, "''");
        const escTags = tagStr.replace(/'/g, "''");
        db.exec(`INSERT INTO playlists(name, tags, created_at) VALUES ('${escName}','${escTags}',${created})`);
      }
      refresh();
    } catch(e){ /* ignore */ }
  }, [db, refresh]);

  const updatePlaylist = React.useCallback(async (id: number, patch: { name?: string; tags?: string[] }) => {
    if(!db) return;
    const sets: string[] = [];
    if(patch.name !== undefined) sets.push(`name='${patch.name.replace(/'/g, "''")}'`);
    if(patch.tags !== undefined) sets.push(`tags='${patch.tags.join(',').replace(/'/g, "''")}'`);
    if(!sets.length) return;
    try { db.exec?.(`UPDATE playlists SET ${sets.join(', ')} WHERE id=${id}`); refresh(); } catch(_){}
  }, [db, refresh]);

  const deletePlaylist = React.useCallback(async (id: number) => {
    if(!db) return;
    try { db.exec?.(`DELETE FROM playlist_items WHERE playlist_id=${id}`); db.exec?.(`DELETE FROM playlists WHERE id=${id}`); refresh(); } catch(_){}
  }, [db, refresh]);

  return { playlists, loading, error, refresh, createPlaylist, updatePlaylist, deletePlaylist };
}
