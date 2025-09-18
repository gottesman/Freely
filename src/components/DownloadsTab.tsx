import React, { useCallback, useEffect, useMemo } from 'react';
import { usePlaybackSelector } from '../core/playback';
import { useDownloads } from '../core/Downloads';
import { useI18n } from '../core/i18n';
import { buildDownloadsContextMenuItems } from './ContextMenu';
import { useContextMenu } from '../core/ContextMenuContext';
import { runTauriCommand } from '../core/tauriCommands';

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


// Optimized DownloadsItem component
interface DownloadsItemProps {
  id: string;
  isDownloading: boolean;
  progress?: number;
  isPaused?: boolean;
  trackData?: TrackData;
}

const DownloadsItem = React.memo<DownloadsItemProps>(({
  id, isDownloading, progress = 0, isPaused, trackData
}) => {
  const { t } = useI18n();
  const { openMenu } = useContextMenu();

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

  return (
    <li
      data-downloads-id={id}
      className={itemClass}
      role="button"
      aria-current={isDownloading ? 'true' : undefined}
      title={trackData?.name || id}
    >
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
        <span className='track overflow-ellipsis'>{trackData?.name || 'Loading…'}</span>
        <small className="artist overflow-ellipsis" style={{ fontSize: '11px' }}>
          {trackData?.artists?.map(a => a.name).join(', ') || ''}
        </small>
      </span>
      <button
        className='downloads-more-btn btn-icon'
        aria-label={t('common.more')}
        onClick={handleMoreClick}
      >
        <span className="material-symbols-rounded">more_horiz</span>
      </button>
    </li>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function for better performance
  return (
    prevProps.id === nextProps.id &&
    prevProps.isDownloading === nextProps.isDownloading &&
    prevProps.isPaused === nextProps.isPaused &&
    prevProps.progress === nextProps.progress &&
    prevProps.trackData === nextProps.trackData
  );
});

export const DownloadsTab = React.memo<{ collapsed?: boolean }>(({ collapsed }) => {
  const { list, prune } = useDownloads();
  const trackCache = usePlaybackSelector(s => s.trackCache ?? {});
  const { t } = useI18n();
  // Use list directly; it's already derived from context state

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
        
          return (
            <DownloadsItem
              key={d.id}
              id={d.id}
              isDownloading={d.status === 'downloading' || d.status === 'ready'}
              progress={prog}
              isPaused={paused}
              trackData={trackCache[d.trackId] as TrackData | undefined}
            />
          );
        })}
      </ul>
    </div>
  );
});

export default DownloadsTab;