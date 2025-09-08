/**
 * Enhanced error handling middleware
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

  // Express error handling middleware
  static middleware() {
    return (err, req, res, next) => {
      console.error('Express error:', ErrorHandler.formatError(err));
      
      if (res.headersSent) {
        return next(err);
      }

      const status = err.status || err.statusCode || 500;
      res.status(status).json({
        error: err.message || 'Internal Server Error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
      });
    };
  }
}

module.exports = ErrorHandler;
