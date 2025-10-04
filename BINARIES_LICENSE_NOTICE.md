## BASS Runtime Notice

This project downloads and bundles the BASS audio library (c) Un4seen Developments.

Website: http://www.un4seen.com/

License summary:
* Free for non-commercial use. A separate license is required for commercial distribution.
* See the official BASS license for full terms; this file is informational only.

You are responsible for ensuring your use of BASS complies with its license.

Fetch script: `npm run fetch:bass` (downloads platform zip and extracts the shared library into `src-tauri/bin/`).

## YtDlp Runtime Notice

This project downloads and bundles the YtDlp binary for YouTube integration.

Github: https://github.com/yt-dlp/yt-dlp

License summary:
* Unlicense license that allows anyone to copy, modify, publish, use, compile, sell, or
distribute the software.

Fetch script: `npm run fetch:ytdlp` (downloads platform executable into `src-tauri/bin/`).

## librqbit / librqbit-core Runtime Notice

This project integrates the Rust BitTorrent client library `librqbit` (and related crates) to provide torrent session management, piece scheduling, streaming support, and protocol handling (DHT, PEX, uTP, IPv6, BEP extensions, etc.).

Upstream Repository: https://github.com/ikatson/rqbit

License: Apache License 2.0

License summary (non-exhaustive, refer to full text):
* Permissive license allowing use, modification, distribution, and sublicensing
* Requires preservation of copyright & license notice in redistributions
* Provides express patent grant from contributors
* Distributed on an "AS IS" basis without warranties or conditions

We do not redistribute a modified version at this time; integration is via compiled crates. If this changes, NOTICE updates will follow.

You are responsible for reviewing the upstream LICENSE for full compliance obligations.

