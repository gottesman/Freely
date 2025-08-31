import React, { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { usePlaybackActions, usePlaybackSelector } from '../core/playback';
import { useI18n } from '../core/i18n';

interface TrackData {
  id: string;
  name: string;
  artists: { name: string }[];
  album: {
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
}

const QueueItem: React.FC<QueueItemProps> = React.memo(({
  id, index, isActive, dragState, trackData, handleHoverIndex, onPointerDown, onHover, playTrack
}) => {
  const { t } = useI18n();
  const isDraggingItem = dragState?.from === index;
  const imgUrl = (window as any).imageRes?.(trackData?.album?.images, 2);

  let transform = '';
  if (dragState) {
    const { from, over, dy, itemHeight } = dragState;
    const gap = 6;

    if (index === from) {
      transform = `translateY(${dy}px)`;
    } else if (from < over && index > from && index <= over) {
      transform = `translateY(-${itemHeight + gap}px)`;
    } else if (from > over && index < from && index >= over) {
      transform = `translateY(${itemHeight + gap}px)`;
    }
  }

  const itemClass = ['queue-item', isActive ? 'active' : '', isDraggingItem ? 'dragging-item' : ''].filter(Boolean).join(' ');
  const itemStyle: React.CSSProperties = { transform, zIndex: isDraggingItem ? 2 : 1, position: isDraggingItem ? 'relative' : 'static' };

  return (
    <li
  data-queue-id={id}
      className={itemClass}
      style={itemStyle}
      onPointerDown={(ev) => onPointerDown(ev, index)}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
      role="button"
      aria-current={isActive ? 'true' : undefined}
      title={trackData?.name || id}
    >
      <span className="queue-art" aria-hidden={imgUrl ? 'true' : undefined}>
        {imgUrl ? <img src={imgUrl} alt="" loading="lazy" /> : <span className="material-symbols-rounded" style={{ fontSize: 18, opacity: 0.4 }}>music_note</span>}
        {!isActive && !dragState && handleHoverIndex === index && (
          <button
            type="button"
            className="queue-play-btn"
            aria-label={t('queue.play', undefined, { track: trackData?.name || 'track' })}
            onClick={(e) => { e.stopPropagation(); playTrack(index); }}
          >
            <span className="material-symbols-rounded filled">play_arrow</span>
          </button>
        )}
      </span>
      <span className="track overflow-ellipsis" style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
        <span className='track overflow-ellipsis'>{trackData?.name || 'Loading…'}</span>
        <small className="artist overflow-ellipsis" style={{ fontSize: '11px' }}>{trackData?.artists?.map(a => a.name).join(', ') || ''}</small>
      </span>
      <button
        className='queue-more-btn btn-icon'
        aria-label={t('common.more')}
        onClick={(e) => { e.stopPropagation(); /* TODO: open track context menu */ }}
      >
        <span className="material-symbols-rounded">more_horiz</span>
      </button>
    </li>
  );
});

export const QueueTab: React.FC<{ collapsed?: boolean }> = ({ collapsed }) => {
  const { playAt, reorderQueue } = usePlaybackActions();
  const queueIds = usePlaybackSelector(s => s.queueIds ?? []) ?? [];
  const currentIndex = usePlaybackSelector(s => s.currentIndex ?? 0) ?? 0;
  const trackCache = usePlaybackSelector(s => s.trackCache ?? {}) ?? {};
  const { t } = useI18n();
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [handleHoverIndex, setHandleHoverIndex] = useState<number | null>(null);
  
  const listRef = useRef<HTMLUListElement | null>(null);
  const positionsRef = useRef<DOMRect[]>([]);
  const animationFrameRef = useRef<number>();
  // FLIP helpers: keep previous queue and DOM rects to animate item moving into pinned slot
  const prevQueueRef = useRef<string[] | null>(null);
  const prevCurrentIndexRef = useRef<number | null>(null);
  const prevRectsRef = useRef<Record<string, DOMRect>>({});
  
  const dragStateRef = useRef<DragState | null>(dragState);
  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  const interactionRef = useRef<{
    startX: number;
    startY: number;
    isDragging: boolean;
    pointerId: number;
    index: number;
  } | null>(null);

  const DRAG_THRESHOLD = 5;

  const handlePointerMove = useCallback((ev: PointerEvent) => {
    if (!interactionRef.current || ev.pointerId !== interactionRef.current.pointerId) return;
    
    if (interactionRef.current.isDragging) {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(() => {
        setDragState(currentDragState => {
          if (!currentDragState) return null;
          const baseRect = positionsRef.current[currentDragState.from];
          if (!baseRect) return currentDragState;

          const dy = ev.clientY - (baseRect.top + currentDragState.grabOffset);
          const listTop = positionsRef.current[0]?.top || 0;
          const offsetY = ev.clientY - listTop;
          
          let newOver = currentDragState.from;
          for (let i = 0; i < positionsRef.current.length; i++) {
            const r = positionsRef.current[i];
            if (offsetY < (r.top - listTop) + r.height / 2) { newOver = i; break; }
            newOver = i;
          }
          return { ...currentDragState, dy, over: newOver };
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

        positionsRef.current = Array.from(list.children).map(el => (el as HTMLElement).getBoundingClientRect());
        const rect = positionsRef.current[index];
        if (!rect) return;

        setDragState({
          from: index,
          over: index,
          dragging: true,
          pointerId: pointerId,
          dy: ev.clientY - (rect.top + (ev.clientY - rect.top)),
          itemHeight: rect.height,
          grabOffset: ev.clientY - rect.top,
        });
      }
    }
  }, []);

  const cleanupInteraction = useCallback(() => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    if (interactionRef.current) {
        const target = listRef.current?.children[interactionRef.current.index] as HTMLElement | undefined;
        if(target?.hasPointerCapture(interactionRef.current.pointerId)) {
            target.releasePointerCapture(interactionRef.current.pointerId);
        }
    }
    interactionRef.current = null;
  }, [handlePointerMove]);

  const handlePointerUp = useCallback((ev: PointerEvent) => {
    if (!interactionRef.current || ev.pointerId !== interactionRef.current.pointerId) return;
    
    const finalDragState = dragStateRef.current;

    // We render the currently playing track in a pinned section and allow dragging only on the rest of the queue.
    // finalDragState.from/over are indices into the rest list (queueIds without currentIndex).
    if (finalDragState && interactionRef.current.isDragging) {
      if (finalDragState.from !== finalDragState.over) {
        // Build rest array (excluding current playing track)
        const currIdx = currentIndex;
        const currId = (queueIds || [])[currIdx];
        const rest = (queueIds || []).filter((_, i) => i !== currIdx);
        const nextRest = [...rest];
        const [movedItem] = nextRest.splice(finalDragState.from, 1);
        nextRest.splice(finalDragState.over, 0, movedItem);

        // Reconstruct full queue keeping current track at the same index
        const newQueue: string[] = [];
        const insertAt = Math.min(Math.max(0, currIdx), nextRest.length);
        newQueue.push(...nextRest.slice(0, insertAt));
        if (typeof currId !== 'undefined') newQueue.push(currId);
        newQueue.push(...nextRest.slice(insertAt));
        reorderQueue(newQueue);
      }
    } else if (!interactionRef.current.isDragging) {
      // For non-drag taps, playAt expects the original index within queueIds. Map from rest index to original index.
      const currIdx = currentIndex;
      const restIndex = interactionRef.current.index;
      const origIndex = restIndex < currIdx ? restIndex : restIndex + 1;
      playAt(origIndex);
    }
    
    setDragState(null);
    cleanupInteraction();
  }, [queueIds, playAt, reorderQueue, cleanupInteraction]);

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
      // Failsafe cleanup when component unmounts
      cleanupInteraction();
    }
  }, [cleanupInteraction]);

  // Animate the first "next up" item moving into the pinned "playing now" slot
  useLayoutEffect(() => {
    try {
      const prevQueue = prevQueueRef.current;
      const prevCurrIdx = prevCurrentIndexRef.current;

      // Measure current rects for all visible items (pinned + rest)
      const ids = (queueIds || []);
      const currentRects: Record<string, DOMRect> = {};
      ids.forEach(id => {
        const el = document.querySelector(`[data-queue-id=\"${id}\"]`) as HTMLElement | null;
        if (el) currentRects[id] = el.getBoundingClientRect();
      });

      // If we have previous state and the currentIndex changed, animate the item that moved
      if (prevQueue && typeof prevCurrIdx === 'number' && prevCurrIdx !== currentIndex) {
        // previous "rest" first item (the one that should become pinned)
        const prevRestFirstId = prevQueue.filter((_, i) => i !== prevCurrIdx)[0];
        if (prevRestFirstId) {
          const prevRect = prevRectsRef.current[prevRestFirstId];
          const currRect = currentRects[prevRestFirstId];
          const el = document.querySelector(`[data-queue-id=\"${prevRestFirstId}\"]`) as HTMLElement | null;
          if (prevRect && currRect && el) {
            const deltaY = prevRect.top - currRect.top;

            // Apply inverse transform to start the element at its previous position
            el.style.transition = 'none';
            el.style.transform = `translateY(${deltaY}px)`;
            // Force style flush
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            el.offsetHeight;

            // Animate to natural position
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

      // store current rects and queue for next update
      prevRectsRef.current = currentRects;
      prevQueueRef.current = queueIds ? [...queueIds] : [];
      prevCurrentIndexRef.current = currentIndex;
    } catch (e) {
      // swallow any measurement errors to avoid breaking the UI
    }
  }, [queueIds, currentIndex]);

  if (!(queueIds || []).length) {
    return <div className="rt-panel" role="tabpanel"><div className="rt-placeholder">{t('queue.empty')}</div></div>;
  }

  const currentId = (queueIds || [])[currentIndex];
  const restIds = (queueIds || []).filter((_, i) => i !== currentIndex);

  const listClass = ['np-queue-list', collapsed ? 'is-collapsed' : '', dragState ? '' : 'no-tx'].filter(Boolean).join(' ');

  return (
    <div className={`rt-panel ${collapsed ? 'collapsed' : ''}`} role="tabpanel" aria-label={t('queue.title')}>
      <div className="queue-title np-queue-current">{t('queue.playingNow')}</div>
      {/* Pinned currently playing track (not draggable) */}
      {typeof currentId !== 'undefined' && (
        <ul className="np-queue-list" role="list">
          <QueueItem
            key={currentId}
            id={currentId}
            index={currentIndex}
            isActive={true}
            trackData={(trackCache || {})[currentId] as TrackData | undefined}
            dragState={null}
            handleHoverIndex={null}
            onPointerDown={() => { /* no-op to disable dragging */ }}
            onHover={() => { /* no-op */ }}
            playTrack={() => playAt(currentIndex)}
          />
        </ul>
      )}
      
      <div className="queue-title">{t('queue.nextUp')}</div>
      {/* Rest of the queue (draggable, indices mapped to original queue positions) */}
      {restIds.length > 0 && (
        <ul className={listClass} role="list" ref={listRef}>
          {restIds.map((id, restIdx) => (
            <QueueItem
              key={id}
              id={id}
              index={restIdx}
              isActive={false}
              trackData={(trackCache || {})[id] as TrackData | undefined}
              dragState={dragState}
              handleHoverIndex={handleHoverIndex}
              onPointerDown={handlePointerDown}
              onHover={setHandleHoverIndex}
              playTrack={(idx) => {
                const origIndex = restIdx < currentIndex ? restIdx : restIdx + 1;
                playAt(origIndex);
              }}
            />
          ))}
        </ul>
      )}
      
    </div>
  );
};

export default QueueTab;