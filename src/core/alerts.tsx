import React, { createContext, useCallback, useContext, useState } from 'react';

export type AlertSeverity = 'info' | 'warn' | 'error';
export interface AlertItem { id: string; msg: string; severity: AlertSeverity; }

interface AlertsCtxValue {
  alerts: AlertItem[];
  push: (msg: string, severity?: AlertSeverity) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

const AlertsCtx = createContext<AlertsCtxValue | undefined>(undefined);

export const AlertsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);

  const push = useCallback((msg: string, severity: AlertSeverity = 'info') => {
    if(!msg) return;
    setAlerts(a => [...a, { id: Date.now().toString(36)+Math.random().toString(36).slice(2,7), msg, severity }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setAlerts(a => a.filter(al => al.id !== id));
  }, []);

  const clear = useCallback(() => setAlerts([]), []);

  return (
    <AlertsCtx.Provider value={{ alerts, push, dismiss, clear }}>
      {children}
    </AlertsCtx.Provider>
  );
};

export function useAlerts(){
  const ctx = useContext(AlertsCtx);
  if(!ctx) throw new Error('useAlerts must be used within AlertsProvider');
  return ctx;
}

export const AlertsHost: React.FC = () => {
  const { alerts, dismiss } = useAlerts();
  if(!alerts.length) return null;
  return (
    <div className="player-alerts" role="region" aria-label="Notifications">
      {alerts.map(al => (
        <div key={al.id} className={`player-alert severity-${al.severity}`} role="alert">
          <div className="icon" aria-hidden="true">
            <span className="material-symbols-rounded">{al.severity === 'error' ? 'error' : (al.severity === 'warn' ? 'warning' : 'info')}</span>
          </div>
          <div className="msg">{al.msg}</div>
          <button className="close" aria-label="Dismiss notification" onClick={()=> dismiss(al.id)}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
      ))}
    </div>
  );
};
