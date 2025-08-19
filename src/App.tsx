import React, { useEffect, useRef } from 'react'
import LeftPanel from './components/LeftPanel'
import CenterTabs from './components/CenterTabs'
import RightPanel from './components/RightPanel'
import BottomPlayer from './components/BottomPlayer'
import LyricsOverlay from './components/LyricsOverlay'
import { DBProvider, useDB } from './core/db'
import { PlaybackProvider } from './core/playback'
import TitleBar from './components/TitleBar'
import { AlertsProvider, AlertsHost } from './core/alerts'
import { useAppReady } from './core/ready'
import { useI18n } from './core/i18n'
import { I18nProvider } from './core/i18n'

export default function App() {
  return (
    <I18nProvider>
      <DBProvider>
        <PlaybackProvider>
          <AlertsProvider>
            <Main />
            <AlertsHost />
          </AlertsProvider>
        </PlaybackProvider>
      </DBProvider>
    </I18nProvider>
  )
}

function Main() {
  const { ready: dbReady } = useDB()
  const { ready, states } = useAppReady(dbReady)
  const { t } = useI18n();
  const { getSetting, setSetting } = useDB();
  const [searchQuery, setSearchQuery] = React.useState<string>('')
  const [searchTriggeredAt, setSearchTriggeredAt] = React.useState<number>(0)
  const [activeTab, setActiveTab] = React.useState<string>('home')
  // track collapsed state for side panels
  const [leftCollapsed, setLeftCollapsed] = React.useState<boolean>(false)
  const [rightCollapsed, setRightCollapsed] = React.useState<boolean>(false)
  const [lyricsOpen, setLyricsOpen] = React.useState<boolean>(false)
  const [rightTab, setRightTab] = React.useState<string>('artist')
  // resizable panel widths
  const [leftWidth, setLeftWidth] = React.useState<number>(220)
  const [rightWidth, setRightWidth] = React.useState<number>(220)
  const minPanel = 220; // minimum visible width
  const maxPanel = 480
  const collapseThreshold = 200;
  const collapseIntentThreshold = collapseThreshold;
  const [draggingLeft, setDraggingLeft] = React.useState(false);
  const [draggingRight, setDraggingRight] = React.useState(false);
  const [collapseIntentLeft, setCollapseIntentLeft] = React.useState(false);
  const [collapseIntentRight, setCollapseIntentRight] = React.useState(false);

  const loadedRef = useRef(false);
  // Load persisted UI state once DB is ready (with localStorage fallback)
  useEffect(()=>{
    if(!dbReady || loadedRef.current) return;
    (async()=>{
      let applied = false;
      try {
        const [lw, rw, lc, rc, rtab] = await Promise.all([
          getSetting('ui.leftWidth'),
          getSetting('ui.rightWidth'),
          getSetting('ui.leftCollapsed'),
          getSetting('ui.rightCollapsed'),
          getSetting('ui.rightTab')
        ]);
        if(lw){ const n = parseInt(lw,10); if(!isNaN(n)){ setLeftWidth(Math.min(Math.max(n, minPanel), maxPanel)); applied = true; } }
        if(rw){ const n = parseInt(rw,10); if(!isNaN(n)){ setRightWidth(Math.min(Math.max(n, minPanel), maxPanel)); applied = true; } }
        if(lc === '1'){ setLeftCollapsed(true); applied = true; }
        if(rc === '1'){ setRightCollapsed(true); applied = true; }
        if(rtab === 'queue' || rtab === 'artist'){ setRightTab(rtab); applied = true; }
      } catch(e){}
      // Fallback to localStorage if DB yielded nothing
      if(!applied && typeof window !== 'undefined'){
        try {
          const raw = window.localStorage.getItem('ui.layout.v1');
          if(raw){
            const obj = JSON.parse(raw);
            if(typeof obj.leftWidth === 'number') setLeftWidth(Math.min(Math.max(obj.leftWidth, minPanel), maxPanel));
            if(typeof obj.rightWidth === 'number') setRightWidth(Math.min(Math.max(obj.rightWidth, minPanel), maxPanel));
            if(obj.leftCollapsed === true) setLeftCollapsed(true);
            if(obj.rightCollapsed === true) setRightCollapsed(true);
            if(obj.rightTab === 'queue' || obj.rightTab === 'artist') setRightTab(obj.rightTab);
          }
        } catch(e){}
      }
      loadedRef.current = true;
    })();
  }, [dbReady, getSetting, maxPanel, minPanel]);

  // Persist relevant UI state when they change (debounced via effect ordering is fine given low frequency)
  // Persist to DB + mirror to localStorage
  // Persist UI state (batch to reduce duplicated effects)
  useEffect(()=>{
    if(!dbReady) return;
    try { setSetting('ui.leftWidth', String(leftWidth)); } catch{}
    try { setSetting('ui.rightWidth', String(rightWidth)); } catch{}
    try { setSetting('ui.leftCollapsed', leftCollapsed ? '1':'0'); } catch{}
    try { setSetting('ui.rightCollapsed', rightCollapsed ? '1':'0'); } catch{}
    try { setSetting('ui.rightTab', rightTab); } catch{}
    if(typeof window !== 'undefined') persistLocal();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbReady, leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightTab]);

  function persistLocal(){
    try {
      const payload = { leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightTab };
      window.localStorage.setItem('ui.layout.v1', JSON.stringify(payload));
    } catch(e){}
  }

  const onDragLeft = (e: React.MouseEvent) => {
    if (leftCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;
    let frame = 0;
    setDraggingLeft(true);
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const delta = ev.clientX - startX;
        let candidate = startWidth + delta;
        if (candidate > maxPanel) candidate = maxPanel;
        if (candidate < minPanel) candidate = minPanel; // don't render below min
        setLeftWidth(candidate);
        const raw = startWidth + delta;
  setCollapseIntentLeft(raw < collapseIntentThreshold);
      });
    };
    const up = (ev: MouseEvent) => {
      cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('mouseleave', up);
      const delta = ev.clientX - startX;
      const finalRaw = startWidth + delta;
      if (finalRaw < collapseThreshold) {
        setLeftCollapsed(true);
        // restore width for when expanded again
        setLeftWidth(minPanel);
      }
      setDraggingLeft(false);
      setCollapseIntentLeft(false);
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
    setDraggingRight(true);
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const delta = startX - ev.clientX; // moving left increases width
        let candidate = startWidth + delta;
        if (candidate > maxPanel) candidate = maxPanel;
        if (candidate < minPanel) candidate = minPanel;
        setRightWidth(candidate);
        const raw = startWidth + delta;
  setCollapseIntentRight(raw < collapseIntentThreshold);
      });
    };
    const up = (ev: MouseEvent) => {
      cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('mouseleave', up);
      const delta = startX - ev.clientX;
      const finalRaw = startWidth + delta;
      if (finalRaw < collapseThreshold) {
        setRightCollapsed(true);
        setRightWidth(minPanel);
      }
      setDraggingRight(false);
      setCollapseIntentRight(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('mouseleave', up);
  };

  if (!ready) return (
    <div className="app-loading">
      <div className="splash-box" role="status" aria-live="polite">
        <img src={"splash.png"} alt={t('app.title')} />
        <div className="splash-status">
          { !states.dbReady && t('loading.db') }
          { states.dbReady && !states.fontsReady && t('loading.fonts') }
          { states.fontsReady && !states.preloadReady && t('loading.services') }
          { states.preloadReady && !states.warmupDone && t('loading.warmup') }
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
            <LeftPanel collapsed={leftCollapsed} onToggle={() => setLeftCollapsed(prev => !prev)} width={leftWidth} extraClass={draggingLeft ? `panel-dragging ${collapseIntentLeft ? 'collapse-intent': ''}` : ''} />
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
            <RightPanel collapsed={rightCollapsed} onToggle={() => setRightCollapsed(prev => !prev)} width={rightWidth} activeRightTab={rightTab} onRightTabChange={setRightTab} extraClass={draggingRight ? `panel-dragging ${collapseIntentRight ? 'collapse-intent': ''}` : ''} />
          </div>
          <BottomPlayer
            lyricsOpen={lyricsOpen}
            onToggleLyrics={() => setLyricsOpen(o => !o)}
            onActivateNowPlaying={() => setActiveTab('now')}
            onToggleQueueTab={() => {
              // Toggle between queue and artist tabs without forcing expansion.
              // Previously we auto-expanded the right panel when activating the queue;
              // requirement change: preserve collapsed state.
              setRightTab(t => t==='queue' ? 'artist' : 'queue');
            }}
            queueActive={rightTab==='queue'}
          />
        </div>
    </div>
  )
}