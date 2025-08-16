import React, { useEffect, useState } from 'react'
import Player from './components/Player'
import Library from './components/Library'
import Settings from './components/Settings'
import LeftPanel from './components/LeftPanel'
import CenterTabs from './components/CenterTabs'
import RightPanel from './components/RightPanel'
import BottomPlayer from './components/BottomPlayer'
import { DBProvider, useDB } from './core/db'
import TitleBar from './components/TitleBar'

export default function App() {
  return (
    <DBProvider>
      <Main />
    </DBProvider>
  )
}

function Main() {
  const { ready } = useDB()
  const [searchQuery, setSearchQuery] = React.useState<string>('')
  const [searchTriggeredAt, setSearchTriggeredAt] = React.useState<number>(0)
  if (!ready) return <div style={{padding:20}}>Initializing database...</div>
  return (
    <div className="app">
        <div className="bg">
        </div>
  <TitleBar title="Freely" icon="logo/icon-192.png" onSearch={(q?: string) => { setSearchQuery(q || ''); setSearchTriggeredAt(Date.now()) }} />
        <div className="window-body">
          <div className="content layout">
            <LeftPanel collapsed={false} onToggle={() => {}} />
            <div className="center-area">
              <CenterTabs searchQuery={searchQuery} searchTrigger={searchTriggeredAt} />
            </div>
            <RightPanel collapsed={false} onToggle={() => {}} />
          </div>
        </div>
        <BottomPlayer />
      </div>
  )
}