// Resúmenes, tiempos de demora y exportación a Excel.
import ExcelJS from 'exceljs';
import { DIA, HORA, MIN, fmtDate, horaDe, fmtDuration, median, percentile, round2, parseTimeOfDay } from './util.js';
import { ESTADOS } from './matcher.js';

// Tres turnos de 8 horas alineados con el día operativo (06:00 a 06:00). Editables en Configuración.
export const DEFAULT_TURNOS = [
  { nombre: 'Turno 1', desde: '06:00', hasta: '14:00' },
  { nombre: 'Turno 2', desde: '14:00', hasta: '22:00' },
  { nombre: 'Turno 3', desde: '22:00', hasta: '06:00' },
];

// Turnos de fábrica de versiones anteriores (para actualizar configuraciones sin tocar).
export const TURNOS_ANTERIORES = [
  { nombre: 'Turno 00 a 06', desde: '00:00', hasta: '06:00' },
  { nombre: 'Turno 06 a 12', desde: '06:00', hasta: '12:00' },
  { nombre: 'Turno 12 a 18', desde: '12:00', hasta: '18:00' },
  { nombre: 'Turno 18 a 24', desde: '18:00', hasta: '24:00' },
];

// Franjas de un turno dentro de un día calendario, en ms desde la medianoche.
// Un turno que cruza la medianoche (22 a 06) da dos franjas: 00-06 y 22-24.
export function franjasTurno(t) {
  if (!t) return null;
  const d = t.desde === '24:00' ? DIA : parseTimeOfDay(t.desde);
  const h = t.hasta === '24:00' ? DIA : parseTimeOfDay(t.hasta);
  if (d == null || h == null) return null;
  if (d < h) return [[d, h]];
  return [
    [0, h],
    [d, DIA],
  ];
}

export function turnoDe(ts, turnos = DEFAULT_TURNOS) {
  const tod = ((ts % DIA) + DIA) % DIA;
  for (const t of turnos) {
    const d = t.desde === '24:00' ? DIA : parseTimeOfDay(t.desde);
    const h = t.hasta === '24:00' ? DIA : parseTimeOfDay(t.hasta);
    if (d == null || h == null) continue;
    if (d < h ? tod >= d && tod < h : tod >= d || tod < h) return t.nombre;
  }
  return 'Sin turno';
}

// Día operativo: de las HH del día elegido a las HH del día siguiente.
export function ventanaDia(dayMs, horaInicio = 6) {
  const from = dayMs + horaInicio * HORA;
  return { from, to: from + DIA };
}

