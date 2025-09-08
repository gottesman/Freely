const fs = require('fs');
const path = require('path');
const { SERVER_CONSTANTS } = require('../config/constants');

/**
 * Enhanced error handling for server
 */
class ErrorHandler {
  static setupGlobalHandlers() {
    process.on('unhandledRejection', (reason, promise) => {
      try {
        console.warn('Unhandled Rejection at:', promise, 'reason:', 
                     reason && reason.stack ? reason.stack : reason);
      } catch (e) { /* ignore */ }
    });

    process.on('uncaughtException', (err) => {
      try {
        console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
      } catch (e) { /* ignore */ }
    });
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

  static middleware(err, req, res, next) {
    console.error('Express error:', ErrorHandler.formatError(err));
    
    if (res.headersSent) {
      return next(err);
    }

    const statusCode = err.statusCode || err.status || 500;
    const message = err.message || 'Internal Server Error';

    res.status(statusCode).json({
      success: false,
      error: message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
  }
}

module.exports = ErrorHandler;
