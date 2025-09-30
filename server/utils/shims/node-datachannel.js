// Shim for node-datachannel that gracefully handles missing native dependencies
// In development, try to use the real module if available
// In production (Tauri bundle), provide a fallback that doesn't crash

const path = require('path');
const fs = require('fs');

function loadFromResources() {
  // In a Tauri bundle, try to load from resources if available
  const resPath = process.resourcesPath;
  if (!resPath) return null;

  const platform = process.platform; // 'win32' | 'linux' | 'darwin'
  const arch = process.arch; // 'x64', 'arm64', etc.
  const dir = `${platform}-${arch}`;
  
  // Try to find node-datachannel in various possible locations
  const candidates = [
    path.join(resPath, 'node-datachannel', 'prebuilds', dir, 'node.napi.node'),
    path.join(resPath, 'prebuilds', 'node-datachannel', dir, 'node.napi.node'),
    path.join(resPath, 'node_modules', 'node-datachannel', 'prebuilds', dir, 'node.napi.node')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        return require(candidate);
      } catch (e) {
        console.warn('[node-datachannel-shim] Failed to load prebuilt binary from resources:', e.message);
      }
    }
  }

  return null;
}

// Attempt to load the native module
let nativeModule = null;

try {
  // First try to load from resources (Tauri bundle)
  nativeModule = loadFromResources();
  
  if (!nativeModule) {
    // Fallback to normal resolution during development
    nativeModule = require('node-datachannel');
  }
} catch (error) {
  // If node-datachannel is not available, provide a minimal shim
  console.warn('[node-datachannel-shim] Native module not available, using fallback');
  
  // Provide a minimal API that doesn't crash WebTorrent
  nativeModule = {
    // Minimal DataChannel implementation that does nothing
    DataChannel: class DataChannel {
      constructor() {
        console.warn('[node-datachannel-shim] DataChannel created but will not function');
      }
      
      close() {}
      send() { return false; }
      onOpen() {}
      onClosed() {}
      onError() {}
      onMessage() {}
    },
    
    // Minimal PeerConnection implementation
    PeerConnection: class PeerConnection {
      constructor() {
        console.warn('[node-datachannel-shim] PeerConnection created but will not function');
      }
      
      close() {}
      createDataChannel() { 
        return new nativeModule.DataChannel(); 
      }
      setLocalDescription() {}
      setRemoteDescription() {}
      addIceCandidate() {}
      onStateChange() {}
      onGatheringStateChange() {}
      onLocalDescription() {}
      onLocalCandidate() {}
      onDataChannel() {}
    }
  };
}

module.exports = nativeModule;