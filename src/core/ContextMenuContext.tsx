import React, { createContext, useContext, useRef, useState, useEffect } from 'react';
import ContextMenu from '../components/ContextMenu';
import '../styles/context-menu.css';

export type ContextMenuItem = {
  id: string;
  label: string;
  type?: 'action' | 'link' | 'submenu';
  href?: string; // for link
  disabled?: boolean;
  submenu?: ContextMenuItem[];
  meta?: any;
};

export type ContextMenuOptions = {
  x: number;
  y: number;
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
    setOpts(options);
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
