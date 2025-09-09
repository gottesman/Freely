import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useI18n } from '../core/i18n';
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../core/spotify';
import { runTauriCommand } from '../core/tauriCommands';
import { fmtTotalMs } from './tabHelpers';
import { useDB } from '../core/dbIndexed';
import * as tc from '../core/torrentClient';

// Constants
const DEFAULT_TIMEOUT = 10000;
const MAX_SOURCES = 50;
const CONCURRENCY_LIMIT = 5;
const MIN_SEEDS = 1;

// Audio file extensions for filtering
const AUDIO_EXTENSIONS = /\.(mp3|m4a|flac|wav|ogg|aac|opus|webm)$/i;

// Icons for different source types
const SOURCE_ICONS = {
  youtube: 'https://upload.wikimedia.org/wikipedia/commons/0/09/YouTube_full-color_icon_%282017%29.svg',
  torrent: 'https://free-icon-rainbow.com/i/icon_10753/icon_10753_svg_s1.svg'
} as const;

// Module-level caches with better cleanup
class CacheManager {
  private static instance: CacheManager;
  private searchCache = new Map<string, any[]>();
  private searchInflight = new Map<string, Promise<any>>();
  private fileListCache = new Map<string, any[]>();
  private fileListInflight = new Map<string, Promise<any[]>>();

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

// Combined state type for better performance
interface SourceState {
  sources: any[] | undefined;
  fileLists: Record<string, { name: string; length: number }[]>;
  loadingKeys: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  visibleOutputs: Record<string, boolean>;
  selectedSourceKey: string | undefined;
  lastQuery: string | undefined;
  loadError: string | undefined;
}

const initialState: SourceState = {
  sources: undefined,
  fileLists: {},
  loadingKeys: {},
  errors: {},
  visibleOutputs: {},
  selectedSourceKey: undefined,
  lastQuery: undefined,
  loadError: undefined
};

export default function TrackSources({ track, album, primaryArtist }: { 
  track?: SpotifyTrack; 
  album?: SpotifyAlbum; 
  primaryArtist?: SpotifyArtist; 
}) {
  const { t } = useI18n();
  const { getSetting, setSetting } = useDB();
  const [state, setState] = useState<SourceState>(initialState);
  const wtClientRef = useRef<any | null>(null);
  const fetchedQueriesRef = useRef<Record<string, boolean>>({});
  const abortControllerRef = useRef<AbortController | null>(null);

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
          
          // Restore previously selected source
          if (track?.id) {
            try {
              const saved = await getSetting?.(`source:selected:${track.id}`);
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
  const handleSourceData = useCallback(async (source: any, sourceKey: string) => {
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
        return;
      }

      // Check for inflight request
      let promise = fileListInflight.get(id);
      if (!promise) {
        promise = (async () => {
          try {
            // Handle YouTube FIRST so playUrl/streamUrl becomes available sooner
            if (source.type === 'youtube' && source.id) {
              const info = await runTauriCommand<any>('youtube_get_info', { 
                payload: { id: source.id } 
              });
              const streamUrl = info?.streamUrl || null;
              if (streamUrl) {
                source.streamUrl = streamUrl;
                source.playUrl = streamUrl;
              }
              const estBytes = info?.format?.filesize || info?.format?.filesize_approx || 0;
              const syntheticName = source.title || source.name || `youtube:${source.id}`;
              const synthetic = [{ name: syntheticName, length: estBytes }];
              fileListCache.set(sourceKey, synthetic);
              return synthetic;
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

              const audioFiles = uniqueFiles.filter(f => AUDIO_EXTENSIONS.test(f.name));
              const chosen = audioFiles.length ? audioFiles : uniqueFiles;
              fileListCache.set(sourceKey, chosen);
              return chosen;
            }

            // Generic sources
            const syntheticName = source.title || source.name || String(id);
            const synthetic = [{ name: syntheticName, length: source.length || 0 }];
            fileListCache.set(sourceKey, synthetic);
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
    } catch (e: any) {
      let msg = e?.message ?? String(e);
      
      // Clean up malformed error messages
      if (msg.startsWith('ERR: ') && msg.length > 50 && !msg.includes(' ')) {
        // This looks like a malformed concatenated error - provide a generic message
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
    }
  }, []);


  // Auto-fetch file lists for all sources
  useEffect(() => {
    const { lastQuery, sources } = state;
    if (!lastQuery || !sources?.length || fetchedQueriesRef.current[lastQuery]) return;

    const candidates = sources
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
      for (let i = 0; i < candidates.length; i += CONCURRENCY_LIMIT) {
        const batch = candidates.slice(i, i + CONCURRENCY_LIMIT);
        await Promise.allSettled(
          batch.map(({ source, key }) => {
            if (state.fileLists[key] || state.loadingKeys[key]) {
              return Promise.resolve();
            }
            return handleSourceData(source, key);
          })
        );
      }
      fetchedQueriesRef.current[lastQuery] = true;
    };

    batchProcess();
  }, [state.sources, state.lastQuery, state.fileLists, state.loadingKeys, handleSourceData]);

  // Event handlers
  const handleSourceSelect = useCallback(async (source: any, sourceKey: string) => {
    if (state.loadingKeys[sourceKey] || state.errors[sourceKey]) return;

    const isCurrentlySelected = state.selectedSourceKey === sourceKey;
    const newKey = isCurrentlySelected ? undefined : sourceKey;

    setState(prev => ({ ...prev, selectedSourceKey: newKey }));

    // Persist selection
    if (track?.id) {
      try {
        if (newKey) {
          const minimal = JSON.stringify({
            type: source.type,
            id: source.id,
            infoHash: source.infoHash,
            magnetURI: source.magnetURI,
            playUrl: source.playUrl || source.streamUrl || source.url || null,
            title: source.title
          });
          await setSetting?.(`source:selected:${track.id}`, minimal);
          
          // Notify playback system that track source has changed
          window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
            detail: { trackId: track.id, source: minimal }
          }));
        } else {
          await setSetting?.(`source:selected:${track.id}`, '');
          
          // Notify playback system that source was removed
          window.dispatchEvent(new CustomEvent('freely:track:sourceChanged', {
            detail: { trackId: track.id, source: null }
          }));
        }
      } catch {
        // Ignore persistence errors
      }
    }
  }, [state.loadingKeys, state.errors, state.selectedSourceKey, track?.id, setSetting]);

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

  return (
    <div className="np-section np-audio-sources" aria-label={t('np.audioSources', 'Audio sources')}>
      <h4 className="np-sec-title">
        {t('np.audioSources', 'Audio sources')}
        <div className="np-hint">
          {t('np.audioSourcesHint', 'Choose a source to stream this track')}
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
                          {files && !hasError && (
                            <button className={`ts-select ${isSelected ? 'active' : ''}`}>
                              <span className="material-symbols-rounded">
                                {isSelected ? 'check' : 'radio_button_unchecked'}
                              </span>
                            </button>
                          )}
                          
                          {isLoading && !files && (
                            <div className="loading-dots" style={{ width: 52, textAlign: 'center' }} aria-label={t('np.loading', 'Loading')}>
                              <span></span><span></span><span></span>
                            </div>
                          )}
                          
                          {!isLoading && (
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
                        </>
                      )}
                    </div>
                  </div>
                  
                  <div className={`source-output ${isVisible && !isLoading && !hasError ? 'show' : ''}`}>
                    {isVisible && files && (
                      <div className="source-files">
                        <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>
                          {t('np.sourceFiles', 'Files in source')}
                        </div>
                        <ul style={{ margin: 6, paddingLeft: 16 }}>
                          {files
                            .slice()
                            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
                            .map((file, fileIndex) => {
                              const normTrack = normalizeText(currentTrackName);
                              const normFile = normalizeText(file.name);
                              const isCurrent = normTrack && normFile.includes(normTrack);
                              
                              return (
                                <li
                                  key={fileIndex}
                                  className={`track-file ${isCurrent ? 'current' : ''}`}
                                >
                                  {file.name} 
                                  <span style={{ opacity: .6 }}>
                                    · {Math.round((file.length || 0) / 1024 / 1024)} MB
                                  </span>
                                </li>
                              );
                            })}
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
