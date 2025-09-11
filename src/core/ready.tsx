import { useEffect, useState, useCallback, useMemo } from 'react';
// Import main stylesheet as URL so bundler includes and fingerprints it
// (loaded lazily after fonts) 
// Vite: ?url returns final asset URL
import appCssUrl from '../styles.css?url';
import SpotifyClient from './spotify';
import { useDB } from './dbIndexed';

// Performance constants
const READY_CONSTANTS = {
  TIMEOUTS: {
    MIN_SPLASH_TIME: 600,
    FONT_CHECK_INTERVAL: 100,
    PRELOAD_CHECK_INTERVAL: 50,
    WARMUP_DELAY: 100,
    ICON_CACHE_DELAY: 50
  },
  LIMITS: {
    MAX_FONT_ATTEMPTS: 50, // 5 seconds max wait
    MAX_PRELOAD_ATTEMPTS: 40, // 2 seconds max wait
    MAX_ICON_WIDTH: 50,
    MIN_ICON_WIDTH: 0
  },
  FONT_CONFIG: {
    FAMILY: "'Material Symbols Rounded', sans-serif",
    FALLBACK: 'sans-serif',
    LOAD_SPEC: "400 20px 'Material Symbols Rounded'",
    TEST_ICON: 'play_arrow',
    SIZE: '20px'
  },
  CSS_SELECTORS: {
    APP_CSS_LINK: 'link[data-app-css]',
    MATERIAL_ICONS_CLASS: 'material-symbols-rounded'
  },
  POSITIONING: {
    HIDDEN_LEFT: '-9999px',
    HIDDEN_VISIBILITY: 'hidden',
    ABSOLUTE_POSITION: 'absolute'
  },
  COMMON_ICONS: 'play_arrow pause skip_next skip_previous volume_up favorite add check playlist_add search close menu'
} as const;

// Logging prefixes for better debugging
const LOG_PREFIXES = {
  FONT: '🔤',
  CSS: '🎨',
  WARMUP: '🔥'
} as const;

// Interface definitions for type safety
interface ReadyStates {
  dbReady: boolean;
  fontsReady: boolean;
  cssReady: boolean;
  preloadReady: boolean;
  warmupDone: boolean;
  minTimePassed: boolean;
}

interface UseAppReadyReturn {
  ready: boolean;
  states: ReadyStates;
}

// Utility classes for better organization
class FontManager {
  /**
   * Create a hidden test element for font measurements
   */
  static createTestElement(content: string): HTMLElement {
    const element = document.createElement('span');
    element.style.fontFamily = READY_CONSTANTS.FONT_CONFIG.FAMILY;
    element.style.fontSize = READY_CONSTANTS.FONT_CONFIG.SIZE;
    element.style.position = READY_CONSTANTS.POSITIONING.ABSOLUTE_POSITION;
    element.style.left = READY_CONSTANTS.POSITIONING.HIDDEN_LEFT;
    element.style.visibility = READY_CONSTANTS.POSITIONING.HIDDEN_VISIBILITY;
    element.textContent = content;
    return element;
  }

  /**
   * Test if font is loaded by measuring icon width
   */
  static async testFontLoaded(): Promise<boolean> {
    try {
      await (document as any).fonts?.load?.(READY_CONSTANTS.FONT_CONFIG.LOAD_SPEC);
      
      const testElement = this.createTestElement(READY_CONSTANTS.FONT_CONFIG.TEST_ICON);
      document.body.appendChild(testElement);
      
      const iconWidth = testElement.offsetWidth;
      document.body.removeChild(testElement);
      
      return iconWidth > READY_CONSTANTS.LIMITS.MIN_ICON_WIDTH && 
             iconWidth < READY_CONSTANTS.LIMITS.MAX_ICON_WIDTH;
    } catch {
      return false;
    }
  }

