import React, { useEffect, useState, useRef } from 'react'

export default function TitleBar({ title = 'Freely', icon, onSearch }: { title?: string, icon?: string, onSearch?: (q: string) => void }) {
  const [maximized, setMaximized] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

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
        const root = document.querySelector('body')
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
  <div className="titlebar" onDoubleClick={onToggleMax}>
      <div className="titlebar-left">
        {icon ? <div className="titlebar-icon" style={{ backgroundImage: `url(${icon})` }} /> : <div className="titlebar-icon placeholder" />}
        <div className="titlebar-title">{title}</div>
      </div>
      <div className="titlebar-search">
        <span
          className="tb-search-icon"
          onClick={() => { inputRef.current?.focus() }}
          role="button"
          aria-hidden={false}
        >
          {/* simple magnifier SVG */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className="tb-search"
          placeholder="Find your music..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); if (onSearch) onSearch(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && onSearch) onSearch(query) }}
          aria-label="Search"
        />
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
