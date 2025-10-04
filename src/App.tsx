import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import LeftPanel from './components/LeftPanel';
import CenterTabs from './components/CenterPanel';
import RightPanel from './components/RightPanel';
import MainPlayer from './components/MainPlayer';
import SmallPlayer from './components/SmallPlayer';
import LyricsTab from './components/CenterPanel/LyricsTab';
import GeniusClient from './core/Genius';
import MusixmatchClient, { SyncedLyrics } from './core/LyricsProviders';
import AddToPlaylistModal from './components/Utilities/PlaylistModal';
import { DBProvider, useDB } from './core/Database';
import { PlaybackProvider, usePlaybackSelector } from './core/Playback';
import TitleBar from './components/TitleBar';
import { AlertsProvider, AlertsHost } from './core/Alerts';
import { useAppReady } from './core/Ready';
import { useI18n, I18nProvider } from './core/i18n';
import { PromptProvider } from './core/PromptContext';
import { runTauriCommand } from './core/TauriCommands';
import { DownloadsProvider } from './core/Downloads';
import { ContextMenuProvider } from './core/ContextMenu';
import { frontendLogger } from './core/FrontendLogger';

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
  previousRightTab: string; // Track previous tab to return to when closing lyrics
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
  previousRightTab: 'artist',
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
          frontendLogger.warn('[App] Tauri Window API not available');
          return;
        }

        const wnd = Window.getCurrent();
        if (!isMounted) return;
        setAppWindow(wnd);

        try {
          const isMax = await wnd.isMaximized();
          if (isMounted) setMaximized(isMax);
        } catch (e) {
          frontendLogger.warn('[App] failed to read initial maximized state', e);
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
        frontendLogger.debug('[App] Tauri integration not available or failed to init', e);
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
    maximize: async () => await appWindow?.maximize?.().catch(frontendLogger.error),
    restore: async () => await appWindow?.unmaximize?.().catch(frontendLogger.error),
    minimize: async () => await appWindow?.minimize?.().catch(frontendLogger.error),
    close: async () => await appWindow?.close?.().catch(frontendLogger.error),
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
        const client = await import('./core/SpotifyClient');
        const results = await client.search(trimmedQuery, ['track', 'artist', 'album', 'playlist'], { limit: 50 });
        setSearchState(prev => ({ ...prev, results, loading: false }));
      } catch (e) {
        frontendLogger.warn('search failed', e);
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
              <DownloadsProvider>
                <PromptProvider>
                  <Main />
                </PromptProvider>
              </DownloadsProvider>
            </AlertsProvider>
          </PlaybackProvider>
        </ContextMenuProvider>
      </DBProvider>
    </I18nProvider>
  );
}

