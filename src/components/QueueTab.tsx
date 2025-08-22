import React, { useRef, useState, useCallback, useEffect } from 'react';
import { usePlayback } from '../core/playback';
import { useI18n } from '../core/i18n';

interface DragState { from: number; over: number; dragging: boolean; pointerId?: number; dy: number; itemHeight: number; grabOffset: number; }

export const QueueTab: React.FC<{ collapsed?: boolean }> = ({ collapsed }) => {
  const { queueIds, currentIndex, playAt, trackCache, reorderQueue } = usePlayback();
  const { t } = useI18n();
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [handleHoverIndex, setHandleHoverIndex] = useState<number | null>(null);
  const [transitionsEnabled, setTransitionsEnabled] = useState<boolean>(false);
  const listRef = useRef<HTMLUListElement | null>(null);
  const positionsRef = useRef<DOMRect[]>([]);

  if(!queueIds.length){
    return (
      <div className="rt-panel" role="tabpanel">
        <div className="rt-placeholder">{t('queue.empty')}</div>
      </div>
    );
  }

  const beginPointerDrag = (ev: React.PointerEvent, index: number) => {
    const list = listRef.current;
    if(!list) return;
    positionsRef.current = Array.from(list.children).map(el => (el as HTMLElement).getBoundingClientRect());
  const rect = positionsRef.current[index];
  const itemHeight = rect ? rect.height : 0;
  const grabOffset = rect ? (ev.clientY - rect.top) : 0;
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  setTransitionsEnabled(true); // enable transform transition while dragging per request
  setDragState({ from: index, over: index, dragging: true, pointerId: ev.pointerId, dy: 0, itemHeight, grabOffset });
  };

  const updateOverFromPosition = useCallback((clientY: number) => {
    setDragState(ds => {
      if(!ds) return ds;
      const listTop = positionsRef.current[0]?.top || 0;
      const offsetY = clientY - listTop;
      let target = ds.from;
      for(let i=0;i<positionsRef.current.length;i++){
        const r = positionsRef.current[i];
        if(offsetY < (r.top - listTop) + r.height / 2){ target = i; break; }
        target = i; // default to last traversed
      }
      return { ...ds, over: target };
    });
  }, []);

  const performReorder = useCallback((from: number, to: number) => {
    if(from === to) return;
    const next = [...queueIds];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorderQueue(next);
  }, [queueIds, reorderQueue]);

  const performFinalize = useCallback(() => {
    setDragState(ds => {
      if(!ds) return ds;
      if(ds.from !== ds.over){ performReorder(ds.from, ds.over); }
      return null;
    });
  }, [performReorder]);

  const onPointerMove = (ev: PointerEvent) => {
    setDragState(ds => {
      if(!ds || !ds.dragging) return ds;
      if(ds.pointerId !== ev.pointerId) return ds;
      const baseRect = positionsRef.current[ds.from];
  if(!baseRect) return ds;
  const dy = ev.clientY - (baseRect.top + ds.grabOffset);
  return { ...ds, dy };
    });
    updateOverFromPosition(ev.clientY);
  };

  const onPointerUp = (ev: PointerEvent) => {
    setDragState(ds => {
      if(!ds || ds.pointerId !== ev.pointerId) return ds;
      return ds; // we'll finalize after state access below
    });
    performFinalize();
    setTransitionsEnabled(false); // disable transitions after drag ends
  };

  useEffect(()=>{
    if(dragState?.dragging){
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp, { once:false });
      return () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
      };
    }
  }, [dragState?.dragging, onPointerMove]);

  // Collapsed mode reuses the same list; CSS hides text/meta.

  return (
  <div className={`rt-panel ${collapsed ? 'collapsed' : ''}`} role="tabpanel" aria-label={t('queue.title')}>
  <ul className={`np-queue-list ${collapsed ? 'is-collapsed' : ''} ${!transitionsEnabled ? 'no-tx' : ''}`.trim()} role="list" ref={listRef}>
        {queueIds.map((id, i) => {
          const trackData = trackCache[id];
          const isActive = i === currentIndex;
          const imgs = trackData?.album?.images;
          const imgUrl = imgs && imgs.length ? (imgs[imgs.length - 1]?.url || imgs[0].url) : undefined;
          let transform = '';
          if(dragState){
            const { from, over, dragging, dy, itemHeight } = dragState;
            const gap = 6; // matches CSS gap
            if(i === from && dragging){
              transform = `translateY(${dy}px)`;
            } else if(dragging && from < over && i > from && i <= over){
              transform = `translateY(${- (itemHeight + gap)}px)`;
            } else if(dragging && from > over && i < from && i >= over){
              transform = `translateY(${itemHeight + gap}px)`;
            }
          }
          return (
            <li
              key={id}
              className={`${isActive ? 'active ' : ''}${dragState?.from === i ? 'dragging-item ' : ''}`.trim()}
              style={{ transform, zIndex: dragState?.from === i ? 2 : undefined, position: dragState?.from === i ? 'relative' : undefined }}
              onClick={() => !dragState?.dragging && playAt(i)}
              role="button"
              aria-current={isActive ? 'true' : undefined}
              title={trackData?.name || id}
            >
              <span className="queue-art" aria-hidden={imgUrl ? 'true' : undefined}>
        {imgUrl ? <img src={imgUrl} alt="" loading="lazy" /> : <span className="material-symbols-rounded" style={{ fontSize:18, opacity:.4 }}>music_note</span>}
        {!isActive && !dragState?.dragging && handleHoverIndex !== i && (
                  <button
                    type="button"
                    className="queue-play-btn"
          aria-label={t('queue.play', undefined, { track: trackData?.name || 'track' })}
                    onClick={(e) => { e.stopPropagation(); playAt(i); }}
                  >
                    <span className="material-symbols-rounded filled">play_arrow</span>
                  </button>
                )}
              </span>
              <span className="track" style={{ display:'flex', flexDirection:'column', lineHeight:1.15 }}>
        <span>{trackData?.name || 'Loading…'}</span>
        <small className="artist" style={{ fontSize: '11px' }}>{trackData?.artists?.map(a=>a.name).join(', ') || ''}</small>
              </span>
              <button
                className="queue-drag-handle"
        aria-label={t('queue.drag', undefined, { track: trackData?.name || 'track' })}
                onPointerDown={(ev) => beginPointerDrag(ev, i)}
                onClick={(e)=> { if(dragState?.dragging) return; e.stopPropagation(); }}
                onMouseEnter={() => setHandleHoverIndex(i)}
                onMouseLeave={() => setHandleHoverIndex(h => h === i ? null : h)}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16, opacity:0.7 }}>drag_handle</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default QueueTab;
