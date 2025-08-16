import React, { useEffect, useRef, useState } from 'react';
import { chunkArrayBuffer } from '../core/chunker';
import { createNode, PROTOCOL } from '../core/p2p';
import type { Libp2p } from 'libp2p';

export default function Player() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);

  const [node, setNode] = useState<Libp2p | null>(null);
  const [status, setStatus] = useState('Offline');
  const [peerId, setPeerId] = useState<string>('');
  const [remotePeerId, setRemotePeerId] = useState<string>('');

  // Effect to initialize and manage the libp2p node
  useEffect(() => {
    if (!node) return;

    const handleIncomingStream = async ({ stream }: { stream: any }) => {
      // stream typing is `any` to avoid depending on @libp2p/interface-stream-muxer types
      console.log('Incoming stream from', stream.remotePeer?.toString?.());
      setStatus(`Receiving file from ${stream.remotePeer.toString().slice(-6)}...`);
      
      let receivedFirstChunk = false;
      for await (const chunk of stream.source) {
        const data = chunk.subarray();
        if (!receivedFirstChunk) {
          // 1. First chunk is metadata (MIME type)
          const metadata = JSON.parse(new TextDecoder().decode(data));
          console.log('Received metadata:', metadata);
          setupMediaSource(metadata.mimeType);
          receivedFirstChunk = true;
        } else {
          // 2. Subsequent chunks are audio data
          appendChunk(data.buffer);
        }
      }
    };
    
    node.handle(PROTOCOL, handleIncomingStream);

    return () => {
      node.unhandle(PROTOCOL);
    };
  }, [node]);

  const startNode = async () => {
    setStatus('Starting node...');
    const libp2pNode = await createNode();
    setNode(libp2pNode);
    setPeerId(libp2pNode.peerId.toString());
    setStatus('Node online');
  };
  
  const setupMediaSource = (mimeType: string) => {
    if (!MediaSource.isTypeSupported(mimeType)) {
      setStatus(`Error: MIME type not supported: ${mimeType}`);
      return;
    }
    
    const ms = new MediaSource();
    mediaSourceRef.current = ms;
    if (audioRef.current) {
      audioRef.current.src = URL.createObjectURL(ms);
    }
    
    ms.addEventListener('sourceopen', () => {
      const sb = ms.addSourceBuffer(mimeType);
      sourceBufferRef.current = sb;
    }, { once: true });
  };
  
  const appendChunk = (chunk: ArrayBuffer) => {
    const sb = sourceBufferRef.current;
    if (sb && !sb.updating) {
      try {
        sb.appendBuffer(chunk);
      } catch (e) {
        console.error('Error appending buffer:', e);
      }
    }
  };

  const handleFileSend = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !node || !remotePeerId) {
      alert('Please start the node and enter a remote peer ID.');
      return;
    }

    setStatus(`Connecting to ${remotePeerId.slice(-6)}...`);
    try {
  // dialProtocol accepts PeerId | Multiaddr | Multiaddr[] at runtime; cast to any to satisfy TS
  const stream = await node.dialProtocol(remotePeerId as any, PROTOCOL);
      setStatus('Connected. Sending file...');

      // 1. Send metadata first
      const metadata = JSON.stringify({ mimeType: file.type || 'application/octet-stream', name: file.name });
      await stream.sink([new TextEncoder().encode(metadata)]);
      
      // 2. Stream file chunks
      const fileBuffer = await file.arrayBuffer();
      const chunks = chunkArrayBuffer(fileBuffer, 256 * 1024);
      
      for (const chunk of chunks) {
        await stream.sink([new Uint8Array(chunk)]);
        // A small delay can help with flow control on some networks
        await new Promise(res => setTimeout(res, 20)); 
      }
      
      await stream.close();
      setStatus('File sent successfully!');
    } catch (err: any) {
      console.error('Failed to send file:', err);
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div>
      {!node ? (
        <button className="btn" onClick={startNode}>Start P2P Node</button>
      ) : (
        <div>
          <strong>Your Peer ID:</strong>
          <pre style={{ overflowWrap: 'break-word', fontSize: 12 }}>{peerId}</pre>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <input
          type="text"
          placeholder="Remote Peer ID to connect to"
          onChange={(e) => setRemotePeerId(e.target.value)}
          style={{ width: '100%', padding: 8 }}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <input type="file" accept="audio/*" onChange={handleFileSend} />
      </div>
      <div style={{ marginTop: 12 }}>
        <audio ref={audioRef} controls autoPlay style={{ width: '100%' }}></audio>
      </div>
      <div style={{ marginTop: 12 }}>
        <div>Status: <strong>{status}</strong></div>
      </div>
    </div>
  );
}