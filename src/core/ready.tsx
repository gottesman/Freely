import { useEffect, useState } from 'react';
// Import main stylesheet as URL so bundler includes and fingerprints it
// (loaded lazily after fonts) 
// Vite: ?url returns final asset URL
import appCssUrl from '../styles.css?url';
import SpotifyClient from './spotify';
import { useDB } from './db';

/** App readiness steps:
 * 1. DB ready (handled externally) 
 * 2. Material Symbols font loaded (document.fonts)
 * 3. Electron preload APIs responsive (window.electron)
 * 4. Spotify client warmed up with database cache
 */
export function useAppReady(dbReady: boolean){
  const { getApiCache, setApiCache } = useDB();
  const [fontsReady, setFontsReady] = useState(false);
  const [preloadReady, setPreloadReady] = useState(false);
  const [warmupDone, setWarmupDone] = useState(false);
  const [minTimePassed, setMinTimePassed] = useState(false);

  // Minimum splash visibility (avoid flash)
  useEffect(()=>{
    const t = setTimeout(()=> setMinTimePassed(true), 600);
    return ()=> clearTimeout(t);
  }, []);

  // Wait for Material Symbols (Google Icons) font and preload common glyphs
  useEffect(()=>{
    let cancelled = false;
    async function waitFonts(){
      try {
        console.log('🔤 Waiting for Material Symbols font to load...');
        
        // Wait for the specific Material Symbols font to be fully loaded
        let fontReady = false;
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds max wait
        
        while (!fontReady && attempts < maxAttempts && !cancelled) {
          try {
            // Try to load a specific font variation that we commonly use
            await (document as any).fonts?.load?.("400 20px 'Material Symbols Rounded'");
            
            // Test if the font is actually working by measuring icon vs text
            const testElement = document.createElement('span');
            testElement.style.fontFamily = "'Material Symbols Rounded', sans-serif";
            testElement.style.fontSize = '20px';
            testElement.style.position = 'absolute';
            testElement.style.left = '-9999px';
            testElement.style.visibility = 'hidden';
            testElement.textContent = 'play_arrow';
            document.body.appendChild(testElement);
            
            const iconWidth = testElement.offsetWidth;
            document.body.removeChild(testElement);
            
            // If width is reasonable for an icon (not text), font is loaded
            if (iconWidth > 0 && iconWidth < 50) { // Icons are typically 16-24px wide
              fontReady = true;
              console.log('🔤 Material Symbols font verified as loaded');
            } else {
              await new Promise(resolve => setTimeout(resolve, 100));
              attempts++;
            }
          } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
          }
        }
        
        if (attempts >= maxAttempts) {
          console.warn('🔤 Font loading timeout, proceeding anyway');
        }
        
        // Preload common icons to ensure they're cached
        if (fontReady || attempts >= maxAttempts) {
          const iconPreloader = document.createElement('div');
          iconPreloader.className = 'material-symbols-rounded';
          iconPreloader.style.position = 'absolute';
          iconPreloader.style.left = '-9999px';
          iconPreloader.style.visibility = 'hidden';
          iconPreloader.innerHTML = 'play_arrow pause skip_next skip_previous volume_up favorite add check playlist_add search close menu';
          document.body.appendChild(iconPreloader);
          
          // Small delay to ensure icons are rendered
          await new Promise(resolve => setTimeout(resolve, 50));
          document.body.removeChild(iconPreloader);
        }
        
        if(!cancelled) setFontsReady(true);
      } catch (e) { 
        console.warn('🔤 Font loading failed, continuing anyway:', e);
        if(!cancelled) setFontsReady(true); 
      }
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

  // Warm-up: Initialize Spotify client with database cache
  useEffect(()=>{
    if(!preloadReady || !dbReady) return;
    let cancelled = false;
    (async ()=>{
      try {
        console.log('🔥 Starting Spotify client warmup...');
        
        // Initialize the global Spotify client with database cache
        const spotifyClient = new SpotifyClient();
        spotifyClient.setDatabaseCache({ getApiCache, setApiCache });
        
        // Store globally for useSpotifyClient hook to use
        (window as any).__freelySpotifyClient = spotifyClient;
        
        console.log('🔥 Spotify client warmed up with database cache');
        
        // Small delay to ensure everything is settled
        await new Promise(r=> setTimeout(r, 100));
      } catch(e) {
        console.warn('🔥 Spotify client warmup failed:', e);
      } finally { 
        if(!cancelled) setWarmupDone(true); 
      }
    })();
    return ()=>{ cancelled = true; };
  }, [preloadReady, dbReady, getApiCache, setApiCache]);

  const ready = dbReady && fontsReady && preloadReady && warmupDone && minTimePassed;
  return { ready, states: { dbReady, fontsReady, preloadReady, warmupDone, minTimePassed } };
}
