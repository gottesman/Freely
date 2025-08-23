import React, { useState } from 'react'
import { useI18n } from '../core/i18n'

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
  onSelectTrack
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
}){
  const { t } = useI18n();

  const songs = results?.songs || []
  const artists = results?.artists || []
  const albums = results?.albums || []
  const playlists = results?.playlists || []

  // Only display a small subset of the returned items per type
  const displayedSongs = songs.slice(0, 4)
  const displayedArtists = artists.slice(0, 6)
  const displayedAlbums = albums.slice(0, 3)
  const displayedPlaylists = playlists.slice(0, 6)

  const hasAny = !!query && (songs.length || artists.length || albums.length || playlists.length)

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
                    <li key={s.id} className="sr-item">
                      <button type="button" className="sr-card" onClick={() => onSelectTrack && onSelectTrack(String(s.id))}>
                        <div className="sr-thumb">
                          {s.album?.images?.[0]?.url ? <img src={s.album.images[0].url} alt=""/> : <span className="material-symbols-rounded">music_note</span>}
                        </div>
                        <div className="sr-meta">
                          <div className="sr-name">{highlight(s.name, query)}</div>
                          <div className="sr-sub">{s.artists?.map(a => a.name).join(', ')}</div>
                        </div>
                      </button>
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
                <ul className="sr-list sr-grid">
                  {displayedArtists.map(a => (
                    <li key={a.id} className="sr-item sr-compact">
                      <button type="button" className="sr-card sr-card-compact" onClick={() => onSelectArtist && onSelectArtist(String(a.id))}>
                        <div className="sr-thumb">
                          {a.images?.[0]?.url ? <img src={a.images[0].url} alt=""/> : <span className="material-symbols-rounded">person</span>}
                        </div>
                        <div className="sr-meta">
                          <div className="sr-name">{highlight(a.name, query)}</div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {albums.length > 0 && (
              <div className="sr-section sr-albums">
                <div className="sr-section-header">
                  <h2>{t('search.albums', 'Albums')}</h2>
                </div>
                <ul className="sr-list sr-grid">
                  {displayedAlbums.map(al => (
                    <li key={al.id} className="sr-item sr-compact">
                      <button type="button" className="sr-card sr-card-compact" onClick={() => onSelectAlbum && onSelectAlbum(String(al.id))}>
                        <div className="sr-thumb">
                          {al.images?.[0]?.url ? <img src={al.images[0].url} alt=""/> : <span className="material-symbols-rounded">album</span>}
                        </div>
                              <div className="sr-meta">
                                <div className="sr-name">{highlight(al.name, query)}</div>
                                <div className="sr-sub">{(al.artists?.map(a => a.name).join(', ')) || al.artist}</div>
                              </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {playlists.length > 0 && (
              <div className="sr-section sr-playlists">
                <div className="sr-section-header">
                  <h2>{t('search.playlists', 'Playlists')}</h2>
                </div>
                <ul className="sr-list">
                  {displayedPlaylists.map(p => (
                    <li key={p.id} className="sr-item">
                      <button type="button" className="sr-card" onClick={() => onSelectPlaylist && onSelectPlaylist(String(p.id))}>
                        <div className="sr-thumb">
                          {p.images?.[0]?.url ? <img src={p.images[0].url} alt=""/> : <span className="material-symbols-rounded">queue_music</span>}
                        </div>
                        <div className="sr-meta">
                          <div className="sr-name">{highlight(p.name, query)}</div>
                          <div className="sr-sub">{(p.totalTracks || 0) + ' ' + t('pl.tracks', 'tracks')}</div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {/* Songs tab: full table (compact) */}
        {tab === 'songs' && (
            <table className="sr-table sr-table-compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('search.title','Title')}</th>
                  <th>{t('search.album','Album')}</th>
                  <th>{t('search.length','Length')}</th>
                </tr>
              </thead>
              <tbody>
                {songs.map((s, i) => (
                  <tr key={String(s.id)} className="sr-table-row" onClick={() => onSelectTrack && onSelectTrack(String(s.id))}>
                    <td className="sr-td-index">{i+1}</td>
                    <td>
                      <div className="sr-title-with-thumb">
                        <div className="sr-thumb-inline" aria-hidden>
                          {s.album?.images?.[0]?.url ? <img src={s.album.images[0].url} alt="" /> : <span className="material-symbols-rounded">music_note</span>}
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
                <div key={String(a.id)} className="media-card compact" onClick={() => onSelectArtist && onSelectArtist(String(a.id))}>
                  <div className="media-cover circle">{a.images?.[0]?.url ? <img src={a.images[0].url} alt=""/> : <span className="material-symbols-rounded">person</span>}</div>
                  <h3 className="media-title">{a.name}</h3>
                </div>
              ))}
            </div>
        )}

        {tab === 'albums' && (
            <div className="sr-grid-vertical">
              {(albums||[]).map(al => (
                <div key={String(al.id)} className="media-card compact" onClick={() => onSelectAlbum && onSelectAlbum(String(al.id))}>
                  <div className="media-cover square">{al.images?.[0]?.url ? <img src={al.images[0].url} alt=""/> : <span className="material-symbols-rounded">album</span>}</div>
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
                <div key={String(p.id)} className="media-card compact" onClick={() => onSelectPlaylist && onSelectPlaylist(String(p.id))}>
                  <div className="media-cover square">{p.images?.[0]?.url ? <img src={p.images[0].url} alt=""/> : <span className="material-symbols-rounded">queue_music</span>}</div>
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
