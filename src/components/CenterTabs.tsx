import React, { useState, useEffect } from 'react'
import HomeTab from './HomeTab'
import NowPlayingTab from './NowPlayingTab'
import SearchResults from './SearchResults'
import Tests from './Tests'

export default function CenterTabs({ initial = 'home', searchQuery, searchTrigger, activeTab, onTabChange }: { initial?: string, searchQuery?: string, searchTrigger?: number, activeTab?: string, onTabChange?: (t: string)=>void }){
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
        {tab === 'now' && <NowPlayingTab />}
  {tab === 'search' && <SearchResults query={searchQuery} />}
  {tab === 'apis' && <Tests />}
      </div>
    </main>
  )
}
