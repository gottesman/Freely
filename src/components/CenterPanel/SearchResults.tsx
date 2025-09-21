import React, { useState, useMemo, useCallback, MouseEvent } from 'react';
import { useI18n } from '../../core/i18n';
import { usePlaybackSelector } from '../../core/Playback';
import { fetchAlbumTracks, fetchArtistTracks, fetchPlaylistTracks } from '../../core/SpotifyClient';
import { useContextMenu } from '../../core/ContextMenu';
import { buildTrackContextMenuItems } from '../Utilities/ContextMenu';
import InfoHeader from '../Utilities/InfoHeader';

// Types for better organization
type Image = { url: string };
type ArtistStub = { name: string };

type Song = {
  id: string | number;
  name: string;
  artists?: ArtistStub[];
  album?: { name: string; images?: Image[] };
  durationMs?: number;
};

type Artist = {
  id: string | number;
  name: string;
  images?: Image[];
};

type Album = {
  id: string | number;
  name: string;
  artist?: string;
  artists?: ArtistStub[];
  images?: Image[];
};

type Playlist = {
  id: string | number;
  name: string;
  totalTracks?: number;
  images?: Image[];
};

type CollectionKind = 'album' | 'artist' | 'playlist';
type TabType = 'all' | 'songs' | 'artists' | 'albums' | 'playlists';

interface SearchResultsProps {
  query?: string;
  results?: {
    songs?: Song[];
    artists?: Artist[];
    albums?: Album[];
    playlists?: Playlist[];
  };
  onMoreClick?: (id: string) => void;
}

// Utility functions extracted to prevent recreations
const formatDuration = (ms = 0): string => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor(ms / 1000) % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const getImageUrl = (images?: Image[], index = 1): string | undefined => {
  return images?.[Math.min(index, images.length - 1)]?.url;
};

const escapeRegExp = (str: string): string => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const splitTextByQuery = (text: string, query?: string): string[] => {
  if (!query || !text) return [text];
  try {
    return text.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'));
  } catch (e) {
    return [text];
  }
};

const dispatchCustomEvent = (eventType: string, detail: any) => {
  window.dispatchEvent(new CustomEvent(eventType, { detail }));
};

// Event dispatch helpers
const playbackEvents = {
  playNow: (ids: string | string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    dispatchCustomEvent('freely:playback:playNow', { ids: arr });
  }
};

const navigationEvents = {
  selectTrack: (trackId: string, source = 'search') =>
    dispatchCustomEvent('freely:selectTrack', { trackId, source }),
  selectArtist: (artistId: string | number, source = 'search') =>
    dispatchCustomEvent('freely:selectArtist', { artistId, source }),
  selectAlbum: (albumId: string | number, source = 'search') =>
    dispatchCustomEvent('freely:selectAlbum', { albumId, source }),
  selectPlaylist: (playlistId: string, source = 'search') =>
    dispatchCustomEvent('freely:selectPlaylist', { playlistId, source }),
  openAddToPlaylist: (track: Song) =>
    dispatchCustomEvent('freely:openAddToPlaylistModal', { track })
};

