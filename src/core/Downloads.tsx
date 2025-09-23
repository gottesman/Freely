import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAlerts } from './Alerts';
import { runTauriCommand } from './TauriCommands';
import { createCachedSpotifyClient } from './SpotifyClient';

// Contract
// - id: create_cache_filename(trackId, sourceType, sourceHash)
// - We aggregate two sources of progress:
//   1) Explicit cache downloads via cache:download:* events
//   2) Streaming downloads from BASS while playing via playback:download:progress events
// - We expose a map of active items keyed by id with bytes/total, status, and paths

export type DownloadStatus = 'queued' | 'ready' | 'downloading' | 'completed' | 'error';

export interface DownloadItem {
  id: string;              // <trackId>_<sourceType>_<sourceHash>
  sessionId: number;       // Unique sequential ID for this session
  trackId: string;
  sourceType: string;
  sourceHash: string;
  status: DownloadStatus;
  bytes?: number;
  total?: number;
  tmpPath?: string;        // .part path when provided
  cachedPath?: string;     // final path when completed
  updatedAt: number;
  // origin indicates where we first saw this activity
  origin?: 'cache' | 'playback';
}

interface DownloadsContextValue {
  items: Record<string, DownloadItem>;
  list: DownloadItem[];
  get: (id: string) => DownloadItem | undefined;
  // Helper to synthesize an id from parts
  makeId: (trackId: string, sourceType: string, sourceHash: string) => string;
  // Clear completed/errors (optional maintenance)
  prune: (opts?: { olderThanMs?: number }) => void;
}

const DownloadsContext = createContext<DownloadsContextValue | undefined>(undefined);

function createId(trackId: string, sourceType: string, sourceHash: string) {
  // Mirror the sanitizer in Rust: keep alnum, '_' and '-'; replace others with '_'
  const sanitize = (s: string) => (s || '')
    .split('')
    .map(c => (/^[a-zA-Z0-9_-]$/.test(c) ? c : '_'))
    .join('');
  return `${sanitize(trackId)}_${sourceType}_${sanitize(sourceHash)}`;
}

