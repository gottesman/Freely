import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenuOptions, ContextMenuItem } from '../core/ContextMenuContext';
import { playbackEvents } from './tabHelpers';

// Constants for better performance
const MENU_CONFIG = {
  PADDING: 8,
  HORIZONTAL_OVERLAP: 4,
  VERTICAL_OVERLAP: 5,
  SUBMENU_DELAY: 150,
  MIN_HEIGHT: 80,
  INITIAL_POSITION: { top: '-9999px', left: '-9999px', opacity: 0 },
} as const;

// Interfaces for state management
interface MenuState {
  rootStyle?: React.CSSProperties;
  cardStyle?: React.CSSProperties;
  appRect: DOMRect | null;
  activeSubMenu: string | null;
}

interface PositionCalculation {
  left: number;
  top: number;
  cardStyle?: React.CSSProperties;
}

// Utility functions
const calculateMenuPosition = (
  options: { x: number; y: number },
  menuDimensions: { width: number; height: number },
  appRect: DOMRect
): PositionCalculation => {
  const { width: menuWidth, height: menuHeight } = menuDimensions;
  let left = options.x;
  let top = options.y;
  let cardStyle: React.CSSProperties | undefined = undefined;

  // Horizontal positioning
  if (left + menuWidth + MENU_CONFIG.PADDING > appRect.right) {
    left = Math.max(appRect.left + MENU_CONFIG.PADDING, appRect.right - menuWidth - MENU_CONFIG.PADDING);
  }
  if (left < appRect.left + MENU_CONFIG.PADDING) {
    left = appRect.left + MENU_CONFIG.PADDING;
  }

  // Vertical positioning
  let finalTop = top;
  if (top + menuHeight + MENU_CONFIG.PADDING > appRect.bottom) {
    const altTop = top - menuHeight - 8;
    if (altTop >= appRect.top + MENU_CONFIG.PADDING) {
      finalTop = altTop;
    } else {
      finalTop = Math.max(appRect.top + MENU_CONFIG.PADDING, top);
      const maxH = appRect.bottom - finalTop - MENU_CONFIG.PADDING;
      cardStyle = { maxHeight: Math.max(MENU_CONFIG.MIN_HEIGHT, maxH), overflowY: 'auto' };
    }
  }

  return {
    left: Math.round(left),
    top: Math.round(finalTop),
    cardStyle,
  };
};

const calculateSubMenuPosition = (
  parentRect: DOMRect,
  menuDimensions: { width: number; height: number },
  appRect: DOMRect
): { left: number; top: number } => {
  const { width: menuWidth, height: menuHeight } = menuDimensions;
  let left = parentRect.right - MENU_CONFIG.HORIZONTAL_OVERLAP;
  let top = parentRect.top - MENU_CONFIG.VERTICAL_OVERLAP;

  // Horizontal positioning
  if (left + menuWidth + MENU_CONFIG.PADDING > appRect.right) {
    left = parentRect.left - menuWidth + MENU_CONFIG.HORIZONTAL_OVERLAP;
  }
  if (left < appRect.left + MENU_CONFIG.PADDING) {
    left = appRect.left + MENU_CONFIG.PADDING;
  }

  // Vertical positioning
  if (top + menuHeight + MENU_CONFIG.PADDING > appRect.bottom) {
    top = appRect.bottom - menuHeight - MENU_CONFIG.PADDING;
  }
  if (top < appRect.top + MENU_CONFIG.PADDING) {
    top = appRect.top + MENU_CONFIG.PADDING;
  }

  return { left: Math.round(left), top: Math.round(top) };
};

