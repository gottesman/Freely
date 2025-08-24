import React, { createContext, useContext, useState } from 'react';
import { useI18n } from './i18n';
import '../styles/prompt.css';

type PromptResolve = (v: string|null) => void;
type ConfirmResolve = (v: boolean) => void;

interface PromptCtx {
  prompt: (message: string, defaultValue?: string) => Promise<string|null>;
  confirm: (message: string) => Promise<boolean>;
}

const PromptCtx = createContext<PromptCtx | undefined>(undefined);

export const PromptProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'prompt'|'confirm'|'none'>('none');
  const [message, setMessage] = useState<string>('');
  const [value, setValue] = useState<string>('');
  const resolveRef = React.useRef<PromptResolve | ConfirmResolve | null>(null);
  const { t } = useI18n();

  const prompt = (msg: string, defaultValue?: string) => {
    return new Promise<string|null>((resolve) => {
      setMessage(msg);
      setValue(defaultValue || '');
      resolveRef.current = resolve as PromptResolve;
      setType('prompt');
      setOpen(true);
    });
  };

  const confirm = (msg: string) => {
    return new Promise<boolean>((resolve) => {
      setMessage(msg);
      resolveRef.current = resolve as ConfirmResolve;
      setType('confirm');
      setOpen(true);
    });
  };

  function onCancel(){
    if(!resolveRef.current) return;
    try { (resolveRef.current as any)(type === 'confirm' ? false : null); } catch(_){}
    resolveRef.current = null;
    setOpen(false);
    setType('none');
  }

  function onConfirm(){
    if(!resolveRef.current) return;
    if(type === 'confirm'){
      try { (resolveRef.current as ConfirmResolve)(true); } catch(_){}
    } else {
      try { (resolveRef.current as PromptResolve)(value || null); } catch(_){}
    }
    resolveRef.current = null;
    setOpen(false);
    setType('none');
  }

  return (
    <PromptCtx.Provider value={{ prompt, confirm }}>
      {children}
      {open && (
        <div className="prompt-modal" role="dialog" aria-modal="true">
          <div className="prompt-backdrop" onClick={onCancel} />
          <div className="prompt-card">
            <div className="prompt-message">{message}</div>
            {type === 'prompt' && (
              <input className="prompt-input" autoFocus value={value} onChange={e=>setValue(e.target.value)} />
            )}
            <div className="prompt-actions">
              <button className="np-pill" onClick={onCancel}>{t('common.cancel','Cancel')}</button>
              <button className="np-pill create-confirm" onClick={onConfirm}>{type==='confirm' ? t('common.ok','OK') : t('common.create','Create')}</button>
            </div>
          </div>
        </div>
      )}
    </PromptCtx.Provider>
  );
};

export function usePrompt(){
  const ctx = useContext(PromptCtx);
  if(!ctx) throw new Error('usePrompt must be used within PromptProvider');
  return ctx;
}
