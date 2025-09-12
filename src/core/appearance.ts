export const APPEARANCE_DEFAULTS = {
  accent: '#6b21a8',
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
  bgAnimate: true,
  // Default overlay color and opacity (opacity expressed as 0..1)
  bgOverlayColor: '#0A131A',
  bgOverlayOpacity: 0.55,
  bgSize: '200%',
  bgRadius: '100em'
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