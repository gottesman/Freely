const fs = require('fs');
const path = require('path');
const { SERVER_CONSTANTS } = require('../config/constants');

/**
 * Enhanced PID management for server lifecycle
 */
class PidManager {
  constructor(dataDir) {
    this.pidFile = process.env.PID_FILE_PATH || path.join(dataDir || __dirname, '.server.pid');
    console.log(`[PidManager] Using PID file path: ${this.pidFile}`);
  }

  readPidInfo() {
    try {
      if (!fs.existsSync(this.pidFile)) return null;
      const raw = fs.readFileSync(this.pidFile, 'utf8');
      return JSON.parse(raw || 'null');
    } catch (e) {
      return null;
    }
  }

  async killProcess(pid) {
    if (!pid) return false;
    
    try { 
      process.kill(pid, 0); 
    } catch { 
      return false; 
    }

    const signals = ['SIGINT', 'SIGTERM', 'SIGKILL'];
    for (const signal of signals) {
      try {
        process.kill(pid, signal);
      } catch (_) { /* ignore */ }

      // Wait for process to terminate
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try {
          process.kill(pid, 0);
        } catch {
          return true; // Process terminated
        }
      }
    }

    // Final check
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  async ensureNoExistingServer() {
    const info = this.readPidInfo();
    if (!info || !info.pid) return;

    try {
      const killed = await this.killProcess(info.pid);
      if (killed) {
        console.log(`[PidManager] Previous server (pid ${info.pid}) terminated.`);
      } else {
        console.warn(`[PidManager] Previous server (pid ${info.pid}) did not terminate.`);
      }
    } catch (e) {
      console.warn('[PidManager] Error terminating previous server pid:', e.message);
    }

    try {
      fs.unlinkSync(this.pidFile);
    } catch (_) { /* ignore */ }
  }

  writePidInfo(port) {
    try {
      const pidDir = path.dirname(this.pidFile);
      if (!fs.existsSync(pidDir)) {
        fs.mkdirSync(pidDir, { recursive: true });
      }

      const info = {
        pid: process.pid,
        port: port,
        startedAt: Date.now(),
        version: process.version,
        platform: process.platform
      };

      fs.writeFileSync(this.pidFile, JSON.stringify(info, null, 2), { encoding: 'utf8' });
      console.log(`[PidManager] Successfully wrote PID info to: ${this.pidFile}`);
    } catch (e) {
      console.error(`[PidManager] CRITICAL: Failed to write PID file to ${this.pidFile}`);
      console.error(e);
    }
  }

  cleanup() {
    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
        console.log('[PidManager] Cleaned up PID file');
      }
    } catch (_) { /* ignore */ }
  }
}

module.exports = PidManager;
