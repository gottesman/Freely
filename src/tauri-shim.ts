// Lightweight compatibility shim so renderer code using the Tauri APIs
// (window.freelyDB, window.charts, etc.) keeps working under
// Tauri or plain browser dev server. This file intentionally offers minimal
// safe fallbacks and maps to `@tauri-apps/api` when available at runtime.

declare global {
  interface Window {
    freelyDB?: any;
  }
}

const defaultDB = {
  read: async () => null,
  write: async (_data: any) => {},
  path: async () => null
};

// Expose default shims immediately so UI can register listeners synchronously.
(window as any).freelyDB = defaultDB;

// Try to wire to Tauri at runtime if available and overwrite the defaults when ready
;(async () => {
  // If Tauri preload is already present (e.g., running inside Tauri), don't overwrite
  if ((window as any).__FREELY_PRELOAD__) return;
  // mark that we're initializing so other inits don't race
  (window as any).__FREELY_PRELOAD__ = true;

  try {
    // Dynamically import the Tauri API and prefer the window module (appWindow)
    // Use a tolerant import and silence TypeScript if the package isn't installed in this workspace.
    // @ts-ignore
    const tauri = await import('@tauri-apps/api').catch(() => null);
    if (!tauri) throw new Error('tauri API not available');

  const invoke = (tauri as any).invoke as any;

    const dbShim = {
      read: async () => {
        try {
          const b64 = await invoke('db_read');
          if (!b64) return null;
          // decode base64 to Uint8Array
          const str: string = b64 as string;
          const raw = atob(str);
          const arr = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          return arr;
        } catch (e) { return null; }
      },
      write: (data: any) => {
        try {
          // Accept Uint8Array or Buffer-like
          let b64 = null;
          if (data instanceof Uint8Array) {
            let s = '';
            for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
            b64 = btoa(s);
          } else if (typeof data === 'string') {
            b64 = btoa(data);
          } else if (data && Array.isArray(data.data)) {
            const u = new Uint8Array(data.data);
            let s = '';
            for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
            b64 = btoa(s);
          }
          if (b64) return invoke('db_write', { base64_data: b64 }).catch(()=>{});
          return Promise.resolve();
        } catch (e) { return Promise.resolve(); }
      },
      path: () => invoke('db_path').catch(()=>null)
    };

    // Expose the shim
    (window as any).freelyDB = dbShim;
    return;
    } catch (e) {
      // If tauri API import fails (dev server without Tauri), keep the defaults we set above
      return;
    }
})();

export {};
