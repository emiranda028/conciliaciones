// Capturas de pantalla (OCR), cruce sin hora y GANEMOS en tabla. Datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsearCaptura, unirCapturas, filasATabla, inferirFecha } from '../src/core/capturas.js';
import { conciliar, ESTADOS } from '../src/core/matcher.js';
import { tableToFuente, mergeConfig } from '../src/core/session.js';
import { detect } from '../src/core/importers.js';
import { parseDateTime, fmtDateTime, horaDe } from '../src/core/util.js';

// Arma líneas como las devuelve Tesseract: el ícono a la izquierda (x≈71), el texto desde x≈124.
function linea(y, partes) {
  const words = [];
  let x = 0;
  for (const [x0, text] of partes) {
    for (const t of text.split(' ')) {
      words.push({ text: t, bbox: { x0: x0 + x, y0: y, x1: x0 + x + t.length * 9, y1: y + 20 } });
      x += t.length * 10;
    }
    x = 0;
  }
  return { text: partes.map((p) => p[1]).join(' '), confidence: 90, bbox: { x0: partes[0][0], y0: y, x1: 520, y1: y + 20 }, words };
}

const mov = (y, icono, nombre, monto, detalle, fecha) => [
  linea(y, [...(icono ? [[71, icono]] : []), [124, nombre], [420, monto]]),
  linea(y + 26, [[124, detalle], [470, fecha]]),
];

const HOY = new Date(Date.UTC(2026, 9, 1));

test('parsearCaptura: nombre sin ícono, monto, tipo y fecha', () => {
  const lines = [
    linea(22, [[17, '5:35 NX ONYAL']]),
    linea(82, [[34, '< Mis movimientos =']]),
    ...mov(152, '7', 'Martina Sol Ejemplo ...', '+$2.500,00', 'Transferencia recibida', '28/09'),
    ...mov(242, 'y )', 'Pedro Prueba', '+$20.000,00', 'Transferencia recibida', '28/09'),
    ...mov(332, 'A', 'Lucia Inventada', '$760.000,00', 'Transferencia enviada', '27/09'),
    ...mov(422, 'y |', 'Bas: Ana', '+82.750,00', 'Transferencia recibida', '27/09'),
  ];
  const filas = parsearCaptura(lines, { hoy: HOY, imagen: 'a.png' });
  assert.deepEqual(
    filas.map((f) => [f.fecha, f.nombre, f.truncado, f.tipo, f.monto, f.dudoso]),
    [
      ['28/09/2026', 'Martina Sol Ejemplo', true, 'COBRO', 2500, false],
      ['28/09/2026', 'Pedro Prueba', false, 'COBRO', 20000, false],
      ['27/09/2026', 'Lucia Inventada', false, 'PAGO', 760000, false],
      // El "$" leído como "8": se corrige y queda para revisar.
      ['27/09/2026', 'Bas, Ana', false, 'COBRO', 2750, true],
    ]
  );
});

test('parsearCaptura sin posiciones de palabras (solo texto)', () => {
  const lines = [
    { text: '» German Prueba Gullo +$6.500,00' },
    { text: 'Transferencia recibida 28/09' },
    { text: 'A Horizonte Ejemplo S.a.s. $760.000,00' },
    { text: 'Transferencia enviada 27/09' },
  ];
  const filas = parsearCaptura(lines, { hoy: HOY });
  assert.deepEqual(filas.map((f) => [f.nombre, f.tipo, f.monto]), [
    ['German Prueba Gullo', 'COBRO', 6500],
    ['Horizonte Ejemplo S.a.s.', 'PAGO', 760000],
  ]);
});

test('inferirFecha: año actual salvo que quede en el futuro', () => {
  assert.equal(inferirFecha(28, 9, undefined, HOY), '28/09/2026');
  assert.equal(inferirFecha(28, 12, undefined, HOY), '28/12/2025');
  assert.equal(inferirFecha(5, 1, '26', HOY), '05/01/2026');
});

