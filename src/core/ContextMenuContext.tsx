import React, { createContext, useContext, useRef, useState, useEffect } from 'react';
import ContextMenu from '../components/ContextMenu';
import '../styles/context-menu.css';

export type ContextMenuItem = {
  id: string;
  label: string;
  type?: 'action' | 'link' | 'submenu' | 'group' | 'separator';
  href?: string; // for link
  disabled?: boolean;
  submenu?: ContextMenuItem[];
  // For group items
  title?: string;
  items?: ContextMenuItem[];
  // Optional material icon name to render before the label
  icon?: string;
  meta?: any;
  // Optional callback executed when an 'action' item is selected.
  // Can be sync or async. If provided, it will be called with the item
  // before the menu resolves/close.
  onClick?: (item: ContextMenuItem) => void | Promise<void>;
};

export type ContextMenuOptions = {
  x?: number;
  y?: number;
  // Optional anchor: either an HTMLElement (button), a MouseEvent, or an object with clientX/clientY
  e?: HTMLElement | MouseEvent | { clientX: number; clientY: number };
  items: ContextMenuItem[];
  width?: number;
};

type OpenFn = (opts: ContextMenuOptions) => Promise<string | null>;

interface Ctx {
  openMenu: OpenFn;
}

const ContextMenuCtx = createContext<Ctx | undefined>(undefined);

export const ContextMenuProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ContextMenuOptions | null>(null);
  const resolveRef = useRef<((v: string | null) => void) | null>(null);
  const mousePos = useRef<{ x: number; y: number }>({ x: 240, y: 240 });

  useEffect(() => {
    // Track last mouse position so we can default menu position when x/y not provided
    function onMove(e: MouseEvent) {
      mousePos.current = { x: e.clientX, y: e.clientY };
    }
    if (typeof window !== 'undefined') {
      document.addEventListener('mousemove', onMove);
    }
    return () => { if (typeof window !== 'undefined') document.removeEventListener('mousemove', onMove); };
  }, []);

  function computePosition(options: ContextMenuOptions) {
    // If both x and y provided, use them
    if (typeof options.x === 'number' && typeof options.y === 'number') return { x: options.x, y: options.y };

    // If an anchor/event is provided, try to derive coordinates
    const maybe = (options as any).e;
    try {
      if (maybe) {
        // MouseEvent
        if (maybe instanceof MouseEvent) {
          return { x: maybe.clientX, y: maybe.clientY };
        }
        // HTMLElement-like
        if (maybe instanceof HTMLElement || (maybe && typeof maybe.getBoundingClientRect === 'function')) {
          const el = maybe as HTMLElement;
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height + 6) };
        }
        // plain object with clientX/clientY
        if (maybe.clientX && maybe.clientY) return { x: maybe.clientX, y: maybe.clientY };
      }
    } catch (_) {
      // fallthrough to mouse position fallback
    }

    // fallback to last mouse position
    return { x: mousePos.current.x, y: mousePos.current.y };
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close(null);
    }
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function openMenu(options: ContextMenuOptions) {
    // if a menu is already open, close it first
    if (resolveRef.current) {
      try { resolveRef.current(null); } catch (_) {}
      resolveRef.current = null;
    }
  // Compute final position (supports x/y, an anchor element/event via `e`, or mouse fallback)
  const pos = computePosition(options);
  const finalOpts: ContextMenuOptions = Object.assign({}, options, { x: pos.x, y: pos.y });
  setOpts(finalOpts);
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
    });
  }

  function close(result: string | null) {
    setOpen(false);
    setOpts(null);
    if (resolveRef.current) {
      try { resolveRef.current(result); } catch (_) {}
      resolveRef.current = null;
    }
  }

  return (
    <ContextMenuCtx.Provider value={{ openMenu }}>
      {children}
      {open && opts && (
        <ContextMenu options={opts} onClose={close} />
      )}
    </ContextMenuCtx.Provider>
  );
};

export function useContextMenu() {
  const ctx = useContext(ContextMenuCtx);
  if (!ctx) throw new Error('useContextMenu must be used within ContextMenuProvider');
  return ctx;
}
