// Pruebas del núcleo con datos sintéticos (mismos formatos que los reportes reales,
// sin datos de personas reales).
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseNumber, parseDateTime, fmtDateTime, MIN } from '../src/core/util.js';
import { parseCsv, parsePasted } from '../src/core/tabular.js';
import { detect, assignIds, parseGeneric } from '../src/core/importers.js';
import { conciliar, ESTADOS, nameHint } from '../src/core/matcher.js';
import { tiempos, turnoDe, resumen, exportarExcel, ventanaDia } from '../src/core/report.js';
import { dataset, tableToFuente, mergeConfig, serializarTrabajo, deserializarTrabajo, unirDiccionario } from '../src/core/session.js';

const W = (s) => parseDateTime(s); // hora de pared

// --- generadores de reportes ---------------------------------------------------

function betsCsv(ops) {
  const head =
    'Transaction Group Id,Transaction ID,ID,Date,Amount,Notes,Transaction Type,Owner Type,Wallet Type,Before,After,Owner ID,Owner Name,User ID,UserName,Associated Transaction ID,Associated Transaction Time,Associated Transaction Type';
  const lines = [head];
  ops.forEach((o, i) => {
    const type = o.tipo === 'COBRO' ? 'PlayerDepositFromBalance' : 'PlayerWithdrawalToBalance';
    const notes = o.tipo === 'COBRO' ? 'Player deposit from balance' : 'Player withdrawal to balance';
    const amt = o.tipo === 'COBRO' ? o.monto : -o.monto;
    lines.push(`${1000 + i},${2000 + i},${3000 + i * 2},"${o.fecha}",${amt.toFixed(8)},${notes},${type},Player,Balance,0,0,${9000 + i},${o.usuario},25982,AgenteFB1,,,`);
    lines.push(`${1000 + i},${2000 + i},${3001 + i * 2},"${o.fecha}",${(-amt).toFixed(8)},${notes},${type},Agent,Balance,0,0,25982,AgenteFB1,25982,AgenteFB1,,,`);
  });
  return '﻿' + lines.join('\n');
}

function cashCsv(ops) {
  const head =
    'ID Interno,ID Externo,Cuenta,Usuario,Monto,Moneda,Dirección,Canal,Estado,Tipo,Concepto,Fecha,Código COELSA,Nombre Remitente,CBU Remitente,CUIT Remitente,CBU Destinatario,CUIT Destinatario,Nombre Destinatario,Fee,Fee cobrado,Tipo de fee,Fee plataforma';
  const lines = [head];
  ops.forEach((o, i) => {
    const entr = o.tipo === 'COBRO';
    lines.push(
      [
        `id-${i}`,
        `E-${i}`,
        'SUC 1',
        'caja@ejemplo',
        o.monto,
        'ARS',
        entr ? 'Entrante' : 'Saliente',
        o.canal || 'Externo',
        o.estado || 'Hecha',
        entr ? 'inbound' : 'outbound',
        o.concepto || '',
        `"${o.fecha}"`,
        '',
        entr ? o.nombre : 'EMPRESA',
        '',
        '',
        '',
        '',
        entr ? 'EMPRESA' : o.nombre,
        '"ARS 1,00"',
        'Cobrado',
        'Coelsa',
        '',
      ].join(',')
    );
  });
  return lines.join('\n');
}

const fuenteCsv = (nombre, csv) => tableToFuente(nombre, { sheet: null, rows: parseCsv(csv) }, mergeConfig(null));

// --- util ---------------------------------------------------------------------

test('parseNumber entiende formatos argentinos y de exportaciones', () => {
  assert.equal(parseNumber('10.000 '), 10000);
  assert.equal(parseNumber('-30.000 '), -30000);
  assert.equal(parseNumber('ARS 37,20'), 37.2);
  assert.equal(parseNumber('26710.1848'), 26710.1848);
  assert.equal(parseNumber('2000.00000000'), 2000);
  assert.equal(parseNumber('1.234.567,89'), 1234567.89);
  assert.equal(parseNumber('1,234,567.89'), 1234567.89);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
});

