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

export async function runTauriCommand<T = any>(command: string, args?: {}): Promise<T | false> {
    const inv = findInvoke();
    if (!inv) {
        console.warn('Tauri invoke not available in this environment');
        return false;
    }

    try {
        const res = await inv(command, args ?? {});
        return res as T;
    } catch (err) {
        console.warn('Tauri invoke failed', err);
        return false;
    }
}