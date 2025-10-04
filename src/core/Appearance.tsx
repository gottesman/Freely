export const APPEARANCE_DEFAULTS = {
  accent: '#07b6d5',
  textColor: '#e6eef6',
  textDarkColor: '#002211',
  shadowHex: '#0f1724',
  backgrounds: [
    //'https://img.freepik.com/free-vector/abstract-colorful-flow-shapes-background_23-2148233991.jpg',
    'unsplash:1663275160801-6ce8e9a174b9',
    'unsplash:1725113114015-7d65ebd4f2bb',
    'unsplash:1689344682959-d8b85fdab21a',
    'unsplash:1503264116251-35a269479413',
    'unsplash:1755745360285-0633c972b0fd',
    'unsplash:1755187562093-8faef5ecb7fc',
    'unsplash:1756093035138-7135b07084b5',
    'unsplash:1747697006653-569b3f418cf9',
    'unsplash:1555231955-348aa2312e19',
    'unsplash:1671299087726-f31a0b3e3f7d',
    'unsplash:1662113988373-4a34d5760125',
    'unsplash:1692890846581-da1a95435f34',
    'unsplash:1693389107440-afe980ccbb8d',
    'unsplash:1632260260864-caf7fde5ec36',
    'unsplash:1683914791631-ea9c7b87c75a'
  ],
  // index of the default background inside `backgrounds`
  bgImageIndex: 0,
  bgCustomUrl: '',
  bgBlur: true,
  bgBlurAmount: 200,
  // Default overlay color and opacity (opacity expressed as 0..1)
  bgOverlayColor: '#0A131A',
  bgOverlayOpacity: 0.55
};

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
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
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h: number, s: number, l = (max + min) / 2;
  if (max === min) {
    h = s = 0; // achromatic
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hexToHue(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return hsl.h;
}

export function unsplash(options : {id: string, width?: number, quality?: number, height?: number, cs?: string}): string {
    options.cs = options.cs || 'srgb';
    options.quality = options.quality || 80;
    options.width = options.width || 4000;
    options.height = options.height || Math.round((options.width * 9) / 16);
  return `https://images.unsplash.com/photo-${options.id}?w=${options.width}&h=${options.height}&q=${options.quality}&fit=crop&fm=avif&crop=entropy&cs=${options.cs}`;
}

  // Small square thumbnail helper (use for UI thumbnails)
  export function thumbnailUnsplash(id: string, size = 64, quality = 60): string {
    return `https://images.unsplash.com/photo-${id}?w=${size}&h=${size}&q=${quality}&fit=crop&fm=avif&crop=entropy&cs=tinysrgb`;
  }

// ============================================================================
// Unified Appearance Runtime API (migrated from appearanceRuntime.ts)
// ============================================================================

export interface AppearanceState {
  accent: string;
  accentRgb: string; // 'r, g, b'
  text: string;
  textDark: string;
  bgImage: string; // resolved URL or data:
  blur: boolean;
  blurAmount: number; // px
  overlayColor: string; // hex or rgba()
  overlayOpacity: number; // 0..1
  bgRgb: string; // 'r, g, b'
}

export type AppearancePartial = Partial<AppearanceState>;

const APPEARANCE_CACHE_KEY = '__freely_appearance_cache_v1';
// Debounce config: keep tight for responsiveness but avoid thrashing localStorage
const PERSIST_DEBOUNCE_MS = 120; // tuned small; appearance changes feel instant but writes batch

function deriveAccentRgb(hex: string): string {
  const h = (hex || '').replace('#', '');
  if (h.length < 6) return '0, 0, 0';
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `${r}, ${g}, ${b}`;
}

function normalizeOpacity(val: any, fallback = 0.55): number {
  let n = Number(val);
  if (!isFinite(n)) return fallback;
  if (n > 1) n = n / 100; // allow percentage style
  if (n < 0) n = 0; if (n > 1) n = 1;
  return n;
}

function normalizeOverlay(color: string, opacity: number): string {
  if (!color) return `rgba(0,0,0,${opacity})`;
  if (/^rgba?\(/i.test(color)) return color; // already rgba/rgb
  const rgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${normalizeOpacity(opacity)})`;
}

let currentState: AppearanceState = {
  accent: APPEARANCE_DEFAULTS.accent,
  accentRgb: deriveAccentRgb(APPEARANCE_DEFAULTS.accent),
  text: APPEARANCE_DEFAULTS.textColor,
  textDark: APPEARANCE_DEFAULTS.textDarkColor,
  bgImage: '',
  blur: APPEARANCE_DEFAULTS.bgBlur,
  blurAmount: APPEARANCE_DEFAULTS.bgBlurAmount,
  overlayColor: APPEARANCE_DEFAULTS.bgOverlayColor,
  overlayOpacity: APPEARANCE_DEFAULTS.bgOverlayOpacity,
  bgRgb: (() => {
    const rgb = hexToRgb(APPEARANCE_DEFAULTS.shadowHex); return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : '15, 23, 36';
  })()
};

function readAppearanceCache(): Partial<AppearanceState> | null {
  try {
    const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
let persistTimer: number | null = null;
function flushAppearanceCache(state: AppearanceState) {
  try {
    const { accent, accentRgb, text, textDark, bgImage, blur, blurAmount, overlayColor, overlayOpacity, bgRgb } = state;
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ accent, accentRgb, text, textDark, bgImage, blur, blurAmount, overlayColor, overlayOpacity, bgRgb, ts: Date.now() }));
  } catch { /* ignore */ }
}
function writeAppearanceCache(state: AppearanceState): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    flushAppearanceCache(state);
  }, PERSIST_DEBOUNCE_MS);
}

function setVar(target: HTMLElement, name: string, value: string) {
  try { target.style.setProperty(name, value); } catch { /* ignore */ }
}

function applyColors(state: AppearanceState) {
  const root = document.documentElement;
  setVar(root, '--accent', state.accent);
  setVar(root, '--accent-rgb', state.accentRgb);
  setVar(root, '--accent-hue', String(hexToHue(state.accent)));
  setVar(root, '--text', state.text);
  setVar(root, '--text-dark', state.textDark);
  setVar(root, '--text-dark-hue', String(hexToHue(state.textDark)));
  if (state.bgRgb) setVar(root, '--bg', state.bgRgb);
}

function applyBackground(state: AppearanceState) {
  const root = document.documentElement;
  const bgEl = document.querySelector('.bg') as HTMLElement | null;
  const url = state.bgImage && state.bgImage.trim() ? `url("${state.bgImage.replace(/"/g,'\\"')}")` : '';
  const filter = state.blur && state.blurAmount > 0 ? `blur(${state.blurAmount}px)` : 'none';
  const overlay = normalizeOverlay(state.overlayColor, state.overlayOpacity);

  const applyTarget = (el: HTMLElement) => {
    if (url) setVar(el, '--bg-image', url);
    setVar(el, '--bg-filter', filter);
    setVar(el, '--bg-overlay', overlay);
  };
  applyTarget(root);
  if (bgEl) applyTarget(bgEl);
}