function Main() {
  const { t } = useI18n();
  const { ready: dbReady, getSetting, setSetting } = useDB();
  const { ready, states, progress } = useAppReady(dbReady);
  const playbackCurrent = usePlaybackSelector(s => s.currentTrack);

  // Custom hooks for better organization
  const { isMaximized, windowControls } = useWindowState();

  // Consolidated state management
  const [uiState, setUIState] = useState<UIState>(initialUIState);
  const [searchState, setSearchState] = useState<SearchState>(initialSearchState);
  const [tabState, setTabState] = useState<TabState>(initialTabState);
  const [lyricsState, setLyricsState] = useState<LyricsState>(initialLyricsState);
  const [modalState, setModalState] = useState<ModalState>(initialModalState);

  const [windowSize, setWindowSize] = useState<{ width: number; height: number }>({ width: 1200, height: 800 });
  const [windowPos, setWindowPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const [pipMode, setPipMode] = useState(false); // Picture-in-picture mode for small player
  const [pipSize, setPipSize] = useState<{ width: number; height: number }>({ width: 300, height: 300 });
  const [pipPos, setPipPos] = useState<{ x: number; y: number }>({ x: -1, y: -1 });

  const [isPinned, setIsPinned] = useState(false); // Pinned state for always-on-top

  // Refs for performance
  const currentTrackIdRef = useRef<string | undefined>(undefined);
  const loadedRef = useRef(false);

  // Custom hooks
  useDebouncedSearch(searchState, setSearchState);

  // Initialize frontend logging
  useEffect(() => {
    const initializeLogging = async () => {
      try {
        await frontendLogger.init();
        await frontendLogger.info('Frontend logging initialized successfully');
        await frontendLogger.info('Freely Player application started');
      } catch (error) {
        frontendLogger.error('Failed to initialize frontend logging:', error);
      }
    };

    initializeLogging();
  }, []); // Run once on mount

  // Notify Tauri when app is ready
  useEffect(() => {
    if (ready) {
      // Call the Tauri command when app is ready using the helper function
      runTauriCommand('app_ready').catch(frontendLogger.error);
      // Log app ready state
      frontendLogger.info('Application ready state achieved').catch(frontendLogger.error);
      // Load script plugins once after readiness
      import('./core/pluginScripts').then(m => m.loadScriptPluginsOnce())
        .then(list => {
          frontendLogger.info(`Loaded ${list.length} script plugin(s)`).catch(frontendLogger.error);
        })
        .catch(err => frontendLogger.error('Failed loading script plugins', err));
    }
  }, [ready]);

  // Send loading states to splashscreen
  useEffect(() => {
    if (ready) return; // Don't send updates once ready

    const statusText = progress.percentage >= 100
      ? 'Finalizing setup...'
      : `${progress.currentStep} (${progress.percentage}%)`;

    // Send status to splashscreen
    runTauriCommand('update_loading_status', {
      status: statusText,
      progress: progress.percentage,
      details: progress.details
    }).catch(frontendLogger.error);
  }, [ready, progress]);

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
          // Accept 'artist' | 'queue' | 'downloads' from persisted settings
          rightTab: (rtab === 'queue' || rtab === 'artist' || rtab === 'downloads' || rtab === 'lyrics') ? rtab : prev.rightTab
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
              // Accept 'artist' | 'queue' | 'downloads' from local storage
              rightTab: (obj.rightTab === 'queue' || obj.rightTab === 'artist' || obj.rightTab === 'downloads' || obj.rightTab === 'lyrics') ? obj.rightTab : prev.rightTab
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
  const toggleLyrics = useCallback(() => {
    const isLyricsInCenter = lyricsState.open;
    const isLyricsInRightPanel = uiState.rightTab === 'lyrics';

    if (isLyricsInCenter) {
      // Close center panel lyrics
      setLyricsState(prev => ({ ...prev, open: false }));
    } else if (isLyricsInRightPanel) {
      // Close right panel lyrics by switching back to previous tab
      setUIState(prev => ({ ...prev, rightTab: prev.previousRightTab }));
    } else {
      // No lyrics open, open in center panel
      setLyricsState(prev => ({ ...prev, open: true }));
    }
  }, [lyricsState.open, uiState.rightTab]);

  // Calculate if lyrics are open in either center panel or right panel
  const lyricsOpen = useMemo(() => {
    return lyricsState.open || uiState.rightTab === 'lyrics';
  }, [lyricsState.open, uiState.rightTab]);

  // Additional lyrics state that wasn't consolidated
  const [lyricsText, setLyricsText] = useState<string | undefined>(undefined);
  const [lyricsSynced, setLyricsSynced] = useState<SyncedLyrics | undefined>(undefined);
  const [lyricsTitle, setLyricsTitle] = useState<string | undefined>(undefined);
  const [lyricsSource, setLyricsSource] = useState<string | undefined>(undefined);

  // Fetch lyrics when overlay opens for the current playing track
  const playbackCurrentTrack = usePlaybackSelector(s => s.currentTrack);

  // Frontend lyrics caching removed; rely on backend (Tauri) caching inside musixmatch command
  useEffect(() => {
    let cancelled = false;
    if (!lyricsState.open) return undefined;
    (async () => {
      if (!playbackCurrentTrack) return;
      setLyricsState(prev => ({ ...prev, loading: true }));
      setLyricsText(undefined);
      setLyricsSynced(undefined);
      setLyricsTitle(undefined);
      setLyricsSource(undefined);

      // Try Musixmatch first (backend handles caching)
      const trackName = playbackCurrentTrack?.name || '';
      const artistNames = (playbackCurrentTrack?.artists || []).map((a: any) => a.name).join(', ');
      try {
        const mm = new MusixmatchClient();
        const mmRes = await mm.fetchLyrics(trackName, artistNames);
        if (!cancelled && mmRes?.html) {
          if (mmRes.synced) {
            setLyricsSynced(mmRes.synced); // mmRes.synced is now guaranteed to have the correct shape
          }
          setLyricsText(mmRes.html);
          setLyricsSource(mmRes.synced ? 'Musixmatch (synced)' : 'Musixmatch');
          setLyricsTitle(`${playbackCurrentTrack.name} — ${playbackCurrentTrack.artists?.map((a: any) => a.name).join(', ')}`);
          setLyricsState(prev => ({ ...prev, loading: false }));
          return; // success
        }
      } catch (_) { /* ignore musixmatch errors */ }

      // Fallback: Genius (no frontend caching)
      try {
        const gc = new GeniusClient();
        const q = `${playbackCurrentTrack.name} ${playbackCurrentTrack.artists?.[0]?.name || ''}`.trim();
        const res = await gc.search(q);
        const hit = res.hits && res.hits.length ? res.hits[0] : undefined;
        if (hit && hit.id) {
          const lyricsRes = await gc.getLyricsForSong(hit.id);
          const finalLyrics = lyricsRes?.lyrics || undefined;
          if (!cancelled && finalLyrics) {
            setLyricsText(finalLyrics);
            setLyricsTitle(`${playbackCurrentTrack.name} — ${playbackCurrentTrack.artists?.map((a: any) => a.name).join(', ')}`);
            setLyricsSource('Genius');
          }
        }
      } catch (_) { /* ignore genius errors */ }
      if (!cancelled) setLyricsState(prev => ({ ...prev, loading: false }));
    })();
    return () => { cancelled = true; };
  }, [lyricsState.open, playbackCurrentTrack]);

  const toggleQueueTab = useCallback(() => {
    setUIState(prev => ({
      ...prev,
      previousRightTab: prev.rightTab !== 'lyrics' && prev.rightTab !== 'queue' ? prev.rightTab : prev.previousRightTab,
      rightTab: prev.rightTab === 'queue' ? prev.previousRightTab : 'queue'
    }));
  }, []);

  // Function to reload all appearance settings
  const reloadAppearanceSettings = useCallback(async () => {
    try {
      const root = document.documentElement;
      
      // Load accent color
      try {
        const accent = await getSetting('ui.accent');
        if (accent) {
          root.style.setProperty('--accent', accent);
          // Derive and set --accent-rgb
          const h = accent.replace('#','');
          const r = parseInt(h.substring(0,2),16) || 0;
          const g = parseInt(h.substring(2,4),16) || 0;
          const b = parseInt(h.substring(4,6),16) || 0;
          root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
          
          // Calculate and set accent hue
          const hue = Math.round((Math.max(r,g,b) === Math.min(r,g,b)) ? 0 : 
            (Math.max(r,g,b) === r ? ((g-b)/(Math.max(r,g,b)-Math.min(r,g,b)) + (g < b ? 6 : 0)) * 60 :
             Math.max(r,g,b) === g ? ((b-r)/(Math.max(r,g,b)-Math.min(r,g,b)) + 2) * 60 :
             ((r-g)/(Math.max(r,g,b)-Math.min(r,g,b)) + 4) * 60));
          root.style.setProperty('--accent-hue', String(hue));
        }
      } catch {}
      
      // Load text colors
      try {
        const [textColor, textDarkColor] = await Promise.all([
          getSetting('ui.text'),
          getSetting('ui.textDark')
        ]);
        if (textColor) {
          root.style.setProperty('--text', textColor);
        }
        if (textDarkColor) {
          root.style.setProperty('--text-dark', textDarkColor);
          const h = textDarkColor.replace('#','');
          const r = parseInt(h.substring(0,2),16) || 0;
          const g = parseInt(h.substring(2,4),16) || 0;
          const b = parseInt(h.substring(4,6),16) || 0;
          const hue = Math.round((Math.max(r,g,b) === Math.min(r,g,b)) ? 0 : 
            (Math.max(r,g,b) === r ? ((g-b)/(Math.max(r,g,b)-Math.min(r,g,b)) + (g < b ? 6 : 0)) * 60 :
             Math.max(r,g,b) === g ? ((b-r)/(Math.max(r,g,b)-Math.min(r,g,b)) + 2) * 60 :
             ((r-g)/(Math.max(r,g,b)-Math.min(r,g,b)) + 4) * 60));
          root.style.setProperty('--text-dark-hue', String(hue));
        }
      } catch {}
      
      // Load background RGB
      try {
        const storedRgb = await getSetting('ui.bg.rgb');
        if (storedRgb) {
          root.style.setProperty('--bg', storedRgb);
        } else {
          root.style.setProperty('--bg', '15, 23, 36');
        }
      } catch {}
      
      // Load background appearance settings
      try {
        const [bgImage, bgBlur, bgBlurAmount, bgOverlayColor, bgOverlayOpacity] = await Promise.all([
          getSetting('ui.bg.image'),
          getSetting('ui.bg.blur'),
          getSetting('ui.bg.blurAmount'),
          getSetting('ui.bg.overlayColor'),
          getSetting('ui.bg.overlayOpacity')
        ]);
        
        // Apply background settings
        if (bgImage) {
          root.style.setProperty('--bg-image', `url(${bgImage})`);
        }
        
        const blur = (bgBlur === null || bgBlur === undefined || bgBlur === '') ? true : (bgBlur === '1' || bgBlur === 'true');
        const blurAmount = bgBlurAmount != null ? Math.max(0, Math.min(200, Number(bgBlurAmount))) : 200;
        
        const filter = blur ? `blur(${blurAmount}px)` : 'none';
        
        root.style.setProperty('--bg-filter', filter);
        
        // Apply overlay
        const overlayColor = bgOverlayColor || '#0A131A';
        const overlayOpacity = bgOverlayOpacity != null ? Number(bgOverlayOpacity) : 0.55;
        
        if (overlayColor.startsWith('#')) {
          const h = overlayColor.replace('#','');
          const r = parseInt(h.substring(0,2),16) || 0;
          const g = parseInt(h.substring(2,4),16) || 0;
          const b = parseInt(h.substring(4,6),16) || 0;
          root.style.setProperty('--bg-overlay', `rgba(${r}, ${g}, ${b}, ${overlayOpacity})`);
        }
      } catch {}
      
      // Force a repaint to ensure all styles are reapplied
      document.body.offsetHeight; // Trigger reflow
    } catch (error) {
      frontendLogger.warn('Failed to reload appearance settings:', error);
    }
  }, [getSetting]);

  const togglePIP = useCallback(async (pip: boolean) => {
    const currentWindow = getCurrentWindow();
    
    // Fade out the app to hide the transition glitch
    document.body.style.transition = 'opacity 150ms ease-out';
    document.body.style.opacity = '0';
    
    // Small delay to ensure fade out completes
    await new Promise(resolve => setTimeout(resolve, 150));
    
    setPipMode(pip);
    const currentSize = await currentWindow.outerSize();
    const currentPosition = await currentWindow.outerPosition();

    // Disable always-on-top temporarily to avoid glitches
    await currentWindow.setAlwaysOnTop(false);
    setIsPinned(false);

    if (pip) {
      // Entering PIP mode: save current full app state
      setWindowPos(currentPosition);
      setWindowSize(currentSize);
      
      // If this is the first time entering PIP, use current position
      const pipPosition = (pipPos.x === -1 && pipPos.y === -1) ? currentPosition : pipPos;
      
      await currentWindow.setMinSize(new LogicalSize(250, 250));
      await currentWindow.setSize(new LogicalSize(pipSize.width, pipSize.height));
      await currentWindow.setPosition(new LogicalPosition(pipPosition.x, pipPosition.y));
      await currentWindow.setMaxSize(new LogicalSize(800, 800));
      
    } else {
      // Exiting PIP mode: save current PIP state and restore full app
      setPipPos(currentPosition);
      setPipSize(currentSize);

      await currentWindow.setMinSize(new LogicalSize(800, 600));
      await currentWindow.setSize(new LogicalSize(windowSize.width, windowSize.height));
      await currentWindow.setPosition(new LogicalPosition(windowPos.x, windowPos.y));
      await currentWindow.setMaxSize(new LogicalSize(10000, 10000));
      
      // Reload appearance settings when exiting PIP mode
      await reloadAppearanceSettings();
    }
    
    // Small delay to ensure window changes are applied
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Fade back in
    document.body.style.transition = 'opacity 200ms ease-in';
    document.body.style.opacity = '1';
    
    // Clean up transition style after animation completes
    setTimeout(() => {
      document.body.style.transition = '';
    }, 200);
  }, [pipPos, pipSize, windowSize, windowPos, reloadAppearanceSettings]);

  const togglePinned = useCallback(async () => {
    const currentWindow = getCurrentWindow();
    const newPinnedState = !isPinned;
    setIsPinned(newPinnedState);
    await currentWindow.setAlwaysOnTop(newPinnedState);
  }, [isPinned]);

  // Open Downloads tab in the right panel and ensure it is visible
  const openDownloadsTab = useCallback(() => {
    setUIState(prev => ({
      ...prev,
      previousRightTab: prev.rightTab !== 'lyrics' && prev.rightTab !== 'downloads' ? prev.rightTab : prev.previousRightTab,
      rightTab: prev.rightTab === 'downloads' ? prev.previousRightTab : 'downloads'
    }));
  }, []);

  // Switch lyrics to right panel
  const switchLyricsToRightPanel = useCallback(() => {
    setUIState(prev => ({
      ...prev,
      previousRightTab: prev.rightTab !== 'lyrics' ? prev.rightTab : prev.previousRightTab, // Save current tab as previous
      rightTab: 'lyrics',
      rightCollapsed: false // Ensure right panel is visible
    }));
    setLyricsState(prev => ({ ...prev, open: false })); // Close center panel lyrics
  }, []);

  // Switch lyrics to center panel (overlay)
  const switchLyricsToCenterPanel = useCallback(() => {
    setLyricsState(prev => ({ ...prev, open: true }));
    // Switch away from lyrics tab in right panel to previous tab
    if (uiState.rightTab === 'lyrics') {
      setUIState(prev => ({ ...prev, rightTab: prev.previousRightTab }));
    }
  }, [uiState.rightTab]);

  // Direct event-driven AddToPlaylist modal host (replaces former Provider/Context)
  useEffect(() => {
    function onOpen(ev: Event) {
      const d = (ev as CustomEvent).detail || {};
      const track = d.track || d.tracks?.[0] || d.trackData || (Array.isArray(d.trackIds) && d.trackIds.length ? { id: d.trackIds[0] } : null);
      if (track) {
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

  if (pipMode) {
    return (
      <div className={`${'app'} pip-mode`}>
        <TitleBar
          title="Freely"
          icon="icon-192.png"
          onSearch={handleSearch}
          onNavigate={handleNavigate}
          activeTab={tabState.activeTab}
          windowStatus={windowStatus}
          isMaximized={isMaximized}
          pipMode={pipMode}
          handlePin={togglePinned}
          isPinned={isPinned}
        />
        <div className="window-body">
          <div className="content layout">
            <SmallPlayer
              onPIPtoggle={togglePIP}
            />
          </div>
        </div>
      </div>
    )
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
          pipMode={pipMode}
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
              <LyricsTab
                open={lyricsState.open}
                onClose={() => setLyricsState(prev => ({ ...prev, open: false }))}
                onSwitchToRightPanel={switchLyricsToRightPanel}
                lyrics={lyricsState.loading ? t('np.loading') : lyricsText}
                title={lyricsTitle}
                synced={lyricsSynced}
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
              onRightTabChange={(tab) => setUIState(prev => ({
                ...prev,
                previousRightTab: prev.rightTab !== 'lyrics' ? prev.rightTab : prev.previousRightTab,
                rightTab: tab
              }))}
              extraClass={uiState.draggingRight ? `panel-dragging ${uiState.collapseIntentRight ? 'collapse-intent' : ''}` : ''}
              onSelectAlbum={(id) => { handleSelectAlbum(id); }}
              onSelectPlaylist={(id) => { handleSelectPlaylist(id); }}
              lyricsText={lyricsState.loading ? t('np.loading') : lyricsText}
              lyricsTitle={lyricsTitle}
              lyricsSynced={lyricsSynced}
              lyricsLoading={lyricsState.loading}
              onSwitchLyricsToCenterPanel={switchLyricsToCenterPanel}
            />
          </div>

          <MainPlayer
            lyricsOpen={lyricsOpen}
            onToggleLyrics={toggleLyrics}
            onToggleQueueTab={toggleQueueTab}
            onToggleDownloads={openDownloadsTab}
            queueActive={uiState.rightTab === 'queue'}
            downloadsActive={uiState.rightTab === 'downloads'}
            onPIPtoggle={togglePIP}
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
