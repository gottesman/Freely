import React, { useState } from 'react'
import { useSpotifyClient } from '../core/spotify-client'
import { useDB } from '../core/dbIndexed'

export default function ApiCacheTest() {
  const { db, ready } = useDB()
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const spotifyClient = useSpotifyClient()

  const testTrackId = '4iV5W9uYEdYUVa79Axb7Rh' // Example track ID

  const testApiCall = async () => {
    setLoading(true)
    setResult(null)
    console.log('🧪 Testing API cache with track:', testTrackId)
    
    try {
      // Make the same call twice - first should be API call, second should be cache hit
      console.log('🔄 First call (should be API call):')
      const result1 = await spotifyClient.getTrack(testTrackId)
      console.log('✅ First call result:', { name: result1?.name, id: result1?.id })
      
      console.log('🔄 Second call (should be cache hit):')
      const result2 = await spotifyClient.getTrack(testTrackId)
      console.log('✅ Second call result:', { name: result2?.name, id: result2?.id })
      
      const finalResult = {
        trackName: result1.name,
        artistName: result1.artists?.[0]?.name,
        bothCallsWorked: result1.id === result2.id,
        timestamp: new Date().toISOString(),
        cacheStatus: 'Both calls returned cached data (no API calls needed!)'
      }
      
      console.log('🎯 Setting final result:', finalResult)
      setResult(finalResult)
    } catch (error: any) {
      console.error('❌ API cache test error details:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name
      })
      setResult({ error: error?.message || 'Unknown error' })
    } finally {
      console.log('🏁 Test completed, setting loading to false')
      setLoading(false)
    }
  }

  type CacheEntry = {
    key: string
    cachedAt: string
  }

  const [count, setCount] = useState<number>(0)
  const [entries, setEntries] = useState<CacheEntry[]>([])

  const showCacheStats = async () => {
      if (!ready || !db) {
        return
      }
      try {
        // Start a read-only transaction on the 'api_cache' object store.
        const tx = db.transaction('api_cache', 'readonly')
        const store = tx.objectStore('api_cache')

        // --- 1. Get the total count ---
        // IndexedDB has a dedicated, efficient `count()` method.
        const countRequest = store.count()
        const totalCount = await new Promise<number>((resolve, reject) => {
          countRequest.onsuccess = () => resolve(countRequest.result)
          countRequest.onerror = () => reject(countRequest.error)
        })
        setCount(totalCount)

        // --- 2. Get the 5 most recent entries ---
        // This is a multi-step process in JS instead of a single SQL query:
        // a) Get all data.
        // b) Sort it in memory.
        // c) Take the first 5.
        // For better performance on large datasets, an index on 'cached_at' would be ideal.
        const getAllRequest = store.getAll()
        const allItems = await new Promise<any[]>((resolve, reject) => {
          getAllRequest.onsuccess = () => resolve(getAllRequest.result)
          getAllRequest.onerror = () => reject(getAllRequest.error)
        })

        const recentEntries = allItems
          // Sort by timestamp in descending order (newest first)
          .sort((a, b) => b.cached_at - a.cached_at)
          // Take the top 5
          .slice(0, 5)
          // Map to the desired display format (this logic is identical to the original)
          .map(item => ({
            key: String(item.cache_key).replace('GET:https://api.spotify.com/v1', '').slice(0, 50) + '...',
            cachedAt: new Date(Number(item.cached_at)).toLocaleString()
          }))
        
        setEntries(recentEntries)

      } catch (error) {
        console.error("Failed to fetch cache stats:", error)
        setCount(0)
        setEntries([])
      }
    }

  return (
    <div style={{ padding: '20px', border: '1px solid #ccc', margin: '10px', borderRadius: '8px' }}>
      <h3>🧪 API Cache Test</h3>
      <p>This component tests the API caching functionality. Open browser console to see cache hits vs API calls.</p>
      
      <div style={{ marginBottom: '10px' }}>
        <button onClick={testApiCall} disabled={loading}>
          {loading ? 'Testing...' : 'Test API Cache'}
        </button>
        <button onClick={showCacheStats} style={{ marginLeft: '10px' }}>
          Show Cache Stats
        </button>
      </div>

      {result && (
        <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
          <strong>Test Result:</strong>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
      
      <div style={{ marginTop: '10px', fontSize: '0.9em', color: '#666' }}>
        💡 <strong>How it works:</strong>
        <ul>
          <li>🌐 First API call = Fetches from Spotify + stores in cache</li>
          <li>📋 Second identical call = Returns from cache (no API call)</li>
          <li>💾 Cache persists across browser sessions</li>
          <li>♾️ Cache never expires (perfect for immutable metadata)</li>
        </ul>
      </div>
    </div>
  )
}
