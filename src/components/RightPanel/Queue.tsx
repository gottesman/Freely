import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { frontendLogger } from '../../core/FrontendLogger';
import { usePlaybackSelector } from '../../core/Playback';
import { useI18n } from '../../core/i18n';
import { useContextMenu } from '../../core/ContextMenu';
import { useDB } from '../../core/Database';
import { createCachedSpotifyClient } from '../../core/SpotifyClient';
import { buildQueueContextMenuItems } from '../Utilities/ContextMenu';

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

interface DragState {
  from: number;
  over: number;
  dragging: true;
  pointerId: number;
  dy: number;
  itemHeight: number;
  grabOffset: number;
}

interface QueueState {
  dragState: DragState | null;
  handleHoverIndex: number | null;
}

interface InteractionState {
  startX: number;
  startY: number;
  isDragging: boolean;
  pointerId: number;
  index: number;
}

// Constants
const DRAG_THRESHOLD = 5;

// Utility functions
const dispatchPlaybackEvent = (eventType: string, detail: any) => {
  window.dispatchEvent(new CustomEvent(`freely:playback:${eventType}`, { detail }));
};

const getImageUrl = (images: any[]) => {
  return (window as any).imageRes?.(images, 2);
};

const calculateTransform = (dragState: DragState | null, index: number): string => {
  if (!dragState) return '';
  
  const { from, over, dy, itemHeight } = dragState;
  const gap = 6;

  if (index === from) {
    return `translateY(${dy}px)`;
  } else if (from < over && index > from && index <= over) {
    return `translateY(-${itemHeight + gap}px)`;
  } else if (from > over && index < from && index >= over) {
    return `translateY(${itemHeight + gap}px)`;
  }
  
  return '';
};

// Optimized QueueItem component
interface QueueItemProps {
  id: string;
  index: number;
  isActive: boolean;
  dragState: DragState | null;
  trackData?: TrackData;
  handleHoverIndex: number | null;
  onPointerDown: (ev: React.PointerEvent, index: number) => void;
  onHover: (index: number | null) => void;
  playTrack: (index: number) => void;
  originalIndex: number;
  onRemove: (originalIndex: number) => void;
  onPlayNext: (originalIndex: number) => void;
  queueIds: string[];
  currentIndex: number;
}

const QueueItem = React.memo<QueueItemProps>(({
  id, index, isActive, dragState, trackData, handleHoverIndex, 
  onPointerDown, onHover, playTrack, originalIndex, onRemove, 
  onPlayNext, queueIds, currentIndex
}) => {
  const { t } = useI18n();
  const { openMenu } = useContextMenu();

  const isDraggingItem = dragState?.from === index;
  const imgUrl = useMemo(() => getImageUrl(trackData?.album?.images || []), [trackData?.album?.images]);
  const transform = useMemo(() => calculateTransform(dragState, index), [dragState, index]);
  
  const itemClass = useMemo(() => {
    return ['queue-item', isActive ? 'active' : '', isDraggingItem ? 'dragging-item' : '']
      .filter(Boolean)
      .join(' ');
  }, [isActive, isDraggingItem]);

  const itemStyle = useMemo((): React.CSSProperties => ({
    transform,
    zIndex: isDraggingItem ? 2 : 1,
    position: isDraggingItem ? 'relative' : 'static'
  }), [transform, isDraggingItem]);

  const handlePointerDownClick = useCallback((ev: React.PointerEvent) => {
    if ((ev.target as HTMLElement)?.closest('.queue-more-btn')) return;
    onPointerDown(ev, index);
  }, [onPointerDown, index]);

  const handlePlayClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    playTrack(index);
  }, [playTrack, index]);

  const handleMouseEnter = useCallback(() => onHover(index), [onHover, index]);
  const handleMouseLeave = useCallback(() => onHover(null), [onHover]);

  const handleMoreClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.nativeEvent as any)?.stopImmediatePropagation?.();

    const items = buildQueueContextMenuItems({
      t,
      trackData,
      queueList: queueIds,
      currentIndex,
      queueRemovable: !isActive,
      queueOptions: !isActive
    });
    
    await openMenu({ e: e.currentTarget as any, items });
  }, [t, trackData, queueIds, currentIndex, isActive, openMenu]);

  return (
    <li
      data-queue-id={id}
      className={itemClass}
      style={itemStyle}
      onPointerDown={handlePointerDownClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="button"
      aria-current={isActive ? 'true' : undefined}
      title={trackData?.name || id}
    >
      <span className="queue-art" aria-hidden={imgUrl ? 'true' : undefined}>
        {imgUrl ? (
          <img src={imgUrl} alt="" loading="lazy" />
        ) : (
          <span className="material-symbols-rounded" style={{ fontSize: 18, opacity: 0.4 }}>
            music_note
          </span>
        )}
        {!isActive && !dragState && handleHoverIndex === index && (
          <button
            type="button"
            className="queue-play-btn"
            aria-label={t('queue.play', undefined, { track: trackData?.name || 'track' })}
            onClick={handlePlayClick}
          >
            <span className="material-symbols-rounded filled">play_arrow</span>
          </button>
        )}
      </span>
      <span className="track overflow-ellipsis" style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
        <span className='track overflow-ellipsis'>{trackData?.name || 'Loading…'}</span>
        <small className="artist overflow-ellipsis" style={{ fontSize: '11px' }}>
          {trackData?.artists?.map(a => a.name).join(', ') || ''}
        </small>
      </span>
      <button
        className='queue-more-btn btn-icon'
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
    prevProps.index === nextProps.index &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.dragState === nextProps.dragState &&
    prevProps.trackData === nextProps.trackData &&
    prevProps.handleHoverIndex === nextProps.handleHoverIndex &&
    prevProps.originalIndex === nextProps.originalIndex &&
    prevProps.currentIndex === nextProps.currentIndex &&
    prevProps.queueIds.length === nextProps.queueIds.length
  );
});