  /**
   * Preload common icons for better performance
   */
  static async preloadCommonIcons(): Promise<void> {
    const iconPreloader = document.createElement('div');
    iconPreloader.className = READY_CONSTANTS.CSS_SELECTORS.MATERIAL_ICONS_CLASS;
    iconPreloader.style.position = READY_CONSTANTS.POSITIONING.ABSOLUTE_POSITION;
    iconPreloader.style.left = READY_CONSTANTS.POSITIONING.HIDDEN_LEFT;
    iconPreloader.style.visibility = READY_CONSTANTS.POSITIONING.HIDDEN_VISIBILITY;
    iconPreloader.innerHTML = READY_CONSTANTS.COMMON_ICONS;
    
    document.body.appendChild(iconPreloader);
    await new Promise(resolve => setTimeout(resolve, READY_CONSTANTS.TIMEOUTS.ICON_CACHE_DELAY));
    document.body.removeChild(iconPreloader);
  }

  /**
   * Wait for font to be ready with retry logic
   */
  static async waitForFont(): Promise<boolean> {
    console.log(`${LOG_PREFIXES.FONT} Waiting for Material Symbols font to load...`);
    
    let attempts = 0;
    while (attempts < READY_CONSTANTS.LIMITS.MAX_FONT_ATTEMPTS) {
      const isLoaded = await this.testFontLoaded();
      if (isLoaded) {
        console.log(`${LOG_PREFIXES.FONT} Material Symbols font verified as loaded`);
        await this.preloadCommonIcons();
        return true;
      }
      
      await new Promise(resolve => 
        setTimeout(resolve, READY_CONSTANTS.TIMEOUTS.FONT_CHECK_INTERVAL)
      );
      attempts++;
    }
    
    console.warn(`${LOG_PREFIXES.FONT} Font loading timeout, proceeding anyway`);
    return false;
  }
}

class StylesheetManager {
  /**
   * Check if app CSS is already loaded
   */
  static isAppCssLoaded(): boolean {
    return document.querySelector(READY_CONSTANTS.CSS_SELECTORS.APP_CSS_LINK) !== null;
  }

  /**
   * Load the main app stylesheet and return a promise that resolves when loaded
   */
  static async loadAppStylesheet(): Promise<boolean> {
    if (this.isAppCssLoaded()) {
      console.log(`${LOG_PREFIXES.CSS} App CSS already loaded`);
      return true;
    }
    
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = appCssUrl;
      link.dataset.appCss = 'true';
      
      const handleLoad = () => {
        console.log(`${LOG_PREFIXES.CSS} App CSS loaded successfully`);
        resolve(true);
      };
      
      const handleError = () => {
        console.warn(`${LOG_PREFIXES.CSS} App CSS failed to load, continuing anyway`);
        resolve(false);
      };
      
      link.addEventListener('load', handleLoad);
      link.addEventListener('error', handleError);
      
      document.head.appendChild(link);
      
      // Fallback timeout in case load/error events don't fire
      setTimeout(() => {
        console.warn(`${LOG_PREFIXES.CSS} CSS load timeout, assuming loaded`);
        resolve(true);
      }, 3000);
    });
  }
}

class PreloadChecker {
  /**
   * Check if electron preload APIs are available
   */
  static isPreloadReady(): boolean {
    const w: any = window;
    return Boolean(w.electron?.spotify);
  }

  /**
   * Wait for preload APIs with retry logic
   */
  static async waitForPreload(): Promise<boolean> {
    let attempts = 0;
    
    while (attempts < READY_CONSTANTS.LIMITS.MAX_PRELOAD_ATTEMPTS) {
      if (this.isPreloadReady()) {
        return true;
      }
      
      await new Promise(resolve => 
        setTimeout(resolve, READY_CONSTANTS.TIMEOUTS.PRELOAD_CHECK_INTERVAL)
      );
      attempts++;
    }
    
    return false; // Fallback after timeout
  }
}

class SpotifyWarmup {
  /**
   * Initialize Spotify client with database cache
   */
  static async warmupSpotifyClient(getApiCache: any, setApiCache: any): Promise<void> {
    console.log(`${LOG_PREFIXES.WARMUP} Starting Spotify client warmup...`);
    
    const spotifyClient = new SpotifyClient();
    spotifyClient.setDatabaseCache({ getApiCache, setApiCache });
    
    // Store globally for useSpotifyClient hook to use
    (window as any).__freelySpotifyClient = spotifyClient;
    
    console.log(`${LOG_PREFIXES.WARMUP} Spotify client warmed up with database cache`);
    
    // Small delay to ensure everything is settled
    await new Promise(resolve => 
      setTimeout(resolve, READY_CONSTANTS.TIMEOUTS.WARMUP_DELAY)
    );
  }
}

