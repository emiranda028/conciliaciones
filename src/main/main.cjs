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
// Capturas en modo oscuro (Ualá, Brubank: letra clara sobre fondo negro): el OCR pierde la letra
// gris ("Hoy 13:46") y confunde el "+". Se pasan a gris, se invierten y se estira el contraste.
function esOscura(px) {
  let suma = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4 * 97) {
    suma += 0.114 * px[i] + 0.587 * px[i + 1] + 0.299 * px[i + 2];
    n += 1;
  }
  return n > 0 && suma / n < 110;
}

function prepararImagen(buf, escala) {
  try {
    let img = nativeImage.createFromBuffer(buf);
    const { width } = img.getSize();
    if (!width) return { img: buf, oscura: false };
    // Al doble las chicas (celular, ~720 px); las que ya vienen grandes (~1350 px, letra grande)
    // solo un poco: al doble el OCR confunde 3/5 y 6/0 ("+3,000.00" -> "+5,000.00").
    const factor = escala ?? (width < 1100 ? 2 : width < 1400 ? 1.5 : 1);
    if (factor !== 1) img = img.resize({ width: Math.round(width * factor), quality: 'best' });
    const px = img.toBitmap(); // BGRA
    if (!esOscura(px)) return { img: factor !== 1 ? img.toPNG() : buf, oscura: false, factor };
    for (let i = 0; i < px.length; i += 4) {
      const v = 255 - (0.114 * px[i] + 0.587 * px[i + 1] + 0.299 * px[i + 2]);
      px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, (v - 60) * 1.4));
    }
    return { img: nativeImage.createFromBitmap(px, img.getSize()).toPNG(), oscura: true, factor };
  } catch {
    return { img: buf, oscura: false };
  }
}

ipcMain.handle('ocr:leer', async (_e, data) => {
  const w = await getOcr();
  const { img, oscura, factor } = prepararImagen(Buffer.from(data));
  const { data: d } = await w.recognize(img, {}, { blocks: true });
  const lines = lineasOcr(d);
  // AstroPay ("+3,000.00 ARS"): según el tamaño el OCR confunde 3/5 y 6/0 o pierde una fila.
  // Se lee también a otras dos escalas y el monto se decide por mayoría.
  if (lines.filter((l) => /\bARS\b/.test(l.text)).length >= 2 && factor) {
    const otras = [];
    for (const esc of [factor * 0.75, factor * 1.5]) {
      const p = prepararImagen(Buffer.from(data), esc);
      const { data: dx } = await w.recognize(p.img, {}, { blocks: true });
      otras.push(lineasOcr(dx));
    }
    return { lines, otrasEscalas: otras };
  }
  // Comprobantes (un movimiento por imagen, letra grande): una segunda lectura con
  // segmentación automática encuentra el monto que la lectura por bloque a veces saltea.
  const texto = lines.map((l) => l.text).join('\n');
  if (!/comprobante|origen y destino|de operaci/i.test(texto)) {
    // Capturas anchas de la compu (columnas separadas): una segunda lectura por palabras sueltas,
    // con su posición, para armar cada movimiento alrededor del monto.
    let ancha = false;
    try {
      const { width, height } = nativeImage.createFromBuffer(Buffer.from(data)).getSize();
      ancha = width > height * 1.25;
    } catch {
      /* sin tamaño: se queda con la primera lectura */
    }
    // También en modo oscuro (Ualá): el monto queda entre el nombre y la hora.
    if (!ancha && !oscura) return lines;
    try {
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const { data: d3 } = await w.recognize(img, {}, { blocks: true });
      return { lines, palabras: lineasOcr(d3) };
    } finally {
      await w.setParameters({ tessedit_pageseg_mode: '6' });
    }
  }
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
