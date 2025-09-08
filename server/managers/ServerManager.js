const express = require('express');
const path = require('path');
const { SERVER_CONSTANTS } = require('../config/constants');
const PidManager = require('./PidManager');
const LogManager = require('./LogManager');
const ErrorHandler = require('./ErrorHandler');

/**
 * Server lifecycle management
 */
class ServerManager {
  constructor(app, dataDir) {
    this.app = app;
    this.server = null;
    this.dataDir = dataDir || path.join(__dirname, '..', 'data');
    this.pidManager = new PidManager(this.dataDir);
    
    // Initialize logging and error handling
    LogManager.init(this.dataDir);
    ErrorHandler.setupGlobalHandlers();
  }

  async startServer(port = SERVER_CONSTANTS.PORTS.DEFAULT, maxAttempts = SERVER_CONSTANTS.PORTS.RETRY_ATTEMPTS) {
    // Ensure any previous server is terminated
    try {
      await this.pidManager.ensureNoExistingServer();
    } catch (e) {
      console.warn('[ServerManager] Error while ensuring no existing server:', e.message);
    }

    return new Promise((resolve, reject) => {
      const attemptListen = (currentPort, attemptsLeft) => {
        try {
          this.server = this.app.listen(currentPort, () => {
            console.log(`🚀 Server listening on http://localhost:${currentPort}`);
            this.pidManager.writePidInfo(currentPort);
            resolve(currentPort);
          });

          this.server.on('error', (err) => {
            if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
              console.warn(`[ServerManager] Port ${currentPort} in use, trying ${currentPort + 1}...`);
              setTimeout(() => {
                attemptListen(currentPort + 1, attemptsLeft - 1);
              }, SERVER_CONSTANTS.PORTS.RETRY_DELAY);
            } else {
              console.error('[ServerManager] Server listen error:', err.message);
              reject(err);
            }
          });
        } catch (e) {
          reject(e);
        }
      };

      attemptListen(port, maxAttempts);
    });
  }

  gracefulShutdown() {
    console.log('[ServerManager] Shutting down server...');
    
    this.pidManager.cleanup();
    
    if (this.server) {
      this.server.close(() => {
        console.log('[ServerManager] Server closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  }

  setupShutdownHandlers() {
    process.on('SIGINT', () => this.gracefulShutdown());
    process.on('SIGTERM', () => this.gracefulShutdown());
    process.on('exit', () => {
      this.pidManager.cleanup();
    });
  }
}

module.exports = ServerManager;
