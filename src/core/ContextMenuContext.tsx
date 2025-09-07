import React, { createContext, useContext, useRef, useState, useEffect, useCallback, useMemo } from 'react';
import ContextMenu from '../components/ContextMenu';
import '../styles/context-menu.css';

// Types and constants
export type ContextMenuItem = {
  id: string;
  label: string;
  type?: 'action' | 'link' | 'submenu' | 'group' | 'separator' | 'custom';
  image?: string;
  href?: string;
  disabled?: boolean;
  hide?: boolean;
  submenu?: ContextMenuItem[];
  title?: string;
  items?: ContextMenuItem[];
  icon?: string;
  iconFilled?: boolean;
  meta?: any;
  onClick?: (item: ContextMenuItem) => void | Promise<void>;
};

export type ContextMenuOptions = {
  x?: number;
  y?: number;
  e?: HTMLElement | MouseEvent | { clientX: number; clientY: number };
  items: ContextMenuItem[];
  width?: number;
};

type OpenFn = (opts: ContextMenuOptions) => Promise<string | null>;

interface ContextMenuState {
  openMenu: OpenFn;
}

// Constants for better performance
const DEFAULTS = {
  POSITION: { x: 240, y: 240 } as { x: number; y: number },
  ELEMENT_OFFSET: 6,
  THROTTLE_DELAY: 16 // ~60fps
} as const;

// Optimized position computation
const positionCalculators = {
  fromCoordinates: (x: number, y: number) => ({ x, y }),
  
  fromMouseEvent: (event: MouseEvent) => ({
    x: event.clientX,
    y: event.clientY
  }),
  
  fromElement: (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height + DEFAULTS.ELEMENT_OFFSET)
    };
  },
  
  fromObject: (obj: { clientX: number; clientY: number }) => ({
    x: obj.clientX,
    y: obj.clientY
  })
} as const;

// Throttle utility for mouse tracking
const throttle = (func: Function, delay: number) => {
  let timeoutId: number | null = null;
  let lastExecTime = 0;
  
  return (...args: any[]) => {
    const currentTime = Date.now();
    
    if (currentTime - lastExecTime > delay) {
      func(...args);
      lastExecTime = currentTime;
    } else {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        func(...args);
        lastExecTime = Date.now();
      }, delay - (currentTime - lastExecTime));
    }
  };
};

// Context
const ContextMenuCtx = createContext<ContextMenuState | undefined>(undefined);

// Optimized provider
export const ContextMenuProvider = React.memo<{ children: React.ReactNode }>(({ children }) => {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ContextMenuOptions | null>(null);
  const resolveRef = useRef<((v: string | null) => void) | null>(null);
  const mousePos = useRef(DEFAULTS.POSITION);

  // Optimized position computation
  const computePosition = useCallback((options: ContextMenuOptions) => {
    // Direct coordinates take priority
    if (typeof options.x === 'number' && typeof options.y === 'number') {
      return positionCalculators.fromCoordinates(options.x, options.y);
    }

    // Try to extract position from anchor/event
    const anchor = options.e;
    if (anchor) {
      if (anchor instanceof MouseEvent) {
        return positionCalculators.fromMouseEvent(anchor);
      }
      
      if (anchor instanceof HTMLElement || (anchor as any)?.getBoundingClientRect) {
        try {
          return positionCalculators.fromElement(anchor as HTMLElement);
        } catch {
          // Element might be detached, fall through to fallback
        }
      }
      
      if ('clientX' in anchor && 'clientY' in anchor && 
          typeof anchor.clientX === 'number' && typeof anchor.clientY === 'number') {
        return positionCalculators.fromObject(anchor as { clientX: number; clientY: number });
      }
    }

    // Fallback to last mouse position
    return mousePos.current;
  }, []);

  // Memoized close function
  const close = useCallback((result: string | null) => {
    setOpen(false);
    setOpts(null);
    
    if (resolveRef.current) {
      resolveRef.current(result);
      resolveRef.current = null;
    }
  }, []);

  // Memoized open function
  const openMenu = useCallback((options: ContextMenuOptions): Promise<string | null> => {
    // Close existing menu if open
    if (resolveRef.current) {
      resolveRef.current(null);
      resolveRef.current = null;
    }

    // Compute position and prepare final options
    const position = computePosition(options);
    const finalOpts = { ...options, ...position };
    
    setOpts(finalOpts);
    setOpen(true);
    
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
    });
  }, [computePosition]);

  // Consolidated event handling
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Throttled mouse tracking
    const updateMousePosition = throttle((e: MouseEvent) => {
      mousePos.current = { x: e.clientX, y: e.clientY };
    }, DEFAULTS.THROTTLE_DELAY);

    // Keyboard handler
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        close(null);
      }
    };

    // Add listeners
    document.addEventListener('mousemove', updateMousePosition, { passive: true });
    if (open) {
      document.addEventListener('keydown', handleKeydown);
    }

    // Cleanup
    return () => {
      document.removeEventListener('mousemove', updateMousePosition);
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [open, close]);

  // Memoized context value
  const contextValue = useMemo(() => ({
    openMenu
  }), [openMenu]);

  return (
    <ContextMenuCtx.Provider value={contextValue}>
      {children}
      {open && opts && (
        <ContextMenu options={opts} onClose={close} />
      )}
    </ContextMenuCtx.Provider>
  );
});

ContextMenuProvider.displayName = 'ContextMenuProvider';

// Optimized hook
export function useContextMenu(): ContextMenuState {
  const ctx = useContext(ContextMenuCtx);
  if (!ctx) {
    throw new Error('useContextMenu must be used within ContextMenuProvider');
  }
  return ctx;
}
