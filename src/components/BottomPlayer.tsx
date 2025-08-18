import React, { useEffect, useRef, useState } from 'react'
import { usePlayback } from '../core/playback'
import { useAlerts } from '../core/alerts'

export default function BottomPlayer({ lyricsOpen, onToggleLyrics, onActivateNowPlaying, onToggleQueueTab, queueActive }: { lyricsOpen?: boolean, onToggleLyrics?: () => void, onActivateNowPlaying?: () => void, onToggleQueueTab?: () => void, queueActive?: boolean }){
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

  const { currentTrack, loading: trackLoading, error } = usePlayback();
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
        const next = p + 1000;
        if (next >= duration) { clearInterval(iv); return duration; }
        return next;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [isPlaying, currentTrack?.id, currentTrack?.durationMs]);

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

  const title = currentTrack?.name || (trackLoading ? 'Loading track...' : 'Song Title');
  const artist = currentTrack?.artists?.map(a=>a.name).join(', ') || 'Artist Name';
  const album = currentTrack?.album?.name || 'Album Name';
  const cover = currentTrack?.album?.images?.[0]?.url || '/icon-192.png';

  return (
    <div className="bottom-player main-panels">
      <div className='track-progress'>
        <div className='time current'>{fmt(positionMs)}</div>
        <div className='bar' onClick={onSeek} role="progressbar" aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={positionMs} aria-label="Track position">
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
          aria-label="Show now playing details"
          onClick={() => onActivateNowPlaying && onActivateNowPlaying()}
          onKeyDown={(e) => { if((e.key === 'Enter' || e.key === ' ') && onActivateNowPlaying){ e.preventDefault(); onActivateNowPlaying(); } }}
        >
          <img className="album-cover" src={cover} alt={album} />
          <div className="meta-text">
            <div className="song-title">{title}</div>
            <div className="song-artist">{artist}</div>
            <div className="song-album">{album}</div>
          </div>
        </div>
  <button className="small player-icons player-icons-add-playlist" aria-label="Add to playlist"><span className="material-symbols-rounded">add_circle</span></button>
      </div>

      <div className="controls">
  <button className="small player-icons player-icons-shuffle" aria-label="Shuffle"><span className="material-symbols-rounded filled">shuffle</span></button>
  <button className="player-icons player-icons-prev" aria-label="Previous"><span className="material-symbols-rounded filled">skip_previous</span></button>
  <button className="play player-icons player-icons-play" aria-label={isPlaying ? 'Pause' : 'Play'} onClick={togglePlay}>
  <span className="material-symbols-rounded filled">{isPlaying ? 'pause_circle' : 'play_circle'}</span>
  </button>
  <button className="player-icons player-icons-next" aria-label="Next"><span className="material-symbols-rounded filled">skip_next</span></button>
  <button className="small player-icons player-icons-repeat-off" aria-label="Repeat"><span className="material-symbols-rounded filled">repeat</span></button>
      </div>

      <div className="extras">
  <button
    className={`small player-icons player-icons-lyrics ${lyricsOpen ? 'active' : ''}`}
    aria-label={lyricsOpen ? 'Hide lyrics' : 'Show lyrics'}
    aria-pressed={lyricsOpen ? 'true' : 'false'}
    onClick={onToggleLyrics}
  ><span className="material-symbols-rounded">lyrics</span></button>
  <button
    className={`small player-icons player-icons-queue ${queueActive ? 'active' : ''}`}
    aria-label={queueActive ? 'Hide queue' : 'Show queue'}
    aria-pressed={queueActive ? 'true' : 'false'}
    onClick={onToggleQueueTab}
  ><span className="material-symbols-rounded filled">line_weight</span></button>
  <button className="small player-icons player-icons-mute" aria-label="Mute"><span className="material-symbols-rounded filled">volume_up</span></button>
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
  <button className='small player-icons player-icons-mini' aria-label="Mini player"><span className="material-symbols-rounded">pip</span></button>
  <button className='small player-icons player-icons-fullscreen' aria-label="Fullscreen"><span className="material-symbols-rounded filled">pan_zoom</span></button>
      </div>
    </div>
    </div>
  )
}
