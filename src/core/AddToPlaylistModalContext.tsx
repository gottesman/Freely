import React, { createContext, useContext } from 'react';
import { useAddToPlaylistModal, UseAddToPlaylistModalReturn } from './useAddToPlaylistModal';

// Create context
const AddToPlaylistModalContext = createContext<UseAddToPlaylistModalReturn | null>(null);

// Provider component
export function AddToPlaylistModalProvider({ children }: { children: React.ReactNode }) {
  const modalState = useAddToPlaylistModal();
  
  return (
    <AddToPlaylistModalContext.Provider value={modalState}>
      {children}
    </AddToPlaylistModalContext.Provider>
  );
}

// Hook to use the modal context
export function useGlobalAddToPlaylistModal(): UseAddToPlaylistModalReturn {
  const context = useContext(AddToPlaylistModalContext);
  if (!context) {
    throw new Error('useGlobalAddToPlaylistModal must be used within an AddToPlaylistModalProvider');
  }
  return context;
}
