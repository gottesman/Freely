import React, { useState, useEffect } from 'react'
import HomeTab from './HomeTab'
import SongInfoTab from './SongInfoTab'
import AlbumInfoTab from './AlbumInfoTab'
import PlaylistInfoTab from './PlaylistInfoTab'
import ArtistInfoTab from './ArtistInfoTab'
import SearchResults from './SearchResults'
import Tests from './Tests'

export default function CenterTabs({ initial = 'home', searchQuery, searchTrigger, activeTab, onTabChange, songTrackId, albumId, playlistId, artistId, onSelectArtist, onSelectAlbum, onSelectPlaylist, onSelectTrack }: { initial?: string, searchQuery?: string, searchTrigger?: number, activeTab?: string, onTabChange?: (t: string)=>void, songTrackId?: string, albumId?: string, playlistId?: string, artistId?: string, onSelectArtist?: (id: string)=>void, onSelectAlbum?: (id: string)=>void, onSelectPlaylist?: (id: string)=>void, onSelectTrack?: (id: string)=>void }){
  const [internalTab, setInternalTab] = useState(initial)
  const tab = activeTab !== undefined ? activeTab : internalTab;
  const setTab = (t: string) => { if(onTabChange) onTabChange(t); if(activeTab === undefined) setInternalTab(t); };

  useEffect(() => {
    if (searchTrigger) setTab('search')
  }, [searchTrigger])

  return (
    <main className="center-tabs">
      <div className="tabs-body">
  {tab === 'home' && <HomeTab />}
  {tab === 'song' && <SongInfoTab trackId={songTrackId} onSelectArtist={onSelectArtist} onSelectAlbum={onSelectAlbum} onSelectTrack={onSelectTrack} />}
  {tab === 'album' && <AlbumInfoTab albumId={albumId} onSelectArtist={onSelectArtist} onSelectTrack={onSelectTrack} />}
  {tab === 'playlist' && <PlaylistInfoTab playlistId={playlistId} />}
  {tab === 'artist' && <ArtistInfoTab artistId={artistId} onSelectAlbum={onSelectAlbum} onSelectPlaylist={onSelectPlaylist} onSelectTrack={onSelectTrack} />}
  {tab === 'search' && <SearchResults query={searchQuery} />}
  {tab === 'apis' && <Tests />}
      </div>
    </main>
  )
}
