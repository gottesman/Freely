import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LeftPanel from './components/LeftPanel';
import CenterTabs from './components/CenterTabs';
import RightPanel from './components/RightPanel';
import BottomPlayer from './components/BottomPlayer';
import LyricsOverlay from './components/LyricsOverlay';
import GeniusClient from './core/musicdata';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import { DBProvider, useDB } from './core/dbIndexed';
import { PlaybackProvider, usePlaybackSelector } from './core/playback';
import TitleBar from './components/TitleBar';
import { AlertsProvider, AlertsHost, useAlerts } from './core/alerts';
import { useAppReady } from './core/ready';
import { useI18n, I18nProvider } from './core/i18n';
import { PromptProvider } from './core/PromptContext';
import { ContextMenuProvider } from './core/ContextMenuContext';

// Constants for performance optimization
const UI_CONSTANTS = {
  minPanel: 220,
  maxPanel: 480,
  collapseThreshold: 200,
  collapseIntentThreshold: 200,
  searchDebounceMs: 300,
  defaultLeftWidth: 220,
  defaultRightWidth: 220
} as const;

// Combined state interfaces for better performance
interface UIState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
  rightTab: string;
  draggingLeft: boolean;
  draggingRight: boolean;
  collapseIntentLeft: boolean;
  collapseIntentRight: boolean;
}

interface SearchState {
  query: string;
  triggeredAt: number;
  results: any;
  loading: boolean;
}

interface TabState {
  activeTab: string;
  songInfoTrackId?: string;
  albumInfoAlbumId?: string;
  playlistInfoPlaylistId?: string;
  artistInfoArtistId?: string;
}

interface LyricsState {
  open: boolean;
  text?: string;
  title?: string;
  loading: boolean;
}

interface ModalState {
  open: boolean;
  track: any;
  fromBottomPlayer: boolean;
}

// Initial states
const initialUIState: UIState = {
  leftCollapsed: false,
  rightCollapsed: false,
  leftWidth: UI_CONSTANTS.defaultLeftWidth,
  rightWidth: UI_CONSTANTS.defaultRightWidth,
  rightTab: 'artist',
  draggingLeft: false,
  draggingRight: false,
  collapseIntentLeft: false,
  collapseIntentRight: false
};

const initialSearchState: SearchState = {
  query: '',
  triggeredAt: 0,
  results: undefined,
  loading: false
};

const initialTabState: TabState = {
  activeTab: 'home'
};

const initialLyricsState: LyricsState = {
  open: false,
  loading: false
};

const initialModalState: ModalState = {
  open: false,
  track: null,
  fromBottomPlayer: false
};

// Custom hooks for better organization and performance
function useWindowState() {
  const [appWindow, setAppWindow] = useState<any>(null);
  const [maximized, setMaximized] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    const unlistenFns: (() => void)[] = [];

    const setupEventListeners = async () => {
      if (!isMounted) return;
      try {
        const { Window } = await import('@tauri-apps/api/window');
        if (!Window?.getCurrent) {
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

        const unlistenMax = await wnd.listen('window:maximize', () => {
          if (isMounted) setMaximized(true);
        });
        unlistenFns.push(unlistenMax);
        
        const unlistenUnmax = await wnd.listen('window:unmaximize', () => {
          if (isMounted) setMaximized(false);
        });
        unlistenFns.push(unlistenUnmax);
      } catch (e) {
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
      unlistenFns.forEach((fn) => {
        try { fn(); } catch { /* ignore */ }
      });
    };
  }, []);

  const windowActions = useMemo(() => ({
    maximize: async () => await appWindow?.maximize?.().catch(console.error),
    restore: async () => await appWindow?.unmaximize?.().catch(console.error),
    minimize: async () => await appWindow?.minimize?.().catch(console.error),
    close: async () => await appWindow?.close?.().catch(console.error),
  }), [appWindow]);

  return { appWindow, isMaximized: maximized, windowControls: windowActions };
}

