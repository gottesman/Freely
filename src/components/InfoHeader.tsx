import React, { useEffect, useRef } from 'react';

type InfoHeaderProps = {
  id?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  tags?: React.ReactNode[];
  actions?: React.ReactNode[];
  heroImage?: string;
  ariaActionsLabel?: string;
  initialHeight?: number; // initial height in px (default 320)
  minHeight?: number; // min height in px (default 64)
  initialShrink?: number; // initial shrink ratio 0..1 (default 0)
  titleColor?: string; // CSS color for title text (default: inherit)
};

export default function InfoHeader({ id, title, meta, tags, actions, heroImage, ariaActionsLabel, initialHeight, minHeight, initialShrink, titleColor }: InfoHeaderProps) {
  const headerRef = useRef<HTMLElement | null>(null);
  const tagsRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef<HTMLDivElement | null>(null);
  const extrasRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
  const tabsBody = document.querySelector('.tabs-body') as HTMLElement | null;
  const heroEl = headerRef.current;
  const tagsEl = tagsRef.current;
  const metaEl = metaRef.current;
  const extrasEl = extrasRef.current;
    if (!tabsBody || !heroEl) return;

    const maxH = initialHeight ?? 320;
    const minH = minHeight ?? 64;
    const maxTitle = 56;
    const minTitle = 18;

    let raf = 0;
    heroEl.style.setProperty('--title-color', titleColor || 'inherit');
    console.log('Set title color to', titleColor || 'inherit');

  function onScroll() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        
        if (!tabsBody || !heroEl) return;
        const scrollY = tabsBody.scrollTop || 0;
        const range = Math.max(1, maxH - minH);
        const t = initialShrink ?? Math.min(1, scrollY / range);
        // expose a normalized shrink value for CSS and direct style tweaks
        const shrink = Math.max(0, Math.min(1, t));
        // Animate tags collapsing: fade + max-height -> hides and doesn't reserve space
        if (tagsEl) {
          // fully remove from flow when almost fully shrunk
          tagsEl.style.display = shrink > 0.5 ? 'none' : '';
        }
        
        const curH = Math.round(maxH - (maxH - minH) * t);
        const curTitle = Math.round(maxTitle - (maxTitle - minTitle) * t);
        tabsBody.style.setProperty('--np-hero-height', `${curH}px`);
        tabsBody.style.setProperty('--np-hero-maxheight', `${initialShrink ? minH : maxH}px`);
        heroEl.style.setProperty('--np-title-size', `${curTitle}px`);
        const mainPad = 28;
        const topPad = Math.round(mainPad - (16 * t));
        const bottomPad = Math.round(mainPad - (16 * t));
        heroEl.style.setProperty('--np-hero-padding-top', `${Math.max(6, topPad)}px`);
        heroEl.style.setProperty('--np-hero-padding-bottom', `${Math.max(6, bottomPad)}px`);

        heroEl.style.setProperty('--np-shrink', String(shrink));
        // expose a simple state for CSS selectors: 'large' when shrunk past 0.5
        try {
          (heroEl as HTMLElement).dataset.npShrinkState = shrink > 0.5 ? 'large' : 'small';
        } catch (e) {
          // ignore if dataset isn't writable for some reason
        }

        // Make meta line inline with actions when shrunk
        if (metaEl && extrasEl) {
          extrasEl.style.display = 'flex';
          extrasEl.style.alignItems = 'center';
          extrasEl.style.gap = '8px';
          if (shrink > 0.5) {
            metaEl.style.whiteSpace = 'nowrap';
            metaEl.style.margin = '0';
            metaEl.style.opacity = String(Math.max(0.6, 1 - (shrink - 0.5) * 1.2));
          } else {
            metaEl.style.display = '';
            metaEl.style.whiteSpace = '';
            metaEl.style.margin = '';
            metaEl.style.opacity = '';
          }
        }

        // end of requestAnimationFrame callback
      });
    }

    // Forward wheel events from the header to the tabs body so the page
    // scrolls when the cursor is over the hero header. Use passive: false so
    // we can call preventDefault and avoid outer scrolling.
    function onWheel(e: WheelEvent) {
      if (!tabsBody) return;
      tabsBody.scrollBy({
        top: e.deltaY,
        left: e.deltaX,
        behavior: 'smooth'
      });
      e.preventDefault();
    }

    tabsBody.addEventListener('scroll', onScroll, { passive: true });
    heroEl.addEventListener('wheel', onWheel as EventListener, { passive: false });
    onScroll();
    return () => {
      tabsBody.removeEventListener('scroll', onScroll as EventListener);
      heroEl.removeEventListener('wheel', onWheel as EventListener);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <header
      ref={headerRef}
      className="np-hero"
      style={{ ['--hero-image' as any]: heroImage ? `url(${heroImage})` : '' }}
    >
      <div className="np-hero-inner">
        <div className="np-hero-top">
          <h1 id={id} className="np-title">{title}</h1>
          {meta && (
            <div ref={metaRef} className="np-meta-line">{meta}</div>
          )}
        </div>

        <div className="np-extras" ref={extrasRef}>
          <div className="np-tags" ref={tagsRef} aria-label="tags">{tags && tags.map((t) => {
            return <span key={String(t)} className="tag">{t}</span>;
          })}</div>
          <div className="np-actions" aria-label={ariaActionsLabel ?? 'actions'}>
            {actions && actions.map((a, i) => <React.Fragment key={i}>{a}</React.Fragment>)}
          </div>
        </div>
      </div>
    </header>
  );
}
