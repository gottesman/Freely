import React from 'react'
import { useI18n } from '../core/i18n'

export default function HomeTab(){
  const { t } = useI18n();
  const heroImage = '../icon-192.png'
  return (
  <section className="home-page" aria-label={t('home.pageLabel','Browse and personalized content')}>
      {/* Hero / Welcome */}
      <div className="home-hero" style={{ ['--hero-image' as any]: `url(${heroImage})` }}>
        <div className="home-hero-overlay" />
        <div className="home-hero-body">
          <h1 className="home-hero-title">{t('home.welcome')}</h1>
          <p className="home-hero-sub">{t('home.subtitle')}</p>
          <div className="home-hero-actions">
            <button className="np-icon" type="button" aria-label={t('home.cta.playDailyMix')}><span className="material-symbols-rounded filled">play_arrow</span></button>
            <button className="np-icon" type="button" aria-label={t('home.cta.shuffleAll')}><span className="material-symbols-rounded filled">shuffle</span></button>
            <button className="np-icon" type="button" aria-label={t('home.cta.openQueue')}><span className="material-symbols-rounded filled">queue_music</span></button>
          </div>
        </div>
      </div>

      {/* Continue Listening */}
  <HomeSection id="continue" title={t('home.section.continue')} more> 
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
  <HomeSection id="latest" title={t('home.section.latest')} more>
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
  <HomeSection id="recommended" title={t('home.section.recommended')} more>
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
  <HomeSection id="trending" title={t('home.section.trending')} more>
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
  <HomeSection id="artists" title={t('home.section.artists')} more>
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
  <HomeSection id="genres" title={t('home.section.genres')} more>
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
  const { t } = useI18n();
  return (
    <section className="home-section" aria-labelledby={`${id}-title`}>
      <header className="home-sec-head">
        <h2 id={`${id}-title`} className="home-sec-title">{title}</h2>
        {more && <button className="np-link home-sec-more" type="button">{t('home.section.seeAll')}</button>}
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