test('parseDateTime entiende los formatos de cada plataforma', () => {
  assert.equal(fmtDateTime(W('21.09.2026 06:04:46.088')), '21/09/2026 06:04:46');
  assert.equal(fmtDateTime(W('21/09/2026, 01:25:52')), '21/09/2026 01:25:52');
  assert.equal(fmtDateTime(W('20/09/26 23:54 PM')), '20/09/2026 23:54:00');
  assert.equal(fmtDateTime(W('20/09/26 12:10 AM')), '20/09/2026 00:10:00');
  assert.equal(fmtDateTime(W('2026-09-21 03:31:00')), '21/09/2026 03:31:00');
  // Mercado Pago informa con huso; se lleva a hora argentina (-03:00).
  assert.equal(fmtDateTime(W('2026-08-04T12:57:00,000-04:00')), '04/08/2026 13:57:00');
  assert.equal(fmtDateTime(W('2026-09-15T00:42:00,000-03:00')), '15/09/2026 00:42:00');
});

// --- importadores ----------------------------------------------------------------

test('BETS: toma solo la fila del jugador y clasifica cobro/pago', () => {
  const f = fuenteCsv('bets.csv', betsCsv([
    { fecha: '21.09.2026 06:04:46.088', monto: 2000, tipo: 'COBRO', usuario: 'lucas0576' },
    { fecha: '21.09.2026 07:00:00.000', monto: 5000, tipo: 'PAGO', usuario: 'ana123' },
  ]));
  assert.equal(f.importerKey, 'BETS');
  assert.equal(f.records.length, 2);
  assert.deepEqual(
    f.records.map((r) => [r.tipo, r.monto, r.persona, r.cuenta]),
    [
      ['COBRO', 2000, 'lucas0576', 'AgenteFB1'],
      ['PAGO', 5000, 'ana123', 'AgenteFB1'],
    ]
  );
});

test('Cash: entrantes, salientes, fee, internos y revertidas', () => {
  const f = fuenteCsv('cash.csv', cashCsv([
    { fecha: '21/09/2026, 06:03:54', monto: 2000, tipo: 'COBRO', nombre: 'Lucas Julian Q' },
    { fecha: '21/09/2026, 07:00:00', monto: 5000, tipo: 'PAGO', nombre: 'Ana Maria P' },
    { fecha: '22/09/2026, 01:25:52', monto: 100, tipo: 'PAGO', nombre: 'OTRA SUC', canal: 'Interno', concepto: 'Fee' },
    { fecha: '21/09/2026, 08:00:00', monto: 900, tipo: 'PAGO', nombre: 'Juan X', estado: 'Revertida' },
    { fecha: '21/09/2026, 08:00:00', monto: 900, tipo: 'PAGO', nombre: 'Juan X', estado: 'Pendiente' },
  ]));
  assert.equal(f.importerKey, 'CASH');
  assert.deepEqual(
    f.records.map((r) => [r.tipo, r.monto, r.persona]),
    [
      ['COBRO', 2000, 'Lucas Julian Q'],
      ['PAGO', 5000, 'Ana Maria P'],
      ['COMISION', 100, 'OTRA SUC'],
      ['REVERTIDO', 900, 'Juan X'],
    ]
  );
  assert.equal(f.skipped, 1);
});

test('GANEMOS: texto copiado del panel en una sola columna', () => {
  const texto = [
    '246259728444', '21/09/26 00:44 AM', 'Depósito', 'josefina.2332', 'josefina.2332', 'lara7692', '10000', '83.787,5073.787,50',
    '246070449165', '20/09/26 16:52 PM', 'Retiro', 'josefina.2332', 'josefina.2332', 'mary0378bg', '50000', '363.987,50413.987,50',
  ].join('\n');
  const rows = parsePasted(texto);
  const imp = detect(rows);
  assert.equal(imp.key, 'GANEMOS');
  const recs = imp.parse(rows).records;
  assert.deepEqual(
    recs.map((r) => [r.tipo, r.monto, r.persona, r.cuenta, fmtDateTime(r.ts)]),
    [
      ['COBRO', 10000, 'lara7692', 'josefina.2332', '21/09/2026 00:44:00'],
      ['PAGO', 50000, 'mary0378bg', 'josefina.2332', '20/09/2026 16:52:00'],
    ]
  );
});

