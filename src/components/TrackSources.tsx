import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../core/i18n';
import type { SpotifyAlbum, SpotifyArtist, SpotifyTrack } from '../core/spotify';

export default function TrackSources({ track, album, primaryArtist }: { track?: SpotifyTrack, album?: SpotifyAlbum, primaryArtist?: SpotifyArtist }){
  const { t } = useI18n();
  const [sources, setSources] = useState<any[]|undefined>();
  const wtClientRef = useRef<any | null>(null);
  const [torrentFileLists, setTorrentFileLists] = useState<Record<string, { name: string; length: number }[]>>({});
  const [torrentLoadingKeys, setTorrentLoadingKeys] = useState<Record<string, boolean>>({});
  const [torrentErrors, setTorrentErrors] = useState<Record<string,string|undefined>>({});
  const timeoutsRef = useRef<Record<string, number>>({});
  const [lastQuery, setLastQuery] = useState<string|undefined>();
  const [loadError, setLoadError] = useState<string|undefined>();

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

  useEffect(()=>{
    let cancelled = false;
    async function loadSources(){
      setLoadError(undefined);
      setSources(undefined);
      if(!track) return;
      const albumTitle = album?.name || track.album?.name || track.name || '';
      const artist = track.artists?.[0]?.name || primaryArtist?.name || '';
      const query = `${albumTitle} ${artist}`.trim();
      setLastQuery(query || undefined);
      if(!query) return;
      console.log('🎵 TrackSources: Searching torrent sources for album query:', query);

      const w:any = window;
      // Follow Tests.tsx implementation: prefer window.electron.torrent.search({query,page}), else fetch HTTP server
      const errors: string[] = [];
      let results: any[] = [];
      try {
        if (w.electron?.torrent?.search) {
          const res = await w.electron.torrent.search({ query, page: 1 });
          if (cancelled) return;
          results = Array.isArray(res) ? res : (res?.results || res?.items || []);
        } else {
          try {
            const resp = await fetch(`http://localhost:9000/api/torrent-search?q=${encodeURIComponent(query)}&page=1`);
            if (resp.ok) results = await resp.json();
          } catch (e:any) { errors.push(`http-fetch: ${String(e)}`); }
        }
      } catch (e:any) {
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
      } catch (e:any) { errors.push(`seed-fetch: ${String(e)}`); }

      if (!cancelled) {
        setSources([]);
        setLoadError(errors.join(' | '));
      }
    }
    loadSources();
    return ()=> { cancelled = true; };
  }, [track?.id, track?.name, primaryArtist?.name, album?.name]);

  return (
    <div className="np-section np-audio-sources" aria-label={t('np.audioSources','Audio sources')}>
      <h4 className="np-sec-title">{t('np.audioSources','Audio sources')}<div className="np-hint">{t('np.audioSourcesHint','Choose a torrent source to stream this track')}</div></h4>

      {sources === undefined && (
        <div className="np-hint">{t('np.loadingSources','Loading sources...')}</div>
      )}

      {sources && sources.length > 0 && (
        <div className='sources-container'>
          <ul className="sources-list">
            {sources.map((s:any, i:number) => {
              const key = s.infoHash ?? s.magnetURI ?? s.url ?? s.name ?? `source-${i}`;
              return (
                <li key={key} className="source-item">
                  <div className="source-meta">
                    <strong>{s.title || s.infoHash}</strong>
                    <div className="source-sub">
                      {s.source || ''}
                      {s.size ? <> · {s.size}</> : null}
                      {(typeof s.seeders === 'number' || typeof s.seeds === 'number') ? (
                        <> · {(Number(s.seeders ?? s.seeds)).toLocaleString()} {t('np.seeders','seeds')}</>
                      ) : null}
                    </div>
                  </div>
                  <div className="source-actions">
                    {s.magnetURI && (
                      <>
                        <button
                          type="button"
                          className="btn"
                          onClick={async () => {
                            const key = s.infoHash ?? s.magnetURI ?? s.url ?? String(i);
                            if (torrentFileLists[key]) return;
                            // Clear previous error for this key
                            setTorrentErrors(e => ({ ...e, [key]: undefined }));
                            setTorrentLoadingKeys(k => ({ ...k, [key]: true }));

                            // Safety timeout: if metadata doesn't arrive in 20s, show error and clear loading
                            const tid = window.setTimeout(() => {
                              setTorrentLoadingKeys(k => ({ ...k, [key]: false }));
                              setTorrentErrors(e => ({ ...e, [key]: t('np.torrentTimeout','Failed to fetch torrent metadata (timeout)') }));
                            }, 20000);
                            timeoutsRef.current[key] = tid;

                            try {
                              try {
                                if (typeof (globalThis as any).global === 'undefined') {
                                  (globalThis as any).global = globalThis;
                                }
                                if (typeof (globalThis as any).process === 'undefined') {
                                  (globalThis as any).process = { env: {}, browser: true } as any;
                                } else if (!(globalThis as any).process.browser) {
                                  (globalThis as any).process.browser = true;
                                }
                                if (typeof (globalThis as any).Buffer === 'undefined') {
                                  const buf = await import('buffer');
                                  (globalThis as any).Buffer = buf.Buffer;
                                }
                              } catch (e) {
                                console.warn('Polyfill for Buffer/global/process failed (continuing):', e);
                              }

                              // Try to import the browser bundle first, then fall back to the package entry
                              let wt: any;
                              try { wt = await import('webtorrent/webtorrent.min.js'); }
                              catch (_) {
                                try { wt = await import('webtorrent'); }
                                catch (e) { throw new Error('Failed to import webtorrent: '+String(e)); }
                              }
                              const BrowserWebTorrent = (wt && (wt.default || wt)) as any;
                              if (!BrowserWebTorrent) throw new Error('Browser WebTorrent bundle not found');
                              if (!wtClientRef.current) {
                                try { wtClientRef.current = new BrowserWebTorrent(); }
                                catch(e){ throw new Error('Failed to construct WebTorrent client: '+String(e)); }
                              }
                              const client = wtClientRef.current;

                              // Defensive check: ensure client.add exists before calling
                              if (!client || typeof client.add !== 'function'){
                                const msg = 'webtorrent client.add is not a function';
                                console.error(msg, { client });
                                setTorrentErrors(err => ({ ...err, [key]: msg }));
                                setTorrentLoadingKeys(k => ({ ...k, [key]: false }));
                                const to = timeoutsRef.current[key]; if(to) { clearTimeout(to); delete timeoutsRef.current[key]; }
                                return;
                              }

                              try {
                                // If we've already added this torrent to the client, reuse it
                                let torrent: any = client.get(s.infoHash || s.magnetURI);
                                let handled = false;

                                const cleanup = () => {
                                  try {
                                    if (!torrent) return;
                                    torrent.removeListener && torrent.removeListener('ready', onReady);
                                    torrent.removeListener && torrent.removeListener('metadata', onReady);
                                    torrent.removeListener && torrent.removeListener('error', onError);
                                  } catch (e) {}
                                };

                                const onReady = () => {
                                  try {
                                    const files = (torrent.files || []).map((f: any) => ({ name: f.name, length: f.length }));
                                    setTorrentFileLists(l => ({ ...l, [key]: files }));
                                  } catch (e) {
                                    console.error('Failed to read torrent files', e);
                                    setTorrentErrors(e2 => ({ ...e2, [key]: String(e) }));
                                  } finally {
                                    handled = true;
                                    setTorrentLoadingKeys(k => ({ ...k, [key]: false }));
                                    const to = timeoutsRef.current[key]; if (to) { clearTimeout(to); delete timeoutsRef.current[key]; }
                                    cleanup();
                                  }
                                };

                                const onError = (err: any) => {
                                  try {
                                    console.error('Torrent error', err);
                                    setTorrentErrors(e2 => ({ ...e2, [key]: String(err) }));
                                  } finally {
                                    handled = true;
                                    setTorrentLoadingKeys(k => ({ ...k, [key]: false }));
                                    const to = timeoutsRef.current[key]; if (to) { clearTimeout(to); delete timeoutsRef.current[key]; }
                                    cleanup();
                                  }
                                };

                                if (torrent) {
                                  // If metadata already present, read files immediately
                                  if (torrent.files && torrent.files.length) {
                                    onReady();
                                  } else {
                                    torrent.on && torrent.on('ready', onReady);
                                    torrent.on && torrent.on('metadata', onReady);
                                    torrent.on && torrent.on('error', onError);
                                  }
                                } else {
                                  // Add the magnet and wait for metadata/ready
                                  torrent = client.add(s.magnetURI, { destroyStoreOnDestroy: true });
                                  torrent.on && torrent.on('ready', onReady);
                                  torrent.on && torrent.on('metadata', onReady);
                                  torrent.on && torrent.on('error', onError);
                                }
                                // Safety: if nothing calls onReady/onError within timeout it will be handled by previously set timeout
                              } catch(e){
                                console.error('client.add threw', e);
                                setTorrentErrors(err => ({ ...err, [key]: String(e) }));
                                setTorrentLoadingKeys(k => ({ ...k, [key]: false }));
                                const to = timeoutsRef.current[key]; if(to) { clearTimeout(to); delete timeoutsRef.current[key]; }
                              }
                            } catch (e) {
                              console.error('webtorrent failed to load or add torrent:', e);
                              setTorrentErrors(err => ({ ...err, [key]: String(e) }));
                              setTorrentLoadingKeys(k => ({ ...k, [key]: false }));
                              const to = timeoutsRef.current[key]; if(to) { clearTimeout(to); delete timeoutsRef.current[key]; }
                            }
                          }}
                        >
                          {torrentLoadingKeys[s.infoHash ?? s.magnetURI ?? s.url ?? String(i)] ? t('np.loading','Loading') : t('np.openMagnet','Magnet')}
                        </button>
                        { (torrentFileLists[s.infoHash ?? s.magnetURI ?? s.url ?? String(i)]) && (
                          <div className="torrent-files">
                            <div style={{fontSize:12, opacity:.8, marginTop:6}}>{t('np.torrentFiles','Files in torrent')}</div>
                            <ul style={{margin:6, paddingLeft:16}}>
                              {torrentFileLists[s.infoHash ?? s.magnetURI ?? s.url ?? String(i)].map((f, idx2) => (
                                <li key={idx2} style={{fontSize:12}}>{f.name} <span style={{opacity:.6}}>· {Math.round((f.length||0)/1024)} KB</span></li>
                              ))}
                            </ul>
                          </div>
                        )}
                        { torrentErrors[s.infoHash ?? s.magnetURI ?? s.url ?? String(i)] && (
                          <div style={{color:'var(--muted)', fontSize:12, marginTop:6}}>{torrentErrors[s.infoHash ?? s.magnetURI ?? s.url ?? String(i)]}</div>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {Array.isArray(sources) && sources.length === 0 && (
        <div className="np-hint">{t('np.noSources','No sources found')}</div>
      )}
    </div>
  );
}
