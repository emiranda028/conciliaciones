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

test('formato "leyenda arriba, titular abajo" (Personal Pay)', () => {
  const lines = [
    linea(22, [[17, '13:17 ONYAL']]),
    ...mov(152, '7', 'Enviaste dinero', '-$95.000,00', '> aMiriam Prueba Brun', '01/10'),
    ...mov(242, '7', 'Te enviaron dinero', '+$1.191,00', 'deVictor Ejemplo Villa', '01/10'),
    ...mov(332, '7', 'Te enviaron dinero', '+$5.000,00', '€ de Celeste Ficticia Gon...', '01/10'),
    ...mov(422, '7', 'Pagaste con QR', '-$800,00', 'a Kiosco Inventado 14:32', '01/10'),
  ];
  const filas = parsearCaptura(lines, { hoy: HOY });
  assert.deepEqual(
    filas.map((f) => [f.nombre, f.truncado, f.tipo, f.monto, f.leyenda, f.hora, f.dudoso]),
    [
      ['Miriam Prueba Brun', false, 'PAGO', 95000, '', '', false],
      ['Victor Ejemplo Villa', false, 'COBRO', 1191, '', '', false],
      ['Celeste Ficticia Gon', true, 'COBRO', 5000, '', '', false],
      ['Kiosco Inventado', false, 'PAGO', 800, 'Pagaste con QR', '14:32', false],
    ]
  );
  // Con hora, el movimiento deja de ser "sin hora" y entra en los tiempos.
  const fuente = tableToFuente('c', { sheet: null, rows: filasATabla(filas, 'Personal Pay') }, mergeConfig(null));
  const kiosco = fuente.records.find((r) => r.persona === 'Kiosco Inventado');
  assert.equal(kiosco.sinHora, false);
  assert.equal(fmtDateTime(kiosco.ts), '01/10/2026 14:32:00');
  assert.equal(fuente.records.find((r) => r.persona === 'Miriam Prueba Brun').sinHora, true);
});

test('Mercado Pago: encabezados "Hoy/Ayer/5 de octubre", hora por movimiento y centavos', () => {
  const sec = (y, t) => linea(y, [[24, t]]);
  const lines = [
    linea(20, [[24, 'Actividad']]),
    sec(60, 'Hoy'),
    ...mov(90, 'J', 'Juan Prueba Perez', '+ $ 5.000', 'Transferencia recibida', '14:32'),
    ...mov(170, 'K', 'Kiosco Ficticio', '- $ 1.250 50', 'Pago con QR', '11:05'),
    sec(250, 'Ayer'),
    ...mov(280, 'M', 'Maria Inventada Gomez', '- $ 20.000', 'Transferencia enviada', '22:40'),
    sec(360, 'Lunes 5 de octubre'),
    ...mov(390, 'p', 'Pedro Ejemplo Ruiz', '+ $ 3.500', 'Te transfirió dinero', '09:15'),
  ];
  const filas = parsearCaptura(lines, { hoy: new Date(Date.UTC(2026, 9, 7, 12)) });
  assert.deepEqual(
    filas.map((f) => [f.fecha, f.hora, f.nombre, f.tipo, f.monto, f.leyenda, f.dudoso]),
    [
      ['07/10/2026', '14:32', 'Juan Prueba Perez', 'COBRO', 5000, '', false],
      ['07/10/2026', '11:05', 'Kiosco Ficticio', 'PAGO', 1250.5, 'Pago con QR', true],
      ['06/10/2026', '22:40', 'Maria Inventada Gomez', 'PAGO', 20000, '', false],
      ['05/10/2026', '09:15', 'Pedro Ejemplo Ruiz', 'COBRO', 3500, 'Te transfirió dinero', false],
    ]
  );
});

