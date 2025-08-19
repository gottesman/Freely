import React, { useEffect, useState } from 'react'
import { useI18n } from '../core/i18n'
import { useDB } from '../core/db'

export default function Library(){
  const { t } = useI18n();
  const { db } = useDB()
  const [plays, setPlays] = useState<any[]>([])

  useEffect(()=>{
    if (!db) return
    try{
      const stmt = db.prepare('SELECT * FROM plays ORDER BY played_at DESC LIMIT 50')
      const rows:any[] = []
      while(stmt.step()) rows.push(stmt.getAsObject())
      stmt.free()
      setPlays(rows)
    }catch(e){ console.warn(e) }
  },[db])

  return (
    <div>
  <h4>{t('library.recentHistory')}</h4>
      <div className="list">
        {plays.map(p => (
          <div className="item" key={p.id}>
            <div>{p.title}</div>
            <div style={{fontSize:12,opacity:0.8}}>{new Date(p.played_at||0).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  )
}