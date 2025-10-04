import { frontendLogger } from './FrontendLogger';
import { runTauriCommand } from './TauriCommands';

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
  frontendLogger.log('[audioCache] startPlaybackWithSource called with:', { 
    trackId, 
    sourceType, 
    sourceValue, 
    preferCache, 
    sourceMeta 
  });
  
  try {
    // Fire the command but do not rely solely on its long-running completion.
    // The backend now returns quickly and emits a `playback:start:ack` event
    // when it has spawned the async playback task. We'll await the quick
    // invoke result, but also race it with an ack event to avoid UI blocking
    // in cases where the invoke might still take longer.
    // Listen for the ack event (short timeout) before firing the invoke to avoid race
    const eventModule = await import('@tauri-apps/api/event');
    // Correlate ack events with this specific request using a clientRequestId
    const clientRequestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
    const ackPromise = new Promise<any>((resolve) => {
      let unlisten: any = null;
      const timer = setTimeout(() => {
        if (unlisten) unlisten();
        resolve({ timeout: true });
      }, 2500);

      (async () => {
        try {
          unlisten = await eventModule.listen('playback:start:ack', (evt: any) => {
            try { clearTimeout(timer); } catch {}
            // Only resolve when the ack matches our clientRequestId
            const payload = evt.payload || evt;
            if (payload && payload.clientRequestId && payload.clientRequestId === clientRequestId) {
              if (unlisten) unlisten();
              resolve(payload);
            }
          });
        } catch (e) {
          // If listening fails, resolve immediately so we don't hang
          try { clearTimeout(timer); } catch {}
          resolve({ listen_error: true });
        }
      })();
    });

    // Fire the invoke after listener is attached so we don't miss the ack.
    // Keep the invoke's promise so we can race it vs the ack: sometimes the
    // backend returns a quick invoke result (dedup/success) and we should use
    // that instead of waiting for the ack timeout.
    const invokePromise = runTauriCommand('playback_start_with_source', {
      spec: {
        track_id: trackId,
        source_type: sourceType,
        source_value: sourceValue,
        prefer_cache: preferCache,
        source_meta: sourceMeta,
        client_request_id: clientRequestId
      }
    }).then((r) => {
      frontendLogger.log('[audioCache] playback_start_with_source invoke completed (background):', r);
      return { invokeResult: r };
    }).catch((e) => {
      frontendLogger.warn('[audioCache] playback_start_with_source invoke failed (background):', e);
      return { invokeError: e };
    });

    // Race the ack (which includes a timeout) with the invoke result. Prefer
    // the ack, but accept a fast invoke result when it arrives first.
    const res = await Promise.race([ackPromise, invokePromise]);
    frontendLogger.log('[audioCache] Playback ack or timeout:', res);
    return res;
  } catch (error) {
    frontendLogger.error('[audioCache] Failed to start playback with source:', error);
    throw error;
  }
}

/**
 * Check if a track is cached locally
 */
export async function getCachedFile(trackId: string, sourceType: string, sourceHash: string, fileIndex?: number): Promise<string | null> {
  try {
    // Send parameters using camelCase as Tauri converts snake_case Rust params to camelCase for JS
    const args: any = {
      trackId: trackId,
      sourceType: sourceType,
      sourceHash: sourceHash
    };
    if (typeof fileIndex === 'number') {
      args.fileIndex = Math.floor(fileIndex);
    }
    const result: any = await runTauriCommand('cache_get_file', args);
    // Support both direct JSON and { success, data } wrapper forms
    if (result && typeof result === 'object') {
      if ('exists' in result) {
        return result.exists ? (result.cached_path || null) : null;
      }
      if ('success' in result) {
        return result.success ? (result.data || null) : null;
      }
    }
    return null;
  } catch (error) {
    frontendLogger.warn('[cache] Failed to check cache:', error);
    return null;
  }
}

/**
 * Download and cache an audio file
 */
export async function downloadAndCache(trackId: string, sourceType: string, sourceHash: string, url: string, fileIndex?: number): Promise<string | null> {
  try {
    // Send parameters using camelCase as Tauri converts snake_case Rust params to camelCase for JS
    const args: any = {
      trackId: trackId,
      sourceType: sourceType,
      sourceHash: sourceHash,
      url: url
    };
    
    // Only add fileIndex if it's a valid number
    if (typeof fileIndex === 'number' && !isNaN(fileIndex)) {
      args.fileIndex = Math.floor(fileIndex);
    }
    
    // Helpful runtime debug
    try { frontendLogger.debug('[audioCache] cache_download_and_store args:', { ...args, url: typeof url === 'string' ? (url.startsWith('magnet:') ? 'magnet:...' : url) : url }); } catch {}

    frontendLogger.log('[audioCache] About to call runTauriCommand with cache_download_and_store');
    frontendLogger.log('[audioCache] Final args being sent:', JSON.stringify(args, null, 2));
    const result: any = await runTauriCommand('cache_download_and_store', args);
    frontendLogger.log('[audioCache] runTauriCommand returned:', result);
    // Backend returns a plain string ("Download started"); also handle wrapper style
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && 'success' in result) {
      return result.success ? (result.data || 'ok') : null;
    }
    return result ?? null;
  } catch (error) {
    frontendLogger.error('[cache] Failed to download and cache:', error);
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
    frontendLogger.warn('[cache] Failed to get cache stats:', error);
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
    frontendLogger.error('[cache] Failed to clear cache:', error);
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
