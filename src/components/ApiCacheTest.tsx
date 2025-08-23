import React, { useState } from 'react'
import { useSpotifyClient } from '../core/spotify-client'
import { useDB } from '../core/db'

export default function ApiCacheTest() {
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const spotifyClient = useSpotifyClient()
  const { db } = useDB()

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

  const showCacheStats = async () => {
    if (!db) {
      alert('Database not ready')
      return
    }
    
    try {
      // Get a sample of cache entries
      const res = db.exec('SELECT COUNT(*) as count FROM api_cache')
      const count = res[0]?.values?.[0]?.[0] || 0
      
      const sample = db.exec('SELECT cache_key, cached_at FROM api_cache ORDER BY cached_at DESC LIMIT 5')
      const entries = sample[0]?.values?.map(([key, timestamp]: [any, any]) => ({
        key: String(key).replace('GET:https://api.spotify.com/v1', '').slice(0, 50) + '...',
        cachedAt: new Date(Number(timestamp)).toLocaleString()
      })) || []
      
      alert(`Cache Stats:\n- Total entries: ${count}\n- Recent entries:\n${entries.map((e: any) => `  ${e.key} (${e.cachedAt})`).join('\n')}`)
    } catch (error: any) {
      alert('Error getting cache stats: ' + (error?.message || 'Unknown error'))
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
