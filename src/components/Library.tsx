import React, { useEffect, useState } from 'react'
import { useI18n } from '../core/i18n'
import { useDB } from '../core/dbIndexed'

export default function Library() {
  const { t } = useI18n();
  // The useDB hook now also provides a `ready` state, which is crucial.
  const { db, ready } = useDB()
  const [plays, setPlays] = useState<any[]>([])

  useEffect(() => {
    // We must wait for the DB to be ready before attempting to query it.
    if (!ready || !db) return

    const fetchRecentPlays = async () => {
      try {
        // This code performs the equivalent of `SELECT * FROM plays ORDER BY played_at DESC LIMIT 50`.
        // To do this efficiently, we iterate backwards over an index on the `played_at` field.
        // NOTE: This requires an index named 'played_at' on the 'plays' object store.
        // You would add this in your DBProvider's `onupgradeneeded` function:
        //   const store = dbInstance.createObjectStore('plays', ...);
        //   store.createIndex('played_at', 'played_at');

        const tx = db.transaction('plays', 'readonly');
        const store = tx.objectStore('plays');
        const index = store.index('played_at');

        // We wrap the cursor logic in a Promise to use it with async/await.
        const recentPlays = await new Promise<any[]>((resolve, reject) => {
          const rows: any[] = [];
          // The `openCursor` direction 'prev' gets items in descending order (newest first).
          const cursorRequest = index.openCursor(null, 'prev');

          cursorRequest.onerror = () => reject(cursorRequest.error);
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            // If the cursor is valid and we haven't reached our limit of 50...
            if (cursor && rows.length < 50) {
              rows.push(cursor.value);
              cursor.continue(); // ...move to the next item.
            } else {
              // Otherwise, we're done. Resolve the promise with the collected rows.
              resolve(rows);
            }
          };
        });

        setPlays(recentPlays);

      } catch (e) {
        console.warn("Could not fetch recent plays. Does the 'played_at' index exist?", e)
      }
    }

    fetchRecentPlays();

  }, [db, ready]) // The effect now depends on `ready` as well as `db`.

  return (
    <div>
      <h4>{t('library.recentHistory')}</h4>
      <div className="list">
        {plays.map(p => (
          <div className="item" key={p.id}>
            <div>{p.title}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {new Date(p.played_at || 0).toLocaleString()}
            </div>
          </div>
        ))}
        {ready && plays.length === 0 && (
          <div className="item" style={{opacity: 0.6}}>No recent plays found.</div>
        )}
      </div>
    </div>
  )
}