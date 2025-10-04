import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { frontendLogger } from '../../core/FrontendLogger';
import { useI18n } from '../../core/i18n';
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../../core/SpotifyClient';
import { runTauriCommand } from '../../core/TauriCommands';
import * as audioCache from '../../core/audioCache';
import { useDB } from '../../core/Database';
import * as tc from '../../core/TorrentClient';
import { fmtTotalMs, parseByteSizeString, formatBytes } from './Helpers';

// Dev logging guard
const __DEV__ = process.env.NODE_ENV !== 'production';

// ===== CONSTANTS =====
const DEFAULT_TIMEOUT = 10000;
const MAX_SOURCES = 50;
const CONCURRENCY_LIMIT = 2;
const MIN_SEEDS = 1;
const AUTO_FETCH_LIMIT = 5;
const AUDIO_EXTENSIONS = /\.(mp3|m4a|flac|wav|ogg|aac|opus|webm)$/i;

const SOURCE_ICONS = {
  youtube: 'https://icons.getbootstrap.com/assets/icons/youtube.svg',
  torrent: 'https://icons.getbootstrap.com/assets/icons/magnet-fill.svg',
  http: 'https://icons.getbootstrap.com/assets/icons/globe2.svg',
  local: 'https://icons.getbootstrap.com/assets/icons/folder-fill.svg'
} as const;

// Paint external SVGs with the theme text color using a reusable CSS class and CSS var
const ThemedSvgIcon: React.FC<{
  src: string;
  alt?: string;
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
}> = ({ src, alt, size = 16, className, style }) => {
  const px = typeof size === 'number' ? `${size}px` : size;
  const styleObj: React.CSSProperties & { [key: string]: any } = {
    width: px,
    height: px,
    // Pass the URL through a CSS custom property consumed by the class
    ['--icon-url']: `url(${src})`,
    ...style,
  };
  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt}
      className={`${className ? className + ' ' : ''}icon-themed`}
      style={styleObj}
    />
  );
};

// Common inline styles hoisted to constants to avoid per-render allocations
const H5_HEADER_STYLE: React.CSSProperties = { margin: '0 5px', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px' };
const FILES_BAR_STYLE: React.CSSProperties = { fontSize: 12, opacity: .8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const FILES_UL_STYLE: React.CSSProperties = { margin: 6, paddingLeft: 0 };
const RADIO_ICON_STYLE: React.CSSProperties = { fontSize: 14, marginRight: 4 };

// ===== UTILITY FUNCTIONS =====
const generateCacheKey = (title: string, artist: string, year?: string): string =>
  `${title || ''}::${artist || ''}::${year || ''}`;

const generateSourceKey = (source: any, index: number): string =>
  source.infoHash ?? source.magnetURI ?? source.id ?? source.url ?? String(index);

const normalizeText = (text: string): string =>
  text.toLowerCase()
    .replace(/\s+|_+|-+/g, ' ')
    .replace(/[\p{P}\p{S}]/gu, '')
    .trim();

const getSourceTypeInfo = (source: any) => {
  if (source?.type === 'youtube') return { type: 'YouTube', icon: SOURCE_ICONS.youtube };
  if (source?.infoHash || source?.magnetURI) return { type: 'Torrent', icon: SOURCE_ICONS.torrent };
  if (source?.url?.startsWith('http')) return { type: 'HTTP', icon: SOURCE_ICONS.http };
  if (source?.path || source?.file) return { type: 'Local File', icon: SOURCE_ICONS.local };
  return { type: 'Unknown', icon: null };
};

const isValidSource = (source: any): boolean => {
  if (source?.type === 'youtube') return true;
  const seeds = Number(source?.seeders ?? source?.seeds ?? 0);
  return seeds >= MIN_SEEDS;
};

// Using shared parseByteSizeString from Helpers

// ===== CACHE MANAGEMENT =====
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

  cleanup() {
    this.searchCache.clear();
    this.searchInflight.clear();
    this.fileListCache.clear();
    this.fileListInflight.clear();
    this.downloadInflight.clear();
    this.cachedFileCache.clear();
    this.cachedFileInflight.clear();
  }
}

const cacheManager = CacheManager.getInstance();

// Cache formatted size per source object to avoid repeated parse/format work
const sizeFormatCache = new WeakMap<object, string>();

// ===== FILE MATCHING UTILITIES =====
const findMatchingFileIndices = (files: any[], trackName: string): { all: number[], audio: number[], first?: number } => {
  if (!files?.length || !trackName) return { all: [], audio: [] };

  const normTrack = normalizeText(trackName);
  const audioMatches: number[] = [];
  const allMatches: number[] = [];

  files.forEach((file, i) => {
    const fileName = file?.name || '';
    const normFile = normalizeText(fileName);

    if (normFile.includes(normTrack)) {
      allMatches.push(i);
      if (AUDIO_EXTENSIONS.test(fileName)) {
        audioMatches.push(i);
      }
    }
  });

  const preferredMatches = audioMatches.length > 0 ? audioMatches : allMatches;
  return {
    all: allMatches,
    audio: audioMatches,
    first: preferredMatches[0]
  };
};

// Simplified versions for backwards compatibility
const findMatchingFileIndex = (files: any[], trackName: string): number | undefined =>
  findMatchingFileIndices(files, trackName).first;

const findAllMatchingFileIndices = (files: any[], trackName: string): number[] =>
  findMatchingFileIndices(files, trackName).all;

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
  showed: string | false; // false = all collapsed, string = only that type is shown
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
  showed: false, // Start with all types collapsed
  downloadStates: {},
  downloadProgress: {}
};

