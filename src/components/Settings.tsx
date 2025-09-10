import React, { useState } from 'react'
import { useI18n } from '../core/i18n'
import { useDB } from '../core/dbIndexed'
import { usePlaylists } from '../core/playlists'
import { usePrompt } from '../core/PromptContext'
import { useAlerts } from '../core/alerts'
import { getAudioDevices, getAudioSettings, setAudioSettings, reinitializeAudio, AudioDevice, AudioSettings } from '../core/tauriCommands'

export default function Settings(){
  const { exportJSON, importJSON, clearCache, clearLocalData, getSetting, setSetting } = useDB()
  const [accent, setAccent] = useState('#6b21a8')
  const { lang, setLang, t } = useI18n();
  const [importFileName, setImportFileName] = useState<string>('')
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [audioSettings, setAudioSettingsState] = useState<AudioSettings | null>(null)
  const [isLoadingAudio, setIsLoadingAudio] = useState(false)
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
      
      // Load audio settings
      try {
        // First get devices (this initializes BASS)
        const devicesResult = await getAudioDevices()
        const devices = devicesResult.devices || []
        setAudioDevices(devices)

        // Then get settings (now that BASS is initialized)
        const settingsResult = await getAudioSettings()
        
        if (mounted) {
          // If no device is set in settings, select the default device
          let settings = settingsResult.settings
          if (settings.device === undefined || settings.device === null || settings.device === -1) {
            const defaultDevice = devices.find(device => device.is_default)
            if (defaultDevice) {
              settings = { ...settings, device: defaultDevice.id }
              // Update the backend with the default device selection
              try {
                await setAudioSettings({ device: defaultDevice.id })
              } catch (error) {
                console.error('Failed to set default device:', error)
              }
            }
          }
          setAudioSettingsState(settings)
        }
      } catch (error) {
        console.error('Failed to load audio settings:', error)
      }
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

  async function updateAudioSetting(key: keyof AudioSettings, value: any) {
    if (!audioSettings) return;
    
    setIsLoadingAudio(true);
    try {
      const newSettings = { ...audioSettings, [key]: value };
      setAudioSettingsState(newSettings);
      
      const result = await setAudioSettings({ [key]: value });
      
      // Show appropriate message based on whether reinitialization occurred
      if (result.reinitialized) {
        pushAlert(t('settings.audio.reinitialized'), 'info');
      } else {
        pushAlert(t('settings.audio.updated'), 'info');
      }
      
      // Refresh settings to get the actual current state after reinitialization
      if (result.reinitialized) {
        try {
          const settingsResult = await getAudioSettings();
          setAudioSettingsState(settingsResult.settings);
        } catch (refreshError) {
          console.warn('Failed to refresh settings after reinitialization:', refreshError);
        }
      }
    } catch (error) {
      console.error('Failed to update audio setting:', error);
      pushAlert(t('settings.audio.updateFailed'), 'error');
      // Revert on error
      try {
        const settingsResult = await getAudioSettings();
        setAudioSettingsState(settingsResult.settings);
      } catch {}
    } finally {
      setIsLoadingAudio(false);
    }
  }

  async function refreshAudioSettings() {
    setIsLoadingAudio(true);
    try {
      // First get devices (this ensures BASS is initialized)
      const devicesResult = await getAudioDevices();
      setAudioDevices(devicesResult.devices || []);
      
      // Then get settings (now that BASS is initialized)
      const settingsResult = await getAudioSettings();
      setAudioSettingsState(settingsResult.settings);
      
      pushAlert(t('settings.audio.refreshed'), 'info');
    } catch (error) {
      console.error('Failed to refresh audio settings:', error);
      pushAlert(t('settings.audio.refreshFailed'), 'error');
    } finally {
      setIsLoadingAudio(false);
    }
  }

  async function applyDeviceChange(deviceId: number) {
    if (!audioSettings) return;
    
    const confirmed = await prompt.confirm(t('settings.audio.deviceChange.confirm'));
    if (!confirmed) return;
    
    setIsLoadingAudio(true);
    try {
      await reinitializeAudio(deviceId, audioSettings.sample_rate, audioSettings.buffer_size);
      
      // Reload settings after reinitialization
      const settingsResult = await getAudioSettings();
      setAudioSettingsState({ ...settingsResult.settings, device: deviceId });
      
      pushAlert(t('settings.audio.deviceChanged'), 'info');
    } catch (error) {
      console.error('Failed to change audio device:', error);
      pushAlert(t('settings.audio.deviceChangeFailed'), 'error');
    } finally {
      setIsLoadingAudio(false);
    }
  }

  async function applyAdvancedSettings() {
    if (!audioSettings) return;
    
    const confirmed = await prompt.confirm(t('settings.audio.advancedSettings.confirm'));
    if (!confirmed) return;
    
    setIsLoadingAudio(true);
    try {
      await reinitializeAudio(audioSettings.device, audioSettings.sample_rate, audioSettings.buffer_size);
      pushAlert(t('settings.audio.advancedApplied'), 'info');
    } catch (error) {
      console.error('Failed to apply advanced audio settings:', error);
      pushAlert(t('settings.audio.advancedFailed'), 'error');
    } finally {
      setIsLoadingAudio(false);
    }
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

        {/* Audio Settings */}
        <section className="settings-section" aria-labelledby="audio-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">volume_up</span>
            <h3 id="audio-header" className="settings-section-title">{t('settings.audio')}</h3>
            <button 
              className="btn btn-subtle" 
              onClick={refreshAudioSettings}
              disabled={isLoadingAudio}
              title={t('settings.audio.refresh')}
            >
              <span className="material-symbols-rounded" aria-hidden="true" style={{fontSize:18}}>refresh</span>
              {t('settings.audio.refresh')}
            </button>
          </div>
          <div className="settings-card">
            {audioSettings ? (
              <div className="settings-fields">
                {/* Current Audio Status */}
                <div className="settings-field">
                  <div className="settings-info-panel">
                    <p className="settings-info-title">{t('settings.audio.currentStatus')}</p>
                    <div className="settings-info-grid">
                      <span>{t('settings.audio.device')}: {
                        audioDevices.find(device => device.id === audioSettings.device)?.name || 
                        t('settings.audio.device.unknown')
                      }</span>
                      <span>{t('settings.audio.sampleRate')}: {audioSettings.sample_rate}Hz</span>
                      <span>{t('settings.audio.bitDepth')}: {audioSettings.bit_depth}-bit</span>
                      <span>{t('settings.audio.outputChannels')}: {audioSettings.output_channels} {t('settings.audio.outputChannels.channels')}</span>
                    </div>
                  </div>
                </div>

                {/* Audio Device */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="audio-device">{t('settings.audio.device')}</label>
                  <select 
                    id="audio-device" 
                    value={audioSettings.device} 
                    onChange={e => applyDeviceChange(parseInt(e.target.value))}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    {audioDevices.map(device => (
                      <option 
                        key={device.id} 
                        value={device.id}
                        disabled={!device.is_enabled}
                      >
                        {device.name} 
                        {device.is_default && ` ${t('settings.audio.device.default')}`}
                        {!device.is_enabled && ` ${t('settings.audio.device.disabled')}`}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Sample Rate */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="sample-rate">{t('settings.audio.sampleRate')}</label>
                  <select 
                    id="sample-rate" 
                    value={audioSettings.sample_rate} 
                    onChange={e => setAudioSettingsState({...audioSettings, sample_rate: parseInt(e.target.value)})}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={44100}>{t('settings.audio.sampleRate.44100')}</option>
                    <option value={48000}>{t('settings.audio.sampleRate.48000')}</option>
                    <option value={88200}>{t('settings.audio.sampleRate.88200')}</option>
                    <option value={96000}>{t('settings.audio.sampleRate.96000')}</option>
                    <option value={176400}>{t('settings.audio.sampleRate.176400')}</option>
                    <option value={192000}>{t('settings.audio.sampleRate.192000')}</option>
                  </select>
                </div>

                {/* Bit Depth */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="bit-depth">{t('settings.audio.bitDepth')}</label>
                  <select 
                    id="bit-depth" 
                    value={audioSettings.bit_depth} 
                    onChange={e => setAudioSettingsState({...audioSettings, bit_depth: parseInt(e.target.value)})}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={16}>{t('settings.audio.bitDepth.16')}</option>
                    <option value={24}>{t('settings.audio.bitDepth.24')}</option>
                    <option value={32}>{t('settings.audio.bitDepth.32')}</option>
                  </select>
                </div>

                {/* Buffer Size */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="buffer-size">{t('settings.audio.bufferSize')}</label>
                  <select 
                    id="buffer-size" 
                    value={audioSettings.buffer_size} 
                    onChange={e => setAudioSettingsState({...audioSettings, buffer_size: parseInt(e.target.value)})}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={256}>{t('settings.audio.bufferSize.256')}</option>
                    <option value={512}>{t('settings.audio.bufferSize.512')}</option>
                    <option value={1024}>{t('settings.audio.bufferSize.1024')}</option>
                    <option value={2048}>{t('settings.audio.bufferSize.2048')}</option>
                    <option value={4096}>{t('settings.audio.bufferSize.4096')}</option>
                  </select>
                </div>

                {/* Network Buffer */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="net-buffer">{t('settings.audio.netBuffer')}</label>
                  <select 
                    id="net-buffer" 
                    value={audioSettings.net_buffer} 
                    onChange={e => updateAudioSetting('net_buffer', parseInt(e.target.value))}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={1000}>{t('settings.audio.netBuffer.1000')}</option>
                    <option value={2000}>{t('settings.audio.netBuffer.2000')}</option>
                    <option value={5000}>{t('settings.audio.netBuffer.5000')}</option>
                    <option value={10000}>{t('settings.audio.netBuffer.10000')}</option>
                    <option value={15000}>{t('settings.audio.netBuffer.15000')}</option>
                  </select>
                </div>

                {/* Output Channels */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="output-channels">{t('settings.audio.outputChannels')}</label>
                  <select 
                    id="output-channels" 
                    value={audioSettings.output_channels} 
                    onChange={e => setAudioSettingsState({...audioSettings, output_channels: parseInt(e.target.value)})}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={1}>{t('settings.audio.outputChannels.1')}</option>
                    <option value={2}>{t('settings.audio.outputChannels.2')}</option>
                    <option value={6}>{t('settings.audio.outputChannels.6')}</option>
                    <option value={8}>{t('settings.audio.outputChannels.8')}</option>
                  </select>
                </div>

                {/* Exclusive Mode */}
                <div className="settings-field inline">
                  <label className="settings-field-label">
                    <input
                      type="checkbox"
                      checked={audioSettings.exclusive_mode}
                      onChange={e => setAudioSettingsState({...audioSettings, exclusive_mode: e.target.checked})}
                      disabled={isLoadingAudio}
                      style={{ marginRight: '8px' }}
                    />
                    {t('settings.audio.exclusiveMode')}
                  </label>
                  <p className="settings-field-hint">{t('settings.audio.exclusiveMode.hint')}</p>
                </div>

                {/* Apply Advanced Settings Button */}
                <div className="settings-field">
                  <div className="btn-row">
                    <button 
                      className="btn" 
                      onClick={applyAdvancedSettings}
                      disabled={isLoadingAudio}
                    >
                      {isLoadingAudio ? (
                        <>
                          <span className="material-symbols-rounded spinning" aria-hidden="true" style={{fontSize:18}}>refresh</span>
                          {t('settings.audio.applying')}
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-rounded" aria-hidden="true" style={{fontSize:18}}>tune</span>
                          {t('settings.audio.applyAdvanced')}
                        </>
                      )}
                    </button>
                  </div>
                  <p className="settings-field-hint">
                    {t('settings.audio.applyAdvanced.hint')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="loading-state">
                <span className="material-symbols-rounded spinning">refresh</span>
                {t('settings.audio.loading')}
              </div>
            )}
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
