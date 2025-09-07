# Scripts Directory

This directory contains utility scripts for the Freely Player project.

## update-version.js

Automatically updates the version number across all project files.

### Usage

```bash
# Using npm script (recommended)
npm run version:update 1.0.0

# Or directly with node
node scripts/update-version.js 1.0.0
```

### What it updates

- `package.json` - Main Node.js project version
- `src-tauri/Cargo.toml` - Rust/Tauri package version
- `src-tauri/tauri.conf.json` - Tauri configuration version
- `src/core/accessEnv.tsx` - User agent string
- `src/core/musicdata.tsx` - User agent string

### After running

1. Run `npm install` to update `package-lock.json`
2. Commit all the changed files together

### Example

```bash
# Update to version 1.0.0
npm run version:update 1.0.0

# Update package-lock.json
npm install

# Commit changes
git add .
git commit -m "chore: bump version to 1.0.0"
```

## fetch-ytdlp.js

Downloads the latest yt-dlp binary for YouTube integration.

### Usage

```bash
npm run fetch:ytdlp
```

This script is automatically run before dev and build commands.
