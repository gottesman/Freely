import React, { useState } from 'react'
import { useDB } from '../core/db'

export default function Settings(){
  const { db, exportJSON, importJSON } = useDB()
  const [text, setText] = useState('')

  async function onExport(){
    const j = await exportJSON()
    const blob = new Blob([j],{type:'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'myplayer-export.json'; a.click()
    URL.revokeObjectURL(url)
  }

  async function onImportUpload(e:React.ChangeEvent<HTMLInputElement>){
    const f = e.target.files?.[0]; if(!f) return
    const s = await f.text()
    await importJSON(s)
    alert('Importado OK — recarga la app si es necesario')
  }

  return (
    <div>
      <div style={{marginBottom:12}}>
        <button className="btn" onClick={onExport}>Exportar cuenta y configuración</button>
      </div>
      <div style={{marginBottom:12}}>
        <input type="file" accept="application/json" onChange={onImportUpload} />
      </div>
      <PluginList />
    </div>
  )
}

function PluginList(){
  // Discover local plugins in /plugins folder (development)
  const [plugins, setPlugins] = React.useState<any[]>([])
  React.useEffect(()=>{
    fetch('/plugins/index.json').then(r=>r.json()).then(setPlugins).catch(()=>setPlugins([]))
  },[])
  return (
    <div>
      <h4>Plugins detectados</h4>
      <div className="list">
        {plugins.map((p:any)=> (
          <div className="item" key={p.name}>
            <div>{p.name}</div>
            <div style={{fontSize:12}}>{p.version}</div>
          </div>
        ))}
        {plugins.length===0 && <div style={{opacity:0.7}}>No se encontraron plugins. Coloca manifests en /public/plugins/</div>}
      </div>
    </div>
  )
}
