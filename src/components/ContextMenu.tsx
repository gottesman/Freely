import React, { useEffect, useRef } from 'react';
import type { ContextMenuOptions, ContextMenuItem } from '../core/ContextMenuContext';

export default function ContextMenu({ options, onClose }: { options: ContextMenuOptions; onClose: (v: string|null) => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!(e.target instanceof Node)) return;
      if (!rootRef.current.contains(e.target as Node)) {
        onClose(null);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [onClose]);

  function handleAction(item: ContextMenuItem) {
    if (item.disabled) return;
    if (item.type === 'link' && item.href) {
      // open link in new tab/window
      window.open(item.href, '_blank');
      onClose(item.id);
      return;
    }
    if (item.type === 'submenu' && item.submenu && item.submenu.length) {
      // noop: submenu handled in markup
      return;
    }
    onClose(item.id);
  }

  function renderItem(item: ContextMenuItem) {
    if (item.type === 'submenu' && item.submenu) {
      return (
        <div key={item.id} className="cm-item cm-submenu">
          <div className={`cm-label ${item.disabled ? 'disabled' : ''}`}>{item.label}</div>
          <div className="cm-submenu-list">
            {item.submenu.map(s => renderItem(s))}
          </div>
        </div>
      );
    }
    return (
      <div
        key={item.id}
        className={`cm-item ${item.disabled ? 'disabled' : ''}`}
        onClick={() => handleAction(item)}
      >
        <div className="cm-label">{item.label}</div>
      </div>
    );
  }

  // position
  const style: React.CSSProperties = { left: options.x, top: options.y };

  return (
    <div className="cm-root" ref={rootRef} style={style} role="menu">
      <div className="cm-card">
        {options.items.map(i => renderItem(i))}
      </div>
    </div>
  );
}
