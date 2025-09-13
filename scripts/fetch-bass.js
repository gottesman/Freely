#!/usr/bin/env node
/**
 * Fetch the appropriate BASS audio library and plugins for the current platform.
 * BASS is (c) Un4seen Developments. See license: http://www.un4seen.com/.
 * This helper downloads the official zips, extracts only the needed shared libraries
 * into `src-tauri/bin/` so Tauri can bundle them (already listed in resources).
 *
 * Env vars:
 *   FREELY_FORCE_BASS=1   Force re-download even if libraries already present.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'
const ARCH = process.arch; // e.g. x64, arm64
const BIN_DIR = path.join(__dirname, '..', 'src-tauri', 'bin');
fs.mkdirSync(BIN_DIR, { recursive: true });

const FORCE = process.env.FREELY_FORCE_BASS === '1';

// Version pin (update when upstream updates)
const VERSION = '24'; // corresponds to 2.4

// Define all libraries to download: main BASS + plugins
const LIBRARIES = {
  bass: {
    name: 'BASS Core',
    urls: {
      win32: `https://www.un4seen.com/files/bass${VERSION}.zip`,
      darwin: `https://www.un4seen.com/files/bass${VERSION}-osx.zip`,
      linux: `https://www.un4seen.com/files/bass${VERSION}-linux.zip`
    },
    files: {
      win32: 'bass.dll',
      darwin: 'libbass.dylib', 
      linux: 'libbass.so'
    }
  },
  bassflac: {
    name: 'BASS FLAC Plugin',
    urls: {
      win32: `https://www.un4seen.com/files/bassflac${VERSION}.zip`,
      darwin: `https://www.un4seen.com/files/bassflac${VERSION}-osx.zip`,
      linux: `https://www.un4seen.com/files/bassflac${VERSION}-linux.zip`
    },
    files: {
      win32: 'bassflac.dll',
      darwin: 'libbassflac.dylib',
      linux: 'libbassflac.so'
    }
  },
  bassopus: {
    name: 'BASS Opus Plugin',
    urls: {
      win32: `https://www.un4seen.com/files/bassopus${VERSION}.zip`,
      darwin: `https://www.un4seen.com/files/bassopus${VERSION}-osx.zip`, 
      linux: `https://www.un4seen.com/files/bassopus${VERSION}-linux.zip`
    },
    files: {
      win32: 'bassopus.dll',
      darwin: 'libbassopus.dylib',
      linux: 'libbassopus.so'
    }
  },
  basshls: {
    name: 'BASS HLS Plugin',
    urls: {
      win32: `https://www.un4seen.com/files/basshls${VERSION}.zip`,
      darwin: `https://www.un4seen.com/files/basshls${VERSION}-osx.zip`,
      linux: `https://www.un4seen.com/files//basshls${VERSION}-linux.zip`
    },
    files: {
      win32: 'basshls.dll',
      darwin: 'libbasshls.dylib',
      linux: 'libbasshls.so'
    }
  },
  bass_aac: {
    name: 'BASS AAC Plugin',
    urls: {
      win32: `https://www.un4seen.com/files/z/2/bass_aac${VERSION}.zip`,
      darwin: `https://www.un4seen.com/files/z/2/bass_aac${VERSION}-osx.zip`,
      linux: `https://www.un4seen.com/files/z/2/bass_aac${VERSION}-linux.zip`
    },
    files: {
      win32: 'bass_aac.dll',
      darwin: 'libbass_aac.dylib',
      linux: 'libbass_aac.so'
    }
  }
};

// Check if we need to download anything
let needsDownload = FORCE;
if (!needsDownload) {
  console.log('[bass] Checking existing files...');
  for (const [key, lib] of Object.entries(LIBRARIES)) {
    const targetFile = lib.files[PLATFORM];
    const targetPath = path.join(BIN_DIR, targetFile);
    const exists = fs.existsSync(targetPath);
    console.log(`[bass] ${targetFile}: ${exists ? 'EXISTS' : 'MISSING'}`);
    if (!exists) {
      needsDownload = true;
    }
  }
}

if (!needsDownload) {
  console.log(`[bass] All libraries already present (set FREELY_FORCE_BASS=1 to re-fetch)`);
  process.exit(0);
}

function download(url) {
  return new Promise((resolve, reject) => {
    console.log('[bass] Downloading', url);
    https.get(url, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(download(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => resolve(Buffer.concat(bufs)));
    }).on('error', reject);
  });
}

async function downloadLibrary(key, lib) {
  const url = lib.urls[PLATFORM];
  const targetFile = lib.files[PLATFORM];
  const targetPath = path.join(BIN_DIR, targetFile);

  if (!url) {
    console.log(`[bass] Skipping ${lib.name} - not available for platform:`, PLATFORM);
    return;
  }

  console.log(`[bass] Fetching ${lib.name}...`);
  
  try {
    const buf = await download(url);
    console.log(`[bass] Downloaded ${lib.name}:`, (buf.length/1024).toFixed(1), 'KB');
    
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    let picked = null;
    
    // Try to pick entry matching arch first (linux zips contain multiple e.g. x64/ or arm/)
    const archHints = ARCH === 'x64' ? ['x64', 'amd64'] : ARCH === 'arm64' ? ['aarch64','arm64'] : [];
    for (const e of entries) {
      const name = path.basename(e.entryName);
      if (name.toLowerCase() === targetFile.toLowerCase()) {
        if (archHints.length === 0 || archHints.some(h => e.entryName.toLowerCase().includes(h))) {
          picked = e; break;
        }
        // fallback candidate
        if (!picked) picked = e;
      }
    }
    
    if (!picked) {
      console.error(`[bass] Could not locate ${targetFile} inside ${lib.name} archive. Entries:`);
      entries.slice(0,10).forEach(e => console.log(' -', e.entryName));
      return;
    }
    
    fs.writeFileSync(targetPath, picked.getData());
    if (PLATFORM !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }
    console.log(`[bass] Installed ${lib.name} ->`, targetPath);
  } catch (e) {
    console.error(`[bass] Failed to download ${lib.name}:`, e.message);
  }
}

(async () => {
  try {
    console.log('[bass] Starting download of BASS libraries and plugins...');
    
    // Download all libraries
    for (const [key, lib] of Object.entries(LIBRARIES)) {
      await downloadLibrary(key, lib);
    }
    
    console.log('[bass] Download complete!');
    console.log('[bass] NOTE: BASS is proprietary; ensure license compliance for your usage.');
  } catch (e) {
    console.error('[bass] Failed:', e.message);
    process.exit(1);
  }
})();
