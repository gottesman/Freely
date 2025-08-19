import React, { useState } from 'react'
import { useI18n } from '../core/i18n'
import { useDB } from '../core/db'

export default function Settings(){
  const { db, exportJSON, importJSON } = useDB()
  const [text, setText] = useState('')
  const { getSetting, setSetting } = useDB()
  const [accent, setAccent] = useState('#6b21a8')
  const { lang, setLang, t } = useI18n();

  React.useEffect(()=>{
    let mounted = true
    ;(async ()=>{
      try{
        const a = await getSetting('ui.accent')
        if(a && mounted){ setAccent(a); document.documentElement.style.setProperty('--accent', a) }
      }catch{}
    })()
    return ()=>{ mounted=false }
  },[])

  async function saveAccent(){
    document.documentElement.style.setProperty('--accent', accent)
    try{ await setSetting('ui.accent', accent) }catch{}
  }

  async function onExport(){
    const j = await exportJSON()
    const blob = new Blob([j],{type:'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'freely-export.json'; a.click()
    URL.revokeObjectURL(url)
  }

  async function onImportUpload(e:React.ChangeEvent<HTMLInputElement>){
    const f = e.target.files?.[0]; if(!f) return
    const s = await f.text()
    await importJSON(s)
  alert(t('settings.imported'))
  }

  return (
    <div>
      <h4>{t('settings.appearance')}</h4>
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:12}}>
        <label style={{fontSize:13}}>{t('settings.accent')}</label>
        <input type="color" value={accent} onChange={e=>setAccent(e.target.value)} />
        <button className="btn" onClick={saveAccent}>{t('settings.save')}</button>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:20}}>
        <label style={{fontSize:13}}>{t('settings.language')}</label>
        <select value={lang} onChange={e=>setLang(e.target.value)}>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </div>
      <div style={{marginBottom:12}}>
        <button className="btn" onClick={onExport}>{t('settings.export')}</button>
      </div>
      <div style={{marginBottom:12}}>
        <input type="file" accept="application/json" onChange={onImportUpload} aria-label={t('settings.import.placeholder')} />
      </div>
      <PluginList />
    </div>
  )
}

function PluginList(){
  // Discover local plugins in /plugins folder (development)
  const [plugins, setPlugins] = React.useState<any[]>([])
  const { t } = useI18n();
  React.useEffect(()=>{
    fetch('/plugins/index.json').then(r=>r.json()).then(setPlugins).catch(()=>setPlugins([]))
  },[])
  return (
    <div>
  <h4>{t('plugins.detected')}</h4>
      <div className="list">
        {plugins.map((p:any)=> (
          <div className="item" key={p.name}>
            <div>{p.name}</div>
            <div style={{fontSize:12}}>{p.version}</div>
          </div>
        ))}
  {plugins.length===0 && <div style={{opacity:0.7}}>{t('plugins.none')}</div>}
      </div>
    </div>
  )
}
