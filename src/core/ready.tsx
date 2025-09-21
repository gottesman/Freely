import { useEffect, useState, useCallback, useMemo } from 'react';
import { hexToRgb, hexToHue } from './Appearance';
// Import main stylesheet as URL so bundler includes and fingerprints it
// (loaded lazily after fonts) 
// Vite: ?url returns final asset URL
import appCssUrl from '../styles.css?url';
import { SpotifyClient } from './SpotifyClient';
import { useDB } from './Database';

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

interface ReadyProgress {
  percentage: number;
  currentStep: string;
  details: string;
  stepIndex: number;
  totalSteps: number;
}

interface UseAppReadyReturn {
  ready: boolean;
  states: ReadyStates;
  progress: ReadyProgress;
}

// ============================================================================
// Font Management Functions
// ============================================================================

/**
 * Create a hidden test element for font measurements
 */
function createFontTestElement(content: string): HTMLElement {
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
async function testFontLoaded(): Promise<boolean> {
  try {
    await (document as any).fonts?.load?.(READY_CONSTANTS.FONT_CONFIG.LOAD_SPEC);

    const testElement = createFontTestElement(READY_CONSTANTS.FONT_CONFIG.TEST_ICON);
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
async function preloadCommonIcons(): Promise<void> {
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
async function waitForFont(): Promise<boolean> {
  console.log(`${LOG_PREFIXES.FONT} Waiting for Material Symbols font to load...`);

  let attempts = 0;
  while (attempts < READY_CONSTANTS.LIMITS.MAX_FONT_ATTEMPTS) {
    const isLoaded = await testFontLoaded();
    if (isLoaded) {
      console.log(`${LOG_PREFIXES.FONT} Material Symbols font verified as loaded`);
      await preloadCommonIcons();
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

// ============================================================================
// Stylesheet Management Functions
// ============================================================================

/**
 * Check if app CSS is already loaded
 */
function isAppCssLoaded(): boolean {
  return document.querySelector(READY_CONSTANTS.CSS_SELECTORS.APP_CSS_LINK) !== null;
}

/**
 * Load the main app stylesheet and return a promise that resolves when loaded
 */
async function loadAppStylesheet(): Promise<boolean> {
  if (isAppCssLoaded()) {
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

// ============================================================================
// Preload Management Functions
// ============================================================================

/**
 * Check if electron preload APIs are available
 */
function isPreloadReady(): boolean {
  const w: any = window;
  return Boolean(w.electron?.spotify);
}

/**
 * Wait for preload APIs with retry logic
 */
async function waitForPreload(): Promise<boolean> {
  let attempts = 0;

  while (attempts < READY_CONSTANTS.LIMITS.MAX_PRELOAD_ATTEMPTS) {
    if (isPreloadReady()) {
      return true;
    }

    await new Promise(resolve =>
      setTimeout(resolve, READY_CONSTANTS.TIMEOUTS.PRELOAD_CHECK_INTERVAL)
    );
    attempts++;
  }

  return false; // Fallback after timeout
}

// ============================================================================
// Spotify Client Warmup Functions
// ============================================================================

/**
 * Initialize Spotify client with database cache
 */
async function warmupSpotifyClient(getApiCache: any, setApiCache: any): Promise<void> {
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

// ============================================================================
// Appearance Settings Functions
// ============================================================================

/**
 * Utility functions for appearance settings
 */
const clamp = (num: number, min: number, max: number) => Math.min(Math.max(num, min), max);

const parseBool = (v: string | null | undefined): boolean => {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

/**
 * Enhanced setVar that ensures background variables are applied to .bg element
 */
function setAppearanceVar(name: string, value: string | null | undefined): void {
  if (!value && value !== '') return; // ignore null/undefined

  const root = document.documentElement;
  try {
    root.style.setProperty(name, String(value));
    // Always try to set on .bg element for background-specific variables
    if (name.startsWith('--bg-') || name === '--bg-overlay') {
      const bgElement = document.querySelector('.bg') as HTMLElement | null;
      if (bgElement) {
        bgElement.style.setProperty(name, String(value));
      }
    }
  } catch { /* ignore */ }
}

/**
 * Apply background-specific variables to .bg element
 */
function applyBackgroundVars(bgImage: string, blurStr: string, blurAmountStr: string, animateStr: string, overlayColor: string, overlayOpacityStr: string): void {
  const applyToBg = (bgElement: HTMLElement) => {
    // Apply background image
    if (bgImage && bgImage.trim()) {
      const url = bgImage.trim().replace(/"/g, '\\"');
      bgElement.style.setProperty('--bg-image', `url("${url}")`);
    }

    // Apply blur settings (default to enabled if not set)
    const blur = (blurStr == null || blurStr === '') ? true : parseBool(blurStr);
    const blurAmount = blurAmountStr != null ? Math.max(0, Math.min(200, Number(blurAmountStr))) : 200;
    if (blur && blurAmount > 0) {
      bgElement.style.setProperty('--bg-filter', `blur(${blurAmount}px)`);
      bgElement.style.setProperty('--bg-size', '200%');
      bgElement.style.setProperty('--bg-radius', '100em');
    } else {
      bgElement.style.setProperty('--bg-filter', 'none');
      bgElement.style.setProperty('--bg-size', '100%');
      bgElement.style.setProperty('--bg-radius', '0');
    }

    // Apply animation
    const animate = (animateStr == null || animateStr === '') ? true : parseBool(animateStr);
    bgElement.style.setProperty('--bg-animation', animate ? 'rotate 40s linear infinite' : 'none');

    // Apply overlay (use defaults if not set)
    const finalOverlayColor = overlayColor || '#0A131A';
    let rgba: string | null = null;
    if (finalOverlayColor) {
      const rgb = hexToRgb(finalOverlayColor) || { r: 0, g: 0, b: 0 };
      let op = overlayOpacityStr != null ? Number(overlayOpacityStr) : 0.55;
      if (op > 1) op = clamp(op / 100, 0, 1);
      else op = clamp(op, 0, 1);
      rgba = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${op})`;
    }
    if (rgba) bgElement.style.setProperty('--bg-overlay', rgba);
  };

  // Try multiple times to find the .bg element
  const tryApply = (attempts: number) => {
    const bgElement = document.querySelector('.bg') as HTMLElement | null;
    if (bgElement) {
      applyToBg(bgElement);
    } else if (attempts < 20) { // Try for up to 2 seconds
      setTimeout(() => tryApply(attempts + 1), 100);
    }
  };

  tryApply(0);
}

/**
 * Apply core color variables
 */
function applyColorVars(accent: string, text: string, textDark: string, bgRgb: string, accentRgb: string, bgImage: string): void {
  // Core colors
  if (accent) setAppearanceVar('--accent', accent);

  // Prefer stored triplet; if missing but we have hex, compute on the fly
  if (accentRgb) {
    setAppearanceVar('--accent-rgb', accentRgb);
  } else if (accent) {
    const rgb = hexToRgb(accent);
    if (rgb) setAppearanceVar('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  }

  if (accent) {
    const hue = hexToHue(accent);
    setAppearanceVar('--accent-hue', String(hue));
  }

  if (text) setAppearanceVar('--text', text);
  if (textDark) setAppearanceVar('--text-dark', textDark);

  if (textDark) {
    const hue = hexToHue(textDark);
    setAppearanceVar('--text-dark-hue', String(hue));
  }

  if (bgRgb) setAppearanceVar('--bg', bgRgb); // expects "r, g, b"

  // Background image (set on root for compatibility)
  if (bgImage && bgImage.trim()) {
    const url = bgImage.trim().replace(/"/g, '\\"');
    setAppearanceVar('--bg-image', `url("${url}")`);
  }
}

/**
 * Load and apply all appearance settings
 */
async function loadAndApplyAppearanceSettings(getSetting: any): Promise<void> {
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

    // Apply background variables
    applyBackgroundVars(bgImage, blurStr, blurAmountStr, animateStr, overlayColor, overlayOpacityStr);

    // Apply color variables
    applyColorVars(accent, text, textDark, bgRgb, accentRgb, bgImage);

  } catch (e) {
    console.warn('🎨 Failed to apply appearance settings early:', e);
  }
}

// ============================================================================
// Ready State Monitoring
// ============================================================================

/**
 * Performance monitoring for ready states
 */
class ReadyStateMonitor {
  private startTime: number = Date.now();
  private stepTimings: Map<string, { start: number; end?: number; duration?: number; error?: string }> = new Map();

  startStep(stepName: string): void {
    this.stepTimings.set(stepName, { start: Date.now() });
    console.log(`🚀 [${stepName}] Started at ${new Date().toISOString()}`);
  }

  endStep(stepName: string, success: boolean = true, error?: string): void {
    const step = this.stepTimings.get(stepName);
    if (step) {
      const end = Date.now();
      const duration = end - step.start;
      step.end = end;
      step.duration = duration;
      if (error) step.error = error;

      const status = success ? '✅' : '❌';
      const errorMsg = error ? ` (Error: ${error})` : '';
      console.log(`${status} [${stepName}] Completed in ${duration}ms${errorMsg}`);
    }
  }

  getReport(): { totalTime: number; steps: Record<string, any> } {
    const totalTime = Date.now() - this.startTime;
    const steps: Record<string, any> = {};

    for (const [name, timing] of this.stepTimings) {
      steps[name] = {
        duration: timing.duration || 0,
        error: timing.error,
        completed: timing.end !== undefined
      };
    }

    return { totalTime, steps };
  }
}

// Global monitor instance
const readyMonitor = new ReadyStateMonitor();

/**
 * Get detailed description for current initialization step
 */
function getStepDetails(stepName: string): string {
  const stepDetails: Record<string, string> = {
    'Database': 'Setting up local data storage and cache',
    'Fonts': 'Loading Material Symbols font and icons',
    'Styles': 'Applying application styles and themes',
    'Environment': 'Checking system compatibility and APIs',
    'Services': 'Initializing music services and clients',
    'Interface': 'Preparing user interface components'
  };
  return stepDetails[stepName] || 'Initializing application components';
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

  // Start monitoring when hook initializes
  useEffect(() => {
    readyMonitor.startStep('AppReady Hook');
    console.log('🚀 App readiness monitoring started');
  }, []);

  // Apply appearance settings ASAP once DB is ready (before CSS load to avoid flash)
  useEffect(() => {
    if (!dbReady) return;

    let cancelled = false;
    readyMonitor.startStep('Appearance Settings');

    const applySettings = async () => {
      try {
        // Load and apply appearance settings
        await loadAndApplyAppearanceSettings(getSetting);
        if (!cancelled) {
          readyMonitor.endStep('Appearance Settings', true);
        }
      } catch (e) {
        console.warn('🎨 Failed to apply appearance settings early:', e);
        if (!cancelled) {
          readyMonitor.endStep('Appearance Settings', false, String(e));
        }
      }
    };

    applySettings();
    return () => { cancelled = true; };
  }, [dbReady, getSetting]);

  // Minimum splash visibility (avoid flash)
  useEffect(() => {
    readyMonitor.startStep('Minimum Splash Time');
    const timer = setTimeout(() => {
      setMinTimePassed(true);
      readyMonitor.endStep('Minimum Splash Time', true);
      console.log('⏰ Minimum splash time completed');
    }, READY_CONSTANTS.TIMEOUTS.MIN_SPLASH_TIME);
    return () => clearTimeout(timer);
  }, []);

  // Wait for Material Symbols font and preload common glyphs
  useEffect(() => {
    let cancelled = false;
    readyMonitor.startStep('Font Loading');

    const initializeFonts = async () => {
      try {
        console.log(`${LOG_PREFIXES.FONT} Waiting for Material Symbols font to load...`);
        const success = await waitForFont();
        if (!cancelled) {
          setFontsReady(true);
          readyMonitor.endStep('Font Loading', success);
          console.log(`${LOG_PREFIXES.FONT} Fonts initialized, success: ${success}`);
        }
      } catch (error) {
        console.warn(`${LOG_PREFIXES.FONT} Font loading failed, continuing anyway:`, error);
        if (!cancelled) {
          setFontsReady(true); // Continue anyway for better UX
          readyMonitor.endStep('Font Loading', false, String(error));
        }
      }
    };

    // Start font loading immediately (parallel with other operations)
    initializeFonts();
    return () => { cancelled = true; };
  }, []); // Remove dependency on dbReady to allow parallel execution

  // Once fonts are ready, start loading the full app stylesheet and wait for it
  useEffect(() => {
    if (!fontsReady) return;
    
    let cancelled = false;
    
    const initializeCSS = async () => {
      try {
        console.log(`${LOG_PREFIXES.CSS} Starting app CSS loading...`);
        const success = await loadAppStylesheet();
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
        console.log('⚡ Checking preload APIs...');

        // In browser environment, skip preload check
        const isElectron = Boolean((window as any).electron);
        if (!isElectron) {
          console.log('⚡ Browser environment detected, skipping preload check');
          if (!cancelled) {
            setPreloadReady(true);
          }
          return;
        }

        const startTime = Date.now();
        const isReady = await waitForPreload();
        const duration = Date.now() - startTime;

        if (!cancelled) {
          setPreloadReady(isReady);
          console.log(`⚡ Preload check completed in ${duration}ms, ready: ${isReady}`);
        }
      } catch (error) {
        console.warn('⚡ Preload check failed:', error);
        if (!cancelled) {
          setPreloadReady(true); // Continue anyway
        }
      }
    };

    // Start preload check immediately (parallel with other operations)
    initializePreload();
    return () => { cancelled = true; };
  }, []); // Remove dependency on dbReady to allow parallel execution

  // Warm-up: Initialize Spotify client with database cache
  useEffect(() => {
    if (!preloadReady || !dbReady || !cssReady) return;
    
    let cancelled = false;
    
    const initializeWarmup = async () => {
      try {
        console.log(`${LOG_PREFIXES.WARMUP} Starting Spotify client warmup...`);
        
        // In browser environment, create basic client; otherwise warmup via helper
        const isElectron = Boolean((window as any).electron);
        if (!isElectron) {
          console.log(`${LOG_PREFIXES.WARMUP} Browser environment, creating basic client`);
          const spotifyClient = new SpotifyClient();
          spotifyClient.setDatabaseCache({ getApiCache, setApiCache });
          (window as any).__freelySpotifyClient = spotifyClient;
        } else {
          await warmupSpotifyClient(getApiCache, setApiCache);
        }

        // Ensure Spotify token is valid before finishing warmup
        try {
          const client: SpotifyClient = (window as any).__freelySpotifyClient || new SpotifyClient();
          if (client.setDatabaseCache && getApiCache && setApiCache) {
            client.setDatabaseCache({ getApiCache, setApiCache });
          }
          
          console.log(`${LOG_PREFIXES.WARMUP} Checking Spotify token validity...`);
          const tokenStatus = client.getTokenStatus();
          console.log(`${LOG_PREFIXES.WARMUP} Current token status:`, tokenStatus);
          
          if (!client.isTokenValid()) {
            console.log(`${LOG_PREFIXES.WARMUP} Token invalid or expired, clearing cache and fetching new token...`);
            // Clear any invalid cached tokens
            client.clearTokenCache();
            
            console.log(`${LOG_PREFIXES.WARMUP} Ensuring Spotify access token is valid...`);
            await client.ensureAccessToken();
            console.log(`${LOG_PREFIXES.WARMUP} Spotify access token ensured`);
          } else {
            console.log(`${LOG_PREFIXES.WARMUP} Spotify token is already valid`);
          }
        } catch (e) {
          console.warn(`${LOG_PREFIXES.WARMUP} Failed to ensure Spotify token before ready:`, e);
          // If token validation fails, try clearing cache and retrying once
          try {
            const client: SpotifyClient = (window as any).__freelySpotifyClient || new SpotifyClient();
            console.log(`${LOG_PREFIXES.WARMUP} Retrying with cleared token cache...`);
            client.clearTokenCache();
            await client.ensureAccessToken();
            console.log(`${LOG_PREFIXES.WARMUP} Spotify token retry successful`);
          } catch (retryError) {
            console.error(`${LOG_PREFIXES.WARMUP} Spotify token retry also failed:`, retryError);
            // Continue; subsequent calls will attempt refresh again
          }
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

    // Log performance report when app becomes ready
    if (isReady) {
      readyMonitor.endStep('AppReady Hook', true);
      const report = readyMonitor.getReport();
      console.log('🚀 App readiness completed!', {
        totalTime: `${report.totalTime}ms`,
        steps: report.steps
      });
    }

    return isReady;
  }, [dbReady, fontsReady, cssReady, preloadReady, warmupDone, minTimePassed]);  // Calculate progress based on completed steps
  const progress = useMemo((): ReadyProgress => {
    const steps = [
      { name: 'Database', completed: dbReady, weight: 15 },
      { name: 'Fonts', completed: fontsReady, weight: 20 },
      { name: 'Styles', completed: cssReady, weight: 25 },
      { name: 'Environment', completed: preloadReady, weight: 15 },
      { name: 'Services', completed: warmupDone, weight: 20 },
      { name: 'Interface', completed: minTimePassed, weight: 5 }
    ];

    let completedWeight = 0;
    let currentStepIndex = 0;
    let currentStepName = 'Initializing...';
    let currentStepDetails = 'Preparing application components';

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.completed) {
        completedWeight += step.weight;
        currentStepIndex = i + 1;
      } else {
        currentStepName = step.name;
        currentStepDetails = getStepDetails(step.name);
        break;
      }
    }

    const percentage = Math.min(100, Math.round(completedWeight));

    return {
      percentage,
      currentStep: currentStepName,
      details: currentStepDetails,
      stepIndex: currentStepIndex,
      totalSteps: steps.length
    };
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

  return { ready, states, progress };
}
