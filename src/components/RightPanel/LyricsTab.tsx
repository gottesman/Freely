import React from 'react';
import { BaseLyricsComponent, LyricsProps } from '../../core/Lyrics';

interface LyricsTabProps extends LyricsProps {
  onSwitchToCenterPanel?: () => void;
}

export default function LyricsTab({ 
  lyrics, 
  title, 
  synced,
  onSwitchToCenterPanel 
}: LyricsTabProps) {
  return (
    <div className="lyrics-right-panel">
      <BaseLyricsComponent
        lyrics={lyrics}
        title={title}
        synced={synced}
        className="right-panel-lyrics"
        showSettings={true}
        showSwitchButton={true}
        switchButtonIcon="open_in_full"
        onSwitchPanel={onSwitchToCenterPanel}
      />
    </div>
  );
}