test('turno de capturas sin hora: el cruce se limita a las horas del turno', async () => {
  const { dataset, mergeConfig: mc } = await import('../src/core/session.js');
  const config = mc(null);
  assert.deepEqual(config.turnos.map((t) => t.nombre), ['Turno 1', 'Turno 2', 'Turno 3']);
  // Configuraciones con los turnos de fábrica viejos pasan a los nuevos; las editadas se respetan.
  const viejos = [
    { nombre: 'Turno 00 a 06', desde: '00:00', hasta: '06:00' },
    { nombre: 'Turno 06 a 12', desde: '06:00', hasta: '12:00' },
    { nombre: 'Turno 12 a 18', desde: '12:00', hasta: '18:00' },
    { nombre: 'Turno 18 a 24', desde: '18:00', hasta: '24:00' },
  ];
  assert.equal(mc({ turnos: viejos }).turnos[0].nombre, 'Turno 1');
  assert.equal(mc({ turnos: [{ nombre: 'Mañana', desde: '06:00', hasta: '18:00' }] }).turnos[0].nombre, 'Mañana');

  const filas = [
    { fecha: '28/09/2026', nombre: 'Ana Prueba', tipo: 'COBRO', monto: 3000, turno: 'Turno 2' },
    { fecha: '28/09/2026', nombre: 'Beto Ejemplo', tipo: 'COBRO', monto: 4000, turno: 'Turno 3' },
  ];
  const fuente = tableToFuente('c', { sheet: null, rows: filasATabla(filas, 'MP') }, config);
  const { billetera } = dataset([fuente], config);
  const ana = billetera.find((r) => r.persona === 'Ana Prueba');
  assert.equal(ana.turno, 'Turno 2');
  assert.equal(fmtDateTime(ana.ts), '28/09/2026 18:00:00');
  const P = (h, monto, persona) => ({ id: `${persona}${h}`, lado: 'panel', origen: 'BETS', cuenta: 'Ag', persona, ts: parseDateTime(`28/09/2026, ${h}`), tipo: 'COBRO', monto });
  // Mismo monto a las 09:00 (turno 1) y a las 16:00 (turno 2): con turno 2 se elige el de las 16:00.
  let r = conciliar([P('09:00:00', 3000, 'x1'), P('16:00:00', 3000, 'x2')], billetera.filter((w) => w.persona === 'Ana Prueba'));
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].panel[0].persona, 'x2');
  // Turno 3 (22 a 06): sirve tanto de madrugada como de noche del mismo día calendario.
  r = conciliar([P('02:30:00', 4000, 'z1')], billetera.filter((w) => w.persona === 'Beto Ejemplo'));
  assert.equal(r.matches.length, 1);
  r = conciliar([P('15:00:00', 4000, 'z2')], billetera.filter((w) => w.persona === 'Beto Ejemplo'));
  assert.equal(r.matches.length, 0);
});

test('iniciales del avatar no quedan en el nombre', () => {
  const lines = [
    ...mov(90, null, 'JP Juan Prueba Perez', '+ $ 5.000', 'Transferencia recibida', '14:32'),
    ...mov(170, null, 'Pp Pedro Ejemplo Ruiz', '+ $ 3.500', 'Te transfirió dinero', '09:15'),
    ...mov(250, null, 'Al Fredo Ejemplo', '+ $ 1.000', 'Transferencia recibida', '08:00'),
  ];
  const filas = parsearCaptura(lines, { hoy: HOY });
  assert.deepEqual(filas.map((f) => f.nombre), ['Juan Prueba Perez', 'Pedro Ejemplo Ruiz', 'Al Fredo Ejemplo']);
});

