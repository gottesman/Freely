const fs = require('fs');
const path = require('path');

/**
 * Enhanced logging system
 */
class LogManager {
  static initialized = false;
  static originalMethods = {};

  static init(dataDir) {
    if (this.initialized) return;

    try {
      // Use environment variables if provided by Tauri, fallback to dataDir
      const LOG_FILE = process.env.FREELY_SERVER_LOGS || path.join(dataDir, 'server_logs.txt');
      const ERR_FILE = process.env.FREELY_SERVER_ERRORS || path.join(dataDir, 'server_errors.txt');
      
      // Ensure directories exist
      const logDir = path.dirname(LOG_FILE);
      const errDir = path.dirname(ERR_FILE);
      
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      if (logDir !== errDir && !fs.existsSync(errDir)) {
        fs.mkdirSync(errDir, { recursive: true });
      }
      
      const outStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
      const errStream = fs.createWriteStream(ERR_FILE, { flags: 'a' });
      
      // Store original methods
      this.originalMethods = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error
      };

      const writeLog = (stream, level, args) => {
        const timestamp = new Date().toISOString();
        const formattedArgs = args.map(this.formatError).join(' ');
        const line = `[${timestamp}] [${level}] ${formattedArgs}\n`;
        stream.write(line);
      };

      // Override console methods
      console.log = (...args) => {
        writeLog(outStream, 'LOG', args);
        this.originalMethods.log(...args);
      };

      console.info = (...args) => {
        writeLog(outStream, 'INFO', args);
        this.originalMethods.info(...args);
      };

      console.warn = (...args) => {
        writeLog(errStream, 'WARN', args);
        this.originalMethods.warn(...args);
      };

      console.error = (...args) => {
        writeLog(errStream, 'ERROR', args);
        this.originalMethods.error(...args);
      };

      // Cleanup on exit
      process.on('exit', () => {
        try { outStream.end(); } catch (_) {}
        try { errStream.end(); } catch (_) {}
      });

      this.initialized = true;
      console.log('[LogManager] File logging initialized');

    } catch (e) {
      console.error('File logging init failed:', e.message);
    }
  }

  static formatError(error) {
    if (error instanceof Error) return error.stack || error.message;
    if (typeof error === 'object') {
      try { 
        return JSON.stringify(error); 
      } catch (_) { 
        return String(error); 
      }
    }
    return String(error);
  }

  static restore() {
    if (!this.initialized) return;

    // Restore original console methods
    console.log = this.originalMethods.log;
    console.info = this.originalMethods.info;
    console.warn = this.originalMethods.warn;
    console.error = this.originalMethods.error;

    this.initialized = false;
    console.log('[LogManager] Restored original console methods');
  }
}

module.exports = LogManager;
