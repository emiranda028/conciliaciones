// Orquestación: fuentes cargadas -> movimientos -> conciliación -> reportes.
// Sin DOM, para poder probarlo con node.
import { readFile, parsePasted } from './tabular.js';
import { detect, importerByKey, parseGeneric, assignIds, IMPORTERS, LADO } from './importers.js';
import { conciliar, DEFAULT_PARAMS, nameKey } from './matcher.js';
import { resumen, tiempos, filtrarResultado, ventanaDia, diaSugerido, DEFAULT_TURNOS, TURNOS_ANTERIORES, franjasTurno } from './report.js';
import { norm, cleanText, dayFromIso, isoDay, uid } from './util.js';

export const DEFAULT_CONFIG = {
  version: 1,
  params: { ...DEFAULT_PARAMS },
  turnos: DEFAULT_TURNOS.map((t) => ({ ...t })),
  horaInicioDia: 6,
  diccionario: {},
  plantillas: {}, // firma de encabezados -> mapeo genérico
  alias: {}, // código de cuenta -> nombre visible (ej. cuenta de Mercado Pago)
  lineas: [], // [{ nombre, agentes: ['agentez', ...] }] (ver DEFAULT_LINEAS)
  lineaActiva: '',
};

// Líneas de negocio: cada una concilia los agentes de sus paneles contra sus billeteras.
// En GANEMOS y ZEUS vienen mezclados agentes de varias líneas; se filtran por agente.
export const DEFAULT_LINEAS = [
  { nombre: 'AgenteZ', agentes: ['agentez', 'Agentead1'] },
  { nombre: 'AgenteB', agentes: ['agenteb', 'josefina.2332', 'AgenteFB1'] },
  { nombre: 'Agente777', agentes: ['agente777'] },
  { nombre: 'Agente10', agentes: ['agente10'] },
  { nombre: 'Flordeagente', agentes: ['flordeagente'] },
  { nombre: 'Martin', agentes: ['martin'] },
  { nombre: 'Lourdes', agentes: ['lourdes'] },
  { nombre: 'Tatiana', agentes: ['tatiana'] },
  { nombre: 'Oficina01', agentes: ['oficina01'] },
];

export function lineaDeAgente(config, agente) {
  const k = norm(agente);
  return (config.lineas || []).find((l) => l.agentes.some((a) => norm(a) === k)) || null;
}

// Agentes que aparecen en los paneles cargados, con su línea (o sin asignar).
export function agentesDePaneles(fuentes, config) {
  const cuenta = new Map();
  {
    for (const r of dataset(fuentes, config).panel) {
      if (!r.cuenta) continue;
      const e = cuenta.get(norm(r.cuenta)) || { agente: r.cuenta, origenes: new Set(), movimientos: 0 };
      e.origenes.add(r.origen);
      e.movimientos += 1;
      cuenta.set(norm(r.cuenta), e);
    }
  }
  return [...cuenta.values()]
    .map((e) => ({ ...e, origenes: [...e.origenes], linea: lineaDeAgente(config, e.agente)?.nombre || '' }))
    .sort((a, b) => a.linea.localeCompare(b.linea) || b.movimientos - a.movimientos);
}

export function mergeConfig(saved) {
  const c = { ...DEFAULT_CONFIG, ...(saved || {}) };
  c.params = { ...DEFAULT_PARAMS, ...(saved?.params || {}) };
  const turnosViejos = JSON.stringify(saved?.turnos) === JSON.stringify(TURNOS_ANTERIORES);
  c.turnos = saved?.turnos?.length && !turnosViejos ? saved.turnos : DEFAULT_CONFIG.turnos.map((t) => ({ ...t }));
  c.diccionario = saved?.diccionario || {};
  c.plantillas = saved?.plantillas || {};
  c.alias = saved?.alias || {};
  c.lineas = saved?.lineas?.length ? saved.lineas : DEFAULT_LINEAS.map((l) => ({ ...l, agentes: [...l.agentes] }));
  c.lineaActiva = saved?.lineaActiva || '';
  return c;
}

export function headerSignature(rows, headerRow = 0) {
  return (rows[headerRow] || []).map(norm).filter(Boolean).join('|');
}

// Convierte una tabla en una fuente, usando plantillas guardadas o detección automática.
export function tableToFuente(nombre, table, config) {
  const fuente = {
    id: uid('f'),
    nombre,
    hoja: table.sheet,
    rows: table.rows,
    importerKey: null,
    mapping: null,
    activa: true,
  };
  for (let h = 0; h < Math.min(5, table.rows.length); h += 1) {
    const sig = headerSignature(table.rows, h);
    if (sig && config.plantillas[sig]) {
      fuente.importerKey = 'GENERICO';
      fuente.mapping = { ...config.plantillas[sig], headerRow: h };
      break;
    }
  }
  if (!fuente.importerKey) {
    const imp = detect(table.rows);
    fuente.importerKey = imp ? imp.key : null;
  }
  parseFuente(fuente);
  // Hojas de trabajo que no se reconocen quedan desactivadas.
  if (!fuente.importerKey) fuente.activa = false;
  return fuente;
}

