import React, { useRef, useEffect } from 'react'
import { useI18n } from '../core/i18n'

export default function HomeTab(){
  const { t } = useI18n();
  const heroImage = '../icon-192.png'
  // generic horizontal scroll helpers
  const makeScroller = (ref: React.RefObject<HTMLDivElement>) => ({
    left: () => {
      const el = ref.current; if(!el) return;
      const children = Array.from(el.children) as HTMLElement[];
      if(!children.length) return;
      const positions = children.map(c => c.offsetLeft);
      const current = el.scrollLeft;
      // find index of leftmost item (last whose start <= current)
      let idx = 0; for(let i=0;i<positions.length;i++){ if(positions[i] <= current + 1) idx = i; else break; }
      const prevIdx = Math.max(0, idx - 1);
      const target = positions[prevIdx];
      el.scrollTo({ left: target, behavior:'smooth' });
    },
    right: () => {
      const el = ref.current; if(!el) return;
      const children = Array.from(el.children) as HTMLElement[];
      if(!children.length) return;
      const positions = children.map(c => c.offsetLeft);
      const current = el.scrollLeft;
      // index of leftmost item
      let idx = 0; for(let i=0;i<positions.length;i++){ if(positions[i] <= current + 1) idx = i; else break; }
      const nextIdx = Math.min(positions.length - 1, idx + 1);
      const target = positions[nextIdx];
      if(target !== current) el.scrollTo({ left: target, behavior:'smooth' });
    }
  });

  const refContinue = useRef<HTMLDivElement>(null);
  const refLatest = useRef<HTMLDivElement>(null);
  const refRecommended = useRef<HTMLDivElement>(null);
  const refTrending = useRef<HTMLDivElement>(null);
  const refArtists = useRef<HTMLDivElement>(null);

  const scContinue = makeScroller(refContinue);
  const scLatest = makeScroller(refLatest);
  const scRecommended = makeScroller(refRecommended);
  const scTrending = makeScroller(refTrending);
  const scArtists = makeScroller(refArtists);

  const scrollTolerance = 6;

  // manage overflow classes on wrappers depending on scroll position
  useEffect(()=>{
    const rows: Array<React.RefObject<HTMLDivElement>> = [refContinue, refLatest, refRecommended, refTrending, refArtists];
    const observers: ResizeObserver[] = [];

    function update(row: HTMLDivElement){
      const wrap = row.parentElement; if(!wrap) return;
      const { scrollLeft, scrollWidth, clientWidth } = row;
      const canScroll = scrollWidth > clientWidth + scrollTolerance; // tolerance
      const atStart = scrollLeft <= scrollTolerance;
      const atEnd = scrollLeft + clientWidth >= scrollWidth - scrollTolerance;
      wrap.classList.remove('media-row-overflow-right','media-row-overflow-left','media-row-overflow-both');
      if(!canScroll) return; // no class
      if(atStart && !atEnd) wrap.classList.add('media-row-overflow-right');
      else if(!atStart && atEnd) wrap.classList.add('media-row-overflow-left');
      else if(!atStart && !atEnd) wrap.classList.add('media-row-overflow-both');
    }

    function attach(ref: React.RefObject<HTMLDivElement>){
      const el = ref.current; if(!el) return;
      const onScroll = () => update(el);
      el.addEventListener('scroll', onScroll, { passive: true });
      const ro = new ResizeObserver(()=> update(el));
      ro.observe(el);
      observers.push(ro);
      // initial
      requestAnimationFrame(()=> update(el));
      return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
    }

  // reset scroll to left on mount for consistent stick behavior
  rows.forEach(r => { if(r.current) r.current.scrollLeft = 0; });
  const cleanups = rows.map(r => attach(r)).filter(Boolean) as Array<() => void>;
    const onWinResize = () => rows.forEach(r => { if(r.current) update(r.current); });
    window.addEventListener('resize', onWinResize);
    return () => { cleanups.forEach(fn=>fn()); window.removeEventListener('resize', onWinResize); observers.forEach(o=>o.disconnect()); };
  }, []);

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
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scContinue.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refContinue} className="media-row scroll-x">
          {Array.from({length:6}).map((_,i)=> (
            <MediaCard key={i} kind="album" progress>
              <div className="media-cover" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">Album Title {i+1}</h3>
              <p className="media-meta">Artist Name · 2025</p>
              <div className="media-progress" aria-label="Listening progress"><span style={{['--p' as any]: `${(i+1)*10}%`}} /></div>
            </MediaCard>
          ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scContinue.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Latest Releases */}
  <HomeSection id="latest" title={t('home.section.latest')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scLatest.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refLatest} className="media-row scroll-x">
          {Array.from({length:10}).map((_,i)=> (
            <MediaCard key={i} kind="album">
              <div className="media-cover" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">New Release {i+1}</h3>
              <p className="media-meta">Artist • {(2025)} </p>
            </MediaCard>
          ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scLatest.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Recommended For You */}
  <HomeSection id="recommended" title={t('home.section.recommended')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scRecommended.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refRecommended} className="media-row scroll-x">
          {Array.from({length:8}).map((_,i)=> (
            <MediaCard key={i} kind="playlist">
              <div className="media-cover square" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">Mix #{i+1}</h3>
              <p className="media-meta">Eclectic · Auto Mix</p>
            </MediaCard>
          ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scRecommended.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Trending Now */}
  <HomeSection id="trending" title={t('home.section.trending')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scTrending.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refTrending} className="media-row scroll-x dense">
          {Array.from({length:12}).map((_,i)=> (
            <MediaCard key={i} kind="track" compact>
              <div className="media-cover tiny" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">Hot Track {i+1}</h3>
              <p className="media-meta">Artist</p>
            </MediaCard>
          ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scTrending.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
        </div>
      </HomeSection>

      {/* Top Artists */}
  <HomeSection id="artists" title={t('home.section.artists')} more>
        <div className="media-row-wrap">
          <button type="button" aria-label={t('home.scrollLeft','Scroll left')} className="np-icon scroll-btn left" onClick={scArtists.left}><span className="material-symbols-rounded filled">chevron_left</span></button>
          <div ref={refArtists} className="media-row scroll-x artists">
          {Array.from({length:10}).map((_,i)=> (
            <MediaCard key={i} kind="artist" circle>
              <div className="media-cover circle" aria-hidden="true"><img src="icon-192.png" alt="" /></div>
              <h3 className="media-title">Artist {i+1}</h3>
              <p className="media-meta">2.{i}M listeners</p>
            </MediaCard>
          ))}
          </div>
          <button type="button" aria-label={t('home.scrollRight','Scroll right')} className="np-icon scroll-btn right" onClick={scArtists.right}><span className="material-symbols-rounded filled">chevron_right</span></button>
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
