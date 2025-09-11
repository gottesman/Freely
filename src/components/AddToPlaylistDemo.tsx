import React from 'react';
import { useI18n } from '../core/i18n';

// Example track data for testing
const sampleTrack = {
  id: 'sample-track-1',
  name: 'Example Song Title',
  artists: [
    { id: 'artist-1', name: 'Sample Artist' },
    { id: 'artist-2', name: 'Featured Artist' }
  ],
  album: {
    id: 'album-1',
    name: 'Sample Album',
    images: [
      { url: 'https://via.placeholder.com/300x300/7bd6ff/021?text=Album' }
    ]
  },
  durationMs: 210000 // 3:30
};

export default function AddToPlaylistDemo() {
  const { t } = useI18n();
  const triggerAddToPlaylist = (track: any) => {
    window.dispatchEvent(new CustomEvent('freely:openAddToPlaylistModal',{ detail:{ track } }));
  };

  return (
    <div style={{ padding: '0' }}>
      <p>Click the button below to test the Add to Playlist modal:</p>
      
      <button 
  onClick={() => triggerAddToPlaylist(sampleTrack)}
        style={{
          background: 'var(--accent)',
          color: 'var(--text-dark)',
          border: 'none',
          padding: '12px 24px',
          borderRadius: '8px',
          cursor: 'pointer',
          fontSize: '14px',
          fontWeight: '600'
        }}
      >
        Add Sample Track to Playlist
      </button>
    </div>
  );
}
