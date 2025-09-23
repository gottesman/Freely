import React from 'react';
import Player from './Player';

type Props = {
  lyricsOpen?: boolean;
  onToggleLyrics?: () => void;
  onToggleQueueTab?: () => void;
  onToggleDownloads?: () => void;
  queueActive?: boolean;
  downloadsActive?: boolean;
  onPIPtoggle?: (pip: boolean) => void;
};

export default function MainPlayer(props: Props) {
  return <Player variant="main" {...props} />;
}
