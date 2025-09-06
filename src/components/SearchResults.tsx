import React, { useState, useMemo, useCallback, MouseEvent } from 'react';
import '../styles/search-results.css';
import { useI18n } from '../core/i18n';
import { fetchAlbumTracks, fetchArtistTracks, fetchPlaylistTracks } from '../core/spotify-helpers';
import InfoHeader from './InfoHeader';

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

const HighlightedText: React.FC<{ text: string; query?: string }> = React.memo(({ text, query }) => {
  const parts = useMemo(() => {
    if (!query || !text) return [text];
    try {
      const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'));
    } catch (e) {
      return [text];
    }
  }, [text, query]);

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

const MediaCover: React.FC<{ type: CollectionKind | 'track'; images?: Image[] }> = React.memo(({ type, images }) => {
  const icon = type === 'track' ? 'music_note' : type === 'album' ? 'album' : type === 'artist' ? 'person' : 'queue_music';
  const imageUrl = images?.[Math.min(1, images.length - 1)]?.url;

  return (
    <div className="media-cover-inner">
      {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : <span className="material-symbols-rounded">{icon}</span>}
    </div>
  );
});

interface CollectionPlayButtonProps {
  kind: CollectionKind;
  id: string | number;
  onPlay: (ids: string[]) => void;
}
const CollectionPlayButton: React.FC<CollectionPlayButtonProps> = React.memo(({ kind, id, onPlay }) => {
  const { t } = useI18n();

  const loadAndPlay = useCallback(async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      const fetcher = kind === 'album' ? fetchAlbumTracks : kind === 'artist' ? fetchArtistTracks : fetchPlaylistTracks;
      const fetchedTracks = await fetcher(id, { limit: 50 }) as Song[];
      if (fetchedTracks?.length) {
        onPlay(fetchedTracks.map(t => String(t.id)));
      }
    } catch (err) {
      console.warn(`Failed to play collection ${kind}:${id}`, err);
    }
  }, [kind, id, onPlay]);

  return (
    <div className='media-play-overlay' role="button" aria-label={t('player.play','Play')} onClick={loadAndPlay}>
      <span className="material-symbols-rounded filled">play_arrow</span>
    </div>
  );
});

interface CardProps {
  query?: string;
  onSelect: () => void;
  onPlay: (ids: string[]) => void;
  layout: 'compact' | 'full';
}
const ArtistCard: React.FC<{ artist: Artist } & CardProps> = React.memo(({ artist, query, onSelect, onPlay, layout }) => (
  <div className={`media-card ${layout}`} role="button" onClick={onSelect}>
    <div className="media-cover circle"><MediaCover type="artist" images={artist.images} /><CollectionPlayButton kind="artist" id={artist.id} onPlay={onPlay} /></div>
    <h3 className="media-title"><HighlightedText text={artist.name} query={query} /></h3>
  </div>
));

const AlbumCard: React.FC<{ album: Album } & CardProps> = React.memo(({ album, query, onSelect, onPlay, layout }) => (
  <div className={`media-card ${layout}`} role="button" onClick={onSelect}>
    <div className="media-cover square"><MediaCover type="album" images={album.images} /><CollectionPlayButton kind="album" id={album.id} onPlay={onPlay} /></div>
    <h3 className="media-title"><HighlightedText text={album.name} query={query} /></h3>
    <div className="media-meta">{(album.artists?.map(a => a.name).join(', ')) || album.artist}</div>
  </div>
));

const PlaylistCard: React.FC<{ playlist: Playlist } & CardProps> = React.memo(({ playlist, query, onSelect, onPlay, layout }) => {
  const { t } = useI18n();
  return (
    <div className={`media-card ${layout}`} role="button" onClick={onSelect}>
      <div className="media-cover square"><MediaCover type="playlist" images={playlist.images} /><CollectionPlayButton kind="playlist" id={playlist.id} onPlay={onPlay} /></div>
      <h3 className="media-title"><HighlightedText text={playlist.name} query={query} /></h3>
      <div className="media-meta">{`${playlist.totalTracks || 0} ${t('pl.tracks','tracks')}`}</div>
    </div>
  );
});

