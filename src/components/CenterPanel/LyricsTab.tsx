import React, { useCallback } from 'react';
import { BaseLyricsComponent, LyricsProps } from '../../core/Lyrics';
import { useI18n } from '../../core/i18n';

interface LyricsTabProps extends LyricsProps {
  open?: boolean;
  onClose?: () => void;
  onSwitchToRightPanel?: () => void;
}

export default function LyricsTab({ 
  lyrics, 
  title, 
  synced, 
  open = true, 
  onClose,
  onSwitchToRightPanel 
}: LyricsTabProps) {
  const { t } = useI18n();

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget && onClose) {
      onClose();
    }
  }, [onClose]);

  if (!open) return null;

  return (
    <div 
      className={`np-lyrics-overlay ${open ? 'active' : ''}`} 
      aria-hidden={!open} 
      aria-label={t('lyrics.overlay')} 
      role="dialog" 
      onClick={handleBackdropClick}
    >
      <BaseLyricsComponent
        lyrics={lyrics}
        title={title}
        synced={synced}
        showCloseButton={true}
        showSwitchButton={true}
        onClose={onClose}
        onSwitchPanel={onSwitchToRightPanel}
      />
    </div>
  );
}