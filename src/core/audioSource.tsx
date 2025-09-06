import React, { createContext, useContext, ReactNode, useMemo } from 'react';

export type AudioSourceType = 'local' | 'http' | 'torrent' | 'youtube';

export type AudioSourceSpec = {
    type: AudioSourceType;
    // value is a file path, http url, torrent id/magnet, or youtube url/id
    value: string;
    // optional metadata for provider-specific handling
    meta?: Record<string, any>;
};

export type AudioSourceAPI = {
    // Normalize/resolve a source spec to a playable URL (blob:, http:, tauri://, proxy, etc.)
    resolveSource: (spec: AudioSourceSpec) => Promise<string>;
};

const AudioSourceContext = createContext<AudioSourceAPI | undefined>(undefined);

// standalone resolver that can be used without React context/hook
export async function resolveAudioSource(spec: AudioSourceSpec): Promise<string> {
    const { type, value } = spec;
    const w: any = typeof window !== 'undefined' ? window : {};

    if (type === 'local') {
        if (w.__TAURI__ && w.__TAURI__.fs) {
            return value.startsWith('file:') ? value : `file://${value}`;
        }
        if (w.electron?.fs?.getFileUrl) {
            const url = await w.electron.fs.getFileUrl(value);
            if (url) return url;
        }
        if (/^(blob|data|file):/.test(value)) return value;
        return value;
    }

    if (type === 'http') return value;

    if (type === 'torrent') {
        const tid = encodeURIComponent(value);
        return `/server/torrent-stream?id=${tid}`;
    }

    if (type === 'youtube') {
        // If value looks like a full URL, pass it as `url=`. If it looks like a YouTube
        // video id (simple heuristic), pass as `videoId=` for a smaller query string.
        const v = String(value || '').trim();
        const isUrl = /^https?:\/\//i.test(v);
        const isVideoId = /^[A-Za-z0-9_-]{8,32}$/.test(v);
        if (isUrl) return `/audio/stream?url=${encodeURIComponent(v)}`;
        if (isVideoId) return `/audio/stream?videoId=${encodeURIComponent(v)}`;
        // fallback: encode as url
        return `/youtube/stream?url=${encodeURIComponent(v)}`;
    }

    return value;
}

// Lightweight provider wrapping the resolver so components can call via hook.
export function AudioSourceProvider({ children }: { children: ReactNode }) {
    const api = useMemo<AudioSourceAPI>(() => ({ resolveSource: resolveAudioSource }), []);
    return <AudioSourceContext.Provider value={api}>{children}</AudioSourceContext.Provider>;
}

export function useAudioSource() {
    const ctx = useContext(AudioSourceContext);
    if (!ctx) throw new Error('useAudioSource must be used within AudioSourceProvider');
    return ctx;
}

export default AudioSourceProvider;
