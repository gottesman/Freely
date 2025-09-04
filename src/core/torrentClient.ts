// TorrentClient.ts
import { runTauriCommand } from "./tauriCommands";

type FileInfo = { name: string; length: number };

let client: any = null;
const inflight = new Map<string, Promise<FileInfo[]>>();

// WebSocket trackers used only if running in a browser (rare)
const BROWSER_WS_TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.webtorrent.io',
    'wss://tracker.fastcast.nz'
];

async function ensureClient(): Promise<any> {
    if (client) return client;
    let wt: any = null;
    try {
        wt = await import('webtorrent');
    } catch (err) {
        throw new Error('Failed to import webtorrent module. Ensure it is installed (npm install webtorrent). Original error: ' + String(err));
    }

    const NodeWebTorrent = wt && (wt.default || wt);
    if (!NodeWebTorrent) throw new Error('WebTorrent bundle not found');

    try {
        if (typeof NodeWebTorrent === 'function') client = new (NodeWebTorrent as any)();
        else if (NodeWebTorrent && typeof (NodeWebTorrent as any).default === 'function') client = new (NodeWebTorrent as any).default();
        else if (NodeWebTorrent && typeof (NodeWebTorrent as any).WebTorrent === 'function') client = new (NodeWebTorrent as any).WebTorrent();
        else throw new Error('Unsupported WebTorrent module shape: ' + String(Object.keys(NodeWebTorrent || {})));
    } catch (e) {
        throw new Error('Failed to construct WebTorrent client: ' + String(e));
    }

    return client;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Get file list for a torrent identified by magnet/infoHash/url.
 * Waits up to timeoutMs for metadata/ready. Returns array of {name,length}.
 *
 * This implementation coalesces concurrent calls for the same id,
 * retries the native helper a few times (good for transient failures),
 * and only falls back to Node-side webtorrent in non-browser contexts.
 */

function errorToString(e: any): string {
    const prev = 'ERR: ';
    const errStr = (typeof e === 'string' ? e : (e && e.message) ? e.message : String(e || '')).trim();
    const lower = errStr.toLowerCase();
    if (!errStr) return prev + 'NULL';
    if (lower.includes('timed out') || lower.includes('timeout')) return prev + 'TIMEOUT';
    if (lower.includes('no torrent with that info hash') || lower.includes('no torrent')) return prev + 'NO-TORRENT';
    if (lower.includes('no torrent id') || lower.includes('no id')) return prev + 'NO-ID';
    // fallback: produce a short, safe token from the message
    const safe = errStr.split(/\s+/).slice(0,3).join('_').replace(/[^A-Za-z0-9_-]/g,'').toUpperCase() || 'UNKNOWN';
    return prev + safe;
}

// Create an Error instance from various response shapes returned by the native helper
function makeErrorFromRes(res: any): Error {
    if (!res) return new Error('Unknown error');
    if (typeof res === 'string') return new Error(res);
    try {
        // Prefer explicit message fields if present
        const msg = res.message ?? res.err ?? res.error;
        if (msg && typeof msg === 'string' && msg.trim()) return new Error(msg);
        // If message is an object, stringify it for debugging
        return new Error(JSON.stringify(res));
    } catch (e) {
        return new Error(String(res));
    }
}

export async function getTorrentFileList(id: string, opts?: { timeoutMs?: number }): Promise<FileInfo[]> {
    if (!id) throw new Error('No torrent id provided');
    const timeoutMs = opts?.timeoutMs ?? 20000;

    // If there's already an inflight request, return it (coalescing)
    if (inflight.has(id)) {
        return inflight.get(id)!;
    }

    const task = (async (): Promise<FileInfo[]> => {
        try {
            // call tauri helper
            const res = await runTauriCommand<any>('torrent_get_files', { id, timeoutMs });
            // if helper returned structured error, surface it with a readable message
            if (res && !Array.isArray(res) && (res.error || res.err || res.message)) {
                throw makeErrorFromRes(res);
            }
            if (Array.isArray(res)) {
                return res;
            } else {
                // unexpected shape from helper, stringify for clarity
                throw makeErrorFromRes(res);
            }
        } catch (e) {
            throw new Error(errorToString(e));
        }
    })();

    // store in inflight and ensure it's removed after completion
    inflight.set(id, task);
    try {
        const out = await task;
        return out;
    } finally {
        inflight.delete(id);
    }
}

export function _getClientForDebug() {
    return client;
}