test('GANEMOS: planilla "nro | reporte" ignora la columna contador', () => {
  const vals = ['246250427600', new Date(Date.UTC(2026, 8, 21, 0, 25)), 'Depósito', 'agentez', 'agentez', 'paula08zg', 2000, '294.465,20292.465,20'];
  const rows = [['nro', 'reporte'], ...vals.map((v, i) => [i + 1, v]), ...vals.map((v, i) => [i + 1, v === '246250427600' ? '246250427601' : v])];
  const imp = detect(rows);
  assert.equal(imp.key, 'GANEMOS');
  assert.equal(imp.parse(rows).records.length, 2);
});

test('ZEUS: depósitos y retiros (en retiros el jugador está en "Agente")', () => {
  const rows = [
    ['Nro', 'Fecha', '', 'Operación', 'Agente', 'Destino', 'Depósito', 'Retiro', 'Saldo'],
    ['jydh', '2026-09-21 03:31:00', 'DEPOSITO (Solicitado por 27110600)', 'agent01', 'gory2291', '5000 ', '0 ', '5000 '],
    ['ycl6', '2026-09-20 19:02:00', 'RETIRO (Solicitado por 27110600)', 'gory2291', 'agent01', '0 ', '-30.000 ', '-30.000 '],
  ];
  const imp = detect(rows);
  assert.equal(imp.key, 'ZEUS');
  assert.deepEqual(
    imp.parse(rows).records.map((r) => [r.tipo, r.monto, r.persona, r.cuenta]),
    [
      ['COBRO', 5000, 'gory2291', 'agent01'],
      ['PAGO', 30000, 'gory2291', 'agent01'],
    ]
  );
});

test('Mercado Pago: signo del valor, PAYOUTS como pago, fecha de aprobación', () => {
  const rows = [
    ['ID DE OPERACIÓN EN MERCADO PAGO', 'CÓDIGO DE LA CUENTA DEL VENDEDOR', 'TIPO DE OPERACIÓN', 'VALOR DE LA COMPRA', 'FECHA DE ORIGEN', 'FECHA DE APROBACIÓN', 'PAGADOR'],
    ['1001', '2431937166', 'Pago aprobado', '4000', '2026-09-15T00:42:00,000-03:00', '2026-09-15T00:42:01,000-03:00', 'Juan Perez'],
    ['1002', '2431937166', 'PAYOUTS', '-126900', '2026-09-15T01:00:00,000-03:00', '2026-09-15T01:00:00,000-03:00', ''],
    ['1003', '2431937166', 'Pago rechazado', '500', '2026-09-15T01:00:00,000-03:00', '2026-09-15T01:00:00,000-03:00', ''],
  ];
  const imp = detect(rows);
  assert.equal(imp.key, 'MP');
  const r = imp.parse(rows);
  assert.deepEqual(r.records.map((x) => [x.tipo, x.monto, x.persona, fmtDateTime(x.ts)]), [
    ['COBRO', 4000, 'Juan Perez', '15/09/2026 00:42:01'],
    ['PAGO', 126900, '', '15/09/2026 01:00:00'],
  ]);
  assert.equal(r.skipped, 1);
});

