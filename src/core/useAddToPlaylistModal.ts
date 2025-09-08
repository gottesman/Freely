import { useState, useCallback } from 'react';
import type { SpotifyTrack } from './spotify';

// Modal state interface for better organization
interface ModalState {
  isOpen: boolean;
  track: SpotifyTrack | null;
  fromBottomPlayer: boolean;
}

export interface UseAddToPlaylistModalReturn {
  /** Whether the modal is open */
  isOpen: boolean;
  /** The current track to add to playlists */
  track: SpotifyTrack | null;
  /** Whether the modal was opened from bottom player */
  fromBottomPlayer: boolean;
  /** Open the modal with a track */
  openModal: (track: SpotifyTrack, fromBottomPlayer?: boolean) => void;
  /** Close the modal */
  closeModal: () => void;
}

// Initial state constant
const INITIAL_STATE: ModalState = {
  isOpen: false,
  track: null,
  fromBottomPlayer: false,
} as const;

/**
 * Optimized hook for managing the add to playlist modal state
 * Uses single state object and memoized callbacks for better performance
 * @returns Modal state and control functions
 */
export function useAddToPlaylistModal(): UseAddToPlaylistModalReturn {
  const [state, setState] = useState<ModalState>(INITIAL_STATE);

  const openModal = useCallback((track: SpotifyTrack, fromBottomPlayer: boolean = false) => {
    setState({
      isOpen: true,
      track,
      fromBottomPlayer,
    });
  }, []);

  const closeModal = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return {
    isOpen: state.isOpen,
    track: state.track,
    fromBottomPlayer: state.fromBottomPlayer,
    openModal,
    closeModal,
  };
}
