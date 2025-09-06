import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenuOptions, ContextMenuItem } from '../core/ContextMenuContext';

// --- SubMenu Component (Updated) ---
function SubMenu({
  items,
  parentRef,
  appRect,
  onClose,
  handleMouseEnter, // <-- New prop
  handleMouseLeave, // <-- New prop
}: {
  items: ContextMenuItem[];
  parentRef: React.RefObject<HTMLDivElement>;
  appRect: DOMRect | null;
  onClose: (v: string | null) => void;
  handleMouseEnter: () => void; // <-- New prop
  handleMouseLeave: () => void; // <-- New prop
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    top: '-9999px',
    left: '-9999px',
    opacity: 0,
  });

  // Positioning logic remains the same...
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const card = cardRef.current;
      const parent = parentRef.current;
      if (!card || !parent || !appRect) return;

      const parentRect = parent.getBoundingClientRect();
      const menuWidth = card.offsetWidth;
      const menuHeight = card.offsetHeight;
      const padding = 8;
      const horizontalOverlap = 4;
      const verticalOverlap = 5;

      let left = parentRect.right - horizontalOverlap;
      let top = parentRect.top - verticalOverlap;

      if (left + menuWidth + padding > appRect.right) {
        left = parentRect.left - menuWidth + horizontalOverlap;
      }
      if (left < appRect.left + padding) {
        left = appRect.left + padding;
      }
      if (top + menuHeight + padding > appRect.bottom) {
        top = appRect.bottom - menuHeight - padding;
      }
      if (top < appRect.top + padding) {
        top = appRect.top + padding;
      }

      setStyle({
        position: 'fixed',
        left: Math.round(left),
        top: Math.round(top),
        opacity: 1,
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [items, parentRef, appRect]);

  function handleAction(item: ContextMenuItem) {
    if (item.disabled || item.hide) return;
    if (item.type === 'link' && item.href) {
      window.open(item.href, '_blank');
    }
    onClose(item.id);
  }

  return createPortal(
    // Apply the mouse handlers to the submenu card
    <div
      className="cm-card cm-submenu-card"
      ref={cardRef}
      style={style}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {items.map(s => (
        <div
          key={s.id}
          className={`cm-item ${s.disabled ? 'disabled' : ''}${s.hide ? ' hidden' : ''}`}
          onClick={() => handleAction(s)}
        >
          <div className="cm-label">
            {s.icon && <span className={`cm-icon material-symbols-rounded ${s.iconFilled ? 'filled' : ''}`} aria-hidden>{s.icon}</span>}
            {s.label}
          </div>
        </div>
      ))}
    </div>,
    document.body
  );
}

