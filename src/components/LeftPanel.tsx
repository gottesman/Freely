import React from 'react'

export default function LeftPanel({ collapsed, onToggle }: { collapsed: boolean, onToggle: () => void }){
  return (
    <aside className={`left-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="left-panel-toggle" onClick={onToggle}>{collapsed ? '▶' : '◀'}</div>
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
