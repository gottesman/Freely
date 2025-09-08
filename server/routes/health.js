const express = require('express');
const router = express.Router();

/**
 * Root endpoint - API overview
 */
router.get('/', (req, res) => {
  console.log('Received root request');
  res.json({
    name: 'Freely Server',
    description: 'Peer-to-peer music streaming server',
    version: '2.0.0',
    status: 'running',
    timestamp: Date.now(),
    uptime: process.uptime(),
    endpoints: {
      health: 'GET /ping',
      search: 'GET /api/source-search?title=<title>&artist=<artist>&type=<torrents|youtube>',
      youtube: 'GET /source/youtube?url=<youtube_url>',
      torrent: {
        seed: 'POST /seed',
        stream: 'GET /stream/:infoHash',
        status: 'GET /status/:infoHash'
      }
    }
  });
});

/**
 * Health check endpoint
 */
router.get('/ping', (req, res) => {
  console.log('Received ping request');
  res.json({ 
    pong: true, 
    timestamp: Date.now(),
    uptime: process.uptime(),
    version: process.version
  });
});

module.exports = router;
