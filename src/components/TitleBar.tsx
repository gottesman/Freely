import React, { useEffect, useState } from 'react'

export default function TitleBar({ title = 'Freely Player', icon, accent = '#1db954' }: { title?: string, icon?: string, accent?: string }) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const isMax = await (window as any).electron.window.isMaximized()
        if (mounted) setMaximized(!!isMax)
      } catch (e) {}
    })()
    // listen for maximize/unmaximize events from main
    try {
      (window as any).electron.window.onMaximizeChanged((v: boolean) => {
        setMaximized(!!v)
        const root = document.querySelector('.app')
        if (root) {
          if (v) root.classList.add('maximized')
          else root.classList.remove('maximized')
        }
      })
    } catch (e) {}
    return () => { mounted = false }
  }, [])

  const onMin = () => (window as any).electron.window.minimize()
  const onMax = () => (window as any).electron.window.maximize()
  const onRestore = () => (window as any).electron.window.restore()
  const onToggleMax = () => { maximized ? onRestore() : onMax() }
  const onClose = () => (window as any).electron.window.close()

  return (
    <div className="titlebar" style={{ ['--accent' as any]: accent }}>
      <div className="titlebar-left">
        {icon ? <img src={icon} className="titlebar-icon" /> : <div className="titlebar-icon placeholder" />}
        <div className="titlebar-title">{title}</div>
      </div>
      <div className="titlebar-right">
        <button className="tb-btn tb-min" onClick={onMin} aria-label="Minimize">—</button>
        {maximized ? (
          <button className="tb-btn tb-restore" onClick={onToggleMax} aria-label="Restore">❐</button>
        ) : (
          <button className="tb-btn tb-max" onClick={onToggleMax} aria-label="Maximize">▢</button>
        )}
        <button className="tb-btn tb-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
    </div>
  )
}
