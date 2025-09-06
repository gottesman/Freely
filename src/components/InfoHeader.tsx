import React, { useLayoutEffect, useRef, useCallback, useMemo } from 'react';

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

// Constants for performance and maintainability
const DEFAULT_INITIAL_HEIGHT = 320;
const DEFAULT_MIN_HEIGHT = 64;
const MAX_TITLE_SIZE = 56;
const MIN_TITLE_SIZE = 18;
const MAIN_PADDING = 28;
const MIN_PADDING = 6;
const SHRINK_THRESHOLD = 0.5;

export default function InfoHeader({ 
  id, 
  title, 
  meta, 
  tags, 
  actions, 
  heroImage, 
  ariaActionsLabel, 
  initialHeight = DEFAULT_INITIAL_HEIGHT, 
  minHeight = DEFAULT_MIN_HEIGHT, 
  initialShrink, 
  titleColor = 'inherit' 
}: InfoHeaderProps) {
  const headerRef = useRef<HTMLElement | null>(null);
  const tagsRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef<HTMLDivElement | null>(null);
  const extrasRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);

  // Memoize calculated values to avoid recalculation
  const dimensions = useMemo(() => ({
    heightRange: Math.max(1, initialHeight - minHeight),
    titleRange: MAX_TITLE_SIZE - MIN_TITLE_SIZE,
    paddingRange: MAIN_PADDING - MIN_PADDING
  }), [initialHeight, minHeight]);

  // Extract shrink calculation logic
  const calculateShrinkValues = useCallback((shrinkRatio: number) => {
    const t = Math.max(0, Math.min(1, shrinkRatio));
    
    return {
      height: Math.round(initialHeight - dimensions.heightRange * t),
      titleSize: Math.round(MAX_TITLE_SIZE - dimensions.titleRange * t),
      topPadding: Math.max(MIN_PADDING, Math.round(MAIN_PADDING - dimensions.paddingRange * t)),
      bottomPadding: Math.max(MIN_PADDING, Math.round(MAIN_PADDING - dimensions.paddingRange * t)),
      isLarge: t > SHRINK_THRESHOLD,
      metaOpacity: t > SHRINK_THRESHOLD ? Math.max(0.6, 1 - (t - SHRINK_THRESHOLD) * 1.2) : 1,
      shrinkRatio: t
    };
  }, [initialHeight, dimensions]);

  // Optimized style application function
  const applyShrink = useCallback((shrinkRatio: number) => {
    const tabsBody = document.querySelector('.tabs-body') as HTMLElement | null;
    const heroEl = headerRef.current;
    const tagsEl = tagsRef.current;
    const metaEl = metaRef.current;
    const extrasEl = extrasRef.current;

    if (!tabsBody || !heroEl) return;

    const values = calculateShrinkValues(shrinkRatio);
    
    // Batch DOM updates for better performance
    tabsBody.style.setProperty('--np-hero-height', `${values.height}px`);
    tabsBody.style.setProperty('--np-hero-maxheight', `${initialShrink ? minHeight : initialHeight}px`);
    
    heroEl.style.setProperty('--np-title-size', `${values.titleSize}px`);
    heroEl.style.setProperty('--np-hero-padding-top', `${values.topPadding}px`);
    heroEl.style.setProperty('--np-hero-padding-bottom', `${values.bottomPadding}px`);
    heroEl.style.setProperty('--np-shrink', String(values.shrinkRatio));
    heroEl.dataset.npShrinkState = values.isLarge ? 'large' : 'small';

    // Handle tags visibility
    if (tagsEl) {
      tagsEl.style.display = values.isLarge ? 'none' : '';
    }

    // Handle meta and extras styling
    if (metaEl && extrasEl) {
      extrasEl.style.cssText = 'display: flex; align-items: center; gap: 8px;';
      
      if (values.isLarge) {
        metaEl.style.cssText = `white-space: nowrap; margin: 0; opacity: ${values.metaOpacity};`;
      } else {
        metaEl.style.cssText = '';
      }
    }
  }, [calculateShrinkValues, initialShrink, minHeight, initialHeight]);

  // Optimized scroll handler
  const handleScroll = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    
    rafRef.current = requestAnimationFrame(() => {
      const tabsBody = document.querySelector('.tabs-body') as HTMLElement | null;
      if (!tabsBody || !headerRef.current) return;

      const scrollY = tabsBody.scrollTop || 0;
      const shrinkRatio = initialShrink ?? Math.min(1, scrollY / dimensions.heightRange);
      applyShrink(shrinkRatio);
    });
  }, [applyShrink, initialShrink, dimensions.heightRange]);

  useLayoutEffect(() => {
    const tabsBody = document.querySelector('.tabs-body') as HTMLElement | null;
    const heroEl = headerRef.current;
    
    if (!tabsBody || !heroEl) return;

    // Set initial title color
    heroEl.style.setProperty('--title-color', titleColor);

    // Handle cross-tab animation
    const prevShrinkAttr = tabsBody.dataset.npPrevShrink;
    const targetShrink = initialShrink ?? 0;
    let hasAnimated = false;

    if (prevShrinkAttr && prevShrinkAttr !== String(targetShrink)) {
      const prevShrink = parseFloat(prevShrinkAttr);
      // Start at previous visual state and animate to target
      applyShrink(prevShrink);
      requestAnimationFrame(() => applyShrink(targetShrink));
      hasAnimated = true;
    }

    // Store current shrink for next mount
    tabsBody.dataset.npPrevShrink = String(targetShrink);

    if (!hasAnimated) {
      applyShrink(targetShrink);
    }

    // Set up event listeners
    tabsBody.addEventListener('scroll', handleScroll, { passive: true });

    // Initial scroll-based update if not using static shrink
    if (initialShrink == null) {
      handleScroll();
    }

    // Cleanup function
    return () => {
      tabsBody.removeEventListener('scroll', handleScroll);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [applyShrink, handleScroll, initialShrink, titleColor]);

  return (
    <header
      ref={headerRef}
      className="np-hero"
      style={{ 
        ['--hero-image' as any]: heroImage ? `url(${heroImage})` : 'none',
        pointerEvents: 'none' // Make header transparent to pointer events
      }}
    >
      <div className="np-hero-inner">
        <div className="np-hero-top">
          <h1 id={id} className="np-title">{title}</h1>
          {meta && (
            <div ref={metaRef} className="np-meta-line">{meta}</div>
          )}
        </div>

        <div className="np-extras" ref={extrasRef}>
          {tags && tags.length > 0 && (
            <div className="np-tags" ref={tagsRef} aria-label="tags">
              {tags.map((tag, index) => (
                <span key={index} className="tag">{tag}</span>
              ))}
            </div>
          )}
          {actions && actions.length > 0 && (
            <div 
              className="np-actions" 
              aria-label={ariaActionsLabel ?? 'actions'}
              style={{ pointerEvents: 'auto' }} // Re-enable pointer events for interactive actions
            >
              {actions}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
