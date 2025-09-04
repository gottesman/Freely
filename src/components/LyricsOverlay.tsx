import React, { useEffect, useCallback } from 'react'
import { useI18n } from '../core/i18n'

interface LyricsOverlayProps {
  open: boolean
  onClose: () => void
  lyrics?: string
  title?: string
}

export default function LyricsOverlay({ open, onClose, lyrics, title }: LyricsOverlayProps){
  const { t } = useI18n();
  const resolvedTitle = title || t('lyrics.title');
  // Close on Escape
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) onClose()
  }, [open, onClose])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  lyrics = lyrics || t('lyrics.unavailable');

  return (
    <div
      className={`np-lyrics-overlay ${open ? 'active' : ''}`}
      aria-hidden={!open}
  aria-label={t('lyrics.overlay')}
      role="dialog"
    >
      <div className="np-lyrics-scroll" onClick={(e) => e.stopPropagation()}>
        <div className="np-lyrics-body">
          <button
            type="button"
            className="player-icons np-overlay-close"
            aria-label={t('lyrics.close')}
            onClick={onClose}
          >
            <span className="material-symbols-rounded filled">close</span>
          </button>
          <h2 style={{marginTop:0}}>{resolvedTitle}</h2>
          <div className="lyrics-body" style={{margin:0}} dangerouslySetInnerHTML={{ __html: lyrics || '' }} />
        </div>
      </div>
    </div>
  )
}
