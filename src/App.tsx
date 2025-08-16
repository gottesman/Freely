import React, { useEffect, useState } from 'react'
import Player from './components/Player'
import Library from './components/Library'
import Settings from './components/Settings'
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
  if (!ready) return <div style={{padding:20}}>Initializing database...</div>
  return (
    <div className="app">
        <div className="bg">
        </div>
        <TitleBar title="Freely" icon="logo/icon-192.png" />
        <div className="window-body">
          <div className="content">
            <div className="column" style={{ flex: 1 }}>
              <h3 className="header">Freely — Biblioteca</h3>
              <Library />
            </div>
            <div className="column" style={{ width: 420 }}>
              <h3 className="header">Reproductor</h3>
              <Player />
            </div>
            <div className="column" style={{ width: 320 }}>
              <h3 className="header">Configuración / Plugins</h3>
              <Settings />
            </div>
          </div>
        </div>
      </div>
  )
}