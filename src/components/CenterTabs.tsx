import React, { useState, useEffect } from 'react'
import HomeTab from './HomeTab'
import SongInfoTab from './SongInfoTab'
import AlbumInfoTab from './AlbumInfoTab'
import PlaylistInfoTab from './PlaylistInfoTab'
import ArtistInfoTab from './ArtistInfoTab'
import SearchResults from './SearchResults'
import Settings from './Settings'
import Tests from './Tests'

export default function CenterTabs({ initial = 'home', searchQuery, searchTrigger, searchResults, searchLoading, activeTab, onTabChange, songTrackId, albumId, playlistId, artistId, onSelectArtist, onSelectAlbum, onSelectPlaylist, onSelectTrack }: { initial?: string, searchQuery?: string, searchTrigger?: number, searchResults?: any, searchLoading?: boolean, activeTab?: string, onTabChange?: (t: string)=>void, songTrackId?: string, albumId?: string, playlistId?: string, artistId?: string, onSelectArtist?: (id: string)=>void, onSelectAlbum?: (id: string)=>void, onSelectPlaylist?: (id: string)=>void, onSelectTrack?: (id: string)=>void }){
  const [internalTab, setInternalTab] = useState(initial)
  const tab = activeTab !== undefined ? activeTab : internalTab;
  const setTab = (t: string) => { if(onTabChange) onTabChange(t); if(activeTab === undefined) setInternalTab(t); };

  useEffect(() => {
    if (searchTrigger) setTab('search')
  }, [searchTrigger])

  // When normalized searchResults arrive while on the search tab, scroll them into view
  useEffect(() => {
    if (tab !== 'search') return;
    const raw = searchResults?.results || searchResults;
    const normalized = raw ? {
      songs: raw.track || raw.tracks || raw.songs || [],
      artists: raw.artist || raw.artists || [],
      albums: raw.album || raw.albums || [],
      playlists: raw.playlist || raw.playlists || []
    } : undefined;
    const anyCount = normalized && (normalized.songs.length || normalized.artists.length || normalized.albums.length || normalized.playlists.length);
    if (anyCount) {
      // Defer to next frame to ensure DOM rendered
      requestAnimationFrame(() => {
        const el = document.querySelector('.search-results');
        if (el) {
          if ((el as HTMLElement).scrollIntoView) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
          // briefly add a class to make the results more visible
          el.classList.add('results-arrived');
          setTimeout(() => el.classList.remove('results-arrived'), 1200);
        }
      })
    }
  }, [tab, searchResults])

  // When local data is cleared, if we are on a playlist (or song/album/artist referencing deleted data) navigate home
  useEffect(()=>{
    function handleCleared(){
      if(['playlist','album','artist','song'].includes(tab)){
        setTab('home')
      }
    }
    window.addEventListener('freely:localDataCleared', handleCleared)
    return ()=> window.removeEventListener('freely:localDataCleared', handleCleared)
  }, [tab])

  return (
    <main className="center-tabs">
      <div className="tabs-body">
  {tab === 'home' && <HomeTab />}
  {tab === 'song' && <SongInfoTab trackId={songTrackId} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectTrack={onSelectTrack} />}
  {tab === 'album' && <AlbumInfoTab albumId={albumId} onSelectArtist={onSelectArtist} onSelectTrack={onSelectTrack} />}
  {tab === 'playlist' && <PlaylistInfoTab playlistId={playlistId} onSelectPlaylist={onSelectPlaylist} onSelectTrack={onSelectTrack} />}
  {tab === 'artist' && <ArtistInfoTab artistId={artistId} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} onSelectTrack={onSelectTrack} />}
  {tab === 'search' && (() => {
    const raw = searchResults?.results || searchResults;
    const normalized = raw ? {
      songs: raw.track || raw.tracks || raw.songs || [],
      artists: raw.artist || raw.artists || [],
      albums: raw.album || raw.albums || [],
      playlists: raw.playlist || raw.playlists || []
    } : undefined;
  console.log('[CenterTabs] normalized search results', normalized);
  return <SearchResults query={searchQuery} results={normalized} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} onSelectTrack={onSelectTrack} />;
  })()}
  {tab === 'settings' && <Settings />}
  {tab === 'apis' && <Tests />}
      </div>
    </main>
  )
}