test('comprobante de transferencia de Mercado Pago', async () => {
  const { esComprobante, parsearComprobante, resolverComprobantes } = await import('../src/core/capturas.js');
  const L = (arr) => arr.map((text) => ({ text }));
  // Primera lectura (por bloque): ruido en el mes y sin el monto grande.
  const p1 = L(['mercado', 'pago', 'Comprobante de transferencia', '6/0ctubre/2026 a las 18:49.', 'Motivo: Varios', 'Origen y destino',
    'G Ana Prueba Ficticia', 'Mercado Pago', 'CVuU: 0000003100000000000001', 'CUIT/CUIL: 20-00000000-1',
    '< Empresa Ejemplo', 'Mercado Pago', 'CVU: 0000003100000000000002', 'N.* de operación de Mercado Pago', '181758083051',
    'transferencias por Tansfris 2.00']);
  // Segunda lectura (segmentación automática): trae el monto.
  const p2 = L(['Comprobante de transferencia', '$ 22.500', 'Origen y destino', 'GS Ana Prueba Ficticia', 'EG Empresa Ejemplo', 'Transferi $3.00']);
  assert.ok(esComprobante(p1));
  const a = parsearComprobante(p1, p2, { hoy: HOY, imagen: 'a.jpg' });
  assert.deepEqual([a.fecha, a.hora, a.monto, a.origen, a.destino, a.ref, a.dudoso], ['06/10/2026', '18:49', 22500, 'Ana Prueba Ficticia', 'Empresa Ejemplo', '181758083051', false]);
  const b = parsearComprobante(
    L(['Comprobante de transferencia', '5/octubre/2026 a las 10:00.', '$ 9.000', 'Origen y destino', 'Empresa Ejemplo', 'CVU: 1', 'Pedro Inventado', 'N.º de operación', '181700000000']),
    [],
    { hoy: HOY }
  );
  // El titular es el nombre que se repite: lo recibido es cobro y lo enviado, pago.
  assert.equal(resolverComprobantes([a, b], 'Mercado Pago'), 'empresa ejemplo');
  assert.deepEqual([a.tipo, a.nombre, b.tipo, b.nombre], ['COBRO', 'Ana Prueba Ficticia', 'PAGO', 'Pedro Inventado']);
  // Un solo comprobante: sin titular conocido queda para revisar, salvo que la cuenta lo nombre.
  const c = parsearComprobante(p1, p2, { hoy: HOY });
  resolverComprobantes([c], '');
  assert.equal(c.dudoso, true);
  const d = parsearComprobante(p1, p2, { hoy: HOY });
  resolverComprobantes([d], 'MP Empresa Ejemplo');
  assert.deepEqual([d.tipo, d.dudoso], ['COBRO', false]);
  // El número de operación evita contar dos veces el mismo comprobante y queda como referencia.
  assert.equal(unirCapturas([[a], [{ ...a }]]).filas.length, 1);
  const fuente = tableToFuente('c', { sheet: null, rows: filasATabla([a, b], 'MP') }, mergeConfig(null));
  assert.deepEqual(fuente.records.map((r) => [r.ref, r.sinHora, fmtDateTime(r.ts)]), [
    ['181758083051', false, '06/10/2026 18:49:00'],
    ['181700000000', false, '05/10/2026 10:00:00'],
  ]);
});

test('Personal Pay en PDF: "de"/"a" pegados y en minúscula debajo de la leyenda', () => {
  const lines = [
    ...mov(152, 'Ss', 'Te enviaron dinero', '+$ 25.000,00', '€ delJose Prueba Martinez', '07/10/2026'),
    ...mov(242, 'Ss', 'Te enviaron dinero', '+$ 5.000,00', '€ devirginia carolina gale...', '07/10/2026'),
    ...mov(332, 'Ss', 'Enviaste dinero', '-$ 20.000,00', '> alourdes Natalia Inventada', '07/10/2026'),
  ];
  const filas = parsearCaptura(lines, { hoy: HOY });
  assert.deepEqual(
    filas.map((f) => [f.fecha, f.nombre, f.truncado, f.tipo, f.monto, f.leyenda, f.dudoso]),
    [
      ['07/10/2026', 'Jose Prueba Martinez', false, 'COBRO', 25000, '', false],
      ['07/10/2026', 'Virginia carolina gale', true, 'COBRO', 5000, '', false],
      ['07/10/2026', 'Lourdes Natalia Inventada', false, 'PAGO', 20000, '', false],
    ]
  );
});