interface SongListItemProps { song: Song; query?: string; onSelect: () => void; onPlay: () => void; onAddToPlaylist: () => void; onMore: () => void; }
const SongListItem: React.FC<SongListItemProps> = React.memo(({ song, query, onSelect, onPlay, onAddToPlaylist, onMore }) => {
  const { t } = useI18n();
  const fmtLength = (ms = 0) => `${Math.floor(ms/60000)}:${(Math.floor(ms/1000)%60).toString().padStart(2,'0')}`;
  const handleAction = useCallback((e: MouseEvent, action: () => void) => { e.stopPropagation(); action(); }, []);

  return (
    <li className="sr-item" onClick={onSelect}>
      <div className="sr-thumb"><MediaCover type="track" images={song.album?.images} /><div className='play-button' onClick={(e) => handleAction(e, onPlay)}><span className="material-symbols-rounded filled">play_arrow</span></div></div>
      <div className="sr-main">
        <div className="sr-meta">
          <div className="sr-name overflow-ellipsis"><HighlightedText text={song.name} query={query} /></div>
          <div className="sr-sub overflow-ellipsis">{song.artists?.map(a => a.name).join(', ')}</div>
        </div>
        <div className="sr-controls">
          <button type="button" className="player-icons" title={t('playlist.add')} onClick={(e) => handleAction(e, onAddToPlaylist)}><span className="material-symbols-rounded">add_circle</span></button>
          <div className="sr-time">{fmtLength(song.durationMs)}</div>
          <button type="button" className="player-icons sr-more" title={t('common.more')} onClick={(e) => handleAction(e, onMore)}><span className="material-symbols-rounded bold">more_horiz</span></button>
        </div>
      </div>
    </li>
  );
});

interface SongTableRowProps { song: Song; query?: string; onSelect: () => void; }
const SongTableRow: React.FC<SongTableRowProps> = React.memo(({ song, query, onSelect }) => {
  const fmtLength = (ms = 0) => `${Math.floor(ms/60000)}:${(Math.floor(ms/1000)%60).toString().padStart(2,'0')}`;
  return (
    <tr className="sr-table-row" onClick={onSelect}>
      <td>
        <div className="sr-title-with-thumb overflow-ellipsis">
          <div className="sr-thumb-inline" aria-hidden><MediaCover type="track" images={song.album?.images} /></div>
          <div className="sr-title-meta overflow-ellipsis">
            <div className="sr-table-title overflow-ellipsis"><HighlightedText text={song.name} query={query} /></div>
            <div className="sr-table-sub overflow-ellipsis">{song.artists?.map(a => a.name).join(', ')}</div>
          </div>
        </div>
      </td>
      <td className="sr-table-album overflow-ellipsis">{song.album?.name || ''}</td>
      <td className="sr-td-right">{fmtLength(song.durationMs)}</td>
    </tr>
  );
});

