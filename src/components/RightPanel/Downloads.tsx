import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlaybackSelector } from '../../core/Playback';
import { useDownloads } from '../../core/Downloads';
import { useI18n } from '../../core/i18n';
import { useContextMenu } from '../../core/ContextMenu';
import { runTauriCommand } from '../../core/TauriCommands';
import { buildDownloadsContextMenuItems } from '../Utilities/ContextMenu';
import { formatBytes } from '../Utilities/Helpers';
import { createCachedSpotifyClient } from '../../core/SpotifyClient';
import { useDB } from '../../core/Database';

// Types for better organization
interface TrackData {
  id: string;
  name: string;
  artists: { id: string, name: string }[];
  album: {
    id: string;
    images: any[];
  };
}

const getImageUrl = (images: any[]) => {
  return (window as any).imageRes?.(images, 2);
};

// Hook to fetch missing track metadata
const useMissingTrackMetadata = (trackIds: string[]) => {
  const [metadata, setMetadata] = useState<Record<string, TrackData>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fetchMissingTracks = async () => {
      const spotifyClient = await createCachedSpotifyClient();
      if (!spotifyClient) return;

      const missingIds = trackIds.filter(id => !metadata[id] && !loading.has(id));
      if (missingIds.length === 0) return;

      // Mark as loading to prevent duplicate fetches
      setLoading(prev => {
        const newSet = new Set(prev);
        missingIds.forEach(id => newSet.add(id));
        return newSet;
      });

      try {
        // Use the SpotifyClient's getTracks method which handles batching
        const tracks = await spotifyClient.getTracks(missingIds);
        
        const newMetadata: Record<string, TrackData> = {};
        tracks.forEach((track: any) => {
          if (track && track.id) {
            newMetadata[track.id] = {
              id: track.id,
              name: track.name,
              artists: track.artists || [],
              album: track.album || { id: '', images: [] }
            };
          }
        });

        setMetadata(prev => ({ ...prev, ...newMetadata }));
      } catch (e) {
        console.warn('[Downloads] Failed to fetch missing track metadata:', e);
      } finally {
        // Clear loading state
        setLoading(prev => {
          const newSet = new Set(prev);
          missingIds.forEach(id => newSet.delete(id));
          return newSet;
        });
      }
    };

    if (trackIds.length > 0) {
      fetchMissingTracks();
    }
  }, [trackIds, metadata, loading]);

  return metadata;
};


// Optimized DownloadsItem component
interface DownloadsItemProps {
  id: string;
  trackId: string;
  isDownloading: boolean;
  progress?: number;
  isPaused?: boolean;
  trackData?: TrackData;
  sourceType?: string;
  total?: number; // total bytes if known (e.g., YouTube)
}

