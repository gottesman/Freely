// Lightweight WebTorrent singleton and helper for fetching torrent file lists.
// Keeps imports and polyfills centralized so renderer code remains small and reliable.
type FileInfo = { name: string; length: number };

let client: any = null;
const BROWSER_WS_TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.webtorrent.io',
    'wss://tracker.fastcast.nz'
];

async function applyPolyfills() {
    try {
        if (typeof (globalThis as any).global === 'undefined') {
            (globalThis as any).global = globalThis;
        }
        if (typeof (globalThis as any).process === 'undefined') {
            (globalThis as any).process = { env: {}, browser: true } as any;
        } else if (!(globalThis as any).process.browser) {
            (globalThis as any).process.browser = true;
        }
        if (typeof (globalThis as any).Buffer === 'undefined') {
            const buf = await import('buffer');
            (globalThis as any).Buffer = buf.Buffer;
        }
    } catch (e) {
        // Non-fatal: polyfill attempts may fail in some environments but we continue.
        // Caller will get an error later if webtorrent really fails.
        // eslint-disable-next-line no-console
        console.warn('torrentClient polyfills failed (continuing):', e);
    }
}
// Detect runtime: Tauri, Electron, or Browser
const wAny: any = typeof window !== 'undefined' ? (window as any) : {};
const isTauri = !!(wAny.__TAURI__ || wAny.tauri || wAny.__TAURI__);
const isElectron = !!wAny?.electron;
const isBrowser = (typeof window !== 'undefined') && !isElectron && !isTauri;

async function ensureClient(): Promise<any> {
    if (client) return client;

    // If running in Electron renderer with a main-process torrent helper, prefer IPC
    try {
        const w: any = window as any;
        if (w?.electron?.torrent?.getFiles) {
            // We don't need a local client in this case; the main process will handle it.
            // Return a small proxy object implementing get/add semantics used by callers.
            client = {
                get: (id: string) => null,
                add: (id: string) => ({ files: [] })
            } as any;
            return client;
        }
    } catch (e) {
        // ignore
    }

    await applyPolyfills();


    // In browser, wait for global WebTorrent to be loaded if needed
    if (isBrowser) {
        const g: any = (globalThis as any);
        if (!g.WebTorrent) {
            // Wait for webtorrent vendor bundle to load (max 2s)
            await new Promise((resolve, reject) => {
                let waited = 0;
                const interval = setInterval(() => {
                    if ((globalThis as any).WebTorrent) {
                        clearInterval(interval);
                        console.log('WebTorrent vendor bundle loaded');
                        resolve(true);
                    } else if (waited > 2000) {
                        clearInterval(interval);
                        reject(new Error('WebTorrent vendor bundle not loaded'));
                    }
                    waited += 100;
                }, 100);
            }).catch(() => { });
        }
        if (g && g.WebTorrent) {
            try {
                client = new (g as any).WebTorrent();
                console.log('WebTorrent browser client created');
                return client;
            } catch (err) {
                throw new Error('Global WebTorrent construction failed: ' + err);
            }
        } else {
            throw new Error('WebTorrent vendor bundle not found in browser.');
        }
    }

    // Node/Electron: import as before
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

    if (!isBrowser) {
        // Prefer Tauri invoke when running inside a Tauri app
        try {
            if (isTauri) {
                // Use the global __TAURI__ invoke if available to avoid pulling in @tauri-apps/api here
                const tauri = (wAny.__TAURI__ || wAny.tauri || wAny.__TAURI__);
                if (tauri && typeof tauri.invoke === 'function') {
                    const res = await tauri.invoke('torrent_get_files', { id, timeoutMs });
                    return Array.isArray(res) ? res : [];
                }
                // Fallback: if using new window.tauri API that exposes 'invoke' under window.__TAURI__.tauri
                if (wAny.__TAURI__ && wAny.__TAURI__.tauri && typeof wAny.__TAURI__.tauri.invoke === 'function') {
                    const res = await wAny.__TAURI__.tauri.invoke('torrent_get_files', { id, timeoutMs });
                    return Array.isArray(res) ? res : [];
                }
            }

            // If running in Electron renderer with a main-process torrent helper, prefer IPC
            const w: any = window as any;
            if (w?.electron?.torrent?.getFiles) {
                const res = await w.electron.torrent.getFiles(id, { timeoutMs });
                return Array.isArray(res) ? res : [];
            }
        } catch (e) {
            // fallthrough to local client if main IPC fails
            console.warn('torrentClient: main-process getFiles IPC failed (falling back):', e);
        }
    }

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
