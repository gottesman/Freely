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
    TORRENT: (id: string) => `http://localhost:9000/stream/${encodeURIComponent(id)}/0`,
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

    torrent: async (value: string): Promise<string> => {
        // Extract infoHash from magnetURI if needed
        if (value.startsWith('magnet:')) {
            const match = value.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/);
            if (match) {
                return URL_TEMPLATES.TORRENT(match[1]);
            }
        }
        // Assume it's already an infoHash
        return URL_TEMPLATES.TORRENT(value);
    },

    youtube: async (value: string): Promise<string> => {
        const trimmedValue = value.trim();
        
        // If it's already a localhost streaming URL, return as-is
        if (trimmedValue.startsWith('http://localhost:9000/source/youtube')) {
            return trimmedValue;
        }
        
        // For YouTube sources, get the direct CDN URL from the info endpoint
        try {
            const videoId = URL_PATTERNS.YOUTUBE_ID.test(trimmedValue) 
                ? trimmedValue 
                : trimmedValue;
            
            // Get the info to extract the direct YouTube CDN URL
            const infoUrl = `http://localhost:9000/source/youtube?id=${encodeURIComponent(videoId)}&get=info`;
            console.log('[audioSource] Fetching YouTube info for direct URL:', infoUrl);
            
            const response = await fetch(infoUrl);
            if (response.ok) {
                const data = await response.json();
                console.log('[audioSource] Info response:', data);
                if (data.success && data.data?.format?.url) {
                    const directUrl = data.data.format.url;
                    console.log('[audioSource] Successfully extracted direct YouTube CDN URL:', directUrl);
                    return directUrl;
                } else {
                    console.warn('[audioSource] No direct URL in info response. Data structure:', JSON.stringify(data, null, 2));
                }
            } else {
                console.warn('[audioSource] Info request failed with status:', response.status, await response.text());
            }
        } catch (error) {
            console.warn('[audioSource] Failed to fetch YouTube info:', error);
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
