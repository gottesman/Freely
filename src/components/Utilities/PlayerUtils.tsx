// Shared utilities for player components

// Utility functions
export const formatTime = (ms?: number): string => {
  if (ms === undefined || isNaN(ms)) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + s.toString().padStart(2, '0');
};

export const createPlaybackEvent = (type: string) => () =>
  window.dispatchEvent(new Event(`freely:playback:${type}`));

export const createCustomEvent = (type: string, detail: any) =>
  window.dispatchEvent(new CustomEvent(type, { detail }));

// Optimized refs structure
export const createPlayerRefs = () => ({
  volume: null as HTMLInputElement | null,
  raf: null as number | null,
  lastFrameTime: null as number | null,
  position: 0,
  duration: 0,
  autoNextTriggered: false,
  mounted: true,
  lastStateUpdate: 0
});

// Constants
export const RAF_THROTTLE_MS = 1 / 60 * 1000; // Throttle state updates to reduce re-renders

// State management helpers
export const useTrackMetadata = (currentTrack: any, isTrackLoading: boolean, t: (key: string) => string) => {
  return {
    title: currentTrack?.name || (isTrackLoading ? t('np.loading') : t('np.noTrack')),
    artist: currentTrack?.artists?.map((a: any) => a.name).join(', ') || '',
    album: currentTrack?.album?.name || '',
    cover: (window as any).imageRes?.(currentTrack?.album?.images, 0) || '',
    durationMs: currentTrack?.durationMs || 0
  };
};

export const useLoadingState = (trackLoading: boolean, currentTrack: any, noSource: boolean, backendPosition: any, backendDuration: any, playbackUrl: string) => {
  if (trackLoading) {
    return true; // Explicit loading state
  }

  // If we have a current track with a source but no backend position/duration data, we're likely loading
  if (currentTrack && (currentTrack as any).source && !noSource) {
    const hasBackendData = backendPosition !== undefined || backendDuration !== undefined;
    const hasPlaybackUrl = playbackUrl && playbackUrl !== '';

    // Consider it loading if we have started playback (have URL) but don't have backend data yet
    if (hasPlaybackUrl && !hasBackendData) {
      return true;
    }
  }

  return false;
};

export const useNoSourceState = (currentTrack: any, playbackUrl: string) => {
  if (!currentTrack) return false; // nothing selected yet
  const sourceMeta = (currentTrack as any).source;
  return !sourceMeta && !playbackUrl; // treat absence as needing selection
};

export const useProgressCalculation = (isSeeking: boolean, seekPreviewMs: number | null, backendPosition: any, backendDuration: any, durationMs: number) => {
  // Prioritize backend duration over metadata duration
  const duration = backendDuration ? backendDuration * 1000 : durationMs;
  if (!duration) return 0;

  // Use seek preview if seeking, otherwise use real backend position
  const positionMs = isSeeking && seekPreviewMs != null
    ? seekPreviewMs
    : (backendPosition ? backendPosition * 1000 : 0);

  return Math.min(1, positionMs / duration);
};