export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Record<string, DownloadItem>>({});
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const currentPlaybackIdRef = useRef<string | null>(null);
  // Session-based sequential ID counter - resets on app start
  const sessionIdCounterRef = useRef<number>(1);
  // Cache of known trackIds per composite download id (helps when backend sends only hashes)
  const knownTrackIdsRef = useRef<Record<string, string>>({});
  const pendingRemovalRef = useRef<Set<string>>(new Set());
  const { push: pushAlert } = (() => {
    try {
      return useAlerts();
    } catch {
      // In case AlertsProvider isn't mounted above, provide a no-op fallback
      return { push: (_msg: string) => {} } as any;
    }
  })();

  const spotifyClient = useMemo(() => createCachedSpotifyClient(), []);

  // Heuristics
  const isLikelyInfoHash = (s: any): boolean => {
    if (typeof s !== 'string') return false;
    const hex40 = /^[a-fA-F0-9]{40}$/;
    const base32_32 = /^[A-Z2-7]{32}$/; // BT base32 variant often uppercase
    return hex40.test(s) || base32_32.test(s);
  };

  // Attempt to recover original trackId from the composite id
  const parseTrackIdFromCompositeId = (compositeId: string): string | undefined => {
    if (!compositeId) return undefined;
    const parts = compositeId.split('_');
    if (parts.length < 3) return undefined;
    const sourceHash = parts[parts.length - 1];
    const sourceType = parts[parts.length - 2];
    const trackSanitized = parts.slice(0, parts.length - 2).join('_');
    // Only safe reconstruction we support: spotify:track:<id>
    if (trackSanitized.startsWith('spotify_track_')) {
      const id = trackSanitized.substring('spotify_track_'.length);
      if (id) return `spotify:track:${id}`;
    }
    // Future: support other well-known prefixes if needed
    return undefined;
  };

  // Function to get track name from track ID
  const getTrackName = async (trackId: string): Promise<string> => {
    try {
      if (trackId.startsWith('spotify:track:')) {
        const id = trackId.replace('spotify:track:', '');
        const track = await spotifyClient.getTrack(id);
        return track?.name || trackId;
      }
      return trackId;
    } catch (error) {
      console.error('Error fetching track name:', error);
      return trackId;
    }
  };

  // Stable helper to upsert an item
  const upsert = (id: string, patch: Partial<DownloadItem>) => {
    setItems(prev => {
      const existing = prev[id];
      // Assign sessionId only for new items
      const sessionId = existing?.sessionId ?? sessionIdCounterRef.current++;
      
      // Prefer existing or known trackId; avoid overwriting with probable infohashes
      const candidateTrackId = (patch.trackId as string) || '';
      const safeTrackId = existing?.trackId
        || knownTrackIdsRef.current[id]
        || (isLikelyInfoHash(candidateTrackId) ? '' : candidateTrackId);
      const next: DownloadItem = {
        id,
        sessionId,
        trackId: safeTrackId,
        sourceType: existing?.sourceType || (patch.sourceType as string) || '',
        sourceHash: existing?.sourceHash || (patch.sourceHash as string) || '',
        status: existing?.status || 'queued',
        bytes: existing?.bytes,
        total: existing?.total,
        tmpPath: existing?.tmpPath,
        cachedPath: existing?.cachedPath,
        origin: existing?.origin,
        updatedAt: Date.now(),
        ...patch,
      };
      // Ensure sessionId is not overwritten by patch
      next.sessionId = sessionId;
      if (patch.status) next.updatedAt = Date.now();
      return { ...prev, [id]: next };
    });
  };

  // Event listeners from backend cache pipeline
  useEffect(() => {
    let mounted = true;
    const unsubs: Array<() => void> = [];
    (async () => {
      // First: best-effort fetch of current inflight downloads for initial UI state
      try {
        const res: any = await (await import('./TauriCommands')).runTauriCommand('cache_list_inflight');
        const items = (res as any)?.items || (res as any)?.data?.items || [];
        if (Array.isArray(items)) {
          for (const it of items) {
            const trackId = String(it.trackId ?? '');
            const sourceType = String(it.sourceType ?? '');
            const sourceHash = String(it.sourceHash ?? '');
            const id = createId(trackId, sourceType, sourceHash);
            const bytes = typeof it.bytes_downloaded === 'number' ? Number(it.bytes_downloaded) : undefined;
            const total = typeof it.total_bytes === 'number' ? Number(it.total_bytes) : undefined;
            // Skip seeding entries that are already complete
            if (typeof bytes === 'number' && typeof total === 'number' && total > 0 && bytes >= total) continue;
            upsert(id, {
              trackId, sourceType, sourceHash,
              status: 'downloading', origin: 'cache',
              bytes,
              total,
            });
          }
        }
      } catch {}

      try {
        const { listen } = await import('@tauri-apps/api/event');

        // Helper to compute id and common fields from payload
        const derive = (p: any) => {
          const trackId = String(p.trackId ?? '');
          const sourceType = String(p.sourceType ?? '');
          const sourceHash = String(p.sourceHash ?? '');
          const id = createId(trackId, sourceType, sourceHash);
          return { id, trackId, sourceType, sourceHash };
        };

        const un1 = await listen('cache:download:ready', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId, sourceType, sourceHash } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          const bytes = Number(p.bytes_downloaded || 0) || 0;
          const total = p.total_bytes != null ? Number(p.total_bytes) : undefined;
          // If already complete, skip adding
          if (typeof total === 'number' && total > 0 && bytes >= total) return;
          upsert(id, {
            trackId, sourceType, sourceHash,
            status: 'ready', origin: 'cache',
            tmpPath: p.tmpPath,
            bytes,
            total,
          });
        });
        unsubs.push(un1);

        const un2 = await listen('cache:download:progress', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId, sourceType, sourceHash } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          const bytes = Number(p.bytes_downloaded || 0) || 0;
          const total = p.total_bytes != null ? Number(p.total_bytes) : undefined;
          // If completed (bytes >= total when total is known), announce and schedule removal
          if (typeof total === 'number' && total > 0 && bytes >= total) {
            if (!pendingRemovalRef.current.has(id)) {
              pendingRemovalRef.current.add(id);
              const trackId = knownTrackIdsRef.current[id]
                || itemsRef.current[id]?.trackId
                || parseTrackIdFromCompositeId(id)
                || 'Download';
              (async () => {
                const name = await getTrackName(trackId);
                try { pushAlert(`${name} downloaded`, 'info'); } catch {}
              })();
              setTimeout(() => {
                setItems(prev => {
                  const next = { ...prev };
                  delete next[id];
                  return next;
                });
                pendingRemovalRef.current.delete(id);
              }, 1000);
            }
            return;
          }
          upsert(id, {
            trackId, sourceType, sourceHash,
            status: 'downloading', origin: 'cache',
            bytes,
            total,
          });
        });
        unsubs.push(un2);

        const un3 = await listen('cache:download:complete', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          if (!pendingRemovalRef.current.has(id)) {
            pendingRemovalRef.current.add(id);
            const currentTrackId = knownTrackIdsRef.current[id]
              || itemsRef.current[id]?.trackId
              || trackId
              || parseTrackIdFromCompositeId(id)
              || 'Download';
            (async () => {
              const name = await getTrackName(currentTrackId);
              try { pushAlert(`${name} downloaded`, 'info'); } catch {}
            })();
            setTimeout(() => {
              setItems(prev => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
              pendingRemovalRef.current.delete(id);
            }, 1000);
          }
        });
        unsubs.push(un3);

        const un4 = await listen('cache:download:error', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId, sourceType, sourceHash } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          upsert(id, {
            trackId, sourceType, sourceHash,
            status: 'error', origin: 'cache',
          });
        });
        unsubs.push(un4);

        // Handle pause/resume/remove events from backend controls
        const un5a = await listen('cache:download:paused', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId, sourceType, sourceHash } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          // Represent paused state as 'queued' so UI shows Pause/Resume state consistently
          upsert(id, {
            trackId, sourceType, sourceHash,
            status: 'queued', origin: 'cache',
          });
        });
        unsubs.push(un5a);

        const un5b = await listen('cache:download:resumed', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId, sourceType, sourceHash } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          upsert(id, {
            trackId, sourceType, sourceHash,
            status: 'downloading', origin: 'cache',
          });
        });
        unsubs.push(un5b);

        const un5c = await listen('cache:download:removed', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id } = derive(p);
          setItems(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        });
        unsubs.push(un5c);

        // Playback ack: only track the current id, do NOT create a list item yet
        const un6 = await listen('playback:start:ack', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const trackId = String(p.trackId ?? '');
          const sourceType = String(p.sourceType ?? '');
          const sourceHash = String(p.sourceHash ?? '');
          if (!trackId || !sourceType || !sourceHash) return;
          const id = createId(trackId, sourceType, sourceHash);
          currentPlaybackIdRef.current = id;
          knownTrackIdsRef.current[id] = trackId;
          // Avoid upserting here to prevent adding cached items that won't download
        });
        unsubs.push(un6);

        // Listen for playback download progress events (replaces polling)
        const un7 = await listen('playback:download:progress', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const data = p?.data || p;
          if (!data || data.success === false) return;
          
          const downloaded = data.downloaded_bytes ?? data.data?.downloaded_bytes;
          const total = data.total_bytes ?? data.data?.total_bytes;
          if (typeof downloaded === 'number') {
            const id = currentPlaybackIdRef.current;
            if (id) {
              const target = itemsRef.current[id];
              const totalNum = typeof total === 'number' ? Number(total) : (typeof target?.total === 'number' ? target.total : undefined);
              const bytesNum = Number(downloaded) || 0;
              // If we know total and reached/exceeded it, alert and schedule removal
              if (typeof totalNum === 'number' && totalNum > 0 && bytesNum >= totalNum) {
                if (!pendingRemovalRef.current.has(id)) {
                  pendingRemovalRef.current.add(id);
                  const trackId = knownTrackIdsRef.current[id]
                    || itemsRef.current[id]?.trackId
                    || parseTrackIdFromCompositeId(id)
                    || 'Download';
                  (async () => {
                    const name = await getTrackName(trackId);
                    try { pushAlert(`${name} downloaded`, 'info'); } catch {}
                  })();
                  setTimeout(() => {
                    setItems(prev => {
                      const next = { ...prev };
                      delete next[id];
                      return next;
                    });
                    pendingRemovalRef.current.delete(id);
                  }, 1000);
                }
              } else {
                upsert(id, {
                  status: 'downloading', origin: (target?.origin ?? 'playback'),
                  bytes: bytesNum,
                  total: totalNum,
                });
              }
            }
          }
        });
        unsubs.push(un7);
      } catch (e) {
        // Tauri not available in browser preview; ignore
        if (process.env.NODE_ENV !== 'production') {
          console.debug('[Downloads] Event API unavailable', e);
        }
      }
    })();

    return () => {
      mounted = false;
      unsubs.forEach(u => { try { u(); } catch {} });
    };
  }, []);

  const value = useMemo<DownloadsContextValue>(() => ({
    items,
    list: Object.values(items).sort((a, b) => a.sessionId - b.sessionId), // Sort by session order (oldest first)
    get: (id: string) => items[id],
    makeId: createId,
    prune: ({ olderThanMs } = {}) => {
      const threshold = olderThanMs ?? 5 * 60 * 1000; // default: 5 minutes
      const now = Date.now();
      setItems(prev => {
        const next: Record<string, DownloadItem> = {};
        for (const [k, v] of Object.entries(prev)) {
          const keep = v.status === 'downloading' || v.status === 'ready' || (now - v.updatedAt) < threshold;
          if (keep) next[k] = v;
        }
        return next;
      });
    }
  }), [items]);

  return (
    <DownloadsContext.Provider value={value}>
      {children}
    </DownloadsContext.Provider>
  );
}

export function useDownloads(): DownloadsContextValue {
  const ctx = useContext(DownloadsContext);
  if (!ctx) throw new Error('useDownloads must be used within DownloadsProvider');
  return ctx;
}
