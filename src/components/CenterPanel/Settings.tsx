import React, { useState } from 'react'
import { frontendLogger } from '../../core/FrontendLogger';
import { useI18n } from '../../core/i18n'
import { useDB } from '../../core/Database'
import { usePlaylists } from '../../core/Playlists'
import { usePrompt } from '../../core/PromptContext'
import { useAlerts } from '../../core/Alerts'
import { getAudioDevices, getAudioSettings, setAudioSettings, reinitializeAudio, AudioDevice, AudioSettings, isTauriAvailable, runTauriCommand, pluginsList, pluginsSetEnabled, pluginsDelete, pluginsInstallZipFromFile } from '../../core/TauriCommands'
import { APPEARANCE_DEFAULTS, unsplash, thumbnailUnsplash, setAppearance, getAppearance } from '../../core/Appearance'

// Consistent icon style for buttons (non-delete)
const ICON_STYLE: React.CSSProperties = { fontSize: 18, lineHeight: '1', verticalAlign: 'middle' };

// Resolve background entry (may be a URL, data:, or a special marker like 'unsplash:ID')
const resolveBackground = (entry: string | null | undefined) => {
  if (!entry) return '';
  if (entry.startsWith('unsplash:')) {
    const parts = entry.split(':');
    const id = parts.slice(1).join(':');
    return unsplash({ id });
  }
  return entry;
};

const previewFor = (entry: string | null | undefined) => {
  if (!entry) return '';
  if (entry.startsWith('unsplash:')) {
    const id = entry.split(':').slice(1).join(':');
    return thumbnailUnsplash(id, 64, 60);
  }
  return entry;
};

// Main (larger) preview for the central preview image — use a bigger Unsplash image
const mainPreviewFor = (entry: string | null | undefined) => {
  if (!entry) return '';
  if (entry.startsWith('unsplash:')) {
    const id = entry.split(':').slice(1).join(':');
    // Request a reasonably large preview for the main area
    return unsplash({ id, width: 750, quality: 80, cs: 'srgb' });
  }
  return entry;
};

