#!/usr/bin/env node
const WebTorrent = require('webtorrent');
const id = process.argv[2];
const timeoutMs = parseInt(process.argv[3] || '20000', 10);
if (!id) {
  console.error('missing id');
  process.exit(2);
}

const client = new WebTorrent();
let timedOut = false;
const tid = setTimeout(() => { timedOut = true; console.error('timeout'); try { client.destroy(() => process.exit(2)); } catch (_) { process.exit(2); } }, timeoutMs);

function finishExit(code, obj) {
  clearTimeout(tid);
  if (obj !== undefined) {
    try { console.log(JSON.stringify(obj)); } catch (e) { console.error('json error', e); }
  }
  try { client.destroy(() => process.exit(code)); } catch (_) { process.exit(code); }
}

try {
  client.add(id, { destroyStoreOnDestroy: true }, (torrent) => {
    if (timedOut) return;
    const files = (torrent.files || []).map(f => ({ name: f.name, length: f.length }));
    finishExit(0, files);
  });
} catch (e) {
  if (!timedOut) {
    console.error('error', e && e.message ? e.message : e);
    finishExit(3);
  }
}
