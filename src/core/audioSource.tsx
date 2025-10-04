import React, { createContext, useContext, ReactNode, useMemo } from 'react';
import { frontendLogger } from './FrontendLogger';
import { runTauriCommand, unwrapTauriResult } from './TauriCommands';

// Types and constants
export type AudioSourceType = 'local' | 'http' | 'torrent' | 'youtube';

export type AudioSourceSpec = {
    type: AudioSourceType;
    value: string;
    meta?: Record<string, any>;
};

export type AudioSourceAPI = {
    resolveSource: (spec: AudioSourceSpec) => Promise<string>;
};

// Constants for better performance
const URL_PATTERNS = {
    HTTP: /^https?:\/\//i,
    FILE_PROTOCOL: /^(blob|data|file):/,
    YOUTUBE_ID: /^[A-Za-z0-9_-]{8,32}$/
} as const;

const URL_TEMPLATES = {} as const;

// Optimized environment detection
const getEnvironment = (() => {
    let cached: { tauri?: any; electron?: any } | null = null;
    return () => {
        if (!cached && typeof window !== 'undefined') {
            const w = window as any;
            cached = {
                tauri: w.__TAURI__?.fs,
                electron: w.electron?.fs
            };
        }
        return cached || {};
    };
})();

// Optimized resolver functions for each source type
const resolvers = {
    local: async (value: string): Promise<string> => {
        const env = getEnvironment();
        
        if (env.tauri) {
            return value.startsWith('file:') ? value : `file://${value}`;
        }
        
        if (env.electron?.getFileUrl) {
            const url = await env.electron.getFileUrl(value);
            if (url) return url;
        }
        
        return URL_PATTERNS.FILE_PROTOCOL.test(value) ? value : value;
    },

    http: async (value: string): Promise<string> => value,

    torrent: async (value: string): Promise<string> => {
        // Expect formats:
        // - "torrent://<infohash>/<index>"
        // - "<infohash>#<index>"
        // - "<magnet>" with implicit index 0
        const v = String(value || '').trim();
        let hashOrMagnet = v;
        let index = 0;

        const T_PREFIX = /^torrent:\/\//i;
        if (T_PREFIX.test(v)) {
            const body = v.replace(T_PREFIX, '');
            const parts = body.split('/');
            hashOrMagnet = parts[0] || body;
            if (parts.length > 1) {
                const maybe = Number(parts[1]);
                if (Number.isFinite(maybe) && maybe >= 0) index = Math.floor(maybe);
            }
        } else if (v.includes('#')) {
            const [h, i] = v.split('#');
            hashOrMagnet = h;
            const maybe = Number(i);
            if (Number.isFinite(maybe) && maybe >= 0) index = Math.floor(maybe);
        }

        try {
            // Start download (idempotent if already added)
            await runTauriCommand('torrent_start_download', {
                magnet: hashOrMagnet,
                index,
            });
        } catch {
            // best-effort; ignore errors if already started
        }

        try {
            // Get the current file path for playback (when ready)
            const res: any = await runTauriCommand('torrent_get_file_path', {
                hash_or_magnet: hashOrMagnet,
                index,
            });
            if (typeof res === 'string' && res) {
                return res.startsWith('file://') ? res : `file://${res}`;
            }
        } catch (e) {
            frontendLogger.warn('[audioSource] torrent file path not ready yet:', e);
        }
        // Fallback to original value if not yet resolvable
        return value;
    },

    youtube: async (value: string): Promise<string> => {
        const trimmedValue = value.trim();
        
        // Resolve direct CDN URL via Tauri command
        try {
            const videoId = URL_PATTERNS.YOUTUBE_ID.test(trimmedValue) ? trimmedValue : trimmedValue;
            const result = await runTauriCommand('youtube_get_stream_url', { id: videoId });
            const unwrapped: any = unwrapTauriResult(result);
            if (unwrapped && unwrapped.status === 'ok' && unwrapped.data?.url) {
                return unwrapped.data.url as string;
            }
        } catch (error) {
            frontendLogger.warn('[audioSource] Failed to resolve YouTube stream url via Tauri:', error);
        }
    }
} as const;

// Context
const AudioSourceContext = createContext<AudioSourceAPI | undefined>(undefined);

// Optimized standalone resolver
export async function resolveAudioSource(spec: AudioSourceSpec): Promise<string> {
    const resolver = resolvers[spec.type];
    return resolver ? await resolver(spec.value) : spec.value;
}

// Memoized provider
export const AudioSourceProvider = React.memo(({ children }: { children: ReactNode }) => {
    const api = useMemo<AudioSourceAPI>(() => ({
        resolveSource: resolveAudioSource
    }), []);
    
    return (
        <AudioSourceContext.Provider value={api}>
            {children}
        </AudioSourceContext.Provider>
    );
});

AudioSourceProvider.displayName = 'AudioSourceProvider';

// Optimized hook
export function useAudioSource(): AudioSourceAPI {
    const ctx = useContext(AudioSourceContext);
    if (!ctx) {
        throw new Error('useAudioSource must be used within AudioSourceProvider');
    }
    return ctx;
}

export default AudioSourceProvider;