export function parseFuente(f) {
  f.records = [];
  f.nombres = null;
  f.skipped = 0;
  f.error = null;
  try {
    if (f.importerKey === 'GENERICO' && f.mapping) {
      const r = parseGeneric(f.rows, f.mapping);
      f.records = r.records;
      f.skipped = r.skipped;
      f.lado = f.mapping.lado;
      f.label = `Columnas mapeadas (${f.mapping.origen || f.mapping.lado})`;
    } else if (f.importerKey) {
      const imp = importerByKey(f.importerKey);
      const r = imp.parse(f.rows);
      f.records = r.records;
      f.skipped = r.skipped;
      f.nombres = r.nombres || null;
      f.lado = imp.lado;
      f.label = imp.label;
    } else {
      f.lado = null;
      f.label = 'No reconocido';
    }
  } catch (e) {
    f.error = e.message || String(e);
    f.records = [];
  }
  const ts = f.records.map((r) => r.ts);
  f.desde = ts.length ? Math.min(...ts) : null;
  f.hasta = ts.length ? Math.max(...ts) : null;
  return f;
}

export async function fuentesDesdeArchivo(nombre, buf, config) {
  const tables = await readFile(nombre, buf);
  return tables.map((t) => tableToFuente(nombre, t, config));
}

export function fuenteDesdeTexto(texto, importerKey, config) {
  const table = { sheet: null, rows: parsePasted(texto) };
  const f = tableToFuente('Texto pegado', table, config);
  if (importerKey && importerKey !== 'AUTO') {
    f.importerKey = importerKey;
    parseFuente(f);
    f.activa = true;
  }
  return f;
}

export const IMPORTER_OPTIONS = IMPORTERS.map((i) => ({ key: i.key, label: i.label, lado: i.lado }));

// Junta los movimientos de las fuentes activas, aplica alias y nombres de retiros MP.
export function dataset(fuentes, config) {
  const activas = fuentes.filter((f) => f.activa);
  const nombresRetiros = {};
  for (const f of activas) if (f.nombres) Object.assign(nombresRetiros, f.nombres);
  const all = [];
  for (const f of activas) {
    for (const r of f.records) {
      const rec = { ...r, fuente: f.hoja ? `${f.nombre} / ${f.hoja}` : f.nombre };
      if (!rec.persona && rec.ref && nombresRetiros[rec.ref]) rec.persona = nombresRetiros[rec.ref];
      const alias = config.alias[norm(rec.cuenta)];
      if (alias) rec.cuenta = alias;
      // Capturas sin hora con turno asignado: el cruce se limita a las horas de ese turno.
      if (rec.sinHora && rec.turno) {
        const fr = franjasTurno((config.turnos || []).find((t) => t.nombre === rec.turno));
        if (fr) {
          const inicio = rec.ts - (((rec.ts % 86400000) + 86400000) % 86400000);
          rec.franjas = fr.map(([a, b]) => [inicio + a, inicio + b]);
          if (fr.length === 1) rec.ts = inicio + Math.round((fr[0][0] + fr[0][1]) / 2);
        }
      }
      all.push(rec);
    }
  }
  // Si la misma operación vino en dos archivos (misma referencia), se deja una sola.
  const seen = new Set();
  const conRef = [];
  for (const r of all) {
    if (!r.ref) continue;
    const k = `${r.origen}|${r.ref}|${r.tipo}`;
    if (seen.has(k)) continue;
    seen.add(k);
    conRef.push(r);
  }
  // Movimientos sin referencia (bases planas armadas a mano) que ya vinieron en un reporte
  // original: mismo lado, tipo, usuario y monto, con menos de un minuto de diferencia.
  const idx = new Map();
  const bucketKey = (r) => `${r.lado}|${r.tipo}|${norm(r.persona)}|${r.monto}`;
  for (const r of conRef) {
    const k = bucketKey(r);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  }
  const usados = new Set();
  const sinRef = [];
  for (const r of all) {
    if (r.ref) continue;
    const match = (idx.get(bucketKey(r)) || []).find((o) => o.fuente !== r.fuente && !usados.has(o) && Math.abs(o.ts - r.ts) <= 60000);
    if (match) {
      usados.add(match);
      continue;
    }
    sinRef.push(r);
  }
  const unique = [...conRef, ...sinRef].sort((a, b) => a.ts - b.ts);
  assignIds(unique);
  return {
    panel: unique.filter((r) => r.lado === LADO.PANEL),
    billetera: unique.filter((r) => r.lado === LADO.BILLETERA),
    duplicadosDescartados: all.length - unique.length,
  };
}

