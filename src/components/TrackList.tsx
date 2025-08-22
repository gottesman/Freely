import React, { useMemo } from 'react';
import { useI18n } from '../core/i18n';
import { usePlayback } from '../core/playback';
import type { SpotifyTrack } from '../core/spotify';

// Duration formatting helper (mm:ss)
function fmt(ms?: number){
  if(!ms && ms!==0) return '--:--';
  const total = Math.floor(ms/1000); const m = Math.floor(total/60); const s = total%60; return m+':' + (s<10?'0':'')+s;
}

export interface TrackListProps {
  tracks?: SpotifyTrack[];
  selectedTrackId?: string; // highlighted selection (e.g., details view)
  playingTrackId?: string; // currently playing track
  showPlayButton?: boolean;
  onSelectTrack?: (id: string)=>void;
  className?: string;
}

export default function TrackList({ tracks, selectedTrackId, playingTrackId, showPlayButton = false, onSelectTrack, className }: TrackListProps){
  const { t } = useI18n();
  const { queueIds, setQueue, currentIndex, enqueue } = usePlayback();

  const artistColWidth = useMemo(()=>{ if(!tracks?.length) return undefined; const names = tracks.map(t=> t.artists?.[0]?.name || ''); const longest = names.reduce((a,b)=> b.length>a.length? b:a,''); if(!longest) return undefined; const avgCharPx=7.2; const padding=28; return Math.min(240, Math.max(80, Math.round(longest.length*avgCharPx+padding))); }, [tracks]);

  if(!tracks) return null;

  return (
    <ol className={['np-tracklist', className].filter(Boolean).join(' ')} style={artistColWidth ? ({ ['--artist-col-width' as any]: artistColWidth + 'px' }) : undefined}>
      {tracks.map((tr,i)=>{
        const isSelected = tr.id === selectedTrackId;
        const isPlaying = tr.id === playingTrackId;
        return (
          <li
            key={tr.id}
            onClick={(e)=> { if((e.target as HTMLElement).closest('.track-action')) return; if(tr.id && onSelectTrack) onSelectTrack(tr.id); }}
            onKeyDown={(e)=> { if((e.target as HTMLElement).closest('.track-action')) return; if((e.key==='Enter' || e.key===' ') && tr.id && onSelectTrack){ e.preventDefault(); onSelectTrack(tr.id); } }}
            role={onSelectTrack ? 'button' : undefined}
            tabIndex={onSelectTrack ? 0 : undefined}
            className={[isSelected?'selected':'', isPlaying?'playing':''].filter(Boolean).join(' ')}
            aria-current={isSelected? 'true': undefined}
            aria-label={onSelectTrack ? (t('np.openTrackDetails','Open track details') + ': ' + tr.name) : undefined}
          >
            {isPlaying ? (
              <span className="index playing-icon" aria-hidden="true"><span className="material-symbols-rounded">music_note</span></span>
            ) : (
              <span className="index">{i+1}</span>
            )}
            {showPlayButton && !isPlaying && (
              <button
                type="button"
                className="play-track-btn track-action"
                aria-label={t('player.playTrack','Play track')}
                onClick={(e: React.MouseEvent)=>{
                  e.stopPropagation();
                  if(!tr.id) return;
                  const currentSegment = queueIds.slice(currentIndex);
                  const rest = currentSegment.filter(id => id !== tr.id);
                  const newQueue = [tr.id, ...rest];
                  setQueue(newQueue, 0);
                }}
                onKeyDown={(e)=>{ e.stopPropagation(); }}
              >
                <span className="material-symbols-rounded filled">play_arrow</span>
              </button>
            )}
            <span className="t-title" title={tr.name}>{tr.name}</span>
            <span className="t-artist-col" title={tr.artists?.map(a=>a.name).join(', ') || ''}>{tr.artists?.[0]?.name || '—'}</span>
            <div className="tl-actions">
              <span className="duration">{fmt(tr.durationMs)}</span>
              <button
                type="button"
                className="queue-track-btn track-action"
                aria-label={t('player.addToQueue','Add to queue')}
                title={t('player.addToQueue','Add to queue')}
                onClick={(e)=>{ e.stopPropagation(); if(tr.id) enqueue(tr.id); }}
                onKeyDown={(e)=>{ e.stopPropagation(); }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>queue</span>
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