// Optimized HighlightedText component
const HighlightedText = React.memo<{ text: string; query?: string }>(({ text, query }) => {
  const parts = useMemo(() => splitTextByQuery(text, query), [text, query]);

  return (
    <>
      {parts.map((part, i) =>
        query && part.toLowerCase() === query.toLowerCase() ? (
          <span key={i} className="sr-highlight">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
});

// Optimized MediaCover component
const MediaCover = React.memo<{ type: CollectionKind | 'track'; images?: Image[] }>(({ type, images }) => {
  const iconMap = {
    track: 'music_note',
    album: 'album',
    artist: 'person',
    playlist: 'queue_music'
  } as const;

  const icon = iconMap[type];
  const imageUrl = useMemo(() => getImageUrl(images), [images]);

  return (
    <div className="media-cover-inner">
      {imageUrl ? (
        <img src={imageUrl} alt="" loading="lazy" />
      ) : (
        <span className="material-symbols-rounded">{icon}</span>
      )}
    </div>
  );
});

// Optimized CollectionPlayButton component
interface CollectionPlayButtonProps {
  kind: CollectionKind;
  id: string | number;
  onPlay: (ids: string[]) => void;
}

const CollectionPlayButton = React.memo<CollectionPlayButtonProps>(({ kind, id, onPlay }) => {
  const { t } = useI18n();

  const fetchers = useMemo(() => ({
    album: fetchAlbumTracks,
    artist: fetchArtistTracks,
    playlist: fetchPlaylistTracks
  }), []);

  const loadAndPlay = useCallback(async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      const fetcher = fetchers[kind];
      const fetchedTracks = await fetcher(id, { limit: 50 }) as Song[];
      if (fetchedTracks?.length) {
        onPlay(fetchedTracks.map(t => String(t.id)));
      }
    } catch (err) {
      console.warn(`Failed to play collection ${kind}:${id}`, err);
    }
  }, [kind, id, onPlay, fetchers]);

  return (
    <div
      className='media-play-overlay'
      role="button"
      aria-label={t('player.play', 'Play')}
      onClick={loadAndPlay}
    >
      <span className="material-symbols-rounded filled">play_arrow</span>
    </div>
  );
});

// Common card props interface
interface BaseCardProps {
  query?: string;
  onSelect: () => void;
  onPlay: (ids: string[]) => void;
  layout: 'compact' | 'full';
}

// Optimized card components
const ArtistCard = React.memo<{ artist: Artist } & BaseCardProps>(({ artist, query, onSelect, onPlay, layout }) => (
  <div className={`media-card ${layout}`} role="button" onClick={onSelect}>
    <div className="media-cover circle">
      <MediaCover type="artist" images={artist.images} />
      <CollectionPlayButton kind="artist" id={artist.id} onPlay={onPlay} />
    </div>
    <h3 className="media-title">
      <HighlightedText text={artist.name} query={query} />
    </h3>
  </div>
));

const AlbumCard = React.memo<{ album: Album } & BaseCardProps>(({ album, query, onSelect, onPlay, layout }) => {
  const artistName = useMemo(() =>
    (album.artists?.map(a => a.name).join(', ')) || album.artist || '',
    [album.artists, album.artist]
  );

  return (
    <div className={`media-card ${layout}`} role="button" onClick={onSelect}>
      <div className="media-cover square">
        <MediaCover type="album" images={album.images} />
        <CollectionPlayButton kind="album" id={album.id} onPlay={onPlay} />
      </div>
      <h3 className="media-title">
        <HighlightedText text={album.name} query={query} />
      </h3>
      <div className="media-meta">{artistName}</div>
    </div>
  );
});

const PlaylistCard = React.memo<{ playlist: Playlist } & BaseCardProps>(({ playlist, query, onSelect, onPlay, layout }) => {
  const { t } = useI18n();

  const trackCountText = useMemo(() =>
    `${playlist.totalTracks || 0} ${t('pl.tracks', 'tracks')}`,
    [playlist.totalTracks, t]
  );

  return (
    <div className={`media-card ${layout}`} role="button" onClick={onSelect}>
      <div className="media-cover square">
        <MediaCover type="playlist" images={playlist.images} />
        <CollectionPlayButton kind="playlist" id={playlist.id} onPlay={onPlay} />
      </div>
      <h3 className="media-title overflow-ellipsis">
        <HighlightedText text={playlist.name} query={query} />
      </h3>
      <div className="media-meta">{trackCountText}</div>
    </div>
  );
});

// Optimized song components
interface SongListItemProps {
  song: Song;
  query?: string;
  onSelect: () => void;
  onPlay: () => void;
  onAddToPlaylist: () => void;
  onMore: (e: MouseEvent, song: Song) => void;
}

const SongListItem = React.memo<SongListItemProps>(({ song, query, onSelect, onPlay, onAddToPlaylist, onMore }) => {
  const { t } = useI18n();

  const handleAction = useCallback((e: MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
  }, []);

  const handleMoreAction = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    onMore(e, song);
  }, [onMore, song]);

  const artistNames = useMemo(() =>
    song.artists?.map(a => a.name).join(', ') || '',
    [song.artists]
  );

  const duration = useMemo(() => formatDuration(song.durationMs), [song.durationMs]);

  return (
    <li className="sr-item" onClick={onSelect}>
      <div className="sr-thumb">
        <MediaCover type="track" images={song.album?.images} />
        <div className='play-button' onClick={(e) => handleAction(e, onPlay)}>
          <span className="material-symbols-rounded filled">play_arrow</span>
        </div>
      </div>
      <div className="sr-main">
        <div className="sr-meta">
          <div className="sr-name overflow-ellipsis">
            <HighlightedText text={song.name} query={query} />
          </div>
          <div className="sr-sub overflow-ellipsis">{artistNames}</div>
        </div>
        <div className="sr-controls">
          <div className="sr-time">{duration}</div>
          <button
            type="button"
            className={`sr-more-btn`}
            aria-label='More'
            title='More'
            onClick={(e) => { e.stopPropagation(); onMore(e, song) }}
            onKeyDown={(e) => { e.stopPropagation(); }}
          >
            <span
              className={`material-symbols-rounded`}
            >more_horiz
            </span>
          </button>
        </div>
      </div>
    </li>
  );
});

