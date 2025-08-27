import React, { useEffect, useState, useRef } from 'react'
import { useI18n } from '../core/i18n'

export default function TitleBar({ title, icon, onSearch, onNavigate, activeTab, windowStatus: { maximize, restore, minimize, close }, isMaximized }: { title?: string, icon?: string, onSearch?: (q: string) => void, onNavigate?: (dest: string) => void, activeTab?: string, windowStatus: { maximize: () => void, restore: () => void, minimize: () => void, close: () => void }, isMaximized: boolean }) {
  const { t } = useI18n();
  const resolvedTitle = title || t('app.title');
  const [maximized, setMaximized] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // get maximized status from App.tsx
  useEffect(() => {
    setMaximized(isMaximized);
  }, [isMaximized]);

  return (
  <div className="titlebar">
      <div className="titlebar-left">
        {icon ? <div className="titlebar-icon" style={{ backgroundImage: `url(${icon})` }} /> : <div className="titlebar-icon placeholder" />}
  <div className="titlebar-title">{resolvedTitle}</div>
      </div>
      <div className="titlebar-nav">
  <button type="button" className={`tb-nav-btn ${activeTab==='home'?'active':''}`} aria-label={t('nav.home')} title={t('nav.home')} onClick={()=> onNavigate && onNavigate('home')}>
          <span className="material-symbols-rounded filled">home</span>
        </button>
  <button type="button" className={`tb-nav-btn ${activeTab==='settings'?'active':''}`} aria-label={t('nav.settings')} title={t('nav.settings')} onClick={()=> onNavigate && onNavigate('settings')}>
          <span className="material-symbols-rounded filled">settings</span>
        </button>
  <button type="button" className={`tb-nav-btn ${activeTab==='apis'?'active':''}`} aria-label={t('nav.dev')} title={t('nav.dev')} onClick={()=> onNavigate && onNavigate('apis')}>
          <span className="material-symbols-rounded filled">terminal</span>
        </button>
  <div className={"titlebar-search" + (activeTab==='search' ? ' search-active' : '')}>
          <span
            className="tb-search-icon material-symbols-rounded"
            onClick={() => { inputRef.current?.focus() }}
            role="button"
            aria-label={t('search.focus','Focus search')}
          >search</span>
          <input
            ref={inputRef}
            className="tb-search"
            placeholder={t('search.placeholder')}
            value={query}
                onChange={(e) => { setQuery(e.target.value); if (onSearch) onSearch(e.target.value) }}
                onKeyDown={(e) => { if (e.key === 'Enter' && onSearch) onSearch(query) }}
                onFocus={() => {
                  // Don't clear results on focus. Instead, activate the Search tab and
                  // re-trigger the current query so results repopulate if they were cleared.
                  if (onNavigate) onNavigate('search');
                  if (query && onSearch) onSearch(query);
                }}
            aria-label={t('search.action','Search')}
          />
        </div>
      </div>
      
  {/* Additional right-side custom buttons could go here */}
      <div className="titlebar-right titlebar-window-buttons">
  <button className="tb-btn tb-min" onClick={minimize} aria-label={t('window.minimize','Minimize')}>—</button>
        {maximized ? (
          <button className="tb-btn tb-restore" onClick={restore} aria-label={t('window.restore','Restore')}>❐</button>
        ) : (
          <button className="tb-btn tb-max" onClick={maximize} aria-label={t('window.maximize','Maximize')}>▢</button>
        )}
  <button className="tb-btn tb-close" onClick={close} aria-label={t('window.close','Close')}>✕</button>
      </div>
    </div>
  )
}
