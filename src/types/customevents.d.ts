/**
 * Global CustomEvent type declarations for Freely application.
 *
 * These provide strong typing for the event-driven architecture adopted for
 * navigation, playback control, queue manipulation, and modal orchestration.
 *
 * Usage examples (now fully typed):
 *   window.dispatchEvent(new CustomEvent('freely:playback:next'));
 *   window.addEventListener('freely:playback:setQueue', (e) => {
 *     const { tracks, startIndex } = e.detail; // typed
 *   });
 */

// Minimal generic track shape (kept loose to avoid import cycles in .d.ts ambient context)
// If a richer Track type exists elsewhere you can replace this with `import type { Track } from '...';`
interface FreelyTrack {
  id: string;
  name?: string;
  album?: any; // kept broad; existing runtime supplies album object
  artists?: any[];
  url?: string;
  [k: string]: any;
}

/* Navigation / selection */
interface FreelySelectTrackDetail { trackId: string; }
interface FreelySelectAlbumDetail { albumId: string; }
interface FreelySelectArtistDetail { artistId: string; }
interface FreelySelectPlaylistDetail { playlistId: string; }

/* Add-to-Playlist modal */
interface FreelyOpenAddToPlaylistModalDetail {
  track?: FreelyTrack;                 // single track object
  tracks?: FreelyTrack[];              // optional multiple tracks
  trackData?: FreelyTrack;             // legacy alias used in some call sites
  trackIds?: string[];                 // fallback ids if track objects not available
  fromBottomPlayer?: boolean;          // context flag for UI adjustments
}

/* Playback queue operations */
interface FreelyPlaybackSetQueueDetail {
  tracks: FreelyTrack[];               // full queue to set
  startIndex?: number;                 // index to start playing from
  play?: boolean;                      // if true, begin playback immediately
}
interface FreelyPlaybackEnqueueDetail {
  tracks: FreelyTrack[];               // tracks to append / insert
  atIndex?: number;                    // optional specific insertion index
  playIfIdle?: boolean;                // start playback if nothing currently playing
}
interface FreelyPlaybackPlayAtDetail { index: number; }
interface FreelyPlaybackPlayTrackDetail {
  track: FreelyTrack;                  // track to play (will be inserted if not present)
  playNow?: boolean;                   // force immediate play even if something is playing
}
interface FreelyPlaybackPlayNowDetail {
  track: FreelyTrack;                  // track to play immediately (clears or inserts in queue logic)
}
interface FreelyPlaybackReorderQueueDetail {
  fromIndex: number;
  toIndex: number;
}
interface FreelyPlaybackRemoveTrackDetail {
  trackId?: string;                    // id of track to remove
  index?: number;                      // alternative: direct index in queue
}
// Next / Prev have empty detail but retain typed CustomEvent<undefined>

/**
 * Augment the global WindowEventMap so that addEventListener / dispatchEvent are typed.
 */
declare global {
  interface WindowEventMap {
    // Selection
    'freely:selectTrack': CustomEvent<FreelySelectTrackDetail>;
    'freely:selectAlbum': CustomEvent<FreelySelectAlbumDetail>;
    'freely:selectArtist': CustomEvent<FreelySelectArtistDetail>;
    'freely:selectPlaylist': CustomEvent<FreelySelectPlaylistDetail>;

    // Add-to-Playlist modal
    'freely:openAddToPlaylistModal': CustomEvent<FreelyOpenAddToPlaylistModalDetail>;

    // Playback
    'freely:playback:setQueue': CustomEvent<FreelyPlaybackSetQueueDetail>;
    'freely:playback:enqueue': CustomEvent<FreelyPlaybackEnqueueDetail>;
    'freely:playback:playAt': CustomEvent<FreelyPlaybackPlayAtDetail>;
    'freely:playback:playTrack': CustomEvent<FreelyPlaybackPlayTrackDetail>;
    'freely:playback:playNow': CustomEvent<FreelyPlaybackPlayNowDetail>;
    'freely:playback:reorderQueue': CustomEvent<FreelyPlaybackReorderQueueDetail>;
    'freely:playback:removeTrack': CustomEvent<FreelyPlaybackRemoveTrackDetail>;
    'freely:playback:next': CustomEvent<undefined>;
    'freely:playback:prev': CustomEvent<undefined>;
  }
}

export {};