interface SongTableRowProps {
  song: Song;
  query?: string;
  onSelect: () => void;
  onMore: (e: MouseEvent, song: Song) => void;
}

const SongTableRow = React.memo<SongTableRowProps>(({ song, query, onSelect, onMore }) => {
  const artistNames = useMemo(() =>
    song.artists?.map(a => a.name).join(', ') || '',
    [song.artists]
  );

  const duration = useMemo(() => formatDuration(song.durationMs), [song.durationMs]);

  return (
    <tr className="sr-table-row" onClick={onSelect}>
      <td>
        <div className="sr-title-with-thumb overflow-ellipsis">
          <div className="sr-thumb-inline" aria-hidden>
            <MediaCover type="track" images={song.album?.images} />
          </div>
          <div className="sr-title-meta overflow-ellipsis">
            <div className="sr-table-title overflow-ellipsis">
              <HighlightedText text={song.name} query={query} />
            </div>
            <div className="sr-table-sub overflow-ellipsis">{artistNames}</div>
          </div>
        </div>
      </td>
      <td className="sr-table-album overflow-ellipsis">{song.album?.name || ''}</td>
      <td className="sr-td-right">
        <span className="sr-time">
          {duration}
        </span>
        <button
          type="button"
          className={`sr-more-btn`}
          aria-label='More'
          title='More'
          onClick={(e) => { e.stopPropagation(); onMore(e, song) }}
          onKeyDown={(e) => { e.stopPropagation(); }}
        >
          <span
            className={`material-symbols-rounded`}
          >more_horiz
          </span>
        </button>
      </td>
    </tr>
  );
});

// Custom hook for search event handlers
const useSearchHandlers = (onMoreClick?: (id: string) => void) => {
  const { t } = useI18n();
  const queueIds = usePlaybackSelector(s => s.queueIds) as string[] | undefined;
  const currentIndex = usePlaybackSelector(s => s.currentIndex) as number | undefined;
  const { openMenu } = useContextMenu();

  return useMemo(() => ({
    handlePlayNow: (ids: string | string[]) => playbackEvents.playNow(ids),

    handleSelectTrack: (id?: string | number) => {
      if (id !== undefined) navigationEvents.selectTrack(String(id));
    },

    handleSelectArtist: (id?: string | number) => {
      if (id !== undefined) navigationEvents.selectArtist(id);
    },

    handleSelectAlbum: (id?: string | number) => {
      if (id !== undefined) navigationEvents.selectAlbum(id);
    },

    handleSelectPlaylist: (id?: string | number) => {
      if (id !== undefined) navigationEvents.selectPlaylist(String(id));
    },

    handleMore: async (e: MouseEvent, song: Song) => {
      const items = buildTrackContextMenuItems({
        t,
        trackData: song,
        queueList: queueIds,
        currentIndex,
        queueOptions: true
      });
      await openMenu({ e: e.currentTarget as any, items });
    },

    handleAddToPlaylist: (song: Song) => navigationEvents.openAddToPlaylist(song)
  }), [onMoreClick, t, queueIds, currentIndex, openMenu]);
};

