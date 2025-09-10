import { runTauriCommand } from './tauriCommands';

export interface CacheStats {
  total_size_mb: number;
  entry_count: number;
  max_size_mb: number;
}

/**
 * Start playback with source specification (backend handles URL resolution)
 */
export async function startPlaybackWithSource(
  trackId: string,
  sourceType: string,
  sourceValue: string,
  preferCache: boolean = true,
  sourceMeta?: Record<string, any>
): Promise<any> {
  console.log('[audioCache] startPlaybackWithSource called with:', { 
    trackId, 
    sourceType, 
    sourceValue, 
    preferCache, 
    sourceMeta 
  });
  
  try {
    const result = await runTauriCommand('playback_start_with_source', {
      spec: {
        track_id: trackId,
        source_type: sourceType,
        source_value: sourceValue,
        prefer_cache: preferCache,
        source_meta: sourceMeta
      }
    });
    
    console.log('[audioCache] Backend response:', result);
    return result;
  } catch (error) {
    console.error('[audioCache] Failed to start playback with source:', error);
    throw error;
  }
}

/**
 * Check if a track is cached locally
 */
export async function getCachedFile(trackId: string, sourceType: string, sourceHash: string): Promise<string | null> {
  try {
    const result = await runTauriCommand('cache_get_file', {
      trackId: trackId,
      sourceType: sourceType,
      sourceHash: sourceHash
    });
    return result?.success ? result.data : null;
  } catch (error) {
    console.warn('[cache] Failed to check cache:', error);
    return null;
  }
}

/**
 * Download and cache an audio file
 */
export async function downloadAndCache(trackId: string, sourceType: string, sourceHash: string, url: string): Promise<string | null> {
  try {
    const result = await runTauriCommand('cache_download_and_store', {
      trackId: trackId,
      sourceType: sourceType,
      sourceHash: sourceHash,
      url: url
    });
    return result?.success ? result.data : null;
  } catch (error) {
    console.error('[cache] Failed to download and cache:', error);
    return null;
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<CacheStats | null> {
  try {
    const result = await runTauriCommand('cache_get_stats');
    return result?.success ? result.data : null;
  } catch (error) {
    console.warn('[cache] Failed to get cache stats:', error);
    return null;
  }
}

/**
 * Clear the entire cache
 */
export async function clearCache(): Promise<boolean> {
  try {
    const result = await runTauriCommand('cache_clear');
    return result?.success === true;
  } catch (error) {
    console.error('[cache] Failed to clear cache:', error);
    return false;
  }
}

/**
 * Format cache size for display
 */
export function formatCacheSize(sizeInMB: number): string {
  if (sizeInMB < 1) {
    return `${(sizeInMB * 1024).toFixed(1)} KB`;
  } else if (sizeInMB < 1024) {
    return `${sizeInMB.toFixed(1)} MB`;
  } else {
    return `${(sizeInMB / 1024).toFixed(1)} GB`;
  }
}
