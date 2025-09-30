# Freely — decentralized, P2P music player

<p align="center">
	<img src="public/icon-192.png" alt="Freely splash screen" width="192" />
</p>

> ⚠️ Work In Progress: Freely is under active development and may break or be unstable at any time. Features can change without notice.

**Freely** is an experimental music player focused on **peer-to-peer streaming** and **local-first data ownership**.

The idea: stream music directly from other peers, work offline, and carry your playlists, favorites, and settings anywhere.

## Highlights

* **P2P-first streaming** — play music from LAN or WebRTC peers.
* **Local-first** — your data stays with you; export/import anytime.
* **Multi-format** — MP3, FLAC, WAV, OGG, AAC, etc.
* **Customizable UI** — themes, plugins, small-screen mode.
* **Cross-platform** — desktop and mobile.

## Current Status

🚧 Active WIP — core P2P transport, local DB, and desktop app via Tauri v2 are in place. Daily development focuses on stability, source reliability, and UX polish.

What to expect today:
- Search and play from multiple sources (YouTube, torrents, HTTP) with local caching
- A desktop-first Tauri app (no standalone web build)
- Basic playlists and playback controls using a native audio backend

Known gaps (being worked on): robust multi-source downloads, modding APIs, richsync lyrics performance, proxy settings, and better UX.

Tip: After starting the app in dev mode, do not open the dev server URL in a browser; it’s reserved for the Tauri window.

## Usage

1) Launch the desktop app (see Quick start below)
2) Search for a song/artist
3) In results, open “Sources” and pick a source (YouTube/torrent/HTTP)
4) Click Play to stream or Download to cache locally (downloads panel shows progress)
5) Manage playback via the bottom player; tracks are cached for faster replays

### Development

Freely targets Tauri v2 for native desktop builds.

Quick start (dev):

```bash
npm install
npm run tauri dev
```

Production build:

```bash
npm install
npm run tauri:build
```

Notes:
- Tauri requires a Rust toolchain and platform-specific dependencies: https://tauri.app/start/prerequisites
- Tauri config: `src-tauri/tauri.conf.json`; Rust main: `src-tauri/src/main.rs`

### Environment Setup

Create a local `.env` by copying the provided example and then edit values:

```bash
# Windows PowerShell
Copy-Item .env.example .env

# macOS/Linux
cp .env.example .env
```

Environment variables in the renderer are resolved via `src/core/AccessEnv.tsx`:
- You can override defaults with `VITE_*` variables (e.g., `VITE_SPOTIFY_TOKEN_ENDPOINT`)
- Tauri/Rust may also read OS-level envs (e.g., `SPOTIFY_TOKEN_ENDPOINT`) directly
- Keep secrets out of the renderer; prefer external endpoints (see Spotify section)

Key variables:
- `SPOTIFY_TOKEN_ENDPOINT` or `VITE_SPOTIFY_TOKEN_ENDPOINT` — URL of your Cloudflare Worker for Spotify tokens
- `CHARTS_SPOTIFY_ENDPOINT` or `VITE_CHARTS_SPOTIFY_ENDPOINT` — URL for Spotify charts proxy
- `GENIUS_ENDPOINT` or `VITE_GENIUS_ENDPOINT` — URL for Genius proxy

### Development Commands

- `npm run tauri dev` — Run the app in development (recommended)
- `npm run typecheck` — TypeScript type checking
- `npm run build:server` — Build the Node.js server bundle
- `npm run fetch:bass` — Download/update BASS audio libraries

### Testing

The project includes several testing and validation approaches:

#### Type Checking
```bash
npm run typecheck
# or directly:
npx tsc --noEmit
```

#### CSS Validation
Validate styles with Stylelint:
```bash
npm run lint:css
# or directly:
npx stylelint "src/**/*.css"
```

Configuration is in `.stylelintrc.cjs` following standard CSS rules.

## Building

### Development Build
```bash
npm run build
```
Creates optimized frontend build and server bundle.

### Production Build
```bash
npm run build:optimized
```
Production-optimized build with environment variables.

### Tauri Desktop App

