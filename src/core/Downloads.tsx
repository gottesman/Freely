import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { frontendLogger } from './FrontendLogger';
import { useAlerts } from './Alerts';
import { useDB } from './Database';

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
  fileIndex?: number;      // Optional selected file index for torrents
  status: DownloadStatus;
  bytes?: number;
  total?: number;
  // progress: normalized 0..1 if known (backend supplied percent preferred for torrents)
  progress?: number;
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

  const { getTrack } = useDB();

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
      const isUri = trackId.startsWith('spotify:track:');
      const id = isUri ? trackId.replace('spotify:track:', '') : trackId;
      // Always try DB for a name; fall back only if missing
  const rec = await getTrack(id);
  const name = rec?.spotify?.name;
      if (name && typeof name === 'string') return name;
      return trackId; // fallback to original string if no name found
    } catch (error) {
      frontendLogger.error('Error fetching track name:', error);
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
      let safeTrackId = existing?.trackId
        || knownTrackIdsRef.current[id]
        || (isLikelyInfoHash(candidateTrackId) ? '' : candidateTrackId);
      // Fallback: derive from composite id when not available or looks like a hash
      if (!safeTrackId || isLikelyInfoHash(safeTrackId)) {
        const parsed = parseTrackIdFromCompositeId(id);
        if (parsed) safeTrackId = parsed;
      }
      const next: DownloadItem = {
        id,
        sessionId,
  trackId: safeTrackId,
        sourceType: existing?.sourceType || (patch.sourceType as string) || '',
        sourceHash: existing?.sourceHash || (patch.sourceHash as string) || '',
        fileIndex: (typeof patch.fileIndex === 'number' ? patch.fileIndex : (existing?.fileIndex)),
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
            const fileIndex = typeof it.file_index === 'number' ? Number(it.file_index) : undefined;
            // Skip seeding entries that are already complete
            if (typeof bytes === 'number' && typeof total === 'number' && total > 0 && bytes >= total) continue;
            upsert(id, {
              trackId, sourceType, sourceHash,
              status: 'downloading', origin: 'cache',
              bytes,
              total,
              fileIndex,
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

        // Extract bytes/total from cache or playback payloads
        const extractBytesTotal = (payload: any, kind: 'cache' | 'playback') => {
          if (kind === 'cache') {
            const bytesRaw = (payload.bytes_downloaded ?? payload.downloaded_bytes ?? 0);
            const totalRaw = (payload.total_bytes ?? payload.size ?? undefined);
            const bytes = Number(bytesRaw) || 0;
            const total = totalRaw != null ? Number(totalRaw) : undefined;
            return { bytes, total } as { bytes: number; total?: number };
          }
          const data = payload?.data || payload;
          const downloaded = data?.downloaded_bytes ?? data?.data?.downloaded_bytes;
          const total = data?.total_bytes ?? data?.data?.total_bytes;
          return { bytes: Number(downloaded) || 0, total: typeof total === 'number' ? Number(total) : undefined } as { bytes: number; total?: number };
        };

        // Announce completion and remove item (idempotent)
        const scheduleRemoval = (id: string) => {
          if (pendingRemovalRef.current.has(id)) return;
          pendingRemovalRef.current.add(id);
          const resolvedId = knownTrackIdsRef.current[id]
            || itemsRef.current[id]?.trackId
            || parseTrackIdFromCompositeId(id)
            || 'Download';
          (async () => {
            const name = await getTrackName(resolvedId);
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
        };

  // Cache: ready
        const un1 = await listen('cache:download:ready', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId, sourceType, sourceHash } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          const { bytes, total } = extractBytesTotal(p, 'cache');
          if (typeof total === 'number' && total > 0 && bytes >= total) return; // already complete
          const fileIndex = typeof p.file_index === 'number' ? Number(p.file_index) : undefined;
          upsert(id, { trackId, sourceType, sourceHash, status: 'ready', origin: 'cache', tmpPath: p.tmpPath, bytes, total, fileIndex });
        });
        unsubs.push(un1);

        // Cache: progress
        const un2 = await listen('cache:download:progress', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId, sourceType, sourceHash } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          const { bytes, total } = extractBytesTotal(p, 'cache');
          if (typeof total === 'number' && total > 0 && bytes >= total) {
            scheduleRemoval(id);
            return;
          }
          const fileIndex = typeof p.file_index === 'number' ? Number(p.file_index) : undefined;
          upsert(id, { trackId, sourceType, sourceHash, status: 'downloading', origin: 'cache', bytes, total, fileIndex });
        });
        unsubs.push(un2);

        // Cache: complete
        const un3 = await listen('cache:download:complete', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId } = derive(p);
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          scheduleRemoval(id);
        });
        unsubs.push(un3);

        // Cache: error / paused / resumed / removed
        const simpleStatus = async (evt: any, status: DownloadStatus | 'removed') => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { id, trackId, sourceType, sourceHash } = derive(p);
          if (status === 'removed') {
            setItems(prev => { const next = { ...prev }; delete next[id]; return next; });
            return;
          }
          if (trackId) knownTrackIdsRef.current[id] = trackId;
          upsert(id, { trackId, sourceType, sourceHash, status: status as DownloadStatus, origin: 'cache' });
        };

        const un4 = await listen('cache:download:error', (evt: any) => simpleStatus(evt, 'error'));
        const un5a = await listen('cache:download:paused', (evt: any) => simpleStatus(evt, 'queued'));
        const un5b = await listen('cache:download:resumed', (evt: any) => simpleStatus(evt, 'downloading'));
        const un5c = await listen('cache:download:removed', (evt: any) => simpleStatus(evt, 'removed'));
        unsubs.push(un4, un5a, un5b, un5c);

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
        });
        unsubs.push(un6);

        // Playback: progress
        const un7 = await listen('playback:download:progress', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const { bytes, total } = extractBytesTotal(p, 'playback');
          const id = currentPlaybackIdRef.current;
          if (!id) return;
          const target = itemsRef.current[id];
          const totalNum = typeof total === 'number' ? Number(total) : (typeof target?.total === 'number' ? target.total : undefined);
          const bytesNum = Number(bytes) || 0;
          if (typeof totalNum === 'number' && totalNum > 0 && bytesNum >= totalNum) {
            scheduleRemoval(id);
          } else {
            const frac = (typeof totalNum === 'number' && totalNum > 0) ? (bytesNum / totalNum) : undefined;
            upsert(id, { status: 'downloading', origin: (target?.origin ?? 'playback'), bytes: bytesNum, total: totalNum, progress: frac });
          }
        });
        unsubs.push(un7);

        // Torrent: progress events from backend (provides percent already)
        const un8 = await listen('torrent:progress', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const key: string = String(p.id || '');
          if (!key) return;
          // percent may already be computed server-side with two decimal precision
          const percentRaw = typeof p.percent === 'number' ? p.percent : undefined;
          const normalized = (typeof percentRaw === 'number') ? Math.max(0, Math.min(100, percentRaw)) / 100 : undefined;
          const fileIndex = typeof p.fileIndex === 'number' ? p.fileIndex : undefined;
          const bytes = typeof p.verifiedBytes === 'number' ? p.verifiedBytes : (typeof p.bytes === 'number' ? p.bytes : undefined);
          const total = typeof p.total === 'number' ? p.total : undefined;
          // Attempt to locate existing download item(s) referencing this torrent by matching sourceHash
          // Our item IDs embed <trackId>_<sourceType>_<sourceHash>; so match suffix after last '_' occurrences.
          const matches: string[] = Object.keys(itemsRef.current).filter(idKey => idKey.endsWith(`_${key}`) || idKey.includes(`_${key}`));
          if (matches.length === 0) {
            // Create a synthetic placeholder item so user sees progress even before track metadata resolves.
            const syntheticId = `unknown_torrent_${key}`; // sanitized pattern
            upsert(syntheticId, {
              trackId: 'unknown',
              sourceType: 'torrent',
              sourceHash: key,
              status: 'downloading',
              fileIndex,
              bytes,
              total,
              progress: normalized ?? (typeof bytes === 'number' && typeof total === 'number' && total > 0 ? bytes / total : undefined),
              origin: 'cache'
            });
            return;
          }
          for (const idKey of matches) {
            const existing = itemsRef.current[idKey];
            const frac = normalized ?? (typeof bytes === 'number' && typeof total === 'number' && total > 0 ? bytes / total : existing?.progress);
            upsert(idKey, {
              status: 'downloading',
              bytes: typeof bytes === 'number' ? bytes : existing?.bytes,
              total: typeof total === 'number' ? total : existing?.total,
              progress: frac,
              fileIndex: existing?.fileIndex ?? fileIndex,
              sourceType: 'torrent'
            });
          }
        });
        unsubs.push(un8);

  // Torrent: completion (verified bytes == total); the backend emits this once per (torrent,fileIndex).
  // We map the info-hash (id) back to existing DownloadItems (their ids embed sourceHash) and schedule removal.
  // If only a synthetic placeholder existed (unknown_torrent_<hash>), remove that instead.
        const un9 = await listen('torrent:complete', (evt: any) => {
          if (!mounted) return;
          const p: any = evt.payload || evt;
          const key: string = String(p.id || '');
          if (!key) return;
          const matches: string[] = Object.keys(itemsRef.current).filter(idKey => idKey.endsWith(`_${key}`) || idKey.includes(`_${key}`));
          if (matches.length === 0) {
            // If we created a synthetic placeholder earlier, its id will be unknown_torrent_<hash>
            const syntheticId = `unknown_torrent_${key}`;
            if (itemsRef.current[syntheticId]) {
              scheduleRemoval(syntheticId);
            }
            return;
          }
          for (const idKey of matches) {
            scheduleRemoval(idKey);
          }
        });
        unsubs.push(un9);
      } catch (e) {
        // Tauri not available in browser preview; ignore
        if (process.env.NODE_ENV !== 'production') {
          frontendLogger.debug('[Downloads] Event API unavailable', e);
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
  list: Object.values(items).sort((a, b) => b.sessionId - a.sessionId), // Newest first for better visibility
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
