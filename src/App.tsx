import React, { useEffect, useRef, useState, useCallback } from 'react'
import LeftPanel from './components/LeftPanel'
import CenterTabs from './components/CenterTabs'
import RightPanel from './components/RightPanel'
import BottomPlayer from './components/BottomPlayer'
import LyricsOverlay from './components/LyricsOverlay'
import AddToPlaylistModal from './components/AddToPlaylistModal'
import { DBProvider, useDB } from './core/db'
import { PlaybackProvider, usePlayback } from './core/playback'
import TitleBar from './components/TitleBar'
import { AlertsProvider, AlertsHost, useAlerts } from './core/alerts'
import { useAppReady } from './core/ready'
import { useI18n } from './core/i18n'
import { I18nProvider } from './core/i18n'
import { AddToPlaylistModalProvider, useGlobalAddToPlaylistModal } from './core/AddToPlaylistModalContext'
import { PromptProvider } from './core/PromptContext'

export default function App() {
  return (
    <I18nProvider>
      <DBProvider>
        <PlaybackProvider>
          <AlertsProvider>
            <AddToPlaylistModalProvider>
                <Main />
              </AddToPlaylistModalProvider>
          </AlertsProvider>
        </PlaybackProvider>
  </DBProvider>
    </I18nProvider>
  )
}


