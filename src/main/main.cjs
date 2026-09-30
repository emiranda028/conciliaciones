// Proceso principal de Electron: ventana, archivos y configuración local.
// La app no usa red: cualquier pedido http/https se bloquea.
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DEV = process.env.CONCILIADOR_DEV === '1';

// En la versión portable (pendrive) los datos quedan junto al .exe.
function dataDir() {
  const base = process.env.PORTABLE_EXECUTABLE_DIR;
  if (base) {
    const dir = path.join(base, 'ConciliadorDatos');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // pendrive protegido contra escritura: usar la carpeta del usuario
    }
  }
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const configPath = () => path.join(dataDir(), 'configuracion.json');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'Conciliador de Fichas',
    backgroundColor: '#f4f6f9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: DEV,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith('file:') || details.url.startsWith('devtools:') || details.url.startsWith('data:');
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  if (!DEV) Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('config:load', () => {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('config:save', (_e, data) => {
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, configPath());
  return true;
});

ipcMain.handle('config:dir', () => dataDir());

ipcMain.handle('file:save', async (e, { defaultName, data, filters }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return r.filePath;
});

ipcMain.handle('file:open', async (e, { filters }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), data: fs.readFileSync(p) };
});
