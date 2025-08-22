import React, { useEffect, useRef, useState } from 'react'
import { usePlayback } from '../core/playback'
import { useI18n } from '../core/i18n'
import { useAlerts } from '../core/alerts'

export default function BottomPlayer({ lyricsOpen, onToggleLyrics, onActivateSongInfo, onToggleQueueTab, queueActive, onSelectArtist }: { lyricsOpen?: boolean, onToggleLyrics?: () => void, onActivateSongInfo?: () => void, onToggleQueueTab?: () => void, queueActive?: boolean, onSelectArtist?: (id: string)=>void }){
  const [volume, setVolume] = useState<number>(40)
  const volRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // set initial CSS var for the slider
    if (volRef.current) volRef.current.style.setProperty('--vol', `${volume}%`)
  }, [])

  const onVolume = (v: number) => {
    setVolume(v)
    if (volRef.current) volRef.current.style.setProperty('--vol', `${v}%`)
  }

  const { currentTrack, loading: trackLoading, error, next, prev } = usePlayback();
  const { t } = useI18n();
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [positionMs, setPositionMs] = useState<number>(0);

  // Global alerts
  const { push: pushAlert, alerts } = useAlerts();
  // When playback error appears, create an alert (de-dupe by existing same message)
  useEffect(()=>{
    if(error && !alerts.some(a=>a.msg === error)){
      pushAlert(error, 'error');
    }
  }, [error, alerts, pushAlert]);

  // Reset position when track changes
  useEffect(() => { setPositionMs(0); }, [currentTrack?.id]);

  // Simulated playback timer (since we don't have audio element yet)
  useEffect(() => {
    if (!isPlaying) return;
    const duration = currentTrack?.durationMs || 0;
    if (!duration) return;
    const iv = setInterval(() => {
      setPositionMs(p => {
        const updated = p + 1000;
        if (updated >= duration) {
          clearInterval(iv);
          // Snap to end, then auto-advance
          setTimeout(() => { next(); }, 0);
          return duration;
        }
        return updated;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [isPlaying, currentTrack?.id, currentTrack?.durationMs, next]);

  function togglePlay(){ setIsPlaying(p => !p); }

  function fmt(ms?: number){
    if (ms === undefined || isNaN(ms)) return '--:--';
    const totalSec = Math.floor(ms/1000);
    const m = Math.floor(totalSec/60);
    const s = totalSec % 60;
    return m + ':' + s.toString().padStart(2,'0');
  }

  const durationMs = currentTrack?.durationMs || 0;
  const progress = durationMs ? Math.min(1, positionMs / durationMs) : 0;

  function onSeek(e: React.MouseEvent<HTMLDivElement, MouseEvent>){
    if (!durationMs) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, x / rect.width));
    setPositionMs(Math.floor(ratio * durationMs));
  }

  const title = currentTrack?.name || (trackLoading ? t('np.loading') : t('np.noTrack'));
  const artist = currentTrack?.artists?.map(a=>a.name).join(', ') || '';
  const album = currentTrack?.album?.name || '';
  const cover = currentTrack?.album?.images?.[0]?.url || '/icon-192.png';

  return (
    <div className="bottom-player main-panels">
      <div className='track-progress'>
        <div className='time current'>{fmt(positionMs)}</div>
  <div className='bar' onClick={onSeek} role="progressbar" aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={positionMs} aria-label={t('np.trackPosition','Track position')}>
          <div className='fill' style={{ width: `${progress*100}%` }} />
          <div className='handle' style={{ left: `${progress*100}%` }} />
        </div>
        <div className='time total'>{fmt(durationMs)}</div>
      </div>
      <div className="track-player">
      <div className="meta-block">
        <div
          className="meta"
          role="button"
          tabIndex={0}
          aria-label={t('np.showDetails','Show song details')}
          onClick={() => onActivateSongInfo && onActivateSongInfo()}
          onKeyDown={(e) => { if((e.key === 'Enter' || e.key === ' ') && onActivateSongInfo){ e.preventDefault(); onActivateSongInfo(); } }}
        >
          <img className="album-cover" src={cover} alt={album} />
          <div className="meta-text">
            <div className="song-title">{title}</div>
            <div className="song-artist">
              {currentTrack?.artists?.map((a,i)=>(<React.Fragment key={a.id||a.name}>{i>0?', ':''}<button type="button" className="np-link artist inline" onClick={(e)=>{ e.stopPropagation(); if(onSelectArtist && a.id) onSelectArtist(a.id); else if(a.url) window.open(a.url,'_blank'); }}>{a.name}</button></React.Fragment>))}
            </div>
            <div className="song-album">{album}</div>
          </div>
        </div>
  <button className="small player-icons player-icons-add-playlist" aria-label={t('player.addPlaylist')}><span className="material-symbols-rounded">add_circle</span></button>
      </div>

      <div className="controls">
  <button className="small player-icons player-icons-shuffle" aria-label={t('player.shuffle')}><span className="material-symbols-rounded filled">shuffle</span></button>
  <button className="player-icons player-icons-prev" aria-label={t('player.previous')} onClick={prev}><span className="material-symbols-rounded filled">skip_previous</span></button>
  <button className="play player-icons player-icons-play" aria-label={isPlaying ? t('player.pause') : t('player.play')} onClick={togglePlay}>
  <span className="material-symbols-rounded filled">{isPlaying ? 'pause_circle' : 'play_circle'}</span>
  </button>
  <button className="player-icons player-icons-next" aria-label={t('player.next')} onClick={next}><span className="material-symbols-rounded filled">skip_next</span></button>
  <button className="small player-icons player-icons-repeat-off" aria-label={t('player.repeat')}><span className="material-symbols-rounded filled">repeat</span></button>
      </div>

      <div className="extras">
  <button
    className={`small player-icons player-icons-lyrics ${lyricsOpen ? 'active' : ''}`}
  aria-label={lyricsOpen ? t('player.hideLyrics') : t('player.showLyrics')}
    aria-pressed={lyricsOpen ? 'true' : 'false'}
    onClick={onToggleLyrics}
  ><span className="material-symbols-rounded">lyrics</span></button>
  <button
    className={`small player-icons player-icons-queue ${queueActive ? 'active' : ''}`}
  aria-label={queueActive ? t('player.hideQueue') : t('player.showQueue')}
    aria-pressed={queueActive ? 'true' : 'false'}
    onClick={onToggleQueueTab}
  ><span className="material-symbols-rounded filled">line_weight</span></button>
  <button className="small player-icons player-icons-mute" aria-label={t('player.mute')}><span className="material-symbols-rounded filled">volume_up</span></button>
  <input
    ref={volRef}
    className="volume-range"
    type="range"
    min={0}
    max={100}
    value={volume}
    onChange={(e) => onVolume(Number(e.target.value))}
    style={{ ['--vol' as any]: `${volume}%` }}
  />
  <button className='small player-icons player-icons-mini' aria-label={t('player.mini')}><span className="material-symbols-rounded">pip</span></button>
  <button className='small player-icons player-icons-fullscreen' aria-label={t('player.fullscreen')}><span className="material-symbols-rounded filled">pan_zoom</span></button>
      </div>
    </div>
    </div>
  )
}
