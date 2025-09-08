import React, { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';
import { useI18n } from './i18n';
import '../styles/prompt.css';

// Performance constants
const PROMPT_CONSTANTS = {
  DIALOG_TYPES: {
    NONE: 'none',
    PROMPT: 'prompt',
    CONFIRM: 'confirm'
  },
  CSS_CLASSES: {
    MODAL: 'prompt-modal',
    BACKDROP: 'prompt-backdrop',
    CARD: 'prompt-card',
    MESSAGE: 'prompt-message',
    INPUT: 'prompt-input',
    ACTIONS: 'prompt-actions',
    PILL: 'np-pill',
    CONFIRM_BUTTON: 'create-confirm'
  },
  DEFAULT_VALUES: {
    EMPTY_STRING: '',
    DEFAULT_MESSAGE: ''
  },
  ARIA_ATTRIBUTES: {
    DIALOG_ROLE: 'dialog',
    MODAL_TRUE: 'true'
  }
} as const;

// Translation key constants
const TRANSLATION_KEYS = {
  CANCEL: 'common.cancel',
  OK: 'common.ok',
  CREATE: 'common.create'
} as const;

// Default translation values
const DEFAULT_TRANSLATIONS = {
  CANCEL: 'Cancel',
  OK: 'OK',
  CREATE: 'Create'
} as const;

// Type definitions
type DialogType = typeof PROMPT_CONSTANTS.DIALOG_TYPES[keyof typeof PROMPT_CONSTANTS.DIALOG_TYPES];
type PromptResolve = (v: string | null) => void;
type ConfirmResolve = (v: boolean) => void;
type AnyResolve = PromptResolve | ConfirmResolve;

// Utility classes for better organization
interface PromptState {
  open: boolean;
  type: DialogType;
  message: string;
  value: string;
}

class PromptStateManager {
  /**
   * Get initial prompt state
   */
  static getInitialState(): PromptState {
    return {
      open: false,
      type: PROMPT_CONSTANTS.DIALOG_TYPES.NONE as DialogType,
      message: PROMPT_CONSTANTS.DEFAULT_VALUES.DEFAULT_MESSAGE,
      value: PROMPT_CONSTANTS.DEFAULT_VALUES.EMPTY_STRING
    };
  }

  /**
   * Create prompt state for showing prompt dialog
   */
  static createPromptState(message: string, defaultValue: string = PROMPT_CONSTANTS.DEFAULT_VALUES.EMPTY_STRING): PromptState {
    return {
      open: true,
      type: PROMPT_CONSTANTS.DIALOG_TYPES.PROMPT as DialogType,
      message,
      value: defaultValue
    };
  }

  /**
   * Create confirm state for showing confirm dialog
   */
  static createConfirmState(message: string): PromptState {
    return {
      open: true,
      type: PROMPT_CONSTANTS.DIALOG_TYPES.CONFIRM as DialogType,
      message,
      value: PROMPT_CONSTANTS.DEFAULT_VALUES.EMPTY_STRING
    };
  }

  /**
   * Create closed state
   */
  static createClosedState(): PromptState {
    return {
      open: false,
      type: PROMPT_CONSTANTS.DIALOG_TYPES.NONE as DialogType,
      message: PROMPT_CONSTANTS.DEFAULT_VALUES.DEFAULT_MESSAGE,
      value: PROMPT_CONSTANTS.DEFAULT_VALUES.EMPTY_STRING
    };
  }
}

class PromptResolver {
  /**
   * Safely resolve prompt with error handling
   */
  static resolvePrompt(resolver: AnyResolve | null, type: DialogType, value?: string): void {
    if (!resolver) return;
    
    try {
      if (type === PROMPT_CONSTANTS.DIALOG_TYPES.CONFIRM) {
        (resolver as ConfirmResolve)(true);
      } else {
        (resolver as PromptResolve)(value || null);
      }
    } catch (error) {
      console.warn('[PromptResolver] Error resolving prompt:', error);
    }
  }

  /**
   * Safely cancel prompt with error handling
   */
  static cancelPrompt(resolver: AnyResolve | null, type: DialogType): void {
    if (!resolver) return;
    
    try {
      if (type === PROMPT_CONSTANTS.DIALOG_TYPES.CONFIRM) {
        (resolver as ConfirmResolve)(false);
      } else {
        (resolver as PromptResolve)(null);
      }
    } catch (error) {
      console.warn('[PromptResolver] Error canceling prompt:', error);
    }
  }
}

interface PromptCtx {
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
}

const PromptCtx = createContext<PromptCtx | undefined>(undefined);

export const PromptProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Consolidated state management
  const [state, setState] = useState(() => PromptStateManager.getInitialState());
  const resolveRef = useRef<AnyResolve | null>(null);
  const { t } = useI18n();

  // Optimize prompt function with useCallback
  const prompt = useCallback((message: string, defaultValue?: string): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setState(PromptStateManager.createPromptState(message, defaultValue));
      resolveRef.current = resolve as PromptResolve;
    });
  }, []);

  // Optimize confirm function with useCallback
  const confirm = useCallback((message: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState(PromptStateManager.createConfirmState(message));
      resolveRef.current = resolve as ConfirmResolve;
    });
  }, []);

  // Optimize cancel handler with useCallback
  const handleCancel = useCallback(() => {
    PromptResolver.cancelPrompt(resolveRef.current, state.type);
    resolveRef.current = null;
    setState(PromptStateManager.createClosedState());
  }, [state.type]);

  // Optimize confirm handler with useCallback
  const handleConfirm = useCallback(() => {
    PromptResolver.resolvePrompt(resolveRef.current, state.type, state.value);
    resolveRef.current = null;
    setState(PromptStateManager.createClosedState());
  }, [state.type, state.value]);

  // Optimize input change handler with useCallback
  const handleInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setState(prev => ({ ...prev, value: event.target.value }));
  }, []);

  // Optimize backdrop click to prevent event bubbling
  const handleBackdropClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    handleCancel();
  }, [handleCancel]);

  // Optimize context value with useMemo
  const contextValue = useMemo(() => ({
    prompt,
    confirm
  }), [prompt, confirm]);

  // Optimize translations with useMemo
  const translations = useMemo(() => ({
    cancel: t(TRANSLATION_KEYS.CANCEL, DEFAULT_TRANSLATIONS.CANCEL),
    ok: t(TRANSLATION_KEYS.OK, DEFAULT_TRANSLATIONS.OK),
    create: t(TRANSLATION_KEYS.CREATE, DEFAULT_TRANSLATIONS.CREATE)
  }), [t]);

  // Optimize button text with useMemo
  const confirmButtonText = useMemo(() => {
    return state.type === PROMPT_CONSTANTS.DIALOG_TYPES.CONFIRM 
      ? translations.ok 
      : translations.create;
  }, [state.type, translations.ok, translations.create]);

  return (
    <PromptCtx.Provider value={contextValue}>
      {children}
      {state.open && (
        <div 
          className={PROMPT_CONSTANTS.CSS_CLASSES.MODAL} 
          role={PROMPT_CONSTANTS.ARIA_ATTRIBUTES.DIALOG_ROLE} 
          aria-modal={PROMPT_CONSTANTS.ARIA_ATTRIBUTES.MODAL_TRUE}
        >
          <div 
            className={PROMPT_CONSTANTS.CSS_CLASSES.BACKDROP} 
            onClick={handleBackdropClick} 
          />
          <div className={PROMPT_CONSTANTS.CSS_CLASSES.CARD}>
            <div className={PROMPT_CONSTANTS.CSS_CLASSES.MESSAGE}>
              {state.message}
            </div>
            {state.type === PROMPT_CONSTANTS.DIALOG_TYPES.PROMPT && (
              <input 
                className={PROMPT_CONSTANTS.CSS_CLASSES.INPUT}
                autoFocus 
                value={state.value} 
                onChange={handleInputChange}
              />
            )}
            <div className={PROMPT_CONSTANTS.CSS_CLASSES.ACTIONS}>
              <button 
                className={PROMPT_CONSTANTS.CSS_CLASSES.PILL} 
                onClick={handleCancel}
              >
                {translations.cancel}
              </button>
              <button 
                className={`${PROMPT_CONSTANTS.CSS_CLASSES.PILL} ${PROMPT_CONSTANTS.CSS_CLASSES.CONFIRM_BUTTON}`}
                onClick={handleConfirm}
              >
                {confirmButtonText}
              </button>
            </div>
          </div>
        </div>
      )}
    </PromptCtx.Provider>
  );
};

export function usePrompt(): PromptCtx {
  const context = useContext(PromptCtx);
  if (!context) {
    throw new Error('usePrompt must be used within PromptProvider');
  }
  return context;
}
