// TorrentClient.ts - Optimized torrent file list retrieval
import { runTauriCommand } from "./TauriCommands";

// Performance constants
const DEFAULT_TIMEOUT_MS = 20000;
const ERROR_PREFIX = 'ERR: ';

// Types
type FileInfo = { name: string; length: number; path?: string };
type TorrentResponse = FileInfo[] | { error?: string; err?: string; message?: string };

// Module state
const inflight = new Map<string, Promise<FileInfo[]>>();

/**
 * Normalize error messages to consistent format
 */
function normalizeError(e: any): string {
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
 * Create normalized error from response object
 */
function createError(res: any): Error {
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

  // Fallback: provide a generic error message
  return new Error('Request failed with invalid response format');
}

/**
 * Get file list for a torrent identified by magnet/infoHash/url.
 * Optimized with coalesced requests and simplified error handling.
 */
export async function getTorrentFileList(
  id: string,
  opts?: { timeout_ms?: number }
): Promise<FileInfo[]> {
  if (!id) throw new Error('No torrent id provided');

  // Prefer snake_case to match backend only
  const timeoutMs = (opts?.timeout_ms) ?? DEFAULT_TIMEOUT_MS;

  // Return existing inflight request if available (coalescing)
  if (inflight.has(id)) {
    return inflight.get(id)!;
  }

  const task = (async (): Promise<FileInfo[]> => {
    try {
      // Call optimized Tauri command
      const res = await runTauriCommand<any>('torrent_get_files', {
        id,
        timeout_ms: timeoutMs
      });

      // Handle structured responses from the server
      if (res && typeof res === 'object') {
        // Check for error responses first
        if ((res as any).error || (res as any).err || (res as any).message) {
          throw createError(res);
        }

        // New Tauri shape: { status: 'ok', data: FileInfo[] }
        if ((res as any).status === 'ok') {
          const data = (res as any).data;
          if (Array.isArray(data)) return data;
          if (data && Array.isArray((data as any).files)) return (data as any).files;
        }

        // Alternate success shape: { success: true, files: [...] }
        if ((res as any).success && Array.isArray((res as any).files)) {
          return (res as any).files;
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
      throw createError(res);
    } catch (error) {
      throw new Error(normalizeError(error));
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
