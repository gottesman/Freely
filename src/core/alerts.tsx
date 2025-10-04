import React, { createContext, useCallback, useContext, useState, useRef, useMemo, useEffect } from 'react';
import { frontendLogger } from './FrontendLogger';

export type AlertSeverity = 'info' | 'warn' | 'error';

export interface AlertItem { 
  id: string; 
  msg: string; 
  severity: AlertSeverity; 
  dismissing?: boolean; 
}

interface AlertsCtxValue {
  alerts: AlertItem[];
  push: (msg: string, severity?: AlertSeverity, meta?: any) => void;
  dismiss: (id: string) => void;
  clear: () => void;
  addLogListener: (fn: (entry: LogEntry) => void) => () => void;
}

export interface LogEntry { 
  ts: number; 
  source: string; 
  msg: string; 
  severity: AlertSeverity; 
  meta?: any; 
}

// Constants for better performance and maintainability
const ALERT_CONFIG = {
  AUTO_DISMISS_DELAY: 3000, // 3 seconds visible
  FADE_DURATION: 300, // CSS transition duration
  MAX_ALERTS: 10, // Prevent memory issues
} as const;

// Memoized severity icon mapping
const SEVERITY_ICONS: Record<AlertSeverity, string> = {
  error: 'error',
  warn: 'warning',
  info: 'info'
} as const;

const AlertsCtx = createContext<AlertsCtxValue | undefined>(undefined);

// Custom hook for managing alert timers
function useAlertTimers() {
  const timersRef = useRef<Map<string, { dismissTimer?: NodeJS.Timeout; removeTimer?: NodeJS.Timeout }>>(new Map());

  const clearTimers = useCallback((id: string) => {
    const timers = timersRef.current.get(id);
    if (timers) {
      if (timers.dismissTimer) clearTimeout(timers.dismissTimer);
      if (timers.removeTimer) clearTimeout(timers.removeTimer);
      timersRef.current.delete(id);
    }
  }, []);

  const setAutoDismiss = useCallback((id: string, onDismiss: () => void, onRemove: () => void) => {
    // Clear any existing timers for this alert
    clearTimers(id);

    // Set new timers
    const dismissTimer = setTimeout(() => {
      onDismiss();
      
      const removeTimer = setTimeout(() => {
        onRemove();
        timersRef.current.delete(id);
      }, ALERT_CONFIG.FADE_DURATION);

      // Update the timers map
      const currentTimers = timersRef.current.get(id);
      if (currentTimers) {
        currentTimers.removeTimer = removeTimer;
      }
    }, ALERT_CONFIG.AUTO_DISMISS_DELAY);

    timersRef.current.set(id, { dismissTimer });
  }, [clearTimers]);

  const setManualDismiss = useCallback((id: string, onRemove: () => void) => {
    clearTimers(id);
    
    const removeTimer = setTimeout(() => {
      onRemove();
      timersRef.current.delete(id);
    }, ALERT_CONFIG.FADE_DURATION);

    timersRef.current.set(id, { removeTimer });
  }, [clearTimers]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      for (const [id] of timersRef.current) {
        clearTimers(id);
      }
    };
  }, [clearTimers]);

  return { setAutoDismiss, setManualDismiss, clearTimers };
}