export function sugerirDia(fuentes, config) {
  const recs = fuentes.filter((f) => f.activa && f.lado === LADO.PANEL).flatMap((f) => f.records);
  const d = diaSugerido(recs.length ? recs : fuentes.filter((f) => f.activa).flatMap((f) => f.records), config.horaInicioDia);
  return d == null ? '' : isoDay(d);
}

// Corre todo. dia: 'YYYY-MM-DD' o '' para no filtrar.
export function ejecutar({ fuentes, config, manual, dia, linea }) {
  const ds = dataset(fuentes, config);
  const { billetera, duplicadosDescartados } = ds;
  let { panel } = ds;
  // Línea elegida: solo los movimientos de panel de sus agentes.
  const excluidosLinea = {};
  const l = linea ? (config.lineas || []).find((x) => x.nombre === linea) : null;
  if (l) {
    const agentes = new Set(l.agentes.map(norm));
    panel = panel.filter((r) => {
      if (agentes.has(norm(r.cuenta))) return true;
      const k = r.cuenta || '(sin agente)';
      excluidosLinea[k] = (excluidosLinea[k] || 0) + 1;
      return false;
    });
  }
  const res = conciliar(panel, billetera, { params: config.params, diccionario: config.diccionario, manual });
  const dayMs = dayFromIso(dia);
  const ventana = dayMs == null ? null : ventanaDia(dayMs, config.horaInicioDia);
  const vista = filtrarResultado(res, ventana);
  return {
    panel,
    billetera,
    duplicadosDescartados,
    linea: l ? l.nombre : '',
    excluidosLinea,
    completo: res,
    vista,
    ventana,
    resumen: resumen(vista),
    tiempos: tiempos(vista, config.turnos),
    diccionarioAprendido: res.diccionario,
  };
}

// Une lo aprendido al diccionario guardado sin inflar los contadores al recalcular.
export function unirDiccionario(base, aprendido) {
  const out = {};
  for (const src of [base || {}, aprendido || {}]) {
    for (const [k, e] of Object.entries(src)) {
      const dst = out[k] || (out[k] = { usuario: e.usuario, nombres: {} });
      for (const [nk, n] of Object.entries(e.nombres || {})) {
        const prev = dst.nombres[nk];
        dst.nombres[nk] = { nombre: n.nombre, veces: Math.max(prev?.veces || 0, n.veces || 0) };
      }
    }
  }
  return out;
}

export function agregarAlDiccionario(dicc, usuario, nombre) {
  const out = unirDiccionario(dicc, {});
  const k = norm(usuario);
  const e = out[k] || (out[k] = { usuario: cleanText(usuario), nombres: {} });
  const nk = nameKey(nombre);
  if (!nk) return out;
  e.nombres[nk] = { nombre: cleanText(nombre), veces: Math.max(1, e.nombres[nk]?.veces || 0) };
  return out;
}

export function quitarDelDiccionario(dicc, usuarioKey, nombreKey) {
  const out = unirDiccionario(dicc, {});
  if (!out[usuarioKey]) return out;
  if (nombreKey) delete out[usuarioKey].nombres[nombreKey];
  if (!nombreKey || !Object.keys(out[usuarioKey].nombres).length) delete out[usuarioKey];
  return out;
}

// Importa un Excel/CSV de dos columnas: usuario del panel | titular de la billetera.
export function diccionarioDesdeTabla(rows, dicc) {
  let out = unirDiccionario(dicc, {});
  let n = 0;
  for (const row of rows) {
    const [u, nom] = row.map((c) => cleanText(c ?? ''));
    if (!u || !nom || /usuario/i.test(u)) continue;
    out = agregarAlDiccionario(out, u, nom);
    n += 1;
  }
  return { diccionario: out, agregados: n };
}

// Trabajo guardado (.conciliacion): fuentes ya parseadas + decisiones manuales.
export function serializarTrabajo({ fuentes, manual, dia }) {
  return JSON.stringify({
    tipo: 'conciliador-fichas',
    version: 1,
    guardado: new Date().toISOString(),
    dia,
    manual,
    fuentes: fuentes.map((f) => ({
      nombre: f.nombre,
      hoja: f.hoja,
      importerKey: f.importerKey,
      mapping: f.mapping,
      activa: f.activa,
      rows: f.rows,
    })),
  });
}

export function deserializarTrabajo(text) {
  const data = JSON.parse(text);
  if (data.tipo !== 'conciliador-fichas') throw new Error('El archivo no es un trabajo del Conciliador.');
  const fuentes = data.fuentes.map((f) => {
    const rows = f.rows.map((r) => r.map((c) => (typeof c === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(c) ? new Date(c) : c)));
    return parseFuente({ ...f, rows, id: uid('f') });
  });
  return { fuentes, manual: data.manual || { forzados: [], estados: {}, rechazados: [] }, dia: data.dia || '' };
}