// Día operativo más frecuente en los movimientos (para sugerirlo al cargar).
export function diaSugerido(records, horaInicio = 6) {
  const counts = new Map();
  for (const r of records) {
    const d = Math.floor((r.ts - horaInicio * HORA) / DIA) * DIA;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = null;
  for (const [d, n] of counts) if (!best || n > best[1]) best = [d, n];
  return best ? best[0] : null;
}

export function filtrarResultado(res, ventana) {
  if (!ventana) return res;
  const dentro = (ts) => ts >= ventana.from && ts < ventana.to;
  const tsRef = (m) => (m.panel.length ? Math.min(...m.panel.map((r) => r.ts)) : m.ts);
  return {
    ...res,
    matches: res.matches.filter((m) => dentro(tsRef(m))),
    pendientes: res.pendientes.filter((p) => dentro(p.registro.ts)),
  };
}

const signo = (r) => (r.tipo === 'COBRO' ? 1 : r.tipo === 'PAGO' ? -1 : 0);

function totales(list) {
  const t = { cobros: 0, pagos: 0, bonos: 0, internos: 0, comisiones: 0, nCobros: 0, nPagos: 0 };
  for (const r of list) {
    if (r.tipo === 'COBRO') {
      t.cobros += r.monto;
      t.nCobros += 1;
    } else if (r.tipo === 'PAGO') {
      t.pagos += r.monto;
      t.nPagos += 1;
    } else if (r.tipo === 'BONO') t.bonos += r.monto;
    else if (r.tipo === 'INTERNO') t.internos += r.monto;
    else if (r.tipo === 'COMISION') t.comisiones += r.monto;
  }
  for (const k of Object.keys(t)) t[k] = round2(t[k]);
  t.neto = round2(t.cobros - t.pagos);
  return t;
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export function resumen(res) {
  const panel = [];
  const billetera = [];
  for (const m of res.matches) {
    panel.push(...m.panel);
    billetera.push(...m.billetera);
  }
  for (const p of res.pendientes) (p.registro.lado === 'panel' ? panel : billetera).push(p.registro);

  const tp = totales(panel);
  const tb = totales(billetera);
  const porEstado = [];
  for (const [estado, ms] of groupBy(res.matches, (m) => m.estado)) {
    porEstado.push({
      estado,
      grupo: 'conciliado',
      cantidad: ms.length,
      montoPanel: round2(ms.reduce((s, m) => s + m.montoPanel * (m.tipo === 'PAGO' ? -1 : 1), 0)),
      montoBilletera: round2(ms.reduce((s, m) => s + m.montoBilletera * (m.tipo === 'PAGO' ? -1 : 1), 0)),
    });
  }
  for (const [estado, ps] of groupBy(res.pendientes, (p) => p.estado)) {
    const enPanel = ps.filter((p) => p.registro.lado === 'panel');
    const enBill = ps.filter((p) => p.registro.lado !== 'panel');
    porEstado.push({
      estado,
      grupo: 'pendiente',
      cantidad: ps.length,
      montoPanel: round2(enPanel.reduce((s, p) => s + signo(p.registro) * p.registro.monto, 0)),
      montoBilletera: round2(enBill.reduce((s, p) => s + (signo(p.registro) || -1) * p.registro.monto, 0)),
    });
  }
  const porOrigen = [];
  for (const [k, list] of groupBy([...panel, ...billetera], (r) => `${r.lado}|${r.origen}|${r.cuenta}`)) {
    const [lado, origen, cuenta] = k.split('|');
    porOrigen.push({ lado, origen, cuenta, ...totales(list) });
  }
  porOrigen.sort((a, b) => a.lado.localeCompare(b.lado) || a.origen.localeCompare(b.origen) || a.cuenta.localeCompare(b.cuenta));
  const nConciliados = res.matches.reduce((s, m) => s + m.panel.length, 0);
  const nPanelOperables = panel.filter((r) => r.tipo === 'COBRO' || r.tipo === 'PAGO').length;
  return {
    panel: tp,
    billetera: tb,
    diferenciaNeta: round2(tp.neto - tb.neto),
    porEstado,
    porOrigen,
    avance: nPanelOperables ? nConciliados / nPanelOperables : 0,
    nConciliados,
    nPanelOperables,
  };
}

function stats(ms) {
  const vals = ms.map((m) => m.demora).filter((d) => d != null);
  if (!vals.length) return { cantidad: 0 };
  return {
    cantidad: vals.length,
    promedio: vals.reduce((s, v) => s + v, 0) / vals.length,
    mediana: median(vals),
    p90: percentile(vals, 90),
    maximo: Math.max(...vals),
    minimo: Math.min(...vals),
  };
}

export const TRAMOS = [
  { nombre: 'Menos de 1 min', hasta: MIN },
  { nombre: '1 a 5 min', hasta: 5 * MIN },
  { nombre: '5 a 15 min', hasta: 15 * MIN },
  { nombre: '15 a 30 min', hasta: 30 * MIN },
  { nombre: 'Más de 30 min', hasta: Infinity },
];

// Demoras de las partidas conciliadas:
//  COBRO: desde que entra el dinero hasta que se acreditan las fichas.
//  PAGO: desde que se retiran las fichas hasta que sale el dinero.
export function tiempos(res, turnos = DEFAULT_TURNOS) {
  const out = {};
  for (const tipo of ['COBRO', 'PAGO']) {
    const ms = res.matches.filter((m) => m.tipo === tipo && m.panel.length && m.billetera.length && m.demora != null);
    const tsPanel = (m) => m.panel[0].ts;
    const by = (fn) =>
      [...groupBy(ms, fn)].map(([k, list]) => ({ clave: k, ...stats(list) })).sort((a, b) => String(a.clave).localeCompare(String(b.clave)));
    const tramos = TRAMOS.map((t) => ({ nombre: t.nombre, cantidad: 0 }));
    for (const m of ms) {
      const d = Math.max(0, m.demora);
      tramos.find((t, i) => d < TRAMOS[i].hasta).cantidad += 1;
    }
    out[tipo] = {
      general: stats(ms),
      porTurno: by((m) => turnoDe(tsPanel(m), turnos)),
      porCajero: by((m) => m.panel[0].cuenta || '(sin agente)'),
      porCuenta: by((m) => `${m.billetera[0].origen} ${m.billetera[0].cuenta}`.trim()),
      tramos,
      lentas: [...ms].sort((a, b) => b.demora - a.demora).slice(0, 20),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exportación

const TIPO_TXT = { COBRO: 'COBRO', PAGO: 'PAGO', BONO: 'BONO', INTERNO: 'INTERNO', COMISION: 'COMISIÓN', REVERTIDO: 'REVERTIDO' };

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  row.alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map((c) => ({ header: c.h, key: c.k, width: c.w || 14, style: c.money ? { numFmt: '#,##0.00' } : {} }));
  for (const r of rows) ws.addRow(r);
  styleHeader(ws);
  return ws;
}

const recCols = (prefix = '') => [
  { h: `${prefix}Fecha`, k: 'fecha', w: 11 },
  { h: `${prefix}Hora`, k: 'hora', w: 9 },
  { h: `${prefix}Origen`, k: 'origen', w: 12 },
  { h: `${prefix}Agente / Cuenta`, k: 'cuenta', w: 18 },
  { h: `${prefix}Usuario / Titular`, k: 'persona', w: 28 },
  { h: `${prefix}Operación`, k: 'tipo', w: 10 },
  { h: `${prefix}Monto`, k: 'monto', w: 13, money: true },
  { h: `${prefix}Referencia`, k: 'ref', w: 24 },
];

function recRow(r, turnos) {
  return {
    fecha: fmtDate(r.ts),
    hora: horaDe(r),
    turno: r.sinHora ? r.turno || '' : turnoDe(r.ts, turnos),
    origen: r.origen,
    cuenta: r.cuenta,
    persona: r.persona,
    tipo: TIPO_TXT[r.tipo] || r.tipo,
    monto: r.tipo === 'PAGO' ? -r.monto : r.monto,
    ref: r.ref,
    detalle: r.detalle,
  };
}

const joinF = (list, f) => list.map(f).join(' + ');

export async function exportarExcel({ res, resumenData, tiemposData, panel, billetera, diccionario, turnos, titulo }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Conciliador de Fichas';
  wb.created = new Date();

  // Resumen
  const ws = wb.addWorksheet('Resumen');
  ws.columns = [{ width: 42 }, { width: 18 }, { width: 18 }, { width: 18 }];
  ws.addRow([titulo || 'Conciliación']).font = { bold: true, size: 14 };
  ws.addRow([]);
  const hdr = ws.addRow(['Concepto', 'Panel (fichas)', 'Billeteras (dinero)', 'Diferencia']);
  hdr.font = { bold: true };
  const rp = resumenData.panel;
  const rb = resumenData.billetera;
  for (const [txt, a, b] of [
    ['Cobros / cargas de fichas', rp.cobros, rb.cobros],
    ['Pagos / retiros de fichas', rp.pagos, rb.pagos],
    ['Neto (cobros - pagos)', rp.neto, rb.neto],
    ['Cantidad de cobros', rp.nCobros, rb.nCobros],
    ['Cantidad de pagos', rp.nPagos, rb.nPagos],
    ['Bonificaciones (fichas sin dinero)', rp.bonos, null],
    ['Movimientos internos', null, rb.internos],
    ['Comisiones', null, rb.comisiones],
  ]) {
    const row = ws.addRow([txt, a, b, a != null && b != null ? round2(a - b) : null]);
    [2, 3, 4].forEach((c) => (row.getCell(c).numFmt = '#,##0.00'));
  }
  ws.addRow([]);
  ws.addRow(['Estado', 'Cantidad', 'Monto panel', 'Monto billeteras']).font = { bold: true };
  for (const e of resumenData.porEstado) {
    const row = ws.addRow([e.estado, e.cantidad, e.montoPanel, e.montoBilletera]);
    [3, 4].forEach((c) => (row.getCell(c).numFmt = '#,##0.00'));
  }
  ws.addRow([]);
  ws.addRow(['Demoras', 'Promedio', 'Mediana', 'Máximo']).font = { bold: true };
  for (const [tipo, txt] of [
    ['COBRO', 'Cobro → carga de fichas'],
    ['PAGO', 'Retiro de fichas → pago'],
  ]) {
    const g = tiemposData[tipo].general;
    ws.addRow([`${txt} (${g.cantidad || 0} partidas)`, fmtDuration(g.promedio), fmtDuration(g.mediana), fmtDuration(g.maximo)]);
  }

  // Conciliación
  addSheet(
    wb,
    'Conciliación',
    [
      { h: 'Estado', k: 'estado', w: 26 },
      { h: 'Confianza', k: 'confianza', w: 10 },
      { h: 'Operación', k: 'tipo', w: 10 },
      { h: 'Turno', k: 'turno', w: 14 },
      { h: 'Panel fecha', k: 'pFecha', w: 11 },
      { h: 'Panel hora', k: 'pHora', w: 9 },
      { h: 'Panel', k: 'pOrigen', w: 10 },
      { h: 'Agente', k: 'pCuenta', w: 16 },
      { h: 'Usuario', k: 'pPersona', w: 18 },
      { h: 'Monto panel', k: 'montoPanel', w: 13, money: true },
      { h: 'Billetera hora', k: 'wHora', w: 9 },
      { h: 'Billetera', k: 'wOrigen', w: 12 },
      { h: 'Cuenta', k: 'wCuenta', w: 16 },
      { h: 'Titular', k: 'wPersona', w: 28 },
      { h: 'Monto billetera', k: 'montoBilletera', w: 13, money: true },
      { h: 'Diferencia', k: 'diferencia', w: 12, money: true },
      { h: 'Demora', k: 'demora', w: 12 },
      { h: 'Demora (min)', k: 'demoraMin', w: 10 },
      { h: 'Nota', k: 'nota', w: 30 },
      { h: 'Ref. panel', k: 'pRef', w: 16 },
      { h: 'Ref. billetera', k: 'wRef', w: 28 },
    ],
    res.matches.map((m) => ({
      estado: m.estado,
      confianza: m.confianza,
      tipo: m.tipo,
      turno: turnoDe(m.panel[0]?.ts ?? m.ts, turnos),
      pFecha: m.panel[0] ? fmtDate(m.panel[0].ts) : '',
      pHora: joinF(m.panel, horaDe),
      pOrigen: m.panel[0]?.origen || '',
      pCuenta: joinF(m.panel, (r) => r.cuenta),
      pPersona: joinF(m.panel, (r) => r.persona),
      montoPanel: m.montoPanel,
      wHora: joinF(m.billetera, horaDe),
      wOrigen: m.billetera[0]?.origen || '',
      wCuenta: joinF(m.billetera, (r) => r.cuenta),
      wPersona: joinF(m.billetera, (r) => r.persona),
      montoBilletera: m.montoBilletera,
      diferencia: m.diferencia,
      demora: fmtDuration(m.demora),
      demoraMin: m.demora == null ? null : round2(m.demora / MIN),
      nota: m.nota,
      pRef: joinF(m.panel, (r) => r.ref),
      wRef: joinF(m.billetera, (r) => r.ref),
    }))
  );

  // Pendientes
  addSheet(
    wb,
    'Pendientes',
    [{ h: 'Estado', k: 'estado', w: 28 }, { h: 'Lado', k: 'lado', w: 10 }, { h: 'Turno', k: 'turno', w: 14 }, ...recCols(), { h: 'Detalle', k: 'detalle', w: 24 }, { h: 'Nota', k: 'nota', w: 30 }],
    res.pendientes.map((p) => ({ estado: p.estado, lado: p.registro.lado, nota: p.nota, ...recRow(p.registro, turnos) }))
  );

  // Tiempos
  const wt = wb.addWorksheet('Tiempos');
  wt.columns = [{ width: 34 }, { width: 10 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  for (const [tipo, txt] of [
    ['COBRO', 'COBROS: desde que entra el dinero hasta que se cargan las fichas'],
    ['PAGO', 'PAGOS: desde que se retiran las fichas hasta que sale el dinero'],
  ]) {
    const t = tiemposData[tipo];
    wt.addRow([txt]).font = { bold: true, size: 12 };
    for (const [sub, list] of [
      ['General', [{ clave: 'Todas', ...t.general }]],
      ['Por turno', t.porTurno],
      ['Por cajero / agente', t.porCajero],
      ['Por cuenta de billetera', t.porCuenta],
    ]) {
      wt.addRow([sub, 'Partidas', 'Promedio', 'Mediana', 'Percentil 90', 'Máximo']).font = { bold: true };
      for (const s of list) wt.addRow([s.clave, s.cantidad, fmtDuration(s.promedio), fmtDuration(s.mediana), fmtDuration(s.p90), fmtDuration(s.maximo)]);
    }
    wt.addRow(['Distribución', 'Partidas']).font = { bold: true };
    for (const tr of t.tramos) wt.addRow([tr.nombre, tr.cantidad]);
    wt.addRow([]);
  }

  // Bases planas
  const baseCols = [...recCols(), { h: 'Turno', k: 'turno', w: 14 }, { h: 'Detalle', k: 'detalle', w: 28 }];
  addSheet(wb, 'Base panel', baseCols, [...panel].sort((a, b) => a.ts - b.ts).map((r) => recRow(r, turnos)));
  addSheet(wb, 'Base billeteras', baseCols, [...billetera].sort((a, b) => a.ts - b.ts).map((r) => recRow(r, turnos)));

  // Diccionario
  const dic = [];
  for (const e of Object.values(diccionario || {})) {
    for (const n of Object.values(e.nombres)) dic.push({ usuario: e.usuario, nombre: n.nombre, veces: n.veces });
  }
  dic.sort((a, b) => a.usuario.localeCompare(b.usuario));
  addSheet(wb, 'Usuarios y titulares', [{ h: 'Usuario panel', k: 'usuario', w: 22 }, { h: 'Titular billetera', k: 'nombre', w: 34 }, { h: 'Veces', k: 'veces', w: 8 }], dic);

  return wb.xlsx.writeBuffer();
}

export { ESTADOS };
