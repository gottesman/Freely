import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HomeTab from './HomeTab';
import SongInfoTab from './SongInfoTab';
import AlbumInfoTab from './AlbumInfoTab';
import PlaylistInfoTab from './PlaylistInfoTab';
import ArtistInfoTab from './ArtistInfoTab';
import SearchResults from './SearchResults';
import Settings from './Settings';
import Tests from './Tests';

// Constants for better performance
const SCROLL_RESET_TABS = ['playlist', 'album', 'artist', 'song'] as const;
const SCROLL_BEHAVIOR: ScrollIntoViewOptions = { behavior: 'smooth', block: 'start' };

interface Props {
  initial?: string;
  searchQuery?: string;
  searchTrigger?: number;
  searchResults?: any;
  searchLoading?: boolean;
  activeTab?: string;
  onTabChange?: (t: string) => void;
  songTrackId?: string;
  albumId?: string;
  playlistId?: string;
  artistId?: string;
}

// Consolidated state for better organization
interface TabIds {
  song?: string;
  album?: string;
  playlist?: string;
  artist?: string;
}

interface TabRefs {
  current: string;
  container: React.RefObject<HTMLElement>;
  tabsBody: React.RefObject<HTMLDivElement>;
  prevIds: React.MutableRefObject<TabIds>;
}

// Custom hooks for better organization
function useTabRefs(tab: string): TabRefs {
  const containerRef = useRef<HTMLElement | null>(null);
  const tabsBodyRef = useRef<HTMLDivElement | null>(null);
  const prevIdsRef = useRef<TabIds>({});
  const currentTabRef = useRef<string>(tab);

  useEffect(() => {
    currentTabRef.current = tab;
  }, [tab]);

  return {
    current: currentTabRef.current,
    container: containerRef,
    tabsBody: tabsBodyRef,
    prevIds: prevIdsRef
  };
}

function useScrollReset(refs: TabRefs) {
  return useCallback(() => {
    requestAnimationFrame(() => {
      const body = refs.tabsBody.current ?? document.querySelector('.center-tabs .tabs-body');
      if (body instanceof HTMLElement && body.scrollTop !== 0) {
        body.scrollTop = 0;
      }

      const container = refs.container.current ?? document.querySelector('.center-tabs');
      if (container instanceof HTMLElement && container.scrollTop !== 0) {
        container.scrollTop = 0;
      }
    });
  }, [refs.container, refs.tabsBody]);
}

function useIdChangeDetection(
  tab: string, 
  ids: TabIds, 
  refs: TabRefs, 
  scrollReset: () => void
) {
  useEffect(() => {
    const currentIds = refs.prevIds.current;
    const tabType = tab as keyof TabIds;
    
    if (SCROLL_RESET_TABS.includes(tab as any) && 
        ids[tabType] !== currentIds[tabType]) {
      
      console.log('CenterTabs: id changed for tab', tab, 'resetting scroll');
      currentIds[tabType] = ids[tabType];
      scrollReset();
    }
  }, [tab, ids, refs.prevIds, scrollReset]);
}
/**
 * CenterTabs - Optimized for performance and maintainability:
 * - Consolidated state management with custom hooks
 * - Simplified ID change detection logic
 * - Memoized search results and content rendering
 * - Optimized scroll management
 * - Reduced code duplication
 */
export default function CenterTabs({
  initial = 'home',
  searchQuery,
  searchTrigger,
  searchResults,
  searchLoading,
  activeTab,
  onTabChange,
  songTrackId,
  albumId,
  playlistId,
  artistId,
}: Props) {
  const [internalTab, setInternalTab] = useState<string>(initial);
  
  // Derived effective tab (controlled or uncontrolled)
  const tab = activeTab !== undefined ? activeTab : internalTab;
  
  // Consolidated refs and utilities
  const refs = useTabRefs(tab);
  const scrollReset = useScrollReset(refs);
  
  // Current IDs object for easier management
  const currentIds: TabIds = useMemo(() => ({
    song: songTrackId,
    album: albumId,
    playlist: playlistId,
    artist: artistId
  }), [songTrackId, albumId, playlistId, artistId]);

  // Optimized tab change handler
  const setTab = useCallback((newTab: string) => {
    if (newTab === tab) return; // No-op if same
    if (onTabChange) onTabChange(newTab);
    if (activeTab === undefined) setInternalTab(newTab);
  }, [tab, onTabChange, activeTab]);

  // Handle search trigger
  useEffect(() => {
    if (searchTrigger && tab !== 'search') {
      setTab('search');
    }
  }, [searchTrigger, tab, setTab]);

  // Use custom hook for ID change detection
  useIdChangeDetection(tab, currentIds, refs, scrollReset);

  // Memoized normalized search results
  const normalizedSearchResults = useMemo(() => {
    const raw = searchResults?.results ?? searchResults;
    if (!raw) return undefined;
    
    return {
      songs: raw.track ?? raw.tracks ?? raw.songs ?? [],
      artists: raw.artist ?? raw.artists ?? [],
      albums: raw.album ?? raw.albums ?? [],
      playlists: raw.playlist ?? raw.playlists ?? [],
    };
  }, [searchResults]);

  // Handle search results scroll into view
  useEffect(() => {
    if (tab !== 'search' || !normalizedSearchResults) return;
    
    const hasResults = Object.values(normalizedSearchResults).some(arr => arr.length > 0);
    if (!hasResults) return;

    requestAnimationFrame(() => {
      const container = refs.container.current ?? document.querySelector('.center-tabs');
      const searchEl = container?.querySelector('.search-results') ?? document.querySelector('.search-results');
      
      if (searchEl instanceof HTMLElement) {
        searchEl.scrollIntoView(SCROLL_BEHAVIOR);
        searchEl.classList.add('results-arrived');
        setTimeout(() => searchEl.classList.remove('results-arrived'), 1200);
      }
    });
  }, [tab, normalizedSearchResults, refs.container]);

  // Global event listener for data clearing
  useEffect(() => {
    const handleCleared = () => {
      if (SCROLL_RESET_TABS.includes(refs.current as any)) {
        setTab('home');
      }
    };
    
    window.addEventListener('freely:localDataCleared', handleCleared);
    return () => window.removeEventListener('freely:localDataCleared', handleCleared);
  }, [refs, setTab]);

  // Memoized tab content for optimal rendering
  const content = useMemo(() => {
    switch (tab) {
      case 'home':
        return <HomeTab />;
      case 'song':
        return <SongInfoTab trackId={songTrackId} />;
      case 'album':
        return <AlbumInfoTab albumId={albumId} />;
      case 'playlist':
        return <PlaylistInfoTab playlistId={playlistId} />;
      case 'artist':
        return <ArtistInfoTab artistId={artistId} />;
      case 'search':
        return (
          <SearchResults
            query={searchQuery}
            results={normalizedSearchResults}
            // @ts-expect-error - loading prop may be optional
            loading={searchLoading}
          />
        );
      case 'settings':
        return <Settings />;
      case 'apis':
        return <Tests />;
      default:
        return null;
    }
  }, [tab, songTrackId, albumId, playlistId, artistId, searchQuery, normalizedSearchResults, searchLoading]);

  return (
    <main className="center-tabs" ref={refs.container}>
      <div className="tabs-body" ref={refs.tabsBody}>
        {content}
      </div>
    </main>
  );
}