test('mapeo genérico de columnas', () => {
  const rows = [
    ['Fecha', 'Hora', 'Movimiento', 'Importe', 'Cliente'],
    ['21/09/2026', '10:00:00', 'Crédito', '1.500,00', 'Pedro'],
    ['21/09/2026', '11:00:00', 'Débito', '700,00', 'Ana'],
  ];
  const r = parseGeneric(rows, { lado: 'billetera', origen: 'BANCO', headerRow: 0, fecha: 0, hora: 1, tipo: 2, monto: 3, persona: 4, cobroSi: 'crédito' });
  assert.deepEqual(r.records.map((x) => [x.tipo, x.monto, x.persona, fmtDateTime(x.ts)]), [
    ['COBRO', 1500, 'Pedro', '21/09/2026 10:00:00'],
    ['PAGO', 700, 'Ana', '21/09/2026 11:00:00'],
  ]);
});

// --- motor ------------------------------------------------------------------------

let n = 0;
const P = (hora, tipo, monto, persona, extra = {}) => ({ id: `p${++n}`, lado: 'panel', origen: 'BETS', cuenta: 'AgenteFB1', persona, ts: W(`21/09/2026, ${hora}`), tipo, monto, ref: '', ...extra });
const B = (hora, tipo, monto, persona, extra = {}) => ({ id: `b${++n}`, lado: 'billetera', origen: 'CASH', cuenta: 'SUC 1', persona, ts: W(`21/09/2026, ${hora}`), tipo, monto, ref: '', ...extra });

test('cobro: primero el dinero, después las fichas; pago al revés', () => {
  const panel = [P('10:02:00', 'COBRO', 1000, 'lucas0576'), P('11:00:00', 'PAGO', 5000, 'ana123')];
  const bill = [B('10:00:30', 'COBRO', 1000, 'Lucas Julian Q'), B('11:03:00', 'PAGO', 5000, 'Ana Maria P')];
  const r = conciliar(panel, bill);
  assert.equal(r.matches.length, 2);
  assert.equal(r.pendientes.length, 0);
  assert.equal(r.matches[0].demora, 90 * 1000);
  assert.equal(r.matches[1].demora, 3 * MIN);
});

test('no cruza fuera de la ventana de demora', () => {
  const r = conciliar([P('11:00:00', 'COBRO', 1000, 'x')], [B('10:00:00', 'COBRO', 1000, 'Y')]);
  assert.equal(r.matches.length, 0);
  assert.deepEqual(r.pendientes.map((p) => p.estado).sort(), [ESTADOS.FICHA_SIN_COBRO, ESTADOS.COBRO_SIN_FICHA].sort());
});

test('bonificación del 10% solo en cobros', () => {
  const r = conciliar(
    [P('10:02:00', 'COBRO', 3300, 'maximo0884'), P('12:00:00', 'PAGO', 6000, 'dario0132')],
    [B('10:01:00', 'COBRO', 3000, 'Humberto J O'), B('12:01:00', 'PAGO', 5000, 'Otro')]
  );
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].estado, ESTADOS.BONIFICACION);
  assert.equal(r.matches[0].nota, 'Bonificación 10%');
});

test('el diccionario desempata entre dos cobros del mismo monto', () => {
  const panel = [P('10:02:00', 'COBRO', 1000, 'serio1920')];
  const bill = [B('10:01:50', 'COBRO', 1000, 'Pedro Gomez'), B('10:00:30', 'COBRO', 1000, 'Nilda Maria Villalba')];
  const diccionario = { serio1920: { usuario: 'serio1920', nombres: { 'nilda maria villalba': { nombre: 'Nilda Maria Villalba', veces: 3 } } } };
  const r = conciliar(panel, bill, { diccionario });
  assert.equal(r.matches[0].billetera[0].persona, 'Nilda Maria Villalba');
  assert.equal(r.matches[0].confianza, 'alta');
});

test('pista por nombre: usuario parecido al titular', () => {
  assert.ok(nameHint('santi7342c', 'SANTIAGO MIGUEL BOSSI'));
  assert.ok(nameHint('Zapata3957x', 'Joaquin Marcelo Zapata'));
  assert.ok(nameHint('Mar30tin', 'Martin Esmoli'));
  assert.ok(nameHint('estrella10azar', 'Estrella Eileén Gonzalez'));
  assert.ok(!nameHint('Mar30tin', 'Lucia Gomez'));
  assert.ok(nameHint('daro5866', 'DARIO DAMIAN LAN'));
  assert.ok(!nameHint('daro5866', 'Dora Lopez'));
  assert.ok(nameHint('serio1920', 'Sergio Fariña'));
  assert.ok(!nameHint('0367xx', 'Hugo Escobar'));
});

