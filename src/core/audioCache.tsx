import { runTauriCommand } from './tauriCommands';

export interface CacheStats {
  total_size_mb: number;
  entry_count: number;
  max_size_mb: number;
}

/**
 * Extract source type and hash from a URL
 */
export function extractSourceInfo(url: string): { sourceType: string; sourceHash: string } {
  if (url.includes('googlevideo.com') || url.includes('youtube.com') || url.includes('youtu.be')) {
    // For YouTube URLs, try to extract video ID
    let videoId = '';
    
    // Try v= parameter
    const vMatch = url.match(/[?&]v=([^&]+)/);
    if (vMatch) {
      videoId = vMatch[1].substring(0, 11);
    } else {
      // Try id= parameter (for googlevideo.com URLs)
      const idMatch = url.match(/[?&]id=([^&]+)/);
      if (idMatch) {
        videoId = idMatch[1];
      } else {
        // Fallback: use hash of URL
        videoId = btoa(url).substring(0, 11).replace(/[^a-zA-Z0-9]/g, '0');
      }
    }
    
    return { sourceType: 'youtube', sourceHash: videoId };
  } else if (url.startsWith('magnet:')) {
    // For torrents, extract info hash
    const btihMatch = url.match(/xt=urn:btih:([^&]+)/);
    const infoHash = btihMatch ? btihMatch[1].toLowerCase() : 'unknown';
    return { sourceType: 'torrent', sourceHash: infoHash };
  } else if (url.startsWith('http://') || url.startsWith('https://')) {
    // For HTTP URLs, use a hash of the URL
    const hash = btoa(url).substring(0, 16).replace(/[^a-zA-Z0-9]/g, '0');
    return { sourceType: 'http', sourceHash: hash };
  } else if (url.startsWith('file://') || !url.includes('://')) {
    // For local files, use the file path hash
    const hash = btoa(url).substring(0, 16).replace(/[^a-zA-Z0-9]/g, '0');
    return { sourceType: 'local', sourceHash: hash };
  } else {
    // Unknown source type
    const hash = btoa(url).substring(0, 8).replace(/[^a-zA-Z0-9]/g, '0');
    return { sourceType: 'unknown', sourceHash: hash };
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
 * Start playback with cache support using explicit source information
 */
export async function startPlaybackWithCache(
  trackId: string, 
  url: string, 
  preferCache: boolean = true,
  sourceType?: string,
  sourceHash?: string
): Promise<any> {
  try {
    // Use provided source info if available, otherwise extract from URL
    let finalSourceType = sourceType;
    let finalSourceHash = sourceHash;
    
    if (!finalSourceType || !finalSourceHash) {
      const extracted = extractSourceInfo(url);
      finalSourceType = extracted.sourceType;
      finalSourceHash = extracted.sourceHash;
    }
    
    const result = await runTauriCommand('playback_start_with_cache', {
      trackId: trackId,
      url: url,
      preferCache: preferCache,
      sourceType: finalSourceType,
      sourceHash: finalSourceHash
    });
    return result;
  } catch (error) {
    console.error('[cache] Failed to start playback with cache:', error);
    throw error;
  }
}

/**
 * Check if a cached file exists for a track and URL
 */
export async function checkCacheForTrack(trackId: string, url: string): Promise<string | null> {
  const { sourceType, sourceHash } = extractSourceInfo(url);
  return await getCachedFile(trackId, sourceType, sourceHash);
}

/**
 * Download and cache a track from URL
 */
export async function cacheTrackFromUrl(trackId: string, url: string): Promise<string | null> {
  const { sourceType, sourceHash } = extractSourceInfo(url);
  return await downloadAndCache(trackId, sourceType, sourceHash, url);
}

/**
 * Check if a URL looks like it could be cached
 */
export function isCacheableUrl(url: string): boolean {
  // Only cache YouTube CDN URLs for now
  return url.includes('googlevideo.com') && url.includes('mime=audio');
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