export default function TrackSources({ track, album, primaryArtist }: {
  track?: SpotifyTrack;
  album?: SpotifyAlbum;
  primaryArtist?: SpotifyArtist;
}) {
  const { t } = useI18n();
  const { getTrack, selectTrackSource, setTrackSources } = useDB();
  const [state, setState] = useState<SourceState>(initialState);
  // Local file selection state (separate from torrent/youtube lists)
  const [localPath, setLocalPath] = useState<string | undefined>(undefined);
  const [localSelected, setLocalSelected] = useState<boolean>(false);
  // ===== REFS AND MEMOIZED VALUES =====
  const fetchedQueriesRef = useRef<Record<string, boolean>>({});
  const sourcesRef = useRef<any[] | undefined>(state.sources);

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

  // ===== MEMOIZED COMPUTED VALUES =====
  const validSources = useMemo(() =>
    state.sources?.filter(isValidSource) ?? [],
    [state.sources]
  );

  const { youtubeSources, torrentSources } = useMemo(() => ({
    youtubeSources: validSources.filter(s => s.type === 'youtube'),
    torrentSources: validSources.filter(s => s.type !== 'youtube')
  }), [validSources]);

  const selectedSourceInfo = useMemo(() => {
    if (localSelected) return { type: 'Local File', icon: SOURCE_ICONS.local } as any;
    if (!state.selectedSourceKey || !validSources.length) return null;
    const selectedIndex = validSources.findIndex((source, index) =>
      generateSourceKey(source, index) === state.selectedSourceKey
    );
    return selectedIndex !== -1 ? getSourceTypeInfo(validSources[selectedIndex]) : null;
  }, [state.selectedSourceKey, validSources, localSelected]);

  // ===== STATE UPDATE HELPERS =====
  const updateSourceState = useCallback((updates: Partial<SourceState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);

  const updateDownloadState = useCallback((sourceKey: string, downloadState: SourceState['downloadStates'][string], progress?: SourceState['downloadProgress'][string]) => {
    setState(prev => ({
      ...prev,
      downloadStates: { ...prev.downloadStates, [sourceKey]: downloadState },
      downloadProgress: progress !== undefined ? { ...prev.downloadProgress, [sourceKey]: progress } : prev.downloadProgress
    }));
  }, []);

  const updateSourceError = useCallback((sourceKey: string, error?: string, loading?: boolean) => {
    setState(prev => ({
      ...prev,
      errors: { ...prev.errors, [sourceKey]: error },
      loadingKeys: loading !== undefined ? { ...prev.loadingKeys, [sourceKey]: loading } : prev.loadingKeys
    }));
  }, []);

  // Load existing local file (if any) from DB when track changes; do not require it to be selected
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!track?.id || !getTrack) { setLocalPath(undefined); return; }
      try {
        const rec = await getTrack(track.id);
        const sources = (rec?.sources || []) as any[];
        const local = sources.find(s => s?.type === 'local');
        if (!cancelled) {
          setLocalPath(local?.file_path || local?.url || '');
          setLocalSelected(Boolean(local?.selected));
        }
      } catch {
        if (!cancelled) setLocalPath(undefined);
      }
    })();
    return () => { cancelled = true; };
  }, [track?.id, getTrack]);

  // Choose a local file and upsert into sources list without changing selection
  const pickLocalFile = useCallback(async () => {
    if (!track?.id) return;
    try {
      // Ask backend to open the native file dialog and return the chosen path
      const filePath = await runTauriCommand<string>('open_audio_file_dialog');
      if (!filePath || typeof filePath !== 'string') return;
      setLocalPath(filePath);
      // Merge into existing sources without selecting by default
      try {
        const rec = await getTrack(track.id);
        const prev = (rec?.sources || []) as any[];
        let next = prev.map(s => ({ ...s }));
        const idx = next.findIndex(s => s?.type === 'local');
        const updated = { type: 'local', url: filePath, file_path: filePath, title: 'Local file', selected: Boolean(idx >= 0 && next[idx]?.selected) } as any;
        if (idx >= 0) next[idx] = { ...next[idx], ...updated };
        else next.push(updated);
        await setTrackSources?.(track.id, next);

        // Auto-select the local source after successful pick and DB update
        const toSelect = { type: 'local', url: filePath, file_path: filePath, title: 'Local file', selected: true } as any;
        await selectTrackSource?.(track.id, toSelect);
        setLocalSelected(true);
        setState(prev => ({ ...prev, selectedSourceKey: undefined }));
        window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
          detail: { trackId: track.id, source: { type: 'local', url: filePath, file_path: filePath } }
        }));
      } catch (e) {
        frontendLogger.warn('Failed to upsert local source in DB:', e);
      }
    } catch (e) {
      frontendLogger.error('Failed to select local file:', e);
    }
  }, [track?.id, getTrack, setTrackSources, selectTrackSource]);

  // Clear local file from the sources list (and selection if it was selected)
  const clearLocalFile = useCallback(async () => {
    if (!track?.id) return;
    try {
      setLocalPath(undefined);
      const rec = await getTrack(track.id);
      const prev = (rec?.sources || []) as any[];
      const wasSelected = Boolean(prev.find(s => s?.type === 'local' && s?.selected));
      const next = prev.filter(s => s?.type !== 'local');
      await setTrackSources?.(track.id, next);
      setLocalSelected(false);
      if (wasSelected) {
        await selectTrackSource?.(track.id, null);
        window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
          detail: { trackId: track.id, source: null }
        }));
      }
    } catch (e) {
      frontendLogger.warn('Failed to clear local file selection:', e);
    }
  }, [track?.id, getTrack, setTrackSources, selectTrackSource]);

  // ===== INFO PROCESSING HELPERS =====
  const processInfoTemplate = useCallback((template: string, source: any) => {
    // Helper: format size consistently using formatBytes when possible
    const formatSourceSize = () => {
      if (source && typeof source === 'object') {
        const cached = sizeFormatCache.get(source);
        if (cached !== undefined) return cached;
      }
      const raw = source?.size;
      const parsed = typeof raw === 'number' ? raw : parseByteSizeString(raw);
      const out = (typeof parsed === 'number' && !isNaN(parsed)) ? formatBytes(parsed) : (raw || '');
      if (source && typeof source === 'object') sizeFormatCache.set(source, out);
      return out;
    };
    // Handle special t(key,placeholder) pattern
    if (template.startsWith('t(') && template.includes(',{') && template.endsWith(')')) {
      const match = template.match(/^t\(([^,]+),\{([^}]+)\}\)$/);
      if (match) {
        const [, localeKey, placeholder] = match;
        let value: any = '';
        let count: number | undefined = undefined;

        switch (placeholder) {
          case 'seeders':
            if (typeof source.seeders === 'number' || typeof source.seeds === 'number') {
              const seedersCount = Number(source.seeders ?? source.seeds ?? 0);
              value = seedersCount.toLocaleString();
              count = seedersCount;
            } else return null;
            break;
          case 'time':
            value = source.duration ? fmtTotalMs(Number(source.duration) * 1000) : '';
            break;
          case 'uploader':
            value = source.uploader || '';
            break;
          case 'id':
            value = source.id || '';
            break;
          case 'source':
            value = source.source || '';
            break;
          case 'size':
            value = formatSourceSize();
            break;
        }

        if (value) {
          const translatedText = count !== undefined
            ? t(localeKey, undefined, { count })
            : t(localeKey, undefined, { value });
          return translatedText;
        }
        return null;
      }
    }

    // Handle regular template substitution
    const formattedSize = formatSourceSize();
    return template
      .replace('{time}', source.duration ? fmtTotalMs(Number(source.duration) * 1000) : '')
      .replace('{uploader}', source.uploader || '')
      .replace('{id}', source.id || '')
      .replace('{source}', source.source || '')
      .replace('{size}', formattedSize)
      .replace('{seeders}', (typeof source.seeders === 'number' || typeof source.seeds === 'number') ?
        Number(source.seeders ?? source.seeds ?? 0).toLocaleString() : '');
  }, [t]);

  // ===== EFFECTS =====
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
      frontendLogger.debug('[TrackSources] Unmatched cache event payload (could not map to source):', payload, sourcesRef.current?.map((s, i) => ({ key: generateSourceKey(s, i), id: s.id, infoHash: s.infoHash, playUrl: s.playUrl, streamUrl: s.streamUrl })));
    } catch { /* ignore */ }
    return undefined;
  }, []);

  // Estimate total bytes for a source using metadata or file list
  const estimateTotalBytesForSource = useCallback((source: any, sourceKey: string) => {
    if (!source) return undefined;
    // If explicit size provided on source (like '3.4 MB'), try to parse
    const parsed = parseByteSizeString(source.size);
    if (parsed) return parsed;

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
        frontendLogger.debug('[TrackSources] Tauri event API not available', e);
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

        // Persisted DB cache removed: rely on in-memory cache only

        // Check cache first
        if (searchCache.has(cacheKey)) {
          results = searchCache.get(cacheKey) || [];
        } else {
          // Check for inflight request
          let promise = searchInflight.get(cacheKey);
          if (!promise) {
            promise = (async () => {
              const youtubeTitle = track?.name || title;
              const youtubePayload = { title: youtubeTitle, artist, type: 'youtube' };

              // Use new Tauri scrapers for torrent search across all providers
              const [torrentResp, youtubeResp] = await Promise.allSettled([
                runTauriCommand('torrent_search', { payload: { query } }),
                runTauriCommand('source_search', { payload: youtubePayload })
              ]);

              const rawTorrent = torrentResp.status === 'fulfilled'
                ? (Array.isArray(torrentResp.value) ? torrentResp.value : (torrentResp.value?.results ?? torrentResp.value?.items ?? []))
                : [];

              // Normalize torrent results so downstream logic works with all providers
              const torrentResults = (rawTorrent as any[]).map((r: any) => {
                const out: any = { ...r };
                out.type = 'torrent';
                // map provider -> source (for UI info labels)
                if (r.provider && !r.source) out.source = r.provider;
                // unify magnet field
                if (!r.magnetURI && r.magnet) out.magnetURI = r.magnet;
                // best-effort infoHash extraction
                if (!out.infoHash && typeof out.magnetURI === 'string') {
                  const m = out.magnetURI.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
                  if (m?.[1]) out.infoHash = m[1].toLowerCase();
                }
                return out;
              });

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

              // Prefer immediate playable sources first (YouTube), then torrents
              const combined = [...youtubeResults, ...torrentResults];
              searchCache.set(cacheKey, combined);
              searchInflight.delete(cacheKey);
              // No DB persistence in new implementation
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
                  frontendLogger.error(`Failed to check cache for source ${sourceKey}:`, e);
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

          // Restore previously selected source using new tracks store
          if (track?.id && getTrack) {
            try {
              const rec = await getTrack(track.id);
              const selected = (rec?.sources || []).find((s: any) => s?.selected);
              if (selected) {
                if (selected.type === 'local') {
                  setLocalSelected(true);
                } else {
                  const match = subset.find(s =>
                    (selected.hash && (s.infoHash === selected.hash || s.id === selected.hash)) ||
                    (selected.url && (s.magnetURI === selected.url || s.url === selected.url || s.playUrl === selected.url))
                  );
                  if (match) {
                    const idx = subset.indexOf(match);
                    const key = generateSourceKey(match, idx);
                    setState(prev => ({ ...prev, selectedSourceKey: key }));
                  }
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
        frontendLogger.error('TrackSources: load error', err);
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
  }, [track?.id, cacheKey, searchParams]);

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
                const response = await runTauriCommand<any>('youtube_get_info', {
                  payload: { id: source.id }
                });

                // Backend returns { status: "ok", data: info }
                const info = response?.data || response;

                // Check for unavailable video error
                if (info?.success === false && info?.reason === 'unavailable') {
                  throw new Error('Video is unavailable');
                }

                // Get stream URL - first try to get it directly from the info, 
                // if not available, call the stream URL command
                let streamUrl = info?.url || null;
                if (!streamUrl) {
                  try {
                    const streamResponse = await runTauriCommand<any>('youtube_get_stream_url', { id: source.id });
                    streamUrl = streamResponse?.data?.url || streamResponse?.url || null;
                  } catch (streamError) {
                    frontendLogger.warn(`Failed to get YouTube stream URL for ${source.id}:`, streamError);
                  }
                }

                if (streamUrl) {
                  source.streamUrl = streamUrl;
                  source.playUrl = streamUrl;
                }
                const estBytes = info?.filesize || info?.filesize_approx || 0;
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
                  frontendLogger.warn(`[TrackSources] YouTube video ${source.id} is unavailable, skipping`);
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
              const files = await tc.getTorrentFileList(id, { timeout_ms: DEFAULT_TIMEOUT });
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
      frontendLogger.error('TrackSources: full error details', {
        originalError: e,
        fullMessage: msg,
        messageLength: msg.length,
        source: source?.infoHash || source?.magnetURI || source?.id || 'unknown'
      });

      // Clean up malformed error messages
      if (msg.startsWith('ERR: ') && msg.length > 50 && !msg.includes(' ')) {
        // This looks like a malformed concatenated error - provide a generic message
        frontendLogger.warn('TrackSources: sanitizing long error message:', msg);
        msg = 'Failed to load torrent files';
      }

      frontendLogger.error('TrackSources: file list error', msg);

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
              if (__DEV__) frontendLogger.log(`[TrackSources] Skipping file loading for cached source ${key}`);
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

  if (__DEV__) frontendLogger.log(`[TrackSources] Auto-fetching ${candidates.length} priority sources`);
    batchProcess();
  }, [state.sources, state.lastQuery, state.fileLists, state.loadingKeys, handleSourceData]);

  // Check if source is cached
  const checkSourceCached = useCallback(async (source: any, sourceKey: string) => {
    if (!track?.id) return false;

    try {
      const sourceType = source.type === 'youtube' ? 'youtube' : 'torrent';
      const sourceHash = source.id || source.infoHash || source.magnetURI || source.url || '';

      if (!sourceHash) {
  if (__DEV__) frontendLogger.log(`[TrackSources] No source hash for ${sourceKey}`);
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
              if (__DEV__) frontendLogger.log(`[TrackSources] File list not loaded for ${sourceKey}, loading before cache check`);
              try {
                files = await handleSourceData(source, generateSourceKey(source, state.sources.indexOf(source)));
              } catch (e) {
                frontendLogger.warn(`[TrackSources] Failed to load file list for cache check:`, e);
                files = [];
              }
            }

            if (files.length > 0) {
              const targetFileIndex = files.findIndex((file: any) => file.name && AUDIO_EXTENSIONS.test(file.name));
              if (targetFileIndex !== -1) {
                fileIndex = targetFileIndex;
                if (__DEV__) frontendLogger.log(`[TrackSources] Cache check using file_index: ${fileIndex} for ${sourceKey}`);
              }
            }
          }

          if (__DEV__) frontendLogger.log(`[TrackSources] Checking cache with params:`, {
            trackId: track.id,
            sourceType,
            sourceHash: sourceHash.substring(0, 16) + '...',
            fileIndex
          });

          const result = await runTauriCommand('cache_get_file', {
            trackId: track.id,
            sourceType: sourceType,
            sourceHash: sourceHash,
            ...(fileIndex !== undefined && { fileIndex: fileIndex })
          });
          if (__DEV__) frontendLogger.log(`[TrackSources] Cache check result for ${sourceKey}:`, result);
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
      frontendLogger.error('Failed to check cache status:', e);
      return false;
    }
  }, [track?.id]);

  // Download source to cache
  const downloadSource = useCallback(async (source: any, sourceKey: string) => {
    if (!track?.id) return;

  if (__DEV__) frontendLogger.log(`[TrackSources] Starting download for ${sourceKey}`);

    setState(prev => ({
      ...prev,
      downloadStates: { ...prev.downloadStates, [sourceKey]: 'downloading' }
    }));

    try {
      const sourceType: 'youtube' | 'torrent' = source.type === 'youtube' ? 'youtube' : 'torrent';
      let sourceHash = sourceType === 'torrent'
        ? (source.magnetURI || source.infoHash || source.id || '')
        : (source.id || source.infoHash || source.magnetURI || source.url || '');

      if (sourceType === 'torrent' && typeof sourceHash === 'string' && sourceHash.startsWith('magnet:')) {
        const match = sourceHash.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
        if (match?.[1]) sourceHash = match[1].toLowerCase();
      }

      if (!sourceHash) throw new Error('No source identifier available');

      let downloadUrl: string | undefined = source.playUrl || source.streamUrl || source.url;
      if (sourceType === 'torrent') downloadUrl = source.magnetURI || String(sourceHash);

      if (source.type === 'youtube' && source.id && !downloadUrl) {
        if (!source.streamUrl && !source.playUrl) await handleSourceData(source, sourceKey);
        downloadUrl = source.streamUrl || source.playUrl;
        if (!downloadUrl) throw new Error('Failed to get YouTube stream URL');
      }

      if (!downloadUrl) throw new Error('No download URL available');

      const downloadMap = cacheManager.getDownloadInflight();
      if (downloadMap.has(sourceKey)) {
        try { await downloadMap.get(sourceKey); } catch { /* ignore */ }
        return;
      }

      const p = (async () => {
        try {
          let fileIndex: number | undefined;
          if (sourceType === 'torrent') {
            let files = state.fileLists[sourceKey];
            if (!files || files.length === 0) {
              try { files = await handleSourceData(source, sourceKey); } catch { files = []; }
            }
            if (files && files.length > 0) {
              fileIndex = getSelectedFileIndex(sourceKey, files, currentTrackName, state.selectedFileIndices);
              if (fileIndex !== undefined) {
                try {
                  const cacheResult = await runTauriCommand('cache_get_file', {
                    trackId: track.id,
                    sourceType: sourceType,
                    sourceHash: sourceHash,
                    fileIndex: fileIndex
                  });
                  if (cacheResult?.exists) {
                    setState(prev => ({ ...prev, downloadStates: { ...prev.downloadStates, [sourceKey]: 'completed' } }));
                    return;
                  }
                } catch { /* ignore */ }
              }
            }
          }

          await audioCache.downloadAndCache(track.id, sourceType, sourceHash, downloadUrl!, fileIndex);

          const totalTimeoutMs = 90_000;
          const startTs = Date.now();
          while (Date.now() - startTs < totalTimeoutMs) {
            const elapsed = Date.now() - startTs;
            const interval = elapsed < 5000 ? 250 : (elapsed < 15000 ? 500 : 1000);
            await new Promise(r => setTimeout(r, interval));

            try {
              let status: any = null;
              try {
                status = await runTauriCommand('cache_download_status', {
                  trackId: track.id,
                  sourceType: sourceType,
                  sourceHash: sourceHash,
                  fileIndex: fileIndex
                });
              } catch { /* optional */ }

              if (status?.inflight) {
                setState(prev => ({
                  ...prev,
                  downloadProgress: { ...prev.downloadProgress, [sourceKey]: { bytes: status.bytes_downloaded || 0, total: status.total_bytes || undefined } }
                }));
                if (status.completed) {
                  setState(prev => ({ ...prev, downloadStates: { ...prev.downloadStates, [sourceKey]: 'completed' }, downloadProgress: { ...prev.downloadProgress, [sourceKey]: undefined } }));
                  return;
                }
              }

              let isNowCached = false;
              try {
                if (sourceType === 'torrent' && fileIndex !== undefined) {
                  const cacheResult = await runTauriCommand('cache_get_file', {
                    trackId: track.id,
                    sourceType: sourceType,
                    sourceHash: sourceHash,
                    fileIndex: fileIndex
                  });
                  isNowCached = cacheResult?.exists === true;
                } else {
                  isNowCached = await checkSourceCached(source, sourceKey);
                }
              } catch {
                isNowCached = await checkSourceCached(source, sourceKey);
              }
              if (isNowCached) {
                setState(prev => ({ ...prev, downloadStates: { ...prev.downloadStates, [sourceKey]: 'completed' }, downloadProgress: { ...prev.downloadProgress, [sourceKey]: undefined } }));
                return;
              }
            } catch { /* continue polling */ }
          }

          setState(prev => ({ ...prev, downloadStates: { ...prev.downloadStates, [sourceKey]: 'error' } }));
        } finally {
          cacheManager.getDownloadInflight().delete(sourceKey);
        }
      })();

      downloadMap.set(sourceKey, p);
      p.catch(e => frontendLogger.error(`[TrackSources] download promise error for ${sourceKey}:`, e));
    } catch (e) {
      frontendLogger.error(`[TrackSources] Download failed for ${sourceKey}:`, e);
      setState(prev => ({ ...prev, downloadStates: { ...prev.downloadStates, [sourceKey]: 'error' } }));
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
          frontendLogger.warn(`[TrackSources] Cannot select unavailable YouTube video ${source.id}`);
          alert(`This YouTube video is unavailable and cannot be played. It may be private, deleted, or region-restricted.`);
          return;
        }

        // For other errors, still allow selection but show the error
        frontendLogger.error('Failed to load source data:', loadError);
      }
    }

    // Source is loaded, proceed with selection
    const isCurrentlySelected = state.selectedSourceKey === sourceKey;
    const newKey = isCurrentlySelected ? undefined : sourceKey;

    setState(prev => ({ ...prev, selectedSourceKey: newKey }));

    // Persist selection in DB (ensure only one selected)
    if (track?.id) {
      try {
        if (newKey) {
          // For torrents, find the matching file index
          let fileIndex: number | undefined = undefined;
          if (source.type === 'torrent') {
            let files = state.fileLists[sourceKey];

            // If file list is not loaded, load it now
            if (!files || !Array.isArray(files) || files.length === 0) {
              if (__DEV__) frontendLogger.log(`[TrackSources] File list not loaded for ${sourceKey} during source selection, loading now...`);
              try {
                files = await handleSourceData(source, sourceKey);
                if (__DEV__) frontendLogger.log(`[TrackSources] Loaded ${files?.length || 0} files for ${sourceKey} during source selection`);
              } catch (e) {
                frontendLogger.warn(`[TrackSources] Failed to load file list for ${sourceKey} during source selection:`, e);
              }
            }

            if (files && Array.isArray(files)) {
              fileIndex = getSelectedFileIndex(sourceKey, files, currentTrackName, state.selectedFileIndices);
              if (__DEV__) frontendLogger.log(`[TrackSources] Torrent ${sourceKey}: found matching file index ${fileIndex} for track "${currentTrackName}" during source selection`);
            }
          }

          // Build TrackSource shape
          let hash: string | null = null;
          let url: string | null = null;
          if (source.type === 'youtube') {
            hash = source.id || null;
            url = (source.playUrl || source.streamUrl || source.url || null) as any;
          } else if (source.type === 'torrent') {
            hash = source.infoHash || null;
            if (!hash && typeof source.magnetURI === 'string') {
              const m = source.magnetURI.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
              if (m) hash = m[1].toLowerCase();
            }
            url = (source.magnetURI || source.url || null) as any;
          } else if (source.type === 'http') {
            url = (source.playUrl || source.url || null) as any;
          }

          const minimalObj: any = {
            type: source.type,
            hash,
            url,
            title: source.title || null,
            file_index: fileIndex ?? null,
            selected: true,
          };
          await selectTrackSource?.(track.id, minimalObj);
          // Make sure local visual selection is cleared
          setLocalSelected(false);

          // Start playback using the cache-aware backend entrypoint so the backend will
          // prefer caching, play the .part while downloading and gaplessly hand off to
          // the final cached file when ready.
          // Do not directly start playback here - let the central playback controller
          // react to the source change. Starting playback from two places caused
          // duplicate invocations of `playback_start_with_source` and raced the
          // backend. Instead, emit the internal event and let `playback` effect
          // perform the cache-aware start.
          window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
            detail: { trackId: track.id, source: minimalObj }
          }));
        } else {
          await selectTrackSource?.(track.id, null);

          // Stop playback by clearing selection; existing playback handlers listen for this event
          window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
            detail: { trackId: track.id, source: null }
          }));
        }
      } catch {
        // Ignore persistence errors
      }
    }
  }, [state.loadingKeys, state.errors, state.selectedSourceKey, state.selectedFileIndices, track?.id, handleSourceData, currentTrackName, selectTrackSource]);

  const handleDownloadSource = useCallback(async (source: any, sourceKey: string) => {
    const currentState = state.downloadStates[sourceKey] || 'idle';
  if (__DEV__) frontendLogger.log(`[TrackSources] Download button clicked for ${sourceKey}, current state: ${currentState}`);

    if (currentState === 'downloading') {
  if (__DEV__) frontendLogger.log(`[TrackSources] Already downloading ${sourceKey}, ignoring`);
      return; // Already downloading
    }

    // Check if already cached in real-time
  if (__DEV__) frontendLogger.log(`[TrackSources] Checking if ${sourceKey} is already cached`);
    const isAlreadyCached = await checkSourceCached(source, sourceKey);
  if (__DEV__) frontendLogger.log(`[TrackSources] Cache check result for ${sourceKey}: ${isAlreadyCached}`);
    if (isAlreadyCached) {
  if (__DEV__) frontendLogger.log(`[TrackSources] ${sourceKey} is already cached, updating state`);
      // Update state to reflect cached status
      setState(prev => ({
        ...prev,
        downloadStates: { ...prev.downloadStates, [sourceKey]: 'completed' }
      }));
      return;
    }

  if (__DEV__) frontendLogger.log(`[TrackSources] ${sourceKey} not cached, starting download`);
    // Not cached, trigger download
    await downloadSource(source, sourceKey);
  }, [state.downloadStates, checkSourceCached, downloadSource]);

  // Check cache status for sources
  useEffect(() => {
    if (!state.sources || !track?.id) {
  if (__DEV__) frontendLogger.log('[TrackSources] Skipping cache check - no sources or track ID');
      return;
    }

  if (__DEV__) frontendLogger.log(`[TrackSources] Checking cache status for ${state.sources.length} sources`);

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
          if (__DEV__) frontendLogger.log(`[TrackSources] Cache status for ${sourceKey}: ${isCached ? 'cached' : 'not cached'}`);
        } else {
          frontendLogger.error(`[TrackSources] Cache check failed for source ${index}:`, result.reason);
        }
      });

      setState(prev => ({
        ...prev,
        downloadStates: { ...prev.downloadStates, ...newDownloadStates }
      }));

  if (__DEV__) frontendLogger.log('[TrackSources] Cache status check completed');
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
  if (__DEV__) frontendLogger.log(`[TrackSources] Skipping file loading for cached source ${sourceKey}`);
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

  // Function to render a complete sources section for a specific type
  const renderSourcesList = useCallback(({ title, type, sources, icon, info, showFiles = false }: {
    title: string;
    type: string;
    sources: any[];
    icon: string;
    info?: string[];
    showFiles?: boolean;
  }) => {
    const isCollapsed = state.showed !== type;
    const listClassName = `sources-list source-${type}`;

    return (
      <div className={`source-section ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="source-section-header" onClick={() => {
          setState(prev => ({
            ...prev,
            showed: prev.showed === type ? false : type
          }));
        }}
          aria-label={t('np.collapseExpand', `Collapse/Expand ${title} sources`)}
          role="button">
          <h5 style={H5_HEADER_STYLE}>
            {icon && (
              <ThemedSvgIcon
                src={icon}
                alt={title}
                className="source-icon"
                size={16}
              />
            )} {title} ({sources.length})
          </h5>
          <span className="material-symbols-rounded">
            {isCollapsed ? 'expand_more' : 'expand_less'}
          </span>
        </div>
        <ul className={`${listClassName} ${isCollapsed ? 'collapsed' : 'expanded'}`}>
          {sources.length === 0 ? (
            <li className="source-item info">
              <div className="source-element">
                <div className="source-meta">
                  <div className="source-sub">
                    {state.sources === undefined
                      ? t('np.loading', 'Loading')
                      : (state.loadError || t('np.noSources', `No ${title} sources`))}
                  </div>
                </div>
              </div>
            </li>
          ) : sources.map((source: any, index: number) => {
            const sourceKey = generateSourceKey(source, index);
            const isSelected = state.selectedSourceKey === sourceKey;
            const isLoading = state.loadingKeys[sourceKey];
            const hasError = state.errors[sourceKey];
            const files = state.fileLists[sourceKey];
            const isVisible = state.visibleOutputs[sourceKey];
            const downloadState = state.downloadStates[sourceKey] || 'idle';
            const isDownloading = downloadState === 'downloading';
            const isDownloaded = downloadState === 'completed';

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
                    <button className={`btn-borderless ts-select ${isSelected ? 'active' : ''}`}>
                      <span className="material-symbols-rounded">
                        {isSelected ? 'task_alt' : 'radio_button_unchecked'}
                      </span>
                    </button>
                  </div>
                  <div className="source-meta">
                    <div>
                      <strong title={source.title || source.infoHash}>
                        {source.title || source.infoHash}
                      </strong>
                    </div>
                    <div className="source-sub">
                      {info && info.map((infoTemplate, idx) => {
                        // Handle special infoHash case (needs React element)
                        if (infoTemplate === '{infoHash}') {
                          const infoHashValue = source.infoHash || (
                            <span style={{ opacity: .6 }}>{t('np.unknownHash', 'Unknown info hash')}</span>
                          );
                          return { key: idx, content: infoHashValue };
                        }

                        // Use optimized info processor
                        const processed = processInfoTemplate(infoTemplate, source);
                        return processed ? { key: idx, content: processed } : null;
                      }).filter(Boolean).map((item, renderIdx) => (
                        <span key={item.key}>
                          {renderIdx > 0 ? ' · ' : ''}{item.content}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="source-actions">
                    {!isLoading && !(files && !showFiles) && (
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
                    <button className={`btn-borderless ts-download${isLoading || isDownloading || isDownloaded ? ' disabled' : ''}${isDownloading ? ' downloading' : isDownloaded ? ' downloaded' : ''}`}
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
                          if (total === undefined) total = estimateTotalBytesForSource(source, sourceKey);

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
                  </div>
                </div>

                <div className={`source-output ${isVisible && !isLoading && !hasError && type === 'torrent' ? 'show' : ''}`}>
                  {isVisible && files && (
                    <div className="source-files">
                      <div style={FILES_BAR_STYLE}>
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
                      <ul style={FILES_UL_STYLE}>
                        {(() => {
                          // Filter to show only audio files when available, otherwise show all files
                          const audioFiles = files.filter(f => AUDIO_EXTENSIONS.test(f.name));
                          const baseFiles = audioFiles.length > 0 ? audioFiles : files;

                          // Precompute real indices map to avoid O(n^2) indexOf lookups
                          const realIndexMap = new Map<any, number>();
                          for (let i = 0; i < files.length; i++) realIndexMap.set(files[i], i);

                          // Sort a shallow copy for display order
                          const displayFiles = baseFiles.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

                          // Find all matching files and check if user can select
                          const allMatchingIndices = findAllMatchingFileIndices(files, currentTrackName);
                          const canSelectFiles = allMatchingIndices.length > 1;

                          // Get currently selected file index
                          const selectedFileIndex = getSelectedFileIndex(sourceKey, files, currentTrackName, state.selectedFileIndices);

                          return displayFiles.map((file, displayIndex) => {
                            const realIndex = realIndexMap.get(file);
                            const normTrack = normalizeText(currentTrackName);
                            const normFile = normalizeText(file.name);
                            const isCurrent = normTrack && normFile.includes(normTrack);
                            const isSelected = realIndex === selectedFileIndex;
                            const isClickable = canSelectFiles && isCurrent;

                            return (
                              <li
                                key={`${realIndex}-${displayIndex}`}
                                className={`track-file ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''} ${isClickable ? 'clickable' : ''}`}
                                onClick={isClickable && realIndex !== undefined ? (e) => handleFileSelect(e, sourceKey, realIndex!) : undefined}
                                title={isClickable ? 'Click to select this file for playback/download' : undefined}
                              >
                                {canSelectFiles && isCurrent && (
                                  <span className="material-symbols-rounded" style={RADIO_ICON_STYLE}>
                                    {isSelected ? 'radio_button_checked' : 'radio_button_unchecked'}
                                  </span>
                                )}
                                {file.name}
                                <span style={{ opacity: .6 }}>
                                  · {formatBytes(file.length || 0)}
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
    );
  }, [state.selectedSourceKey, state.loadingKeys, state.errors, state.fileLists, state.visibleOutputs, state.downloadStates, state.downloadProgress, state.selectedFileIndices, state.showed, t, handleSourceSelect, handleToggleFiles, handleDownloadSource, handleFileSelect, currentTrackName]);



  return (
    <div className="np-section np-audio-sources" aria-label={t('np.audioSources', 'Audio sources')}>
      <h4 className="np-sec-title">
        {t('np.audioSources', 'Audio sources')}
        <div className='np-sec-right'>
          <div className="np-hint">
            {selectedSourceInfo ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Source selected:&nbsp;
                {selectedSourceInfo.icon && (
                  <ThemedSvgIcon
                    src={selectedSourceInfo.icon}
                    alt={selectedSourceInfo.type}
                    size={16}
                  />
                )}
                {selectedSourceInfo.type}
              </div>
            ) : (
              t('np.audioSourcesHint', 'Choose a source to stream this track')
            )}
          </div>
        </div>
      </h4>

      <div className="sources-container">
        {/* Local file audio source */}
        <div className="source-section">
          <div className="source-section-header">
            <h5 style={H5_HEADER_STYLE}>
              {SOURCE_ICONS?.local && (
                <ThemedSvgIcon
                  src={SOURCE_ICONS.local}
                  alt="Local"
                  className="source-icon"
                  size={16}
                />
              )}
              Local file
            </h5>
          </div>
          <ul className="sources-list source-local single">
            <li
              className={`source-item ${localSelected ? 'selected' : ''}`}
              aria-pressed={localSelected}
              aria-label={localSelected ? t('np.selectedSource', 'Selected source') : t('np.selectSource', 'Select this source')}
              onClick={async (e) => {
                e.stopPropagation();
                if (!track?.id || !localPath) return;
                const toSelect = !localSelected;
                if (toSelect) {
                  await selectTrackSource?.(track.id, { type: 'local', url: localPath, file_path: localPath, title: 'Local file', selected: true } as any);
                  setLocalSelected(true);
                  setState(prev => ({ ...prev, selectedSourceKey: undefined }));
                  window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
                    detail: { trackId: track.id, source: { type: 'local', url: localPath, file_path: localPath } }
                  }));
                } else {
                  await selectTrackSource?.(track.id, null);
                  setLocalSelected(false);
                  window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
                    detail: { trackId: track.id, source: null }
                  }));
                }
              }}
            >
              <div className="source-element">
                <div className="source-actions">
                  <button className={`btn-borderless ts-select ${localSelected ? 'active' : ''}`} type="button">
                    <span className="material-symbols-rounded">{localSelected ? 'radio_button_checked' : 'radio_button_unchecked'}</span>
                  </button>
                </div>
                <div className="source-meta">
                  <div title={localPath || ''} style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {localPath || t('np.noFileSelected', 'No file selected')}
                  </div>
                </div>
                <div className="source-actions" style={{ display: 'flex', gap: 8 }}>
                  {localPath && (
                    <button type="button" className="btn-borderless" onClick={(e) => { e.stopPropagation(); clearLocalFile(); }}>
                      <span className="material-symbols-rounded" aria-label={t('np.clearFile', 'Clear local audio file')}>delete</span>
                    </button>
                  )}
                  <button type="button" className="btn-icon" onClick={(e) => { e.stopPropagation(); pickLocalFile(); }}>
                    {t('np.selectFile', 'Select')}
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </div>

        {renderSourcesList({
          title: "YouTube",
          type: "youtube",
          sources: youtubeSources,
          icon: SOURCE_ICONS.youtube,
          info: ["{time}", "{uploader}", "{id}"],
          showFiles: false
        })}

        {renderSourcesList({
          title: "Torrents",
          type: "torrent",
          sources: torrentSources,
          icon: SOURCE_ICONS.torrent,
          info: ["{source}", "{size}", "t(np.seeders,{seeders})", "{infoHash}"],
          showFiles: true
        })}
      </div>
    </div>
  );
}