// Custom hook for queue operations
const useQueueOperations = () => {
  return useMemo(() => ({
    playNext: (originalIndex: number, currentIndex: number, queueIds: string[]) => {
      if (originalIndex === currentIndex) return;
      
      const nextQueue = [...queueIds];
      const [trackId] = nextQueue.splice(originalIndex, 1);
      let insertPos = currentIndex + 1;
      
      if (originalIndex < currentIndex) insertPos -= 1;
      if (insertPos > nextQueue.length) insertPos = nextQueue.length;
      
      nextQueue.splice(insertPos, 0, trackId);
      dispatchPlaybackEvent('reorderQueue', { queueIds: nextQueue });
    },

    removeFromQueue: (originalIndex: number, currentIndex: number, queueIds: string[]) => {
      if (originalIndex === currentIndex) return;
      
      const nextQueue = queueIds.filter((_, i) => i !== originalIndex);
      dispatchPlaybackEvent('reorderQueue', { queueIds: nextQueue });
    },

    reorderQueue: (dragState: DragState, currentIndex: number, queueIds: string[]) => {
      if (dragState.from === dragState.over) return;
      
      const currId = queueIds[currentIndex];
      const rest = queueIds.filter((_, i) => i !== currentIndex);
      const nextRest = [...rest];
      const [movedItem] = nextRest.splice(dragState.from, 1);
      nextRest.splice(dragState.over, 0, movedItem);

      const newQueue: string[] = [];
      const insertAt = Math.min(Math.max(0, currentIndex), nextRest.length);
      newQueue.push(...nextRest.slice(0, insertAt));
      if (typeof currId !== 'undefined') newQueue.push(currId);
      newQueue.push(...nextRest.slice(insertAt));
      
      dispatchPlaybackEvent('reorderQueue', { queueIds: newQueue });
    },

    playAt: (index: number) => {
      dispatchPlaybackEvent('playAt', { index });
    }
  }), []);
};