function Main() {
  const { ready: dbReady, getSetting, setSetting } = useDB()
  const { ready, states } = useAppReady(dbReady)
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [searchTriggeredAt, setSearchTriggeredAt] = useState<number>(0)
  const [searchResults, setSearchResults] = useState<any | undefined>(undefined)
  const [searchLoading, setSearchLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('home')
  const [songInfoTrackId, setSongInfoTrackId] = useState<string | undefined>(undefined)
  const [albumInfoAlbumId, setAlbumInfoAlbumId] = useState<string | undefined>(undefined)
  const [playlistInfoPlaylistId, setPlaylistInfoPlaylistId] = useState<string | undefined>(undefined)
  const [artistInfoArtistId, setArtistInfoArtistId] = useState<string | undefined>(undefined)
  const currentTrackIdRef = useRef<string | undefined>(undefined)
  const { currentTrack: playbackCurrent } = usePlayback();
  // Attempt to subscribe to playback changes if exposed on window (best-effort)
  // Keep ref synced with playback hook (simpler than IPC event subscription)
  useEffect(()=>{ currentTrackIdRef.current = playbackCurrent?.id; }, [playbackCurrent?.id]);
  // track collapsed state for side panels
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false)
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(false)
  const [lyricsOpen, setLyricsOpen] = useState<boolean>(false)
  const [rightTab, setRightTab] = useState<string>('artist')
  // resizable panel widths
  const [leftWidth, setLeftWidth] = useState<number>(220)
  const [rightWidth, setRightWidth] = useState<number>(220)
  const minPanel = 220; // minimum visible width
  const maxPanel = 480
  const collapseThreshold = 200;
  const collapseIntentThreshold = collapseThreshold;
  const [draggingLeft, setDraggingLeft] = useState(false);
  const [draggingRight, setDraggingRight] = useState(false);
  const [collapseIntentLeft, setCollapseIntentLeft] = useState(false);
  const [collapseIntentRight, setCollapseIntentRight] = useState(false);

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

  // Wire debounced search to update searchResults. Pass searchTriggeredAt so re-triggering
  // the same query (e.g. clicking the search icon again) forces a refresh.
  useDebouncedSearch(searchQuery, searchTriggeredAt, (res:any) => setSearchResults(res), (b:boolean) => setSearchLoading(b));

  // Fallback global listener: in case some consumers dispatch a global event when
  // selecting an artist (legacy code), respond by opening the artist tab.
  React.useEffect(() => {
    function onGlobalSelect(e: any) {
      const id = e?.detail;
      if (!id) return;
      setArtistInfoArtistId(String(id));
      setActiveTab('artist');
    }
    window.addEventListener('freely:select-artist', onGlobalSelect as EventListener);
    return () => window.removeEventListener('freely:select-artist', onGlobalSelect as EventListener);
  }, []);

  // Memoize handlers that are passed down to avoid unnecessary re-renders
  const handleSearch = useCallback((q?: string) => {
    setSearchQuery(q || '');
    setSearchTriggeredAt(Date.now());
  }, []);

  const handleNavigate = useCallback((dest: string) => setActiveTab(dest), []);

  function persistLocal(){
    try {
      const payload = { leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightTab };
      window.localStorage.setItem('ui.layout.v1', JSON.stringify(payload));
    } catch(e){}
  }

  // Resolve a preferred image URL from an array of image URLs.
  // - imagesUrls: array of image URL strings (may contain falsy values)
  // - preferred: zero-based preferred index; if out of range we'll fallback to the first available
  const imageRes = useCallback((imagesUrls: Array<string|undefined|null> = [], preferred: number = 0): string | undefined => {
    if (!imagesUrls || !Array.isArray(imagesUrls) || imagesUrls.length === 0) return undefined;
    const clean = imagesUrls.map(u => {
      if (typeof u === 'string') return u.trim();
      if (u && typeof u === 'object' && typeof (u as any).url === 'string') return ((u as any).url || '').trim();
      return '';
    }).filter(Boolean) as string[];
    if (clean.length === 0) return undefined;
    // If preferred is within bounds and non-empty, return it.
    if (Number.isInteger(preferred) && preferred >= 0 && preferred < clean.length && clean[preferred]) return clean[preferred];
    // Otherwise, prefer the previous available index (preferred-1, preferred-2, ... 0)
    let idx = Math.min(Math.max(Math.floor(preferred), 0), clean.length - 1);
    for (; idx >= 0; idx--) {
      if (clean[idx]) return clean[idx];
    }
    // No previous found; return undefined
    return undefined;
  }, []);

  // Expose globally on window for legacy consumers that expect a helper
  useEffect(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).imageRes = imageRes;
    } catch (e) {}
    return () => {
      try { (window as any).imageRes = undefined; } catch(e) {}
    };
  }, [imageRes]);

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
      <div className={"app" + (draggingLeft || draggingRight ? ' is-resizing' : '')}>
      <PromptProvider>
        <div className="bg" />
        <TitleBar
          title="Freely"
          icon="icon-192.png"
          onSearch={handleSearch}
          onNavigate={handleNavigate}
          activeTab={activeTab}
        />
        <div className="window-body">
          <div className="content layout">
            <LeftPanel
              collapsed={leftCollapsed}
              onToggle={() => setLeftCollapsed(prev => !prev)}
              width={leftWidth}
              extraClass={draggingLeft ? `panel-dragging ${collapseIntentLeft ? 'collapse-intent': ''}` : ''}
              activePlaylistId={activeTab==='playlist' ? playlistInfoPlaylistId : undefined}
              onSelectPlaylist={(pid)=> { setPlaylistInfoPlaylistId(prev => { if(prev===pid) return prev; return pid; }); setActiveTab('playlist'); }}
              onSelectArtist={(id)=> { setArtistInfoArtistId(id); setActiveTab('artist'); }}
              // Provide currently active artist id so the left panel can highlight it
              onSelectArtistActiveId={artistInfoArtistId}
              activeArtistVisible={activeTab === 'artist'}
            />
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
              <CenterTabs
                searchQuery={searchQuery}
                searchTrigger={searchTriggeredAt}
                searchResults={searchResults}
                searchLoading={searchLoading}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                songTrackId={songInfoTrackId}
                albumId={albumInfoAlbumId}
                playlistId={playlistInfoPlaylistId}
                artistId={artistInfoArtistId}
                onSelectArtist={(id)=> { setArtistInfoArtistId(id); setActiveTab('artist'); }}
                onSelectAlbum={(id)=> { setAlbumInfoAlbumId(id); setActiveTab('album'); }}
                onSelectPlaylist={(id)=> { setPlaylistInfoPlaylistId(prev => { if(prev===id) return prev; return id; }); setActiveTab('playlist'); }}
                onSelectTrack={(id)=> { setSongInfoTrackId(id); setActiveTab('song'); }}
              />
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
            <RightPanel
              collapsed={rightCollapsed}
              onToggle={() => setRightCollapsed(prev => !prev)}
              width={rightWidth}
              activeRightTab={rightTab}
              onRightTabChange={setRightTab}
              extraClass={draggingRight ? `panel-dragging ${collapseIntentRight ? 'collapse-intent': ''}` : ''}
              onSelectAlbum={(id) => { setAlbumInfoAlbumId(id); setActiveTab('album'); }}
              onSelectPlaylist={(id) => { setPlaylistInfoPlaylistId(prev => { if(prev===id) return prev; return id; }); setActiveTab('playlist'); }}
            />
          </div>
          <BottomPlayer
            lyricsOpen={lyricsOpen}
            onToggleLyrics={() => setLyricsOpen(o => !o)}
            onActivateSongInfo={() => { if(currentTrackIdRef.current){ setSongInfoTrackId(currentTrackIdRef.current); } setActiveTab('song'); }}
            onToggleQueueTab={() => {
              // Toggle between queue and artist tabs without forcing expansion.
              // Previously we auto-expanded the right panel when activating the queue;
              // requirement change: preserve collapsed state.
              setRightTab(t => t==='queue' ? 'artist' : 'queue');
            }}
            queueActive={rightTab==='queue'}
            onSelectArtist={(id)=> { setArtistInfoArtistId(id); setActiveTab('artist'); }}
          />
        </div>
  <AlertsHost />
  <GlobalAddToPlaylistModal />
  </PromptProvider>
    </div>
  )
}