test('unirCapturas quita el solapamiento entre capturas consecutivas', () => {
  const f = (n, m) => ({ fecha: '28/09/2026', nombre: n, tipo: 'COBRO', monto: m });
  const img1 = [f('A Uno', 1), f('B Dos', 2), f('C Tres', 3)];
  const img2 = [f('C Tres', 3), f('D Cuatro', 4)];
  const img3 = [f('E Cinco', 5)];
  // En cualquier orden de carga.
  const r = unirCapturas([img2, img3, img1]);
  assert.equal(r.quitadas, 1);
  assert.equal(r.filas.length, 5);
  assert.deepEqual(
    r.filas.filter((x) => x.monto !== 5).map((x) => x.monto),
    [1, 2, 3, 4]
  );
  // Un movimiento repetido dentro de una misma captura no se toca.
  assert.equal(unirCapturas([[f('A Uno', 1), f('A Uno', 1)]]).filas.length, 2);
});

test('fuente de capturas: importador, sin hora y cruce por día y nombre', () => {
  const filas = [
    { fecha: '28/09/2026', nombre: 'Martina Sol Ejemp', truncado: true, tipo: 'COBRO', monto: 2500, imagen: 'a.png' },
    { fecha: '28/09/2026', nombre: 'Pedro Prueba', tipo: 'COBRO', monto: 7000, imagen: 'a.png' },
    { fecha: '28/09/2026', nombre: 'Nadie Conocido', tipo: 'COBRO', monto: 999, imagen: 'a.png' },
    { fecha: '28/09/2026', nombre: 'Juan Perez', tipo: 'PAGO', monto: 5000, imagen: 'b.png' },
  ];
  const rows = filasATabla(filas, 'Billetera X');
  assert.equal(detect(rows).key, 'CAPTURAS');
  const fuente = tableToFuente('Capturas', { sheet: null, rows }, mergeConfig(null));
  const b = fuente.records.map((r, i) => ({ ...r, id: `w${i}` }));
  assert.equal(b[0].sinHora, true);
  assert.equal(horaDe(b[0]), 's/h');
  assert.equal(b[0].persona, 'Martina Sol Ejemp');
  const P = (h, tipo, monto, persona) => ({ id: `${persona}${h}`, lado: 'panel', origen: 'BETS', cuenta: 'Ag', persona, ts: parseDateTime(`28/09/2026, ${h}`), tipo, monto });
  const panel = [
    P('22:15:00', 'COBRO', 2500, 'martina1'), // nombre conocido (diccionario, nombre completo)
    P('10:00:00', 'COBRO', 7000, 'xx99'), // monto único ese día
    P('23:00:00', 'PAGO', 5000, 'juan77'), // pista por nombre
  ];
  const diccionario = { martina1: { usuario: 'martina1', nombres: { 'martina sol ejemplo': { nombre: 'Martina Sol Ejemplo', veces: 2 } } } };
  const r = conciliar(panel, b, { diccionario });
  const conf = Object.fromEntries(r.matches.map((m) => [m.panel[0].persona, m.confianza]));
  assert.deepEqual(conf, { martina1: 'alta', xx99: 'baja', juan77: 'media' });
  assert.ok(r.matches.every((m) => m.demora === null && m.nota.startsWith('Captura sin hora')));
  assert.deepEqual(r.pendientes.map((p) => [p.registro.persona, p.estado]), [['Nadie Conocido', ESTADOS.COBRO_SIN_FICHA]]);
});

test('sin hora: no cruza con otro día ni le gana a un movimiento con hora', () => {
  const W = (persona, monto, extra) => ({ id: persona, lado: 'billetera', origen: 'X', cuenta: '', persona, tipo: 'COBRO', monto, ...extra });
  const p = { id: 'p1', lado: 'panel', origen: 'BETS', cuenta: '', persona: 'ana1', ts: parseDateTime('28/09/2026, 10:05:00'), tipo: 'COBRO', monto: 3000 };
  const otroDia = W('Ana Lopez', 3000, { ts: parseDateTime('27/09/2026, 12:00:00'), sinHora: true });
  assert.equal(conciliar([p], [otroDia]).matches.length, 0);
  const conHora = W('Ana Lopez', 3000, { ts: parseDateTime('28/09/2026, 10:03:00') });
  const sinHora = W('Ana Lopez B', 3000, { ts: parseDateTime('28/09/2026, 12:00:00'), sinHora: true });
  const r = conciliar([p], [sinHora, conHora]);
  assert.equal(r.matches[0].billetera[0].id, 'Ana Lopez');
});

