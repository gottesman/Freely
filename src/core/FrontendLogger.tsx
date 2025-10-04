import { runTauriCommand } from './TauriCommands';

interface PathConfig {
    app_data_dir: string;
    app_log_dir: string;
    app_config_dir: string;
    resource_dir: string;
    torrents_dir: string;
    youtube_dir: string;
    audio_cache_dir: string;
    logs: {
        backend_logs: string;
        backend_errors: string;
        frontend_logs: string;
        frontend_errors: string;
        server_logs: string;
        server_errors: string;
    };
}

class FrontendLogger {
    private static instance: FrontendLogger;
    private pathConfig: PathConfig | null = null;
    private logQueue: LogEntry[] = [];
    private isInitialized = false;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private isFlushing = false;
    private lastEntry: { key: string; count: number } | null = null;

    // Tuning knobs – adjust if needed
    private readonly FLUSH_INTERVAL_MS = 500; // batch interval
    private readonly MAX_QUEUE = 2000; // hard cap to avoid unbounded memory / message spam
    private readonly MAX_BATCH = 200; // per flush write size

    private constructor() {}

    static getInstance(): FrontendLogger {
        if (!FrontendLogger.instance) {
            FrontendLogger.instance = new FrontendLogger();
        }
        return FrontendLogger.instance;
    }

    async init(): Promise<void> {
        try {
            const configJson = await runTauriCommand<string>('get_path_config');
            if (typeof configJson === 'string') {
                this.pathConfig = JSON.parse(configJson);
                this.isInitialized = true;

                // Process queued logs
                await this.flushLogQueue();

                this.log('info', 'Frontend logger initialized');
            }
        } catch (error) {
            console.error('Failed to initialize frontend logger:', error);
        }
    }

    private async flushLogQueue(force = false): Promise<void> {
        if (this.isFlushing) return; // prevent concurrent flushes
        if (!force && this.logQueue.length === 0) return;
        if (!this.isInitialized || !this.pathConfig) return; // can't flush yet

        this.isFlushing = true;
        try {
            const batch = this.logQueue.splice(0, this.MAX_BATCH);
            if (batch.length === 0) return;

            const timestamped = batch.map(entry => {
                const ts = new Date(entry.timestamp).toISOString();
                return `[${ts}] [${entry.level.toUpperCase()}] ${entry.message}`;
            });

            const byFile: Record<string, string[]> = {};
            for (const line of timestamped) {
                // Decide file based on embedded level token in line
                const isErrorOrWarn = /\[ERROR\]|\[WARN\]/.test(line);
                const target = isErrorOrWarn ? this.pathConfig.logs.frontend_errors : this.pathConfig.logs.frontend_logs;
                (byFile[target] ||= []).push(line);
            }

            // Perform minimal IPC calls – one per target file used in this batch
            for (const [file, lines] of Object.entries(byFile)) {
                const content = lines.join('\n') + '\n';
                try {
                    await runTauriCommand('write_to_log_file', { filePath: file, content });
                } catch (err) {
                    console.error('Failed to write batched log file:', err);
                }
            }
        } finally {
            this.isFlushing = false;
            // If more logs arrived during flush, schedule another soon
            if (this.logQueue.length > 0) this.scheduleFlush();
        }
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return; // already scheduled
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flushLogQueue();
        }, this.FLUSH_INTERVAL_MS);
    }

    private async enqueueLog(level: LogLevel, message: string): Promise<void> {
        const key = `${level}:${message}`;
        const now = Date.now();

        // Collapse repeats to reduce spam
        if (this.lastEntry && this.lastEntry.key === key) {
            this.lastEntry.count++;
            // Update last queued message suffix
            const last = this.logQueue[this.logQueue.length - 1];
            if (last) {
                last.message = `${message} (x${this.lastEntry.count})`;
            }
        } else {
            this.lastEntry = { key, count: 1 };
            this.logQueue.push({ level, message, timestamp: now });
        }

        // Apply queue size limits w/ backpressure (drop oldest low priority logs first)
        if (this.logQueue.length > this.MAX_QUEUE) {
            // Remove oldest non-error first
            for (let i = 0; i < this.logQueue.length && this.logQueue.length > this.MAX_QUEUE; i++) {
                if (this.logQueue[i].level !== 'error') {
                    this.logQueue.splice(i, 1);
                    i--;
                }
            }
            // If still too big, trim head
            while (this.logQueue.length > this.MAX_QUEUE) this.logQueue.shift();
        }

        // Schedule a flush; force immediate flush for high severity bursts
        if (level === 'error') {
            void this.flushLogQueue(true);
        } else {
            this.scheduleFlush();
        }

        // If initialized and queue is large, proactively flush
        if (this.isInitialized && this.logQueue.length >= this.MAX_BATCH) {
            void this.flushLogQueue();
        }
    }

    async innerlog(level: LogLevel, message: string, ...optionalParams: any[]): Promise<void> {
        // Format message with optional params (stringify sparsely)
        if (optionalParams.length) {
            const formattedExtras = optionalParams.map(p => {
                try { return typeof p === 'string' ? p : JSON.stringify(p); } catch { return '[Unserializable]'; }
            }).join(' ');
            message = `${message} ${formattedExtras}`.trim();
        }

        switch (level) {
            case 'error':
                console.error('[FRONTEND]', message);
                break;
            case 'warn':
                console.warn('[FRONTEND]', message);
                break;
            case 'info':
            case 'log':
                console.log('[FRONTEND]', message);
                break;
            case 'debug':
                // Use debug; if user has disabled debug this is inexpensive
                console.debug('[FRONTEND]', message);
                break;
        }

        // Do not await to avoid backpressure on hot paths
        void this.enqueueLog(level, message);
    }

    async log(message: string, ...optionalParams: any[]): Promise<void> {
        await this.innerlog('log', message, ...optionalParams);
    }

    async info(message: string, ...optionalParams: any[]): Promise<void> {
        await this.innerlog('info', message, ...optionalParams);
    }

    async warn(message: string, ...optionalParams: any[]): Promise<void> {
        await this.innerlog('warn', message, ...optionalParams);
    }

    async error(message: string, ...optionalParams: any[]): Promise<void> {
        await this.innerlog('error', message, ...optionalParams);
    }

    async debug(message: string, ...optionalParams: any[]): Promise<void> {
        await this.innerlog('debug', message, ...optionalParams);
    }

    getPathConfig(): PathConfig | null {
        return this.pathConfig;
    }
}

type LogLevel = 'log' |'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: number; // epoch ms for consistent batching
}

// Global logger instance
export const frontendLogger = FrontendLogger.getInstance();

// Initialize logger when module is loaded
frontendLogger.init().catch(console.error);

export type { PathConfig };