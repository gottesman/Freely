// TorrentClient.ts - Optimized torrent file list retrieval
import { runTauriCommand } from "./tauriCommands";

// Performance constants
const DEFAULT_TIMEOUT_MS = 20000;
const ERROR_PREFIX = 'ERR: ';

// Types
type FileInfo = { name: string; length: number };
type TorrentErrorResponse = { error?: string; err?: string; message?: string };
type TorrentResponse = FileInfo[] | TorrentErrorResponse;

// Module state
let client: any = null;
const inflight = new Map<string, Promise<FileInfo[]>>();

// Error handling utility class
class TorrentErrorHandler {
  /**
   * Normalize error messages to consistent format
   */
  static normalizeError(e: any): string {
    const errStr = (typeof e === 'string' ? e : e?.message || String(e || '')).trim();
    if (!errStr) return ERROR_PREFIX + 'NULL';
    
    const lower = errStr.toLowerCase();
    if (lower.includes('timeout')) return ERROR_PREFIX + 'TIMEOUT';
    if (lower.includes('no torrent')) return ERROR_PREFIX + 'NO-TORRENT';
    if (lower.includes('no id')) return ERROR_PREFIX + 'NO-ID';
    
    // Return the original error message (truncated if too long)
    const maxLength = 100;
    if (errStr.length > maxLength) {
      return ERROR_PREFIX + errStr.substring(0, maxLength) + '...';
    }
    return ERROR_PREFIX + errStr;
  }

  /**
   * Create Error from response object
   */
  static createError(res: any): Error {
    if (!res) return new Error('Unknown error');
    if (typeof res === 'string') return new Error(res);
    
    // Extract message from various possible fields
    const msg = res.message ?? res.err ?? res.error;
    if (msg && typeof msg === 'string' && msg.trim()) {
      return new Error(msg);
    }
    
    // If it's an object with specific error structure, format it properly
    if (res && typeof res === 'object') {
      if (res.error && res.message) {
        return new Error(`${res.error}: ${res.message}`);
      }
      if (res.status_code && res.message) {
        return new Error(`HTTP ${res.status_code}: ${res.message}`);
      }
    }
    
    // Fallback: provide a generic error message instead of stringifying
    return new Error('Request failed with invalid response format');
  }
}

// WebTorrent client management
class WebTorrentManager {
  /**
   * Ensure client is initialized (simplified initialization)
   */
  static async ensureClient(): Promise<any> {
    if (client) return client;
    
    try {
      const wt = await import('webtorrent');
      const WebTorrent = wt?.default || wt;
      
      if (!WebTorrent) {
        throw new Error('WebTorrent module not found');
      }
      
      // Simplified client creation
      if (typeof WebTorrent === 'function') {
        client = new WebTorrent();
      } else if (WebTorrent.default && typeof WebTorrent.default === 'function') {
        client = new WebTorrent.default();
      } else {
        throw new Error('Unsupported WebTorrent module structure');
      }
      
      return client;
    } catch (error) {
      throw new Error(`Failed to initialize WebTorrent: ${String(error)}`);
    }
  }
}

/**
 * Get file list for a torrent identified by magnet/infoHash/url.
 * Optimized with coalesced requests and simplified error handling.
 */
export async function getTorrentFileList(
  id: string, 
  opts?: { timeoutMs?: number }
): Promise<FileInfo[]> {
  if (!id) throw new Error('No torrent id provided');
  
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Return existing inflight request if available (coalescing)
  if (inflight.has(id)) {
    return inflight.get(id)!;
  }

  const task = (async (): Promise<FileInfo[]> => {
    try {
      // Call optimized Tauri command
      const res = await runTauriCommand<any>('torrent_get_files', { 
        id, 
        timeoutMs 
      });
      
      // Handle structured responses from the server
      if (res && typeof res === 'object') {
        // Check for error responses first
        if (res.error || res.err || res.message) {
          throw TorrentErrorHandler.createError(res);
        }
        
        // Extract files array from successful response
        if (res.success && Array.isArray(res.files)) {
          return res.files;
        }
        
        // Handle direct array response (legacy)
        if (Array.isArray(res)) {
          return res;
        }
      }
      
      // Handle direct array response
      if (Array.isArray(res)) {
        return res;
      }
      
      // Unexpected response shape
      throw TorrentErrorHandler.createError(res);
    } catch (error) {
      throw new Error(TorrentErrorHandler.normalizeError(error));
    }
  })();

  // Track inflight request and ensure cleanup
  inflight.set(id, task);
  try {
    return await task;
  } finally {
    inflight.delete(id);
  }
}

/**
 * Debug utility to access client instance
 */
export function _getClientForDebug() {
  return client;
}
