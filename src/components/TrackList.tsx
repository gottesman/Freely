import React, { useCallback, useMemo } from 'react';
import { useI18n } from '../core/i18n';
import { usePlaybackSelector } from '../core/playback';
import type { SpotifyTrack } from '../core/spotify';
import { fmtMs, navigationEvents, playbackEvents, calculateArtistColWidth } from './tabHelpers';
import { buildTrackContextMenuItems } from './ContextMenu';
import { useContextMenu } from '../core/ContextMenuContext';

export interface TrackListProps {
  tracks?: SpotifyTrack[];
  selectedTrackId?: string; // highlighted selection (e.g., details view)
  playingTrackId?: string; // currently playing track
  showPlayButton?: boolean;
  onDeleteTrack?: boolean; // if true, show "remove from playlist" option
  className?: string;
}

// Constants for better performance
const BUTTON_ICON_STYLE = { fontSize: '20px' } as const;

// Memoized track action button component
const TrackActionButton = React.memo(({
  className,
  ariaLabel,
  title,
  onClick,
  icon,
  iconStyle,
  filled = false
}: {
  className: string;
  ariaLabel: string;
  title?: string;
  onClick: (e: React.MouseEvent) => void;
  icon: string;
  iconStyle?: React.CSSProperties;
  filled?: boolean;
}) => (
  <button
    type="button"
    className={`${className} track-action`}
    aria-label={ariaLabel}
    title={title}
    onClick={onClick}
    onKeyDown={(e) => { e.stopPropagation(); }}
  >
    <span 
      className={`material-symbols-rounded${filled ? ' filled' : ''}`} 
      style={iconStyle}
    >
      {icon}
    </span>
  </button>
));

TrackActionButton.displayName = 'TrackActionButton';

// Memoized track item component
const TrackItem = React.memo(({
  track,
  index,
  isSelected,
  isPlaying,
  showPlayButton,
  onDeleteTrack,
  queueIds,
  currentIndex,
  onTrackClick,
  onTrackKeyDown,
  onPlayTrack,
  onEnqueueTrack,
  onMoreClick,
  onDeleteClick,
  t
}: {
  track: SpotifyTrack;
  index: number;
  isSelected: boolean;
  isPlaying: boolean;
  showPlayButton: boolean;
  onDeleteTrack?: boolean;
  queueIds?: string[];
  currentIndex?: number;
  onTrackClick: (trackId: string) => void;
  onTrackKeyDown: (e: React.KeyboardEvent, trackId: string) => void;
  onPlayTrack: (trackId: string) => void;
  onEnqueueTrack: (trackId: string) => void;
  onMoreClick: (e: React.MouseEvent, track: SpotifyTrack) => void;
  onDeleteClick: (trackId: string) => void;
  t: (key: string, fallback?: string) => string;
}) => {
  // Memoized class name computation
  const className = useMemo(() => 
    [isSelected ? 'selected' : '', isPlaying ? 'playing' : ''].filter(Boolean).join(' '),
    [isSelected, isPlaying]
  );

  // Memoized artist names
  const artistNames = useMemo(() => 
    track.artists?.map(a => a.name).join(', ') || '',
    [track.artists]
  );

  const handleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.track-action')) return;
    if (track.id) onTrackClick(track.id);
  }, [track.id, onTrackClick]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('.track-action')) return;
    if ((e.key === 'Enter' || e.key === ' ') && track.id) {
      e.preventDefault();
      onTrackKeyDown(e, track.id);
    }
  }, [track.id, onTrackKeyDown]);

  const handlePlayClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.id) onPlayTrack(track.id);
  }, [track.id, onPlayTrack]);

  const handleEnqueueClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.id) onEnqueueTrack(track.id);
  }, [track.id, onEnqueueTrack]);

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onMoreClick(e, track);
  }, [track, onMoreClick]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (track.id) onDeleteClick(track.id);
  }, [track.id, onDeleteClick]);

  return (
    <li
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      className={className}
      aria-current={isSelected ? 'true' : undefined}
      aria-label={`${t('np.openTrackDetails', 'Open track details')}: ${track.name}`}
    >
      {isPlaying ? (
        <span className="index playing-icon" aria-hidden="true">
          <span className="material-symbols-rounded">music_note</span>
        </span>
      ) : (
        <span className="index">{index + 1}</span>
      )}

      {showPlayButton && !isPlaying && (
        <TrackActionButton
          className="play-track-btn"
          ariaLabel={t('player.playTrack', 'Play track')}
          onClick={handlePlayClick}
          icon="play_arrow"
          filled
        />
      )}

      <span className="t-title" title={track.name}>{track.name}</span>
      <span className="t-artist-col" title={artistNames}>{track.artists?.[0]?.name || '—'}</span>
      
      <div className="tl-actions">
        <span className="duration">{fmtMs(track.durationMs)}</span>
        
        <TrackActionButton
          className="queue-track-btn"
          ariaLabel={t('player.addToQueue', 'Add to queue')}
          title={t('player.addToQueue', 'Add to queue')}
          onClick={handleEnqueueClick}
          icon="queue"
          iconStyle={BUTTON_ICON_STYLE}
        />

        <TrackActionButton
          className="track-more-btn"
          ariaLabel={t('common.more', 'More')}
          title={t('common.more', 'More')}
          onClick={handleMoreClick}
          icon="more_horiz"
          iconStyle={BUTTON_ICON_STYLE}
        />

        {onDeleteTrack && (
          <TrackActionButton
            className="delete-track-btn"
            ariaLabel={t('player.removeFromPlaylist', 'Remove from playlist')}
            title={t('player.removeFromPlaylist', 'Remove from playlist')}
            onClick={handleDeleteClick}
            icon="delete"
            iconStyle={BUTTON_ICON_STYLE}
          />
        )}
      </div>
    </li>
  );
});

