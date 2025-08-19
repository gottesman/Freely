import React, { createContext, useCallback, useContext, useState } from 'react';

export type AlertSeverity = 'info' | 'warn' | 'error';
export interface AlertItem { id: string; msg: string; severity: AlertSeverity; }

interface AlertsCtxValue {
  alerts: AlertItem[];
  push: (msg: string, severity?: AlertSeverity, meta?: any) => void;
  dismiss: (id: string) => void;
  clear: () => void;
  addLogListener: (fn: (entry: LogEntry) => void) => () => void;
}

export interface LogEntry { ts:number; source:string; msg:string; severity:AlertSeverity; meta?:any }

const AlertsCtx = createContext<AlertsCtxValue | undefined>(undefined);

export const AlertsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const logListenersRef = React.useRef<((e:LogEntry)=>void)[]>([]);

  const emitLog = useCallback((entry: LogEntry) => {
    for (const fn of logListenersRef.current) {
      try { fn(entry); } catch(_){}
    }
  }, []);

  const push = useCallback((msg: string, severity: AlertSeverity = 'info', meta?: any) => {
    if(!msg) return;
    const id = Date.now().toString(36)+Math.random().toString(36).slice(2,7);
    setAlerts(a => [...a, { id, msg, severity }]);
    emitLog({ ts: Date.now(), source:'alert', msg, severity, meta });
  }, [emitLog]);

  const dismiss = useCallback((id: string) => {
    setAlerts(a => a.filter(al => al.id !== id));
  }, []);

  const clear = useCallback(() => setAlerts([]), []);

  const addLogListener = useCallback((fn: (e:LogEntry)=>void) => {
    logListenersRef.current.push(fn);
    return () => { logListenersRef.current = logListenersRef.current.filter(f => f!==fn); };
  }, []);

  return (
    <AlertsCtx.Provider value={{ alerts, push, dismiss, clear, addLogListener }}>
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