test('GANEMOS en tabla (hoja Consolidado)', () => {
  const rows = [
    ['1', '2', '3', '4', '5', '6', '7', '8'],
    ['ID', 'FECHA', 'OPERACIÓN', 'INICIADOR', 'DE', 'A ', 'monto', 'saldo', 'DIA', 'HORA', 'Operación', 'agente', 'NOMBRE', 'MONTO'],
    [null, '2026-09-29 03:40:00', 'Depósito', 'josefina.2332', 'josefina.2332', 'junior7606', '2500', null, '=+B3'],
    [null, '2026-09-29 02:37:00', 'Retiro', 'agentez', 'agentez', '366212', '20000', null, '=+B4'],
    [null, null, null, null, null, null, null, null, '=+B5'],
  ];
  const imp = detect(rows);
  assert.equal(imp.key, 'GANEMOS_TABLA');
  assert.deepEqual(
    imp.parse(rows).records.map((r) => [fmtDateTime(r.ts), r.tipo, r.monto, r.cuenta, r.persona]),
    [
      ['29/09/2026 03:40:00', 'COBRO', 2500, 'josefina.2332', 'junior7606'],
      ['29/09/2026 02:37:00', 'PAGO', 20000, 'agentez', '366212'],
    ]
  );
});

test('leyendas: se omiten las habituales y se conservan las demás', async () => {
  const { leyendaVisible } = await import('../src/core/capturas.js');
  for (const l of ['Transferencia enviada', 'TRANSFERENCIA RECIBIDA', 'Te enviaron dinero', 'Enviaste  dinero']) assert.equal(leyendaVisible(l), '');
  assert.equal(leyendaVisible('Pago con QR'), 'Pago con QR');
  const lines = [
    ...mov(152, '7', 'Ana Prueba', '+$1.000,00', 'Te enviaron dinero', '28/09'),
    ...mov(242, 'A', 'Beto Ejemplo', '$2.000,00', 'Enviaste dinero', '28/09'),
    ...mov(332, 'A', 'Kiosco Ficticio', '$500,00', 'Pago con QR', '28/09'),
    ...mov(422, '7', 'Banco Inventado', '+$12,50', 'Rendimientos', '28/09'),
  ];
  const filas = parsearCaptura(lines, { hoy: HOY });
  assert.deepEqual(filas.map((f) => [f.nombre, f.tipo, f.leyenda]), [
    ['Ana Prueba', 'COBRO', ''],
    ['Beto Ejemplo', 'PAGO', ''],
    ['Kiosco Ficticio', 'PAGO', 'Pago con QR'],
    ['Banco Inventado', 'COBRO', 'Rendimientos'],
  ]);
  const fuente = tableToFuente('c', { sheet: null, rows: filasATabla(filas, 'X') }, mergeConfig(null));
  assert.deepEqual(fuente.records.map((r) => r.detalle), ['', '', 'Pago con QR', 'Rendimientos']);
  // Tabla guardada por la versión anterior (sin columna Leyenda): se sigue leyendo.
  const vieja = [['Fecha', 'Titular', 'Operación', 'Monto', 'Cuenta', 'Imagen', 'Origen: captura de pantalla'], ['28/09/2026', 'Ana Prueba', 'Cobro', 1000, 'X', 'a.png']];
  const fv = tableToFuente('v', { sheet: null, rows: vieja }, mergeConfig(null));
  assert.equal(fv.records.length, 1);
  assert.equal(fv.records[0].detalle, '');
});
