import React, { useEffect, useCallback, useMemo } from 'react'
import { useI18n } from '../core/i18n'

interface LyricsOverlayProps {
  open: boolean
  onClose: () => void
  lyrics?: string
  title?: string
}

// Utility function for safe HTML processing
const sanitizeAndProcessLyrics = (lyrics: string | undefined, fallbackText: string): string => {
  if (!lyrics) return fallbackText;
  
  // Basic HTML sanitization - remove potentially harmful elements
  const cleanLyrics = lyrics
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');
  
  return cleanLyrics;
};

const LyricsOverlay = ({ 
  open, 
  onClose, 
  lyrics, 
  title 
}: LyricsOverlayProps) => {
  const { t } = useI18n();
  
  // Memoized computed values to prevent unnecessary recalculations
  const resolvedTitle = useMemo(() => 
    title || t('lyrics.title')
  , [title, t]);
  
  const processedLyrics = useMemo(() => 
    sanitizeAndProcessLyrics(lyrics, t('lyrics.unavailable'))
  , [lyrics, t]);

  // Optimized keyboard event handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      onClose();
    }
  }, [open, onClose]);

  // Effect for keyboard event listener with proper cleanup
  useEffect(() => {
    if (!open) return; // Only add listener when overlay is open
    
    window.addEventListener('keydown', handleKeyDown, { passive: false });
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  // Memoized click handler to prevent recreation on every render
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  const handleContentClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Early return for performance when overlay is not open
  if (!open) {
    return null;
  }

  return (
    <div
      className={`np-lyrics-overlay ${open ? 'active' : ''}`}
      aria-hidden={!open}
      aria-label={t('lyrics.overlay')}
      role="dialog"
      onClick={handleBackdropClick}
    >
      <div className="np-lyrics-scroll" onClick={handleContentClick}>
        <div className="np-lyrics-body">
          <button
            type="button"
            className="player-icons np-overlay-close"
            aria-label={t('lyrics.close')}
            onClick={onClose}
          >
            <span className="material-symbols-rounded filled">close</span>
          </button>
          <h2 style={{ marginTop: 0 }}>{resolvedTitle}</h2>
          <div 
            className="lyrics-body" 
            style={{ margin: 0 }} 
            dangerouslySetInnerHTML={{ __html: processedLyrics }} 
          />
        </div>
      </div>
    </div>
  );
};

// Custom comparison function for React.memo optimization
const arePropsEqual = (prevProps: LyricsOverlayProps, nextProps: LyricsOverlayProps): boolean => {
  return (
    prevProps.open === nextProps.open &&
    prevProps.onClose === nextProps.onClose &&
    prevProps.lyrics === nextProps.lyrics &&
    prevProps.title === nextProps.title
  );
};

const OptimizedLyricsOverlay = React.memo(LyricsOverlay, arePropsEqual);
OptimizedLyricsOverlay.displayName = 'LyricsOverlay';

export default OptimizedLyricsOverlay;
