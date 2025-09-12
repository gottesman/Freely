## Welcome to Freely!

This document provides a guide for AI coding agents to effectively contribute to the Freely codebase.

### Big Picture

Freely is a decentralized, peer-to-peer music player built with Tauri v2, React, and TypeScript. It's designed to be a web-first application with a focus on local-first data ownership and peer-to-peer streaming.

The application is composed of three main parts:

1.  **Tauri Main Process (`src-tauri/main.rs`)**: This is the entry point of the desktop application. It's responsible for creating the main browser window, handling native OS integrations, and managing the application's lifecycle. It also acts as a backend for the renderer process, handling tasks that require Node.js APIs, such as file system access and spawning child processes.

2.  **React Renderer Process (`src/`)**: This is the user interface of the application. It's a single-page application built with React and TypeScript, and it's responsible for rendering the UI and handling user interactions.

3.  **Main Server (`server/server.js`)**: This is a separate Node.js process that's responsible for handling the peer-to-peer and youtube search and streaming of music. It's bundled on build (dev and production), and then spawned by the main process and communicates with it through IPC.

### Developer Workflows

To get started with development, you'll need to have Node.js and npm installed. Once you've cloned the repository, you can install the dependencies and start the development server by running the following commands:

```bash
npm install
npm run dev
```

This will start a Vite development server for the React application but no Tauri application.

To build the application for development, you can use the following command:

```bash
npm run tauri dev
```

To build the application for production, you can use the following command:

```bash
npm run tauri build
```

To "test" the application after running npm run tauri dev, the localhost:5123 should never be open in a browser, as it is only for the Tauri app to use. So no web browser testing is needed neither expected.

This will create a distributable package for your operating system in the `build` directory.

### Project-Specific Conventions

*   **State Management**: The application uses a combination of React's built-in state management and a local-first database (sql.js) for storing user data. The database is managed by the `DBProvider` component, which provides a `useDB` hook for accessing the database.

*   **Styling**: The application uses a combination of CSS modules and a global stylesheet (`src/app.css`). The global stylesheet is used for defining the overall look and feel of the application, while CSS modules are used for styling individual components.

*   **API Integration**: The application integrates with the Genius and Spotify APIs for fetching music metadata. The API calls are made from the main process and exposed to the renderer process through the preload script. This is done to avoid exposing API keys to the renderer process.

### Key Files and Directories

*   `src/App.tsx`: The main application component.
*   `src/core/db.tsx`: The database provider and hook.
*   `src/core/playback.tsx`: The playback provider and hook (in frontend).
*   `src/core/i18n.tsx`: The locale language implementation.
*   `src/lang/*.json`: The languages files.
*   `server/server.js`: The main backend server source code.
*   `webpack.server.config.js`: Instructions for webpack to build the server bundle for Tauri.
*   `vite.config.ts`: The Vite configuration file.
*   `package.json`: The project's dependencies and scripts.

### Tauri

*   `src-tauri/src/playback.rs`: The playback backend using BASS for audio decoding.
*   `src-tauri/bin/*`: Libraries and binaries requiered for the app.
*   `src-tauri/tauri.conf.json`: The configuration file for the Tauri application.
*   `src-tauri/src/main.rs`: The main Rust file for the Tauri application.
*   `https://schema.tauri.app/config/2`: The schema for the Tauri configuration file.

### Commit Message Conventions

When making commits to the codebase, please follow these conventions for commit messages:
*   Use the present tense ("Add feature" not "Added feature").
*   Use the imperative mood ("Fix bug" not "Fixed bug" or "Fixes bug").
*   Limit the first line to 50 characters or less.
*   Make it easy to copy.

Styling and desing example for the message:

