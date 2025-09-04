// Shared helpers for tabs/components (time formatting, etc.)
export function fmtMs(ms?: number){
  if (ms === undefined || ms === null) return '--:--';
  const total = Math.floor(ms/1000);
  const m = Math.floor(total/60);
  const s = total%60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

export function fmtTotalMs(ms?: number){
  if (ms === undefined || ms === null) return '--';
  const totalSec = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

// Helper to safely resolve a hero image URL from spotify-style images array
export function useHeroImage(images?: Array<{url?: string}>, idx = 0){
  // Consumers should call this inside useMemo to keep hook-free
  try { return (window as any).imageRes?.(images, idx) ?? '' } catch { return '' }
}