export default function Settings() {
  const { exportJSON, importJSON, clearCache, clearLocalData, getSetting, setSetting } = useDB()
  const [accent, setAccent] = useState(APPEARANCE_DEFAULTS.accent)
  const [textColor, setTextColor] = useState(APPEARANCE_DEFAULTS.textColor)
  const [textDarkColor, setTextDarkColor] = useState(APPEARANCE_DEFAULTS.textDarkColor)
  const { lang, setLang, t } = useI18n();
  const [importFileName, setImportFileName] = useState<string>('')
  // Background appearance settings
  // Use backgrounds from APPEARANCE_DEFAULTS
  const [bgCarouselIndex, setBgCarouselIndex] = useState<number>(APPEARANCE_DEFAULTS.bgImageIndex as number);
  // Store the resolved URL (resolve 'unsplash:ID' markers to real URLs)
  const [bgImage, setBgImage] = useState<string>(resolveBackground(APPEARANCE_DEFAULTS.backgrounds[APPEARANCE_DEFAULTS.bgImageIndex as number]));
  const [bgCustomUrl, setBgCustomUrl] = useState<string>(APPEARANCE_DEFAULTS.bgCustomUrl);
  const [bgBlur, setBgBlur] = useState<boolean>(APPEARANCE_DEFAULTS.bgBlur);
  const [bgBlurAmount, setBgBlurAmount] = useState<number>(APPEARANCE_DEFAULTS.bgBlurAmount);
  const [bgOverlayColor, setBgOverlayColor] = useState<string>(APPEARANCE_DEFAULTS.bgOverlayColor);
  const [bgOverlayOpacity, setBgOverlayOpacity] = useState<number>(APPEARANCE_DEFAULTS.bgOverlayOpacity);
  // Shadow (app background RGB triplet via --bg)
  const [shadowHex, setShadowHex] = useState<string>(APPEARANCE_DEFAULTS.shadowHex);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [audioSettings, setAudioSettingsState] = useState<AudioSettings | null>(null)
  const [isLoadingAudio, setIsLoadingAudio] = useState(false)
  usePlaylists();
  const prompt = usePrompt();
  const { push: pushAlert } = useAlerts();

  // Helper to apply background CSS variables to the .bg element
  const applyBackgroundVars = React.useCallback((imageUrl: string, blurAmount: number, overlayColor?: string, overlayOpacity?: number) => {
    // Try to apply to the .bg element. If it's not present yet, retry a few times with a short delay.
    const doApply = (attemptsLeft: number) => {
      try {
        const bgEl = document.querySelector('.bg') as HTMLElement | null;
        // Prepare computed values and defaults so we can apply them to :root as fallback
        const url = imageUrl?.trim() ? `url('${imageUrl}')` : `url('${resolveBackground(APPEARANCE_DEFAULTS.backgrounds[0])}')`;
        const filter = blurAmount > 0 ? `blur(${blurAmount}px)` : 'none';

        // Apply to :root as a fallback for early startup when .bg may not exist
        try {
          const root = document.documentElement as HTMLElement | null;
          if (root) {
            root.style.setProperty('--bg-image', url);
            root.style.setProperty('--bg-filter', filter);
            if (overlayColor !== undefined && overlayOpacity !== undefined) {
              const a = Math.max(0, Math.min(1, overlayOpacity));
              const hex = overlayColor.replace('#', '');
              const r = parseInt(hex.substring(0, 2), 16) || 0;
              const g = parseInt(hex.substring(2, 4), 16) || 0;
              const b = parseInt(hex.substring(4, 6), 16) || 0;
              root.style.setProperty('--bg-overlay', `rgba(${r}, ${g}, ${b}, ${a})`);
            }
          }
        } catch (_) { }

        if (!bgEl) {
          if (attemptsLeft > 0) {
            setTimeout(() => doApply(attemptsLeft - 1), 50);
          }
          return;
        }
        bgEl.style.setProperty('--bg-image', url);
        bgEl.style.setProperty('--bg-filter', filter);
        if (overlayColor !== undefined && overlayOpacity !== undefined) {
          const a = Math.max(0, Math.min(1, overlayOpacity));
          // Convert hex to rgba
          const hex = overlayColor.replace('#', '');
          const r = parseInt(hex.substring(0, 2), 16) || 0;
          const g = parseInt(hex.substring(2, 4), 16) || 0;
          const b = parseInt(hex.substring(4, 6), 16) || 0;
          bgEl.style.setProperty('--bg-overlay', `rgba(${r}, ${g}, ${b}, ${a})`);
        }
      } catch (_) { /* ignore */ }
    };
    doApply(6); // try for ~300ms total
  }, [APPEARANCE_DEFAULTS.backgrounds]);

  React.useEffect(() => {
    let mounted = true
      ; (async () => {
        try {
          const a = await getSetting('ui.accent')
          if (a && mounted) {
            setAccent(a);
            setAppearance({ accent: a });
          }
        } catch { }
        // Load text colors
        try {
          const [txt, txtDark] = await Promise.all([
            getSetting('ui.text'),
            getSetting('ui.textDark')
          ]);
          if (!mounted) return;
          if (txt) { setTextColor(txt); setAppearance({ text: txt }); }
          if (txtDark) { setTextDarkColor(txtDark); setAppearance({ textDark: txtDark }); }
        } catch { }
        // Load Shadow (app background rgb triplet)
        try {
          const storedRgb = await getSetting('ui.bg.rgb');
          if (!mounted) return;
          const toHex = (rgbStr: string) => {
            try {
              const parts = rgbStr.split(',').map(s => parseInt(s.trim(), 10));
              const [r, g, b] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
              const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
              return hex;
            } catch { return '#0f1724'; }
          };
          if (storedRgb) { setShadowHex(toHex(storedRgb)); setAppearance({ bgRgb: storedRgb }); }
          else { setShadowHex('#0f1724'); setAppearance({ bgRgb: '15, 23, 36' }); }
        } catch { }

        // Load background appearance settings
        try {
          const [storedImage, storedBlur, storedBlurAmount, storedOverlay, storedOverlayOpacity] = await Promise.all([
            getSetting('ui.bg.image'),
            getSetting('ui.bg.blur'),
            getSetting('ui.bg.blurAmount'),
            getSetting('ui.bg.overlayColor'),
            getSetting('ui.bg.overlayOpacity')
          ]);
          if (!mounted) return;
          const image = storedImage || resolveBackground(APPEARANCE_DEFAULTS.backgrounds[0]);
          setBgImage(image);
          const idx = APPEARANCE_DEFAULTS.backgrounds.findIndex(entry => resolveBackground(entry) === image);
          setBgCarouselIndex(idx >= 0 ? idx : 0);
          // If the image is not a default background and not a data URL, show it in the custom URL input
          if (idx < 0 && !image.startsWith('data:')) {
            setBgCustomUrl(image);
          }
          // Treat missing or empty storedBlur as enabled by default
          const blur = (storedBlur === null || storedBlur === undefined || storedBlur === '') ? '1' : storedBlur;
          const blurBool = blur === '1' || blur === 'true';
          setBgBlur(blurBool);
          const blurAmount = storedBlurAmount != null ? Math.max(0, Math.min(200, Number(storedBlurAmount))) : 200;
          setBgBlurAmount(blurAmount);
          const overlayColor = storedOverlay || APPEARANCE_DEFAULTS.bgOverlayColor;
          const overlayOpacity = storedOverlayOpacity != null ? Number(storedOverlayOpacity) : APPEARANCE_DEFAULTS.bgOverlayOpacity;
          setBgOverlayColor(overlayColor);
          setBgOverlayOpacity(overlayOpacity);
          setAppearance({
            bgImage: image,
            blur: blurBool,
            blurAmount: blurAmount,
            overlayColor: overlayColor,
            overlayOpacity: overlayOpacity
          });
        } catch (_) { /* ignore */ }

        // Load audio settings
        try {
          // First get devices (this initializes BASS)
          const devicesResult = await getAudioDevices()
          const devices = devicesResult.devices || []
          setAudioDevices(devices)

          // Then get settings (now that BASS is initialized)
          const settingsResult = await getAudioSettings()

          if (mounted) {
            // If no device is set in settings, select the default device
            let settings = settingsResult.settings
            if (settings.device === undefined || settings.device === null || settings.device === -1) {
              const defaultDevice = devices.find(device => device.is_default)
              if (defaultDevice) {
                settings = { ...settings, device: defaultDevice.id }
                // Update the backend with the default device selection
                try {
                  // Preserve current sample_rate to avoid falling back to 44100 during reinit
                  await setAudioSettings({ device: defaultDevice.id, sample_rate: settings.sample_rate })
                } catch (error) {
                  frontendLogger.error('Failed to set default device:', error)
                }
              }
            }
            setAudioSettingsState(settings)
          }
        } catch (error) {
          frontendLogger.error('Failed to load audio settings:', error)
        }
      })()
    return () => { mounted = false }
  }, [])

  async function saveAccent() {
  setAppearance({ accent });
  try { const triplet = getAppearance().accentRgb; await setSetting('ui.accent.rgb', triplet); } catch { }
    try { await setSetting('ui.accent', accent) } catch { }
  }

  // Apply on change (no Save button)
  const onAccentChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const val = e.target.value;
    setAccent(val);
  setAppearance({ accent: val });
  try { const triplet = getAppearance().accentRgb; setSetting('ui.accent.rgb', triplet).catch(() => {}); } catch {}
    setSetting('ui.accent', val).catch(() => { });
  };

  const onTextColorChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const val = e.target.value;
    setTextColor(val);
  setAppearance({ text: val });
    setSetting('ui.text', val).catch(() => { });
  };

  const onTextDarkColorChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const val = e.target.value;
    setTextDarkColor(val);
  setAppearance({ textDark: val });
    setSetting('ui.textDark', val).catch(() => { });
  };

  // Background setting handlers
  const onCycleBackground = (dir: -1 | 1) => {
    const len = APPEARANCE_DEFAULTS.backgrounds.length;
    const next = (bgCarouselIndex + dir + len) % len;
    setBgCarouselIndex(next);
    const entry = APPEARANCE_DEFAULTS.backgrounds[next];
    const url = resolveBackground(entry);
    setBgImage(url);
  setAppearance({ bgImage: url });
    setSetting('ui.bg.image', url).catch(() => { });
  };

  const onApplyCustomUrl = () => {
    const url = bgCustomUrl.trim();
    if (!url) return;
    setBgImage(url);
  setAppearance({ bgImage: url });
    setSetting('ui.bg.image', url).catch(() => { });
  pushAlert(t('settings.background.applied'), 'info');
  };

  const onSelectCustomFile: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    try {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        pushAlert(t('settings.background.fileInvalid'), 'warn');
        return;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      setBgImage(dataUrl);
  setAppearance({ bgImage: dataUrl });
      setSetting('ui.bg.image', dataUrl).catch(() => { });
      setBgCustomUrl('');
      setBgCarouselIndex(0);
  pushAlert(t('settings.background.applied'), 'info');
    } catch (err) {
      frontendLogger.error('Failed to set custom background:', err);
  pushAlert(t('settings.background.applyFailed'), 'error');
    } finally {
      try { (e.target as HTMLInputElement).value = ''; } catch { }
    }
  };

  const onToggleBlur: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const val = e.target.checked;
    setBgBlur(val);
    setAppearance({ bgImage, blur: val });
    setSetting('ui.bg.blur', val ? '1' : '0').catch(() => { });
  };

  const onOverlayColorChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const val = e.target.value;
    setBgOverlayColor(val);
    setAppearance({ bgImage, overlayColor: val });
    setSetting('ui.bg.overlayColor', val).catch(() => { });
  };

  const onBlurAmountChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const val = Math.max(0, Math.min(200, Number(e.target.value)));
    setBgBlurAmount(val);
    setAppearance({ bgImage, blurAmount: val });
    setSetting('ui.bg.blurAmount', String(val)).catch(() => { });
  };

  const onOverlayOpacityChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const val = Math.max(0, Math.min(1, Number(e.target.value)));
    setBgOverlayOpacity(val);
    setAppearance({ bgImage, overlayOpacity: val });
    setSetting('ui.bg.overlayOpacity', String(val)).catch(() => { });
  };

  // Shadow color change handler (hex -> "r, g, b")
  const onShadowHexChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const hex = e.target.value || '#000000';
    setShadowHex(hex);
    try {
      const h = hex.replace('#', '');
      const r = parseInt(h.substring(0, 2), 16) || 0;
      const g = parseInt(h.substring(2, 4), 16) || 0;
      const b = parseInt(h.substring(4, 6), 16) || 0;
      const triplet = `${r}, ${g}, ${b}`;
    setAppearance({ bgRgb: triplet });
      setSetting('ui.bg.rgb', triplet).catch(() => { });
    } catch { }
  };

  async function onExport() {
    try {
      const j = await exportJSON()

      // If running inside Tauri, call the backend command to show a save dialog and write the file
      if (isTauriAvailable() && runTauriCommand) {
        try {
          const result = await runTauriCommand('save_file_and_write', {
            default_file_name: 'freely-export.json',
            contents: j
          });
          // runTauriCommand returns false if Tauri unavailable, an error object on failure, or the result
          if (result && typeof result === 'object' && 'error' in result) {
            throw new Error((result as any).message || 'Failed to save');
          }
          // Successful or cancelled (null/false) — show exported message
          pushAlert(t('settings.exported'), 'info');
        } catch (err) {
          frontendLogger.warn('Tauri save_file_and_write failed, falling back to browser download', err);
          // Fallback to browser download
          const blob = new Blob([j], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'freely-export.json';
          a.click();
          URL.revokeObjectURL(url);
          pushAlert(t('settings.exported'), 'info');
        }
      } else {
        // Browser fallback
        const blob = new Blob([j], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'freely-export.json';
        a.click();
        URL.revokeObjectURL(url);
  pushAlert(t('settings.exported'), 'info');
      }
    } catch (e) {
  frontendLogger.error('Failed to export settings:', e);
  pushAlert(t('settings.exportFailed'), 'error');
    }
  }

  // Export only the Appearance-related settings (with optional embedded image)
  async function onExportAppearance() {
    // runTauriCommand is imported from '../core/tauriCommands' above
    try {
      // Build appearance export: DO NOT include bgImage or bgCustomUrl.
      // Only include bgImageUrl (can be a resolved URL or a data: base64 string).
      const appearance: any = {
        accent,
        textColor,
        textDarkColor,
        shadowHex,
        bgBlur,
        bgBlurAmount,
        bgOverlayColor,
        bgOverlayOpacity
      };

      // Set bgImageUrl to the currently selected image. If it's a data: URL, that stays as-is.
      if (bgImage) {
        appearance.bgImageUrl = bgImage;
      }

      // If bgImage is a remote URL and NOT one of the defaults, we may optionally embed a base64 copy
      // as bgImageBase64 (best-effort). This does not add bgImage or bgCustomUrl.
      // We intentionally do NOT embed remote images as base64 here. If the selected
      // image is already a data: URL it will be exported via bgImageUrl. Otherwise we
      // export only bgImageUrl (the remote URL). This keeps export sizes predictable.

      const data = JSON.stringify(appearance, null, 2);

      // If running inside Tauri, call the backend command to show a save dialog and write the file
      if (isTauriAvailable() && runTauriCommand) {
        try {
          const result = await runTauriCommand('save_file_and_write', { default_file_name: 'freely-appearance.json', contents: data });
          // runTauriCommand returns false if Tauri unavailable, an error object on failure, or the result
          if (result && typeof result === 'object' && 'error' in result) {
            throw new Error((result as any).message || 'Failed to save');
          }
          // Successful or cancelled (null/false) — show exported message
          pushAlert(t('settings.appearance.exported'), 'info');
        } catch (err) {
          frontendLogger.warn('Tauri save_file_and_write failed, falling back to browser download', err);
          const blob = new Blob([data], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'freely-appearance.json';
          a.click();
          URL.revokeObjectURL(url);
          pushAlert(t('settings.appearance.exported'), 'info');
        }
      } else {
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'freely-appearance.json';
        a.click();
  URL.revokeObjectURL(url);
  pushAlert(t('settings.appearance.exported'), 'info');
      }
    } catch (e) {
  frontendLogger.error('Failed to export appearance:', e);
  pushAlert(t('settings.appearance.exportFailed'), 'error');
    }
  }

  // Import appearance JSON (file input handler)
  async function onImportAppearanceUpload(e: React.ChangeEvent<HTMLInputElement>) {
    try {
      const f = e.target.files?.[0]; if (!f) return;
      const s = await f.text();
      const parsed = JSON.parse(s);

      // Apply settings if present
      if (parsed.accent) { setAccent(parsed.accent); document.documentElement.style.setProperty('--accent', parsed.accent); setSetting('ui.accent', parsed.accent).catch(() => { }); }
      if (parsed.textColor) { setTextColor(parsed.textColor); document.documentElement.style.setProperty('--text', parsed.textColor); setSetting('ui.text', parsed.textColor).catch(() => { }); }
      if (parsed.textDarkColor) { setTextDarkColor(parsed.textDarkColor); document.documentElement.style.setProperty('--text-dark', parsed.textDarkColor); setSetting('ui.textDark', parsed.textDarkColor).catch(() => { }); }
      if (parsed.shadowHex) { setShadowHex(parsed.shadowHex); try { const h = parsed.shadowHex.replace('#', ''); const r = parseInt(h.substring(0, 2), 16) || 0; const g = parseInt(h.substring(2, 4), 16) || 0; const b = parseInt(h.substring(4, 6), 16) || 0; const triplet = `${r}, ${g}, ${b}`; document.documentElement.style.setProperty('--bg', triplet); setSetting('ui.bg.rgb', triplet).catch(() => { }); } catch { } }

      // Collect the new values for background application
      let newBgImage = bgImage;
      let newBgBlur = bgBlur;
      let newBgBlurAmount = bgBlurAmount;
      let newOverlayColor = bgOverlayColor;
      let newOverlayOpacity = bgOverlayOpacity;

      // Background image: prefer base64 if present, else use url
      if (parsed.bgImageBase64) {
        newBgImage = parsed.bgImageBase64;
        setBgImage(parsed.bgImageBase64);
        setSetting('ui.bg.image', parsed.bgImageBase64).catch(() => { });
      } else if (parsed.bgImageUrl || parsed.bgImage) {
        const img = parsed.bgImageUrl || parsed.bgImage;
        newBgImage = img;
        setBgImage(img);
        setSetting('ui.bg.image', img).catch(() => { });
      }

      if (parsed.bgCustomUrl !== undefined) setBgCustomUrl(parsed.bgCustomUrl);
      if (parsed.bgBlur !== undefined) {
        newBgBlur = Boolean(parsed.bgBlur);
        setBgBlur(Boolean(parsed.bgBlur));
        setSetting('ui.bg.blur', parsed.bgBlur ? '1' : '0').catch(() => { });
      }
      if (parsed.bgBlurAmount !== undefined) {
        newBgBlurAmount = Number(parsed.bgBlurAmount);
        setBgBlurAmount(Number(parsed.bgBlurAmount));
        setSetting('ui.bg.blurAmount', String(parsed.bgBlurAmount)).catch(() => { });
      }
      if (parsed.bgOverlayColor) {
        newOverlayColor = parsed.bgOverlayColor;
        setBgOverlayColor(parsed.bgOverlayColor);
        setSetting('ui.bg.overlayColor', parsed.bgOverlayColor).catch(() => { });
      }
      if (parsed.bgOverlayOpacity !== undefined) {
        newOverlayOpacity = Number(parsed.bgOverlayOpacity);
        setBgOverlayOpacity(Number(parsed.bgOverlayOpacity));
        setSetting('ui.bg.overlayOpacity', String(parsed.bgOverlayOpacity)).catch(() => { });
      }

      // Apply all background variables with the updated settings
      applyBackgroundVars(newBgImage, newBgBlur ? newBgBlurAmount : 0, newOverlayColor, newOverlayOpacity);

  pushAlert(t('settings.appearance.imported'), 'info');
    } catch (err) {
  frontendLogger.error('Failed to import appearance:', err);
  pushAlert(t('settings.appearance.importFailed'), 'error');
    } finally {
      try { (e.target as HTMLInputElement).value = ''; } catch { }
    }
  }

  async function onImportUpload(e: React.ChangeEvent<HTMLInputElement>) {
    try {
      const f = e.target.files?.[0];
      if (!f) return;

      setImportFileName(f.name);

      // Validate file type
      if (!f.name.toLowerCase().endsWith('.json')) {
        pushAlert(t('settings.import.invalidFile'), 'warn');
        return;
      }

      const s = await f.text();

      // Validate JSON format
      try {
        JSON.parse(s);
      } catch (parseErr) {
        pushAlert(t('settings.import.invalidJSON'), 'error');
        return;
      }

  // Import the settings
  await importJSON(s);
  pushAlert(t('settings.imported'), 'info');

      // Trigger a page refresh to apply imported settings
      try {
        window.dispatchEvent(new CustomEvent('freely:settingsImported'));
      } catch (_) { }

    } catch (error) {
  frontendLogger.error('Failed to import settings:', error);
  pushAlert(t('settings.importFailed'), 'error');
    } finally {
      // Clear the file input
      try {
        (e.target as HTMLInputElement).value = '';
        setImportFileName('');
      } catch { }
    }
  }

  async function onClearCache() {
    const ok = await prompt.confirm(t('settings.data.confirm'));
    if (!ok) return;
  try { await clearCache(); pushAlert(t('settings.data.cache.cleared'), 'info'); }
  catch (error) { frontendLogger.error('Failed to clear cache:', error); pushAlert(t('settings.data.cache.clearFailed'), 'error'); }
  }

  async function onClearLocalData() {
    const ok = await prompt.confirm(t('settings.data.confirm'));
    if (!ok) return;
    try {
      await clearLocalData();
      try { window.dispatchEvent(new CustomEvent('freely:localDataCleared')); } catch (_) { }
      try { if (location.hash) location.hash = ''; } catch (_) { }
      pushAlert(t('settings.data.local.cleared'), 'info');
    } catch (error) { frontendLogger.error('Failed to clear local data:', error); pushAlert(t('settings.data.local.clearFailed'), 'error'); }
  }

  async function updateAudioSetting(key: keyof AudioSettings, value: any) {
    if (!audioSettings) return;

    setIsLoadingAudio(true);
    try {
      const newSettings = { ...audioSettings, [key]: value };
      setAudioSettingsState(newSettings);

      const result = await setAudioSettings({ [key]: value });

      // Show appropriate message based on whether reinitialization occurred
      if (result.reinitialized) {
        pushAlert(t('settings.audio.reinitialized'), 'info');
      } else {
        pushAlert(t('settings.audio.updated'), 'info');
      }

      // Refresh settings to get the actual current state after reinitialization
      if (result.reinitialized) {
        try {
          const settingsResult = await getAudioSettings();
          setAudioSettingsState(settingsResult.settings);
        } catch (refreshError) {
          frontendLogger.warn('Failed to refresh settings after reinitialization:', refreshError);
        }
      }
    } catch (error) {
      frontendLogger.error('Failed to update audio setting:', error);
      pushAlert(t('settings.audio.updateFailed'), 'error');
      // Revert on error
      try {
        const settingsResult = await getAudioSettings();
        setAudioSettingsState(settingsResult.settings);
      } catch { }
    } finally {
      setIsLoadingAudio(false);
    }
  }

  async function refreshAudioSettings() {
    setIsLoadingAudio(true);
    try {
      // First get devices (this ensures BASS is initialized)
      const devicesResult = await getAudioDevices();
      setAudioDevices(devicesResult.devices || []);

      // Then get settings (now that BASS is initialized)
      const settingsResult = await getAudioSettings();
      setAudioSettingsState(settingsResult.settings);

      pushAlert(t('settings.audio.refreshed'), 'info');
    } catch (error) {
      frontendLogger.error('Failed to refresh audio settings:', error);
      pushAlert(t('settings.audio.refreshFailed'), 'error');
    } finally {
      setIsLoadingAudio(false);
    }
  }

  async function applyDeviceChange(deviceId: number) {
    if (!audioSettings) return;

    const confirmed = await prompt.confirm(t('settings.audio.deviceChange.confirm'));
    if (!confirmed) return;

    setIsLoadingAudio(true);
    try {
      // Persist device selection together with current sample_rate/buffer_size so backend reinit uses desired params in one shot
      try {
        await setAudioSettings({ device: deviceId, sample_rate: audioSettings.sample_rate, buffer_size: audioSettings.buffer_size });
      } catch (e) {
        frontendLogger.warn('Failed to persist device before reinit:', e);
      }

      // Reload settings after reinitialization
      const settingsResult = await getAudioSettings();
      setAudioSettingsState({ ...settingsResult.settings, device: deviceId });

      pushAlert(t('settings.audio.deviceChanged'), 'info');
    } catch (error) {
      frontendLogger.error('Failed to change audio device:', error);
      pushAlert(t('settings.audio.deviceChangeFailed'), 'error');
    } finally {
      setIsLoadingAudio(false);
    }
  }

  async function applyAdvancedSettings() {
    if (!audioSettings) return;

    const confirmed = await prompt.confirm(t('settings.audio.advancedSettings.confirm'));
    if (!confirmed) return;

    setIsLoadingAudio(true);
    try {
      // Persist all advanced settings; backend will reinitialize immediately when required
      const result = await setAudioSettings({
        device: audioSettings.device,
        sample_rate: audioSettings.sample_rate,
        buffer_size: audioSettings.buffer_size,
        bit_depth: audioSettings.bit_depth,
        output_channels: audioSettings.output_channels,
        exclusive_mode: audioSettings.exclusive_mode,
        net_buffer: audioSettings.net_buffer,
      });

      // If for any reason the backend did not reinitialize, perform it explicitly
      if (!result?.reinitialized) {
        await reinitializeAudio(audioSettings.device, audioSettings.sample_rate, audioSettings.buffer_size);
      }

      // Refresh settings from backend to reflect actual applied state
      try {
        const refreshed = await getAudioSettings();
        setAudioSettingsState(refreshed.settings);
      } catch (refreshErr) {
        frontendLogger.warn('Failed to refresh audio settings after apply:', refreshErr);
      }

      pushAlert(t('settings.audio.advancedApplied'), 'info');
    } catch (error) {
      frontendLogger.error('Failed to apply advanced audio settings:', error);
      pushAlert(t('settings.audio.advancedFailed'), 'error');
    } finally {
      setIsLoadingAudio(false);
    }
  }

  function colorButton(name: string, value: string, label: string, onChange: React.ChangeEventHandler<HTMLInputElement>) {
    return (
      <div className="settings-field block">
        <div className="settings-color-wrap">
          <label className="settings-field-label" htmlFor={name}>{label}</label>
          <input id={name} type="color" value={value} onChange={onChange} className="settings-color-input" aria-label={label} />
        </div>
      </div>
    );
  }


  return (
    <div className="settings-page">
      <div className="settings-sections">
        {/* Appearance */}
        <section className="settings-section" aria-labelledby="appearance-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">palette</span>
            <h3 id="appearance-header" className="settings-section-title">{t('settings.appearance')}</h3>
          </div>
          <div className="settings-card">
            <div className="settings-fields">
              <div className="settings-field inline">
                <label className="settings-field-label" htmlFor="language-select">{t('settings.language')}</label>
                <select id="language-select" value={lang} onChange={e => setLang(e.target.value)} className="settings-control-select" aria-label={t('settings.language')}>
                  <option value="en">English</option>
                  <option value="es">Español</option>
                </select>
              </div>
              {/* Colors */}
              <div className="settings-field">
                <label className="settings-field-label">{t('settings.colors')}</label>
                <div className="settings-group">
                  {colorButton('accent-color', accent, t('settings.accent'), onAccentChange)}
                  {colorButton('text-color', textColor, t('settings.text'), onTextColorChange)}
                  {colorButton('text-dark-color', textDarkColor, t('settings.textSecondary'), onTextDarkColorChange)}
                  {colorButton('bg-shadow-color', shadowHex, t('settings.shadow'), onShadowHexChange)}
                </div>
              </div>

              {/* Background settings */}
              <div className="settings-field">
                <label className="settings-field-label">{t('settings.background')}</label>
                <div className="bg-carousel" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8, alignItems: 'center' }}>
                  <div className="bg-preview" style={{ position: 'relative', height: 120, borderRadius: 10, overflow: 'hidden', border: '8px solid var(--border-subtle)' }}>
                    <button
                      className="btn btn-subtle"
                      onClick={() => onCycleBackground(-1)}
                      aria-label={t('settings.background.prev')}
                      style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', zIndex: 3 }}
                    >
                      <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>chevron_left</span>
                    </button>
                    <img src={mainPreviewFor(APPEARANCE_DEFAULTS.backgrounds[bgCarouselIndex])} alt={t('settings.background.preview')} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: bgBlur ? 'blur(0px)' : 'none', border: 'solid 1px var(--border-strong)' }} />
                    <button
                      className="btn btn-subtle"
                      onClick={() => onCycleBackground(1)}
                      aria-label={t('settings.background.next')}
                      style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', zIndex: 3 }}
                    >
                      <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>chevron_right</span>
                    </button>
                    {/* Thumbnails moved below the preview — rendered separately to improve layout */}
                  </div>
                </div>
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'center' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', overflowX: 'auto', padding: '6px 4px' }}>
                    {APPEARANCE_DEFAULTS.backgrounds.map((entry, i) => {
                      const thumb = previewFor(entry);
                      const resolved = resolveBackground(entry);
                      const active = i === bgCarouselIndex;
                      return (
                        <img
                          key={i}
                          src={thumb}
                          alt={`Background ${i + 1}`}
                          onClick={() => {
                            setBgCarouselIndex(i);
                            setBgImage(resolved);
                            applyBackgroundVars(resolved, bgBlur ? bgBlurAmount : 0, bgOverlayColor, bgOverlayOpacity);
                            setSetting('ui.bg.image', resolved).catch(() => { });
                          }}
                          style={{
                            width: 64,
                            height: 64,
                            objectFit: 'cover',
                            borderRadius: 6,
                            cursor: 'pointer',
                            border: active ? '2px solid var(--accent)' : '1px solid var(--border-subtle)',
                            boxSizing: 'border-box'
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
                <div className="settings-field-hint">{t('settings.background.hint')}</div>
              </div>

              <div className="settings-field inline">
                <label className="settings-field-label" htmlFor="bg-custom-url">{t('settings.background.custom')}</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
                  <input id="bg-custom-url" type="url" placeholder={t('settings.background.customUrl')} value={bgCustomUrl} onChange={e => setBgCustomUrl(e.target.value)} className="settings-control-input" style={{ flex: 1 }} />
                  <button className="btn btn-subtle" onClick={onApplyCustomUrl}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>check_circle</span>
                    {t('settings.background.use')}
                  </button>
                  <label className="btn btn-subtle" style={{ cursor: 'pointer' }}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>image</span>
                    <input type="file" accept="image/*" onChange={onSelectCustomFile} style={{ display: 'none' }} />
                  </label>
                </div>
              </div>

              <div className="settings-field inline">
                <label className="settings-field-label">
                  <input type="checkbox" checked={bgBlur} onChange={onToggleBlur} style={{ marginRight: 8 }} />
                  {t('settings.background.blur')}
                </label>
              </div>

              {bgBlur && (
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="bg-blur-amount">{t('settings.background.blurAmount')}</label>
                  <input
                    id="bg-blur-amount"
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={bgBlurAmount}
                    onChange={onBlurAmountChange}
                    aria-label={t('settings.background.blurAmount')}
                    style={{ ["--range-progress" as any]: `${(bgBlurAmount / 200) * 100}%` }}
                  />
                  <span className="settings-field-value">{bgBlurAmount}px</span>
                </div>
              )}

              <div className="settings-field inline">
                <label className="settings-field-label" htmlFor="bg-overlay-color">{t('settings.background.overlayColor')}</label>
                <div className="settings-color-wrap">
                  <input id="bg-overlay-color" type="color" value={bgOverlayColor} onChange={onOverlayColorChange} className="settings-color-input" aria-label={t('settings.background.overlayColor')} />
                </div>
              </div>

              <div className="settings-field inline">
                <label className="settings-field-label" htmlFor="bg-overlay-opacity">{t('settings.background.overlayOpacity')}</label>
                <input
                  id="bg-overlay-opacity"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={bgOverlayOpacity}
                  onChange={onOverlayOpacityChange}
                  aria-label={t('settings.background.overlayOpacity')}
                  style={{ ["--range-progress" as any]: `${bgOverlayOpacity * 100}%` }}
                />
              </div>
              {/* Appearance import/export for background and accent */}
              <div className="settings-field" style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn" onClick={onExportAppearance}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>upload</span>
                    {t('settings.appearance.export')}
                  </button>
                  <label className="btn btn-subtle" style={{ cursor: 'pointer' }}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>download</span>
                    {t('settings.appearance.import')}
                    <input type="file" accept="application/json" onChange={onImportAppearanceUpload} style={{ display: 'none' }} />
                  </label>
                </div>
                <div className="settings-field-hint">{t('settings.appearance.importExportHint')}</div>
              </div>
            </div>
          </div>
        </section>

        {/* Audio Settings */}
        <section className="settings-section" aria-labelledby="audio-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">volume_up</span>
            <h3 id="audio-header" className="settings-section-title">{t('settings.audio')}</h3>
            <button
              className="btn btn-subtle"
              onClick={refreshAudioSettings}
              disabled={isLoadingAudio}
              title={t('settings.audio.refresh')}
            >
              <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>refresh</span>
              {t('settings.audio.refresh')}
            </button>
          </div>
          <div className="settings-card">
            {audioSettings ? (
              <div className="settings-fields">
                {/* Current Audio Status */}
                <div className="settings-field">
                  <div className="settings-info-panel">
                    <p className="settings-info-title">{t('settings.audio.currentStatus')}</p>
                    <div className="settings-info-grid">
                      <span>{t('settings.audio.device')}: {
                        audioDevices.find(device => device.id === audioSettings.device)?.name ||
                        t('settings.audio.device.unknown')
                      }</span>
                      <span>{t('settings.audio.sampleRate')}: {audioSettings.sample_rate}Hz</span>
                      <span>{t('settings.audio.bitDepth')}: {audioSettings.bit_depth}-bit</span>
                      <span>{t('settings.audio.outputChannels')}: {audioSettings.output_channels} {t('settings.audio.outputChannels.channels')}</span>
                    </div>
                  </div>
                </div>

                {/* Audio Device */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="audio-device">{t('settings.audio.device')}</label>
                  <select
                    id="audio-device"
                    value={audioSettings.device}
                    onChange={e => applyDeviceChange(parseInt(e.target.value))}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    {audioDevices.map(device => (
                      <option
                        key={device.id}
                        value={device.id}
                        disabled={!device.is_enabled}
                      >
                        {device.name}
                        {device.is_default && ` ${t('settings.audio.device.default')}`}
                        {!device.is_enabled && ` ${t('settings.audio.device.disabled')}`}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Sample Rate */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="sample-rate">{t('settings.audio.sampleRate')}</label>
                  <select
                    id="sample-rate"
                    value={audioSettings.sample_rate}
                    onChange={e => setAudioSettingsState({ ...audioSettings, sample_rate: parseInt(e.target.value) })}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={44100}>{t('settings.audio.sampleRate.44100')}</option>
                    <option value={48000}>{t('settings.audio.sampleRate.48000')}</option>
                    <option value={88200}>{t('settings.audio.sampleRate.88200')}</option>
                    <option value={96000}>{t('settings.audio.sampleRate.96000')}</option>
                    <option value={176400}>{t('settings.audio.sampleRate.176400')}</option>
                    <option value={192000}>{t('settings.audio.sampleRate.192000')}</option>
                  </select>
                </div>

                {/* Bit Depth */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="bit-depth">{t('settings.audio.bitDepth')}</label>
                  <select
                    id="bit-depth"
                    value={audioSettings.bit_depth}
                    onChange={e => setAudioSettingsState({ ...audioSettings, bit_depth: parseInt(e.target.value) })}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={16}>{t('settings.audio.bitDepth.16')}</option>
                    <option value={24}>{t('settings.audio.bitDepth.24')}</option>
                    <option value={32}>{t('settings.audio.bitDepth.32')}</option>
                  </select>
                </div>

                {/* Buffer Size */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="buffer-size">{t('settings.audio.bufferSize')}</label>
                  <select
                    id="buffer-size"
                    value={audioSettings.buffer_size}
                    onChange={e => setAudioSettingsState({ ...audioSettings, buffer_size: parseInt(e.target.value) })}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={256}>{t('settings.audio.bufferSize.256')}</option>
                    <option value={512}>{t('settings.audio.bufferSize.512')}</option>
                    <option value={1024}>{t('settings.audio.bufferSize.1024')}</option>
                    <option value={2048}>{t('settings.audio.bufferSize.2048')}</option>
                    <option value={4096}>{t('settings.audio.bufferSize.4096')}</option>
                  </select>
                </div>

                {/* Network Buffer */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="net-buffer">{t('settings.audio.netBuffer')}</label>
                  <select
                    id="net-buffer"
                    value={audioSettings.net_buffer}
                    onChange={e => updateAudioSetting('net_buffer', parseInt(e.target.value))}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={1000}>{t('settings.audio.netBuffer.1000')}</option>
                    <option value={2000}>{t('settings.audio.netBuffer.2000')}</option>
                    <option value={5000}>{t('settings.audio.netBuffer.5000')}</option>
                    <option value={10000}>{t('settings.audio.netBuffer.10000')}</option>
                    <option value={15000}>{t('settings.audio.netBuffer.15000')}</option>
                  </select>
                </div>

                {/* Output Channels */}
                <div className="settings-field inline">
                  <label className="settings-field-label" htmlFor="output-channels">{t('settings.audio.outputChannels')}</label>
                  <select
                    id="output-channels"
                    value={audioSettings.output_channels}
                    onChange={e => setAudioSettingsState({ ...audioSettings, output_channels: parseInt(e.target.value) })}
                    className="settings-control-select"
                    disabled={isLoadingAudio}
                  >
                    <option value={1}>{t('settings.audio.outputChannels.1')}</option>
                    <option value={2}>{t('settings.audio.outputChannels.2')}</option>
                    <option value={6}>{t('settings.audio.outputChannels.6')}</option>
                    <option value={8}>{t('settings.audio.outputChannels.8')}</option>
                  </select>
                </div>

                {/* Exclusive Mode */}
                <div className="settings-field inline">
                  <label className="settings-field-label">
                    <input
                      type="checkbox"
                      checked={audioSettings.exclusive_mode}
                      onChange={e => updateAudioSetting('exclusive_mode', e.target.checked)}
                      disabled={isLoadingAudio}
                      style={{ marginRight: '8px' }}
                    />
                    {t('settings.audio.exclusiveMode')}
                  </label>
                  <p className="settings-field-hint">{t('settings.audio.exclusiveMode.hint')}</p>
                </div>

                {/* Apply Advanced Settings Button */}
                <div className="settings-field">
                  <div className="btn-row">
                    <button
                      className="btn"
                      onClick={applyAdvancedSettings}
                      disabled={isLoadingAudio}
                    >
                      {isLoadingAudio ? (
                        <>
                          <span className="material-symbols-rounded spinning" aria-hidden="true" style={ICON_STYLE}>refresh</span>
                          {t('settings.audio.applying')}
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>tune</span>
                          {t('settings.audio.applyAdvanced')}
                        </>
                      )}
                    </button>
                  </div>
                  <p className="settings-field-hint">
                    {t('settings.audio.applyAdvanced.hint')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="loading-state">
                <span className="material-symbols-rounded spinning" aria-hidden="true" style={ICON_STYLE}>refresh</span>
                {t('settings.audio.loading')}
              </div>
            )}
          </div>
        </section>

        {/* Import / Export */}
        <section className="settings-section" aria-labelledby="import-export-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">sync_alt</span>
            <h3 id="import-export-header" className="settings-section-title">{t('settings.importExport')}</h3>
          </div>
          <div className="settings-card">
            <div className="settings-fields">
              <div className="settings-field">
                <div className="btn-row">
                  <button className="btn" onClick={onExport}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>upload</span>
                    {t('settings.export')}
                  </button>
                  <div className="file-input-wrap">
                    <input id="import-file" className="file-input-hidden" type="file" accept="application/json" onChange={onImportUpload} aria-label={t('settings.import.placeholder')} />
                    <label htmlFor="import-file" className="btn btn-subtle" style={{ cursor: 'pointer' }}>
                      <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>download</span>
                      {t('settings.import')}
                      {importFileName && <span className="file-input-filename" title={importFileName}>{importFileName}</span>}
                    </label>
                  </div>
                </div>
                <p className="settings-field-hint">{t('settings.importExport.hint')}</p>
              </div>
            </div>
          </div>
        </section>

        {/* Plugins */}
        <section className="settings-section" aria-labelledby="plugins-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">extension</span>
            <h3 id="plugins-header" className="settings-section-title">{t('plugins.plugins')}</h3>
          </div>
          <div className="settings-card">
            <PluginList />
          </div>
        </section>

        {/* Data Management */}
        <section className="settings-section" aria-labelledby="data-header">
          <div className="settings-section-header">
            <span className="material-symbols-rounded settings-icon" aria-hidden="true">database</span>
            <h3 id="data-header" className="settings-section-title">{t('settings.data')}</h3>
          </div>
          <div className="settings-warning" role="note">
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20 }}>warning</span>
            <div>{t('settings.data.warning')}</div>
          </div>
          <div className="settings-card tight" aria-live="polite">
            <div className="settings-fields">
              <div className="settings-field">
                <div className="btn-row">
                  <button className="btn btn-danger" onClick={onClearCache}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>delete</span>
                    {t('settings.data.cache.clear')}
                  </button>
                </div>
                <p className="settings-field-hint">{t('settings.data.cache.description')}</p>
              </div>
              <div className="settings-field">
                <div className="btn-row">
                  <button className="btn btn-danger" onClick={onClearLocalData}>
                    <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>delete_forever</span>
                    {t('settings.data.local.clear')}
                  </button>
                </div>
                <p className="settings-field-hint">{t('settings.data.local.description')}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function PluginList() {
  const [plugins, setPlugins] = React.useState<any[]>([]);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const { t } = useI18n();

  async function load() {
    try {
      // Prefer Tauri backend list when available
      if (isTauriAvailable()) {
        const list = await pluginsList();
        list.sort((a: any, b: any) => String(a?.name || '').toLowerCase().localeCompare(String(b?.name || '').toLowerCase()));
        setPlugins(list);
      } else {
        // Fallback: show bundled public list without enabled state
        const base = await fetch('/plugins/index.json').then(r => r.json()).catch(() => []);
        const sorted = (base || []).slice().sort((a: any, b: any) => String(a?.name || '').toLowerCase().localeCompare(String(b?.name || '').toLowerCase()));
        setPlugins(sorted.map((e: any) => ({ ...e, enabled: true })));
      }
    } catch {
      setPlugins([]);
    }
  }

  React.useEffect(() => { load(); }, []);

  async function onToggle(p: any, checked: boolean) {
    if (!isTauriAvailable()) return; // no-op in web
    setBusy(true);
    try {
      await pluginsSetEnabled(p.name, checked);
      await load();
    } finally { setBusy(false); }
  }

  async function onDelete(p: any) {
    if (!isTauriAvailable()) return; // no-op in web
  if (!confirm(t('plugins.delete.confirm'))) return;
    setBusy(true);
    try {
      await pluginsDelete(p.name);
      await load();
    } finally { setBusy(false); }
  }

  async function onUploadZip(e: React.ChangeEvent<HTMLInputElement>) {
    try {
      const f = e.target.files?.[0];
      if (!f) return;
      setBusy(true);
      await pluginsInstallZipFromFile(f);
      await load();
    } catch (err) {
      frontendLogger.error('Plugin install failed', err);
  alert(t('plugins.installFailed'));
    } finally {
      setBusy(false);
      try { if (e.target) (e.target as HTMLInputElement).value = ''; } catch { }
    }
  }

  return (
    <div className="plugin-section">
      <div className="plugin-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <label className={`btn btn-subtle ${!isTauriAvailable() ? 'disabled' : ''}`} style={{ cursor: isTauriAvailable() ? 'pointer' : 'not-allowed' }}>
          <span className="material-symbols-rounded" aria-hidden="true" style={ICON_STYLE}>upload</span>
          {t('plugins.add')}
          <input ref={fileRef} type="file" accept=".zip" onChange={onUploadZip} style={{ display: 'none' }} disabled={!isTauriAvailable() || busy} />
        </label>
      </div>
      {plugins.length === 0 ? (
        <div className="plugin-empty">{t('plugins.none')}</div>
      ) : (
        <div className="plugin-grid">
          {plugins.map((p: any) => (
            <div className="plugin-card" key={p.name}>
              <div className="title"><div className='plugin-name'>{p.name}</div> <small>v{p.version}</small></div>
              <div className="meta">{p.provider && <div className="meta-sub">{p.provider}</div>}</div>
              <div className="row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
                <label className="toggle" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={!!p.enabled} onChange={e => onToggle(p, e.target.checked)} disabled={!isTauriAvailable() || busy} />
                </label>
                <button className="btn btn-danger btn-sm" onClick={() => onDelete(p)} disabled={!isTauriAvailable() || busy}>
                  <span className="material-symbols-rounded" aria-hidden>delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
