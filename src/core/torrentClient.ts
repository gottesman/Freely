import { runTauriCommand } from "./tauriCommands";

type FileInfo = { name: string; length: number };

let client: any = null;
const BROWSER_WS_TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.webtorrent.io',
    'wss://tracker.fastcast.nz'
];

async function ensureClient(): Promise<any> {
    // Node import
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

/**
 * Get file list for a torrent identified by magnet/infoHash/url.
 * Waits up to timeoutMs for metadata/ready. Returns array of {name,length}.
 */
export async function getTorrentFileList(id: string, opts?: { timeoutMs?: number }): Promise<FileInfo[]> {
    if (!id) throw new Error('No torrent id provided');
    const timeoutMs = opts?.timeoutMs ?? 20000;

    runTauriCommand<any>('torrent_get_files', { id, timeoutMs }).then(res => {
        if (Array.isArray(res)) return res;
        return [];
    }).catch(() => []);

    const client = await ensureClient();

    return new Promise<FileInfo[]>((resolve, reject) => {
        console.log('Fetching torrent file list...');
        let resolved = false;
        const onResolve = (files: FileInfo[]) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(tid);
            resolve(files);
        };
        const onReject = (err: any) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(tid);
            reject(err);
        };

        const tid = setTimeout(() => {
            onReject(new Error('Failed to fetch torrent metadata (timeout)'));
        }, timeoutMs) as unknown as number;

        try {
            let torrent: any = client.get(id);

            const handleReady = () => {
                try {
                    const files = (torrent.files || []).map((f: any) => ({ name: f.name, length: f.length }));
                    onResolve(files);
                } catch (e) {
                    onReject(e);
                }
            };

            const handleError = (err: any) => {
                onReject(err || new Error('Torrent error'));
            };

            if (torrent) {
                if (torrent.files && torrent.files.length) {
                    handleReady();
                } else {
                    torrent.once && torrent.once('ready', handleReady);
                    torrent.once && torrent.once('metadata', handleReady);
                    torrent.once && torrent.once('error', handleError);
                }
            } else {
                try {
                    // If running in the browser, pass websocket trackers to help metadata discovery
                    const isBrowser = (typeof window !== 'undefined') && !(window as any).electron;
                    const addOpts: any = { destroyStoreOnDestroy: true };
                    if (isBrowser) addOpts.trackers = BROWSER_WS_TRACKERS;
                    torrent = client.add(id, addOpts);
                    torrent.once && torrent.once('ready', handleReady);
                    torrent.once && torrent.once('metadata', handleReady);
                    torrent.once && torrent.once('error', handleError);
                } catch (e) {
                    onReject(e);
                }
            }
        } catch (e) {
            onReject(e);
        }
    });
}

export function _getClientForDebug() {
    return client;
}
