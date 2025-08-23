import { useState } from 'react';

export interface UseAddToPlaylistModalReturn {
  /** Whether the modal is open */
  isOpen: boolean;
  /** The current track to add to playlists */
  track: any | null;
  /** Whether the modal was opened from bottom player */
  fromBottomPlayer: boolean;
  /** Open the modal with a track */
  openModal: (track: any, fromBottomPlayer?: boolean) => void;
  /** Close the modal */
  closeModal: () => void;
}

/**
 * Hook for managing the add to playlist modal state
 * @returns Modal state and control functions
 */
export function useAddToPlaylistModal(): UseAddToPlaylistModalReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [track, setTrack] = useState<any | null>(null);
  const [fromBottomPlayer, setFromBottomPlayer] = useState(false);

  const openModal = (trackToAdd: any, isFromBottomPlayer: boolean = false) => {
    setTrack(trackToAdd);
    setFromBottomPlayer(isFromBottomPlayer);
    setIsOpen(true);
  };

  const closeModal = () => {
    setIsOpen(false);
    setTrack(null);
    setFromBottomPlayer(false);
  };

  return {
    isOpen,
    track,
    fromBottomPlayer,
    openModal,
    closeModal,
  };
}
