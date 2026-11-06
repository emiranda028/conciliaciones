// Motivo probable de cada pendiente: ayuda a separar lo que falta cargar (una billetera, las
// capturas de un turno, otro agente) de lo que hay que revisar a mano (un par posible que no se
// unió solo).
import { MIN, HORA, DIA, fmtDateTime, fmtMoney } from './util.js';
import { ESTADOS } from './matcher.js';

export const MOTIVOS = {
  SIN_BILLETERA: 'Falta billetera en ese horario',
  POSIBLE_PAR: 'Posible par (revisar a mano)',
  OTRO_AGENTE: 'Puede ser de otro agente',
  SIN_MONTO: 'Sin movimiento con ese monto',
  SIN_PANEL: 'Sin panel en ese horario',
};

const PENDIENTES_REALES = new Set([ESTADOS.FICHA_SIN_COBRO, ESTADOS.RETIRO_SIN_PAGO, ESTADOS.COBRO_SIN_FICHA, ESTADOS.PAGO_SIN_RETIRO]);
const iguales = (a, b, params) => Math.abs(a - b) <= (params?.toleranciaMonto ?? 0.01);
const hora = (r) => (r.sinHora ? `${fmtDateTime(r.ts).slice(0, 10)} s/h` : fmtDateTime(r.ts).slice(0, 16));
const quien = (r) => [r.persona, r.cuenta].filter(Boolean).join(' · ');

// Horarios que cubre cada billetera (cuenta): de su primer a su último movimiento con hora, y las
// franjas del turno de las capturas sin hora. Con un margen de media hora.
function cobertura(registros) {
  const porCuenta = new Map();
  for (const r of registros) {
    // Por cuenta y por día: un reporte de varios días no cubre las horas entre un día y otro.
    const k = `${r.origen}|${r.cuenta}|${Math.floor(r.ts / DIA)}`;
    if (!porCuenta.has(k)) porCuenta.set(k, { min: Infinity, max: -Infinity, franjas: [] });
    const c = porCuenta.get(k);
    if (r.sinHora) {
      const inicio = r.ts - (((r.ts % DIA) + DIA) % DIA);
      c.franjas.push(...(r.franjas || [[inicio, inicio + DIA]]));
    } else {
      c.min = Math.min(c.min, r.ts);
      c.max = Math.max(c.max, r.ts);
    }
  }
  const tramos = [];
  for (const c of porCuenta.values()) {
    if (c.min <= c.max) tramos.push([c.min - 30 * MIN, c.max + 30 * MIN]);
    tramos.push(...c.franjas);
  }
  return (ts) => tramos.some(([d, h]) => ts >= d && ts < h);
}

// Por qué no se unió un par posible.
function razon(p, w, params) {
  if (w.sinHora || p.sinHora) return 'sin hora y con más de un candidato posible';
  const dif = Math.round(Math.abs(p.ts - w.ts) / MIN);
  if (p.tipo === 'COBRO' && w.ts > p.ts + (params?.toleranciaRelojMin ?? 2) * MIN) return `la plata figura ${dif} min después de la carga`;
  if (p.tipo === 'PAGO' && w.ts < p.ts - (params?.toleranciaRelojMin ?? 2) * MIN) return `el pago figura ${dif} min antes del retiro`;
  const max = p.tipo === 'COBRO' ? params?.demoraMaxCobroMin ?? 30 : params?.demoraMaxPagoMin ?? 60;
  if (dif > max) return `${dif} min de diferencia (máximo ${max})`;
  return 'otro movimiento igual compite por el mismo par';
}

// res: resultado de conciliar (vista del día); panel/billetera: todos los movimientos usados;
// excluidos: movimientos de panel de otros agentes (filtrados por línea o agente).
export function diagnosticar(res, { panel = [], billetera = [], excluidos = [], params = {} } = {}) {
  const libres = new Set(res.pendientes.map((p) => p.registro.id));
  const pendP = res.pendientes.filter((p) => p.registro.lado === 'panel').map((p) => p.registro);
  const pendW = res.pendientes.filter((p) => p.registro.lado !== 'panel').map((p) => p.registro);
  const cubreBilletera = cobertura(billetera);
  const cubrePanel = cobertura(panel.filter((r) => !r.sinHora));
  const cerca = (a, b) => (a.sinHora || b.sinHora ? Math.abs(a.ts - b.ts) < DIA : Math.abs(a.ts - b.ts) <= 3 * HORA);
  const out = new Map();
  for (const p of res.pendientes) {
    if (!PENDIENTES_REALES.has(p.estado)) continue;
    const r = p.registro;
    const delPanel = r.lado === 'panel';
    const otros = delPanel ? pendW : pendP;
    const par = otros
      .filter((o) => o.tipo === r.tipo && libres.has(o.id) && iguales(o.monto, r.monto, params) && cerca(o, r))
      .sort((a, b) => Math.abs(a.ts - r.ts) - Math.abs(b.ts - r.ts))[0];
    if (par) {
      const [pp, ww] = delPanel ? [r, par] : [par, r];
      out.set(r.id, { motivo: MOTIVOS.POSIBLE_PAR, detalle: `${quien(par)} ${hora(par)}: ${razon(pp, ww, params)}` });
      continue;
    }
    if (!delPanel) {
      const ajeno = excluidos
        .filter((o) => o.tipo === r.tipo && iguales(o.monto, r.monto, params) && cerca(o, r))
        .sort((a, b) => Math.abs(a.ts - r.ts) - Math.abs(b.ts - r.ts))[0];
      if (ajeno) {
        out.set(r.id, { motivo: MOTIVOS.OTRO_AGENTE, detalle: `${ajeno.persona || '?'} de ${ajeno.cuenta || '?'} ${hora(ajeno)}, $${fmtMoney(ajeno.monto)}` });
        continue;
      }
      if (!r.sinHora && !cubrePanel(r.ts)) {
        out.set(r.id, { motivo: MOTIVOS.SIN_PANEL, detalle: 'no hay movimientos de panel cargados a esa hora' });
        continue;
      }
      out.set(r.id, { motivo: MOTIVOS.SIN_MONTO, detalle: `en el panel no hay un ${r.tipo === 'COBRO' ? 'cobro' : 'pago'} de $${fmtMoney(r.monto)} cerca de esa hora` });
      continue;
    }
    if (!cubreBilletera(r.ts)) {
      out.set(r.id, { motivo: MOTIVOS.SIN_BILLETERA, detalle: 'ninguna billetera cargada cubre esa hora: falta el reporte o las capturas de ese turno' });
      continue;
    }
    out.set(r.id, {
      motivo: MOTIVOS.SIN_MONTO,
      detalle: `hay billeteras de ese horario pero ninguna con un ${r.tipo === 'COBRO' ? 'ingreso' : 'pago'} de $${fmtMoney(r.monto)}: puede faltar una billetera o una captura`,
    });
  }
  return out;
}

// Cantidad de pendientes por motivo, para el resumen.
export function resumenMotivos(diag) {
  const c = {};
  for (const d of diag.values()) c[d.motivo] = (c[d.motivo] || 0) + 1;
  return Object.values(MOTIVOS)
    .filter((m) => c[m])
    .map((m) => ({ motivo: m, cantidad: c[m] }));
}