export const AlertsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const logListenersRef = useRef<((e: LogEntry) => void)[]>([]);
  const { setAutoDismiss, setManualDismiss, clearTimers } = useAlertTimers();

  // Memoized log emitter
  const emitLog = useCallback((entry: LogEntry) => {
    for (const fn of logListenersRef.current) {
      try { 
        fn(entry); 
      } catch (error) {
        frontendLogger.warn('Error in log listener:', error);
      }
    }
  }, []);

  // Optimized alert generation
  const generateAlertId = useCallback(() => 
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    []
  );

  // Unified dismiss logic
  const triggerDismiss = useCallback((id: string) => {
    setAlerts(prev => prev.map(alert => 
      alert.id === id ? { ...alert, dismissing: true } : alert
    ));
  }, []);

  // Unified remove logic
  const removeAlert = useCallback((id: string) => {
    setAlerts(prev => prev.filter(alert => alert.id !== id));
    clearTimers(id);
  }, [clearTimers]);

  const push = useCallback((msg: string, severity: AlertSeverity = 'info', meta?: any) => {
    if (!msg?.trim()) return;

    const id = generateAlertId();
    
    // Limit the number of alerts to prevent memory issues
    setAlerts(prev => {
      const newAlert = { id, msg: msg.trim(), severity };
      const updatedAlerts = [...prev, newAlert];
      
      // Remove oldest alerts if exceeding limit
      if (updatedAlerts.length > ALERT_CONFIG.MAX_ALERTS) {
        const alertsToRemove = updatedAlerts.slice(0, updatedAlerts.length - ALERT_CONFIG.MAX_ALERTS);
        alertsToRemove.forEach(alert => clearTimers(alert.id));
        return updatedAlerts.slice(-ALERT_CONFIG.MAX_ALERTS);
      }
      
      return updatedAlerts;
    });

    // Emit log entry
    emitLog({ 
      ts: Date.now(), 
      source: 'alert', 
      msg: msg.trim(), 
      severity, 
      meta 
    });
    
    // Set up auto-dismiss
    setAutoDismiss(
      id, 
      () => triggerDismiss(id), 
      () => removeAlert(id)
    );
  }, [generateAlertId, emitLog, setAutoDismiss, triggerDismiss, removeAlert, clearTimers]);

  const dismiss = useCallback((id: string) => {
    triggerDismiss(id);
    setManualDismiss(id, () => removeAlert(id));
  }, [triggerDismiss, setManualDismiss, removeAlert]);

  const clear = useCallback(() => {
    // Clear all timers before clearing alerts
    alerts.forEach(alert => clearTimers(alert.id));
    setAlerts([]);
  }, [alerts, clearTimers]);

  const addLogListener = useCallback((fn: (e: LogEntry) => void) => {
    logListenersRef.current.push(fn);
    return () => { 
      logListenersRef.current = logListenersRef.current.filter(f => f !== fn); 
    };
  }, []);

  // Memoized context value to prevent unnecessary re-renders
  const contextValue = useMemo(() => ({
    alerts,
    push,
    dismiss,
    clear,
    addLogListener
  }), [alerts, push, dismiss, clear, addLogListener]);

  return (
    <AlertsCtx.Provider value={contextValue}>
      {children}
    </AlertsCtx.Provider>
  );
};

export function useAlerts() {
  const ctx = useContext(AlertsCtx);
  if (!ctx) throw new Error('useAlerts must be used within AlertsProvider');
  return ctx;
}

// Memoized alert item component for better performance
const AlertItemComponent = React.memo<{
  alert: AlertItem;
  onDismiss: (id: string) => void;
}>(({ alert, onDismiss }) => {
  const handleDismiss = useCallback(() => {
    onDismiss(alert.id);
  }, [alert.id, onDismiss]);

  const icon = SEVERITY_ICONS[alert.severity];
  const className = `player-alert severity-${alert.severity}${alert.dismissing ? ' dismissing' : ''}`;

  return (
    <div 
      className={className} 
      role="alert"
      aria-live={alert.severity === 'error' ? 'assertive' : 'polite'}
    >
      <div className="icon" aria-hidden="true">
        <span className="material-symbols-rounded">{icon}</span>
      </div>
      <div className="msg">{alert.msg}</div>
      <button 
        className="close" 
        aria-label="Dismiss notification" 
        onClick={handleDismiss}
        type="button"
      >
        <span className="material-symbols-rounded">close</span>
      </button>
    </div>
  );
});

AlertItemComponent.displayName = 'AlertItem';

export const AlertsHost: React.FC = () => {
  const { alerts, dismiss } = useAlerts();
  
  // Memoized alert items to prevent unnecessary re-renders
  const alertItems = useMemo(() => 
    alerts.map(alert => (
      <AlertItemComponent
        key={alert.id}
        alert={alert}
        onDismiss={dismiss}
      />
    )), [alerts, dismiss]);

  if (!alerts.length) return null;

  return (
    <div className="player-alerts" role="region" aria-label="Notifications">
      {alertItems}
    </div>
  );
};