/** App readiness steps:
 * 1. DB ready (handled externally) 
 * 2. Material Symbols font loaded (document.fonts)
 * 3. Main app CSS stylesheet loaded 
 * 4. Electron preload APIs responsive (window.electron)
 * 5. Spotify client warmed up with database cache
 */
export function useAppReady(dbReady: boolean): UseAppReadyReturn {
  const { getApiCache, setApiCache, getSetting } = useDB();
  const [fontsReady, setFontsReady] = useState(false);
  const [cssReady, setCssReady] = useState(false);
  const [preloadReady, setPreloadReady] = useState(false);
  const [warmupDone, setWarmupDone] = useState(false);
  const [minTimePassed, setMinTimePassed] = useState(false);

  // Apply appearance settings ASAP once DB is ready (before CSS load to avoid flash)
  useEffect(() => {
    if (!dbReady) return;

    let cancelled = false;

    const clamp = (num: number, min: number, max: number) => Math.min(Math.max(num, min), max);
    const parseBool = (v: string | null | undefined): boolean => {
      if (v == null) return false;
      const s = String(v).trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    };
    const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
      if (!hex) return null;
      let h = hex.trim();
      if (h.startsWith('#')) h = h.slice(1);
      if (h.length === 3) {
        const r = parseInt(h[0] + h[0], 16);
        const g = parseInt(h[1] + h[1], 16);
        const b = parseInt(h[2] + h[2], 16);
        return { r, g, b };
      }
      if (h.length === 6) {
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        return { r, g, b };
      }
      return null;
    };
    const rgbToHsl = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, l = (max + min) / 2;
      if (max === min) {
        h = s = 0; // achromatic
      } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }
      return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
    };
    const hexToHue = (hex: string): number => {
      const rgb = hexToRgb(hex);
      if (!rgb) return 0;
      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      return hsl.h;
    };

    (async () => {
      try {
        const [
          accent,
          text,
          textDark,
          bgImage,
          blurStr,
          blurAmountStr,
          animateStr,
          overlayColor,
          overlayOpacityStr,
          bgRgb,
          accentRgb
        ] = await Promise.all([
          getSetting('ui.accent'),
          getSetting('ui.text'),
          getSetting('ui.textDark'),
          getSetting('ui.bg.image'),
          getSetting('ui.bg.blur'),
          getSetting('ui.bg.blurAmount'),
          getSetting('ui.bg.animate'),
          getSetting('ui.bg.overlayColor'),
          getSetting('ui.bg.overlayOpacity'),
          getSetting('ui.bg.rgb'),
          getSetting('ui.accent.rgb')
        ]);

        if (cancelled) return;

        const root = document.documentElement;
        const bgEl = document.querySelector('.bg') as HTMLElement | null;
        const setVar = (name: string, value: string | null | undefined) => {
          if (!value && value !== '') return; // ignore null/undefined
          try { 
            root.style.setProperty(name, String(value)); 
            // Also set on .bg element for background-specific variables
            if (bgEl && (name.startsWith('--bg-') || name === '--bg-overlay')) {
              bgEl.style.setProperty(name, String(value));
            }
          } catch { /* ignore */ }
        };

        // If .bg element doesn't exist yet, wait for it and retry
        if (!bgEl && (bgImage || blurStr || blurAmountStr || animateStr || overlayColor || overlayOpacityStr)) {
          const retryBgVars = () => {
            const bgElement = document.querySelector('.bg') as HTMLElement | null;
            if (bgElement) {
              // Apply background variables to .bg element
              if (bgImage && bgImage.trim()) {
                const url = bgImage.trim().replace(/"/g, '\\"');
                bgElement.style.setProperty('--bg-image', `url("${url}")`);
              }
              
              const blur = parseBool(blurStr);
              const blurAmount = blurAmountStr != null ? Math.max(0, Math.min(200, Number(blurAmountStr))) : 200;
              if (blur && blurAmount > 0) {
                bgElement.style.setProperty('--bg-filter', `blur(${blurAmount}px) brightness(0.7)`);
                bgElement.style.setProperty('--bg-size', '200%');
                bgElement.style.setProperty('--bg-radius', '100em');
              } else {
                bgElement.style.setProperty('--bg-filter', 'none');
                bgElement.style.setProperty('--bg-size', '100%');
                bgElement.style.setProperty('--bg-radius', '0');
              }

              const animate = parseBool(animateStr);
              bgElement.style.setProperty('--bg-animation', animate ? 'rotate 40s linear infinite' : 'none');

              if (overlayColor || overlayOpacityStr) {
                let rgba: string | null = null;
                if (overlayColor) {
                  const rgb = hexToRgb(overlayColor) || { r: 0, g: 0, b: 0 };
                  let op = 0;
                  if (overlayOpacityStr != null) {
                    const raw = Number(overlayOpacityStr);
                    if (!Number.isNaN(raw)) {
                      op = raw > 1 ? clamp(raw / 100, 0, 1) : clamp(raw, 0, 1);
                    }
                  }
                  rgba = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${op})`;
                }
                if (rgba) bgElement.style.setProperty('--bg-overlay', rgba);
              }
            }
          };
          
          // Try immediately
          retryBgVars();
          
          // Also try after a short delay in case DOM isn't ready yet
          setTimeout(retryBgVars, 100);
        }

        // Core colors
        if (accent) setVar('--accent', accent);
        // Prefer stored triplet; if missing but we have hex, compute on the fly
        if (accentRgb) {
          setVar('--accent-rgb', accentRgb);
        } else if (accent) {
          const rgb = hexToRgb(accent);
          if (rgb) setVar('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
        }
        if (accent) {
          const hue = hexToHue(accent);
          setVar('--accent-hue', String(hue));
        }
        if (text) setVar('--text', text);
        if (textDark) setVar('--text-dark', textDark);
        if (textDark) {
          const hue = hexToHue(textDark);
          setVar('--text-dark-hue', String(hue));
        }
        if (bgRgb) setVar('--bg', bgRgb); // expects "r, g, b"

        // Background image
        if (bgImage && bgImage.trim()) {
          const url = bgImage.trim().replace(/"/g, '\\"');
          setVar('--bg-image', `url("${url}")`);
        }

        // Blur controls size/radius/filter
        const blur = parseBool(blurStr);
        const blurAmount = blurAmountStr != null ? Math.max(0, Math.min(200, Number(blurAmountStr))) : 200;
        if (blur && blurAmount > 0) {
          setVar('--bg-filter', `blur(${blurAmount}px) brightness(0.7)`);
          setVar('--bg-size', '200%');
          setVar('--bg-radius', '100em');
        } else {
          setVar('--bg-filter', 'none');
          setVar('--bg-size', '100%');
          setVar('--bg-radius', '0');
        }

        // Animation
        const animate = parseBool(animateStr);
        setVar('--bg-animation', animate ? 'rotate 40s linear infinite' : 'none');

        // Overlay color + opacity
        if (overlayColor || overlayOpacityStr) {
          let rgba: string | null = null;
          if (overlayColor) {
            const rgb = hexToRgb(overlayColor) || { r: 0, g: 0, b: 0 };
            let op = 0;
            if (overlayOpacityStr != null) {
              const raw = Number(overlayOpacityStr);
              if (!Number.isNaN(raw)) {
                op = raw > 1 ? clamp(raw / 100, 0, 1) : clamp(raw, 0, 1);
              }
            }
            rgba = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${op})`;
          }
          if (rgba) setVar('--bg-overlay', rgba);
        }
      } catch (e) {
        console.warn('🎨 Failed to apply appearance settings early:', e);
      }
    })();

    return () => { cancelled = true; };
  }, [dbReady, getSetting]);

  // Minimum splash visibility (avoid flash)
  useEffect(() => {
    const timer = setTimeout(() => {
      setMinTimePassed(true);
      console.log('⏰ Minimum splash time completed');
    }, READY_CONSTANTS.TIMEOUTS.MIN_SPLASH_TIME);
    return () => clearTimeout(timer);
  }, []);

  // Wait for Material Symbols font and preload common glyphs
  useEffect(() => {
    let cancelled = false;
    
    const initializeFonts = async () => {
      try {
        const success = await FontManager.waitForFont();
        if (!cancelled) {
          setFontsReady(true);
          console.log(`${LOG_PREFIXES.FONT} Fonts initialized, success: ${success}`);
        }
      } catch (error) {
        console.warn(`${LOG_PREFIXES.FONT} Font loading failed, continuing anyway:`, error);
        if (!cancelled) {
          setFontsReady(true);
        }
      }
    };
    
    initializeFonts();
    return () => { cancelled = true; };
  }, []);

  // Once fonts are ready, start loading the full app stylesheet and wait for it
  useEffect(() => {
    if (!fontsReady) return;
    
    let cancelled = false;
    
    const initializeCSS = async () => {
      try {
        console.log(`${LOG_PREFIXES.CSS} Starting app CSS loading...`);
        const success = await StylesheetManager.loadAppStylesheet();
        if (!cancelled) {
          setCssReady(true);
          console.log(`${LOG_PREFIXES.CSS} CSS loading completed, success: ${success}`);
        }
      } catch (error) {
        console.warn(`${LOG_PREFIXES.CSS} CSS loading failed, continuing anyway:`, error);
        if (!cancelled) {
          setCssReady(true);
        }
      }
    };
    
    initializeCSS();
    return () => { cancelled = true; };
  }, [fontsReady]);

  // Check preload exposure (simple polling up to timeout)
  useEffect(() => {
    let cancelled = false;
    
    const initializePreload = async () => {
      try {
        // In browser environment, skip preload check
        const isElectron = Boolean((window as any).electron);
        if (!isElectron) {
          console.log('⚡ Browser environment detected, skipping preload check');
          if (!cancelled) {
            setPreloadReady(true);
          }
          return;
        }
        
        const isReady = await PreloadChecker.waitForPreload();
        if (!cancelled) {
          setPreloadReady(isReady);
          console.log(`⚡ Preload check completed, ready: ${isReady}`);
        }
      } catch (error) {
        console.warn('⚡ Preload check failed:', error);
        if (!cancelled) {
          setPreloadReady(true); // Continue anyway
        }
      }
    };
    
    initializePreload();
    return () => { cancelled = true; };
  }, []);

  // Warm-up: Initialize Spotify client with database cache
  useEffect(() => {
    if (!preloadReady || !dbReady || !cssReady) return;
    
    let cancelled = false;
    
    const initializeWarmup = async () => {
      try {
        console.log(`${LOG_PREFIXES.WARMUP} Starting Spotify client warmup...`);
        
        // In browser environment, create basic client
        const isElectron = Boolean((window as any).electron);
        if (!isElectron) {
          console.log(`${LOG_PREFIXES.WARMUP} Browser environment, creating basic client`);
          const spotifyClient = new SpotifyClient();
          spotifyClient.setDatabaseCache({ getApiCache, setApiCache });
          (window as any).__freelySpotifyClient = spotifyClient;
        } else {
          await SpotifyWarmup.warmupSpotifyClient(getApiCache, setApiCache);
        }
        
        if (!cancelled) {
          setWarmupDone(true);
          console.log(`${LOG_PREFIXES.WARMUP} Warmup completed successfully`);
        }
      } catch (error) {
        console.warn(`${LOG_PREFIXES.WARMUP} Spotify client warmup failed:`, error);
        if (!cancelled) {
          setWarmupDone(true); // Continue anyway
        }
      }
    };
    
    initializeWarmup();
    return () => { cancelled = true; };
  }, [preloadReady, dbReady, cssReady, getApiCache, setApiCache]); // Include cssReady

  // Optimize ready state calculation with useMemo
  const ready = useMemo(() => {
    const isReady = dbReady && fontsReady && cssReady && preloadReady && warmupDone && minTimePassed;
    console.log('🚀 Ready state check:', { 
      dbReady, 
      fontsReady, 
      cssReady,
      preloadReady, 
      warmupDone, 
      minTimePassed, 
      isReady 
    });
    return isReady;
  }, [dbReady, fontsReady, cssReady, preloadReady, warmupDone, minTimePassed]);

  // Optimize states object with useMemo
  const states = useMemo(() => ({
    dbReady,
    fontsReady,
    cssReady,
    preloadReady,
    warmupDone,
    minTimePassed
  }), [dbReady, fontsReady, cssReady, preloadReady, warmupDone, minTimePassed]);

  return { ready, states };
}
