import React from 'react'

export default function LeftPanel({ collapsed, onToggle, width }: { collapsed: boolean, onToggle: () => void, width?: number }){
  return (
  <aside className={`main-panels left-panel ${collapsed ? 'collapsed' : ''}`} style={!collapsed && width ? { width } : undefined}>
      <div className="panel-collapse-toggle left-panel-toggle" onClick={onToggle}>{collapsed ? '▶' : '◀'}</div>
      <nav className="left-nav">
        <h4>Collections</h4>
        <ul>
          <li>Playlists</li>
          <li>Liked Artists</li>
          <li>Liked Albums</li>
          <li>Liked Songs</li>
        </ul>
      </nav>
    </aside>
  )
}
