import { invoke } from "@tauri-apps/api/core";

// A small, defensive wrapper that tries multiple possible Tauri invoke entrypoints
// (global window.tauri / window.__TAURI__.invoke / @tauri-apps/api invoke) and
// returns the command result or `false` if invoke isn't available or fails.
const wAny: any = typeof window !== 'undefined' ? (window as any) : {};

function findInvoke(): ((cmd: string, args?: any) => Promise<any>) | undefined {
    // 1) window.tauri.invoke (new API)
    if (wAny.tauri && typeof wAny.tauri.invoke === 'function') return wAny.tauri.invoke.bind(wAny.tauri);

    // 2) window.__TAURI__.invoke or window.__TAURI__.core.invoke (older embedding variations)
    if (wAny.__TAURI__) {
        if (typeof wAny.__TAURI__.invoke === 'function') return wAny.__TAURI__.invoke.bind(wAny.__TAURI__);
        if (wAny.__TAURI__.core && typeof wAny.__TAURI__.core.invoke === 'function') return wAny.__TAURI__.core.invoke.bind(wAny.__TAURI__.core);
        if (wAny.__TAURI__.tauri && typeof wAny.__TAURI__.tauri.invoke === 'function') return wAny.__TAURI__.tauri.invoke.bind(wAny.__TAURI__.tauri);
    }

    // 3) fallback to the @tauri-apps/api/core imported invoke (if present at build time)
    if (typeof invoke === 'function') return invoke as any;

    console.warn('Tauri invoke not found in this environment');

    return undefined;
}

export async function runTauriCommand<T = any>(command: string, args?: {}): Promise<T | false | any> {
    // coalesce identical command+args to a single inflight invoke
    const key = command + '::' + JSON.stringify(args ?? {});
    if (!(globalThis as any).__tauri_inflight) (globalThis as any).__tauri_inflight = new Map<string, Promise<any>>();
    const inflight: Map<string, Promise<any>> = (globalThis as any).__tauri_inflight;
    if (inflight.has(key)) return inflight.get(key);

    const inv = findInvoke();
    if (!inv) {
        console.warn('Tauri invoke not available in this environment');
        return false;
    }

    const task = (async () => {
        try {
            const res = await inv(command, args ?? {});
            return res as T;
        } catch (err) {
            // If Tauri returned a structured error object, return it directly.
            // Sometimes the runtime surfaces the error as a JSON string — try to parse it.
            try {
                if (typeof err === 'string') {
                    const parsed = JSON.parse(err);
                    return parsed;
                }
                if (err && typeof err === 'object') return err;
            } catch (e) {
                // fallthrough
            }

            // Fallback: return a simple object with error/message for consumers to inspect
            return { error: String(err), message: (err && (err as any).message) || String(err) };
        }
    })();

    inflight.set(key, task);
    try {
        const out = await task;
        return out;
    } finally {
        inflight.delete(key);
    }
}