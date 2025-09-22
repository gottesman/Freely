import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useI18n } from '../../core/i18n';
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../../core/SpotifyClient';
import { runTauriCommand } from '../../core/TauriCommands';
import * as audioCache from '../../core/audioCache';
import { useDB } from '../../core/Database';
import * as tc from '../../core/TorrentClient';
import { fmtTotalMs } from './Helpers';

// Constants
const DEFAULT_TIMEOUT = 10000;
const MAX_SOURCES = 50;
const CONCURRENCY_LIMIT = 2; // Reduced from 5 to 2 to limit ytdlp processes
const MIN_SEEDS = 1;
const AUTO_FETCH_LIMIT = 5; // Only auto-fetch first 5 sources to reduce CPU load

// Audio file extensions for filtering
const AUDIO_EXTENSIONS = /\.(mp3|m4a|flac|wav|ogg|aac|opus|webm)$/i;

// Icons for different source types
const SOURCE_ICONS = {
  youtube: 'https://upload.wikimedia.org/wikipedia/commons/0/09/YouTube_full-color_icon_%282017%29.svg',
  torrent: 'https://free-icon-rainbow.com/i/icon_10753/icon_10753_svg_s1.svg',
  http: 'https://cdn-icons-png.flaticon.com/512/25/25284.png',
  local: 'https://cdn-icons-png.flaticon.com/512/3767/3767084.png'
} as const;

// Helper function to get source type info
const getSourceTypeInfo = (source: any) => {
  if (source?.type === 'youtube') {
    return { type: 'YouTube', icon: SOURCE_ICONS.youtube };
  }

  if (source?.infoHash || source?.magnetURI) {
    return { type: 'Torrent', icon: SOURCE_ICONS.torrent };
  }

  if (source?.url?.startsWith('http')) {
    return { type: 'HTTP', icon: SOURCE_ICONS.http };
  }

  if (source?.path || source?.file) {
    return { type: 'Local File', icon: SOURCE_ICONS.local };
  }

  return { type: 'Unknown', icon: null };
};

// Module-level caches with better cleanup
class CacheManager {
  private static instance: CacheManager;
  private searchCache = new Map<string, any[]>();
  private searchInflight = new Map<string, Promise<any>>();
  private fileListCache = new Map<string, any[]>();
  private fileListInflight = new Map<string, Promise<any[]>>();
  private downloadInflight = new Map<string, Promise<any>>();
  private cachedFileCache = new Map<string, boolean>();
  private cachedFileInflight = new Map<string, Promise<boolean>>();

  static getInstance() {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  getSearchCache() { return this.searchCache; }
  getSearchInflight() { return this.searchInflight; }
  getFileListCache() { return this.fileListCache; }
  getFileListInflight() { return this.fileListInflight; }
  getDownloadInflight() { return this.downloadInflight; }
  getCachedFileCache() { return this.cachedFileCache; }
  getCachedFileInflight() { return this.cachedFileInflight; }

  // Cleanup method for memory management
  cleanup() {
    this.searchCache.clear();
    this.searchInflight.clear();
    this.fileListCache.clear();
    this.fileListInflight.clear();
  }
}

const cacheManager = CacheManager.getInstance();

// Utility functions
const generateCacheKey = (title: string, artist: string, year?: string): string =>
  `${title || ''}::${artist || ''}::${year || ''}`;

const generateSourceKey = (source: any, index: number): string =>
  source.infoHash ?? source.magnetURI ?? source.id ?? source.url ?? String(index);

const normalizeText = (text: string): string =>
  text.toLowerCase()
    .replace(/\s+|_+|-+/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, '')
    .trim();

// Helper function to find the matching file index for a track in torrent files
const findMatchingFileIndex = (files: any[], trackName: string): number | undefined => {
  if (!files || !trackName) {
    console.log(`[findMatchingFileIndex] Invalid input: files=${!!files}, trackName="${trackName}"`);
    return undefined;
  }

  const normTrack = normalizeText(trackName);
  console.log(`[findMatchingFileIndex] Looking for "${trackName}" (normalized: "${normTrack}") in ${files.length} files`);

  // Log first few file names for debugging
  for (let i = 0; i < Math.min(10, files.length); i++) {
    const file = files[i];
    const fileName = file.name || '';
    const isAudio = AUDIO_EXTENSIONS.test(fileName);
    console.log(`[findMatchingFileIndex] File ${i}: "${fileName}" (audio: ${isAudio})`);
  }

  // First pass: Look for exact audio file matches
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileName = file.name || '';
    const normFile = normalizeText(fileName);

    // Check if it's an audio file
    if (AUDIO_EXTENSIONS.test(fileName)) {
      // Prefer files that contain the track name and are audio files
      if (normFile.includes(normTrack)) {
        console.log(`[findMatchingFileIndex] Found audio match at index ${i}: "${fileName}"`);
        return i;
      }
    }
  }

  console.log(`[findMatchingFileIndex] No audio file matches found, checking all files...`);

  // Second pass: If no exact audio match, look for any file containing the track name
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const normFile = normalizeText(file.name || '');
    if (normFile.includes(normTrack)) {
      console.log(`[findMatchingFileIndex] Found any file match at index ${i}: "${file.name}"`);
      return i;
    }
  }

  console.log(`[findMatchingFileIndex] No matches found for "${trackName}"`);
  return undefined;
};

// Helper to get all matching file indices for a track
const findAllMatchingFileIndices = (files: any[], trackName: string): number[] => {
  if (!files || !Array.isArray(files) || !trackName) {
    return [];
  }

  const normTrack = normalizeText(trackName);
  const matches: number[] = [];

  // Check audio files first
  const audioMatches: number[] = [];
  files.forEach((file, i) => {
    const fileName = file?.name || '';
    const isAudio = AUDIO_EXTENSIONS.test(fileName);
    const normFile = normalizeText(fileName);
    
    if (normFile.includes(normTrack)) {
      if (isAudio) {
        audioMatches.push(i);
      } else {
        matches.push(i);
      }
    }
  });

  // Prefer audio matches
  return audioMatches.length > 0 ? audioMatches : matches;
};

// Helper to get the selected file index for a source, falling back to auto-selection
const getSelectedFileIndex = (
  sourceKey: string, 
  files: any[], 
  trackName: string, 
  selectedFileIndices: Record<string, number>
): number | undefined => {
  // If user has manually selected a file, use that
  if (selectedFileIndices[sourceKey] !== undefined) {
    const selectedIndex = selectedFileIndices[sourceKey];
    // Validate that the selected index is still valid
    if (files && selectedIndex >= 0 && selectedIndex < files.length) {
      return selectedIndex;
    }
  }
  
  // Otherwise, use automatic matching
  return findMatchingFileIndex(files, trackName);
};

// Combined state type for better performance
interface SourceState {
  sources: any[] | undefined;
  fileLists: Record<string, { name: string; length: number }[]>;
  loadingKeys: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  visibleOutputs: Record<string, boolean>;
  selectedSourceKey: string | undefined;
  selectedFileIndices: Record<string, number>; // sourceKey -> real file index
  lastQuery: string | undefined;
  loadError: string | undefined;
  isCollapsed: boolean;
  downloadStates: Record<string, 'idle' | 'downloading' | 'completed' | 'error'>;
  downloadProgress: Record<string, { bytes: number; total?: number } | undefined>;
}

const initialState: SourceState = {
  sources: undefined,
  fileLists: {},
  loadingKeys: {},
  errors: {},
  visibleOutputs: {},
  selectedSourceKey: undefined,
  selectedFileIndices: {},
  lastQuery: undefined,
  loadError: undefined,
  isCollapsed: true,
  downloadStates: {},
  downloadProgress: {}
};

