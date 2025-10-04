import { APPEARANCE_DEFAULTS, hexToRgb, hexToHue } from './Appearance';

// Central cache key (keep in sync with Ready.tsx if referenced there)
const APPEARANCE_CACHE_KEY = '__freely_appearance_cache_v1';

export interface AppearanceState {
  accent: string; // hex
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

// ============================= Helpers =====================================
export function deriveAccentRgb(hex: string): string {
  const h = (hex || '').replace('#', '');
  if (h.length < 6) return '0, 0, 0';
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `${r}, ${g}, ${b}`;
}

export function normalizeOpacity(val: any, fallback = 0.55): number {
  let n = Number(val);
  if (!isFinite(n)) return fallback;
  if (n > 1) n = n / 100; // allow percentage style
  if (n < 0) n = 0; if (n > 1) n = 1;
  return n;
}

export function normalizeOverlay(color: string, opacity: number): string {
  if (!color) return `rgba(0,0,0,${opacity})`;
  if (/^rgba?\(/i.test(color)) return color; // already rgba/rgb
  const rgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${normalizeOpacity(opacity)})`;
}

// ============================= Cache =======================================
export function readAppearanceCache(): Partial<AppearanceState> | null {
  try { const raw = localStorage.getItem(APPEARANCE_CACHE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function writeAppearanceCache(state: AppearanceState): void {
  try { localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ ...state, ts: Date.now() })); } catch { /* ignore */ }
}

export function updateAppearanceCache(partial: AppearancePartial): void {
  currentState = mergeState(partial);
  writeAppearanceCache(currentState);
}

// ============================= Application =================================
export function applyAppearance(state: AppearanceState): void {
  currentState = { ...state };
  applyColors(currentState);
  applyBackground(currentState);
  writeAppearanceCache(currentState);
}

export function applyAppearancePartial(partial: AppearancePartial): void {
  const before = currentState;
  const merged = mergeState(partial);
  const colorKeys = ['accent','accentRgb','text','textDark','bgRgb'] as const;
  const backgroundKeys = ['bgImage','blur','blurAmount','overlayColor','overlayOpacity'] as const;
  const colorsChanged = colorKeys.some(k => (partial as any)[k] !== undefined && (partial as any)[k] !== (before as any)[k]);
  const backgroundChanged = backgroundKeys.some(k => (partial as any)[k] !== undefined && (partial as any)[k] !== (before as any)[k]);
  currentState = merged;
  if (colorsChanged) applyColors(currentState);
  if (backgroundChanged) applyBackground(currentState);
  if (colorsChanged || backgroundChanged) writeAppearanceCache(currentState);
}

export function seedAppearanceFromCache(cache: Partial<AppearanceState> | null): void {
  if (!cache) return;
  const merged = mergeState(cache);
  currentState = merged;
  applyColors(currentState);
  applyBackground(currentState);
}

// ============================= Internal impl ===============================
function mergeState(partial: AppearancePartial): AppearanceState {
  const merged: AppearanceState = { ...currentState, ...partial } as AppearanceState;
  // Derivations
  if (partial.accent && !partial.accentRgb) {
    merged.accentRgb = deriveAccentRgb(partial.accent);
  }
  if (!merged.accentRgb) merged.accentRgb = deriveAccentRgb(merged.accent);
  if (partial.overlayOpacity !== undefined) {
    merged.overlayOpacity = normalizeOpacity(partial.overlayOpacity, merged.overlayOpacity);
  }
  return merged;
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

export function getCurrentAppearance(): AppearanceState {
  return { ...currentState };
}

// Convenience builder for callers that possess raw DB values
export function buildAppearanceState(params: Partial<AppearanceState>): AppearanceState {
  return mergeState(params);
}
