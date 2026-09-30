// Genera build/ con el código empaquetado, minificado y ofuscado.
//   node scripts/build.mjs         -> producción (ofuscado)
//   node scripts/build.mjs --dev   -> sin ofuscar, con DevTools (CONCILIADOR_DEV=1)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build');
const dev = process.argv.includes('--dev');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });

// exceljs se carga como script aparte (window.ExcelJS) para no ofuscar 1 MB de librería.
const excelShim = {
  name: 'exceljs-global',
  setup(b) {
    b.onResolve({ filter: /^exceljs$/ }, () => ({ path: 'exceljs', namespace: 'shim' }));
    b.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: 'export default window.ExcelJS;', loader: 'js' }));
  },
};

await build({
  entryPoints: [path.join(root, 'src/renderer/app.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  outfile: path.join(out, 'app.js'),
  plugins: [excelShim],
});

for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join(root, 'src/renderer', f), path.join(out, f));
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8').replace(
  '<script src="app.js"></script>',
  '<script src="vendor/exceljs.min.js"></script>\n    <script src="app.js"></script>'
);
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync(path.join(root, 'node_modules/exceljs/dist/exceljs.min.js'), path.join(out, 'vendor/exceljs.min.js'));
for (const f of ['main.cjs', 'preload.cjs']) fs.copyFileSync(path.join(root, 'src/main', f), path.join(out, f));

if (!dev) {
  const opts = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    splitStrings: true,
    splitStringsChunkLength: 8,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  };
  for (const f of ['app.js', 'main.cjs', 'preload.cjs']) {
    const p = path.join(out, f);
    const code = fs.readFileSync(p, 'utf8');
    const res = JavaScriptObfuscator.obfuscate(code, { ...opts, target: f === 'app.js' ? 'browser' : 'node' });
    fs.writeFileSync(p, res.getObfuscatedCode());
  }
}

const size = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0) + ' KB';
console.log(`build/ listo (${dev ? 'desarrollo' : 'producción, ofuscado'}): app.js ${size('app.js')}, main.cjs ${size('main.cjs')}`);
