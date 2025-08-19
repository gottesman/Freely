import React, { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';

export interface I18nContextValue {
  lang: string;
  setLang: (lang: string) => void;
  /**
   * Translate a key. Optionally provide a fallback string and/or interpolation variables.
   * Usage:
   *  t('home.welcome')
   *  t('search.resultsFor', undefined, { query })
   */
  t: (key: string, fallback?: string, vars?: Record<string, string | number>) => string;
  ready: boolean;
  keys: Record<string,string>;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

async function loadLocale(lang: string): Promise<Record<string,string>> {
  try {
    switch(lang){
      case 'es': return (await import('../lang/es.json')).default as any;
      case 'en':
      default: return (await import('../lang/en.json')).default as any;
    }
  } catch {
    return {};
  }
}

export function I18nProvider({ children, initialLang = 'en' }: { children: ReactNode; initialLang?: string }) {
  const [lang, setLang] = useState<string>(initialLang);
  const [keys, setKeys] = useState<Record<string,string>>({});
  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    loadLocale(lang).then(k => { if(!cancelled){ setKeys(k); setReady(true); } });
    return () => { cancelled = true; };
  }, [lang]);

  const t = useCallback((key: string, fallback?: string, vars?: Record<string,string|number>) => {
    let out = keys[key] || fallback || key;
    if(vars){
      out = out.replace(/\{(\w+)\}/g, (m, k) => Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
    }
    return out;
  }, [keys]);

  const value: I18nContextValue = { lang, setLang, t, ready, keys };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if(!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