test('compensado: retira 6000 y carga 1000, se le pagan 5000', () => {
  const r = conciliar(
    [P('22:40:57', 'PAGO', 6000, 'dario0132'), P('22:41:05', 'COBRO', 1000, 'dario0132')],
    [B('22:41:37', 'PAGO', 5000, 'RUBEN DARIO Y')]
  );
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].estado, ESTADOS.COMPENSADO);
  assert.equal(r.matches[0].diferencia, 0);
});

test('agrupado: dos transferencias para una sola carga de fichas', () => {
  const r = conciliar([P('10:05:00', 'COBRO', 10000, 'juan1')], [B('10:01:00', 'COBRO', 6000, 'Juan Perez'), B('10:02:00', 'COBRO', 4000, 'Juan Perez')]);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].estado, ESTADOS.AGRUPADO);
  assert.equal(r.matches[0].billetera.length, 2);
});

test('pago duplicado', () => {
  const r = conciliar([P('03:00:00', 'PAGO', 8000, 'martin2775')], [B('03:00:20', 'PAGO', 8000, 'Carlos Martin M'), B('03:09:12', 'PAGO', 8000, 'Carlos Martin M')]);
  assert.equal(r.matches.length, 1);
  assert.equal(r.pendientes.length, 1);
  assert.equal(r.pendientes[0].estado, ESTADOS.PAGO_DUPLICADO);
});

test('manual: forzar, rechazar y marcar estado', () => {
  const p1 = P('10:00:00', 'COBRO', 1000, 'a');
  const b1 = B('09:59:00', 'COBRO', 1000, 'A B');
  const b2 = B('15:00:00', 'COBRO', 999, 'Z');
  const p2 = P('16:00:00', 'COBRO', 500, 'q');
  // Rechazar el par automático deja ambos pendientes.
  let r = conciliar([p1], [b1], { manual: { rechazados: [`${p1.id}|${b1.id}`] } });
  assert.equal(r.matches.length, 0);
  // Forzar un par que el automático no haría.
  r = conciliar([p1, p2], [b1, b2], { manual: { forzados: [{ panel: [p2.id], billetera: [b2.id], nota: 'ok' }], estados: {} } });
  assert.ok(r.matches.some((m) => m.estado === ESTADOS.MANUAL && m.diferencia === -499));
  // Marcar estado a mano.
  r = conciliar([p1], [b1, b2], { manual: { estados: { [b2.id]: { estado: 'Otro', nota: 'x' } } } });
  assert.equal(r.pendientes.find((p) => p.registro.id === b2.id).estado, 'Otro');
});

// --- reportes -----------------------------------------------------------------------

test('turnos, ventana de día operativo y tiempos', () => {
  assert.equal(turnoDe(W('21/09/2026, 05:59:59')), 'Turno 3');
  assert.equal(turnoDe(W('21/09/2026, 06:00:00')), 'Turno 1');
  assert.equal(turnoDe(W('21/09/2026, 14:00:00')), 'Turno 2');
  assert.equal(turnoDe(W('21/09/2026, 23:00:00')), 'Turno 3');
  const v = ventanaDia(Date.UTC(2026, 8, 21), 6);
  assert.equal(fmtDateTime(v.from), '21/09/2026 06:00:00');
  assert.equal(fmtDateTime(v.to), '22/09/2026 06:00:00');
  const r = conciliar(
    [P('10:01:00', 'COBRO', 1000, 'a1'), P('10:05:00', 'COBRO', 2000, 'a2'), P('11:00:00', 'PAGO', 500, 'a3')],
    [B('10:00:00', 'COBRO', 1000, 'X'), B('10:02:00', 'COBRO', 2000, 'Y'), B('11:10:00', 'PAGO', 500, 'Z')]
  );
  const t = tiempos(r);
  assert.equal(t.COBRO.general.cantidad, 2);
  assert.equal(t.COBRO.general.promedio, 2 * MIN);
  assert.equal(t.PAGO.general.maximo, 10 * MIN);
  const s = resumen(r);
  assert.equal(s.panel.cobros, 3000);
  assert.equal(s.billetera.pagos, 500);
  assert.equal(s.diferenciaNeta, 0);
  assert.equal(s.avance, 1);
});

