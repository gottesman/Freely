import React, { createContext, useContext, useEffect, useState, ReactNode, useCallback, useMemo } from 'react';
import { frontendLogger } from './FrontendLogger';
import { setSpotifyLocale } from './SpotifyClient';

// Performance constants
const DEFAULT_LANG = 'en';
const DEFAULT_LOCALE = 'en-US';
const INTERPOLATION_REGEX = /\{(\w+)\}/g;

// Language to locale mapping configuration
const LANG_TO_LOCALE_MAP = {
  'es': 'es-ES',
  'en': 'en-US'
} as const;

// Supported languages configuration
const SUPPORTED_LANGUAGES = {
  EN: 'en',
  ES: 'es'
} as const;

// Type definitions for better performance
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
  keys: Record<string, string>;
}

interface I18nProviderProps {
  children: ReactNode;
  initialLang?: string;
}

// Optimized internationalization utilities
class I18nUtils {
  /**
   * Load locale data dynamically with error handling
   */
  static async loadLocale(lang: string): Promise<Record<string, string>> {
    try {
      switch (lang) {
        case SUPPORTED_LANGUAGES.ES:
          return (await import('../lang/es.json')).default as Record<string, string>;
        case SUPPORTED_LANGUAGES.EN:
        default:
          return (await import('../lang/en.json')).default as Record<string, string>;
      }
    } catch (error) {
      frontendLogger.warn(`[i18n] Failed to load locale for ${lang}:`, error);
      return {};
    }
  }

  /**
   * Map language code to full locale string
   */
  static mapLangToLocale(lang: string): string {
    if (!lang) return DEFAULT_LOCALE;
    return LANG_TO_LOCALE_MAP[lang as keyof typeof LANG_TO_LOCALE_MAP] || DEFAULT_LOCALE;
  }

  /**
   * Perform string interpolation with variables
   */
  static interpolateString(
    template: string, 
    vars: Record<string, string | number>
  ): string {
    return template.replace(INTERPOLATION_REGEX, (match, key) => 
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    );
  }

  /**
   * Safe Spotify locale setting with error handling
   */
  static setSpotifyLocaleSafe(locale: string): void {
    try {
      setSpotifyLocale(locale);
    } catch (error) {
      frontendLogger.warn('[i18n] Failed to set Spotify locale:', error);
    }
  }
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

// Memoized I18n Provider with optimized performance
export const I18nProvider = React.memo<I18nProviderProps>(({ 
  children, 
  initialLang = DEFAULT_LANG 
}) => {
  const [lang, setLang] = useState<string>(initialLang);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [ready, setReady] = useState<boolean>(false);

  // Memoized language change effect
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    
    I18nUtils.loadLocale(lang).then(loadedKeys => {
      if (!cancelled) {
        setKeys(loadedKeys);
        setReady(true);
      }
    });

    // Propagate locale to Spotify with safe error handling
    I18nUtils.setSpotifyLocaleSafe(I18nUtils.mapLangToLocale(lang));
    
    return () => { cancelled = true; };
  }, [lang]);

  // Memoized translation function
  const t = useCallback((
    key: string, 
    fallback?: string, 
    vars?: Record<string, string | number>
  ) => {
    let output = keys[key] || fallback || key;
    
    if (vars) {
      output = I18nUtils.interpolateString(output, vars);
    }
    
    return output;
  }, [keys]);

  // Memoized context value to prevent unnecessary re-renders
  const contextValue = useMemo((): I18nContextValue => ({
    lang,
    setLang,
    t,
    ready,
    keys
  }), [lang, setLang, t, ready, keys]);

  return (
    <I18nContext.Provider value={contextValue}>
      {children}
    </I18nContext.Provider>
  );
});

// Optimized hook with error boundary
export const useI18n = (): I18nContextValue => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider');
  }
  return context;
};
