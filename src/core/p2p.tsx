import { createLibp2p, Libp2p } from 'libp2p';
import { yamux } from '@chainsafe/libp2p-yamux';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { bootstrap } from '@libp2p/bootstrap';

// Protocol name for our music streaming application
export const PROTOCOL = '/freely-player/1.0.0';

// Public bootstrap servers for peer discovery
const BOOTSTRAP_PEERS = [
  '/dns4/wrtc-star1.par.dwebops.pub/tcp/443/wss/p2p/12D3KooWSoL6WTbwv6XzbpYPSh15By9362ADdUS2U1asNuiJTeea',
  '/dns4/wrtc-star2.sjc.dwebops.pub/tcp/443/wss/p2p/12D3KooW9xgV71GqK2rV3g44UncF9AFGNYmcDoILTfxA3a5dKZT8',
];

export async function createNode(): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: {
      listen: [
        '/dns4/wrtc-star1.par.dwebops.pub/tcp/443/wss/p2p-webrtc-star',
        '/dns4/wrtc-star2.sjc.dwebops.pub/tcp/443/wss/p2p-webrtc-star',
      ],
    },
  transports: [webSockets(), webRTC()],
  // cast to any to avoid type incompatibilities between different libp2p package copies
  connectionEncryption: [noise() as any],
    streamMuxers: [yamux()], // UPDATED to use yamux
    peerDiscovery: [
      bootstrap({
        list: BOOTSTRAP_PEERS,
      }) as any,
    ],
  });

  await node.start();
  console.log('libp2p node started with Peer ID:', node.peerId.toString());
  return node;
}