// --- MenuItem Component (Updated) ---
function MenuItem({
  item,
  appRect,
  activeSubMenu,
  setActiveSubMenu,
  handleAction,
  onClose,
  handleMouseEnter, // <-- New prop
  handleMouseLeave, // <-- New prop
}: {
  item: ContextMenuItem;
  appRect: DOMRect | null;
  activeSubMenu: string | null;
  setActiveSubMenu: (id: string | null) => void;
  handleAction: (item: ContextMenuItem) => void;
  onClose: (v: string | null) => void;
  handleMouseEnter: () => void; // <-- New prop
  handleMouseLeave: () => void; // <-- New prop
}) {
  const itemRef = useRef<HTMLDivElement>(null);
  const isSubMenuOpen = activeSubMenu === item.id;

  if (item.type === 'submenu' && item.submenu) {
    return (
      <div
        className={`cm-item cm-submenu ${item.disabled ? 'disabled' : ''}${item.hide ? ' hidden' : ''}`}
        ref={itemRef}
        onMouseEnter={() => {
          handleMouseEnter(); // Clear any closing timer
          setActiveSubMenu(item.id); // Open this submenu
        }}
      // The main leave handler is on the parent, so we don't need one here
      >
        <div className={`cm-label ${item.disabled ? 'disabled' : ''}`}>
          {item.icon && <span className={`cm-icon material-symbols-rounded ${item.iconFilled ? 'filled' : ''}`} aria-hidden>{item.icon}</span>}
          {item.label}
          <span className='material-symbols-rounded cm-icon' aria-hidden>{'chevron_right'}</span>
        </div>
        {isSubMenuOpen && (
          <SubMenu
            items={item.submenu}
            parentRef={itemRef}
            appRect={appRect}
            onClose={onClose}
            handleMouseEnter={handleMouseEnter} // Pass handlers down
            handleMouseLeave={handleMouseLeave}
          />
        )}
      </div>
    );
  }

  // Separator
  if (item.type === 'separator') {
    return <div key={item.id} className="cm-separator" />;
  }

  // Group: renders a title and a list of items
  if (item.type === 'group') {
    return (
      <div key={item.id} className={`cm-group${item.hide ? ' hidden' : ''}`}>
        {item.title && <div className="cm-group-title">{item.title}</div>}
        <div className="cm-group-items">
          {(item.items || []).map(i => (
            <MenuItem
              key={i.id}
              item={i}
              appRect={appRect}
              activeSubMenu={activeSubMenu}
              setActiveSubMenu={setActiveSubMenu}
              handleAction={handleAction}
              onClose={onClose}
              handleMouseEnter={handleMouseEnter}
              handleMouseLeave={handleMouseLeave}
            />
          ))}
        </div>
      </div>
    );
  }

  // Custom item type (for title with image, etc.)
  if (item.type === 'custom' && item.meta) {
    return (
      <div
        className={`cm-item custom-item ${item.disabled ? 'disabled' : 'disabled'}${item.hide ? ' hidden' : ''}`}
      >
        <div className="cm-label">
          <div
            className={`cm-custom-image ${item.image ? '' : 'no-image'}`}
            style={item.image ? { backgroundImage: `url(${item.image})` } : undefined}
          >
            {!item.image && <span className={`cm-icon material-symbols-rounded ${item.iconFilled ? 'filled' : ''}`} aria-hidden>{item.icon || 'hide_image'}</span>}
          </div>
          <div className="cm-custom-meta">
            <div className="cm-custom-title overflow-ellipsis">{item.meta.title}</div>
            {item.meta.subtitle && <div className="cm-custom-subtitle overflow-ellipsis">{item.meta.subtitle}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`cm-item ${item.disabled ? 'disabled' : ''}${item.hide ? ' hidden' : ''}`}
      onClick={() => handleAction(item)}
      onMouseEnter={() => {
        handleMouseEnter(); // Clear any closing timer
        setActiveSubMenu(null); // Close any open submenu
      }}
    >
      <div className="cm-label">
        {item.icon && <span className={`cm-icon material-symbols-rounded ${item.iconFilled ? 'filled' : ''}`} aria-hidden>{item.icon}</span>}
        {item.label}
      </div>
    </div>
  );
}

// --- Main ContextMenu Component (Updated) ---
export default function ContextMenu({ options, onClose }: { options: ContextMenuOptions; onClose: (v: string | null) => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [rootStyle, setRootStyle] = useState<React.CSSProperties | undefined>(undefined);
  const [cardStyle, setCardStyle] = useState<React.CSSProperties | undefined>(undefined);
  const [appRect, setAppRect] = useState<DOMRect | null>(null);
  const [activeSubMenu, setActiveSubMenu] = useState<string | null>(null);

  // --- NEW: Timer logic for handling mouse leave events ---
  const leaveTimer = useRef<number | null>(null);

  const handleMouseLeave = () => {
    // If a timer is already running, clear it
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    // Start a new timer to close the submenu
    leaveTimer.current = window.setTimeout(() => {
      setActiveSubMenu(null);
    }, 150); // 150ms grace period
  };

  const handleMouseEnter = () => {
    // When the mouse enters, clear any pending timer to prevent closing
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  };
  // --- END of new logic ---


  // useEffect for click outside (unchanged)
  useEffect(() => {
    const appEl = document.getElementById('app') || document.querySelector('.app') || document.documentElement;
    setAppRect((appEl as Element).getBoundingClientRect());
    function onClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!(e.target instanceof Element)) return;
      const isOutside = !rootRef.current.contains(e.target) && !e.target.closest('.cm-card');
      if (isOutside) onClose(null);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [onClose]);

  // useEffect for main menu positioning (unchanged)
  useEffect(() => {
    let raf = 0;
    raf = requestAnimationFrame(() => {
      const card = cardRef.current;
      const root = rootRef.current;
      if (!root || !card || !appRect) {
        setRootStyle({ left: options.x, top: options.y, position: 'fixed' });
        setCardStyle(undefined);
        return;
      }
      const menuWidth = card.offsetWidth;
      const menuHeight = card.offsetHeight;
      let left = typeof options.x === 'number' ? options.x : 0;
      let top = typeof options.y === 'number' ? options.y : 0;
      const padding = 8;
      let cardStyleToSet: React.CSSProperties | undefined = undefined;
      if (left + menuWidth + padding > appRect.right) {
        left = Math.max(appRect.left + padding, appRect.right - menuWidth - padding);
      }
      if (left < appRect.left + padding) left = appRect.left + padding;
      let finalTop = top;
      if (top + menuHeight + padding > appRect.bottom) {
        const altTop = top - menuHeight - 8;
        if (altTop >= appRect.top + padding) {
          finalTop = altTop;
        } else {
          finalTop = Math.max(appRect.top + padding, top);
          const maxH = appRect.bottom - finalTop - padding;
          cardStyleToSet = { maxHeight: Math.max(80, maxH), overflowY: 'auto' };
        }
      }
      setRootStyle({ left: Math.round(left), top: Math.round(finalTop), position: 'fixed', opacity: 1 });
      setCardStyle(cardStyleToSet);
    });
    return () => cancelAnimationFrame(raf);
  }, [options.x, options.y, options.items?.length, appRect]);

  // handleAction (unchanged)
  function handleAction(item: ContextMenuItem) {
    if (item.disabled || item.type === 'submenu') return;
    if (item.type === 'link' && item.href) window.open(item.href, '_blank');
    if (item.type === 'action' && typeof item.onClick === 'function') {
      try {
        const r = item.onClick(item);
        if (r && typeof (r as Promise<any>).then === 'function') {
          (r as Promise<any>).finally(() => onClose(item.id));
          return;
        }
      } catch (e) { console.error('ContextMenu action error', e); }
    }
    onClose(item.id);
  }

  return (
    <div
      className="cm-root"
      ref={rootRef}
      style={rootStyle}
      role="menu"
      onMouseLeave={handleMouseLeave} // Apply the handlers
      onMouseEnter={handleMouseEnter} // Apply the handlers
    >
      <div className="cm-card" ref={cardRef} style={cardStyle}>
        {options.items.map(item => (
          <MenuItem
            key={item.id}
            item={item}
            appRect={appRect}
            activeSubMenu={activeSubMenu}
            setActiveSubMenu={setActiveSubMenu}
            handleAction={handleAction}
            onClose={onClose}
            handleMouseEnter={handleMouseEnter} // Pass the handlers down
            handleMouseLeave={handleMouseLeave}
          />
        ))}
      </div>
    </div>
  );
}

// Pure builder (no hooks) so callers inside components can safely use hooks and then build items.
export interface BuildTrackMenuOptions {
  t: (k: string, def?: string, vars?: Record<string, any>) => string;
  trackData: any; // TODO: replace 'any' with a Track type if available
  queueList?: string[];
  currentIndex?: number;
  queueRemovable?: boolean; // if true, show "remove from playlist" option
  queueOptions?: boolean; // whether to show queue manipulation group
}

export function buildTrackContextMenuItems(opts: BuildTrackMenuOptions): ContextMenuItem[] {
  if (!opts || typeof opts !== 'object') return [];
  const {
    t,
    trackData,
    queueList,
    currentIndex,
    queueRemovable = false,
    queueOptions = true,
  } = opts;


  const trackTitle = trackData?.name || trackData?.id || 'track';
  const firstArtist = trackData?.artists?.[0];
  const items: ContextMenuItem[] = [
    {
      id: 'title', label: 'title', type: 'custom',
      image: (window as any).imageRes?.(trackData?.album?.images, 3) || undefined, icon: 'person', iconFilled: true,
      meta: { title: trackTitle, subtitle: trackData?.artists?.map((a: any) => a.name).join(', ') || '' }
    },
    {
      id: 'playlist', label: t('common.addToPlaylist', 'Add to playlist'), type: 'action', icon: 'playlist_add',
      onClick: () => {
        window.dispatchEvent(new CustomEvent('freely:openAddToPlaylistModal', { detail: { track: trackData, fromBottomPlayer: false } }));
      }
    },
    ...(queueOptions ? [
      {
        id: 'grp-track', label: trackTitle, type: 'group', items: [
          {
            id: 'act-play', label: t('common.playNow', 'Play now'), type: 'action', icon: 'play_arrow', iconFilled: true,
            onClick: () => {
              if (!trackData?.id) return;
              const currentSegment = (queueList || []).slice(currentIndex || 0);
              const rest = currentSegment.filter(id => id !== trackData.id);
              const newQueue = [trackData.id, ...rest];
              // Set new queue beginning with this track and start playback at index 0
              window.dispatchEvent(new CustomEvent('freely:playback:setQueue', { detail: { queueIds: newQueue, startIndex: 0 } }));
            }
          },
          {
            id: 'act-play-next', label: t('common.playNext', 'Play next'), type: 'action', icon: 'playlist_play',
            onClick: () => {
              if (!trackData?.id) return;
              const id = trackData.id;
              const q = Array.isArray(queueList) ? [...queueList] : [];
              // If queue empty just enqueue (don't force immediate play)
              if (!q.length) {
                window.dispatchEvent(new CustomEvent('freely:playback:enqueue', { detail: { ids: [id] } }));
                return;
              }
              const curIdx = (typeof currentIndex === 'number' && currentIndex >= 0) ? currentIndex : 0;
              const desiredPos = Math.min(curIdx + 1, q.length); // position right after current track
              const existingIdx = q.indexOf(id);
              if (existingIdx === desiredPos) return; // already next
              if (existingIdx !== -1) {
                // Remove from old position
                q.splice(existingIdx, 1);
              }
              // Insert at desired position (could be end)
              q.splice(desiredPos, 0, id);
              // Reorder queue without changing the currently playing track
              window.dispatchEvent(new CustomEvent('freely:playback:reorderQueue', { detail: { queueIds: q } }));
            }
          },
          {
            id: 'act-add-queue', label: t('player.addToQueue', 'Add to queue'), type: 'action', icon: 'queue',
            onClick: () => {
              if (trackData?.id) window.dispatchEvent(new CustomEvent('freely:playback:enqueue', { detail: { ids: [trackData.id] } }));
            }
          },
          ...(queueRemovable ? [
            {
              id: 'act-remove', label: t('player.removeFromPlaylist', 'Remove from playlist'), type: 'action', icon: 'close',
              onClick: () => {
                if (trackData?.id) {
                  window.dispatchEvent(new CustomEvent('freely:playback:removeTrack', { detail: { id: trackData.id } }));
                }
              }
            }
          ] : []) as any
        ]
      }
    ] : []) as any,
    ...(firstArtist?.id ? [
      {
        id: 'artist', label: t('common.goToArtist', 'Go to artist'), type: 'action' as const, icon: 'person', iconFilled: true,
        onClick: () => {
          if (firstArtist.id) window.dispatchEvent(new CustomEvent('freely:selectArtist', { detail: { artistId: firstArtist.id, source: 'track-list-menu' } }));
        }
      }
    ] : []),
    ...(trackData?.id ? [
      {
        id: 'info', label: t('common.goToSong', 'Go to song'), type: 'action' as const, icon: 'music_note',
        onClick: () => {
          window.dispatchEvent(new CustomEvent('freely:selectTrack', { detail: { trackId: trackData.id, source: 'track-list-menu' } }));
        }
      }
    ] : [])
  ];
  return items;
}