// Custom hooks for better organization
function useMenuState(): [MenuState, {
  setRootStyle: (style: React.CSSProperties) => void;
  setCardStyle: (style?: React.CSSProperties) => void;
  setAppRect: (rect: DOMRect | null) => void;
  setActiveSubMenu: (id: string | null) => void;
}] {
  const [state, setState] = useState<MenuState>({
    appRect: null,
    activeSubMenu: null,
  });

  const actions = useMemo(() => ({
    setRootStyle: (rootStyle: React.CSSProperties) =>
      setState(prev => ({ ...prev, rootStyle })),
    setCardStyle: (cardStyle?: React.CSSProperties) =>
      setState(prev => ({ ...prev, cardStyle })),
    setAppRect: (appRect: DOMRect | null) =>
      setState(prev => ({ ...prev, appRect })),
    setActiveSubMenu: (activeSubMenu: string | null) =>
      setState(prev => ({ ...prev, activeSubMenu })),
  }), []);

  return [state, actions];
}

function useSubmenuTimer() {
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const setTimer = useCallback((callback: () => void, delay: number = MENU_CONFIG.SUBMENU_DELAY) => {
    clearTimer();
    timerRef.current = window.setTimeout(callback, delay);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return { clearTimer, setTimer };
}

function useMenuPositioning(
  cardRef: React.RefObject<HTMLElement>,
  options: { x: number; y: number },
  appRect: DOMRect | null,
  dependencies: any[] = []
) {
  const [position, setPosition] = useState<React.CSSProperties>({
    left: options.x,
    top: options.y,
    position: 'fixed',
  });
  const [cardStyle, setCardStyle] = useState<React.CSSProperties | undefined>();

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card || !appRect) {
        setPosition({ left: options.x, top: options.y, position: 'fixed' });
        setCardStyle(undefined);
        return;
      }

      const menuDimensions = {
        width: card.offsetWidth,
        height: card.offsetHeight,
      };

      const result = calculateMenuPosition(options, menuDimensions, appRect);
      
      setPosition({
        left: result.left,
        top: result.top,
        position: 'fixed',
        opacity: 1,
      });
      setCardStyle(result.cardStyle);
    });

    return () => cancelAnimationFrame(raf);
  }, [options.x, options.y, appRect, ...dependencies]);

  return { position, cardStyle };
}

// Optimized SubMenu Component
const SubMenu = React.memo<{
  items: ContextMenuItem[];
  parentRef: React.RefObject<HTMLDivElement>;
  appRect: DOMRect | null;
  onClose: (v: string | null) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}>(({ items, parentRef, appRect, onClose, onMouseEnter, onMouseLeave }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    ...MENU_CONFIG.INITIAL_POSITION,
  });

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const card = cardRef.current;
      const parent = parentRef.current;
      if (!card || !parent || !appRect) return;

      const parentRect = parent.getBoundingClientRect();
      const menuDimensions = {
        width: card.offsetWidth,
        height: card.offsetHeight,
      };

      const position = calculateSubMenuPosition(parentRect, menuDimensions, appRect);
      
      setStyle({
        position: 'fixed',
        left: position.left,
        top: position.top,
        opacity: 1,
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [items.length, parentRef, appRect]);

  const handleAction = useCallback((item: ContextMenuItem) => {
    if (item.disabled || item.hide) return;
    if (item.type === 'link' && item.href) {
      window.open(item.href, '_blank');
    }
    onClose(item.id);
  }, [onClose]);

  const menuItems = useMemo(() => 
    items.map(item => (
      <div
        key={item.id}
        className={`cm-item ${item.disabled ? 'disabled' : ''}${item.hide ? ' hidden' : ''}`}
        onClick={() => handleAction(item)}
      >
        <div className="cm-label">
          {item.icon && (
            <span 
              className={`cm-icon material-symbols-rounded ${item.iconFilled ? 'filled' : ''}`} 
              aria-hidden
            >
              {item.icon}
            </span>
          )}
          {item.label}
        </div>
      </div>
    )), 
    [items, handleAction]
  );

  return createPortal(
    <div
      className="cm-card cm-submenu-card"
      ref={cardRef}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {menuItems}
    </div>,
    document.body
  );
});