export default function TrackSources({ track, album, primaryArtist }: {
  track?: SpotifyTrack;
  album?: SpotifyAlbum;
  primaryArtist?: SpotifyArtist;
}) {
  const { t } = useI18n();
  const { getSetting, setSetting, getSource, setSource } = useDB();
  const [state, setState] = useState<SourceState>(initialState);
  const wtClientRef = useRef<any | null>(null);
  const fetchedQueriesRef = useRef<Record<string, boolean>>({});
  const abortControllerRef = useRef<AbortController | null>(null);
  const sourcesRef = useRef<any[] | undefined>(state.sources);

  // Persisted sources cache TTL (to avoid re-requesting every time)
  // Adjust as needed; 6 hours strikes a balance between freshness and fewer lookups
  const SOURCES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  // Memoized values
  const currentTrackName = useMemo(() => track?.name?.trim() || '', [track?.name]);

  const searchParams = useMemo(() => {
    const title = album?.name ?? track?.album?.name ?? track?.name ?? "";
    const artist = track?.artists?.[0]?.name ?? primaryArtist?.name ?? "";
    const year = album?.releaseDate ?? track?.album?.releaseDate ?? undefined;
    return { title, artist, year };
  }, [album, track, primaryArtist]);

  const cacheKey = useMemo(() =>
    generateCacheKey(searchParams.title, searchParams.artist, searchParams.year),
    [searchParams]
  );

  // Cleanup effect
  useEffect(() => {
    return () => {
      if (wtClientRef.current?.destroy) {
        try {
          wtClientRef.current.destroy();
          wtClientRef.current = null;
        } catch (e) {
          console.error('Failed to destroy WebTorrent client', e);
        }
      }
      abortControllerRef.current?.abort();
    };
  }, []);

  // Keep a ref of current sources for event handlers to avoid stale closures
  useEffect(() => {
    sourcesRef.current = state.sources;
  }, [state.sources]);

  // Helper to find a sourceKey from event payload (best-effort)
  const findSourceKeyForEvent = useCallback((payload: any) => {
    if (!sourcesRef.current) return undefined;
    const { sourceHash } = payload || {};

    // Recreate the same filtered/ordered list as the UI (validSources) so the index used
    // when rendering the button matches the key we compute here.
    const all = sourcesRef.current || [];
    const filtered: any[] = all.filter((s: any) => {
      if (!s) return false;
      if (s.type === 'youtube') return true;
      const seeds = Number(s.seeders ?? s.seeds ?? 0);
      return seeds >= MIN_SEEDS;
    });

    for (let i = 0; i < filtered.length; i++) {
      const s = filtered[i];
      const key = generateSourceKey(s, i);
      if (!s) continue;
      const candidates = [s.id, s.infoHash, s.magnetURI, s.url, s.playUrl, s.streamUrl];
      for (const c of candidates) {
        if (!c) continue;
        try {
          if (String(c) === String(sourceHash)) return key;
          if (String(c).startsWith(String(sourceHash))) return key;
          if (String(sourceHash).startsWith(String(c))) return key;
        } catch { /* ignore */ }
      }
      if (payload.cachedPath) {
        const cp = String(payload.cachedPath);
        if (s.playUrl && cp.includes(String(s.playUrl))) return key;
        if (s.streamUrl && cp.includes(String(s.streamUrl))) return key;
      }
    }
    // No exact match found; debug for developer
    try {
      console.debug('[TrackSources] Unmatched cache event payload (could not map to source):', payload, sourcesRef.current?.map((s, i) => ({ key: generateSourceKey(s, i), id: s.id, infoHash: s.infoHash, playUrl: s.playUrl, streamUrl: s.streamUrl })));
    } catch { /* ignore */ }
    return undefined;
  }, []);

  // Estimate total bytes for a source using metadata or file list
  const estimateTotalBytesForSource = useCallback((source: any, sourceKey: string) => {
    if (!source) return undefined;
    // If explicit size provided on source (like '3.4 MB'), try to parse
    if (source.size && typeof source.size === 'string') {
      const m = String(source.size).match(/([0-9.]+)\s*(kb|mb|gb|b)/i);
      if (m) {
        const n = parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        if (!isNaN(n)) {
          if (unit === 'b') return Math.round(n);
          if (unit === 'kb') return Math.round(n * 1024);
          if (unit === 'mb') return Math.round(n * 1024 * 1024);
          if (unit === 'gb') return Math.round(n * 1024 * 1024 * 1024);
        }
      }
    }

    // If files list exists, sum lengths
    const fileList = state.fileLists[sourceKey];
    if (Array.isArray(fileList) && fileList.length > 0) {
      const sum = fileList.reduce((acc, f) => acc + (Number(f.length) || 0), 0);
      if (sum > 0) return sum;
    }

    return undefined;
  }, [state.fileLists]);

  // Wire Tauri events emitted by backend for download progress/completion/errors
  useEffect(() => {
    if (!track?.id) return; // only listen when we have a track context
    let isMounted = true;
    const unlistenFns: Array<() => void> = [];

    (async () => {
      try {
        const events = await import('@tauri-apps/api/event');

        const un1 = await events.listen('cache:download:progress', (evt: any) => {
          if (!isMounted) return;
          const p = evt.payload || evt;
          if (!p || p.trackId !== track.id) return;
          const key = findSourceKeyForEvent(p);
          if (!key) return;
          // Ensure total is populated when possible so the UI can display percent
          let total = p.total_bytes;
          if (!total) {
            // find the source object corresponding to this key
            const all = sourcesRef.current || [];
            const filtered = all.filter((s: any) => s ? (s.type === 'youtube' ? true : (Number(s.seeders ?? s.seeds ?? 0) >= MIN_SEEDS)) : false);
            const idx = filtered.findIndex((s: any, i: number) => generateSourceKey(s, i) === key);
            const src = idx !== -1 ? filtered[idx] : undefined;
            const est = estimateTotalBytesForSource(src, key);
            if (est && est > 0) total = est;
          }

          setState(prev => ({
            ...prev,
            downloadStates: { ...prev.downloadStates, [key]: 'downloading' },
            downloadProgress: { ...prev.downloadProgress, [key]: { bytes: p.bytes_downloaded || 0, total: total } }
          }));
        });
        unlistenFns.push(un1);

        const un2 = await events.listen('cache:download:complete', (evt: any) => {
          if (!isMounted) return;
          const p = evt.payload || evt;
          if (!p || p.trackId !== track.id) return;
          const key = findSourceKeyForEvent(p);
          if (!key) return;
          setState(prev => ({
            ...prev,
            downloadStates: { ...prev.downloadStates, [key]: 'completed' },
            downloadProgress: { ...prev.downloadProgress, [key]: undefined }
          }));
        });
        unlistenFns.push(un2);

        const un3 = await events.listen('cache:download:error', (evt: any) => {
          if (!isMounted) return;
          const p = evt.payload || evt;
          if (!p || p.trackId !== track.id) return;
          const key = findSourceKeyForEvent(p);
          if (!key) return;
          setState(prev => ({
            ...prev,
            downloadStates: { ...prev.downloadStates, [key]: 'error' }
          }));
        });
        unlistenFns.push(un3);

        // Ready event: indicates the backend considers the .part file ready/playable
        const un4 = await events.listen('cache:download:ready', (evt: any) => {
          if (!isMounted) return;
          const p = evt.payload || evt;
          if (!p || p.trackId !== track.id) return;
          const key = findSourceKeyForEvent(p);
          if (!key) return;
          // The payload may include bytes_downloaded and tmpPath
          setState(prev => ({
            ...prev,
            downloadStates: { ...prev.downloadStates, [key]: 'downloading' },
            downloadProgress: { ...prev.downloadProgress, [key]: { bytes: p.bytes_downloaded || 0, total: p.total_bytes || prev.downloadProgress?.[key]?.total } }
          }));
        });
        unlistenFns.push(un4);
      } catch (e) {
        // Tauri event API not available in this environment (e.g., web preview)
        console.debug('[TrackSources] Tauri event API not available', e);
      }
    })();

    return () => {
      isMounted = false;
      unlistenFns.forEach(fn => {
        try { fn(); } catch { /* ignore */ }
      });
    };
  }, [track?.id, findSourceKeyForEvent]);

  // Load sources effect
  useEffect(() => {
    let cancelled = false;
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    const { title, artist, year } = searchParams;
    const query = `${title} ${artist}`.trim();

    setState(prev => ({
      ...prev,
      lastQuery: query || undefined,
      loadError: undefined,
      sources: undefined
    }));

    if (!track || (!title && !artist)) {
      setState(prev => ({ ...prev, sources: [] }));
      return;
    }

    const loadSources = async () => {
      try {
        const errors: string[] = [];
        let results: any[] = [];
        const searchCache = cacheManager.getSearchCache();
        const searchInflight = cacheManager.getSearchInflight();

        // Try persisted cache first (DB-backed), then warm memory cache
        try {
          const persisted = await getSource?.(`cache:${cacheKey}`);
          if (persisted) {
            try {
              const parsed = JSON.parse(persisted);
              const ts = Number(parsed?.ts ?? 0);
              const arr = parsed?.results;
              if (Array.isArray(arr) && ts > 0 && (Date.now() - ts) < SOURCES_CACHE_TTL_MS) {
                searchCache.set(cacheKey, arr);
              } else if (Array.isArray(arr)) {
                // Expired; lazily clear
                await setSource?.(`cache:${cacheKey}`, '');
              }
            } catch {
              // ignore malformed persisted value
            }
          }
        } catch {
          // persistence not available; continue
        }

        // Check cache first
        if (searchCache.has(cacheKey)) {
          results = searchCache.get(cacheKey) || [];
        } else {
          // Check for inflight request
          let promise = searchInflight.get(cacheKey);
          if (!promise) {
            promise = (async () => {
              const torrentPayload = { title: title, artist, type: 'torrents' };
              const youtubeTitle = track?.name || title;
              const youtubePayload = { title: youtubeTitle, artist, type: 'youtube' };

              const [torrentResp, youtubeResp] = await Promise.allSettled([
                runTauriCommand('source_search', { payload: torrentPayload }),
                runTauriCommand('source_search', { payload: youtubePayload })
              ]);

              const torrentResults = torrentResp.status === 'fulfilled'
                ? Array.isArray(torrentResp.value)
                  ? torrentResp.value
                  : (torrentResp.value?.results ?? torrentResp.value?.items ?? [])
                : [];

              const youtubeResults = youtubeResp.status === 'fulfilled'
                ? Array.isArray(youtubeResp.value)
                  ? youtubeResp.value
                  : (youtubeResp.value?.results ?? youtubeResp.value?.items ?? [])
                : [];

              if (torrentResp.status === 'rejected') {
                errors.push(`torrent search: ${torrentResp.reason}`);
              }
              if (youtubeResp.status === 'rejected') {
                errors.push(`youtube search: ${youtubeResp.reason}`);
              }

              const combined = [...youtubeResults, ...torrentResults];
              searchCache.set(cacheKey, combined);
              searchInflight.delete(cacheKey);
              // Persist successful results with timestamp for future sessions
              if (combined && combined.length > 0) {
                try {
                  await setSource?.(
                    `cache:${cacheKey}`,
                    JSON.stringify({ ts: Date.now(), results: combined })
                  );
                } catch {
                  // ignore persistence failure
                }
              }
              return combined;
            })();
            searchInflight.set(cacheKey, promise);
          }

          try {
            results = await promise;
          } catch (e) {
            searchInflight.delete(cacheKey);
            errors.push(`search failed: ${String(e)}`);
          }
        }

        if (cancelled) return;

        if (results?.length > 0) {
          const subset = results.slice(0, MAX_SOURCES);
          setState(prev => ({ ...prev, sources: subset }));

          // Check cache states for all sources
          if (track?.id) {
            const checkAllCacheStates = async () => {
              const cacheStates: Record<string, 'idle' | 'downloading' | 'completed' | 'error'> = {};
              
              for (let i = 0; i < subset.length; i++) {
                const source = subset[i];
                const sourceKey = generateSourceKey(source, i);
                
                try {
                  const isCached = await checkSourceCached(source, sourceKey);
                  cacheStates[sourceKey] = isCached ? 'completed' : 'idle';
                } catch (e) {
                  console.error(`Failed to check cache for source ${sourceKey}:`, e);
                  cacheStates[sourceKey] = 'idle';
                }
              }
              
              setState(prev => ({
                ...prev,
                downloadStates: { ...prev.downloadStates, ...cacheStates }
              }));
            };
            
            checkAllCacheStates();
          }

          // Restore previously selected source
          if (track?.id) {
            try {
              const saved = await getSource?.(`selected:${track.id}`);
              if (saved) {
                const parsed = JSON.parse(saved);
                const match = subset.find(s =>
                  (parsed.infoHash && s.infoHash === parsed.infoHash) ||
                  (parsed.magnetURI && s.magnetURI === parsed.magnetURI) ||
                  (parsed.id && s.id === parsed.id) ||
                  (parsed.playUrl && s.playUrl === parsed.playUrl)
                );
                if (match) {
                  const key = generateSourceKey(match, 0);
                  setState(prev => ({ ...prev, selectedSourceKey: key }));
                }
              }
            } catch {
              // Ignore restore errors
            }
          }
        } else {
          setState(prev => ({
            ...prev,
            sources: [],
            loadError: errors.join(' | ') || 'No sources found'
          }));
        }
      } catch (err) {
        console.error('TrackSources: load error', err);
        if (!cancelled) {
          setState(prev => ({
            ...prev,
            sources: [],
            loadError: String(err)
          }));
        }
      }
    };

    loadSources();
    return () => { cancelled = true; };
  }, [track?.id, cacheKey, searchParams, getSetting]);

  // Handle source data loading with optimized state updates
  const handleSourceData = useCallback(async (source: any, sourceKey: string): Promise<any[]> => {
    setState(prev => ({
      ...prev,
      errors: { ...prev.errors, [sourceKey]: undefined },
      loadingKeys: { ...prev.loadingKeys, [sourceKey]: true }
    }));

    try {
      const id = source.magnetURI ?? source.infoHash ?? source.id ?? source.url ?? source.path ?? '';
      if (!id) throw new Error('Missing source id');

      const fileListCache = cacheManager.getFileListCache();
      const fileListInflight = cacheManager.getFileListInflight();

      // Return cached files if available (only for successful results)
      if (fileListCache.has(sourceKey)) {
        const cached = fileListCache.get(sourceKey) || [];
        setState(prev => ({
          ...prev,
          fileLists: { ...prev.fileLists, [sourceKey]: cached },
          loadingKeys: { ...prev.loadingKeys, [sourceKey]: false }
        }));
        return cached;
      }

      // Check for inflight request
      let promise = fileListInflight.get(id);
      if (!promise) {
        promise = (async () => {
          try {
            // Handle YouTube FIRST so playUrl/streamUrl becomes available sooner
            if (source.type === 'youtube' && source.id) {
              try {
                const info = await runTauriCommand<any>('youtube_get_info', {
                  payload: { id: source.id }
                });
                
                // Check for unavailable video error
                if (info?.success === false && info?.reason === 'unavailable') {
                  throw new Error('Video is unavailable');
                }
                
                const streamUrl = info?.streamUrl || null;
                if (streamUrl) {
                  source.streamUrl = streamUrl;
                  source.playUrl = streamUrl;
                }
                const estBytes = info?.format?.filesize || info?.format?.filesize_approx || 0;
                const syntheticName = source.title || source.name || `youtube:${source.id}`;
                const synthetic = [{ name: syntheticName, length: estBytes }];
                fileListCache.set(sourceKey, synthetic);
                setState(prev => ({
                  ...prev,
                  fileLists: { ...prev.fileLists, [sourceKey]: synthetic },
                  loadingKeys: { ...prev.loadingKeys, [sourceKey]: false }
                }));
                return synthetic;
              } catch (youtubeError: any) {
                const errorMsg = youtubeError?.message || String(youtubeError);
                
                // Handle unavailable video specifically
                if (errorMsg.includes('Video is unavailable') || errorMsg.includes('unavailable')) {
                  console.warn(`[TrackSources] YouTube video ${source.id} is unavailable, skipping`);
                  // Don't cache unavailable videos - let them fail gracefully
                  throw new Error('Video is unavailable');
                }
                
                // Re-throw other errors
                throw youtubeError;
              }
            }

            const maybeInfoHash = String(id || '');
            const isMagnet = maybeInfoHash.startsWith('magnet:');
            const isInfoHash = /^[a-f0-9]{40}$/i.test(maybeInfoHash);

            if (isMagnet || isInfoHash) {
              const files = await tc.getTorrentFileList(id, { timeoutMs: DEFAULT_TIMEOUT });
              const seen = new Set();
              const uniqueFiles = (files || []).filter((f: any) => {
                const name = String(f.name || '').trim();
                if (!name || seen.has(name)) return false;
                seen.add(name);
                return true;
              });

              // Cache the full file list so indices match the original torrent
              fileListCache.set(sourceKey, uniqueFiles);
              setState(prev => ({
                ...prev,
                fileLists: { ...prev.fileLists, [sourceKey]: uniqueFiles },
                loadingKeys: { ...prev.loadingKeys, [sourceKey]: false }
              }));
              return uniqueFiles;
            }

            // Generic sources
            const syntheticName = source.title || source.name || String(id);
            const synthetic = [{ name: syntheticName, length: source.length || 0 }];
            fileListCache.set(sourceKey, synthetic);
            setState(prev => ({
              ...prev,
              fileLists: { ...prev.fileLists, [sourceKey]: synthetic },
              loadingKeys: { ...prev.loadingKeys, [sourceKey]: false }
            }));
            return synthetic;
          } finally {
            // Always clean up inflight promise
            fileListInflight.delete(id);
          }
        })();
        fileListInflight.set(id, promise);
      }

      const files = await promise;
      setState(prev => ({
        ...prev,
        fileLists: { ...prev.fileLists, [sourceKey]: files },
        loadingKeys: { ...prev.loadingKeys, [sourceKey]: false }
      }));
      return files;
    } catch (e: any) {
      let msg = e?.message ?? String(e);

      // Log the full error message first for debugging
      console.error('TrackSources: full error details', {
        originalError: e,
        fullMessage: msg,
        messageLength: msg.length,
        source: source?.infoHash || source?.magnetURI || source?.id || 'unknown'
      });

      // Clean up malformed error messages
      if (msg.startsWith('ERR: ') && msg.length > 50 && !msg.includes(' ')) {
        // This looks like a malformed concatenated error - provide a generic message
        console.warn('TrackSources: sanitizing long error message:', msg);
        msg = 'Failed to load torrent files';
      }

      console.error('TrackSources: file list error', msg);

      // Clean up failed request from inflight map
      const id = source.magnetURI ?? source.infoHash ?? source.id ?? source.url ?? source.path ?? '';
      if (id) {
        const fileListInflight = cacheManager.getFileListInflight();
        fileListInflight.delete(id);
      }

      setState(prev => ({
        ...prev,
        errors: { ...prev.errors, [sourceKey]: msg },
        loadingKeys: { ...prev.loadingKeys, [sourceKey]: false }
      }));
      return [];
    }
  }, []);


  // Auto-fetch file lists for priority sources only (reduced CPU load)
  useEffect(() => {
    const { lastQuery, sources } = state;
    if (!lastQuery || !sources?.length || fetchedQueriesRef.current[lastQuery]) return;

    // Only auto-fetch first few sources to reduce CPU load
    const candidates = sources
      .slice(0, AUTO_FETCH_LIMIT) // Limit auto-fetching
      .map((s: any, i: number) => ({
        source: s,
        key: generateSourceKey(s, i)
      }))
      .filter(({ source }) => !!(
        source.infoHash || source.magnetURI || source.id || source.url
      ))
      // Prioritize YouTube first so their stream URLs & synthetic file entries populate early
      .sort((a, b) => {
        const ay = a.source.type === 'youtube' ? 0 : 1;
        const by = b.source.type === 'youtube' ? 0 : 1;
        return ay - by;
      });

    const batchProcess = async () => {
      // Process with even smaller batches to reduce concurrent ytdlp processes
      for (let i = 0; i < candidates.length; i += CONCURRENCY_LIMIT) {
        const batch = candidates.slice(i, i + CONCURRENCY_LIMIT);
        await Promise.allSettled(
          batch.map(async ({ source, key }) => {
            if (state.fileLists[key] || state.loadingKeys[key]) {
              return Promise.resolve();
            }
            
            // Skip loading if source is already cached
            const isCached = state.downloadStates[key] === 'completed';
            if (isCached) {
              console.log(`[TrackSources] Skipping file loading for cached source ${key}`);
              return Promise.resolve();
            }
            
            return handleSourceData(source, key);
          })
        );

        // Add small delay between batches to prevent overwhelming the system
        if (i + CONCURRENCY_LIMIT < candidates.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      fetchedQueriesRef.current[lastQuery] = true;
    };

    console.log(`[TrackSources] Auto-fetching ${candidates.length} priority sources`);
    batchProcess();
  }, [state.sources, state.lastQuery, state.fileLists, state.loadingKeys, handleSourceData]);

  // Check if source is cached
  const checkSourceCached = useCallback(async (source: any, sourceKey: string) => {
    if (!track?.id) return false;

    try {
      const sourceType = source.type === 'youtube' ? 'youtube' : 'torrent';
      const sourceHash = source.id || source.infoHash || source.magnetURI || source.url || '';

      if (!sourceHash) {
        console.log(`[TrackSources] No source hash for ${sourceKey}`);
        return false;
      }

      const cachedFileCache = cacheManager.getCachedFileCache();
      const cachedFileInflight = cacheManager.getCachedFileInflight();

      const cacheKey = `${track.id}::${sourceType}::${sourceHash}`;

      // Return cached result if we have it
      if (cachedFileCache.has(cacheKey)) {
        return Boolean(cachedFileCache.get(cacheKey));
      }

      // If an inflight check exists, await it
      if (cachedFileInflight.has(cacheKey)) {
        try {
          const val = await cachedFileInflight.get(cacheKey)!;
          return val;
        } catch (e) {
          // fallthrough to perform a fresh check
        }
      }

      // Otherwise, perform the IPC check and store inflight promise
      const promise = (async () => {
        try {
          // For torrents, we need to find the file index
          let fileIndex;
          if (sourceType === 'torrent') {
            let files = state.fileLists[sourceKey] || [];
            
            // If file list is not loaded yet, load it first
            if (files.length === 0) {
              console.log(`[TrackSources] File list not loaded for ${sourceKey}, loading before cache check`);
              try {
                files = await handleSourceData(source, generateSourceKey(source, state.sources.indexOf(source)));
              } catch (e) {
                console.warn(`[TrackSources] Failed to load file list for cache check:`, e);
                files = [];
              }
            }
            
            if (files.length > 0) {
              const targetFileIndex = files.findIndex((file: any) => file.name && AUDIO_EXTENSIONS.test(file.name));
              if (targetFileIndex !== -1) {
                fileIndex = targetFileIndex;
                console.log(`[TrackSources] Cache check using file_index: ${fileIndex} for ${sourceKey}`);
              }
            }
          }

          console.log(`[TrackSources] Checking cache with params:`, {
            trackId: track.id,
            sourceType,
            sourceHash: sourceHash.substring(0, 16) + '...',
            fileIndex
          });

          const result = await runTauriCommand('cache_get_file', {
            trackId: track.id,
            track_id: track.id,
            sourceType: sourceType,
            source_type: sourceType,
            sourceHash: sourceHash,
            source_hash: sourceHash,
            ...(fileIndex !== undefined && { fileIndex, file_index: fileIndex })
          });
          console.log(`[TrackSources] Cache check result for ${sourceKey}:`, result);
          const isCached = result?.exists === true;
          cachedFileCache.set(cacheKey, isCached);
          // Expire this cache entry after a short period to keep freshness
          setTimeout(() => cachedFileCache.delete(cacheKey), 5000);
          return isCached;
        } finally {
          cachedFileInflight.delete(cacheKey);
        }
      })();

      cachedFileInflight.set(cacheKey, promise);
      return await promise;
    } catch (e) {
      console.error('Failed to check cache status:', e);
      return false;
    }
  }, [track?.id]);

  // Download source to cache
  const downloadSource = useCallback(async (source: any, sourceKey: string) => {
    if (!track?.id) return;

    console.log(`[TrackSources] Starting download for ${sourceKey}`);

    setState(prev => ({
      ...prev,
      downloadStates: { ...prev.downloadStates, [sourceKey]: 'downloading' }
    }));

    try {
      const sourceType = source.type === 'youtube' ? 'youtube' : 'torrent';
      let sourceHash = sourceType === 'torrent' ? (source.magnetURI || source.infoHash || source.id || '') : (source.id || source.infoHash || source.magnetURI || source.url || '');

      // For torrents, normalize the source hash to just the infoHash for cache key purposes
      if (sourceType === 'torrent' && sourceHash.startsWith('magnet:')) {
        const match = sourceHash.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
        if (match && match[1]) {
          sourceHash = match[1].toLowerCase();
        }
      }

      if (!sourceHash) {
        throw new Error('No source identifier available');
      }

      console.log(`[TrackSources] Download params: type=${sourceType}, hash=${sourceHash}`);

      // Get the URL to download
      let downloadUrl = source.playUrl || source.streamUrl || source.url;

      // For torrent sources, use the magnet URI as the download URL
      if (sourceType === 'torrent') {
        downloadUrl = source.magnetURI || sourceHash;
      }

      // For YouTube, ensure we have the stream URL
      if (source.type === 'youtube' && source.id && !downloadUrl) {
        console.log(`[TrackSources] YouTube source ${sourceKey} needs stream URL, loading source data first`);
        
        try {
          // Load source data if not already loaded to get the stream URL
          if (!source.streamUrl && !source.playUrl) {
            await handleSourceData(source, sourceKey);
          }
          
          // Now use the stream URL that should be available
          downloadUrl = source.streamUrl || source.playUrl;
          console.log(`[TrackSources] Using YouTube URL after loading: ${downloadUrl ? 'yes' : 'no'}`);
          
          if (!downloadUrl) {
            throw new Error('Failed to get YouTube stream URL');
          }
        } catch (sourceError: any) {
          const errorMsg = sourceError?.message || String(sourceError);
          
          // Handle unavailable video specifically
          if (errorMsg.includes('Video is unavailable') || errorMsg.includes('unavailable')) {
            console.warn(`[TrackSources] Cannot download unavailable YouTube video ${source.id}`);
            alert(`This YouTube video is unavailable and cannot be downloaded. It may be private, deleted, or region-restricted.`);
            
            // Reset download state and don't proceed
            setState(prev => ({
              ...prev,
              downloadStates: { ...prev.downloadStates, [sourceKey]: 'idle' }
            }));
            return;
          }
          
          // Re-throw other errors
          throw sourceError;
        }
      }

      if (!downloadUrl) {
        throw new Error('No download URL available');
      }

      console.log(`[TrackSources] Starting cache download for ${sourceKey} from ${downloadUrl}`);

      // If the user explicitly requested download & playback, try to start playback via
      // the backend cache-aware entrypoint so the backend will attempt to download -> play
      // .part and then hand off to .m4a. This avoids creating a CDN stream locally.
      // Previously we attempted to start playback via the cache-aware backend entrypoint
      // when the user clicked Download. That caused downloads to sometimes start audio
      // playback unexpectedly and put the player into a sticky "loading" state.
      //
      // Instead, only run the download pipeline here (no automatic playback). The
      // backend still performs caching and emits progress events which the UI listens
      // for. If the user explicitly chooses Play, the normal playback flows will run.

      // Dedupe frontend downloads using CacheManager.downloadInflight
      const downloadMap = cacheManager.getDownloadInflight();
      if (downloadMap.has(sourceKey)) {
        console.log(`[TrackSources] Download already inflight for ${sourceKey}, awaiting existing promise`);
        try {
          await downloadMap.get(sourceKey);
        } catch (e) {
          console.warn(`[TrackSources] Existing inflight download for ${sourceKey} failed:`, e);
        }
      } else {
        const p = (async () => {
          try {
            // For torrents, find the matching file index to download only that file
            let fileIndex: number | undefined = undefined;
            if (sourceType === 'torrent') {
              let files = state.fileLists[sourceKey];
              console.log(`[TrackSources] Finding file index for track "${currentTrackName}" in ${files?.length || 0} files`);
              
              // If file list is not loaded, load it now
              if (!files || !Array.isArray(files) || files.length === 0) {
                console.log(`[TrackSources] File list not loaded for ${sourceKey}, loading now...`);
                try {
                  files = await handleSourceData(source, sourceKey);
                  console.log(`[TrackSources] File list loaded: ${files?.length || 0} files`);
                } catch (loadError) {
                  console.error(`[TrackSources] Failed to load file list for ${sourceKey}:`, loadError);
                  files = [];
                }
              }
              
              if (files && Array.isArray(files) && files.length > 0) {
                fileIndex = getSelectedFileIndex(sourceKey, files, currentTrackName, state.selectedFileIndices);
                console.log(`[TrackSources] Torrent ${sourceKey}: found matching file index ${fileIndex} for track "${currentTrackName}"`);
                
                // For torrents, check if the specific file is already cached
                if (fileIndex !== undefined) {
                  try {
                    const cacheResult = await runTauriCommand('cache_get_file', {
                      trackId: track.id,
                      sourceType: sourceType,
                      sourceHash: sourceHash,
                      file_index: fileIndex
                    });
                    if (cacheResult?.exists) {
                      console.log(`[TrackSources] Torrent file already cached for ${sourceKey} at index ${fileIndex}`);
                      setState(prev => ({
                        ...prev,
                        downloadStates: { ...prev.downloadStates, [sourceKey]: 'completed' }
                      }));
                      return;
                    }
                  } catch (cacheError) {
                    console.warn(`[TrackSources] Cache check failed for ${sourceKey}:`, cacheError);
                  }
                }
              }
            }
            
            console.log(`[TrackSources] About to call audioCache.downloadAndCache with:`, {
              trackId: track.id,
              sourceType,
              sourceHash,
              downloadUrl: downloadUrl.startsWith('magnet:') ? 'magnet:...' : downloadUrl,
              fileIndex
            });
            await audioCache.downloadAndCache(track.id, sourceType, sourceHash, downloadUrl, fileIndex);
            console.log(`[TrackSources] Cache download initiated for ${sourceKey}`);
            // Poll for completion using an adaptive schedule: quick checks initially
            // so the UI becomes responsive fast, then slower checks to avoid CPU/network churn.
            // Total timeout: 90 seconds.
            const totalTimeoutMs = 90 * 1000;
            const startTs = Date.now();
            let lastChecked = 0;

            while (Date.now() - startTs < totalTimeoutMs) {
              const elapsed = Date.now() - startTs;

              // adaptive interval: 250ms for first 5s, 500ms for next 10s, then 1000ms
              const interval = elapsed < 5000 ? 250 : (elapsed < 15000 ? 500 : 1000);
              await new Promise(resolve => setTimeout(resolve, interval));
              lastChecked += interval;

              try {
                // use backend inflight status (more accurate) when available
                let status: any = null;
                try {
                  status = await runTauriCommand('cache_download_status', {
                    // send both casings
                    trackId: track.id,
                    track_id: track.id,
                    sourceType,
                    source_type: sourceType,
                    sourceHash,
                    source_hash: sourceHash,
                    // Ensure the backend uses the correct inflight key for torrents
                    fileIndex: fileIndex,
                    file_index: fileIndex
                  });
                } catch (e) {
                  // ignore - some backends may not implement this command
                }

                if (status && status.inflight) {
                  // update progress map in state
                  setState(prev => ({
                    ...prev,
                    downloadProgress: { ...prev.downloadProgress, [sourceKey]: { bytes: status.bytes_downloaded || 0, total: status.total_bytes || undefined } }
                  }));

                  // if backend reports completed, flip state
                  if (status.completed) {
                    setState(prev => ({ ...prev, downloadStates: { ...prev.downloadStates, [sourceKey]: 'completed' } }));
                    return;
                  }
                }

                // fallback to existence check (include file_index for torrents when known)
                let isNowCached = false;
                try {
                  if (sourceType === 'torrent' && fileIndex !== undefined) {
                    const cacheResult = await runTauriCommand('cache_get_file', {
                      trackId: track.id,
                      track_id: track.id,
                      sourceType: sourceType,
                      source_type: sourceType,
                      sourceHash: sourceHash,
                      source_hash: sourceHash,
                      fileIndex: fileIndex,
                      file_index: fileIndex
                    });
                    isNowCached = cacheResult?.exists === true;
                  } else {
                    isNowCached = await checkSourceCached(source, sourceKey);
                  }
                } catch (existErr) {
                  console.warn('[TrackSources] Existence fallback check failed:', existErr);
                  isNowCached = await checkSourceCached(source, sourceKey);
                }
                if (isNowCached) {
                  const tookMs = Date.now() - startTs;
                  console.log(`[TrackSources] Download completed for ${sourceKey} after ${Math.round(tookMs/1000)}s`);
                  setState(prev => ({
                    ...prev,
                    downloadStates: { ...prev.downloadStates, [sourceKey]: 'completed' },
                    downloadProgress: { ...prev.downloadProgress, [sourceKey]: undefined }
                  }));
                  return;
                }
              } catch (e) {
                console.error('Error checking cache completion or progress:', e);
                // continue polling unless timeout
              }
            }

            console.warn(`[TrackSources] Download polling timed out for ${sourceKey} after ${Math.round(totalTimeoutMs/1000)}s`);
            setState(prev => ({
              ...prev,
              downloadStates: { ...prev.downloadStates, [sourceKey]: 'error' }
            }));
          } finally {
            // remove inflight marker
            downloadMap.delete(sourceKey);
          }
        })();

        downloadMap.set(sourceKey, p);
        // run without awaiting so UI stays responsive; caller may await if needed
        p.catch(e => console.error(`[TrackSources] download promise error for ${sourceKey}:`, e));
      }

    } catch (e) {
      console.error(`[TrackSources] Download failed for ${sourceKey}:`, e);
      setState(prev => ({
        ...prev,
        downloadStates: { ...prev.downloadStates, [sourceKey]: 'error' }
      }));
    }
  }, [track?.id, checkSourceCached, handleSourceData, currentTrackName, state.selectedFileIndices]);

  // Event handlers
  const handleSourceSelect = useCallback(async (source: any, sourceKey: string) => {
    // If source is loading, do nothing
    if (state.loadingKeys[sourceKey]) return;

    // If source is not loaded or has error, trigger loading (unless already cached)
    if ((!state.fileLists[sourceKey] || state.errors[sourceKey]) && state.downloadStates[sourceKey] !== 'completed') {
      try {
        await handleSourceData(source, sourceKey);
      } catch (loadError: any) {
        const errorMsg = loadError?.message || String(loadError);
        
        // Handle unavailable video specifically
        if (errorMsg.includes('Video is unavailable') || errorMsg.includes('unavailable')) {
          console.warn(`[TrackSources] Cannot select unavailable YouTube video ${source.id}`);
          alert(`This YouTube video is unavailable and cannot be played. It may be private, deleted, or region-restricted.`);
          return;
        }
        
        // For other errors, still allow selection but show the error
        console.error('Failed to load source data:', loadError);
      }
    }

  // Source is loaded, proceed with selection
    const isCurrentlySelected = state.selectedSourceKey === sourceKey;
    const newKey = isCurrentlySelected ? undefined : sourceKey;

    setState(prev => ({ ...prev, selectedSourceKey: newKey }));

    // Persist selection
    if (track?.id) {
      try {
        if (newKey) {
          // For torrents, find the matching file index
          let fileIndex: number | undefined = undefined;
          if (source.type === 'torrent') {
            let files = state.fileLists[sourceKey];
            
            // If file list is not loaded, load it now
            if (!files || !Array.isArray(files) || files.length === 0) {
              console.log(`[TrackSources] File list not loaded for ${sourceKey} during source selection, loading now...`);
              try {
                files = await handleSourceData(source, sourceKey);
                console.log(`[TrackSources] Loaded ${files?.length || 0} files for ${sourceKey} during source selection`);
              } catch (e) {
                console.warn(`[TrackSources] Failed to load file list for ${sourceKey} during source selection:`, e);
              }
            }
            
            if (files && Array.isArray(files)) {
              fileIndex = getSelectedFileIndex(sourceKey, files, currentTrackName, state.selectedFileIndices);
              console.log(`[TrackSources] Torrent ${sourceKey}: found matching file index ${fileIndex} for track "${currentTrackName}" during source selection`);
            }
          }
          
          const minimal = JSON.stringify({
            type: source.type,
            id: source.id,
            infoHash: source.infoHash,
            magnetURI: source.magnetURI,
            playUrl: source.playUrl || source.streamUrl || source.url || null,
            title: source.title,
            fileIndex: fileIndex
          });
          await setSource?.(`selected:${track.id}`, minimal);

          // Start playback using the cache-aware backend entrypoint so the backend will
          // prefer caching, play the .part while downloading and gaplessly hand off to
          // the final cached file when ready.
          // Do not directly start playback here - let the central playback controller
          // react to the source change. Starting playback from two places caused
          // duplicate invocations of `playback_start_with_source` and raced the
          // backend. Instead, emit the internal event and let `playback` effect
          // perform the cache-aware start.
          window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
            detail: { trackId: track.id, source: minimal }
          }));
        } else {
          await setSource?.(`selected:${track.id}`, '');

          // Stop playback by clearing selection; existing playback handlers listen for this event
          window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
            detail: { trackId: track.id, source: null }
          }));
        }
      } catch {
        // Ignore persistence errors
      }
    }
  }, [state.loadingKeys, state.errors, state.selectedSourceKey, state.selectedFileIndices, track?.id, setSetting, handleSourceData, currentTrackName]);

  const handleDownloadSource = useCallback(async (source: any, sourceKey: string) => {
    const currentState = state.downloadStates[sourceKey] || 'idle';
    console.log(`[TrackSources] Download button clicked for ${sourceKey}, current state: ${currentState}`);

    if (currentState === 'downloading') {
      console.log(`[TrackSources] Already downloading ${sourceKey}, ignoring`);
      return; // Already downloading
    }

    // Check if already cached in real-time
    console.log(`[TrackSources] Checking if ${sourceKey} is already cached`);
    const isAlreadyCached = await checkSourceCached(source, sourceKey);
    console.log(`[TrackSources] Cache check result for ${sourceKey}: ${isAlreadyCached}`);
    if (isAlreadyCached) {
      console.log(`[TrackSources] ${sourceKey} is already cached, updating state`);
      // Update state to reflect cached status
      setState(prev => ({
        ...prev,
        downloadStates: { ...prev.downloadStates, [sourceKey]: 'completed' }
      }));
      return;
    }

    console.log(`[TrackSources] ${sourceKey} not cached, starting download`);
    // Not cached, trigger download
    await downloadSource(source, sourceKey);
  }, [state.downloadStates, checkSourceCached, downloadSource]);

  // Check cache status for sources
  useEffect(() => {
    if (!state.sources || !track?.id) {
      console.log('[TrackSources] Skipping cache check - no sources or track ID');
      return;
    }

    console.log(`[TrackSources] Checking cache status for ${state.sources.length} sources`);

    const checkCacheStatus = async () => {
      const cacheChecks = state.sources.map(async (source: any, index: number) => {
        const sourceKey = generateSourceKey(source, index);
        const isCached = await checkSourceCached(source, sourceKey);
        return { sourceKey, isCached };
      });

      const results = await Promise.allSettled(cacheChecks);
      const newDownloadStates: Record<string, 'idle' | 'downloading' | 'completed' | 'error'> = {};

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { sourceKey, isCached } = result.value;
          newDownloadStates[sourceKey] = isCached ? 'completed' : 'idle';
          console.log(`[TrackSources] Cache status for ${sourceKey}: ${isCached ? 'cached' : 'not cached'}`);
        } else {
          console.error(`[TrackSources] Cache check failed for source ${index}:`, result.reason);
        }
      });

      setState(prev => ({
        ...prev,
        downloadStates: { ...prev.downloadStates, ...newDownloadStates }
      }));

      console.log('[TrackSources] Cache status check completed');
    };

    checkCacheStatus();
  }, [state.sources, track?.id, checkSourceCached]);

  const handleToggleFiles = useCallback((source: any, sourceKey: string) => {
    if (state.fileLists[sourceKey]) {
      setState(prev => ({
        ...prev,
        visibleOutputs: {
          ...prev.visibleOutputs,
          [sourceKey]: !prev.visibleOutputs[sourceKey]
        }
      }));
    } else if (!state.loadingKeys[sourceKey]) {
      // Skip loading if source is already cached
      const isCached = state.downloadStates[sourceKey] === 'completed';
      if (isCached) {
        console.log(`[TrackSources] Skipping file loading for cached source ${sourceKey}`);
        setState(prev => ({
          ...prev,
          visibleOutputs: { ...prev.visibleOutputs, [sourceKey]: true },
          errors: { ...prev.errors, [sourceKey]: undefined }
        }));
        return;
      }
      
      // Clear any previous errors and cached failures when retrying
      const fileListCache = cacheManager.getFileListCache();
      const fileListInflight = cacheManager.getFileListInflight();
      const id = source.magnetURI ?? source.infoHash ?? source.id ?? source.url ?? source.path ?? '';

      // Remove failed cache entries to allow retry
      if (state.errors[sourceKey]) {
        fileListCache.delete(sourceKey);
        if (id) {
          fileListInflight.delete(id);
        }
      }

      setState(prev => ({
        ...prev,
        visibleOutputs: { ...prev.visibleOutputs, [sourceKey]: true },
        errors: { ...prev.errors, [sourceKey]: undefined }
      }));
      handleSourceData(source, sourceKey);
    }
  }, [state.fileLists, state.loadingKeys, state.errors, handleSourceData]);

  // Memoized filtered and sorted sources
  const validSources = useMemo(() => {
    if (!state.sources) return [];

    return state.sources.filter((source: any) => {
      const isYoutube = source.type === 'youtube';
      if (isYoutube) return true;

      const seeds = Number(source.seeders ?? source.seeds ?? 0);
      return seeds >= MIN_SEEDS;
    });
  }, [state.sources]);

  // Memoized selected source info
  const selectedSourceInfo = useMemo(() => {
    if (!state.selectedSourceKey || !state.sources) return null;

    const selectedIndex = validSources.findIndex((source: any, index: number) =>
      generateSourceKey(source, index) === state.selectedSourceKey
    );

    if (selectedIndex === -1) return null;

    const selectedSource = validSources[selectedIndex];
    return getSourceTypeInfo(selectedSource);
  }, [state.selectedSourceKey, state.sources, validSources]);

  // Handle file selection for sources with multiple matching files
  const handleFileSelect = useCallback((event: any, sourceKey: string, realFileIndex: number) => {
    event.stopPropagation();
    event.preventDefault();

    setState(prev => ({
      ...prev,
      selectedFileIndices: {
        ...prev.selectedFileIndices,
        [sourceKey]: realFileIndex
      }
    }));
  }, []);

  return (
    <div className={`np-section np-audio-sources ${state.isCollapsed ? 'collapsed' : ''}`} aria-label={t('np.audioSources', 'Audio sources')}>
      <h4 className="np-sec-title">
        {t('np.audioSources', 'Audio sources')}
        <div className='np-sec-right'>
          <div className="np-hint">
            {selectedSourceInfo ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Source selected:&nbsp;
                {selectedSourceInfo.icon && (
                  <img
                    src={selectedSourceInfo.icon}
                    alt={selectedSourceInfo.type}
                    style={{ width: 16, height: 16, objectFit: 'contain' }}
                  />
                )}
                {selectedSourceInfo.type}
              </div>
            ) : (
              t('np.audioSourcesHint', 'Choose a source to stream this track')
            )}
          </div>
          <button className={`btn-icon btn-${state.isCollapsed ? 'show' : 'hide'}`} type="button" onClick={() => {
            setState(prev => ({ ...prev, isCollapsed: !prev.isCollapsed }));
          }} aria-label={t('np.collapseExpand', 'Collapse/Expand section')}>
            <span className="material-symbols-rounded">
              {state.isCollapsed ? 'expand_more' : 'expand_less'}
            </span>
          </button>
        </div>
      </h4>

      {state.sources === undefined && (
        <div className="np-hint">{t('np.loadingSources', 'Loading sources...')}</div>
      )}

      {validSources.length > 0 && (
        <div className="sources-container">
          <ul className="sources-list">
            {validSources.map((source: any, index: number) => {
              const sourceKey = generateSourceKey(source, index);
              const isYoutube = source.type === 'youtube';
              const isSelected = state.selectedSourceKey === sourceKey;
              const isLoading = state.loadingKeys[sourceKey];
              const hasError = state.errors[sourceKey];
              const files = state.fileLists[sourceKey];
              const isVisible = state.visibleOutputs[sourceKey];
              const downloadState = state.downloadStates[sourceKey] || 'idle';
              const isDownloading = downloadState === 'downloading';
              const isDownloaded = downloadState === 'completed';

              const iconSrc = isYoutube ? SOURCE_ICONS.youtube : SOURCE_ICONS.torrent;

              return (
                <li
                  key={sourceKey}
                  className={`source-item ${isSelected ? 'selected' : ''} ${isLoading ? 'loading' : ''} ${hasError ? 'error' : ''}`}
                  aria-pressed={isSelected}
                  aria-label={isSelected ? t('np.selectedSource', 'Selected source') : t('np.selectSource', 'Select this source')}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleSourceSelect(source, sourceKey);
                  }}
                >
                  <div className="source-element">
                    <div className="source-actions">
                      <button className={`ts-select ${isSelected ? 'active' : ''}`}>
                        <span className="material-symbols-rounded">
                          {isSelected ? 'task_alt' : 'radio_button_unchecked'}
                        </span>
                      </button>
                    </div>
                    <div className="source-meta">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {iconSrc && (
                          <img
                            src={iconSrc}
                            alt={isYoutube ? 'YouTube' : 'Torrent'}
                            className="source-icon"
                            style={{ width: 16, height: 16, objectFit: 'contain' }}
                            loading="lazy"
                          />
                        )}
                        <strong title={source.title || source.infoHash}>
                          {source.title || source.infoHash}
                        </strong>
                      </div>
                      <div className="source-sub">
                        {isYoutube ? 'YouTube' : source.source}
                        {isYoutube && (
                          <>
                            {source.duration && <> · {fmtTotalMs(Number(source.duration) * 1000)}</>}
                            {source.uploader && <> · {source.uploader}</>}
                            {source.id && <> · {source.id}</>}
                          </>
                        )}
                        {source.size && <> · {source.size}</>}
                        {!isYoutube && (typeof source.seeders === 'number' || typeof source.seeds === 'number') && (
                          <> · {Number(source.seeders ?? source.seeds ?? 0).toLocaleString()} {t('np.seeders', 'seeds')} · {source.infoHash || <span style={{ opacity: .6 }}>{t('np.unknownHash', 'Unknown info hash')}</span>}</>
                        )}
                      </div>
                    </div>

                    <div className="source-actions">
                      {(source.magnetURI || source.infoHash || isYoutube) && (
                        <>
                          {!isLoading && !(files && source.type !== 'torrent') && (
                            <button
                              type="button"
                              className={`btn-icon ts-files ${hasError ? (hasError.includes('Error') ? 'btn-error' : 'btn-warning') : ''}`}
                              disabled={isLoading && !files}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleFiles(source, sourceKey);
                              }}
                            >
                              {files
                                ? (isVisible ? t('np.hide', 'Hide') : t('np.filesSource', 'Show'))
                                : (hasError || t('np.filesSource', 'Load'))
                              }
                            </button>
                          )}
                          {isLoading && !files && (
                            <div className="loading-dots" aria-label={t('np.loading', 'Loading')}>
                              <span></span><span></span><span></span>
                            </div>
                          )}
                          <button className={`ts-download${isLoading || isDownloading || isDownloaded ? ' disabled' : ''}${ isDownloading ? ' downloading' : isDownloaded ? ' downloaded' : ''}`}
                            aria-label={isDownloaded ? t('np.downloaded', 'Downloaded') : t('np.download', 'Download this source')}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadSource(source, sourceKey);
                            }}
                            disabled={isLoading || isDownloading || isDownloaded}
                          >
                            {isDownloading ? (
                              // Circular progress with percentage in middle
                              (() => {
                                  const prog = state.downloadProgress[sourceKey];
                                  const bytes = prog?.bytes ?? 0;
                                  let total = prog?.total ?? undefined;

                                  // Fallback: estimate total from source metadata or file list
                                  const estimateTotalFromSource = () => {
                                    // If explicit size provided on source (like '3.4 MB'), try to parse
                                    if (source.size && typeof source.size === 'string') {
                                      const m = String(source.size).match(/([0-9.]+)\s*(kb|mb|gb|b)/i);
                                      if (m) {
                                        const n = parseFloat(m[1]);
                                        const unit = m[2].toLowerCase();
                                        if (!isNaN(n)) {
                                          if (unit === 'b') return Math.round(n);
                                          if (unit === 'kb') return Math.round(n * 1024);
                                          if (unit === 'mb') return Math.round(n * 1024 * 1024);
                                          if (unit === 'gb') return Math.round(n * 1024 * 1024 * 1024);
                                        }
                                      }
                                    }

                                    // If files list exists, sum lengths
                                    const fileList = state.fileLists[sourceKey];
                                    if (Array.isArray(fileList) && fileList.length > 0) {
                                      const sum = fileList.reduce((acc, f) => acc + (Number(f.length) || 0), 0);
                                      if (sum > 0) return sum;
                                    }

                                    return undefined;
                                  };

                                  if (total === undefined) {
                                    const est = estimateTotalFromSource();
                                    if (est && est > 0) total = est;
                                  }

                                  const percent = total ? Math.round((bytes / total) * 100) : undefined;

                                  return (
                                    <div className="ts-download-progress">
                                      {percent !== undefined ? `${percent}%` : '...'}
                                    </div>
                                  );
                              })()
                            ) : (
                              <span className="material-symbols-rounded filled">
                                {isDownloaded ? 'download_done' : 'download'}
                              </span>
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  <div className={`source-output ${isVisible && !isLoading && !hasError && source.type == 'torrent' ? 'show' : ''}`}>
                    {isVisible && files && (
                      <div className="source-files">
                        <div style={{ fontSize: 12, opacity: .8,display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          {t('np.sourceFiles', 'Files in source')}
                          {(() => {
                          const allMatchingIndices = findAllMatchingFileIndices(files, currentTrackName);
                          if (allMatchingIndices.length > 1) {
                            const selectedFileIndex = getSelectedFileIndex(sourceKey, files, currentTrackName, state.selectedFileIndices);
                            const selectedFile = selectedFileIndex !== undefined ? files[selectedFileIndex] : null;
                            return (
                              <div>
                                {allMatchingIndices.length} matching files found.
                                {selectedFile && ` Selected: ${selectedFile.name}`}
                              </div>
                            );
                          }
                          return null;
                        })()}
                        </div>
                        <ul style={{ margin: 6, paddingLeft: 0 }}>
                          {(() => {
                            // Filter to show only audio files when available, otherwise show all files
                            const audioFiles = files.filter(f => AUDIO_EXTENSIONS.test(f.name));
                            const displayFiles = audioFiles.length > 0 ? audioFiles : files;
                            
                            // Find all matching files and check if user can select
                            const allMatchingIndices = findAllMatchingFileIndices(files, currentTrackName);
                            const canSelectFiles = allMatchingIndices.length > 1;
                            
                            // Get currently selected file index
                            const selectedFileIndex = getSelectedFileIndex(sourceKey, files, currentTrackName, state.selectedFileIndices);
                            
                            // Create mappings between display and real indices
                            const displayToRealIndex = new Map<number, number>();
                            displayFiles
                              .map((file, idx) => ({ file, realIndex: files.indexOf(file), displayIndex: idx }))
                              .sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: 'base' }))
                              .forEach(({ realIndex }, sortedDisplayIndex) => {
                                displayToRealIndex.set(sortedDisplayIndex, realIndex);
                              });

                            return displayFiles
                              .slice()
                              .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
                              .map((file, displayIndex) => {
                                const realIndex = displayToRealIndex.get(displayIndex);
                                const normTrack = normalizeText(currentTrackName);
                                const normFile = normalizeText(file.name);
                                const isCurrent = normTrack && normFile.includes(normTrack);
                                const isSelected = realIndex === selectedFileIndex;
                                const isClickable = canSelectFiles && isCurrent;

                                return (
                                  <li
                                    key={`${realIndex}-${displayIndex}`}
                                    className={`track-file ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''} ${isClickable ? 'clickable' : ''}`}
                                    onClick={isClickable && realIndex !== undefined ? (e) => handleFileSelect(e,sourceKey, realIndex) : undefined}
                                    title={isClickable ? 'Click to select this file for playback/download' : undefined}
                                  >
                                    {canSelectFiles && isCurrent && (
                                      <span className="material-symbols-rounded" style={{ fontSize: 14, marginRight: 4 }}>
                                        {isSelected ? 'radio_button_checked' : 'radio_button_unchecked'}
                                      </span>
                                    )}
                                    {file.name}
                                    <span style={{ opacity: .6 }}>
                                      · {Math.round((file.length || 0) / 1024 / 1024)} MB
                                    </span>
                                  </li>
                                );
                              });
                          })()}
                        </ul>
                      </div>
                    )}

                    {((isLoading && !isVisible) || hasError) && (
                      <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
                        {isLoading ? t('np.loading', 'Loading') : hasError}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {Array.isArray(state.sources) && state.sources.length === 0 && (
        <div className="np-hint">
          {state.loadError || t('np.noSources', 'No sources found')}
        </div>
      )}
    </div>
  );
}
