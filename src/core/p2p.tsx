// Thin shim: use local torrent server for seeding/streaming.
// This file preserves the exports used elsewhere but exposes
// a minimal HTTP-based API to seed files and get stream URLs.

export const PROTOCOL = 'torrent/http';
export const BOOTSTRAP_PEERS: string[] = [];

/**
 * createNode() kept for API compatibility. In this torrent-backed
 * flow it does not create a libp2p node; instead it returns a small
 * object with helper methods that mirror what the app expects.
 */
export async function createNode() {
  return {
    // seedFile: POST to /seed on local torrent server. Accepts FormData
    seedFile: async (file: File | Blob) => {
      const fd = new FormData();
      fd.append('file', file as any, (file as any).name || 'upload.bin');
      const resp = await fetch('http://localhost:9000/seed', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error('Failed to seed file');
      return resp.json();
    },
    // getStreamUrl: returns the local HTTP stream URL for an infoHash
    getStreamUrl: (infoHash: string) => `http://localhost:9000/stream/${infoHash}`,
    // a no-op handler placeholder so Player code calling node.handle/node.unhandle doesn't break
    handle: () => {},
    unhandle: () => {},
    // include a fake peerId for compatibility; consumer should not rely on libp2p PeerId methods
    peerId: { toString: () => 'torrent-local' },
  } as any;
}