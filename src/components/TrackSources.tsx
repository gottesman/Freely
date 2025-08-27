import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../core/spotify';
import { getTorrentFileList } from '../core/torrentClient';

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
    async function loadSources() {
      setLoadError(undefined);
      setSources(undefined);
      if (!track) return;
      const albumTitle = album?.name || track.album?.name || track.name || '';
      const artist = track.artists?.[0]?.name || primaryArtist?.name || '';
      const query = `${albumTitle} ${artist}`.trim();
      setLastQuery(query || undefined);
      if (!query) return;
      console.log('🎵 TrackSources: Searching torrent sources for album query:', query);

      const w: any = window;
      // Follow Tests.tsx implementation: prefer window.electron.torrent.search({query,page}), else fetch HTTP server
      const errors: string[] = [];
      let results: any[] = [];
      try {
        if (w.electron?.torrent?.search) {
          const res = await w.electron.torrent.search({ query, page: 1, debug: false });
          if (cancelled) return;
          results = Array.isArray(res) ? res : (res?.results || res?.items || []);
        } else {
          try {
            const resp = await fetch(`http://localhost:9000/api/torrent-search?q=${encodeURIComponent(query)}&page=1`);
            if (resp.ok) results = await resp.json();
          } catch (e: any) { errors.push(`http-fetch: ${String(e)}`); }
        }
      } catch (e: any) {
        errors.push(`ipc-torrent: ${String(e)}`);
      }

      if (results && results.length) {
        if (!cancelled) setSources(results.slice(0, 50));
        return;
      }

      // seed-out.json fallback
      try {
        const resp2 = await fetch('/seed-out.json');
        if (resp2.ok) {
          const body2 = await resp2.json();
          if (cancelled) return;
          const list2 = Array.isArray(body2) ? body2 : [body2];
          if (list2 && list2.length) { setSources(list2); return; }
        }
      } catch (e: any) { errors.push(`seed-fetch: ${String(e)}`); }

      if (!cancelled) {
        setSources([]);
        setLoadError(errors.join(' | '));
      }
    }
    loadSources();
    return () => { cancelled = true; };
  }, [track?.id, track?.name, primaryArtist?.name, album?.name]);

  async function handleSourceData(s: any, i: number, t_key: any) {
  // Prevent concurrent fetches for the same key or if files already present
  setTorrentErrors(e => ({ ...e, [t_key]: undefined }));
  setTorrentLoadingKeys(k => ({ ...k, [t_key]: true }));

    // call centralized helper
    try {
      const files = await getTorrentFileList(s.magnetURI, { timeoutMs: 8000 });
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
      setTorrentErrors(err => ({ ...err, [t_key]: (
        msg.indexOf('timeout') >= 0 ?
          t('np.torrentTimeout', 'Torrent timeout') : 
          msg || t('np.unknownError', 'Unknown error')
        ) + " - Retry" }));
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
                          className="btn"
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
