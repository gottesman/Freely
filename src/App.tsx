import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LeftPanel from './components/LeftPanel';
import CenterTabs from './components/CenterTabs';
import RightPanel from './components/RightPanel';
import BottomPlayer from './components/BottomPlayer';
import LyricsOverlay from './components/LyricsOverlay';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import { DBProvider, useDB } from './core/dbIndexed';
import { PlaybackProvider, usePlaybackSelector } from './core/playback';
import TitleBar from './components/TitleBar';
import { AlertsProvider, AlertsHost, useAlerts } from './core/alerts';
import { useAppReady } from './core/ready';
import { useI18n, I18nProvider } from './core/i18n';
import { AddToPlaylistModalProvider, useGlobalAddToPlaylistModal } from './core/AddToPlaylistModalContext';
import { PromptProvider } from './core/PromptContext';
import { ContextMenuProvider } from './core/ContextMenuContext';

export default function App() {
  return (
    <I18nProvider>
      <DBProvider>
        <ContextMenuProvider>
          <PlaybackProvider>
            <AlertsProvider>
              <AddToPlaylistModalProvider>
                <Main />
              </AddToPlaylistModalProvider>
            </AlertsProvider>
          </PlaybackProvider>
        </ContextMenuProvider>
      </DBProvider>
    </I18nProvider>
  );
}

