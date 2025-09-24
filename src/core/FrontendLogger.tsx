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
    server: {
        script: string;
        pid_file: string;
        db_file: string;
    };
}

class FrontendLogger {
    private static instance: FrontendLogger;
    private pathConfig: PathConfig | null = null;
    private logQueue: LogEntry[] = [];
    private isInitialized = false;

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

    private async flushLogQueue(): Promise<void> {
        if (this.logQueue.length === 0) return;

        const queuedLogs = [...this.logQueue];
        this.logQueue = [];

        for (const entry of queuedLogs) {
            await this.writeLog(entry.level, entry.message);
        }
    }

    private async writeLog(level: LogLevel, message: string): Promise<void> {
        if (!this.isInitialized || !this.pathConfig) {
            // Queue the log for later
            this.logQueue.push({ level, message });
            return;
        }

        try {
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

            const logFile = level === 'error' || level === 'warn' 
                ? this.pathConfig.logs.frontend_errors
                : this.pathConfig.logs.frontend_logs;

            await runTauriCommand('write_to_log_file', {
                filePath: logFile,
                content: logEntry
            });
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    async log(level: LogLevel, message: string): Promise<void> {
        // Also log to console
        switch (level) {
            case 'error':
                console.error(`[FRONTEND] ${message}`);
                break;
            case 'warn':
                console.warn(`[FRONTEND] ${message}`);
                break;
            case 'info':
                console.info(`[FRONTEND] ${message}`);
                break;
            case 'debug':
                console.debug(`[FRONTEND] ${message}`);
                break;
        }

        await this.writeLog(level, message);
    }

    async info(message: string): Promise<void> {
        await this.log('info', message);
    }

    async warn(message: string): Promise<void> {
        await this.log('warn', message);
    }

    async error(message: string): Promise<void> {
        await this.log('error', message);
    }

    async debug(message: string): Promise<void> {
        await this.log('debug', message);
    }

    getPathConfig(): PathConfig | null {
        return this.pathConfig;
    }
}

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
    level: LogLevel;
    message: string;
}

// Global logger instance
export const frontendLogger = FrontendLogger.getInstance();

// Convenience functions
export const logInfo = (message: string) => frontendLogger.info(message);
export const logWarn = (message: string) => frontendLogger.warn(message);
export const logError = (message: string) => frontendLogger.error(message);
export const logDebug = (message: string) => frontendLogger.debug(message);

// Initialize logger when module is loaded
frontendLogger.init().catch(console.error);

export type { PathConfig };