// Motor de conciliación panel (fichas) <-> billeteras (dinero).
//
// Reglas del negocio:
//  - COBRO: primero entra el dinero a la billetera y unos minutos después se cargan las fichas.
//  - PAGO: primero se retiran las fichas del panel y después sale el dinero de la billetera.
//  - A veces hay bonificación: el panel carga un 10% o 20% más de lo cobrado.
//  - El usuario del panel ("lucas0576") y el titular de la billetera ("Lucas Julian Quintana")
//    no coinciden textualmente; se usa un diccionario aprendido y una pista por nombre.
import { MIN, norm, nameTokens, round2 } from './util.js';

export const DEFAULT_PARAMS = {
  demoraMaxCobroMin: 30, // máx. entre el cobro en billetera y la carga de fichas
  demoraMaxPagoMin: 60, // máx. entre el retiro de fichas y el pago
  toleranciaRelojMin: 3, // se acepta que el orden aparezca invertido por hasta estos minutos
  bonificaciones: [10, 20], // % extra de fichas sobre el monto cobrado
  toleranciaMonto: 0.5, // diferencia máxima en $ para considerar montos iguales
  agrupar: true, // buscar 2 movimientos que sumen el monto del otro lado
  duplicadoMaxMin: 60, // ventana para marcar pagos duplicados
};

export const ESTADOS = {
  CONCILIADO: 'Conciliado',
  BONIFICACION: 'Conciliado con bonificación',
  AGRUPADO: 'Conciliado agrupado',
  COMPENSADO: 'Compensado (carga y retiro netos)',
  MANUAL: 'Conciliado manual',
  COBRO_SIN_FICHA: 'Ingreso sin identificar',
  FICHA_SIN_COBRO: 'Fichas cargadas sin cobro',
  RETIRO_SIN_PAGO: 'Fichas retiradas sin pago',
  PAGO_SIN_RETIRO: 'Pago sin retiro de fichas',
  PAGO_DUPLICADO: 'Pago duplicado',
  BONO: 'Bonificación de fichas',
  INTERNO: 'Movimiento interno',
  COMISION: 'Comisión',
  REVERTIDO: 'Operación revertida',
};

const MATCHABLE = new Set(['COBRO', 'PAGO']);

// Diccionario usuario -> { nombreNormalizado: {nombre, veces} }
export function nameKey(s) {
  return nameTokens(s).join(' ');
}

function mappedNames(dicc, usuario) {
  const e = dicc[norm(usuario)];
  return e ? e.nombres : null;
}

// Pista débil: "santi7342c" ~ "SANTIAGO MIGUEL BOSSI FRIAS", "Zapata3957x" ~ "... ZAPATA".
export function nameHint(usuario, nombre) {
  const letters = String(usuario || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[a-z]+/g);
  if (!letters) return false;
  const toks = nameTokens(nombre);
  for (const l of letters) {
    if (l.length < 4) continue;
    for (const t of toks) {
      if (t.length < 3) continue;
      if (t.startsWith(l) || l.startsWith(t) || (l.length >= 5 && t.includes(l))) return true;
      // Un error de tipeo: "serio" ~ "sergio".
      if (l.length >= 5 && (lev(l, t.slice(0, l.length)) <= 1 || lev(l, t.slice(0, l.length + 1)) <= 1)) return true;
    }
  }
  return false;
}

function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Relación de nombre entre un movimiento de panel y uno de billetera.
// 'conocido' (diccionario coincide), 'distinto' (diccionario dice otro), 'pista', o null.
function nameRelation(dicc, p, w) {
  if (!w.persona) return null;
  const known = mappedNames(dicc, p.persona);
  const wk = nameKey(w.persona);
  if (known && Object.keys(known).length) {
    if (known[wk]) return 'conocido';
    return nameHint(p.persona, w.persona) ? 'pista' : 'distinto';
  }
  return nameHint(p.persona, w.persona) ? 'pista' : null;
}

