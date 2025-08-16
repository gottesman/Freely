import React from 'react'

export default function RightPanel({ collapsed, onToggle }: { collapsed: boolean, onToggle: () => void }){
  return (
    <aside className={`right-panel ${collapsed ? 'collapsed' : ''}`}>
      <div className="right-panel-toggle" onClick={onToggle}>{collapsed ? '◀' : '▶'}</div>
      <div className="right-content">
        <h4>More from artist</h4>
        <div>(Artist suggestions)</div>
        <h4>Queue</h4>
        <div>(Current play queue)</div>
      </div>
    </aside>
  )
}