export default function SearchResults({ query, results, onMoreClick }: SearchResultsProps) {
  const { t } = useI18n();
  const playNow = (ids: string | string[]) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    window.dispatchEvent(new CustomEvent('freely:playback:playNow',{ detail:{ ids: arr } }));
  };
  const [tab, setTab] = useState<'all'|'songs'|'artists'|'albums'|'playlists'>('all');

  const uniqueSongs = useMemo(() => {
    const seen = new Set<string>();
    return (results?.songs || []).filter(s => {
      if (!s || s.id === undefined || s.id === null) return false;
      const key = String(s.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [results?.songs]);

  const artists = results?.artists || [];
  const albums = results?.albums || [];
  const playlists = results?.playlists || [];
  const hasAny = !!query && (uniqueSongs.length > 0 || artists.length > 0 || albums.length > 0 || playlists.length > 0);

  const handlePlayNow = useCallback((ids: string | string[]) => playNow(ids), [playNow]);
  const handleSelectTrack = useCallback((id?: string | number) => {
    if(id !== undefined) window.dispatchEvent(new CustomEvent('freely:selectTrack',{ detail:{ trackId:String(id), source:'search' } }));
  }, []);
  const handleSelectPlaylist = useCallback((id?: string | number) => {
    if(id !== undefined) window.dispatchEvent(new CustomEvent('freely:selectPlaylist',{ detail:{ playlistId:String(id), source:'search' } }));
  }, []);

  const handleMore = useCallback((id: string) => onMoreClick?.(id), [onMoreClick]);
  const handleAddToPlaylist = useCallback((song: Song) => {
    window.dispatchEvent(new CustomEvent('freely:openAddToPlaylistModal',{ detail:{ track: song } }));
  }, []);

  const allSongsList = useMemo(() => uniqueSongs.slice(0, 4).map(s => <SongListItem key={String(s.id)} song={s} query={query} onSelect={() => handleSelectTrack(s.id)} onPlay={() => handlePlayNow(String(s.id))} onAddToPlaylist={() => handleAddToPlaylist(s)} onMore={() => handleMore(String(s.id))} />), [uniqueSongs, query, handlePlayNow, handleAddToPlaylist, handleMore, handleSelectTrack]);
  const allArtistsGrid = useMemo(() => artists.slice(0, 6).map(a => <ArtistCard key={String(a.id)} artist={a} query={query} layout="compact" onSelect={() => { if(a.id) window.dispatchEvent(new CustomEvent('freely:selectArtist',{ detail:{ artistId:a.id, source:'search' } })); }} onPlay={handlePlayNow} />), [artists, query, handlePlayNow]);
  const allAlbumsGrid = useMemo(() => albums.slice(0, 4).map(a => <AlbumCard key={String(a.id)} album={a} query={query} layout="compact" onSelect={() => { if(a.id) window.dispatchEvent(new CustomEvent('freely:selectAlbum',{ detail:{ albumId:a.id, source:'search' } })); }} onPlay={handlePlayNow} />), [albums, query, handlePlayNow]);
  const allPlaylistsGrid = useMemo(() => playlists.slice(0, 6).map(p => <PlaylistCard key={String(p.id)} playlist={p} query={query} layout="compact" onSelect={() => handleSelectPlaylist(p.id)} onPlay={handlePlayNow} />), [playlists, query, handlePlayNow, handleSelectPlaylist]);
  
  const fullSongTable = useMemo(() => uniqueSongs.map(s => <SongTableRow key={String(s.id)} song={s} query={query} onSelect={() => handleSelectTrack(s.id)} />), [uniqueSongs, query, handleSelectTrack]);
  const fullArtistGrid = useMemo(() => artists.map(a => <ArtistCard key={String(a.id)} artist={a} query={query} layout="full" onSelect={() => { if(a.id) window.dispatchEvent(new CustomEvent('freely:selectArtist',{ detail:{ artistId:a.id, source:'search' } })); }} onPlay={handlePlayNow} />), [artists, query, handlePlayNow]);
  const fullAlbumGrid = useMemo(() => albums.map(a => <AlbumCard key={String(a.id)} album={a} query={query} layout="full" onSelect={() => { if(a.id) window.dispatchEvent(new CustomEvent('freely:selectAlbum',{ detail:{ albumId:a.id, source:'search' } })); }} onPlay={handlePlayNow} />), [albums, query, handlePlayNow]);
  const fullPlaylistGrid = useMemo(() => playlists.map(p => <PlaylistCard key={String(p.id)} playlist={p} query={query} layout="full" onSelect={() => handleSelectPlaylist(p.id)} onPlay={handlePlayNow} />), [playlists, query, handlePlayNow, handleSelectPlaylist]);

 // if (!query) return <section className="search-results"><h1>{t('search.results')}</h1><div className="sr-empty">{t('search.resultsEmpty')}</div></section>;

  return (
    <section className="search-results">
      <InfoHeader
          id="artist-heading"
          title={t('search.results')}
          meta={query ? t('search.resultsFor', undefined, { query }) : undefined}
          actions={
            [
              <button className={`sr-tab ${tab==='all'?'active':''}`} onClick={()=>setTab('all')}>{t('search.tab.all','All')}</button>,
              <button className={`sr-tab ${tab==='songs'?'active':''}`} onClick={()=>setTab('songs')}>{t('search.songs','Songs')}</button>,
              <button className={`sr-tab ${tab==='artists'?'active':''}`} onClick={()=>setTab('artists')}>{t('search.artists','Artists')}</button>,
              <button className={`sr-tab ${tab==='albums'?'active':''}`} onClick={()=>setTab('albums')}>{t('search.albums','Albums')}</button>,
              <button className={`sr-tab ${tab==='playlists'?'active':''}`} onClick={()=>setTab('playlists')}>{t('search.playlists','Playlists')}</button>
            ]
          }
          initialShrink={1}
      />
      {
        /*
        <div className='sr-header'>
          <div className="sr-tabs">
            <button className={`sr-tab ${tab==='all'?'active':''}`} onClick={()=>setTab('all')}>{t('search.tab.all','All')}</button>
            <button className={`sr-tab ${tab==='songs'?'active':''}`} onClick={()=>setTab('songs')}>{t('search.songs','Songs')}</button>
            <button className={`sr-tab ${tab==='artists'?'active':''}`} onClick={()=>setTab('artists')}>{t('search.artists','Artists')}</button>
            <button className={`sr-tab ${tab==='albums'?'active':''}`} onClick={()=>setTab('albums')}>{t('search.albums','Albums')}</button>
            <button className={`sr-tab ${tab==='playlists'?'active':''}`} onClick={()=>setTab('playlists')}>{t('search.playlists','Playlists')}</button>
          </div>
        </div>
        */
      }
      <div className='sr-results'>
        {!hasAny ? <div className="sr-no-results">{t('search.noResults', 'No items found')}</div> :
          <>
            {tab === 'all' && <>
              {allSongsList.length > 0 && <div className="sr-section sr-songs"><div className="sr-section-header"><h2>{t('search.songs', 'Songs')}</h2></div><ul className="sr-list">{allSongsList}</ul></div>}
              {allArtistsGrid.length > 0 && <div className="sr-section sr-artists"><div className="sr-section-header"><h2>{t('search.artists', 'Artists')}</h2></div><div className="sr-list sr-grid">{allArtistsGrid}</div></div>}
              {allAlbumsGrid.length > 0 && <div className="sr-section sr-albums"><div className="sr-section-header"><h2>{t('search.albums', 'Albums')}</h2></div><div className="sr-list sr-grid">{allAlbumsGrid}</div></div>}
              {allPlaylistsGrid.length > 0 && <div className="sr-section sr-playlists"><div className="sr-section-header"><h2>{t('search.playlists', 'Playlists')}</h2></div><div className="sr-list sr-grid">{allPlaylistsGrid}</div></div>}
            </>}
            {tab === 'songs' && <table className="sr-table sr-table-compact"><thead><tr><th>{t('search.title','Title')}</th><th>{t('search.album','Album')}</th><th>{t('search.length','Length')}</th></tr></thead><tbody>{fullSongTable}</tbody></table>}
            {tab === 'artists' && <div className="sr-grid-vertical">{fullArtistGrid}</div>}
            {tab === 'albums' && <div className="sr-grid-vertical">{fullAlbumGrid}</div>}
            {tab === 'playlists' && <div className="sr-grid-vertical">{fullPlaylistGrid}</div>}
          </>
        }
      </div>
    </section>
  );
}