const DownloadsItem = React.memo<DownloadsItemProps>(({
  id, trackId, isDownloading, progress = 0, isPaused, trackData, sourceType, total
}) => {
  const { t } = useI18n();
  const { openMenu } = useContextMenu();
  const { getSource } = useDB();

  // Internal state for torrent-specific telemetry
  const [torrentPeers, setTorrentPeers] = useState<number | undefined>(undefined);
  const [torrentSize, setTorrentSize] = useState<number | undefined>(undefined);

  const imgUrl = useMemo(() => getImageUrl(trackData?.album?.images || []), [trackData?.album?.images]);

  const itemClass = useMemo(() => {
    return ['downloads-item', isPaused ? 'paused' : '']
      .filter(Boolean)
      .join(' ');
  }, [isDownloading, isPaused]);

  const handleMoreClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.nativeEvent as any)?.stopImmediatePropagation?.();

    const items = buildDownloadsContextMenuItems({
      t,
      trackData,
      downloadId: id,
      isPaused: !!isPaused
    });

    await openMenu({ e: e.currentTarget as any, items });
  }, [t, trackData, openMenu]);
  // progress provided via props
  const percent = useMemo(() => {
    const clamped = Math.max(0, Math.min(1, progress));
    return Math.round(clamped * 100);
  }, [progress]);

  // Poll torrent progress to get peers and authoritative file size
  useEffect(() => {
    let active = true;
    let interval: any;
    let aborted = false;
    let cachedPort: number | null = null;

    const poll = async () => {
      if (aborted) return;
      try {
        // Only applicable for torrent sources
        if (sourceType !== 'torrent') return;

        // Selected file index is not fetched from legacy DB anymore; server progress will infer defaults
        let fileIndex: number | undefined = undefined;

        // Derive infoHash from id or sourceHash portion of id
        // Our DownloadItem id is sanitized: <trackId>_<sourceType>_<sourceHash>
        // We can safely extract the last segment(s) as sourceHash used when creating the id
        const parts = id.split('_');
        const sourceHash = parts.slice(2).join('_');
        if (!sourceHash) return;

        // Resolve server port once (fallback to 9000)
        if (cachedPort == null) {
          try {
            const status: any = await runTauriCommand('server_status');
            const port = (status && (status.port || (status.data && status.data.port))) || 9000;
            cachedPort = typeof port === 'number' ? port : 9000;
          } catch (_) {
            cachedPort = 9000;
          }
        }

        const idx = typeof fileIndex === 'number' ? fileIndex : 0;
        const url = `http://localhost:${cachedPort}/progress/${encodeURIComponent(sourceHash)}/${idx}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const json = await res.json();
        const data = json?.data || {};
        if (!active) return;
        if (typeof data.peers === 'number') setTorrentPeers(data.peers);
        if (typeof data.total === 'number' && data.total > 0) setTorrentSize(data.total);
      } catch (_) {
        // Ignore network errors
      }
    };

    if (sourceType === 'torrent' && !isPaused) {
      // Initial poll immediately, then at interval
      poll();
      interval = setInterval(poll, 3000);
    }

    return () => {
      active = false;
      aborted = true;
      if (interval) clearInterval(interval);
    };
  }, [id, trackId, sourceType, isPaused, getSource]);

  const displayPeers = useMemo(() => {
    if (sourceType === 'torrent') return torrentPeers ?? 0;
    return undefined;
  }, [sourceType, torrentPeers]);

  const displaySize = useMemo(() => {
    // For torrents, prefer authoritative torrentSize from progress polling.
    // For non-torrent sources (e.g., YouTube), show provided total size when available.
    const raw = (sourceType === 'torrent') ? torrentSize : (typeof total === 'number' ? total : undefined);
    return formatBytes(raw);
  }, [formatBytes, torrentSize, sourceType, total]);

  return (
    <li
      data-downloads-id={id}
      className={itemClass}
      role="button"
      aria-current={isDownloading ? 'true' : undefined}
      title={trackData?.name || id}
    >
      <button
        className='downloads-more-btn btn-icon'
        aria-label={t('common.more')}
        onClick={handleMoreClick}
      >
        <span className="material-symbols-rounded">more_horiz</span>
      </button>
      <span className="downloads-art" aria-hidden={imgUrl ? 'true' : undefined}>
        {imgUrl ? (
          <img src={imgUrl} alt="" loading="lazy" />
        ) : (
          <span className="material-symbols-rounded" style={{ fontSize: 18, opacity: 0.4 }}>
            music_note
          </span>
        )}
        <span
          className="download-progress-outer"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('downloads.progress', 'Download progress')}
        >
          <span
            className="download-progress-inner"
            style={{ ['--progress' as any]: `${Math.max(0, Math.min(1, progress)) * 360}deg` }}
          />
          <span
            className="download-progress-label"
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600 }}
          >
            {percent}%
          </span>
        </span>
      </span>
      <span className="track overflow-ellipsis" style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
        <span className='track overflow-ellipsis'>
          {trackData?.name || 'Unknown track'}
        </span>
        <small className="artist overflow-ellipsis" style={{ fontSize: '11px' }}>
          {trackData?.artists?.map(a => a.name).join(', ') || ''}
        </small>
      </span>
      <span className={`download-info${sourceType ? ` source-${sourceType}` : ''}`} aria-hidden="true">
        {sourceType === 'torrent' ? (          
          <span className='download-info-peers'><span className='download-info-label'>{t('downloads.peers')}:</span>{displayPeers ?? 0}</span>
        ) : null}
        <span className='download-info-size'><span className='download-info-label'>{t('downloads.size')}:</span>{displaySize}</span>
      </span>      
    </li>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function for better performance
  return (
    prevProps.id === nextProps.id &&
    prevProps.trackId === nextProps.trackId &&
    prevProps.isDownloading === nextProps.isDownloading &&
    prevProps.isPaused === nextProps.isPaused &&
    prevProps.progress === nextProps.progress &&
    prevProps.trackData === nextProps.trackData &&
    prevProps.sourceType === nextProps.sourceType &&
    prevProps.total === nextProps.total
  );
});

export const DownloadsTab = React.memo<{ collapsed?: boolean }>(({ collapsed }) => {
  const { list, prune } = useDownloads();
  const trackCache = usePlaybackSelector(s => s.trackCache ?? {});
  const { t } = useI18n();
  
  // Extract track IDs from downloads
  const trackIds = useMemo(() => 
    list.map(d => d.trackId).filter(Boolean),
    [list]
  );
  
  // Fetch missing track metadata
  const missingMetadata = useMissingTrackMetadata(trackIds);
  
  // Combine trackCache with fetched metadata and add URI/ID aliases so lookups work with either form
  const combinedTrackData = useMemo(() => {
    const base: Record<string, TrackData> = {
      ...(trackCache as any),
      ...missingMetadata
    };
    const withAliases: Record<string, TrackData> = { ...base };
    for (const [key, val] of Object.entries(base)) {
      if (!key) continue;
      if (key.startsWith('spotify:track:')) {
        const raw = key.slice('spotify:track:'.length);
        if (raw && !withAliases[raw]) withAliases[raw] = val as any;
      } else {
        const uri = `spotify:track:${key}`;
        if (!withAliases[uri]) withAliases[uri] = val as any;
      }
    }
    return withAliases;
  }, [trackCache, missingMetadata]);

  // Listen to default CustomEvents for downloads actions emitted by ContextMenu
  useEffect(() => {
    const onPause = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id) return;
      // Parse id => trackId, sourceType, sourceHash
      const [trackId, sourceType, ...rest] = id.split('_');
      const sourceHash = rest.join('_');
      if (!trackId || !sourceType || !sourceHash) return;
      // Call backend command
      (async () => {
        try {
          const res: any = await runTauriCommand('downloads_pause', {
            trackId, sourceType, sourceHash
          });
        } catch {}
      })();
    };
    const onResume = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id) return;
      const [trackId, sourceType, ...rest] = id.split('_');
      const sourceHash = rest.join('_');
      if (!trackId || !sourceType || !sourceHash) return;
      (async () => {
        try {
          const res: any = await runTauriCommand('downloads_resume', {
            trackId, sourceType, sourceHash
          });
        } catch {}
      })();
    };
    const onRemove = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id) return;
      const [trackId, sourceType, ...rest] = id.split('_');
      const sourceHash = rest.join('_');
      if (!trackId || !sourceType || !sourceHash) return;
      (async () => {
        try {
          const res: any = await runTauriCommand('downloads_remove', {
            trackId, sourceType, sourceHash
          });
        } catch {}
        // Prune immediately for UX
        try { prune({ olderThanMs: 0 }); } catch {}
      })();
    };
    window.addEventListener('freely:downloads:pause', onPause as EventListener);
    window.addEventListener('freely:downloads:resume', onResume as EventListener);
    window.addEventListener('freely:downloads:remove', onRemove as EventListener);
    return () => {
      window.removeEventListener('freely:downloads:pause', onPause as EventListener);
      window.removeEventListener('freely:downloads:resume', onResume as EventListener);
      window.removeEventListener('freely:downloads:remove', onRemove as EventListener);
    };
  }, [prune]);

  const panelClass = useMemo(() => {
    return `rt-panel ${collapsed ? 'collapsed' : ''}`;
  }, [collapsed]);

  // Early return for empty downloads
  if (!list.length) {
    return (
      <div className="rt-panel" role="tabpanel">
        <div className="rt-placeholder">{t('downloads.empty')}</div>
      </div>
    );
  }

  return (
    <div className={panelClass} role="tabpanel" aria-label={t('downloads.title')}>
      <ul className="np-downloads-list" role="list">
        {list.map((d) => {
          const total = typeof d.total === 'number' && d.total > 0 ? d.total : undefined;
          const bytes = typeof d.bytes === 'number' ? d.bytes : 0;
          const prog = total ? Math.max(0, Math.min(1, bytes / total)) : 0;
          // Consider 'queued' as paused. 'ready' means playable but still downloading, not paused.
          const paused = d.status === 'queued';
          const td = combinedTrackData[d.trackId];
        
          return (
            <DownloadsItem
              key={d.id}
              id={d.id}
              trackId={d.trackId}
              isDownloading={d.status === 'downloading' || d.status === 'ready'}
              progress={prog}
              isPaused={paused}
              trackData={td as TrackData | undefined}
              sourceType={d.sourceType}
              total={total}
            />
          );
        })}
      </ul>
    </div>
  );
});

export default DownloadsTab;