import React, { useState, useEffect } from 'react'

export default function CenterTabs({ initial = 'home', searchQuery, searchTrigger }: { initial?: string, searchQuery?: string, searchTrigger?: number }){
  const [tab, setTab] = useState(initial)
  const [query, setQuery] = useState(searchQuery || '')

  useEffect(() => {
    // When parent triggers a search (timestamp changed) switch to search tab
    if (searchTrigger) setTab('search')
  }, [searchTrigger])

  useEffect(() => { if (typeof searchQuery !== 'undefined') setQuery(searchQuery) }, [searchQuery])

  return (
    <main className="center-tabs">
      <div className="tabs-header">
        <button className={tab==='home' ? 'active' : ''} onClick={() => setTab('home')}>Home</button>
        <button className={tab==='now' ? 'active' : ''} onClick={() => setTab('now')}>Now Playing</button>
        <button className={tab==='search' ? 'active' : ''} onClick={() => setTab('search')}>Search</button>
      </div>
      <div className="tabs-body">
        {tab === 'home' && (
          <section className="home-page">
            <h3>Latest launches</h3>
            <div className="row">(Latest items placeholder)</div>
            <h3>Recommended</h3>
            <div className="row">(Recommendations placeholder)</div>
            <h3>Most listened</h3>
            <div className="row">(Most listened placeholder)</div>
          </section>
        )}
        {tab === 'now' && (
          <section className="now-playing">
            <h3>Now Playing (expanded)</h3>
            <div>(Expanded player + lyrics/credits placeholder)</div>
          </section>
        )}
        {tab === 'search' && (
          <section className="search-results">
            <h3>Search Results</h3>
            <div>(Results will appear here)</div>
          </section>
        )}
      </div>
    </main>
  )
}
