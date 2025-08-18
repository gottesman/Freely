import React, { useEffect, useState } from 'react'
import Player from './components/Player'
import Library from './components/Library'
import Settings from './components/Settings'
import LeftPanel from './components/LeftPanel'
import CenterTabs from './components/CenterTabs'
import RightPanel from './components/RightPanel'
import BottomPlayer from './components/BottomPlayer'
import LyricsOverlay from './components/LyricsOverlay'
import { DBProvider, useDB } from './core/db'
import { PlaybackProvider } from './core/playback'
import TitleBar from './components/TitleBar'
import GeniusClient from './core/musicdata'
import { AlertsProvider, AlertsHost } from './core/alerts'
import { useAppReady } from './core/ready'

export default function App() {
  return (
    <DBProvider>
      <PlaybackProvider>
        <AlertsProvider>
          <Main />
          <AlertsHost />
        </AlertsProvider>
      </PlaybackProvider>
    </DBProvider>
  )
}

function Main() {
  const { ready: dbReady } = useDB()
  const { ready, states } = useAppReady(dbReady)
  const [searchQuery, setSearchQuery] = React.useState<string>('')
  const [searchTriggeredAt, setSearchTriggeredAt] = React.useState<number>(0)
  const [activeTab, setActiveTab] = React.useState<string>('home')
  // track collapsed state for side panels so their toggle buttons work
  const [leftCollapsed, setLeftCollapsed] = React.useState<boolean>(false)
  const [rightCollapsed, setRightCollapsed] = React.useState<boolean>(false)
  const [lyricsOpen, setLyricsOpen] = React.useState<boolean>(false)
  const [rightTab, setRightTab] = React.useState<string>('artist')
  // resizable panel widths (persist later if desired)
  const [leftWidth, setLeftWidth] = React.useState<number>(220)
  const [rightWidth, setRightWidth] = React.useState<number>(220)
  const minPanel = 140
  const maxPanel = 480

  const onDragLeft = (e: React.MouseEvent) => {
    if (leftCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;
    let frame = 0;
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const delta = ev.clientX - startX;
        let next = startWidth + delta;
        if (next < minPanel) next = minPanel;
        if (next > maxPanel) next = maxPanel;
        setLeftWidth(next);
      });
    };
    const up = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('mouseleave', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('mouseleave', up);
  };

  const onDragRight = (e: React.MouseEvent) => {
    if (rightCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightWidth;
    let frame = 0;
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const delta = startX - ev.clientX; // moving left increases width
        let next = startWidth + delta;
        if (next < minPanel) next = minPanel;
        if (next > maxPanel) next = maxPanel;
        setRightWidth(next);
      });
    };
    const up = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('mouseleave', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('mouseleave', up);
  };

  if (!ready) return (
    <div className="app-loading">
      <div className="splash-box" role="status" aria-live="polite">
        <img src={"splash.png"} alt="Loading Freely" />
        <div className="splash-status">
          { !states.dbReady && 'Preparing database' }
          { states.dbReady && !states.fontsReady && 'Loading fonts' }
          { states.fontsReady && !states.preloadReady && 'Connecting services' }
          { states.preloadReady && !states.warmupDone && 'Warming up' }
        </div>
      </div>
    </div>
  )

  return (
    <div className="app">
        <div className="bg">
        </div>
  <TitleBar
    title="Freely"
    icon="icon-192.png"
    onSearch={(q?: string) => { setSearchQuery(q || ''); setSearchTriggeredAt(Date.now()) }}
    onNavigate={(dest) => setActiveTab(dest)}
  activeTab={activeTab}
  />
        <div className="window-body">
          <div className="content layout">
            <LeftPanel collapsed={leftCollapsed} onToggle={() => setLeftCollapsed(prev => !prev)} width={leftWidth} />
            {/* Left resize handle */}
            <div
              className={`resize-handle left ${leftCollapsed ? 'disabled' : ''}`}
              onMouseDown={onDragLeft}
              role="separator"
              aria-orientation="vertical"
              aria-hidden={leftCollapsed}
              aria-label="Resize left panel"
            />
            <div className="center-area main-panels">
              <CenterTabs searchQuery={searchQuery} searchTrigger={searchTriggeredAt} activeTab={activeTab} onTabChange={setActiveTab} />
              <LyricsOverlay open={lyricsOpen} onClose={() => setLyricsOpen(false)} />
            </div>
            {/* Right resize handle */}
            <div
              className={`resize-handle right ${rightCollapsed ? 'disabled' : ''}`}
              onMouseDown={onDragRight}
              role="separator"
              aria-orientation="vertical"
              aria-hidden={rightCollapsed}
              aria-label="Resize right panel"
            />
            <RightPanel collapsed={rightCollapsed} onToggle={() => setRightCollapsed(prev => !prev)} width={rightWidth} activeRightTab={rightTab} onRightTabChange={setRightTab} />
          </div>
          <BottomPlayer
            lyricsOpen={lyricsOpen}
            onToggleLyrics={() => setLyricsOpen(o => !o)}
            onActivateNowPlaying={() => setActiveTab('now')}
            onToggleQueueTab={() => {
              setRightTab(t => t==='queue' ? 'artist' : 'queue');
              if(rightCollapsed) setRightCollapsed(false);
            }}
            queueActive={rightTab==='queue'}
          />
        </div>
    </div>
  )
}