// Demora "lógica" en ms: positiva cuando el orden es el esperado.
export function demora(p, w) {
  return p.tipo === 'COBRO' ? p.ts - w.ts : w.ts - p.ts;
}

function amountRelation(pMonto, wMonto, params, tipo) {
  if (Math.abs(pMonto - wMonto) <= params.toleranciaMonto) return { tipo: 'exacto' };
  // La bonificación solo existe al cargar fichas.
  if (tipo !== 'COBRO') return null;
  for (const b of params.bonificaciones) {
    if (Math.abs(pMonto - round2(wMonto * (1 + b / 100))) <= params.toleranciaMonto + wMonto * 0.001) {
      return { tipo: 'bonificacion', pct: b };
    }
  }
  return null;
}

function inWindow(p, w, params) {
  const d = demora(p, w);
  const max = (p.tipo === 'COBRO' ? params.demoraMaxCobroMin : params.demoraMaxPagoMin) * MIN;
  return d >= -params.toleranciaRelojMin * MIN && d <= max;
}

function scorePair(p, w, amount, rel, params) {
  const d = demora(p, w);
  let s = 100;
  s -= Math.abs(d) / MIN; // 1 punto por minuto de demora
  if (d < 0) s -= 5; // orden invertido
  if (amount.tipo !== 'exacto') s -= 15;
  if (rel === 'conocido') s += 60;
  else if (rel === 'pista') s += 25;
  else if (rel === 'distinto') s -= 45;
  if (p.cuenta && w.cuenta && params.cuentasPorAgente) {
    const esperadas = params.cuentasPorAgente[norm(p.cuenta)];
    if (esperadas && esperadas.includes(norm(w.cuenta))) s += 10;
  }
  return s;
}

// Índice por tipo y tiempo para no comparar todos contra todos.
function sortedByTs(list) {
  return [...list].sort((a, b) => a.ts - b.ts);
}

function lowerBound(arr, ts) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function candidatesFor(p, walletSorted, params) {
  const maxLag = Math.max(params.demoraMaxCobroMin, params.demoraMaxPagoMin) * MIN;
  const tol = params.toleranciaRelojMin * MIN;
  const from = p.ts - maxLag - tol;
  const to = p.ts + maxLag + tol;
  const out = [];
  for (let i = lowerBound(walletSorted, from); i < walletSorted.length && walletSorted[i].ts <= to; i += 1) {
    const w = walletSorted[i];
    if (w.tipo === p.tipo && inWindow(p, w, params)) out.push(w);
  }
  return out;
}

