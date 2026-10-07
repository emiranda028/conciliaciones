// Prueba de humo de la app empaquetada: abre el ejecutable, carga un panel y una
// billetera de ejemplo (datos inventados), concilia y verifica el resultado.
//   node scripts/smoke-electron.mjs <ruta al ejecutable o a electron>
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.argv[2];
if (!exe) throw new Error('Uso: node scripts/smoke-electron.mjs <ejecutable>');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conciliador-'));

const bets = [
  'Transaction Group Id,Transaction ID,ID,Date,Amount,Notes,Transaction Type,Owner Type,Wallet Type,Before,After,Owner ID,Owner Name,User ID,UserName,Associated Transaction ID,Associated Transaction Time,Associated Transaction Type',
  '1,11,101,"21.09.2026 10:02:00.000",1000.00000000,Player deposit from balance,PlayerDepositFromBalance,Player,Balance,0,0,5,juan123,9,AgenteFB1,,,',
  '1,11,102,"21.09.2026 10:02:00.000",-1000.00000000,Player deposit from balance,PlayerDepositFromBalance,Agent,Balance,0,0,9,AgenteFB1,9,AgenteFB1,,,',
  '2,12,103,"21.09.2026 11:00:00.000",-5000.00000000,Player withdrawal to balance,PlayerWithdrawalToBalance,Player,Balance,0,0,6,ana456,9,AgenteFB1,,,',
  '2,12,104,"21.09.2026 11:00:00.000",5000.00000000,Player withdrawal to balance,PlayerWithdrawalToBalance,Agent,Balance,0,0,9,AgenteFB1,9,AgenteFB1,,,',
].join('\n');
const cash = [
  'ID Interno,ID Externo,Cuenta,Usuario,Monto,Moneda,Dirección,Canal,Estado,Tipo,Concepto,Fecha,Código COELSA,Nombre Remitente,CBU Remitente,CUIT Remitente,CBU Destinatario,CUIT Destinatario,Nombre Destinatario,Fee,Fee cobrado,Tipo de fee,Fee plataforma',
  'a1,E1,SUC 1,caja,1000,ARS,Entrante,Externo,Hecha,inbound,,"21/09/2026, 10:00:30",,Juan Perez,,,,,EMPRESA,,,,',
  'a2,S1,SUC 1,caja,5000,ARS,Saliente,Externo,Hecha,outbound,,"21/09/2026, 11:03:00",,EMPRESA,,,,,Ana Gomez,,,,',
].join('\n');
fs.writeFileSync(path.join(dir, 'panel.csv'), bets);
fs.writeFileSync(path.join(dir, 'billetera.csv'), cash);

const isElectronDev = /electron(\.exe)?$/i.test(path.basename(exe)) && !/Conciliador/i.test(exe);
const app = await electron.launch({
  executablePath: exe,
  args: [...(isElectronDev ? [path.resolve('.')] : []), ...(process.env.SMOKE_EXTRA_ARGS || '').split(' ').filter(Boolean)],
  env: { ...process.env, PORTABLE_EXECUTABLE_DIR: dir },
  timeout: 90000,
});
const fail = (m) => {
  console.error('FALLÓ:', m);
  process.exitCode = 1;
};
try {
  const win = await app.firstWindow();
  await win.waitForSelector('#nav button', { timeout: 60000 });
  if ((await win.title()) !== 'Conciliador de Fichas') fail('título inesperado');
  if ((await win.evaluate(() => typeof window.require)) !== 'undefined') fail('el renderer tiene acceso a Node');
  const red = await win.evaluate(async () => {
    try {
      await fetch('https://example.com');
      return 'abierta';
    } catch {
      return 'bloqueada';
    }
  });
  if (red !== 'bloqueada') fail('la red no está bloqueada');
  await win.setInputFiles('#file-in', [path.join(dir, 'panel.csv'), path.join(dir, 'billetera.csv')]);
  await win.waitForSelector('[data-act=conciliar]', { timeout: 60000 });
  await win.evaluate(() => document.querySelector('[data-act=conciliar]').click());
  await win.waitForSelector('[data-view=conciliacion] .count');
  const n = await win.$eval('[data-view=conciliacion] .count', (e) => e.textContent.trim());
  if (n !== '2') fail(`se esperaban 2 partidas conciliadas y hubo ${n}`);
  // OCR de una captura de ejemplo (datos inventados): verifica que el lector viaje con la app.
  await win.evaluate(() => document.querySelector('[data-view=cargar]').click());
  await win.setInputFiles('#file-in', [path.resolve('test/fixtures/captura-ejemplo.png')]);
  await win.waitForSelector('#cap-ok', { timeout: 120000 });
  const filasOcr = await win.$$eval('[data-cap-row]', (r) => r.length);
  if (filasOcr !== 4) fail(`OCR: se esperaban 4 movimientos en la captura y se leyeron ${filasOcr}`);
  await win.fill('#cap-cuenta', 'Prueba');
  await win.evaluate(() => document.querySelector('#cap-ok').click());
  await win.waitForFunction(() => !document.querySelector('#cap-ok'));
  // Comprobante de transferencia de Mercado Pago (segunda lectura del OCR), elegido con el botón de capturas.
  await win.setInputFiles('#cap-in', [path.resolve('test/fixtures/comprobante-ejemplo.png')]);
  await win.waitForSelector('#cap-ok', { timeout: 120000 });
  const comp = await win.$$eval('[data-cap-row] input', (ins) => ins.map((i) => i.value));
  if (!comp.includes('15.000,00') || !comp.includes('21:15') || !comp.some((v) => /Lucia Ejemplo Ficticia/.test(v))) fail(`comprobante mal leído: ${comp.join(' | ')}`);
  // Agregar más imágenes al mismo lote desde la revisión.
  await win.setInputFiles('#cap-mas', [path.resolve('test/fixtures/captura-ejemplo.png')]);
  await win.waitForFunction(() => document.querySelectorAll('[data-cap-row]').length === 5 && !document.querySelector('#cap-ok').disabled, null, { timeout: 120000 }).catch(() => fail('no se agregaron las imágenes al lote'));
  await win.evaluate(() => document.querySelector('[data-close]').click());
  await win.waitForTimeout(1000);
  if (!fs.existsSync(path.join(dir, 'ConciliadorDatos', 'configuracion.json'))) fail('no se guardó la configuración junto al ejecutable');
  if (!process.exitCode) console.log(`OK: la app abre, lee los reportes, concilia (2/2), lee capturas con OCR (${filasOcr}/4), comprobantes y lotes de varias imágenes, bloquea la red y guarda la configuración.`);
} finally {
  await app.close();
}
