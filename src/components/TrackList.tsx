import React, { useMemo } from 'react';
import { useI18n } from '../core/i18n';
import { usePlaybackSelector } from '../core/playback';
import type { SpotifyTrack } from '../core/spotify';
import { fmtMs } from './tabHelpers';
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

export default function TrackList({ tracks, selectedTrackId, playingTrackId, showPlayButton = false, onDeleteTrack, className }: TrackListProps) {
  const { t } = useI18n();
  const queueIds = usePlaybackSelector(s => s.queueIds) as string[] | undefined;
  const currentIndex = usePlaybackSelector(s => s.currentIndex) as number | undefined;
  const { openMenu } = useContextMenu();

  const artistColWidth = useMemo(() => { if (!tracks?.length) return undefined; const names = tracks.map(t => t.artists?.[0]?.name || ''); const longest = names.reduce((a, b) => b.length > a.length ? b : a, ''); if (!longest) return undefined; const avgCharPx = 7.2; const padding = 28; return Math.min(240, Math.max(80, Math.round(longest.length * avgCharPx + padding))); }, [tracks]);

  if (!tracks) return null;

  return (
    <ol className={['np-tracklist', className].filter(Boolean).join(' ')} style={artistColWidth ? ({ ['--artist-col-width' as any]: artistColWidth + 'px' }) : undefined}>
      {tracks.map((tr, i) => {
        const isSelected = tr.id === selectedTrackId;
        const isPlaying = tr.id === playingTrackId;
        return (
          <li
            key={`${tr.id}-${i}`}
            onClick={(e) => { if ((e.target as HTMLElement).closest('.track-action')) return; if (tr.id) window.dispatchEvent(new CustomEvent('freely:selectTrack', { detail: { trackId: tr.id, source: 'track-list' } })); }}
            onKeyDown={(e) => { if ((e.target as HTMLElement).closest('.track-action')) return; if ((e.key === 'Enter' || e.key === ' ') && tr.id) { e.preventDefault(); window.dispatchEvent(new CustomEvent('freely:selectTrack', { detail: { trackId: tr.id, source: 'track-list-key' } })); } }}
            role='button'
            tabIndex={0}
            className={[isSelected ? 'selected' : '', isPlaying ? 'playing' : ''].filter(Boolean).join(' ')}
            aria-current={isSelected ? 'true' : undefined}
            aria-label={t('np.openTrackDetails', 'Open track details') + ': ' + tr.name}
          >
            {isPlaying ? (
              <span className="index playing-icon" aria-hidden="true"><span className="material-symbols-rounded">music_note</span></span>
            ) : (
              <span className="index">{i + 1}</span>
            )}
            {showPlayButton && !isPlaying && (
              <button
                type="button"
                className="play-track-btn track-action"
                aria-label={t('player.playTrack', 'Play track')}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  if (!tr.id) return;
                  const currentSegment = (queueIds || []).slice(currentIndex || 0);
                  const rest = currentSegment.filter(id => id !== tr.id);
                  const newQueue = [tr.id, ...rest];
                  window.dispatchEvent(new CustomEvent('freely:playback:setQueue',{ detail:{ queueIds:newQueue, startIndex:0 } }));
                }}
                onKeyDown={(e) => { e.stopPropagation(); }}
              >
                <span className="material-symbols-rounded filled">play_arrow</span>
              </button>
            )}
            <span className="t-title" title={tr.name}>{tr.name}</span>
            <span className="t-artist-col" title={tr.artists?.map(a => a.name).join(', ') || ''}>{tr.artists?.[0]?.name || '—'}</span>
            <div className="tl-actions">
              <span className="duration">{fmtMs(tr.durationMs)}</span>
              <button
                type="button"
                className="queue-track-btn track-action"
                aria-label={t('player.addToQueue', 'Add to queue')}
                title={t('player.addToQueue', 'Add to queue')}
                onClick={(e) => { e.stopPropagation(); if (tr.id) window.dispatchEvent(new CustomEvent('freely:playback:enqueue',{ detail:{ ids:[tr.id] } })); }}
                onKeyDown={(e) => { e.stopPropagation(); }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>queue</span>
              </button>
              <button
                type="button"
                className="track-more-btn track-action"
                aria-label={t('common.more', 'More')}
                title={t('common.more', 'More')}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!tr) return;
                  const items = buildTrackContextMenuItems({
                    t,
                    trackData: tr,
                    queueList: queueIds,
                    currentIndex,
                    queueRemovable: onDeleteTrack,
                    queueOptions: !isPlaying
                  });
                  await openMenu({ e: e.currentTarget as any, items });
                }}
                onKeyDown={(e) => { e.stopPropagation(); }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>more_horiz</span>
              </button>
              {!!onDeleteTrack && (
                <button
                  type="button"
                  className="delete-track-btn track-action"
                  aria-label={t('player.removeFromPlaylist', 'Remove from playlist')}
                  title={t('player.removeFromPlaylist', 'Remove from playlist')}
                  onClick={(e) => { e.stopPropagation(); if (tr.id) 
                    window.dispatchEvent(new CustomEvent('freely:playback:removeTrack',{ detail:{ id: tr.id } }));
                   }}
                  onKeyDown={(e) => { e.stopPropagation(); }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>delete</span>
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