**Development:**
```bash
npm run tauri dev
```

**Production Build:**
```bash
npm run tauri:build
```

**Release Build:**
```bash
npm run tauri:build:release
```

### Build Requirements

- **Node.js** 18+ and npm
- **Rust toolchain** (for Tauri builds)
- **Platform dependencies** (see [Tauri prerequisites](https://tauri.app/start/prerequisites))

### Build Outputs

| Build Type | Output Location | Description |
|------------|----------------|-------------|
| Frontend | `dist/` | Vite-built React app |
| Server | `src-tauri/server-dist/` | Bundled Node.js server |
| Desktop | `src-tauri/target/` | Native executables |

### Troubleshooting Builds

**Missing binaries:** Run dependency fetchers:
```bash
npm run fetch:ytdlp
npm run fetch:bass
```

**Type errors:** Check with `npm run typecheck`

**Rust compilation issues:** Ensure Rust toolchain is updated:
```bash
rustup update
```

### Spotify API (optional)

Freely can use Spotify for richer metadata (public data only). The recommended approach is to use an external token endpoint so your Spotify client secret never resides on your machine.

#### External Token Endpoint (recommended)

Set up a tiny Cloudflare Worker that performs the Client Credentials exchange and returns only `{ access_token, expires_in }`. The app will call this endpoint from the Tauri/server side and never handle your secret directly.

Worker example (`src/index.js` in your Worker project):

```js
export default {
	async fetch(req, env) {
		const basic = btoa(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET);
		const r = await fetch('https://accounts.spotify.com/api/token', {
			method: 'POST',
			headers: {
				'Authorization': 'Basic ' + basic,
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: 'grant_type=client_credentials'
		});
		if (!r.ok) {
			return new Response(JSON.stringify({ error: 'spotify_http_' + r.status }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		}
		const j = await r.json();
		return new Response(JSON.stringify({ access_token: j.access_token, expires_in: j.expires_in }), {
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public,max-age=240' }
		});
	}
}
```

Deploy steps:
1. `npm install -g wrangler`
2. `wrangler init freely-spotify-token --no-open --type=javascript`
3. Replace generated `src/index.js` with the example above
4. Set secrets:
	 - `wrangler secret put SPOTIFY_CLIENT_ID`
	 - `wrangler secret put SPOTIFY_CLIENT_SECRET`
5. `wrangler deploy`
6. Copy the deployed URL and set it in your local `.env` as:
	 - `SPOTIFY_TOKEN_ENDPOINT=https://your-worker-subdomain.workers.dev`

App configuration:
- The app reads `SPOTIFY_TOKEN_ENDPOINT` from environment variables and uses it to request an app access token when needed.
- No Spotify secrets are bundled in the renderer.
- For development, the app runs without Spotify if the endpoint is not configured.

## Roadmap / TODO

- Achieve a reliable way to download from different sources (YouTube/torrent/HTTP)
- Implement modding capabilities (plugins/themeable UI with sandboxing)
- Improve performance with richsync lyrics
- Improve overall UX and error handling
- Implement proxy settings
- Editable/custom covers for playlists (optionally generate mosaics from track art)
- Avoid app not working when installed in a custom disk/folder
- Better streaming reliability (chunk hashing, multi-peer fetch)
- More language options
- Mobile build & WebRTC fixes

### Long-term (far future)

- Multi-platform releases: Windows, Linux, and Android
	- Windows: stable installers and auto-update flow
	- Linux: packaging targets (AppImage/.deb/.rpm) and distro testing
	- Android: explore Tauri Mobile or alternative runtime for a mobile build

## Known limitations

- WIP: Expect unstable behavior and breaking changes
- Source reliability varies; downloads may intermittently fail
- Richsync lyrics can be heavy; performance optimizations are ongoing
- Proxy settings not yet implemented
- Some environments may fail when installed to custom locations; this is being addressed

## Why?

I couldn’t find a music player that was P2P, plugin-friendly, customizable, and truly local. So I built one.

---

**License:** MIT

This is a prototype. Expect breaking changes and rough edges.
