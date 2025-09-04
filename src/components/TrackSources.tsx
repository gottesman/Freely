import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../core/spotify';
import { runTauriCommand } from '../core/tauriCommands';
import * as tc from '../core/torrentClient'; // static import to get types

// Module-level caches and inflight maps to ensure one-shot Tauri calls across
// component remounts (React StrictMode can mount/unmount during dev).
const tauriSearchInflight = new Map<string, Promise<any>>();
const tauriSearchCache = new Map<string, any[]>();

const torrentFileListInflight = new Map<string, Promise<any[]>>();
const torrentFileListCache = new Map<string, any[]>();

export default function TrackSources({ track, album, primaryArtist }: { track?: SpotifyTrack, album?: SpotifyAlbum, primaryArtist?: SpotifyArtist }) {
  const { t } = useI18n();
  // Get the current track name for highlighting
  const currentTrackName = track?.name?.trim() || '';
  const [sources, setSources] = useState<any[] | undefined>();
  const wtClientRef = useRef<any | null>(null);
  const [torrentFileLists, setTorrentFileLists] = useState<Record<string, { name: string; length: number }[]>>({});
  const [torrentLoadingKeys, setTorrentLoadingKeys] = useState<Record<string, boolean>>({});
  const [torrentErrors, setTorrentErrors] = useState<Record<string, string | undefined>>({});
  const [visibleOutputs, setVisibleOutputs] = useState<Record<string, boolean>>({});
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | undefined>(undefined);
  const timeoutsRef = useRef<Record<string, number>>({});
  const [lastQuery, setLastQuery] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const fetchedQueriesRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    return () => {
      try {
        if (wtClientRef.current && typeof wtClientRef.current.destroy === 'function') {
          wtClientRef.current.destroy();
          wtClientRef.current = null;
        }
      } catch (e) {
        console.error('Failed to destroy WebTorrent client', e);
      }
    };
  }, []);

  // build separate fields and send them to the backend
  useEffect(() => {
    let cancelled = false;
    const albumTitle = album?.name ?? track?.album?.name ?? track?.name ?? "";
    const artist = track?.artists?.[0]?.name ?? primaryArtist?.name ?? "";
    // try to extract year if available (optional)
    const year = album?.releaseDate ?? track?.album?.releaseDate ?? undefined;
    setLastQuery(`${albumTitle} ${artist}`.trim() || undefined);

    async function loadSources() {
      setLoadError(undefined);
      setSources(undefined);
      if (!track || (!albumTitle && !artist)) {
        setSources([]);
        return;
      }

      const errors: string[] = [];
      let results: any[] = [];
      try {
        const key = `${String(albumTitle||'')}::${String(artist||'')}::${String(year||'')}`;
        // If we already have a cached result, use it
        if (tauriSearchCache.has(key)) {
          results = tauriSearchCache.get(key) || [];
        } else {
          // If an inflight promise exists, await it; otherwise start one
          let p = tauriSearchInflight.get(key);
          if (!p) {
            p = (async () => {
              const cmd = 'torrent_search';
              const resp = await runTauriCommand(cmd, { payload: { albumTitle, artist, year, page: 1 } }) as any;
              const r = Array.isArray(resp) ? resp : (resp?.results ?? resp?.items ?? resp ?? []);
              // cache result
              tauriSearchCache.set(key, r);
              tauriSearchInflight.delete(key);
              return r;
            })();
            tauriSearchInflight.set(key, p);
          }
          try {
            results = await p;
          } catch (e) {
            tauriSearchInflight.delete(key);
            errors.push(`tauri-invoke-torrent_search: ${String(e)}`);
          }
        }

        if (!cancelled) {
          if (results && results.length > 0) setSources(results.slice(0, 50));
          else {
            setSources([]);
            setLoadError(errors.join(' | ') || undefined);
          }
        }
      } catch (err) {
        console.error('🎵 TrackSources: unexpected error', err);
        if (!cancelled) {
          setSources([]);
          setLoadError(String(err));
        }
      }
    }

    loadSources();
    return () => { cancelled = true; };
  }, [track?.id, track?.name, album?.name, primaryArtist?.name]);


  async function handleSourceData(s: any, i: number, t_key: any) {
    // Prevent concurrent fetches for the same key or if files already present
    setTorrentErrors(e => ({ ...e, [t_key]: undefined }));
    setTorrentLoadingKeys(k => ({ ...k, [t_key]: true }));
    try {
      const id = s.magnetURI ?? s.infoHash ?? s.url ?? '';
      if (!id) throw new Error('Missing torrent id');

      const DEFAULT_TIMEOUT = 10000;

      // Return cached files if available
      if (torrentFileListCache.has(id)) {
        const cached = torrentFileListCache.get(id) || [];
        setTorrentFileLists(l => ({ ...l, [t_key]: cached }));
        setTorrentLoadingKeys(k => ({ ...k, [t_key]: false }));
        return;
      }

      // If inflight, await the existing promise
      let p = torrentFileListInflight.get(id);
      if (!p) {
        p = (async () => {
          const files = await tc.getTorrentFileList(id, { timeoutMs: DEFAULT_TIMEOUT });
          // Normalize & dedupe by filename (preserve first occurrence order)
          const seen = new Set();
          const uniqueFiles = (files || []).filter((f: any) => {
            const name = String(f.name || '').trim();
            if (!name) return false;
            if (seen.has(name)) return false;
            seen.add(name);
            return true;
          });
          // Prefer common audio files
          const audioExt = /\.(mp3|m4a|flac|wav|ogg|aac|opus|webm)$/i;
          const audioFiles = uniqueFiles.filter(f => audioExt.test(f.name));
          const chosen = (audioFiles.length ? audioFiles : uniqueFiles);
          torrentFileListCache.set(id, chosen);
          torrentFileListInflight.delete(id);
          return chosen;
        })();
        torrentFileListInflight.set(id, p);
      }

      let files: any[] = [];
      try {
        files = await p;
      } catch (firstErr) {
        torrentFileListInflight.delete(id);
        throw firstErr;
      }

      setTorrentFileLists(l => ({ ...l, [t_key]: files }));
      setTorrentLoadingKeys(k => ({ ...k, [t_key]: false }));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.error('🎵 TrackSources: getTorrentFileList error', msg);
      setTorrentErrors(err => ({ ...err, [t_key]: msg }));
      setTorrentLoadingKeys(k => ({ ...k, [t_key]: false }));
    }
  }


  // Auto-fetch file lists for all sources once per query so the Files button
  // can toggle stored data without re-fetching.
  useEffect(() => {
    const q = lastQuery;
    if (!q || !sources || !sources.length) return;
    if (fetchedQueriesRef.current[q]) return;

    const candidates = sources.map((s: any, i: number) => ({ s, i, t_key: s.infoHash ?? s.magnetURI ?? s.url ?? String(i) }))
      .filter((c: any) => !!(c.s.infoHash || c.s.magnetURI || c.s.url));

    const concurrency = 4;
    (async () => {
      for (let i = 0; i < candidates.length; i += concurrency) {
        const batch = candidates.slice(i, i + concurrency);
        await Promise.all(batch.map(b => {
          if (torrentFileLists[b.t_key] || torrentLoadingKeys[b.t_key]) return Promise.resolve();
          return handleSourceData(b.s, b.i, b.t_key);
        }));
      }
      fetchedQueriesRef.current[q] = true;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, lastQuery]);

  return (
    <div className="np-section np-audio-sources" aria-label={t('np.audioSources', 'Audio sources')}>
      <h4 className="np-sec-title">{t('np.audioSources', 'Audio sources')}<div className="np-hint">{t('np.audioSourcesHint', 'Choose a torrent source to stream this track')}</div></h4>

      {sources === undefined && (
        <div className="np-hint">{t('np.loadingSources', 'Loading sources...')}</div>
      )}

      {sources && sources.length > 0 && (
        <div className='sources-container'>
          <ul className="sources-list">
            {sources.map((s: any, i: number) => {
              const t_key = s.infoHash ?? s.magnetURI ?? s.url ?? String(i);
              const seeds = Number(s.seeders ?? s.seeds ?? 0);
              if (seeds < 1) return;

              return (
                <li key={t_key} className="source-item">
                  <div className="torrent-element">
                    <div className="source-meta">
                      <strong>{s.title || s.infoHash}</strong>
                      <div className="source-sub">
                        {s.source || ''}
                        {s.size ? <> · {s.size}</> : null}
                        {(typeof s.seeders === 'number' || typeof s.seeds === 'number') ? (
                          <> · {seeds.toLocaleString()} {t('np.seeders', 'seeds')} · {s.infoHash || <span style={{ opacity: .6 }}>{t('np.unknownHash', 'Unknown info hash')}</span>}</>
                        ) : null}
                      </div>
                    </div>
                    <div className="source-actions">
                      {s.magnetURI && (
                        <>
                          {/* Select this source for playback - only show when files are loaded and no error */}
                          {torrentFileLists[t_key] && !torrentErrors[t_key] && (
                            <button
                              type="button"
                              className={`btn-icon ts-select ${selectedSourceKey === t_key ? 'active' : ''}`}
                              aria-pressed={selectedSourceKey === t_key}
                              aria-label={selectedSourceKey === t_key ? t('np.selectedSource', 'Selected source') : t('np.selectSource', 'Select this source')}
                              onClick={(ev) => { ev.stopPropagation(); ev.preventDefault(); setSelectedSourceKey(prev => prev === t_key ? undefined : t_key); }}
                            >
                              <span className="material-symbols-rounded">{selectedSourceKey === t_key ? 'check' : 'radio_button_unchecked'}</span>
                            </button>
                          )}

                          <button
                            type="button"
                            className={`btn-icon ts-files ${torrentErrors[t_key] ? (torrentErrors[t_key].includes('Error') ? 'btn-error' : 'btn-warning') : ''}`}
                            disabled={!!torrentLoadingKeys[t_key] && !torrentFileLists[t_key]}
                            onClick={async (ev) => {
                              ev.stopPropagation();
                              // If we already have files, toggle visibility. Otherwise trigger fetch.
                              if (torrentFileLists[t_key]) {
                                setVisibleOutputs(v => ({ ...v, [t_key]: !v[t_key] }));
                                return;
                              }
                              if (torrentLoadingKeys[t_key]) return;
                              // mark visible so the user sees loading/errors immediately
                              setVisibleOutputs(v => ({ ...v, [t_key]: true }));
                              handleSourceData(s, i, t_key);
                            }}
                          >
                            {torrentFileLists[t_key] ? (visibleOutputs[t_key] ? t('np.hide', 'Hide') : t('np.filesSource', 'Show')) : (torrentLoadingKeys[t_key] ? t('np.loading', 'Loading') : (torrentErrors[t_key] ? torrentErrors[t_key] : t('np.filesSource', 'Load')))}
                          </button>
                          {
                            /*
                            <button
                              type="button"
                              className="btn-icon">
                              <span className="material-symbols-rounded">more_horiz</span>
                            </button>
                            */
                          }
                        </>
                      )}
                    </div>
                  </div>
                  <div className={`torrent-output ${visibleOutputs[t_key] && !torrentLoadingKeys[t_key] && !torrentErrors[t_key] ? 'show' : ''}`}>
                    {visibleOutputs[t_key] && torrentFileLists[t_key] && (
                      <div className="torrent-files">
                        <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>{t('np.torrentFiles', 'Files in torrent')}</div>
                        <ul style={{ margin: 6, paddingLeft: 16 }}>
                          {
                            torrentLoadingKeys[t_key] ?
                              <li>{t('np.loading', 'Loading')}</li> :
                              (torrentFileLists[t_key] && Array.isArray(torrentFileLists[t_key]) ? [...torrentFileLists[t_key]] : [])
                                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
                                .map((f, idx2) => {
                                  // Normalize: lowercase, remove punctuation, trim
                                  const normalize = (str: string) => str
                                    .toLowerCase()
                                    .replace(/\s+|_+|-+/g, ' ')
                                    .replace(/[\p{P}\p{S}]/gu, '')
                                    .trim();
                                  const normTrack = normalize(currentTrackName);
                                  const normFile = normalize(f.name);
                                  const isCurrent = normTrack && normFile.includes(normTrack);
                                  return (
                                    <li
                                      key={idx2}
                                      className={`track-file ${isCurrent ? 'current' : ''}`}
                                    >
                                      {f.name} <span style={{ opacity: .6 }}>· {Math.round((f.length || 0) / 1024 / 1024)} MB</span>
                                    </li>
                                  );
                                })}
                        </ul>
                      </div>
                    )}
                    {((torrentLoadingKeys[t_key] && !visibleOutputs[t_key]) || torrentErrors[t_key]) && (
                      <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
                        {torrentLoadingKeys[t_key] ? t('np.loading', 'Loading') : torrentErrors[t_key]}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {Array.isArray(sources) && sources.length === 0 && (
        <div className="np-hint">{t('np.noSources', 'No sources found')}</div>
      )}
    </div>
  );
}
