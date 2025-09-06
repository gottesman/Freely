#!/usr/bin/env node
/**
 * Fetch the yt-dlp binary into src-tauri/bin so it's packaged as a Tauri resource.
 * Idempotent: skips download if binary already exists and --force not passed.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const force = process.argv.includes('--force');
const platform = process.platform; // win32, darwin, linux
const binDir = path.join(__dirname, '..', 'src-tauri', 'bin');
if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

const binName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const dest = path.join(binDir, binName);

if (fs.existsSync(dest) && !force) {
  const size = fs.statSync(dest).size;
  if (size > 1000000) { // >1MB assume valid
    console.log('[fetch-ytdlp] existing binary present, skipping. Use --force to re-download.');
    process.exit(0);
  }
}

// Official latest direct download URL
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binName}`;
console.log('[fetch-ytdlp] downloading', url);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      try { fs.unlinkSync(dest); } catch(_){}
      reject(err);
    });
  });
}

download(url, dest)
  .then(() => {
    try { if (platform !== 'win32') fs.chmodSync(dest, 0o755); } catch(_){}
    console.log('[fetch-ytdlp] downloaded to', dest);
  })
  .catch(err => {
    console.error('[fetch-ytdlp] failed', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
