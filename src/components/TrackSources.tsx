import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../core/spotify';
import { invoke } from '@tauri-apps/api/core';

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
  const timeoutsRef = useRef<Record<string, number>>({});
  const [lastQuery, setLastQuery] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const fetchedQueriesRef = useRef<Record<string, boolean>>({});

  function withTimeout<T>(p: Promise<T>, ms = 10000) {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      p.then((v) => {
        clearTimeout(t);
        resolve(v);
      }).catch((e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

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

  useEffect(() => {
    let cancelled = false;

    // compute the query once per effect run, keep the effect deps small & explicit
    const albumTitle = album?.name ?? track?.album?.name ?? track?.name ?? "";
    const artist = track?.artists?.[0]?.name ?? primaryArtist?.name ?? "";
    const query = `${albumTitle} ${artist}`.trim();
    setLastQuery(query || undefined);

    async function loadSources() {
      setLoadError(undefined);
      setSources(undefined);

      if (!track || !query) {
        // nothing to search for
        if (!query) {
          console.debug("🎵 TrackSources: empty query, skipping search");
          setSources([]);
        }
        return;
      }

      console.info("🎵 TrackSources: start loadSources for query=", query);

      const errors: string[] = [];
      let results: any[] = [];

      try {
        // Make access to an imported `invoke` safe: `typeof` won't throw for undeclared vars.
        const importedInvoke =
          typeof invoke === "function" ? (invoke as any) : undefined;

        // fallback to window/global tauri core invoke if available
        const globalInvoke =
          (globalThis as any).__TAURI__?.core?.invoke ||
          (globalThis as any).__TAURI__?.invoke;

        const tauriInvoke = importedInvoke ?? globalInvoke ?? null;

        if (!tauriInvoke) {
          console.warn("🎵 TrackSources: no tauri invoke() available");
          errors.push("no-tauri-invoke");
        } else {
          const cmd = "torrent_search";
          console.debug("🎵 TrackSources: calling invoke command=", cmd);

          try {
            // wrap with a timeout to avoid hanging the UI indefinitely
            const resp = await withTimeout(
              (tauriInvoke as Function)(cmd, { query, page: 1 }),
              10_000
            ) as any;
            if (cancelled) return;

            // normalize possible response shapes
            results = Array.isArray(resp)
              ? resp
              : (resp?.results ?? resp?.items ?? resp ?? []);
            console.debug(
              "🎵 TrackSources: invoke response normalized length=",
              Array.isArray(results) ? results.length : 0
            );
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            console.warn("🎵 TrackSources: invoke failed:", msg);
            errors.push(`tauri-invoke-${cmd}: ${msg}`);
          }
        }

        if (!cancelled) {
          if (results && results.length > 0) {
            setSources(results.slice(0, 50));
            console.info("🎵 TrackSources: loaded", results.length, "results");
          } else {
            console.warn("🎵 TrackSources: no results found", errors);
            setSources([]);
            setLoadError(errors.join(" | ") || undefined);
          }
        }
      } catch (err: any) {
        console.error("🎵 TrackSources: unexpected error", err);
        if (!cancelled) {
          setSources([]);
          setLoadError(String(err));
        }
      }
    }

    loadSources();

    return () => {
      cancelled = true;
    };
    // Depend only on stable pieces required to produce the query
  }, [track?.id, track?.name, album?.name, primaryArtist?.name]);

  async function handleSourceData(s: any, i: number, t_key: any) {
    // Prevent concurrent fetches for the same key or if files already present
    setTorrentErrors(e => ({ ...e, [t_key]: undefined }));
    setTorrentLoadingKeys(k => ({ ...k, [t_key]: true }));

    // call centralized helper
    try {
      const id = s.magnetURI ?? s.infoHash ?? s.url ?? '';
      let files: any[] = [];

      // Prefer Tauri invoke when available
      const importedInvoke = typeof invoke === 'function' ? (invoke as any) : undefined;
      const globalInvoke = (globalThis as any).__TAURI__?.core?.invoke || (globalThis as any).__TAURI__?.invoke || (globalThis as any).__TAURI__?.tauri?.invoke;
      const tauriInvoke = importedInvoke ?? globalInvoke ?? null;

      if (tauriInvoke) {
        const resp = await withTimeout((tauriInvoke as Function)('torrent_get_files', { id, timeoutMs: 8000 }), 8000) as any;
        files = Array.isArray(resp) ? resp : (resp?.results ?? resp?.items ?? resp ?? []);
      } else {
        // Fallback: dynamically import the client helper to avoid static electron-only import
        try {
          const tc = await import('../core/torrentClient');
          files = await tc.getTorrentFileList(id, { timeoutMs: 8000 });
        } catch (e) {
          throw e;
        }
      }
      // Normalize & dedupe by filename (preserve first occurrence order)
      const seen = new Set<string>();
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
      setTorrentFileLists(l => ({ ...l, [t_key]: (audioFiles.length ? audioFiles : uniqueFiles) }));
      setTorrentLoadingKeys(k => ({ ...k, [t_key]: false }));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setTorrentErrors(err => ({
        ...err, [t_key]: (
          msg.indexOf('timeout') >= 0 ?
            'Timeout' :
            msg || 'Error'
        ) + " - Retry"
      }));
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
                          <button
                            type="button"
                            className={`btn-icon ${torrentErrors[t_key] ? (torrentErrors[t_key].includes('Error')?'btn-error':'btn-warning') : ''}`}
                            disabled={!!torrentLoadingKeys[t_key] && !torrentFileLists[t_key]}
                            onClick={async () => {
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
                          <button
                            type="button"
                            className="btn-icon">
                            <span className="material-symbols-rounded">more_horiz</span>
                          </button>
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
                                    .replace(/\s+/g, ' ')
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
