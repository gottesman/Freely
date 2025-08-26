const fs = require('fs');
const path = require('path');

// Copy webtorrent browser bundle into public/vendor/webtorrent.min.js
(async function(){
  try {
    const src = path.join(__dirname, '..', 'node_modules', 'webtorrent', 'webtorrent.min.js');
    const destDir = path.join(__dirname, '..', 'public', 'vendor');
    const dest = path.join(destDir, 'webtorrent.min.js');
    if (!fs.existsSync(src)) {
      console.warn('[vendor-webtorrent] webtorrent.min.js not found in node_modules; skipping vendor step');
      return;
    }
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    console.log('[vendor-webtorrent] copied webtorrent.min.js to public/vendor');
  } catch (e) {
    console.error('[vendor-webtorrent] failed', e && e.message ? e.message : e);
    process.exitCode = 1;
  }
})();
