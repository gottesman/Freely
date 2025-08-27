import React, { useState } from 'react'
import '../styles/search-results.css'
import { useI18n } from '../core/i18n'
import { usePlayback } from '../core/playback'
import { useGlobalAddToPlaylistModal } from '../core/AddToPlaylistModalContext'
import useArtistBuckets from '../core/hooks/useArtistBuckets'
import { fetchAlbumTracks, fetchArtistTracks, fetchPlaylistTracks } from '../core/spotify-helpers'

type Song = { id: string | number; name: string; artists?: { name: string }[]; album?: { name: string; images?: { url: string }[] } }
type Artist = { id: string | number; name: string; images?: { url: string }[] }
type Album = { id: string | number; name: string; artist?: string; artists?: { name: string }[]; images?: { url: string }[] }
type Playlist = { id: string | number; name: string; totalTracks?: number; images?: { url: string }[] }

export default function SearchResults({
  query,
  results,
  onSelectArtist,
  onSelectAlbum,
  onSelectPlaylist,
  onSelectTrack,
  onMoreClick
}: {
  query?: string
  results?: {
    songs?: Song[]
    artists?: Artist[]
    albums?: Album[]
    playlists?: Playlist[]
  }
  onSelectArtist?: (id: string)=>void
  onSelectAlbum?: (id: string)=>void
  onSelectPlaylist?: (id: string)=>void
  onSelectTrack?: (id: string)=>void
  onMoreClick?: (id: string)=>void
}){
  const { t } = useI18n();
  const { playNow } = usePlayback();
  const { openModal } = useGlobalAddToPlaylistModal();

  const songs = results?.songs || []
  const artists = results?.artists || []
  const albums = results?.albums || []
  const playlists = results?.playlists || []

  // Deduplicate songs by id (preserve first occurrence order)
  const uniqueSongs = React.useMemo(() => {
    const seen = new Set<string>();
    const out: typeof songs = [];
    for (const s of songs) {
      const key = s && s.id !== undefined && s.id !== null ? String(s.id) : '';
      if (!key) continue; // skip items without id
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }, [songs]);

  // Only display a small subset of the returned items per type
  const displayedSongs = uniqueSongs.slice(0, 4)
  const displayedArtists = artists.slice(0, 6)
  const displayedAlbums = albums.slice(0, 4)
  const displayedPlaylists = playlists.slice(0, 6)

  const hasAny = !!query && (uniqueSongs.length || artists.length || albums.length || playlists.length)

  const [tab, setTab] = useState<'all'|'songs'|'artists'|'albums'|'playlists'>('all')

  const fmtLength = (ms?: number) => {
    if (!ms && ms !== 0) return '';
    const s = Math.floor((ms || 0) / 1000);
    const mm = Math.floor(s / 60).toString();
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const highlight = (text: string, q?: string) => {
    if (!q) return text
    try {
      const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'ig'))
      return (
        <>
          {parts.map((part, i) =>
            part.toLowerCase() === q.toLowerCase() ? (
              <span key={i} className="sr-highlight">{part}</span>
            ) : (
              <span key={i}>{part}</span>
            )
          )}
        </>
      )
    } catch (e) {
      return text
    }
  }

  // Lazy-loading cache for fetched collections (artist/album/playlist -> simple track array)
  const [collectionCache, setCollectionCache] = React.useState<Record<string, Song[] | undefined>>({});

  function addPlayButton(tracks: Song[] | undefined) {
    if (!tracks || tracks.length === 0) return null;
    const ids = tracks.map(t => String(t.id)).filter(Boolean);
    if (!ids.length) return null;
    return (
      <div
        className='media-play-overlay'
        role="button"
        aria-label={t('player.play','Play')}
        onClick={(e) => { e.stopPropagation(); playNow(ids); }}
      >
        <span className="material-symbols-rounded filled">play_arrow</span>
      </div>
    );
  }

  const loadCollection = async (kind: 'album' | 'artist' | 'playlist', id?: string | number) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    if (collectionCache[key] !== undefined) return; // already loaded (could be undefined if failed)
    try {
      let tracks: Song[] | undefined;
      if (kind === 'album') tracks = await fetchAlbumTracks(id, { limit: 10 }) as any;
      else if (kind === 'artist') tracks = await fetchArtistTracks(id, { limit: 10 }) as any;
      else tracks = await fetchPlaylistTracks(id, { limit: 10 }) as any;
      setCollectionCache(prev => ({ ...prev, [key]: tracks }));
    } catch (e) {
      setCollectionCache(prev => ({ ...prev, [key]: undefined }));
    }
  }

  const renderCollectionPlay = (kind: 'album' | 'artist' | 'playlist', id?: string | number) => {
    if (!id) return null;
    const key = `${kind}:${id}`;
    const cached = collectionCache[key];
    // If cached tracks available, render real play button
    if (cached && cached.length) return addPlayButton(cached as any);

    // Otherwise render a lazy play button: preload on hover, fetch+play on click
    return (
      <div
        className='media-play-overlay'
        role="button"
        aria-label={t('player.play','Play')}
        onMouseEnter={() => loadCollection(kind, id)}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            let res: Song[] | undefined;
            if (kind === 'album') res = await fetchAlbumTracks(id as any, { limit: 50 }) as any;
            else if (kind === 'artist') res = await fetchArtistTracks(id as any, { limit: 50 }) as any;
            else res = await fetchPlaylistTracks(id as any, { limit: 50 }) as any;
            if (res && res.length) {
              playNow(res.map(r => String((r as any).id)));
              setCollectionCache(prev => ({ ...prev, [key]: res }));
            }
          } catch (err) {
            console.warn('play collection failed', err);
          }
        }}
      >
        <span className="material-symbols-rounded filled">play_arrow</span>
      </div>
    );
  }

  if (!query) {
    return (
      <section className="search-results">
        <h1>{t('search.results')}</h1>
        <div className="sr-empty">{t('search.resultsEmpty')}</div>
      </section>
    )
  }

  return (
    <section className="search-results">
      <div className='sr-header'>
        <h1>{t('search.resultsFor', undefined, { query })}</h1>
        <div className="sr-tabs">
          <button className={"sr-tab " + (tab==='all'?'active':'')} onClick={()=>setTab('all')}>{t('search.tab.all','All')}</button>
          <button className={"sr-tab " + (tab==='songs'?'active':'')} onClick={()=>setTab('songs')}>{t('search.songs','Songs')}</button>
          <button className={"sr-tab " + (tab==='artists'?'active':'')} onClick={()=>setTab('artists')}>{t('search.artists','Artists')}</button>
          <button className={"sr-tab " + (tab==='albums'?'active':'')} onClick={()=>setTab('albums')}>{t('search.albums','Albums')}</button>
          <button className={"sr-tab " + (tab==='playlists'?'active':'')} onClick={()=>setTab('playlists')}>{t('search.playlists','Playlists')}</button>
        </div>
      </div>
      <div className='sr-results'>
        {!hasAny && (
          <div className="sr-no-results">{t('search.noResults', 'No items found')}</div>
        )}

        {/* All tab: existing compact preview */}
        {tab === 'all' && (
          <>
            {songs.length > 0 && (
              <div className="sr-section sr-songs">
                <div className="sr-section-header">
                  <h2>{t('search.songs', 'Songs')}</h2>
                </div>
                <ul className="sr-list">
                  {displayedSongs.map(s => (
                      <li key={String(s.id)} className="sr-item" onClick={() => onSelectTrack && onSelectTrack(String(s.id))}>
                        <div className="sr-thumb">
                          {s.album?.images?.[s.album?.images?.length - 1]?.url ? <img src={s.album.images[s.album.images.length - 1].url} alt=""/> : <span className="material-symbols-rounded">music_note</span>}
                          <div className='play-button' onClick={(e)=>{ e.stopPropagation(); playNow(String(s.id)); }}>
                            <span className="material-symbols-rounded filled">play_arrow</span>
                          </div>
                        </div>
                        <div className="sr-main">
                          <div className="sr-meta">
                            <div className="sr-name">{highlight(s.name, query)}</div>
                            <div className="sr-sub">{s.artists?.map(a => a.name).join(', ')}</div>
                          </div>
                          <div className="sr-controls">
                            <button type="button" className="player-icons add-to-playlist" title={"Add to playlist"} onClick={(e)=>{ e.stopPropagation(); openModal && openModal(s); }}><span className="material-symbols-rounded">add_circle</span></button>
                            <div className="sr-time">{fmtLength((s as any).durationMs || (s as any).duration)}</div>
                            <button type="button" className="player-icons sr-more" title={"More"} onClick={(e)=>{ e.stopPropagation(); onMoreClick && onMoreClick(String(s.id)); }}>
                              <span className="material-symbols-rounded bold">more_horiz</span>
                            </button>
                          </div>
                        </div>
                      </li>
                  ))}
                </ul>
              </div>
            )}

            {artists.length > 0 && (
              <div className="sr-section sr-artists">
                <div className="sr-section-header">
                  <h2>{t('search.artists', 'Artists')}</h2>
                </div>
                <div className="sr-list sr-grid">
                  {displayedArtists.map(a => (
                      <div className="media-card compact" role="button" onClick={() => onSelectArtist && onSelectArtist(String(a.id))}>
                        <div className="media-cover circle">
                          <div className="media-cover-inner">
                            {a.images?.[a.images?.length - 1]?.url ? (
                              <img src={a.images[a.images.length - 1].url} alt="" />
                            ) : (
                              <span className="material-symbols-rounded">person</span>
                            )}
                          </div>
                          {renderCollectionPlay('artist', a.id)}
                        </div>
                        <h3 className="media-title">{highlight(a.name, query)}</h3>
                      </div>
                  ))}
                </div>
              </div>
            )}

            {albums.length > 0 && (
              <div className="sr-section sr-albums">
                <div className="sr-section-header">
                  <h2>{t('search.albums', 'Albums')}</h2>
                </div>
                <div className="sr-list sr-grid">
                  {displayedAlbums.map(al => (
                      <div className="media-card compact" role="button" onClick={() => onSelectAlbum && onSelectAlbum(String(al.id))}>
                        <div className="media-cover square">
                          <div className="media-cover-inner">
                            {al.images?.[al.images.length - 1]?.url ? (
                              <img src={al.images[al.images.length - 1].url} alt="" />
                            ) : (
                              <span className="material-symbols-rounded">album</span>
                            )}
                          </div>
                          {renderCollectionPlay('album', al.id)}
                        </div>
                        <h3 className="media-title">{highlight(al.name, query)}</h3>
                        <div className="media-meta">{(al.artists?.map(a => a.name).join(', ')) || al.artist}</div>
                      </div>
                  ))}
                </div>
              </div>
            )}

            {playlists.length > 0 && (
              <div className="sr-section sr-playlists">
                <div className="sr-section-header">
                  <h2>{t('search.playlists', 'Playlists')}</h2>
                </div>
                <div className="sr-list sr-grid">
                  {displayedPlaylists.map(p => (
                      <div className="media-card compact" role="button" onClick={() => onSelectPlaylist && onSelectPlaylist(String(p.id))}>
                        <div className="media-cover square">
                          <div className="media-cover-inner">
                            {p.images?.[p.images.length - 1]?.url ? (
                              <img src={p.images[p.images.length - 1].url} alt="" />
                            ) : (
                              <span className="material-symbols-rounded">queue_music</span>
                            )}
                          </div>
                          {renderCollectionPlay('playlist', p.id)}
                        </div>
                        <h3 className="media-title">{highlight(p.name, query)}</h3>
                        <div className="media-meta">{(p.totalTracks || 0) + ' ' + t('pl.tracks','tracks')}</div>
                      </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Songs tab: full table (compact) */}
        {tab === 'songs' && (
            <table className="sr-table sr-table-compact">
              <thead>
                <tr>
                  <th>{t('search.title','Title')}</th>
                  <th>{t('search.album','Album')}</th>
                  <th>{t('search.length','Length')}</th>
                </tr>
              </thead>
              <tbody>
                {uniqueSongs.map((s, i) => (
                  <tr key={String(s.id)} className="sr-table-row" onClick={() => onSelectTrack && onSelectTrack(String(s.id))}>
                    <td>
                      <div className="sr-title-with-thumb">
                        <div className="sr-thumb-inline" aria-hidden>
                          {s.album?.images?.[s.album?.images?.length - 1]?.url ? <img src={s.album.images[s.album.images.length - 1].url} alt="" /> : <span className="material-symbols-rounded">music_note</span>}
                        </div>
                        <div className="sr-title-meta">
                          <div className="sr-table-title">{highlight(s.name, query)}</div>
                          <div className="sr-table-sub">{s.artists?.map(a => a.name).join(', ')}</div>
                        </div>
                      </div>
                    </td>
                    <td className="sr-table-album">{s.album?.name || ''}</td>
                    <td className="sr-td-right">{fmtLength((s as any).durationMs || (s as any).duration)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        )}

        {/* Artists / Albums / Playlists tabs: full grid */}
        {tab === 'artists' && (
            <div className="sr-grid-vertical">
              {(artists||[]).map(a => (
                <div key={String(a.id)} className="media-card" onClick={() => onSelectArtist && onSelectArtist(String(a.id))}>
                  <div className="media-cover circle"><div className="media-cover-inner">{a.images?.[0]?.url ? <img src={a.images[0].url} alt=""/> : <span className="material-symbols-rounded">person</span>}</div>{renderCollectionPlay('artist', a.id)}</div>
                  <h3 className="media-title">{a.name}</h3>
                </div>
              ))}
            </div>
        )}

        {tab === 'albums' && (
            <div className="sr-grid-vertical">
              {(albums||[]).map(al => (
                <div key={String(al.id)} className="media-card" onClick={() => onSelectAlbum && onSelectAlbum(String(al.id))}>
                  <div className="media-cover square"><div className="media-cover-inner">{al.images?.[0]?.url ? <img src={al.images[0].url} alt=""/> : <span className="material-symbols-rounded">album</span>}</div>{renderCollectionPlay('album', al.id)}</div>
                  <h3 className="media-title">{highlight(al.name, query)}</h3>
                  {((al.artists && al.artists.length) || al.artist) ? (
                    <div className="media-meta">{highlight((al.artists?.map(a => a.name).join(', ')) || al.artist || '', query)}</div>
                  ) : null}
                </div>
              ))}
            </div>
        )}

        {tab === 'playlists' && (
            <div className="sr-grid-vertical">
              {(playlists||[]).map(p => (
                <div key={String(p.id)} className="media-card" onClick={() => onSelectPlaylist && onSelectPlaylist(String(p.id))}>
                  <div className="media-cover square"><div className="media-cover-inner">{p.images?.[0]?.url ? <img src={p.images[0].url} alt=""/> : <span className="material-symbols-rounded">queue_music</span>}</div>{renderCollectionPlay('playlist', p.id)}</div>
                  <h3 className="media-title">{p.name}</h3>
                  <div className="media-meta">{(p.totalTracks || 0) + ' ' + t('pl.tracks','tracks')}</div>
                </div>
              ))}
            </div>
        )}
      </div>
    </section>
  )
}