TrackItem.displayName = 'TrackItem';

export default function TrackList({ 
  tracks, 
  selectedTrackId, 
  playingTrackId, 
  showPlayButton = false, 
  onDeleteTrack, 
  className 
}: TrackListProps) {
  const { t } = useI18n();
  const queueIds = usePlaybackSelector(s => s.queueIds) as string[] | undefined;
  const currentIndex = usePlaybackSelector(s => s.currentIndex) as number | undefined;
  const { openMenu } = useContextMenu();

  // Use tabHelpers function instead of duplicating logic
  const artistColWidth = useMemo(() => calculateArtistColWidth(tracks), [tracks]);

  // Memoized style object
  const listStyle = useMemo(() => 
    artistColWidth ? { ['--artist-col-width' as any]: `${artistColWidth}px` } : undefined,
    [artistColWidth]
  );

  // Memoized className
  const listClassName = useMemo(() => 
    ['np-tracklist', className].filter(Boolean).join(' '),
    [className]
  );

  // Optimized event handlers
  const handleTrackClick = useCallback((trackId: string) => {
    navigationEvents.selectTrack(trackId, 'track-list');
  }, []);

  const handleTrackKeyDown = useCallback((e: React.KeyboardEvent, trackId: string) => {
    navigationEvents.selectTrack(trackId, 'track-list-key');
  }, []);

  const handlePlayTrack = useCallback((trackId: string) => {
    // Use optimized playNow event which handles both UI update and queue management
    const currentSegment = (queueIds || []).slice(currentIndex || 0);
    const rest = currentSegment.filter(id => id !== trackId);
    const newQueue = [trackId, ...rest];
    playbackEvents.playNow(newQueue);
  }, [queueIds, currentIndex]);

  const handleEnqueueTrack = useCallback((trackId: string) => {
    playbackEvents.enqueue([trackId]);
  }, []);

  const handleMoreClick = useCallback(async (e: React.MouseEvent, track: SpotifyTrack) => {
    const items = buildTrackContextMenuItems({
      t,
      trackData: track,
      queueList: queueIds,
      currentIndex,
      queueRemovable: onDeleteTrack,
      queueOptions: track.id !== playingTrackId
    });
    await openMenu({ e: e.currentTarget as any, items });
  }, [t, queueIds, currentIndex, onDeleteTrack, playingTrackId, openMenu]);

  const handleDeleteClick = useCallback((trackId: string) => {
    playbackEvents.removeTrack(trackId);
  }, []);

  if (!tracks) return null;

  return (
    <ol className={listClassName} style={listStyle}>
      {tracks.map((track, index) => (
        <TrackItem
          key={`${track.id}-${index}`}
          track={track}
          index={index}
          isSelected={track.id === selectedTrackId}
          isPlaying={track.id === playingTrackId}
          showPlayButton={showPlayButton}
          onDeleteTrack={onDeleteTrack}
          queueIds={queueIds}
          currentIndex={currentIndex}
          onTrackClick={handleTrackClick}
          onTrackKeyDown={handleTrackKeyDown}
          onPlayTrack={handlePlayTrack}
          onEnqueueTrack={handleEnqueueTrack}
          onMoreClick={handleMoreClick}
          onDeleteClick={handleDeleteClick}
          t={t}
        />
      ))}
    </ol>
  );
}
