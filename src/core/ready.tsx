import { useEffect, useState } from 'react';
// Import main stylesheet as URL so bundler includes and fingerprints it
// (loaded lazily after fonts) 
// Vite: ?url returns final asset URL
import appCssUrl from '../styles.css?url';

/** App readiness steps:
 * 1. DB ready (handled externally) 
 * 2. Material Symbols font loaded (document.fonts)
 * 3. Electron preload APIs responsive (window.electron)
 * 4. (Optional) minimal parallel warm-up calls (e.g., spotify token, cached user) - placeholder
 */
export function useAppReady(dbReady: boolean){
  const [fontsReady, setFontsReady] = useState(false);
  const [preloadReady, setPreloadReady] = useState(false);
  const [warmupDone, setWarmupDone] = useState(false);
  const [minTimePassed, setMinTimePassed] = useState(false);

  // Minimum splash visibility (avoid flash)
  useEffect(()=>{
    const t = setTimeout(()=> setMinTimePassed(true), 600);
    return ()=> clearTimeout(t);
  }, []);

  // Wait for Material Symbols (some glyphs) font
  useEffect(()=>{
    let cancelled = false;
    async function waitFonts(){
      try {
        if((document as any).fonts?.status === 'loaded') { setFontsReady(true); return; }
        // Attempt to load a representative glyph
        await (document as any).fonts?.load?.("12px 'Material Symbols Rounded'");
        await (document as any).fonts?.ready;
        if(!cancelled) setFontsReady(true);
      } catch { if(!cancelled) setFontsReady(true); }
    }
    waitFonts();
    return ()=>{ cancelled = true; };
  }, []);

  // Once fonts are ready, start loading the full app stylesheet if not already
  useEffect(()=>{
    if(!fontsReady) return;
    // Avoid duplicate
    if(document.querySelector('link[data-app-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = appCssUrl;
    link.dataset.appCss = 'true';
    document.head.appendChild(link);
  }, [fontsReady]);

  // Check preload exposure (simple polling up to timeout)
  useEffect(()=>{
    let cancelled = false; let attempts = 0;
    function check(){
      attempts++;
      const w:any = window;
      if(w.electron?.spotify || attempts > 40){ // after 2s fallback
        if(!cancelled) setPreloadReady(true);
        return;
      }
      setTimeout(check, 50);
    }
    check();
    return ()=>{ cancelled = true; };
  }, []);

  // Warm-up placeholder: could prefetch user profile, cache, etc.
  useEffect(()=>{
    if(!preloadReady) return;
    let cancelled = false;
    (async ()=>{
      try {
        // Insert real warm-up calls here when available
        await new Promise(r=> setTimeout(r, 80));
      } finally { if(!cancelled) setWarmupDone(true); }
    })();
    return ()=>{ cancelled = true; };
  }, [preloadReady]);

  const ready = dbReady && fontsReady && preloadReady && warmupDone && minTimePassed;
  return { ready, states: { dbReady, fontsReady, preloadReady, warmupDone, minTimePassed } };
}
