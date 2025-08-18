import React from 'react'

export default function HomeTab(){
  const heroImage = '../icon-192.png'
  return (
    <section className="home-page" aria-label="Browse and personalized content">
      {/* Hero / Welcome */}
      <div className="home-hero" style={{ ['--hero-image' as any]: `url(${heroImage})` }}>
        <div className="home-hero-overlay" />
        <div className="home-hero-body">
          <h1 className="home-hero-title">Welcome back</h1>
          <p className="home-hero-sub">Your daily mix & fresh releases are ready.</p>
          <div className="home-hero-actions">
            <button className="np-icon" type="button" aria-label="Play Daily Mix"><span className="material-symbols-rounded filled">play_arrow</span></button>
            <button className="np-icon" type="button" aria-label="Shuffle All"><span className="material-symbols-rounded filled">shuffle</span></button>
            <button className="np-icon" type="button" aria-label="Open Queue"><span className="material-symbols-rounded filled">queue_music</span></button>
          </div>
        </div>
      </div>

      {/* Continue Listening */}
      <HomeSection id="continue" title="Continue Listening" more> 
        <div className="media-row scroll-x">
          {Array.from({length:6}).map((_,i)=> (
            <MediaCard key={i} kind="album" progress>
              <div className="media-cover" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">Album Title {i+1}</h3>
              <p className="media-meta">Artist Name · 2025</p>
              <div className="media-progress" aria-label="Listening progress"><span style={{['--p' as any]: `${(i+1)*10}%`}} /></div>
            </MediaCard>
          ))}
        </div>
      </HomeSection>

      {/* Latest Releases */}
      <HomeSection id="latest" title="Latest Releases" more>
        <div className="media-row scroll-x">
          {Array.from({length:10}).map((_,i)=> (
            <MediaCard key={i} kind="album">
              <div className="media-cover" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">New Release {i+1}</h3>
              <p className="media-meta">Artist • {(2025)} </p>
            </MediaCard>
          ))}
        </div>
      </HomeSection>

      {/* Recommended For You */}
      <HomeSection id="recommended" title="Recommended For You" more>
        <div className="media-row scroll-x">
          {Array.from({length:8}).map((_,i)=> (
            <MediaCard key={i} kind="playlist">
              <div className="media-cover square" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">Mix #{i+1}</h3>
              <p className="media-meta">Eclectic · Auto Mix</p>
            </MediaCard>
          ))}
        </div>
      </HomeSection>

      {/* Trending Now */}
      <HomeSection id="trending" title="Trending Now" more>
        <div className="media-row scroll-x dense">
          {Array.from({length:12}).map((_,i)=> (
            <MediaCard key={i} kind="track" compact>
              <div className="media-cover tiny" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">Hot Track {i+1}</h3>
              <p className="media-meta">Artist</p>
            </MediaCard>
          ))}
        </div>
      </HomeSection>

      {/* Top Artists */}
      <HomeSection id="artists" title="Top Artists" more>
        <div className="media-row scroll-x artists">
          {Array.from({length:10}).map((_,i)=> (
            <MediaCard key={i} kind="artist" circle>
              <div className="media-cover circle" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">Artist {i+1}</h3>
              <p className="media-meta">2.{i}M listeners</p>
            </MediaCard>
          ))}
        </div>
      </HomeSection>

      {/* Genres & Moods */}
      <HomeSection id="genres" title="Genres & Moods" more>
        <div className="chip-grid">
          {['Electronic','Chill','Focus','Gaming','Workout','Jazz','Classical','Hip-Hop','Ambient','Indie'].map(tag => (
            <button key={tag} className="chip" type="button">{tag}</button>
          ))}
        </div>
      </HomeSection>
    </section>
  )
}

/* --- Internal compositional components (lightweight) --- */
interface HomeSectionProps { id:string; title:string; children: React.ReactNode; more?:boolean }
function HomeSection({id,title,children,more}:HomeSectionProps){
  return (
    <section className="home-section" aria-labelledby={`${id}-title`}>
      <header className="home-sec-head">
        <h2 id={`${id}-title`} className="home-sec-title">{title}</h2>
        {more && <button className="np-link home-sec-more" type="button">See all</button>}
      </header>
      {children}
    </section>
  )
}

interface MediaCardProps { children:React.ReactNode; kind?:string; progress?:boolean; compact?:boolean; circle?:boolean }
function MediaCard({children, progress, compact, circle}:MediaCardProps){
  const cls = ["media-card", progress && 'has-progress', compact && 'compact', circle && 'is-circle'].filter(Boolean).join(' ')
  return <article className={cls}>{children}</article>
}