```
Release v0.11.6: Enhanced YouTube Integration, BASS Audio Engine, and Performance Optimizations

## 🚀 Major Features & Improvements

### YouTube Streaming Integration
- ✅ Fixed YouTube-DL spawn errors in production builds
- ✅ Implemented robust binary path detection for Windows AppData locations
- ✅ Added enhanced error handling and caching for YouTube video info retrieval
- ✅ Optimized YouTube metadata extraction with format preference support

### Audio Engine & Playback
- 🎵 Integrated BASS audio library for high-performance playback
- 🎚️ Added comprehensive audio settings UI components and controls
- 🔊 Implemented volume control, muting, and audio preferences persistence
- ⚡ Enhanced playback tracking with optimized polling and seek functionality

### Tauri Desktop Integration
- 🖥️ Improved Tauri configuration with proper resource bundling
- 📦 Enhanced build process with automatic binary fetching (YouTube-DL, BASS)
- 🔧 Fixed production build issues and resource path resolution
- 🎯 Optimized window management and native OS integrations

### Performance & Caching
- 🚀 Implemented multi-level caching system (memory + file-based)
- 📈 Enhanced Spotify API caching with persistent database storage
- ⚡ Optimized database operations for playlists and track management
- 🔄 Improved pub/sub logic for real-time UI updates

### User Experience Enhancements
- 🎨 Added context menu functionality with provider pattern
- 📱 Improved responsive design and panel management
- 🌍 Enhanced internationalization support with locale management
- 🎵 Better playlist management with drag-and-drop reordering

### Backend & Infrastructure
- 🔧 Fixed server endpoint routing issues in production builds
- 🌐 Enhanced WebTorrent integration with polyfills and file streaming
- 📊 Added comprehensive error handling and logging throughout
- 🛠️ Improved build scripts and development workflow

## 🐛 Bug Fixes
- Fixed "child is not defined" error in YouTube-DL execution
- Resolved spawn EFTYPE errors in Windows production builds
- Fixed splash screen FOUC (Flash of Unstyled Content)
- Corrected binary path detection for bundled resources

## 📦 Technical Improvements
- Migrated from download-based to bundle-based binary management
- Enhanced error handling with detailed spawn error reporting
- Improved file validation and permission checking
- Optimized memory usage with intelligent cache eviction

## 🔄 Breaking Changes
- Updated binary management approach (bundled vs downloaded)
- Modified YouTube-DL integration to use production-ready paths
- Enhanced Tauri configuration for better resource handling

This release significantly improves the stability and performance of the P2P music streaming application, with particular focus on YouTube integration and native desktop functionality.
```

## Coding Guidelines

When contributing to the Freely codebase, please follow these guidelines:
*   **Functionality**: Ensure that any new features or bug fixes are thoroughly tested and work as expected.
    Use the correct commands in terminal for testing the code:
```bash
npx tsc --noEmit
```
        for Typescript.

```bash
cargo clean --manifest-path src-tauri/Cargo.toml
```
        for Rust.
*   **Performance**: Write efficient code that minimizes resource usage and optimizes performance. Avoid unnecessary computations and memory allocations, as well as duplicated code. Before implementing helper functions, api's or event handlers look for an already implemented code that does that. If code is found and it needs something else, add the new functionality in the file where the code was found. Only refactor existing code to improve performance where applicable.
*   **Security**: Follow best practices for security, especially when handling user data or integrating with external APIs. Validate and sanitize all inputs, and avoid exposing sensitive information.
*   **Error Handling**: Implement robust error handling to gracefully handle unexpected situations. Use try-catch blocks where appropriate and provide meaningful error messages.
*   **Code Style**: Follow the existing code style and conventions used in the project. If the code style or conventions needs improving, ask before aplying those changes, and effectivley apply those new styles and conventions onto the rest of the project. Use Prettier for formatting and ESLint for linting.
*   **Documentation**: Write clear and concise comments for complex logic and functions. Update the documentation if you make changes that affect the functionality or usage of the code.
*   **Commit Messages**: Write meaningful commit messages that describe the changes made. Use the present tense and be concise.

### Directory of functions

Here is going to be a comprehensive directory of functions that can help use an already implemented code as a helper.

*   `runTauriCommand` in `src/core/tauriCommands.tsx`: Correctly runs a Tauri command from Rust.
*   `useI18n` in `src/core/i18n.tsx`: Creates a function that helps render the correct locale for the text in the UI. Usage:
```typescript
import { useI18n } from '/core/i18n'; /* Use the correct directory when implementing */
const { t } = useI18n();

function Main() {
    return t('test.Testing'); /* returns the correct text for "test.Testing" depending in the selected language in the app */
}

```

*   (not yet completed)