test('Prex / Naranja X: fecha arriba, leyenda con el monto y titular abajo', () => {
  const lines = [
    linea(22, [[17, '22:18 NX 4 0 3,0']]),
    linea(120, [[124, '07 de octubre']]),
    linea(150, [[60, '<<'], [124, '— Transferencia recibida'], [420, '+ $ 6.000,00']]),
    linea(176, [[124, 'Leonardo Prueba Aguer']]),
    linea(220, [[124, '07 de octubre']]),
    linea(250, [[124, 'Transferenciarecibida'], [420, '+ $ 21.000,00']]),
    linea(276, [[124, 'Pelay, Zulema Inventada']]),
    linea(320, [[124, '06 de octubre']]),
    linea(350, [[124, 'Transferencia enviada'], [420, '- $ 800,00']]),
    linea(376, [[124, 'Mauro Ficticio Martinez']]),
  ];
  const filas = parsearCaptura(lines, { hoy: new Date(Date.UTC(2026, 9, 8)) });
  assert.deepEqual(
    filas.map((f) => [f.fecha, f.hora, f.nombre, f.tipo, f.monto, f.leyenda, f.dudoso]),
    [
      ['07/10/2026', '', 'Leonardo Prueba Aguer', 'COBRO', 6000, '', false],
      ['07/10/2026', '', 'Pelay, Zulema Inventada', 'COBRO', 21000, '', false],
      ['06/10/2026', '', 'Mauro Ficticio Martinez', 'PAGO', 800, '', false],
    ]
  );
});

test('lista con hora y sin día: el ícono "$" delante de la hora no es un monto', () => {
  const lines = [
    linea(40, [[30, 'Movimientos']]),
    linea(150, [[124, 'Hugo Prueba Leguizamon'], [420, '-$277.522']]),
    linea(176, [[124, 'Transferencia enviada'], [470, '12:17']]),
    linea(250, [[60, 'a'], [124, 'Liquidación de dinero'], [420, '+ $277.521,21']]),
    linea(276, [[60, '$'], [470, '12:14']]),
  ];
  const filas = parsearCaptura(lines, { hoy: new Date(Date.UTC(2026, 9, 7, 15)) });
  assert.deepEqual(
    filas.map((f) => [f.fecha, f.hora, f.nombre, f.tipo, f.monto, f.leyenda, f.dudoso]),
    [
      // Sin día en la captura: se supone el de la captura y queda para revisar.
      ['07/10/2026', '12:17', 'Hugo Prueba Leguizamon', 'PAGO', 277522, '', true],
      ['07/10/2026', '12:14', 'Liquidación de dinero', 'COBRO', 277521.21, '', true],
    ]
  );
});

test('fecha del nombre del archivo o del título del PDF', async () => {
  const { fechaDeNombre } = await import('../src/core/capturas.js');
  const hoy = new Date(Date.UTC(2026, 9, 8));
  assert.equal(fechaDeNombre('CAPTURAS_OFICINA_TT_07-10__prex_y_nx.pdf', hoy), '07/10/2026');
  assert.equal(fechaDeNombre('07.10 mov ppay jose', hoy), '07/10/2026');
  assert.equal(fechaDeNombre('ppay y nx TM Tati. 7-10 cami', hoy), '07/10/2026');
  assert.equal(fechaDeNombre('CAPTURAS_TATIANA_DIA_7_TT.pdf', hoy), '07/10/2026');
  assert.equal(fechaDeNombre('CAPTURAS_DIA_30_TM', hoy), '30/09/2026');
  assert.equal(fechaDeNombre('REPORTE TM PPAY', hoy), '');
});

test('leyendas de transferencia con letras mal leídas también se omiten', async () => {
  const { leyendaVisible } = await import('../src/core/capturas.js');
  for (const t of ['Iransferencia recibida', 'Te envlaron dinero', 'ls Transferencia enviada', 'Transferenciarecibida', 'PA Transferencia enviada']) assert.equal(leyendaVisible(t), '', t);
  for (const t of ['Pago con QR', 'Rendimientos', 'CARGA TRANSFERENCIA DE', 'Liquidación de dinero']) assert.equal(leyendaVisible(t), t);
});

