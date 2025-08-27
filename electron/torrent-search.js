// Minimal torrent search helpers for Electron main process
let scrapers = null;
try {
  // require the precompiled CommonJS artifact produced by `npm run build:scrapers`
  // compiled output lives at dist-electron/torrent-search.js (root of dist-electron)
  scrapers = require('../dist-electron/torrent-search');
} catch (e) {
  throw new Error('Centralized scrapers module not found. Run `npm run build:scrapers` to compile the scrapers before starting Electron. Original error: ' + (e && e.message));
}

if (!scrapers || (typeof scrapers.listScrapers !== 'function' && typeof scrapers.listScrapers !== 'object')) {
  throw new Error('Centralized scrapers module is malformed. Ensure `dist-electron/src/core/torrent-search` exports listScrapers/searchAll.');
}

// Delegate to centralized scrapers
function listScrapers() {
  return scrapers.listScrapers();
}

async function search(opts) {
  if (typeof scrapers.searchAll === 'function') return scrapers.searchAll(opts);
  throw new Error('Centralized scrapers module does not export search/searchAll');
}

// Export: prefer external module's functions when available; otherwise export local functions
module.exports = { listScrapers, search };
