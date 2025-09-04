import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HomeTab from './HomeTab';
import SongInfoTab from './SongInfoTab';
import AlbumInfoTab from './AlbumInfoTab';
import PlaylistInfoTab from './PlaylistInfoTab';
import ArtistInfoTab from './ArtistInfoTab';
import SearchResults from './SearchResults';
import Settings from './Settings';
import Tests from './Tests';

type Props = {
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
  onSelectArtist?: (id: string) => void;
  onSelectAlbum?: (id: string) => void;
  onSelectPlaylist?: (id: string) => void;
  onSelectTrack?: (id: string) => void;
};

/**
 * CenterTabs - optimized:
 *  - Avoids setting tab / causing re-renders when requested tab === current tab
 *  - Uses refs to prevent unnecessary add/remove of global event listener
 *  - Memoizes normalized search results and rendered tab content
 *  - Uses refs for DOM nodes to reset scrollTop only when the visible tab actually changed
 *
 * Drop-in replace for the original component.
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
  onSelectArtist,
  onSelectAlbum,
  onSelectPlaylist,
  onSelectTrack,
}: Props) {
  const [internalTab, setInternalTab] = useState<string>(initial);

  // derived effective tab (controlled or uncontrolled)
  const tab = activeTab !== undefined ? activeTab : internalTab;

  // refs for DOM nodes to avoid querying document every time
  const containerRef = useRef<HTMLElement | null>(null);
  const tabsBodyRef = useRef<HTMLElement | null>(null);

  // ref to keep previous tab (so we can detect actual changes)
  const prevTabRef = useRef<string | null>(null);
  // ref that always contains latest tab for event handlers attached once
  const currentTabRef = useRef<string>(tab);
  useEffect(() => {
    currentTabRef.current = tab;
  }, [tab]);

  // Refs for previous ids to detect changes
  const prevSongTrackIdRef = useRef<string | undefined>(songTrackId);
  const prevAlbumIdRef = useRef<string | undefined>(albumId);
  const prevPlaylistIdRef = useRef<string | undefined>(playlistId);
  const prevArtistIdRef = useRef<string | undefined>(artistId);

  // setTab: only act if requested tab differs from current effective tab
  const setTab = useCallback(
    (t: string) => {
      if (t === (activeTab !== undefined ? activeTab : internalTab)) return; // no-op if same
      if (onTabChange) onTabChange(t);
      if (activeTab === undefined) setInternalTab(t);
    },
    // include dependencies that affect the "current" tab calculation or callbacks
    [activeTab, internalTab, onTabChange]
  );

  // when external searchTrigger occurs, switch to search only if it's not already active
  useEffect(() => {
    if (searchTrigger && tab !== 'search') {
      setTab('search');
    }
    // only re-run when searchTrigger changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTrigger]);

  useEffect(() => {
    let shouldReset = false;
    if (tab === 'song' && songTrackId !== prevSongTrackIdRef.current) {
      shouldReset = true;
      prevSongTrackIdRef.current = songTrackId;
    } else if (tab === 'album' && albumId !== prevAlbumIdRef.current) {
      shouldReset = true;
      prevAlbumIdRef.current = albumId;
    } else if (tab === 'playlist' && playlistId !== prevPlaylistIdRef.current) {
      shouldReset = true;
      prevPlaylistIdRef.current = playlistId;
    } else if (tab === 'artist' && artistId !== prevArtistIdRef.current) {
      shouldReset = true;
      prevArtistIdRef.current = artistId;
    }

    if (shouldReset) {
      console.log('CenterTabs: id changed for tab', tab, 'resetting scroll');
      // Defer to next frame to ensure DOM updates completed
      requestAnimationFrame(() => {
        const body = tabsBodyRef.current ?? document.querySelector('.center-tabs .tabs-body');
        if (body instanceof HTMLElement && body.scrollTop !== 0) body.scrollTop = 0;

        const mainEl = containerRef.current ?? document.querySelector('.center-tabs');
        if (mainEl instanceof HTMLElement && mainEl.scrollTop !== 0) mainEl.scrollTop = 0;
      });
    }
  }, [tab, songTrackId, albumId, playlistId, artistId]);

  // Memoize normalized search results so downstream components don't get new object refs unnecessarily
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

  // When normalized searchResults arrive while on the search tab, scroll them into view.
  // This effect runs when either tab or normalizedSearchResults changes.
  useEffect(() => {
    if (tab !== 'search') return;
    const normalized = normalizedSearchResults;
    const anyCount =
      normalized &&
      ((normalized.songs?.length || 0) + (normalized.artists?.length || 0) + (normalized.albums?.length || 0) + (normalized.playlists?.length || 0) > 0);
    if (!anyCount) return;

    requestAnimationFrame(() => {
      const container = containerRef.current ?? document.querySelector('.center-tabs');
      const el = container ? container.querySelector('.search-results') : document.querySelector('.search-results');
      if (el && el instanceof HTMLElement) {
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('results-arrived');
        setTimeout(() => el.classList.remove('results-arrived'), 1200);
      }
    });
  }, [tab, normalizedSearchResults]);

  // Attach a single global listener for 'freely:localDataCleared' which uses currentTabRef to decide action.
  // This avoids re-attaching on every tab change.
  useEffect(() => {
    function handleCleared() {
      const current = currentTabRef.current;
      if (['playlist', 'album', 'artist', 'song'].includes(current)) {
        setTab('home');
      }
    }
    window.addEventListener('freely:localDataCleared', handleCleared);
    return () => window.removeEventListener('freely:localDataCleared', handleCleared);
  }, [setTab]);

  // Memoize rendered tab content to avoid re-creating React nodes when unrelated props change.
  const content = useMemo(() => {
    switch (tab) {
      case 'home':
        return <HomeTab onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectTrack={onSelectTrack} />;

      case 'song':
        return <SongInfoTab trackId={songTrackId} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectTrack={onSelectTrack} />;

      case 'album':
        return <AlbumInfoTab albumId={albumId} onSelectArtist={onSelectArtist} onSelectTrack={onSelectTrack} />;

      case 'playlist':
        return <PlaylistInfoTab playlistId={playlistId} onSelectPlaylist={onSelectPlaylist} onSelectTrack={onSelectTrack} />;

      case 'artist':
        return <ArtistInfoTab artistId={artistId} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} onSelectTrack={onSelectTrack} />;

      case 'search': {
        // normalizedSearchResults already memoized above
        return (
          <SearchResults
            query={searchQuery}
            results={normalizedSearchResults}
            onSelectArtist={onSelectArtist}
            onSelectAlbum={onSelectAlbum}
            onSelectPlaylist={onSelectPlaylist}
            onSelectTrack={onSelectTrack}
            // preserve searchLoading prop if SearchResults supports it
            // @ts-expect-error optional prop forwarding if needed
            loading={searchLoading}
          />
        );
      }

      case 'settings':
        return <Settings />;

      case 'apis':
        return <Tests />;

      default:
        return null;
    }
  }, [
    tab,
    onSelectArtist,
    onSelectAlbum,
    onSelectTrack,
    songTrackId,
    albumId,
    playlistId,
    onSelectPlaylist,
    artistId,
    searchQuery,
    normalizedSearchResults,
    searchLoading,
  ]);

  return (
    <main className="center-tabs" ref={(el) => (containerRef.current = el)}>
      <div className="tabs-body" ref={(el) => (tabsBodyRef.current = el)}>
        {content}
      </div>
    </main>
  );
}