// Optimized MenuItem Component
const MenuItem = React.memo<{
  item: ContextMenuItem;
  appRect: DOMRect | null;
  activeSubMenu: string | null;
  onSetActiveSubMenu: (id: string | null) => void;
  onAction: (item: ContextMenuItem) => void;
  onClose: (v: string | null) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}>(({ item, appRect, activeSubMenu, onSetActiveSubMenu, onAction, onClose, onMouseEnter, onMouseLeave }) => {
  const itemRef = useRef<HTMLDivElement>(null);
  const isSubMenuOpen = activeSubMenu === item.id;

  const handleMouseEnterItem = useCallback(() => {
    onMouseEnter();
    if (item.type === 'submenu') {
      onSetActiveSubMenu(item.id);
    } else {
      onSetActiveSubMenu(null);
    }
  }, [item.type, item.id, onMouseEnter, onSetActiveSubMenu]);

  const handleItemClick = useCallback(() => {
    if (item.type !== 'submenu') {
      onAction(item);
    }
  }, [item, onAction]);

  // Memoized icon component
  const iconElement = useMemo(() => {
    if (!item.icon) return null;
    return (
      <span 
        className={`cm-icon material-symbols-rounded ${item.iconFilled ? 'filled' : ''}`} 
        aria-hidden
      >
        {item.icon}
      </span>
    );
  }, [item.icon, item.iconFilled]);

  // Submenu item
  if (item.type === 'submenu' && item.submenu) {
    return (
      <div
        className={`cm-item cm-submenu ${item.disabled ? 'disabled' : ''}${item.hide ? ' hidden' : ''}`}
        ref={itemRef}
        onMouseEnter={handleMouseEnterItem}
      >
        <div className={`cm-label ${item.disabled ? 'disabled' : ''}`}>
          {iconElement}
          {item.label}
          <span className="material-symbols-rounded cm-icon" aria-hidden>
            chevron_right
          </span>
        </div>
        {isSubMenuOpen && (
          <SubMenu
            items={item.submenu}
            parentRef={itemRef}
            appRect={appRect}
            onClose={onClose}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
          />
        )}
      </div>
    );
  }

  // Separator
  if (item.type === 'separator') {
    return <div className="cm-separator" />;
  }

  // Group
  if (item.type === 'group') {
    const groupItems = useMemo(() => 
      (item.items || []).map(groupItem => (
        <MenuItem
          key={groupItem.id}
          item={groupItem}
          appRect={appRect}
          activeSubMenu={activeSubMenu}
          onSetActiveSubMenu={onSetActiveSubMenu}
          onAction={onAction}
          onClose={onClose}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        />
      )), 
      [item.items, appRect, activeSubMenu, onSetActiveSubMenu, onAction, onClose, onMouseEnter, onMouseLeave]
    );

    return (
      <div className={`cm-group${item.hide ? ' hidden' : ''}`}>
        {item.title && <div className="cm-group-title">{item.title}</div>}
        <div className="cm-group-items">
          {groupItems}
        </div>
      </div>
    );
  }

  // Custom item
  if (item.type === 'custom' && item.meta) {
    const customImage = useMemo(() => {
      if (item.image) {
        return (
          <div 
            className="cm-custom-image"
            style={{ backgroundImage: `url(${item.image})` }}
          />
        );
      }
      return (
        <div className="cm-custom-image no-image">
          <span 
            className={`cm-icon material-symbols-rounded ${item.iconFilled ? 'filled' : ''}`} 
            aria-hidden
          >
            {item.icon || 'hide_image'}
          </span>
        </div>
      );
    }, [item.image, item.icon, item.iconFilled]);

    return (
      <div className={`cm-item custom-item disabled${item.hide ? ' hidden' : ''}`}>
        <div className="cm-label">
          {customImage}
          <div className="cm-custom-meta">
            <div className="cm-custom-title overflow-ellipsis">{item.meta.title}</div>
            {item.meta.subtitle && (
              <div className="cm-custom-subtitle overflow-ellipsis">{item.meta.subtitle}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Regular item
  return (
    <div
      className={`cm-item ${item.disabled ? 'disabled' : ''}${item.hide ? ' hidden' : ''}`}
      onClick={handleItemClick}
      onMouseEnter={handleMouseEnterItem}
    >
      <div className="cm-label">
        {iconElement}
        {item.label}
      </div>
    </div>
  );
});

// Main optimized ContextMenu Component
export default function ContextMenu({ 
  options, 
  onClose 
}: { 
  options: ContextMenuOptions; 
  onClose: (v: string | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [menuState, menuActions] = useMenuState();
  const { clearTimer, setTimer } = useSubmenuTimer();

  // Memoized positioning
  const { position: rootStyle, cardStyle } = useMenuPositioning(
    cardRef,
    { x: options.x, y: options.y },
    menuState.appRect,
    [options.items?.length]
  );

  // Initialize app rect and click outside handler
  useEffect(() => {
    const appEl = document.getElementById('app') || 
      document.querySelector('.app') || 
      document.documentElement;
    menuActions.setAppRect((appEl as Element).getBoundingClientRect());

    const handleClickOutside = (e: MouseEvent) => {
      if (!rootRef.current || !(e.target instanceof Element)) return;
      const isOutside = !rootRef.current.contains(e.target) && !e.target.closest('.cm-card');
      if (isOutside) onClose(null);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, menuActions]);

  // Mouse event handlers
  const handleMouseLeave = useCallback(() => {
    setTimer(() => menuActions.setActiveSubMenu(null));
  }, [setTimer, menuActions]);

  const handleMouseEnter = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  // Action handler
  const handleAction = useCallback((item: ContextMenuItem) => {
    if (item.disabled || item.type === 'submenu') return;
    
    if (item.type === 'link' && item.href) {
      window.open(item.href, '_blank');
    }
    
    if (item.type === 'action' && typeof item.onClick === 'function') {
      try {
        const result = item.onClick(item);
        if (result && typeof (result as Promise<any>).then === 'function') {
          (result as Promise<any>).finally(() => onClose(item.id));
          return;
        }
      } catch (e) {
        console.error('ContextMenu action error', e);
      }
    }
    
    onClose(item.id);
  }, [onClose]);

  // Memoized menu items
  const menuItems = useMemo(() =>
    options.items.map(item => (
      <MenuItem
        key={item.id}
        item={item}
        appRect={menuState.appRect}
        activeSubMenu={menuState.activeSubMenu}
        onSetActiveSubMenu={menuActions.setActiveSubMenu}
        onAction={handleAction}
        onClose={onClose}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      />
    )),
    [
      options.items, 
      menuState.appRect, 
      menuState.activeSubMenu, 
      menuActions.setActiveSubMenu, 
      handleAction, 
      onClose, 
      handleMouseEnter, 
      handleMouseLeave
    ]
  );

  return (
    <div
      className="cm-root"
      ref={rootRef}
      style={rootStyle}
      role="menu"
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
    >
      <div className="cm-card" ref={cardRef} style={cardStyle}>
        {menuItems}
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
        playbackEvents.openAddToPlaylistModal(trackData);
      }
    },
    ...(queueOptions ? [
      {
        id: 'grp-track', label: trackTitle, type: 'group', items: [
          {
            id: 'act-play', label: t('common.playNow', 'Play now'), type: 'action', icon: 'play_arrow', iconFilled: true,
            onClick: () => {
              if (!trackData?.id) return;
              // Use optimized playNow event for immediate playback
              const currentSegment = (queueList || []).slice(currentIndex || 0);
              const rest = currentSegment.filter(id => id !== trackData.id);
              const newQueue = [trackData.id, ...rest];
              playbackEvents.playNow(newQueue);
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
                playbackEvents.enqueue([id]);
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
              playbackEvents.reorderQueue(q);
            }
          },
          {
            id: 'act-add-queue', label: t('player.addToQueue', 'Add to queue'), type: 'action', icon: 'queue',
            onClick: () => {
              if (trackData?.id) playbackEvents.enqueue([trackData.id]);
            }
          },
          ...(queueRemovable ? [
            {
              id: 'act-remove', label: t('player.removeFromPlaylist', 'Remove from playlist'), type: 'action', icon: 'close',
              onClick: () => {
                if (trackData?.id) {
                  playbackEvents.removeTrack(trackData.id);
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