import React, { createContext, useContext, ReactNode, useMemo } from 'react';

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

const URL_TEMPLATES = {
    TORRENT: (id: string) => `/server/torrent-stream?id=${encodeURIComponent(id)}`,
    YOUTUBE_URL: (url: string) => `/audio/stream?url=${encodeURIComponent(url)}`,
    YOUTUBE_ID: (id: string) => `/audio/stream?videoId=${encodeURIComponent(id)}`,
    YOUTUBE_FALLBACK: (url: string) => `/youtube/stream?url=${encodeURIComponent(url)}`
} as const;

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

    torrent: async (value: string): Promise<string> => URL_TEMPLATES.TORRENT(value),

    youtube: async (value: string): Promise<string> => {
        const trimmedValue = value.trim();
        
        if (URL_PATTERNS.HTTP.test(trimmedValue)) {
            return URL_TEMPLATES.YOUTUBE_URL(trimmedValue);
        }
        
        if (URL_PATTERNS.YOUTUBE_ID.test(trimmedValue)) {
            return URL_TEMPLATES.YOUTUBE_ID(trimmedValue);
        }
        
        return URL_TEMPLATES.YOUTUBE_FALLBACK(trimmedValue);
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