// Custom hook for tab management
const useTabManager = () => {
  const [tab, setTab] = useState<TabType>('all');
  const { t } = useI18n();

  const tabButtons = useMemo(() => [
    { key: 'all', label: t('search.all') },
    { key: 'songs', label: t('search.songs') },
    { key: 'artists', label: t('search.artists') },
    { key: 'albums', label: t('search.albums') },
    { key: 'playlists', label: t('search.playlists') }
  ] as const, [t]);

  const tabActions = useMemo(() =>
    tabButtons.map(({ key, label }) => (
      <button
        key={key}
        className={`sr-tab ${tab === key ? 'active' : ''}`}
        onClick={() => setTab(key as TabType)}
      >
        {label}
      </button>
    )),
    [tabButtons, tab]
  );

  return { tab, tabActions };
};

export default function SearchResults({ query, results, onMoreClick }: SearchResultsProps) {
  const { t } = useI18n();
  const { tab, tabActions } = useTabManager();
  const handlers = useSearchHandlers(onMoreClick);

  // Memoized processed data
  const processedData = useMemo(() => {
    const uniqueSongs = (results?.songs || []).filter((s, index, arr) => {
      if (!s || s.id === undefined || s.id === null) return false;
      const key = String(s.id);
      return arr.findIndex(item => String(item.id) === key) === index;
    });

    const artists = results?.artists || [];
    const albums = results?.albums || [];
    const playlists = results?.playlists || [];

    const hasAny = !!query && (
      uniqueSongs.length > 0 ||
      artists.length > 0 ||
      albums.length > 0 ||
      playlists.length > 0
    );

    return { uniqueSongs, artists, albums, playlists, hasAny };
  }, [results, query]);

  // Memoized card generators with stable props
  const cardGenerators = useMemo(() => ({
    artistCard: (artist: Artist, layout: 'compact' | 'full') => (
      <ArtistCard
        key={String(artist.id)}
        artist={artist}
        query={query}
        layout={layout}
        onSelect={() => handlers.handleSelectArtist(artist.id)}
        onPlay={handlers.handlePlayNow}
      />
    ),

    albumCard: (album: Album, layout: 'compact' | 'full') => (
      <AlbumCard
        key={String(album.id)}
        album={album}
        query={query}
        layout={layout}
        onSelect={() => handlers.handleSelectAlbum(album.id)}
        onPlay={handlers.handlePlayNow}
      />
    ),

    playlistCard: (playlist: Playlist, layout: 'compact' | 'full') => (
      <PlaylistCard
        key={String(playlist.id)}
        playlist={playlist}
        query={query}
        layout={layout}
        onSelect={() => handlers.handleSelectPlaylist(playlist.id)}
        onPlay={handlers.handlePlayNow}
      />
    ),

    songListItem: (song: Song) => (
      <SongListItem
        key={String(song.id)}
        song={song}
        query={query}
        onSelect={() => handlers.handleSelectTrack(song.id)}
        onPlay={() => handlers.handlePlayNow(String(song.id))}
        onAddToPlaylist={() => handlers.handleAddToPlaylist(song)}
        onMore={(e, songData) => handlers.handleMore(e, songData)}
      />
    ),

    songTableRow: (song: Song) => (
      <SongTableRow
        key={String(song.id)}
        song={song}
        query={query}
        onSelect={() => handlers.handleSelectTrack(song.id)}
        onMore={(e, songData) => handlers.handleMore(e, songData)}
      />
    )
  }), [query, handlers]);

  // Memoized rendered content based on tab and data
  const renderedContent = useMemo(() => {
    const { uniqueSongs, artists, albums, playlists } = processedData;

    // All tab content (limited items)
    const allContent = {
      songsList: uniqueSongs.slice(0, 4).map(cardGenerators.songListItem),
      artistsGrid: artists.slice(0, 6).map(a => cardGenerators.artistCard(a, 'compact')),
      albumsGrid: albums.slice(0, 4).map(a => cardGenerators.albumCard(a, 'compact')),
      playlistsGrid: playlists.slice(0, 6).map(p => cardGenerators.playlistCard(p, 'compact'))
    };

    // Full tab content (all items)
    const fullContent = {
      songTable: uniqueSongs.map(cardGenerators.songTableRow),
      artistGrid: artists.map(a => cardGenerators.artistCard(a, 'full')),
      albumGrid: albums.map(a => cardGenerators.albumCard(a, 'full')),
      playlistGrid: playlists.map(p => cardGenerators.playlistCard(p, 'full'))
    };

    return { allContent, fullContent };
  }, [processedData, cardGenerators]);

  return (
    <section className="search-results">
      <InfoHeader
        id="artist-heading"
        title={t('search.results')}
        meta={query ? t('search.resultsFor', undefined, { query }) : undefined}
        actions={tabActions}
        initialShrink={1}
      />
      <div className='sr-results'>
        {!processedData.hasAny ? (
          <div className="sr-no-results">{t('search.noResults', 'No items found')}</div>
        ) : (
          <>
            {tab === 'all' && (
              <>
                {renderedContent.allContent.songsList.length > 0 && (
                  <div className="sr-section sr-songs">
                    <div className="sr-section-header">
                      <h2>{t('search.songs', 'Songs')}</h2>
                    </div>
                    <ul className="sr-list">{renderedContent.allContent.songsList}</ul>
                  </div>
                )}
                {renderedContent.allContent.artistsGrid.length > 0 && (
                  <div className="sr-section sr-artists">
                    <div className="sr-section-header">
                      <h2>{t('search.artists', 'Artists')}</h2>
                    </div>
                    <div className="sr-list sr-grid">{renderedContent.allContent.artistsGrid}</div>
                  </div>
                )}
                {renderedContent.allContent.albumsGrid.length > 0 && (
                  <div className="sr-section sr-albums">
                    <div className="sr-section-header">
                      <h2>{t('search.albums', 'Albums')}</h2>
                    </div>
                    <div className="sr-list sr-grid">{renderedContent.allContent.albumsGrid}</div>
                  </div>
                )}
                {renderedContent.allContent.playlistsGrid.length > 0 && (
                  <div className="sr-section sr-playlists">
                    <div className="sr-section-header">
                      <h2>{t('search.playlists', 'Playlists')}</h2>
                    </div>
                    <div className="sr-list sr-grid">{renderedContent.allContent.playlistsGrid}</div>
                  </div>
                )}
              </>
            )}
            {tab === 'songs' && (
              <table className="sr-table sr-table-compact">
                <thead>
                  <tr>
                    <th>{t('search.title', 'Title')}</th>
                    <th>{t('search.album', 'Album')}</th>
                    <th>{t('search.length', 'Length')}</th>
                  </tr>
                </thead>
                <tbody>{renderedContent.fullContent.songTable}</tbody>
              </table>
            )}
            {tab === 'artists' && (
              <div className="sr-grid-vertical sr-artists">{renderedContent.fullContent.artistGrid}</div>
            )}
            {tab === 'albums' && (
              <div className="sr-grid-vertical">{renderedContent.fullContent.albumGrid}</div>
            )}
            {tab === 'playlists' && (
              <div className="sr-grid-vertical">{renderedContent.fullContent.playlistGrid}</div>
            )}
          </>
        )}
      </div>
    </section>
  );
}