// Custom hook for fetching missing track metadata
const useMissingTrackFetcher = (queueIds: string[], trackCache: Record<string, any>) => {
  const { ready, getApiCache, setApiCache } = useDB();
  const [additionalTrackData, setAdditionalTrackData] = useState<Record<string, TrackData>>({});
  const [loadingTracks, setLoadingTracks] = useState<Set<string>>(new Set());

  // Memoize Spotify client with database cache
  const spotifyClient = useMemo(() => {
    return ready ? createCachedSpotifyClient({ getApiCache, setApiCache }) : null;
  }, [ready, getApiCache, setApiCache]);

  useEffect(() => {
    if (!spotifyClient || !queueIds.length) return;

    const fetchMissingTracks = async () => {
      // Find tracks that aren't in either cache and aren't currently loading
      const missingIds = queueIds.filter(id => 
        !trackCache[id] && !additionalTrackData[id] && !loadingTracks.has(id)
      );

      if (missingIds.length === 0) return;

      // Mark tracks as loading
      setLoadingTracks(prev => {
        const newSet = new Set(prev);
        missingIds.forEach(id => newSet.add(id));
        return newSet;
      });

      try {
        const tracks = await spotifyClient.getTracks(missingIds);
        
        const newTrackData: Record<string, TrackData> = {};
        tracks.forEach((track: any) => {
          if (track && track.id) {
            newTrackData[track.id] = {
              id: track.id,
              name: track.name,
              artists: track.artists || [],
              album: track.album || { id: '', images: [] }
            };
          }
        });

        setAdditionalTrackData(prev => ({ ...prev, ...newTrackData }));
      } catch (e) {
        frontendLogger.warn('[Queue] Failed to fetch missing track metadata:', e);
      } finally {
        // Clear loading state
        setLoadingTracks(prev => {
          const newSet = new Set(prev);
          missingIds.forEach(id => newSet.delete(id));
          return newSet;
        });
      }
    };

    fetchMissingTracks();
  }, [spotifyClient, queueIds, trackCache, additionalTrackData, loadingTracks]);

  // Merge track data from both sources
  const mergedTrackData = useMemo(() => {
    const merged: Record<string, TrackData> = {};
    
    // Add data from trackCache first
    queueIds.forEach(id => {
      if (trackCache[id]) {
        merged[id] = trackCache[id] as TrackData;
      }
    });
    
    // Add additional fetched data
    Object.keys(additionalTrackData).forEach(id => {
      if (!merged[id]) {
        merged[id] = additionalTrackData[id];
      }
    });
    
    return merged;
  }, [queueIds, trackCache, additionalTrackData]);

  return mergedTrackData;
};

// Custom hook for drag interactions
const useDragInteraction = (
  queueIds: string[],
  currentIndex: number,
  setState: React.Dispatch<React.SetStateAction<QueueState>>
) => {
  const listRef = useRef<HTMLUListElement | null>(null);
  const positionsRef = useRef<DOMRect[]>([]);
  const animationFrameRef = useRef<number>();
  const dragStateRef = useRef<DragState | null>(null);
  const interactionRef = useRef<InteractionState | null>(null);
  const queueOps = useQueueOperations();

  const handlePointerMove = useCallback((ev: PointerEvent) => {
    if (!interactionRef.current || ev.pointerId !== interactionRef.current.pointerId) return;
    
    if (interactionRef.current.isDragging) {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(() => {
        setState(prevState => {
          const currentDragState = prevState.dragState;
          if (!currentDragState) return prevState;
          
          const baseRect = positionsRef.current[currentDragState.from];
          if (!baseRect) return prevState;

          const dy = ev.clientY - (baseRect.top + currentDragState.grabOffset);
          const listTop = positionsRef.current[0]?.top || 0;
          const offsetY = ev.clientY - listTop;
          
          let newOver = currentDragState.from;
          for (let i = 0; i < positionsRef.current.length; i++) {
            const r = positionsRef.current[i];
            if (offsetY < (r.top - listTop) + r.height / 2) { 
              newOver = i; 
              break; 
            }
            newOver = i;
          }
          
          const newDragState = { ...currentDragState, dy, over: newOver };
          dragStateRef.current = newDragState;
          return { ...prevState, dragState: newDragState };
        });
      });
    } else {
      const dx = Math.abs(ev.clientX - interactionRef.current.startX);
      const dy = Math.abs(ev.clientY - interactionRef.current.startY);
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        interactionRef.current.isDragging = true;
        const { index, pointerId } = interactionRef.current;
        
        const list = listRef.current;
        if (!list) return;

        positionsRef.current = Array.from(list.children).map(el => 
          (el as HTMLElement).getBoundingClientRect()
        );
        const rect = positionsRef.current[index];
        if (!rect) return;

        const newDragState: DragState = {
          from: index,
          over: index,
          dragging: true,
          pointerId: pointerId,
          dy: ev.clientY - (rect.top + (ev.clientY - rect.top)),
          itemHeight: rect.height,
          grabOffset: ev.clientY - rect.top,
        };
        
        dragStateRef.current = newDragState;
        setState(prevState => ({ ...prevState, dragState: newDragState }));
      }
    }
  }, [setState]);

  const cleanupInteraction = useCallback(() => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    if (interactionRef.current) {
      const target = listRef.current?.children[interactionRef.current.index] as HTMLElement | undefined;
      if (target?.hasPointerCapture(interactionRef.current.pointerId)) {
        target.releasePointerCapture(interactionRef.current.pointerId);
      }
    }
    interactionRef.current = null;
  }, [handlePointerMove]);

  const handlePointerUp = useCallback((ev: PointerEvent) => {
    if (!interactionRef.current || ev.pointerId !== interactionRef.current.pointerId) return;
    
    const finalDragState = dragStateRef.current;

    if (finalDragState && interactionRef.current.isDragging) {
      queueOps.reorderQueue(finalDragState, currentIndex, queueIds);
    } else if (!interactionRef.current.isDragging) {
      const currIdx = currentIndex;
      const restIndex = interactionRef.current.index;
      const origIndex = restIndex < currIdx ? restIndex : restIndex + 1;
      queueOps.playAt(origIndex);
    }
    
    setState(prevState => ({ ...prevState, dragState: null }));
    cleanupInteraction();
  }, [queueIds, currentIndex, cleanupInteraction, queueOps, setState]);

  const handlePointerDown = useCallback((ev: React.PointerEvent, index: number) => {
    if (ev.button !== 0 || interactionRef.current) return;

    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);

    interactionRef.current = {
      startX: ev.clientX,
      startY: ev.clientY,
      isDragging: false,
      pointerId: ev.pointerId,
      index,
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  }, [handlePointerMove, handlePointerUp]);

  useEffect(() => {
    return () => {
      cleanupInteraction();
    };
  }, [cleanupInteraction]);

  return {
    listRef,
    handlePointerDown
  };
};