// Conciliación automática 1 a 1 (con bonificación) + agrupados 2 a 1 / 1 a 2.
// manual: { forzados: [{panel:[ids], billetera:[ids], nota}], estados: {id: {estado, nota}}, rechazados: ["pid|wid"] }
export function conciliar(panel, billetera, { params = DEFAULT_PARAMS, diccionario = {}, manual = {} } = {}) {
  params = { ...DEFAULT_PARAMS, ...params };
  const usados = new Set();
  const matches = [];
  const rechazados = new Set(manual.rechazados || []);
  const byId = new Map([...panel, ...billetera].map((r) => [r.id, r]));

  // 1) Conciliaciones manuales primero: mandan sobre lo automático.
  for (const f of manual.forzados || []) {
    const ps = f.panel.map((id) => byId.get(id)).filter(Boolean);
    const ws = f.billetera.map((id) => byId.get(id)).filter(Boolean);
    if (!ps.length && !ws.length) continue;
    if ([...ps, ...ws].some((r) => usados.has(r.id))) continue;
    [...ps, ...ws].forEach((r) => usados.add(r.id));
    matches.push(buildMatch(ps, ws, ESTADOS.MANUAL, f.nota || ''));
  }
  const estadosManuales = manual.estados || {};
  for (const id of Object.keys(estadosManuales)) if (byId.has(id)) usados.add(id);

  const pLibres = () => panel.filter((r) => MATCHABLE.has(r.tipo) && !usados.has(r.id));
  const wSorted = sortedByTs(billetera.filter((r) => MATCHABLE.has(r.tipo)));

  // 2) Pares 1 a 1. Dos rondas: la segunda usa lo aprendido en la primera.
  let dicc = cloneDicc(diccionario);
  for (let ronda = 0; ronda < 2; ronda += 1) {
    const pares = [];
    for (const p of pLibres()) {
      for (const w of candidatesFor(p, wSorted, params)) {
        if (usados.has(w.id) || rechazados.has(`${p.id}|${w.id}`)) continue;
        const amount = amountRelation(p.monto, w.monto, params, p.tipo);
        if (!amount) continue;
        const rel = nameRelation(dicc, p, w);
        pares.push({ p, w, amount, rel, score: scorePair(p, w, amount, rel, params) });
      }
    }
    // En la primera ronda solo se aceptan pares "seguros": con nombre confirmado o
    // únicos (un solo candidato para ambos lados). El resto espera a la segunda ronda.
    const candP = new Map();
    const candW = new Map();
    for (const x of pares) {
      candP.set(x.p.id, (candP.get(x.p.id) || 0) + 1);
      candW.set(x.w.id, (candW.get(x.w.id) || 0) + 1);
    }
    pares.sort((a, b) => b.score - a.score);
    for (const x of pares) {
      if (usados.has(x.p.id) || usados.has(x.w.id)) continue;
      const seguro =
        x.rel === 'conocido' || x.rel === 'pista' || (candP.get(x.p.id) === 1 && candW.get(x.w.id) === 1);
      if (ronda === 0 && (!seguro || x.rel === 'distinto')) continue;
      usados.add(x.p.id);
      usados.add(x.w.id);
      const estado = x.amount.tipo === 'bonificacion' ? ESTADOS.BONIFICACION : ESTADOS.CONCILIADO;
      const nota = x.amount.tipo === 'bonificacion' ? `Bonificación ${x.amount.pct}%` : '';
      const m = buildMatch([x.p], [x.w], estado, nota);
      m.confianza = confianza(x);
      matches.push(m);
    }
    dicc = aprender(dicc, matches);
  }

  // 3) Agrupados: dos cobros/pagos que suman una sola operación del otro lado (o al revés).
  if (params.agrupar) {
    agrupar(pLibres(), wSorted.filter((w) => !usados.has(w.id)), params, dicc, usados, matches);
    compensar(pLibres(), wSorted.filter((w) => !usados.has(w.id)), params, dicc, usados, matches);
  }

  // 4) Lo que quedó suelto se clasifica.
  const pendientes = [];
  for (const r of panel) {
    if (usados.has(r.id) && !estadosManuales[r.id]) continue;
    pendientes.push(clasificarSuelto(r, estadosManuales[r.id]));
  }
  const pagosConciliados = matches.flatMap((m) => m.billetera).filter((w) => w.tipo === 'PAGO');
  const sueltosW = billetera.filter((r) => !usados.has(r.id) || estadosManuales[r.id]);
  for (const r of sueltosW) {
    const man = estadosManuales[r.id];
    if (!man && r.tipo === 'PAGO' && esDuplicado(r, pagosConciliados, sueltosW, params)) {
      pendientes.push({ registro: r, estado: ESTADOS.PAGO_DUPLICADO, nota: '', automatico: true });
      continue;
    }
    pendientes.push(clasificarSuelto(r, man));
  }

  matches.sort((a, b) => a.ts - b.ts);
  pendientes.sort((a, b) => a.registro.ts - b.registro.ts);
  return { matches, pendientes, diccionario: dicc };
}