test('el signo del monto manda: "TRANSFERENCIA CVU/CBU - $" es pago aunque abajo diga "CARGA TRANSFERENCIA DE"', () => {
  const lines = [
    linea(150, [[124, 'CARGA TRANSFERENCIA DE']]),
    linea(176, [[60, '<-'], [420, '$ 6.000,00']]),
    linea(202, [[124, '— ROQUE PRUEBA SANCHEZ']]),
    linea(260, [[60, 'É'], [124, 'TRANSFERENCIA CVU/CBU'], [420, '- $95.000,00']]),
    linea(320, [[124, 'CARGA TRANSFERENCIA DE']]),
    linea(346, [[60, '<='], [420, '$ 30.000,00']]),
    linea(372, [[124, '— SONIA INVENTADA RUIZ']]),
    linea(430, [[124, 'Marcelino Ruben Ovie.. 07n0/2026'], [420, '+$ 20.000,00']]),
  ];
  const filas = parsearCaptura(lines, { hoy: HOY, fechaDefecto: '07/10/2026' });
  assert.deepEqual(
    filas.map((f) => [f.nombre, f.truncado, f.tipo, f.monto, f.dudoso]),
    [
      ['ROQUE PRUEBA SANCHEZ', false, 'COBRO', 6000, false],
      ['TRANSFERENCIA CVU/CBU', false, 'PAGO', 95000, false],
      ['SONIA INVENTADA RUIZ', false, 'COBRO', 30000, false],
      ['Marcelino Ruben Ovie', true, 'COBRO', 20000, false],
    ]
  );
});

test('renglón cortado arriba y dígito duplicado en el monto', () => {
  const lines = [
    linea(40, [[30, 'Cc']]),
    { ...linea(80, [[0, '- <— IAN 1LNZADNOZ LINCINLIZ NX YE DINIZXIN 3.000 00 -']]), confidence: 34 },
    linea(106, [[124, '— FABRIZIO PRUEBA y y']]),
    linea(150, [[124, 'CARGA TRANSFERENCIA DE']]),
    linea(176, [[60, '<-'], [420, '$ 6.000,00']]),
    linea(202, [[124, '— ROQUE PRUEBA SANCHEZ']]),
    linea(260, [[60, 'E)'], [124, 'TRANSFERENCIA CVU/CBU'], [420, '- $ 1550.000,00']]),
    linea(320, [[124, 'CARGA TRANSFERENCIA DE']]),
    linea(346, [[60, '=='], [420, '$ 10.000,00']]),
    linea(372, [[124, '— GINA INVENTADA LARENTI']]),
  ];
  const filas = parsearCaptura(lines, { hoy: HOY, fechaDefecto: '07/10/2026' }).slice(0, 3);
  assert.deepEqual(
    filas.map((f) => [f.nombre, f.tipo, f.monto, f.dudoso]),
    [
      ['FABRIZIO PRUEBA', 'COBRO', 3000, true],
      ['ROQUE PRUEBA SANCHEZ', 'COBRO', 6000, false],
      ['TRANSFERENCIA CVU/CBU', 'PAGO', 150000, true],
    ]
  );
});

