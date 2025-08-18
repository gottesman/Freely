import React, { useEffect, useCallback } from 'react'

interface LyricsOverlayProps {
  open: boolean
  onClose: () => void
  lyrics?: string
  title?: string
}

const defaultLyrics = `[Verse 1]
Neon lights in the rearview fade
Echoes drift through the midnight haze
Heartbeat syncs with the passing lines
Chasing fragments of borrowed time

[Chorus]
And we run, we run through electric sky
Falling forward as the moments fly
Holding on to the fading glow
Till the waveform lets us go

[Bridge]
Static whispers under violet rain
Fragments looping in a soft refrain
`

export default function LyricsOverlay({ open, onClose, lyrics = defaultLyrics, title = 'Lyrics' }: LyricsOverlayProps){
  // Close on Escape
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) onClose()
  }, [open, onClose])

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  return (
    <div
      className={`np-lyrics-overlay ${open ? 'active' : ''}`}
      aria-hidden={!open}
      aria-label="Lyrics overlay"
      role="dialog"
    >
      <div className="np-lyrics-scroll" onClick={(e) => e.stopPropagation()}>
        <div className="np-lyrics-body">
          <button
            type="button"
            className="player-icons np-overlay-close"
            aria-label="Close lyrics"
            onClick={onClose}
          >
            <span className="material-symbols-rounded filled">close</span>
          </button>
          <h2 style={{marginTop:0}}>{title}</h2>
          <pre style={{margin:0}}>{lyrics}</pre>
        </div>
      </div>
    </div>
  )
}