export const QueueTab = React.memo<{ collapsed?: boolean }>(({ collapsed }) => {
  // Fallbacks ensure we render correctly before the first playback snapshot arrives
  const queueIds = usePlaybackSelector(s => s.queueIds) ?? [];
  const currentIndex = usePlaybackSelector(s => s.currentIndex) ?? 0;
  const trackCache = usePlaybackSelector(s => s.trackCache) ?? {};
  const { t } = useI18n();
  
  const [state, setState] = useState<QueueState>({
    dragState: null,
    handleHoverIndex: null
  });

  const queueOps = useQueueOperations();
  const { listRef, handlePointerDown } = useDragInteraction(queueIds, currentIndex, setState);
  
  // Use the new hook to fetch missing track data
  const mergedTrackData = useMissingTrackFetcher(queueIds, trackCache);

  // Memoized derived values
  const queueData = useMemo(() => {
    // Debug visibility to help diagnose empty queue list
    try { frontendLogger.debug('[QueueTab] queueIds:', queueIds.length, 'currentIndex:', currentIndex); } catch {}
    const currentId = queueIds[currentIndex];
    const restIds = queueIds.filter((_, i) => i !== currentIndex);
    return { currentId, restIds };
  }, [queueIds, currentIndex]);

  const setHandleHoverIndex = useCallback((index: number | null) => {
    setState(prevState => ({ ...prevState, handleHoverIndex: index }));
  }, []);

  // Stable event handlers
  const handlePlayNext = useCallback((originalIndex: number) => {
    queueOps.playNext(originalIndex, currentIndex, queueIds);
  }, [queueOps, currentIndex, queueIds]);

  const handleRemoveFromQueue = useCallback((originalIndex: number) => {
    queueOps.removeFromQueue(originalIndex, currentIndex, queueIds);
  }, [queueOps, currentIndex, queueIds]);

  const handlePlayTrack = useCallback((idx: number) => {
    const origIndex = idx < currentIndex ? idx : idx + 1;
    queueOps.playAt(origIndex);
  }, [queueOps, currentIndex]);

  // FLIP animation refs
  const prevQueueRef = useRef<string[] | null>(null);
  const prevCurrentIndexRef = useRef<number | null>(null);
  const prevRectsRef = useRef<Record<string, DOMRect>>({});

  // FLIP animation logic
  useLayoutEffect(() => {
    try {
      const prevQueue = prevQueueRef.current;
      const prevCurrIdx = prevCurrentIndexRef.current;

      const ids = queueIds;
      const currentRects: Record<string, DOMRect> = {};
      ids.forEach(id => {
        const el = document.querySelector(`[data-queue-id="${id}"]`) as HTMLElement | null;
        if (el) currentRects[id] = el.getBoundingClientRect();
      });

      if (prevQueue && typeof prevCurrIdx === 'number' && prevCurrIdx !== currentIndex) {
        const prevRestFirstId = prevQueue.filter((_, i) => i !== prevCurrIdx)[0];
        if (prevRestFirstId) {
          const prevRect = prevRectsRef.current[prevRestFirstId];
          const currRect = currentRects[prevRestFirstId];
          const el = document.querySelector(`[data-queue-id="${prevRestFirstId}"]`) as HTMLElement | null;
          if (prevRect && currRect && el) {
            const deltaY = prevRect.top - currRect.top;

            el.style.transition = 'none';
            el.style.transform = `translateY(${deltaY}px)`;
            el.offsetHeight; // Force reflow

            requestAnimationFrame(() => {
              el.style.transition = 'transform 320ms cubic-bezier(.2,.9,.2,1)';
              el.style.transform = '';
            });

            const onEnd = () => {
              el.style.transition = '';
              el.style.transform = '';
              el.removeEventListener('transitionend', onEnd);
            };
            el.addEventListener('transitionend', onEnd);
          }
        }
      }

      prevRectsRef.current = currentRects;
      prevQueueRef.current = queueIds ? [...queueIds] : [];
      prevCurrentIndexRef.current = currentIndex;
    } catch (e) {
      // Swallow measurement errors to avoid breaking UI
    }
  }, [queueIds, currentIndex]);

  // Memoized class names
  const listClass = useMemo(() => {
    return ['np-queue-list', collapsed ? 'is-collapsed' : '', state.dragState ? '' : 'no-tx']
      .filter(Boolean)
      .join(' ');
  }, [collapsed, state.dragState]);

  const panelClass = useMemo(() => {
    return `rt-panel ${collapsed ? 'collapsed' : ''}`;
  }, [collapsed]);

  // Early return for empty queue
  if (!queueIds.length) {
    return (
      <div className="rt-panel" role="tabpanel">
        <div className="rt-placeholder">{t('queue.empty')}</div>
      </div>
    );
  }

  return (
    <div className={panelClass} role="tabpanel" aria-label={t('queue.title')}>
      <div className="queue-title np-queue-current">{t('queue.playingNow')}</div>
      
      {typeof queueData.currentId !== 'undefined' && (
        <ul className="np-queue-list" role="list">
          <QueueItem
            key={queueData.currentId}
            id={queueData.currentId}
            index={currentIndex}
            isActive={true}
            trackData={mergedTrackData[queueData.currentId] as TrackData | undefined}
            dragState={null}
            handleHoverIndex={null}
            onPointerDown={() => {}} // No-op to disable dragging
            onHover={() => {}} // No-op
            playTrack={() => queueOps.playAt(currentIndex)}
            originalIndex={currentIndex}
            onRemove={handleRemoveFromQueue}
            onPlayNext={handlePlayNext}
            queueIds={queueIds}
            currentIndex={currentIndex}
          />
        </ul>
      )}
      
      <div className="queue-title">{t('queue.nextUp')}</div>
      
      {queueData.restIds.length > 0 && (
        <ul className={listClass} role="list" ref={listRef}>
          {queueData.restIds.map((id, restIdx) => (
            <QueueItem
              key={id}
              id={id}
              index={restIdx}
              isActive={false}
              trackData={mergedTrackData[id] as TrackData | undefined}
              dragState={state.dragState}
              handleHoverIndex={state.handleHoverIndex}
              onPointerDown={handlePointerDown}
              onHover={setHandleHoverIndex}
              playTrack={handlePlayTrack}
              originalIndex={restIdx < currentIndex ? restIdx : restIdx + 1}
              onRemove={handleRemoveFromQueue}
              onPlayNext={handlePlayNext}
              queueIds={queueIds}
              currentIndex={currentIndex}
            />
          ))}
        </ul>
      )}
    </div>
  );
});

export default QueueTab;