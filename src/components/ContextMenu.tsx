import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextMenuOptions, ContextMenuItem } from '../core/ContextMenuContext';

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
    if (item.disabled) return;
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
          className={`cm-item ${s.disabled ? 'disabled' : ''}`}
          onClick={() => handleAction(s)}
        >
          <div className="cm-label">
            {s.icon && <span className="cm-icon material-symbols-rounded" aria-hidden>{s.icon}</span>}
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
        className="cm-item cm-submenu"
        ref={itemRef}
        onMouseEnter={() => {
          handleMouseEnter(); // Clear any closing timer
          setActiveSubMenu(item.id); // Open this submenu
        }}
      // The main leave handler is on the parent, so we don't need one here
      >
        <div className={`cm-label ${item.disabled ? 'disabled' : ''}`}>
          {item.label}
          <span className='material-symbols-rounded cm-icon' aria-hidden>{item.icon || 'chevron_right'}</span>
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
      <div key={item.id} className="cm-group">
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

  return (
    <div
      className={`cm-item ${item.disabled ? 'disabled' : ''}`}
      onClick={() => handleAction(item)}
      onMouseEnter={() => {
        handleMouseEnter(); // Clear any closing timer
        setActiveSubMenu(null); // Close any open submenu
      }}
    >
      <div className="cm-label">
        {item.label}
        {item.icon && <span className="cm-icon material-symbols-rounded cm-icon" aria-hidden>{item.icon}</span>}
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
      setRootStyle({ left: Math.round(left), top: Math.round(finalTop), position: 'fixed' });
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