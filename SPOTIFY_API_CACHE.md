# Spotify API Cache Implementation

## Overview
This implementation adds a persistent database cache for all Spotify API requests to significantly reduce API usage and improve performance. The cache stores API responses indefinitely since Spotify metadata (tracks, albums, artists) rarely changes.

## Implementation Details

### 1. Database Schema Enhancement
- **New Table**: `api_cache` 
  - `cache_key` (TEXT PRIMARY KEY): Unique identifier for each API request
  - `response_data` (TEXT): JSON response data from Spotify API
  - `cached_at` (INTEGER): Timestamp when cached

### 2. Cache Strategy
- **Primary Cache**: Database (persistent, indefinite)
- **Secondary Cache**: In-memory (60 second TTL, current session only)
- **Cache Key Format**: `GET:https://api.spotify.com/v1/tracks/4iV5W9uYEdYUVa79Axb7Rh?market=US&locale=en-US`

### 3. Files Modified

#### Core Files
- **`src/core/db.tsx`**: Added `api_cache` table and cache helper functions
  - `getApiCache(key: string)`: Retrieve cached data
  - `setApiCache(key: string, data: any)`: Store data in cache

- **`src/core/spotify.ts`**: Enhanced SpotifyClient with database caching
  - Added `setDatabaseCache()` method
  - Modified `get()` method to check DB cache first
  - Added console logging for debugging (cache hits vs API calls)

- **`src/core/spotify-client.tsx`**: New utility for cached client management
  - `useSpotifyClient()`: React hook for cached client
  - `createCachedSpotifyClient()`: Factory function for non-hook usage

#### Updated Components
- **`src/components/PlaylistInfoTab.tsx`**: Uses cached SpotifyClient
- **`src/core/playback.tsx`**: Uses cached SpotifyClient 
- **`src/core/hooks/useArtistBuckets.ts`**: Uses cached SpotifyClient
- **`src/components/Tests.tsx`**: Added API cache test component

#### New Test Component
- **`src/components/ApiCacheTest.tsx`**: Interactive cache testing component

### 4. Cache Flow
1. **First API Call**: 
   - Check DB cache → Miss
   - Check memory cache → Miss  
   - Make API call → Store in both caches → Return data
   - Console: "🌐 API CALL: /tracks/xxx"

2. **Second Identical Call**:
   - Check DB cache → Hit
   - Return cached data (no API call)
   - Console: "📋 Cache HIT: /tracks/xxx"

3. **Subsequent Sessions**:
   - DB cache persists across browser restarts
   - Immediate cache hits for previously requested data

### 5. Performance Benefits

#### Before Implementation
- Every track metadata request = 1 API call
- Loading 42-track playlist = 42 API calls
- No persistence across sessions

#### After Implementation  
- First time loading track = 1 API call + cache storage
- Subsequent loads = 0 API calls (cache hit)
- Cache persists indefinitely across sessions
- **Potential API reduction**: 95%+ for repeated content

### 6. Testing & Verification

#### Manual Testing
1. Navigate to Tests tab in the application
2. Use "API Cache Test" component
3. Click "Test API Cache" button twice
4. Observe browser console:
   - First call: "🌐 API CALL: /tracks/xxx" + "💾 Stored in DB cache"
   - Second call: "📋 Cache HIT: /tracks/xxx"

#### Database Inspection
- Click "Show Cache Stats" to see:
  - Total cached entries
  - Recent cache additions with timestamps

### 7. Cache Management

#### Automatic Features
- Cache storage happens transparently 
- No cache expiration (metadata rarely changes)
- Graceful fallback if cache fails
- Environment detection (browser vs Node.js)

#### Manual Management (Future Enhancement)
- Could add cache clearing functionality
- Could add selective cache invalidation
- Could add cache size monitoring

### 8. Integration Points

#### Hook Usage (Recommended)
```typescript
import { useSpotifyClient } from '../core/spotify-client'

function MyComponent() {
  const spotifyClient = useSpotifyClient() // Cached client
  // Use spotifyClient.getTrack(), etc.
}
```

#### Non-Hook Usage
```typescript  
import { createCachedSpotifyClient } from '../core/spotify-client'
import { useDB } from '../core/db'

function MyProvider() {
  const { getApiCache, setApiCache } = useDB()
  const client = createCachedSpotifyClient({ getApiCache, setApiCache })
}
```

### 9. Benefits Summary

✅ **Eliminated API calls** for repeated requests  
✅ **Persistent cache** across browser sessions  
✅ **Graceful fallback** if cache fails  
✅ **Automatic storage** of all API responses  
✅ **Console logging** for debugging and verification  
✅ **Zero configuration** required  
✅ **Backward compatible** with existing code  
✅ **Performance monitoring** via test component

### 10. Next Steps

The implementation is production-ready. Optional enhancements could include:
- Cache size monitoring and cleanup
- Selective cache invalidation 
- Cache statistics dashboard
- Cache export/import functionality

## Technical Notes

- **Browser Compatibility**: Uses Cache Storage API for persistence
- **Error Handling**: Graceful degradation if database unavailable
- **Memory Management**: In-memory cache limited to 60 seconds
- **Thread Safety**: Database operations handle concurrent access
- **Performance Impact**: Minimal overhead, significant API savings