function confianza(x) {
  if (x.rel === 'conocido') return 'alta';
  if (x.rel === 'distinto') return 'baja';
  if (x.rel === 'pista' || x.amount.tipo === 'exacto') return x.score >= 85 ? 'alta' : 'media';
  return 'media';
}

function buildMatch(ps, ws, estado, nota) {
  const all = [...ps, ...ws];
  const ts = Math.min(...all.map((r) => r.ts));
  const montoPanel = round2(ps.reduce((s, r) => s + r.monto, 0));
  const montoBilletera = round2(ws.reduce((s, r) => s + r.monto, 0));
  let dem = null;
  if (ps.length && ws.length) {
    const tipo = (ps[0] || ws[0]).tipo;
    const pTs = tipo === 'COBRO' ? Math.max(...ps.map((r) => r.ts)) : Math.min(...ps.map((r) => r.ts));
    const wTs = tipo === 'COBRO' ? Math.min(...ws.map((r) => r.ts)) : Math.max(...ws.map((r) => r.ts));
    dem = tipo === 'COBRO' ? pTs - wTs : wTs - pTs;
  }
  return {
    id: `${ps.map((r) => r.id).join('+')}=${ws.map((r) => r.id).join('+')}`,
    tipo: (ps[0] || ws[0]).tipo,
    panel: ps,
    billetera: ws,
    estado,
    nota,
    ts,
    montoPanel,
    montoBilletera,
    diferencia: round2(montoPanel - montoBilletera),
    demora: dem,
    confianza: estado === ESTADOS.MANUAL ? 'manual' : 'media',
  };
}

function cloneDicc(d) {
  const out = {};
  for (const [k, v] of Object.entries(d || {})) out[k] = { usuario: v.usuario, nombres: { ...v.nombres } };
  return out;
}

// Suma al diccionario los pares usuario<->titular de conciliaciones confiables.
export function aprender(dicc, matches) {
  const out = cloneDicc(dicc);
  for (const m of matches) {
    if (m.panel.length !== 1 || m.billetera.length !== 1) continue;
    if (!(m.confianza === 'alta' || m.confianza === 'manual')) continue;
    const p = m.panel[0];
    const w = m.billetera[0];
    if (!p.persona || !w.persona) continue;
    const k = norm(p.persona);
    const e = out[k] || (out[k] = { usuario: p.persona, nombres: {} });
    const wk = nameKey(w.persona);
    if (!e.nombres[wk]) e.nombres[wk] = { nombre: w.persona, veces: 0 };
    e.nombres[wk].veces += 1;
  }
  return out;
}

function agrupar(pLibres, wLibres, params, dicc, usados, matches) {
  const free = (r) => !usados.has(r.id);
  const pSorted = sortedByTs(pLibres);
  // Un movimiento de panel = dos de billetera.
  for (const p of pSorted) {
    if (!free(p)) continue;
    const cands = candidatesFor(p, wLibres, params).filter(free);
    const hit = findPair(cands, p.monto, params, (a, b) => sameOrUnknownName(a, b) && nameRelation(dicc, p, a) !== 'distinto');
    if (hit) {
      [p, ...hit].forEach((r) => usados.add(r.id));
      const m = buildMatch([p], hit, ESTADOS.AGRUPADO, 'Dos movimientos de billetera para una operación de panel');
      matches.push(m);
    }
  }
  // Un movimiento de billetera = dos de panel (mismo usuario).
  for (const w of wLibres) {
    if (!free(w)) continue;
    const cands = pSorted.filter((p) => free(p) && p.tipo === w.tipo && inWindow(p, w, params));
    const hit = findPair(cands, w.monto, params, (a, b) => norm(a.persona) === norm(b.persona));
    if (hit) {
      [w, ...hit].forEach((r) => usados.add(r.id));
      matches.push(buildMatch(hit, [w], ESTADOS.AGRUPADO, 'Dos operaciones de panel para un movimiento de billetera'));
    }
  }
}

