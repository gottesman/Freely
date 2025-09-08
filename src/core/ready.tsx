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
  WARMUP: '🔥'
} as const;

// Interface definitions for type safety
interface ReadyStates {
  dbReady: boolean;
  fontsReady: boolean;
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
   * Load the main app stylesheet
   */
  static loadAppStylesheet(): void {
    if (this.isAppCssLoaded()) return;
    
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = appCssUrl;
    link.dataset.appCss = 'true';
    document.head.appendChild(link);
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
 * 3. Electron preload APIs responsive (window.electron)
 * 4. Spotify client warmed up with database cache
 */
export function useAppReady(dbReady: boolean): UseAppReadyReturn {
  const { getApiCache, setApiCache } = useDB();
  const [fontsReady, setFontsReady] = useState(false);
  const [preloadReady, setPreloadReady] = useState(false);
  const [warmupDone, setWarmupDone] = useState(false);
  const [minTimePassed, setMinTimePassed] = useState(false);

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

  // Once fonts are ready, start loading the full app stylesheet if not already
  useEffect(() => {
    if (!fontsReady) return;
    StylesheetManager.loadAppStylesheet();
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
    if (!preloadReady || !dbReady) return;
    
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
  }, [preloadReady, dbReady, getApiCache, setApiCache]); // Use direct dependencies

  // Optimize ready state calculation with useMemo
  const ready = useMemo(() => {
    const isReady = dbReady && fontsReady && preloadReady && warmupDone && minTimePassed;
    console.log('🚀 Ready state check:', { 
      dbReady, 
      fontsReady, 
      preloadReady, 
      warmupDone, 
      minTimePassed, 
      isReady 
    });
    return isReady;
  }, [dbReady, fontsReady, preloadReady, warmupDone, minTimePassed]);

  // Optimize states object with useMemo
  const states = useMemo(() => ({
    dbReady,
    fontsReady,
    preloadReady,
    warmupDone,
    minTimePassed
  }), [dbReady, fontsReady, preloadReady, warmupDone, minTimePassed]);

  return { ready, states };
}