function mergeState(partial: AppearancePartial): AppearanceState {
  // Mutate a shallow clone to keep referential safety outwardly while minimizing allocations
  const merged: AppearanceState = { ...currentState };
  for (const k in partial) {
    // @ts-ignore
    merged[k] = partial[k];
  }
  if (partial.accent && !partial.accentRgb) merged.accentRgb = deriveAccentRgb(partial.accent);
  if (!merged.accentRgb) merged.accentRgb = deriveAccentRgb(merged.accent);
  if (partial.overlayOpacity !== undefined) merged.overlayOpacity = normalizeOpacity(partial.overlayOpacity, merged.overlayOpacity);
  return merged;
}

function applyAppearance(state: AppearanceState, persist = true): void {
  currentState = state === currentState ? { ...state } : { ...state }; // ensure isolation
  applyColors(currentState);
  applyBackground(currentState);
  if (persist) writeAppearanceCache(currentState);
}

function applyAppearancePartial(partial: AppearancePartial): void {
  if (!partial || Object.keys(partial).length === 0) return;
  const before = currentState;
  const merged = mergeState(partial);
  let colorsChanged = false;
  let backgroundChanged = false;
  for (const key of ['accent','accentRgb','text','textDark','bgRgb'] as const) {
    if ((partial as any)[key] !== undefined && (partial as any)[key] !== (before as any)[key]) { colorsChanged = true; break; }
  }
  for (const key of ['bgImage','blur','blurAmount','overlayColor','overlayOpacity'] as const) {
    if ((partial as any)[key] !== undefined && (partial as any)[key] !== (before as any)[key]) { backgroundChanged = true; break; }
  }
  currentState = merged;
  if (colorsChanged) applyColors(currentState);
  if (backgroundChanged) applyBackground(currentState);
  if (colorsChanged || backgroundChanged) writeAppearanceCache(currentState);
}

let cacheSeeded = false;
function seedAppearanceFromCache(cache: Partial<AppearanceState> | null): void {
  if (cacheSeeded || !cache) return;
  cacheSeeded = true;
  const merged = mergeState(cache);
  currentState = merged;
  applyColors(currentState);
  applyBackground(currentState);
}

// Simplified public API
export function getAppearance(): AppearanceState {
  if (!cacheSeeded) {
    seedAppearanceFromCache(readAppearanceCache());
  }
  return { ...currentState };
}
export function setAppearance(partial: AppearancePartial): AppearanceState {
  if (!cacheSeeded) seedAppearanceFromCache(readAppearanceCache());
  // Detect if full state by count (fast path): 
  // We expect 11 keys for a complete state; accentRgb may be omitted if accent provided.
  const keyCount = Object.keys(partial).length;
  if (keyCount >= 10 && 'accent' in partial && 'text' in partial && 'textDark' in partial && 'bgImage' in partial && 'bgRgb' in partial) {
    const full = mergeState(partial as AppearanceState); // ensures derived fields
    applyAppearance(full);
  } else {
    applyAppearancePartial(partial);
  }
  return { ...currentState };
}
