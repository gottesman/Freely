import React, { useState } from 'react'
import { useI18n } from '../core/i18n'
import { useDB } from '../core/dbIndexed'
import { usePlaylists } from '../core/playlists'
import { usePrompt } from '../core/PromptContext'
import { useAlerts } from '../core/alerts'

export default function Settings(){
  const { exportJSON, importJSON, clearCache, clearLocalData, getSetting, setSetting } = useDB()
  const [accent, setAccent] = useState('#6b21a8')
  const { lang, setLang, t } = useI18n();
  const [importFileName, setImportFileName] = useState<string>('')
  usePlaylists();
  const prompt = usePrompt();
  const { push: pushAlert } = useAlerts();

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
    setImportFileName(f.name)
    const s = await f.text()
  await importJSON(s)
  pushAlert(t('settings.imported'), 'info')
  }

  async function onClearCache() {
    const ok = await prompt.confirm(t('settings.data.confirm'));
    if(!ok) return;
    try { await clearCache(); pushAlert(t('settings.data.cache.cleared'), 'info'); }
    catch (error) { console.error('Failed to clear cache:', error); pushAlert('Failed to clear cache. Check console for details.', 'error'); }
  }

  async function onClearLocalData() {
    const ok = await prompt.confirm(t('settings.data.confirm'));
    if(!ok) return;
    try {
      await clearLocalData();
      try { window.dispatchEvent(new CustomEvent('freely:localDataCleared')); } catch(_) {}
      try { if(location.hash) location.hash = ''; } catch(_) {}
      pushAlert(t('settings.data.local.cleared'), 'info');
    } catch (error) { console.error('Failed to clear local data:', error); pushAlert('Failed to clear local data. Check console for details.', 'error'); }
  }

  return (
    <div className="settings-page">
      <div className="settings-sections">
        {/* Appearance */}
        <section className="settings-section" aria-labelledby="appearance-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">palette</span>
            <h3 id="appearance-header" className="settings-section-title">{t('settings.appearance')}</h3>
          </div>
          <div className="settings-card">
            <div className="settings-fields">
              <div className="settings-field inline">
                <label className="settings-field-label" htmlFor="accent-color">{t('settings.accent')}</label>
                <div className="settings-color-wrap">
                  <input id="accent-color" type="color" value={accent} onChange={e=>setAccent(e.target.value)} className="settings-color-input" aria-label={t('settings.accent')} />
                  <button className="btn btn-subtle" onClick={saveAccent}>{t('settings.save')}</button>
                </div>
              </div>
              <div className="settings-field inline">
                <label className="settings-field-label" htmlFor="language-select">{t('settings.language')}</label>
                <select id="language-select" value={lang} onChange={e=>setLang(e.target.value)} className="settings-control-select" aria-label={t('settings.language')}>
                  <option value="en">English</option>
                  <option value="es">Español</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        {/* Import / Export */}
        <section className="settings-section" aria-labelledby="import-export-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">file_upload</span>
            <h3 id="import-export-header" className="settings-section-title">Import & Export</h3>
          </div>
          <div className="settings-card">
            <div className="btn-row">
              <button className="btn" onClick={onExport}>
                <span className="material-symbols-rounded" aria-hidden="true" style={{fontSize:18}}>upload</span>
                {t('settings.export')}
              </button>
              <div className="file-input-wrap">
                <input id="import-file" className="file-input-hidden" type="file" accept="application/json" onChange={onImportUpload} aria-label={t('settings.import.placeholder')} />
                <label htmlFor="import-file" className="file-input-visual">
                  <span className="material-symbols-rounded" aria-hidden="true" style={{fontSize:18}}>download</span>
                  {t('settings.import') || 'Import'}
                  {importFileName && <span className="file-input-filename" title={importFileName}>{importFileName}</span>}
                </label>
              </div>
            </div>
            <p className="settings-field-hint">{t('settings.import.placeholder')}</p>
          </div>
        </section>

        {/* Plugins */}
        <section className="settings-section" aria-labelledby="plugins-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">extension</span>
            <h3 id="plugins-header" className="settings-section-title">{t('plugins.detected')}</h3>
          </div>
          <div className="settings-card">
            <PluginList />
          </div>
        </section>

        {/* Data Management */}
        <section className="settings-section" aria-labelledby="data-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">database</span>
            <h3 id="data-header" className="settings-section-title">{t('settings.data')}</h3>
          </div>
          <div className="settings-warning" role="note">
            <span className="material-symbols-rounded" aria-hidden="true" style={{fontSize:20}}>warning</span>
            <div>{t('settings.data.warning')}</div>
          </div>
          <div className="settings-card tight" aria-live="polite">
            <div className="settings-fields">
              <div className="settings-field">
                <div className="btn-row">
                  <button className="btn btn-danger" onClick={onClearCache}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={{fontSize:18}}>delete</span>
                    {t('settings.data.cache.clear')}
                  </button>
                </div>
                <p className="settings-field-hint">{t('settings.data.cache.description')}</p>
              </div>
              <div className="settings-field">
                <div className="btn-row">
                  <button className="btn btn-danger" onClick={onClearLocalData}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={{fontSize:18}}>delete_forever</span>
                    {t('settings.data.local.clear')}
                  </button>
                </div>
                <p className="settings-field-hint">{t('settings.data.local.description')}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function PluginList(){
  const [plugins, setPlugins] = React.useState<any[]>([])
  const { t } = useI18n();
  React.useEffect(()=>{
    fetch('/plugins/index.json').then(r=>r.json()).then(setPlugins).catch(()=>setPlugins([]))
  },[])
  if(plugins.length === 0) return <div className="plugin-empty">{t('plugins.none')}</div>
  return (
    <div className="plugin-grid">
      {plugins.map((p:any)=> (
        <div className="plugin-card" key={p.name}>
          <div className="title">{p.name}</div>
          <div className="meta">v{p.version}</div>
        </div>
      ))}
    </div>
  )
}