test('exportación a Excel', async () => {
  const r = conciliar([P('10:01:00', 'COBRO', 1000, 'a1')], [B('10:00:00', 'COBRO', 1000, 'X'), B('12:00:00', 'COBRO', 7, 'Y')]);
  const buf = await exportarExcel({ res: r, resumenData: resumen(r), tiemposData: tiempos(r), panel: [], billetera: [], diccionario: {}, turnos: undefined, titulo: 'x' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ['Resumen', 'Conciliación', 'Pendientes', 'Tiempos', 'Base panel', 'Base billeteras', 'Usuarios y titulares']
  );
  assert.equal(wb.getWorksheet('Conciliación').rowCount, 2);
  assert.equal(wb.getWorksheet('Pendientes').rowCount, 2);
});

// --- sesión ---------------------------------------------------------------------------

test('dataset: descarta la misma operación cargada dos veces', () => {
  const csv = betsCsv([{ fecha: '21.09.2026 06:04:46.088', monto: 2000, tipo: 'COBRO', usuario: 'lucas0576' }]);
  const plano = tableToFuente('base.xlsx', { sheet: 'panel todo', rows: [['DIA', 'HORA', 'Operación', 'agente', 'NOMBRE', 'MONTO'], [new Date(Date.UTC(2026, 8, 21)), '06:04:46', 'COBRO', 'AgenteFB1', 'lucas0576', 2000]] }, mergeConfig(null));
  assert.equal(plano.importerKey, 'PANEL_PLANO');
  const d = dataset([fuenteCsv('a.csv', csv), fuenteCsv('b.csv', csv), plano], mergeConfig(null));
  assert.equal(d.panel.length, 1);
  assert.equal(d.duplicadosDescartados, 2);
});

test('trabajo guardado: ida y vuelta', () => {
  const f = fuenteCsv('bets.csv', betsCsv([{ fecha: '21.09.2026 06:04:46.088', monto: 2000, tipo: 'COBRO', usuario: 'lucas0576' }]));
  const manual = { forzados: [], estados: { x: { estado: 'Otro', nota: '' } }, rechazados: ['a|b'] };
  const t = deserializarTrabajo(serializarTrabajo({ fuentes: [f], manual, dia: '2026-09-21' }));
  assert.equal(t.fuentes[0].records.length, 1);
  assert.equal(t.fuentes[0].records[0].persona, 'lucas0576');
  assert.deepEqual(t.manual, manual);
  assert.equal(t.dia, '2026-09-21');
});

test('unirDiccionario no infla contadores al recalcular', () => {
  const a = { u: { usuario: 'u', nombres: { 'x y': { nombre: 'X Y', veces: 2 } } } };
  const b = unirDiccionario(unirDiccionario(a, a), a);
  assert.equal(b.u.nombres['x y'].veces, 2);
});

test('ids estables', () => {
  const recs = assignIds([
    { origen: 'CASH', ref: 'abc', tipo: 'COBRO' },
    { origen: 'CASH', ref: '', tipo: 'COBRO', ts: 1, monto: 5, persona: 'A' },
    { origen: 'CASH', ref: '', tipo: 'COBRO', ts: 1, monto: 5, persona: 'A' },
  ]);
  assert.deepEqual(recs.map((r) => r.id), ['CASH|abc|COBRO', 'CASH|1|COBRO|5|a', 'CASH|1|COBRO|5|a#2']);
});

test('líneas: solo se concilian los agentes de la línea elegida', async () => {
  const { ejecutar, agentesDePaneles, lineaDeAgente } = await import('../src/core/session.js');
  const config = mergeConfig(null);
  assert.equal(lineaDeAgente(config, 'Josefina.2332').nombre, 'AgenteB');
  assert.equal(lineaDeAgente(config, 'agent01'), null);
  const rows = [
    ['Nro', 'Fecha', '', 'Operación', 'Agente', 'Destino', 'Depósito', 'Retiro', 'Saldo'],
    ['a1', '2026-09-29 10:05:00', 'DEPOSITO (Solicitado por 1)', 'agentez', 'joni29zgg', '1000', '0', '1000'],
    ['a2', '2026-09-29 11:05:00', 'DEPOSITO (Solicitado por 2)', 'agent01', 'leti8459', '2000', '0', '2000'],
    ['a3', '2026-09-29 12:05:00', 'DEPOSITO (Solicitado por 3)', 'agenteb', 'viviana68zz', '3000', '0', '3000'],
  ];
  const zeus = tableToFuente('zeus.xlsx', { sheet: 'zeus', rows }, config);
  const cash = fuenteCsv('cash.csv', cashCsv([{ fecha: '29/09/2026, 10:03:00', monto: 1000, tipo: 'COBRO', nombre: 'Jonatan Ejemplo' }]));
  const ags = agentesDePaneles([zeus], config);
  assert.deepEqual(ags.map((a) => [a.agente, a.linea]), [['agent01', ''], ['agentez', 'AgenteZ'], ['agenteb', 'AgenteB']].sort((x, y) => x[1].localeCompare(y[1])));
  const todas = ejecutar({ fuentes: [zeus, cash], config, manual: {}, dia: '2026-09-29' });
  assert.equal(todas.resumen.nPanelOperables, 3);
  const z = ejecutar({ fuentes: [zeus, cash], config, manual: {}, dia: '2026-09-29', linea: 'AgenteZ' });
  assert.equal(z.resumen.nPanelOperables, 1);
  assert.equal(z.resumen.avance, 1);
  assert.deepEqual(z.excluidosLinea, { agent01: 1, agenteb: 1 });
  // Agentes elegidos uno por uno (de distintas líneas): mandan sobre la línea.
  const sel = ejecutar({ fuentes: [zeus, cash], config, manual: {}, dia: '2026-09-29', linea: 'AgenteZ', agentes: ['AgenteZ', 'agent01'] });
  assert.equal(sel.resumen.nPanelOperables, 2);
  assert.equal(sel.linea, '');
  assert.deepEqual(sel.agentes, ['AgenteZ', 'agent01']);
  assert.deepEqual(sel.excluidosLinea, { agenteb: 1 });
});

test('BETS sin fila de títulos y con cada renglón entre comillas', async () => {
  const { parseCsv } = await import('../src/core/tabular.js');
  const { detect } = await import('../src/core/importers.js');
  const txt = [
    '"1,11,101,""07.10.2026 14:24:08.381"",500000.00000000,Player deposit from balance,PlayerDepositFromBalance,Player,Balance,0,0,4,jugador1,9,AgentePrueba,,,"',
    '"2,12,102,""07.10.2026 14:24:17.439"",-5000.00000000,Player withdrawal to balance,PlayerWithdrawalToBalance,Player,Balance,0,0,4,jugador1,9,AgentePrueba,,,"',
  ].join('\n');
  const rows = parseCsv(txt);
  assert.equal(rows[0].length, 18);
  const imp = detect(rows);
  assert.equal(imp?.key, 'BETS');
  const { records } = imp.parse(rows);
  assert.deepEqual(records.map((r) => [r.tipo, r.monto, r.persona, r.cuenta]), [
    ['COBRO', 500000, 'jugador1', 'AgentePrueba'],
    ['PAGO', 5000, 'jugador1', 'AgentePrueba'],
  ]);
});
