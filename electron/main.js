const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 200,
    minHeight: 200,
  frame: false, // we'll draw our own titlebar
  transparent: true,
    resizable: true,
  // use fully transparent background so CSS rounded corners render as transparent
  backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Resolve index.html differently when packaged vs dev
  let indexHtml;
  if (app.isPackaged) {
    // packaged resources live in process.resourcesPath
    indexHtml = path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html');
    if (!fs.existsSync(indexHtml)) {
      // fallback to unpacked area if present
      indexHtml = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'index.html');
    }
  } else {
    indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
  }

  const { pathToFileURL } = require('url');
  mainWindow.loadURL(pathToFileURL(indexHtml).href);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // forward maximize/unmaximize events to renderer so UI can update
  mainWindow.on('maximize', () => {
    try { mainWindow.webContents.send('window:maximized', true) } catch (e) {}
  });
  mainWindow.on('unmaximize', () => {
    try { mainWindow.webContents.send('window:maximized', false) } catch (e) {}
  });

  // Also monitor resize to detect user dragging to restore from snapped/maximized states.
  let _maxNotifyTimer = null
  const notifyMaxState = () => {
    try {
      const isMax = mainWindow.isMaximized()
      mainWindow.webContents.send('window:maximized', !!isMax)
    } catch (e) {}
  }
  const scheduleNotify = () => {
    if (_maxNotifyTimer) clearTimeout(_maxNotifyTimer)
    _maxNotifyTimer = setTimeout(() => { _maxNotifyTimer = null; notifyMaxState() }, 60)
  }

  mainWindow.on('resize', scheduleNotify);
  // 'move' fires while dragging on many platforms — use it to detect restore-via-drag
  mainWindow.on('move', scheduleNotify);
}

app.whenReady().then(() => {
  // Start the local torrent server as a child process.
  // When packaged we expect the server JS to be unpacked (app.asar.unpacked/server/...)
  let serverPath;
  const serverRel = path.join('server', 'torrent-server.js');
  if (app.isPackaged) {
    // Prefer unpacked server (executable outside asar)
    serverPath = path.join(process.resourcesPath, 'app.asar.unpacked', serverRel);
    if (!fs.existsSync(serverPath)) {
      // fallback: try inside asar (not ideal for spawning)
      serverPath = path.join(process.resourcesPath, 'app.asar', serverRel);
    }
  } else {
    serverPath = path.join(__dirname, '..', 'server', 'torrent-server.js');
  }

  try {
    serverProcess = spawn(process.execPath, [serverPath], {
      stdio: 'inherit',
      cwd: path.dirname(serverPath),
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start server process:', err);
    });

    serverProcess.on('exit', (code, signal) => {
      console.log('Server process exited', code, signal);
      serverProcess = null;
    });
  } catch (e) {
    console.error('Error spawning server process', e);
  }

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

const { ipcMain } = require('electron');

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.on('window:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window:maximize', () => {
  if (mainWindow) mainWindow.maximize();
});

ipcMain.on('window:restore', () => {
  if (mainWindow) {
    // restore from maximized state
    if (typeof mainWindow.unmaximize === 'function') mainWindow.unmaximize();
    else mainWindow.restore();
  }
});

ipcMain.on('window:close', () => {
  if (mainWindow) mainWindow.close();
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch (e) {}
  }
  if (process.platform !== 'darwin') app.quit();
});
