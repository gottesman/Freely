const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const WebTorrent = require('webtorrent');

const upload = multer({ dest: path.join(__dirname, 'uploads') });
const client = new WebTorrent();
const app = express();
const PORT = process.env.PORT || 9000;

// Simple in-memory map of infoHash -> { torrent, mimeType, name }
const torrents = new Map();

const trackers = [
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.opentrackr.org:1337',
  'udp://tracker.leechers-paradise.org:6969',
  'udp://tracker.coppersurfer.tk:6969',
  'wss://tracker.btorrent.xyz',
];

app.post('/seed', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const filePath = req.file.path;
  const mimeType = req.file.mimetype || 'application/octet-stream';
  const originalName = req.file.originalname || req.file.filename;
  console.log('Seeding file at', filePath, 'mime:', mimeType);

  client.seed(
    filePath,
    { announce: trackers },
    (torrent) => {
      console.log('Seeding torrent:', torrent.infoHash);
      torrents.set(torrent.infoHash, { torrent, mimeType, name: originalName });
      res.json({
        infoHash: torrent.infoHash,
        magnetURI: torrent.magnetURI,
        streamUrl: `/stream/${torrent.infoHash}`,
        mimeType,
        name: originalName,
      });
    }
  );
});

app.get('/stream/:infoHash', async (req, res) => {
  const infoHash = req.params.infoHash;
  const torrent = client.get(infoHash) || torrents.get(infoHash);
  if (!torrent) return res.status(404).end('Torrent not found');

  // Use the first file in the torrent for streaming
  const file = torrent.files[0];
  if (!file) return res.status(404).end('No file in torrent');

  // Wait until file length / pieces available
  const waitForReady = () =>
    new Promise((resolve) => {
      if (file.length) return resolve();
      torrent.on('ready', resolve);
    });

  await waitForReady();

  const range = req.headers.range;
  let start = 0;
  let end = file.length - 1;
  if (range) {
    const matches = /bytes=(\d+)-(\d+)?/.exec(range);
    if (matches) {
      start = parseInt(matches[1], 10);
      if (matches[2]) end = parseInt(matches[2], 10);
    }
  }

  // Try to read stored mimeType for this torrent
  const stored = torrents.get(infoHash);
  const mimeTypeHeader = stored?.mimeType || 'application/octet-stream';

  res.status(range ? 206 : 200);
  res.set({
    'Content-Type': mimeTypeHeader,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${file.length}`,
  });

  const stream = file.createReadStream({ start, end });
  stream.pipe(res);

  res.on('close', () => {
    try { stream.destroy(); } catch (e) {}
  });
});

app.get('/status/:infoHash', (req, res) => {
  const infoHash = req.params.infoHash;
  const stored = torrents.get(infoHash);
  if (!stored) return res.status(404).json({ error: 'not found' });
  const { torrent, mimeType, name } = stored;
  res.json({
    infoHash: torrent.infoHash,
    magnetURI: torrent.magnetURI,
    name,
    mimeType,
    progress: torrent.progress || 0,
    numPeers: torrent.numPeers || 0,
  });
});

app.listen(PORT, () => {
  console.log(`Torrent server listening on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down torrent server...');
  client.destroy(() => process.exit(0));
});
