import React from 'react'

export default function BottomPlayer(){
  return (
    <div className="bottom-player">
      <div className="meta-block">
        <div className="meta">
          <img className="album-cover" src="/logo/icon-192.png" alt="album" />
          <div className="meta-text">
            <div className="song-title">Song Title</div>
            <div className="song-artist">Artist Name</div>
            <div className="song-album">Album Name</div>
          </div>
        </div>
  <button className="player-icons player-icons-add-playlist" aria-label="Add to playlist"><span className="material-symbols-rounded">add_circle</span></button>
      </div>

      <div className="controls">
  <button className="small player-icons player-icons-shuffle" aria-label="Shuffle"><span className="material-symbols-rounded filled">shuffle</span></button>
  <button className="small player-icons player-icons-prev" aria-label="Previous"><span className="material-symbols-rounded filled">skip_previous</span></button>
  <button className="play player-icons player-icons-play" aria-label="Play/Pause">
  <span className="material-symbols-rounded filled">play_circle</span>
  </button>
  <button className="small player-icons player-icons-next" aria-label="Next"><span className="material-symbols-rounded filled">skip_next</span></button>
  <button className="small player-icons player-icons-repeat-off" aria-label="Repeat"><span className="material-symbols-rounded filled">repeat</span></button>
      </div>

      <div className="extras">
  <button className="small player-icons player-icons-lyrics" aria-label="Lyrics"><span className="material-symbols-rounded">lyrics</span></button>
  <button className="small player-icons player-icons-queue" aria-label="Queue"><span className="material-symbols-rounded filled">line_weight</span></button>
  <button className="small player-icons player-icons-mute" aria-label="Mute"><span className="material-symbols-rounded filled">volume_up</span></button>
  <input className="volume-range" type="range" min={0} max={100} defaultValue={40} />
  <button className='small player-icons player-icons-mini' aria-label="Mini player"><span className="material-symbols-rounded">pip</span></button>
  <button className='small player-icons player-icons-fullscreen' aria-label="Fullscreen"><span className="material-symbols-rounded filled">pan_zoom</span></button>
      </div>
    </div>
  )
}
