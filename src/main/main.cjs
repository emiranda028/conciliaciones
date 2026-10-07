// Proceso principal de Electron: ventana, archivos y configuración local.
// La app no usa red: cualquier pedido http/https se bloquea.
const { app, BrowserWindow, ipcMain, dialog, session, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DEV = process.env.CONCILIADOR_DEV === '1';

// Sin tráfico de fondo de Chromium (actualización de componentes, chequeos de red, etc.).
for (const sw of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'no-pings']) {
  app.commandLine.appendSwitch(sw);
}

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

// OCR de capturas de pantalla (Tesseract, español), todo local: el idioma viaja con la app.
// Las librerías van fuera del asar (asarUnpack) para que el worker thread pueda cargarlas.
let ocrWorker = null;
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

async function getOcr() {
  if (ocrWorker) return ocrWorker;
  const { createWorker } = require('tesseract.js');
  const tjsDir = unpacked(path.dirname(require.resolve('tesseract.js/package.json')));
  const langPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tessdata')
    : path.join(path.dirname(require.resolve('@tesseract.js-data/spa/package.json')), '4.0.0_best_int');
  ocrWorker = await createWorker('spa', 1, {
    langPath,
    cacheMethod: 'none',
    gzip: true,
    workerPath: path.join(tjsDir, 'src', 'worker-script', 'node', 'index.js'),
  });
  return ocrWorker;
}

// Las capturas de celular suelen tener letra chica: al doble de tamaño el OCR confunde
// mucho menos el "$" con un 5 o un 8.
function prepararImagen(buf) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    const { width } = img.getSize();
    if (!width || width >= 1400) return buf;
    return img.resize({ width: width * 2, quality: 'best' }).toPNG();
  } catch {
    return buf;
  }
}

ipcMain.handle('ocr:leer', async (_e, data) => {
  const w = await getOcr();
  const img = prepararImagen(Buffer.from(data));
  const { data: d } = await w.recognize(img, {}, { blocks: true });
  const lines = lineasOcr(d);
  // Comprobantes (un movimiento por imagen, letra grande): una segunda lectura con
  // segmentación automática encuentra el monto que la lectura por bloque a veces saltea.
  const texto = lines.map((l) => l.text).join('\n');
  if (!/comprobante|origen y destino|de operaci/i.test(texto)) return lines;
  try {
    await w.setParameters({ tessedit_pageseg_mode: '3' });
    const { data: d2 } = await w.recognize(img, {}, { blocks: true });
    return { lines, lines2: lineasOcr(d2) };
  } finally {
    await w.setParameters({ tessedit_pageseg_mode: '6' });
  }
});

function lineasOcr(d) {
  return (d.blocks || []).flatMap((b) =>
    b.paragraphs.flatMap((p) =>
      p.lines.map((l) => ({
        text: l.text,
        confidence: l.confidence,
        bbox: l.bbox,
        words: l.words.map((x) => ({ text: x.text, bbox: x.bbox, confidence: x.confidence })),
      }))
    )
  );
}

app.on('before-quit', () => {
  if (ocrWorker) ocrWorker.terminate().catch(() => {});
});

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