// Debounced search effect (placed after Main for clarity)
function useDebouncedSearch(query: string | undefined, trigger: number | undefined, onUpdate: (res: any) => void, setLoading: (b: boolean) => void){
  const last = React.useRef<string | null>(null);
  const lastTrigger = React.useRef<number | null>(null);
  const timer = React.useRef<any>(null);

  React.useEffect(() => {
    if (!query || !query.trim()) {
      // clear results if empty
      onUpdate(undefined);
      setLoading(false);
      last.current = null;
      lastTrigger.current = null;
      return;
    }
    const q = query.trim();
    // If same as last requested and same trigger, skip
    if (last.current === q && lastTrigger.current === (trigger ?? null)) return;

    // Debounce 300ms
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      last.current = q;
      lastTrigger.current = trigger ?? null;
      setLoading(true);
      try {
        const res = await (await import('./core/spotify-client')).search(q, ['track','artist','album','playlist'], { limit: 50 });
        console.log('[search] query=', q, 'response=', res);
        onUpdate(res);
      } catch (e) {
        console.warn('search failed', e);
        onUpdate(undefined);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => { clearTimeout(timer.current); };
  }, [query, trigger, onUpdate, setLoading]);
}


// Global modal component that renders the AddToPlaylistModal using context
function GlobalAddToPlaylistModal() {
  const { isOpen, track, fromBottomPlayer, closeModal } = useGlobalAddToPlaylistModal();
  const { push: pushAlert } = useAlerts();

  return (
    <AddToPlaylistModal
      track={track}
      isOpen={isOpen}
      onClose={closeModal}
      fromBottomPlayer={fromBottomPlayer}
      onAdded={(playlistId, playlistName) => {
        // Modal handles its own alerts, no need for duplicate here
      }}
      // Easy animation customization - uncomment and modify as needed:
      animationDurations={{
        regular: 1.5,        // Very slow to test if it works
        bottomPlayer: 1.0,   // Slow bottom player modal
        backdrop: 2.0        // Very slow backdrop fade
      }}
    />
  );
}