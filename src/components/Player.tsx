import React, { useEffect, useRef, useState } from 'react';
import { chunkArrayBuffer } from '../core/chunker';
import { createNode, PROTOCOL, BOOTSTRAP_PEERS } from '../core/p2p';

export default function Player() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);

  const [node, setNode] = useState<any | null>(null);
  const [status, setStatus] = useState('Offline');
  const [peerId, setPeerId] = useState<string>('');
  const [remotePeerId, setRemotePeerId] = useState<string>('');
  const [magnetURI, setMagnetURI] = useState<string | null>(null);
  const [torrentName, setTorrentName] = useState<string | null>(null);
  const [torrentMime, setTorrentMime] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);

  useEffect(() => {}, [node]);

  const startNode = async () => {
    setStatus('Starting node...');
    const p2pNode = await createNode();
    setNode(p2pNode);
    setPeerId(p2pNode.peerId.toString());
    setStatus('Node online');
  };

  // Poll torrent status when we have a magnet/infoHash
  useEffect(() => {
    let timer: any;
    if (!magnetURI) return;
    const infoHash = magnetURI.split(':').pop();
    const poll = async () => {
      try {
        const resp = await fetch(`http://localhost:9000/status/${infoHash}`);
        if (!resp.ok) return;
        const data = await resp.json();
        setProgress(Math.round((data.progress || 0) * 100));
      } catch (e) {}
    };
    poll();
    timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [magnetURI]);
  
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
    if (!file || !node) {
      alert('Please start the node before sending a file.');
      return;
    }

    setStatus('Uploading and seeding...');
    try {
      const result = await node.seedFile(file);
      const streamUrl = node.getStreamUrl(result.infoHash);
      setMagnetURI(result.magnetURI);
      setTorrentName(result.name || file.name);
      setTorrentMime(result.mimeType || file.type || 'application/octet-stream');
      setStatus('Seeding. Playing...');
      if (audioRef.current) {
        audioRef.current.src = streamUrl;
        await audioRef.current.play();
      }
      setStatus('Playing from torrent stream');
    } catch (err: any) {
      console.error('Failed to seed file:', err);
      setStatus(`Error: ${err?.message || err}`);
    }
  };

  return (
    <div>
      {!node ? (
        <button className="btn" onClick={startNode}>Start Node</button>
      ) : (
        <div>
          <strong>Local Node:</strong>
          <pre style={{ overflowWrap: 'break-word', fontSize: 12 }}>{peerId}</pre>
        </div>
      )}
      {magnetURI && (
        <div style={{ marginTop: 12 }}>
          <div><strong>Magnet:</strong> <small style={{ wordBreak: 'break-all' }}>{magnetURI}</small></div>
          <div><strong>Name:</strong> {torrentName}</div>
          <div><strong>MIME:</strong> {torrentMime}</div>
          <div><strong>Progress:</strong> {progress}%</div>
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