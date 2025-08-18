import React from 'react'

export default function SearchResults({ query }: { query?: string }){
  return (
    <section className="search-results">
      <h3>Search Results</h3>
      <div>{query ? `Results for "${query}"` : '(Results will appear here)'}</div>
    </section>
  )
}
