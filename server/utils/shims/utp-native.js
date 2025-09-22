// Shim for utp-native that works in Tauri packaged apps.
// In development, defer to the real module installed in node_modules.
// In production (Tauri bundle), load the .node binary from resources/prebuilds/<platform>-<arch>/node.napi.node

const path = require('path');
const fs = require('fs');

function loadFromResources() {
  const resPath = process.resourcesPath;
  if (!resPath) return null;

  const platform = process.platform; // 'win32' | 'linux' | 'darwin'
  const arch = process.arch; // 'x64', 'arm64', etc.
  const dir = `${platform}-${arch}`;
  const candidate = path.join(resPath, 'prebuilds', dir, 'node.napi.node');

  if (fs.existsSync(candidate)) {
    try {
      return require(candidate);
    } catch (e) {
      console.warn('[utp-native-shim] Failed to load prebuilt binary from resources:', e.message);
      return null;
    }
  }

  return null;
}

// Try resources first
const native = loadFromResources();
if (native) {
  module.exports = native;
} else {
  // Fallback to normal resolution during development
  module.exports = require('utp-native');
}