function useDebouncedSearch(searchState: SearchState, setSearchState: React.Dispatch<React.SetStateAction<SearchState>>) {
  const lastRef = useRef<{ query: string | null; trigger: number | null }>({
    query: null,
    trigger: null
  });
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const { query, triggeredAt } = searchState;
    
    if (!query?.trim()) {
      setSearchState(prev => ({ ...prev, results: undefined, loading: false }));
      lastRef.current = { query: null, trigger: null };
      return;
    }

    const trimmedQuery = query.trim();
    if (lastRef.current.query === trimmedQuery && lastRef.current.trigger === triggeredAt) {
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(async () => {
      lastRef.current = { query: trimmedQuery, trigger: triggeredAt };
      setSearchState(prev => ({ ...prev, loading: true }));
      
      try {
        const client = await import('./core/spotify-client');
        const results = await client.search(trimmedQuery, ['track', 'artist', 'album', 'playlist'], { limit: 50 });
        setSearchState(prev => ({ ...prev, results, loading: false }));
      } catch (e) {
        console.warn('search failed', e);
        setSearchState(prev => ({ ...prev, results: undefined, loading: false }));
      }
    }, UI_CONSTANTS.searchDebounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [searchState.query, searchState.triggeredAt, setSearchState]);
}

export default function App() {
  return (
    <I18nProvider>
      <DBProvider>
        <ContextMenuProvider>
          <PlaybackProvider>
            <AlertsProvider>
              <Main />
            </AlertsProvider>
          </PlaybackProvider>
        </ContextMenuProvider>
      </DBProvider>
    </I18nProvider>
  );
}

function Main() {
  const { t } = useI18n();
  const { ready: dbReady, getSetting, setSetting, getApiCache, setApiCache } = useDB();
  const { ready, states } = useAppReady(dbReady);
  const playbackCurrent = usePlaybackSelector(s => s.currentTrack);
  
  // Custom hooks for better organization
  const { isMaximized, windowControls } = useWindowState();
  
  // Consolidated state management
  const [uiState, setUIState] = useState<UIState>(initialUIState);
  const [searchState, setSearchState] = useState<SearchState>(initialSearchState);
  const [tabState, setTabState] = useState<TabState>(initialTabState);
  const [lyricsState, setLyricsState] = useState<LyricsState>(initialLyricsState);
  const [modalState, setModalState] = useState<ModalState>(initialModalState);
  
  // Refs for performance
  const currentTrackIdRef = useRef<string | undefined>(undefined);
  const loadedRef = useRef(false);

  // Custom hooks
  useDebouncedSearch(searchState, setSearchState);

  // Update current track ID ref
  useEffect(() => {
    currentTrackIdRef.current = playbackCurrent?.id;
  }, [playbackCurrent?.id]);
  // Load persisted UI state once DB is ready
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

        setUIState(prev => ({
          ...prev,
          leftWidth: lw ? Math.min(Math.max(parseInt(lw, 10), UI_CONSTANTS.minPanel), UI_CONSTANTS.maxPanel) : prev.leftWidth,
          rightWidth: rw ? Math.min(Math.max(parseInt(rw, 10), UI_CONSTANTS.minPanel), UI_CONSTANTS.maxPanel) : prev.rightWidth,
          leftCollapsed: lc === '1',
          rightCollapsed: rc === '1',
          rightTab: (rtab === 'queue' || rtab === 'artist') ? rtab : prev.rightTab
        }));
      } catch (e) {
        // Fallback to localStorage
        try {
          const raw = window.localStorage?.getItem('ui.layout.v1');
          if (raw) {
            const obj = JSON.parse(raw);
            setUIState(prev => ({
              ...prev,
              leftWidth: typeof obj.leftWidth === 'number' 
                ? Math.min(Math.max(obj.leftWidth, UI_CONSTANTS.minPanel), UI_CONSTANTS.maxPanel) 
                : prev.leftWidth,
              rightWidth: typeof obj.rightWidth === 'number' 
                ? Math.min(Math.max(obj.rightWidth, UI_CONSTANTS.minPanel), UI_CONSTANTS.maxPanel) 
                : prev.rightWidth,
              leftCollapsed: obj.leftCollapsed === true,
              rightCollapsed: obj.rightCollapsed === true,
              rightTab: (obj.rightTab === 'queue' || obj.rightTab === 'artist') ? obj.rightTab : prev.rightTab
            }));
          }
        } catch {
          // Ignore localStorage errors
        }
      } finally {
        loadedRef.current = true;
      }
    })();

    return () => { mounted = false; };
  }, [dbReady, getSetting]);

  // Persist UI state when values change
  useEffect(() => {
    if (!dbReady) return;
    
    const { leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightTab } = uiState;
    
    try {
      setSetting('ui.leftWidth', String(leftWidth));
      setSetting('ui.rightWidth', String(rightWidth));
      setSetting('ui.leftCollapsed', leftCollapsed ? '1' : '0');
      setSetting('ui.rightCollapsed', rightCollapsed ? '1' : '0');
      setSetting('ui.rightTab', rightTab);
      
      // Backup to localStorage
      const payload = { leftWidth, rightWidth, leftCollapsed, rightCollapsed, rightTab };
      window.localStorage?.setItem('ui.layout.v1', JSON.stringify(payload));
    } catch {
      // Ignore persistence errors
    }
  }, [dbReady, uiState, setSetting]);

  // debounced search hook
  useDebouncedSearch(searchState, setSearchState);

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
    setTabState(prev => prev.activeTab === newTab ? prev : { ...prev, activeTab: newTab });
  }, []);

  // Handlers: memoized so they are stable references
  const handleSearch = useCallback((q?: string) => {
    setSearchState(prev => ({
      ...prev,
      query: q || '',
      triggeredAt: Date.now()
    }));
  }, []);

  const handleNavigate = useCallback((dest: string) => {
    setActiveTabIfDifferent(dest);
  }, [setActiveTabIfDifferent]);

  // Selection helpers: only update id if different (avoids re-rendering SongInfo if same id)
  const handleSelectTrack = useCallback((id?: string) => {
    if (!id) return;
    setTabState(prev => ({ 
      ...prev, 
      songInfoTrackId: prev.songInfoTrackId === id ? prev.songInfoTrackId : id,
      activeTab: 'song'
    }));
  }, []);

  const handleActivateSongInfo = useCallback(() => {
    const current = currentTrackIdRef.current;
    if (current) {
      setTabState(prev => ({ 
        ...prev, 
        songInfoTrackId: prev.songInfoTrackId === current ? prev.songInfoTrackId : current,
        activeTab: 'song'
      }));
    }
  }, []);

  const handleSelectAlbum = useCallback((id?: string) => {
    if (!id) return;
    setTabState(prev => ({ 
      ...prev, 
      albumInfoAlbumId: prev.albumInfoAlbumId === id ? prev.albumInfoAlbumId : id,
      activeTab: 'album'
    }));
  }, []);

  const handleSelectPlaylist = useCallback((id?: string) => {
    if (!id) return;
    setTabState(prev => ({ 
      ...prev, 
      playlistInfoPlaylistId: prev.playlistInfoPlaylistId === id ? prev.playlistInfoPlaylistId : id,
      activeTab: 'playlist'
    }));
  }, []);

  const handleSelectArtist = useCallback((id?: string) => {
    if (!id) return;
    setTabState(prev => ({ 
      ...prev, 
      artistInfoArtistId: prev.artistInfoArtistId === id ? prev.artistInfoArtistId : id,
      activeTab: 'artist'
    }));
  }, []);

  // Global custom event listeners to summon info tabs
  useEffect(() => {
    function onSelectTrackEvent(e: Event) {
      try {
        const det: any = (e as CustomEvent).detail || {};
        if (det.trackId) handleSelectTrack(det.trackId);
      } catch (err) { /* ignore */ }
    }
    function onSelectAlbumEvent(e: Event) {
      try {
        const det: any = (e as CustomEvent).detail || {};
        if (det.albumId) handleSelectAlbum(det.albumId);
      } catch (err) { /* ignore */ }
    }
    function onSelectArtistEvent(e: Event) {
      try {
        const det: any = (e as CustomEvent).detail || {};
        if (det.artistId) handleSelectArtist(det.artistId);
      } catch (err) { /* ignore */ }
    }
    function onSelectPlaylistEvent(e: Event) {
      try {
        const det: any = (e as CustomEvent).detail || {};
        if (det.playlistId) handleSelectPlaylist(det.playlistId);
      } catch (err) { /* ignore */ }
    }
    window.addEventListener('freely:selectTrack', onSelectTrackEvent as EventListener);
    window.addEventListener('freely:selectAlbum', onSelectAlbumEvent as EventListener);
    window.addEventListener('freely:selectArtist', onSelectArtistEvent as EventListener);
    window.addEventListener('freely:selectPlaylist', onSelectPlaylistEvent as EventListener);
    return () => {
      window.removeEventListener('freely:selectTrack', onSelectTrackEvent as EventListener);
      window.removeEventListener('freely:selectAlbum', onSelectAlbumEvent as EventListener);
      window.removeEventListener('freely:selectArtist', onSelectArtistEvent as EventListener);
      window.removeEventListener('freely:selectPlaylist', onSelectPlaylistEvent as EventListener);
    };
  }, [handleSelectTrack, handleSelectAlbum, handleSelectArtist, handleSelectPlaylist]);

  // TitleBar window actions memoized to avoid object recreation on each render
  const windowStatus = windowControls;

  // Drag handlers for left / right panels (stable references)
  const onDragLeft = useCallback((e: React.MouseEvent) => {
    if (uiState.leftCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = uiState.leftWidth;
    let rafId = 0;
    setUIState(prev => ({ ...prev, draggingLeft: true }));
    
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const delta = ev.clientX - startX;
        let candidate = startWidth + delta;
        if (candidate > UI_CONSTANTS.maxPanel) candidate = UI_CONSTANTS.maxPanel;
        if (candidate < UI_CONSTANTS.minPanel) candidate = UI_CONSTANTS.minPanel;
        setUIState(prev => ({ 
          ...prev, 
          leftWidth: candidate,
          collapseIntentLeft: startWidth + delta < UI_CONSTANTS.collapseIntentThreshold
        }));
      });
    };
    
    const up = (ev: MouseEvent) => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('mouseleave', up);
      const delta = ev.clientX - startX;
      const finalRaw = startWidth + delta;
      
      setUIState(prev => ({
        ...prev,
        leftCollapsed: finalRaw < UI_CONSTANTS.collapseThreshold ? true : prev.leftCollapsed,
        leftWidth: finalRaw < UI_CONSTANTS.collapseThreshold ? UI_CONSTANTS.minPanel : prev.leftWidth,
        draggingLeft: false,
        collapseIntentLeft: false
      }));
    };
    
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('mouseleave', up);
  }, [uiState.leftCollapsed, uiState.leftWidth]);

  const onDragRight = useCallback((e: React.MouseEvent) => {
    if (uiState.rightCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = uiState.rightWidth;
    let rafId = 0;
    setUIState(prev => ({ ...prev, draggingRight: true }));
    
    const move = (ev: MouseEvent) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const delta = startX - ev.clientX; // moving left increases width
        let candidate = startWidth + delta;
        if (candidate > UI_CONSTANTS.maxPanel) candidate = UI_CONSTANTS.maxPanel;
        if (candidate < UI_CONSTANTS.minPanel) candidate = UI_CONSTANTS.minPanel;
        setUIState(prev => ({ 
          ...prev, 
          rightWidth: candidate,
          collapseIntentRight: startWidth + delta < UI_CONSTANTS.collapseIntentThreshold
        }));
      });
    };
    
    const up = (ev: MouseEvent) => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('mouseleave', up);
      const delta = startX - ev.clientX;
      const finalRaw = startWidth + delta;
      
      setUIState(prev => ({
        ...prev,
        rightCollapsed: finalRaw < UI_CONSTANTS.collapseThreshold ? true : prev.rightCollapsed,
        rightWidth: finalRaw < UI_CONSTANTS.collapseThreshold ? UI_CONSTANTS.minPanel : prev.rightWidth,
        draggingRight: false,
        collapseIntentRight: false
      }));
    };
    
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('mouseleave', up);
  }, [uiState.rightCollapsed, uiState.rightWidth]);

  // Expose memoized props for CenterTabs so it only re-renders when relevant values change.
  const centerTabsProps = useMemo(() => ({
    searchQuery: searchState.query,
    searchTrigger: searchState.triggeredAt,
    searchResults: searchState.results,
    searchLoading: searchState.loading,
    activeTab: tabState.activeTab,
    onTabChange: setActiveTabIfDifferent,
    songTrackId: tabState.songInfoTrackId,
    albumId: tabState.albumInfoAlbumId,
    playlistId: tabState.playlistInfoPlaylistId,
    artistId: tabState.artistInfoArtistId,
  }), [
    searchState.query,
    searchState.triggeredAt,
    searchState.results,
    searchState.loading,
    tabState.activeTab,
    setActiveTabIfDifferent,
    tabState.songInfoTrackId,
    tabState.albumInfoAlbumId,
    tabState.playlistInfoPlaylistId,
    tabState.artistInfoArtistId,
  ]);

  // BottomPlayer handlers (memoized)
  const toggleLyrics = useCallback(() => setLyricsState(prev => ({ ...prev, open: !prev.open })), []);

  // Additional lyrics state that wasn't consolidated
  const [lyricsText, setLyricsText] = useState<string | undefined>(undefined);
  const [lyricsTitle, setLyricsTitle] = useState<string | undefined>(undefined);

  // Fetch lyrics when overlay opens for the current playing track
  const playbackCurrentTrack = usePlaybackSelector(s => s.currentTrack);
  useEffect(() => {
    let cancelled = false;
    if (!lyricsState.open) return undefined;
    (async () => {
      if (!playbackCurrentTrack) return;
      setLyricsState(prev => ({ ...prev, loading: true }));
      setLyricsText(undefined);
      setLyricsTitle(undefined);
      try {
        const gc = new GeniusClient();
        // Attempt to find a Genius song via search using track + primary artist
        const q = `${playbackCurrentTrack.name} ${playbackCurrentTrack.artists?.[0]?.name || ''}`.trim();
        const res = await gc.search(q);
        const hit = res.hits && res.hits.length ? res.hits[0] : undefined;

        // Check DB cache first (best-effort). Keys:
        // - LYRICS:GENIUS:<songId>
        // - LYRICS:URL:<trackUrl>
        let cachedLyrics: any = null;
        try {
          if (hit && hit.id) cachedLyrics = await getApiCache(`LYRICS:GENIUS:${hit.id}`);
        } catch (_) { cachedLyrics = null; }
        try {
          if (!cachedLyrics && playbackCurrentTrack?.url) cachedLyrics = await getApiCache(`LYRICS:URL:${playbackCurrentTrack.url}`);
        } catch (_) { /* ignore */ }

        if (cachedLyrics && cachedLyrics.lyrics) {
          if (!cancelled) {
            setLyricsText(cachedLyrics.lyrics);
            setLyricsTitle(cachedLyrics.title || `${playbackCurrentTrack.name} — ${playbackCurrentTrack.artists?.map((a:any)=>a.name).join(', ')}`);
          }
        } else {
          let lyricsRes: any = null;
          if (hit && hit.id) {
            lyricsRes = await gc.getLyricsForSong(hit.id);
          }
          
          const finalLyrics = lyricsRes?.lyrics || undefined;
          if (!cancelled) {
            setLyricsText(finalLyrics);
            setLyricsTitle(finalLyrics ? `${playbackCurrentTrack.name} — ${playbackCurrentTrack.artists?.map((a:any)=>a.name).join(', ')}` : undefined);
          }

          // Persist into DB for future use (best-effort)
          try {
            if (lyricsRes && lyricsRes.lyrics && hit && hit.id) {
              await setApiCache(`LYRICS:GENIUS:${hit.id}`, { lyrics: lyricsRes.lyrics, title: `${playbackCurrentTrack.name} — ${playbackCurrentTrack.artists?.map((a:any)=>a.name).join(', ')}` });
            }
            if (finalLyrics && playbackCurrentTrack?.url) {
              await setApiCache(`LYRICS:URL:${playbackCurrentTrack.url}`, { lyrics: finalLyrics, title: `${playbackCurrentTrack.name} — ${playbackCurrentTrack.artists?.map((a:any)=>a.name).join(', ')}` });
            }
          } catch (e) { /* ignore persistence errors */ }
        }
      } catch (e) {
        // ignore errors; lyricsText stays undefined
      } finally {
        if (!cancelled) setLyricsState(prev => ({ ...prev, loading: false }));
      }
    })();
    return () => { cancelled = true; };
  }, [lyricsState.open, playbackCurrentTrack, getApiCache, setApiCache]);

  const toggleQueueTab = useCallback(() => {
    setUIState(prev => ({ 
      ...prev, 
      rightTab: prev.rightTab === 'queue' ? 'artist' : 'queue' 
    }));
  }, []);

  // Direct event-driven AddToPlaylist modal host (replaces former Provider/Context)
  useEffect(() => {
    function onOpen(ev: Event){
      const d = (ev as CustomEvent).detail || {};
      const track = d.track || d.tracks?.[0] || d.trackData || (Array.isArray(d.trackIds) && d.trackIds.length ? { id: d.trackIds[0] } : null);
      if(track){
        setModalState(prev => ({
          ...prev,
          open: true,
          track,
          fromBottomPlayer: !!d.fromBottomPlayer
        }));
      }
    }
    window.addEventListener('freely:openAddToPlaylistModal', onOpen as any);
    return () => window.removeEventListener('freely:openAddToPlaylistModal', onOpen as any);
  }, []);
  
  const closeAddModal = useCallback(() => { 
    setModalState(prev => ({ ...prev, open: false, track: null, fromBottomPlayer: false })); 
  }, []);

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
    <div className={`${'app'}${(uiState.draggingLeft || uiState.draggingRight) ? ' is-resizing' : ''}${isMaximized ? ' maximized' : ''}`}>
      <PromptProvider>
        <div className="bg" />
        <TitleBar
          title="Freely"
          icon="icon-192.png"
          onSearch={handleSearch}
          onNavigate={handleNavigate}
          activeTab={tabState.activeTab}
          windowStatus={windowStatus}
          isMaximized={isMaximized}
        />
        <div className="window-body">
          <div className="content layout">
            <LeftPanel
              collapsed={uiState.leftCollapsed}
              onToggle={() => setUIState(prev => ({ ...prev, leftCollapsed: !prev.leftCollapsed }))}
              width={uiState.leftWidth}
              extraClass={uiState.draggingLeft ? `panel-dragging ${uiState.collapseIntentLeft ? 'collapse-intent' : ''}` : ''}
              activePlaylistId={tabState.activeTab === 'playlist' ? tabState.playlistInfoPlaylistId : undefined}
              onSelectArtistActiveId={tabState.artistInfoArtistId}
              activeArtistVisible={tabState.activeTab === 'artist'}
            />

            <div
              className={`resize-handle left ${uiState.leftCollapsed ? 'disabled' : ''}`}
              onMouseDown={onDragLeft}
              role="separator"
              aria-orientation="vertical"
              aria-hidden={uiState.leftCollapsed}
              aria-label="Resize left panel"
            />

            <div className="center-area main-panels">
              <CenterTabs {...centerTabsProps} />
              <LyricsOverlay
                open={lyricsState.open}
                onClose={() => setLyricsState(prev => ({ ...prev, open: false }))}
                lyrics={lyricsState.loading ? t('np.loading') : lyricsText}
                title={lyricsTitle}
              />
            </div>

            <div
              className={`resize-handle right ${uiState.rightCollapsed ? 'disabled' : ''}`}
              onMouseDown={onDragRight}
              role="separator"
              aria-orientation="vertical"
              aria-hidden={uiState.rightCollapsed}
              aria-label="Resize right panel"
            />

            <RightPanel
              collapsed={uiState.rightCollapsed}
              onToggle={() => setUIState(prev => ({ ...prev, rightCollapsed: !prev.rightCollapsed }))}
              width={uiState.rightWidth}
              activeRightTab={uiState.rightTab}
              onRightTabChange={(tab) => setUIState(prev => ({ ...prev, rightTab: tab }))}
              extraClass={uiState.draggingRight ? `panel-dragging ${uiState.collapseIntentRight ? 'collapse-intent' : ''}` : ''}
              onSelectAlbum={(id) => { handleSelectAlbum(id); }}
              onSelectPlaylist={(id) => { handleSelectPlaylist(id); }}
            />
          </div>

          <BottomPlayer
            lyricsOpen={lyricsState.open}
            onToggleLyrics={toggleLyrics}
            onToggleQueueTab={toggleQueueTab}
            queueActive={uiState.rightTab === 'queue'}
          />
        </div>

        <AlertsHost />
        <AddToPlaylistModal
          track={modalState.track}
          isOpen={modalState.open}
          onClose={closeAddModal}
          fromBottomPlayer={modalState.fromBottomPlayer}
        />
      </PromptProvider>
    </div>
  );
}