test('turno mal asignado: si el nombre coincide se concilia fuera del turno, para revisar', async () => {
  const { turnoDeTexto, franjasTurno } = await import('../src/core/report.js');
  // Turnos con otros nombres y en otro orden: TM/TT/TN se buscan por la hora.
  const turnos = [
    { nombre: 'Turno 22 a 06', desde: '22:00', hasta: '06:00' },
    { nombre: 'Turno 06 a 14', desde: '06:00', hasta: '14:00' },
    { nombre: 'Turno 14 a 22', desde: '14:00', hasta: '22:00' },
  ];
  assert.equal(turnoDeTexto('REPORTE TM PPAY', turnos), 'Turno 06 a 14');
  assert.equal(turnoDeTexto('CAPTURAS_OFICINA_TT_07-10', turnos), 'Turno 14 a 22');
  assert.equal(turnoDeTexto('capturas TN', turnos), 'Turno 22 a 06');

  const dia = parseDateTime('07/10/2026, 00:00:00');
  const franjas = (t) => franjasTurno(turnos.find((x) => x.nombre === t)).map(([d, h]) => [dia + d, dia + h]);
  const W = (id, persona, monto, turno) => ({ id, lado: 'billetera', origen: 'X', cuenta: '', persona, tipo: 'COBRO', monto, ts: dia + 12 * 3600000, sinHora: true, franjas: franjas(turno) });
  const P = (id, persona, h, monto) => ({ id, lado: 'panel', origen: 'BETS', cuenta: 'Laoficina', persona, ts: parseDateTime(`07/10/2026, ${h}`), tipo: 'COBRO', monto });
  const r = conciliar(
    [P('p1', 'Axeldos22', '09:25:31', 5500), P('p2', 'otro77', '09:30:00', 4000)],
    [W('w1', 'Axel Soria', 5500, 'Turno 22 a 06'), W('w2', 'Nadie Parecido', 4000, 'Turno 22 a 06')]
  );
  assert.deepEqual(
    r.matches.map((m) => [m.panel[0].persona, m.billetera[0].persona, m.confianza, m.nota]),
    [['Axeldos22', 'Axel Soria', 'baja', 'Captura sin hora, fuera del turno indicado']]
  );
  // Sin parecido de nombre no se cruza fuera del turno.
  assert.ok(r.pendientes.some((p) => p.registro.id === 'w2'));
});

test('sin hora: captura repetida y usuario que paga desde varias cuentas', () => {
  const dia = parseDateTime('07/10/2026, 00:00:00');
  const fr = [[dia + 6 * 3600000, dia + 14 * 3600000]];
  const W = (id, persona, monto) => ({ id, lado: 'billetera', origen: 'X', cuenta: '', persona, tipo: 'COBRO', monto, ts: dia + 10 * 3600000, sinHora: true, franjas: fr, turno: 'Turno 06 a 14' });
  const P = (id, persona, h, monto) => ({ id, lado: 'panel', origen: 'BETS', cuenta: 'Ag', persona, ts: parseDateTime(`07/10/2026, ${h}`), tipo: 'COBRO', monto });
  const diccionario = {
    pulga7873: { usuario: 'pulga7873', nombres: { 'mirta isabel morelli': { nombre: 'Mirta Isabel Morelli', veces: 2 } } },
    multi55: { usuario: 'multi55', nombres: { 'ana uno': { nombre: 'Ana Uno', veces: 3 }, 'beto dos': { nombre: 'Beto Dos', veces: 2 } } },
  };
  const r = conciliar(
    [P('p1', 'pulga7873', '10:28:00', 9000), P('p2', 'multi55', '11:00:00', 12000), P('p3', 'otro1', '11:30:00', 12000)],
    // La misma transferencia leída dos veces (capturas repetidas) cuenta como un solo candidato.
    [W('w1', 'Alexis Prueba Lopez', 9000), W('w2', 'Alexis Prueba Lopez', 9000), W('w3', 'Carla Nueva', 12000)],
    { diccionario }
  );
  const pares = Object.fromEntries(r.matches.map((m) => [m.panel[0].persona, [m.billetera[0].id, m.confianza]]));
  // Único en su turno aunque el titular no sea el conocido: se concilia para revisar.
  assert.deepEqual(pares.pulga7873, ['w1', 'baja']);
  // 12000: dos usuarios posibles y ninguna pista: no se elige al azar.
  assert.equal(pares.multi55, undefined);
  assert.ok(r.pendientes.some((p) => p.registro.id === 'w2'));
});
