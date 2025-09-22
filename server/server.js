const path = require('path');
const express = require('express');

// Import managers
const ServerManager = require('./managers/ServerManager');
const ErrorHandler = require('./managers/ErrorHandler');
const { initSearchCache, persistSearchCacheSync } = require('./utils');

// Import middleware
const corsMiddleware = require('./middleware/cors');

// Import routes
const healthRoutes = require('./routes/health');
const { getWebTorrentDiagnostics, isWebTorrentAvailable } = require('./utils/webtorrent-loader');
const searchRoutes = require('./routes/search');
const youtubeRoutes = require('./routes/youtube');
const torrentRoutes = require('./routes/torrent');
const torrentFilesRoutes = require('./routes/torrentFiles');

// Import configuration
const { CONFIG } = require('./config/constants');

// Create Express app
const app = express();

// Initialize global error handling
ErrorHandler.setupGlobalHandlers();

// Setup middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(corsMiddleware());

// Add request logging for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Lightweight diagnostics endpoint
app.get('/api/diagnostics/webtorrent', async (req, res) => {
  const available = await isWebTorrentAvailable().catch(() => false);
  res.json({
    success: true,
    available,
    ...getWebTorrentDiagnostics()
  });
});

// Initialize search cache
const dataDir = path.join(__dirname, 'data');
initSearchCache(dataDir);

// Setup routes
app.use('/', healthRoutes);                    // GET /ping
app.use('/api', searchRoutes);                 // GET /api/source-search
app.use('/api', torrentFilesRoutes);           // GET /api/torrent-files/:id
app.use('/source', youtubeRoutes);             // GET /source/youtube
app.use('/', torrentRoutes);                   // POST /seed, GET /stream, etc.

// Error handling middleware (must be last)
app.use(ErrorHandler.middleware);

// Create server manager
const serverManager = new ServerManager(app, dataDir);

// Setup graceful shutdown
function gracefulShutdown() {
  console.log('[Main] Shutting down server...');
  
  try {
    persistSearchCacheSync();
  } catch (_) { /* ignore */ }
  
  serverManager.gracefulShutdown();
}

// Setup shutdown handlers
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('exit', () => {
  try {
    persistSearchCacheSync();
  } catch (_) { /* ignore */ }
});

// Start the server
const PORT = process.env.PORT || CONFIG.DEFAULT_PORT;
serverManager.startServer(PORT)
  .then((port) => {
    console.log(`🎵 Freely Server (Modular) started successfully`);
    console.log(`🚀 Listening on: http://localhost:${port}`);
    console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📂 Routes loaded:`);
    console.log(`   • Health: GET /ping`);
    console.log(`   • Search: GET /api/source-search`);
    console.log(`   • Torrent Files: GET /api/torrent-files/:id`);
    console.log(`   • YouTube: GET /source/youtube`);
    console.log(`   • Torrents: POST /seed, GET /stream, GET /status`);
  })
  .catch((error) => {
    console.error('[Main] Failed to start server:', error.message);
    process.exit(1);
  });

module.exports = app;