function Main() {
  const { t } = useI18n();

  // Tauri window & maximized state
  const [appWindow, setAppWindow] = useState<any>(null);
  const [maximized, setMaximized] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    const unlistenFns: (() => void)[] = [];

    const setupEventListeners = async () => {
      if (!isMounted) return;
      try {
        // dynamic import to avoid loading in non-tauri environment
        const { Window } = await import('@tauri-apps/api/window');
        if (!Window || !Window.getCurrent) {
          console.warn('[App] Tauri Window API not available');
          return;
        }

        const wnd = Window.getCurrent();
        if (!isMounted) return;
        setAppWindow(wnd);

        try {
          const isMax = await wnd.isMaximized();
          if (isMounted) setMaximized(isMax);
        } catch (e) {
          console.warn('[App] failed to read initial maximized state', e);
        }

        const unlistenMax = await wnd.listen('window:maximize', () => { if (isMounted) setMaximized(true); });
        unlistenFns.push(unlistenMax);
        const unlistenUnmax = await wnd.listen('window:unmaximize', () => { if (isMounted) setMaximized(false); });
        unlistenFns.push(unlistenUnmax);
      } catch (e) {
        // Non-critical; app should still work without Tauri window APIs
        console.debug('[App] Tauri integration not available or failed to init', e);
      }
    };

    if (document.readyState === 'interactive' || document.readyState === 'complete') {
      setupEventListeners();
    } else {
      const onDom = () => setupEventListeners();
      window.addEventListener('DOMContentLoaded', onDom);
      unlistenFns.push(() => window.removeEventListener('DOMContentLoaded', onDom));
    }

    return () => {
      isMounted = false;
      unlistenFns.forEach((u) => {
        try { u(); } catch (e) { /* swallow */ }
      });
    };
  }, []);

  // App-ready / DB ready
  const { ready: dbReady, getSetting, setSetting } = useDB();
  const { ready, states } = useAppReady(dbReady);

  // Playback current track (to keep references and id sync)
  const playbackCurrent = usePlaybackSelector(s => s.currentTrack);
  const currentTrackIdRef = useRef<string | undefined>(undefined);
  useEffect(() => { currentTrackIdRef.current = playbackCurrent?.id; }, [playbackCurrent?.id]);

  // UI state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchTriggeredAt, setSearchTriggeredAt] = useState<number>(0);
  const [searchResults, setSearchResults] = useState<any | undefined>(undefined);
  const [searchLoading, setSearchLoading] = useState(false);

  // Active tab and content ids (song/album/playlist/artist)
  const [activeTab, setActiveTab] = useState<string>('home');
  const [songInfoTrackId, setSongInfoTrackId] = useState<string | undefined>(undefined);
  const [albumInfoAlbumId, setAlbumInfoAlbumId] = useState<string | undefined>(undefined);
  const [playlistInfoPlaylistId, setPlaylistInfoPlaylistId] = useState<string | undefined>(undefined);
  const [artistInfoArtistId, setArtistInfoArtistId] = useState<string | undefined>(undefined);

  // Track panel collapsed states and widths
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(false);
  const [rightTab, setRightTab] = useState<string>('artist');

  const [leftWidth, setLeftWidth] = useState<number>(220);
  const [rightWidth, setRightWidth] = useState<number>(220);

  // Resizing / dragging indicators
  const [draggingLeft, setDraggingLeft] = useState(false);
  const [draggingRight, setDraggingRight] = useState(false);
  const [collapseIntentLeft, setCollapseIntentLeft] = useState(false);
  const [collapseIntentRight, setCollapseIntentRight] = useState(false);

  // constants
  const minPanel = 220;
  const maxPanel = 480;
  const collapseThreshold = 200;
  const collapseIntentThreshold = collapseThreshold;

  // Load persisted UI state once DB is ready (single-run)
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!dbReady || loadedRef.current) return;
    let mounted = true;
    (async () => {
      try {
        const [lw, rw, lc, rc, rtab] = await Promise.all([
          getSetting('ui.leftWidth'),
          getSetting('ui.rightWidth'),
          getSetting('ui.leftCollapsed'),
          getSetting('ui.rightCollapsed'),
          getSetting('ui.rightTab'),
        ]);
        if (!mounted) return;
        if (lw) {
          const n = parseInt(lw, 10);
          if (!isNaN(n)) setLeftWidth(Math.min(Math.max(n, minPanel), maxPanel));
        }
        if (rw) {
          const n = parseInt(rw, 10);
          if (!isNaN(n)) setRightWidth(Math.min(Math.max(n, minPanel), maxPanel));
        }
        if (lc === '1') setLeftCollapsed(true);
        if (rc === '1') setRightCollapsed(true);
        if (rtab === 'queue' || rtab === 'artist') setRightTab(rtab);
      } catch (e) {
        // fallback to localStorage
        try {
          const raw = typeof window !== 'undefined' ? window.localStorage.getItem('ui.layout.v1') : null;
          if (raw) {
            const obj = JSON.parse(raw);
            if (typeof obj.leftWidth === 'number') setLeftWidth(Math.min(Math.max(obj.leftWidth, minPanel), maxPanel));
            if (typeof obj.rightWidth === 'number') setRightWidth(Math.min(Math.max(obj.rightWidth, minPanel), maxPanel));
            if (obj.leftCollapsed === true) setLeftCollapsed(true);
            if (obj.rightCollapsed === true) setRightCollapsed(true);
            if (obj.rightTab === 'queue' || obj.rightTab === 'artist') setRightTab(obj.rightTab);
          }
        } catch (err) {
          // no-op
        }
      } finally {
        loadedRef.current = true;
      }
    })();
    return () => { mounted = false; };
  }, [dbReady, getSetting]);

  // Persist UI state when relevant values change
  useEffect(() => {
    if (!dbReady) return;
    try { setSetting('ui.leftWidth', String(leftWidth)); } catch {}
    try { setSetting('ui.rightWidth', String(rightWidth)); } catch {}
    try { setSetting('ui.leftCollapsed', leftCollapsed ? '1' : '0'); } catch {}
    try { setSetting('ui.rightCollapsed', rightCollapsed ? '1' : '0'); } catch {}
    try { setSetting('ui.rightTab', rightTab); } catch {}
    try {
      if (typeof window !== 'undefined') {
        const payload = { leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightTab };
        window.localStorage.setItem('ui.layout.v1', JSON.stringify(payload));
      }
    } catch (e) { /* ignore */ }
  }, [dbReady, leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightTab]);

  // debounced search hook
  useDebouncedSearch(searchQuery, searchTriggeredAt, (res: any) => setSearchResults(res), (b: boolean) => setSearchLoading(b));

  // Expose imageRes util on window (stable callback)
  const imageRes = useCallback((imagesUrls: Array<string | undefined | null> = [], preferred: number = 0): string | undefined => {
    if (!Array.isArray(imagesUrls) || imagesUrls.length === 0) return undefined;
    const clean = imagesUrls.map(u => {
      if (typeof u === 'string') return u.trim();
      if (u && typeof u === 'object' && typeof (u as any).url === 'string') return ((u as any).url || '').trim();
      return '';
    }).filter(Boolean) as string[];
    if (clean.length === 0) return undefined;
    if (Number.isInteger(preferred) && preferred >= 0 && preferred < clean.length && clean[preferred]) return clean[preferred];
    let idx = Math.min(Math.max(Math.floor(preferred), 0), clean.length - 1);
    for (; idx >= 0; idx--) if (clean[idx]) return clean[idx];
    return undefined;
  }, []);
  useEffect(() => {
    try { (window as any).imageRes = imageRes; } catch { /* ignore */ }
    return () => { try { (window as any).imageRes = undefined; } catch { /* ignore */ } };
  }, [imageRes]);

  // Helper to set active tab only if different (avoids re-rendering children unnecessarily)
  const setActiveTabIfDifferent = useCallback((newTab: string) => {
    setActiveTab(prev => (prev === newTab ? prev : newTab));
  }, []);

  // Handlers: memoized so they are stable references
  const handleSearch = useCallback((q?: string) => {
    setSearchQuery(q || '');
    setSearchTriggeredAt(Date.now());
  }, []);

  const handleNavigate = useCallback((dest: string) => {
    setActiveTabIfDifferent(dest);
  }, [setActiveTabIfDifferent]);

  // Selection helpers: only update id if different (avoids re-rendering SongInfo if same id)
  const handleSelectTrack = useCallback((id?: string) => {
    if (!id) return;
    setSongInfoTrackId(prev => (prev === id ? prev : id));
    setActiveTabIfDifferent('song');
  }, [setActiveTabIfDifferent]);

  const handleActivateSongInfo = useCallback(() => {
    const current = currentTrackIdRef.current;
    if (current) setSongInfoTrackId(prev => (prev === current ? prev : current));
    setActiveTabIfDifferent('song');
  }, [setActiveTabIfDifferent]);

  const handleSelectAlbum = useCallback((id?: string) => {
    if (!id) return;
    setAlbumInfoAlbumId(prev => (prev === id ? prev : id));
    setActiveTabIfDifferent('album');
  }, [setActiveTabIfDifferent]);

  const handleSelectPlaylist = useCallback((id?: string) => {
    if (!id) return;
    setPlaylistInfoPlaylistId(prev => (prev === id ? prev : id));
    setActiveTabIfDifferent('playlist');
  }, [setActiveTabIfDifferent]);

  const handleSelectArtist = useCallback((id?: string) => {
    if (!id) return;
    setArtistInfoArtistId(prev => (prev === id ? prev : id));
    setActiveTabIfDifferent('artist');
  }, [setActiveTabIfDifferent]);

  // TitleBar window actions memoized to avoid object recreation on each render
  const windowStatus = useMemo(() => ({
    maximize: async () => await appWindow?.maximize?.().catch((e: any) => { console.error(e); }),
    restore: async () => await appWindow?.unmaximize?.().catch((e: any) => { console.error(e); }),
    minimize: async () => await appWindow?.minimize?.().catch((e: any) => { console.error(e); }),
    close: async () => await appWindow?.close?.().catch((e: any) => { console.error(e); }),
  }), [appWindow]);

  // Global fallback listener for legacy 'freely:select-artist' event (attach once)
  useEffect(() => {
    const onGlobalSelect = (e: any) => {
      const id = e?.detail;
      if (!id) return;
      setArtistInfoArtistId(prev => (prev === String(id) ? prev : String(id)));
      setActiveTabIfDifferent('artist');
    };
    window.addEventListener('freely:select-artist', onGlobalSelect as EventListener);
    return () => window.removeEventListener('freely:select-artist', onGlobalSelect as EventListener);
  }, [setActiveTabIfDifferent]);

  // Drag handlers for left / right panels (stable references)
  const onDragLeft = useCallback((e: React.MouseEvent) => {
    if (leftCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;
    let rafId = 0;
    setDraggingLeft(true);
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const delta = ev.clientX - startX;
        let candidate = startWidth + delta;
        if (candidate > maxPanel) candidate = maxPanel;
        if (candidate < minPanel) candidate = minPanel;
        setLeftWidth(candidate);
        setCollapseIntentLeft(startWidth + delta < collapseIntentThreshold);
      });
    };
    const up = (ev: MouseEvent) => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('mouseleave', up);
      const delta = ev.clientX - startX;
      const finalRaw = startWidth + delta;
      if (finalRaw < collapseThreshold) {
        setLeftCollapsed(true);
        setLeftWidth(minPanel);
      }
      setDraggingLeft(false);
      setCollapseIntentLeft(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('mouseleave', up);
  }, [leftCollapsed, leftWidth]);

  const onDragRight = useCallback((e: React.MouseEvent) => {
    if (rightCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightWidth;
    let rafId = 0;
    setDraggingRight(true);
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const delta = startX - ev.clientX; // moving left increases width
        let candidate = startWidth + delta;
        if (candidate > maxPanel) candidate = maxPanel;
        if (candidate < minPanel) candidate = minPanel;
        setRightWidth(candidate);
        setCollapseIntentRight(startWidth + delta < collapseIntentThreshold);
      });
    };
    const up = (ev: MouseEvent) => {
      cancelAnimationFrame(rafId);
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
  }, [rightCollapsed, rightWidth]);

  // Expose memoized props for CenterTabs so it only re-renders when relevant values change.
  const centerTabsProps = useMemo(() => ({
    searchQuery,
    searchTrigger: searchTriggeredAt,
    searchResults,
    searchLoading,
    activeTab,
    onTabChange: setActiveTabIfDifferent,
    songTrackId: songInfoTrackId,
    albumId: albumInfoAlbumId,
    playlistId: playlistInfoPlaylistId,
    artistId: artistInfoArtistId,
    onSelectArtist: handleSelectArtist,
    onSelectAlbum: handleSelectAlbum,
    onSelectPlaylist: handleSelectPlaylist,
    onSelectTrack: handleSelectTrack,
  }), [
    searchQuery,
    searchTriggeredAt,
    searchResults,
    searchLoading,
    activeTab,
    setActiveTabIfDifferent,
    songInfoTrackId,
    albumInfoAlbumId,
    playlistInfoPlaylistId,
    artistInfoArtistId,
    handleSelectArtist,
    handleSelectAlbum,
    handleSelectPlaylist,
    handleSelectTrack,
  ]);

  // BottomPlayer handlers (memoized)
  const toggleLyrics = useCallback(() => setLyricsOpen(o => !o), []);
  const [lyricsOpen, setLyricsOpen] = useState<boolean>(false);

  const toggleQueueTab = useCallback(() => {
    setRightTab(t => (t === 'queue' ? 'artist' : 'queue'));
  }, []);

  // Provide global AddToPlaylist modal via a small wrapper component
  function GlobalAddToPlaylistModal() {
    const { isOpen, track, fromBottomPlayer, closeModal } = useGlobalAddToPlaylistModal();
    return (
      <AddToPlaylistModal
        track={track}
        isOpen={isOpen}
        onClose={closeModal}
        fromBottomPlayer={fromBottomPlayer}
      />
    );
  }

  // If app not ready show splash
  if (!ready) {
    return (
      <div className="app-loading">
        <div className="splash-box" role="status" aria-live="polite">
          <img src="splash.png" alt={t('app.title')} />
          <div className="splash-status">
            {!states.dbReady && t('loading.db')}
            {states.dbReady && !states.fontsReady && t('loading.fonts')}
            {states.fontsReady && !states.preloadReady && t('loading.services')}
            {states.preloadReady && !states.warmupDone && t('loading.warmup')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${'app'}${(draggingLeft || draggingRight) ? ' is-resizing' : ''}${maximized ? ' maximized' : ''}`}>
      <PromptProvider>
        <div className="bg" />
        <TitleBar
          title="Freely"
          icon="icon-192.png"
          onSearch={handleSearch}
          onNavigate={handleNavigate}
          activeTab={activeTab}
          windowStatus={windowStatus}
          isMaximized={maximized}
        />
        <div className="window-body">
          <div className="content layout">
            <LeftPanel
              collapsed={leftCollapsed}
              onToggle={() => setLeftCollapsed(prev => !prev)}
              width={leftWidth}
              extraClass={draggingLeft ? `panel-dragging ${collapseIntentLeft ? 'collapse-intent' : ''}` : ''}
              activePlaylistId={activeTab === 'playlist' ? playlistInfoPlaylistId : undefined}
              onSelectPlaylist={(pid) => { handleSelectPlaylist(pid); }}
              onSelectArtist={(id) => { handleSelectArtist(id); }}
              onSelectArtistActiveId={artistInfoArtistId}
              activeArtistVisible={activeTab === 'artist'}
            />

            <div
              className={`resize-handle left ${leftCollapsed ? 'disabled' : ''}`}
              onMouseDown={onDragLeft}
              role="separator"
              aria-orientation="vertical"
              aria-hidden={leftCollapsed}
              aria-label="Resize left panel"
            />

            <div className="center-area main-panels">
              <CenterTabs {...centerTabsProps} />
              <LyricsOverlay open={lyricsOpen} onClose={() => setLyricsOpen(false)} />
            </div>

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
              extraClass={draggingRight ? `panel-dragging ${collapseIntentRight ? 'collapse-intent' : ''}` : ''}
              onSelectAlbum={(id) => { handleSelectAlbum(id); }}
              onSelectPlaylist={(id) => { handleSelectPlaylist(id); }}
            />
          </div>

          <BottomPlayer
            lyricsOpen={lyricsOpen}
            onToggleLyrics={toggleLyrics}
            onActivateSongInfo={() => handleActivateSongInfo()}
            onToggleQueueTab={toggleQueueTab}
            queueActive={rightTab === 'queue'}
            onSelectArtist={(id) => handleSelectArtist(id)}
          />
        </div>

        <AlertsHost />
        <GlobalAddToPlaylistModal />
      </PromptProvider>
    </div>
  );
}

function useDebouncedSearch(query: string | undefined, trigger: number | undefined, onUpdate: (res: any) => void, setLoading: (b: boolean) => void) {
  const last = useRef<string | null>(null);
  const lastTrigger = useRef<number | null>(null);
  const timer = useRef<any>(null);

  useEffect(() => {
    if (!query || !query.trim()) {
      onUpdate(undefined);
      setLoading(false);
      last.current = null;
      lastTrigger.current = null;
      return;
    }
    const q = query.trim();
    if (last.current === q && lastTrigger.current === (trigger ?? null)) return;

    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      last.current = q;
      lastTrigger.current = trigger ?? null;
      setLoading(true);
      try {
        const client = await import('./core/spotify-client');
        const res = await client.search(q, ['track', 'artist', 'album', 'playlist'], { limit: 50 });
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