// Carga y retiro del mismo jugador casi juntos que en la billetera se ven como un solo
// movimiento por la diferencia (p. ej. retira 6000 de fichas, carga 1000 y se le pagan 5000).
function compensar(pLibres, wLibres, params, dicc, usados, matches) {
  const free = (r) => !usados.has(r.id);
  const signo = (r) => (r.tipo === 'COBRO' ? r.monto : -r.monto);
  const ventana = Math.max(params.demoraMaxCobroMin, params.demoraMaxPagoMin) * MIN;
  for (const w of wLibres) {
    if (!free(w) || !w.persona) continue;
    const cands = pLibres.filter((p) => {
      if (!free(p) || Math.abs(p.ts - w.ts) > ventana) return false;
      const rel = nameRelation(dicc, p, w);
      return rel === 'conocido' || rel === 'pista';
    });
    let hit = null;
    for (let i = 0; i < cands.length && !hit; i += 1) {
      for (let j = i + 1; j < cands.length && !hit; j += 1) {
        const a = cands[i];
        const b = cands[j];
        if (a.tipo === b.tipo || norm(a.persona) !== norm(b.persona)) continue;
        if (Math.abs(signo(a) + signo(b) - signo(w)) <= params.toleranciaMonto) hit = [a, b];
      }
    }
    if (hit) {
      [w, ...hit].forEach((r) => usados.add(r.id));
      const m = buildMatch(hit, [w], ESTADOS.COMPENSADO, 'Carga y retiro de fichas netos contra un único movimiento');
      m.montoPanel = round2(hit.reduce((acc, r) => acc + signo(r), 0) * (w.tipo === 'COBRO' ? 1 : -1));
      m.diferencia = round2(m.montoPanel - m.montoBilletera);
      matches.push(m);
    }
  }
}

function sameOrUnknownName(a, b) {
  return !a.persona || !b.persona || nameKey(a.persona) === nameKey(b.persona);
}

function findPair(cands, total, params, ok) {
  for (let i = 0; i < cands.length; i += 1) {
    for (let j = i + 1; j < cands.length; j += 1) {
      if (Math.abs(cands[i].monto + cands[j].monto - total) <= params.toleranciaMonto && ok(cands[i], cands[j])) {
        return [cands[i], cands[j]];
      }
    }
  }
  return null;
}

function esDuplicado(r, pagosConciliados, sueltos, params) {
  const win = params.duplicadoMaxMin * MIN;
  const same = (o) =>
    o.id !== r.id &&
    o.tipo === 'PAGO' &&
    Math.abs(o.monto - r.monto) <= params.toleranciaMonto &&
    nameKey(o.persona) === nameKey(r.persona) &&
    Math.abs(o.ts - r.ts) <= win;
  if (!r.persona) return false;
  if (pagosConciliados.some(same)) return true;
  // Dos pagos sueltos idénticos: el segundo es el duplicado.
  return sueltos.some((o) => same(o) && o.ts < r.ts);
}

function clasificarSuelto(r, man) {
  if (man) return { registro: r, estado: man.estado, nota: man.nota || '', automatico: false };
  let estado;
  if (r.tipo === 'BONO') estado = ESTADOS.BONO;
  else if (r.tipo === 'INTERNO') estado = ESTADOS.INTERNO;
  else if (r.tipo === 'COMISION') estado = ESTADOS.COMISION;
  else if (r.tipo === 'REVERTIDO') estado = ESTADOS.REVERTIDO;
  else if (r.lado === 'panel') estado = r.tipo === 'COBRO' ? ESTADOS.FICHA_SIN_COBRO : ESTADOS.RETIRO_SIN_PAGO;
  else estado = r.tipo === 'COBRO' ? ESTADOS.COBRO_SIN_FICHA : ESTADOS.PAGO_SIN_RETIRO;
  return { registro: r, estado, nota: '', automatico: true };
}
