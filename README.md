# Freely — decentralized, P2P music player

**Freely** is an experimental, web-first music player focused on **peer-to-peer streaming** and **local-first data ownership**.

The idea: stream music directly from other peers, work offline, and carry your playlists, favorites, and settings anywhere.

## Highlights

* **P2P-first streaming** — play music from LAN or WebRTC peers.
* **Local-first** — your data stays with you; export/import anytime.
* **Multi-format** — MP3, FLAC, WAV, OGG, AAC.
* **Customizable UI** — themes, plugins, small-screen mode.
* **Cross-platform** — web, desktop, mobile.

## Current Status

✨ **Prototype** — core P2P transport, local DB, basic UI.
Missing: advanced buffering, robust chunking, polished UX.

## How to Run (Dev)

```bash
npm install
npm run dev
```

## Desktop build (Electron)

This project can be packaged as a Windows executable using Electron + electron-builder.

Developer quick-run (recommended):

```powershell
npm install
npm run start-torrent-server   # start local torrent server
npx electron .                 # run electron from npx (no global install)
```

To create a Windows installer (.exe / NSIS):

```powershell
npm run build
npx electron-builder --win --x64
```

Note: electron-builder will download Electron binaries. Ensure you have network access and enough disk space.

## Roadmap

1. Better streaming reliability (chunk hashing, multi-peer fetch)
2. Native SQLite for desktop
3. IndexedDB option for web
4. Plugin manager & sandboxing
5. Mobile polish & WebRTC fixes

## Why?

I couldn’t find a music player that was P2P, plugin-friendly, customizable, and truly local. So I built one.

---

**License:** MIT

*This is a prototype. Expect breaking changes and rough edges.*
