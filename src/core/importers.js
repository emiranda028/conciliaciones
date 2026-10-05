// Importadores: reconocen cada reporte y lo llevan a la "base plana" común.
//
// Movimiento normalizado:
//   { id, lado: 'panel'|'billetera', origen, cuenta, persona, ts, tipo, monto, ref, detalle, fuente }
//   tipo: COBRO (entra dinero / se cargan fichas) | PAGO (sale dinero / se retiran fichas)
//         BONO (fichas regaladas) | INTERNO (transferencia propia) | COMISION (fee)
//   monto: siempre positivo; el sentido lo da el tipo.
import { norm, cleanText, parseNumber, parseDateTime, parseTimeOfDay, round2 } from './util.js';

export const LADO = { PANEL: 'panel', BILLETERA: 'billetera' };

// Busca la fila de encabezados que contenga todas las columnas pedidas.
// Cada clave puede ser un string o una lista de alternativas; se compara por prefijo normalizado.
function findHeader(rows, keys, { maxScan = 20 } = {}) {
  for (let r = 0; r < Math.min(rows.length, maxScan); r += 1) {
    const cells = rows[r].map(norm);
    const cols = {};
    let ok = true;
    for (const [name, spec] of Object.entries(keys)) {
      const alts = Array.isArray(spec) ? spec : [spec];
      let idx = -1;
      for (const a of alts) {
        idx = cells.findIndex((c) => c === a);
        if (idx < 0) idx = cells.findIndex((c) => c.startsWith(a));
        if (idx >= 0) break;
      }
      if (idx < 0 && !name.startsWith('?')) {
        ok = false;
        break;
      }
      cols[name.replace(/^\?/, '')] = idx;
    }
    if (ok) return { row: r, cols, cells };
  }
  return null;
}

// Como findHeader pero buscando columnas a partir de un ancla (útil cuando la planilla
// tiene columnas calculadas a la izquierda con nombres repetidos: "MONTO" y "Monto").
function findHeaderFrom(rows, anchor, keys, maxScan = 20) {
  for (let r = 0; r < Math.min(rows.length, maxScan); r += 1) {
    const cells = rows[r].map(norm);
    const start = cells.indexOf(anchor);
    if (start < 0) continue;
    const cols = { [anchor]: start };
    let ok = true;
    for (const [name, spec] of Object.entries(keys)) {
      const alts = Array.isArray(spec) ? spec : [spec];
      let idx = -1;
      for (const a of alts) {
        idx = cells.findIndex((c, i) => i >= start && c === a);
        if (idx < 0) idx = cells.findIndex((c) => c === a);
        if (idx >= 0) break;
      }
      if (idx < 0 && !name.startsWith('?')) {
        ok = false;
        break;
      }
      cols[name.replace(/^\?/, '')] = idx;
    }
    if (ok) return { row: r, cols };
  }
  return null;
}

const get = (row, idx) => (idx == null || idx < 0 ? null : row[idx]);

function mk(base) {
  return {
    cuenta: '',
    persona: '',
    ref: '',
    detalle: '',
    ...base,
    monto: round2(Math.abs(base.monto)),
  };
}

// ---------------------------------------------------------------------------
// Panel BETS (export "User Transactions"): dos filas por operación (jugador y agente).
// Nos quedamos con la del jugador.
const bets = {
  key: 'BETS',
  label: 'Panel BETS (User Transactions)',
  lado: LADO.PANEL,
  detect(rows) {
    return findHeader(rows, {
      tipo: 'transactiontype',
      owner: 'ownertype',
      nombre: 'ownername',
      monto: 'amount',
      fecha: 'date',
    })
      ? 100
      : 0;
  },
  parse(rows) {
    const h = findHeader(rows, {
      tipo: 'transactiontype',
      owner: 'ownertype',
      nombre: 'ownername',
      monto: 'amount',
      fecha: 'date',
      '?agente': 'username',
      '?ref': 'transactionid',
      '?nota': 'notes',
    });
    const out = [];
    const skipped = [];
    for (const row of rows.slice(h.row + 1)) {
      if (norm(get(row, h.cols.owner)) !== 'player') continue;
      const tt = norm(get(row, h.cols.tipo));
      const amount = parseNumber(get(row, h.cols.monto));
      const ts = parseDateTime(get(row, h.cols.fecha));
      if (amount == null || ts == null) {
        skipped.push(row);
        continue;
      }
      let tipo;
      if (tt.includes('bonus') || tt.includes('bono')) tipo = 'BONO';
      else if (tt.includes('withdraw')) tipo = 'PAGO';
      else if (tt.includes('deposit')) tipo = 'COBRO';
      else tipo = amount >= 0 ? 'COBRO' : 'PAGO';
      out.push(
        mk({
          lado: LADO.PANEL,
          origen: 'BETS',
          cuenta: cleanText(get(row, h.cols.agente)),
          persona: cleanText(get(row, h.cols.nombre)),
          ts,
          tipo,
          monto: amount,
          ref: cleanText(get(row, h.cols.ref)),
          detalle: cleanText(get(row, h.cols.nota)),
        })
      );
    }
    return { records: out, skipped: skipped.length };
  },
};

// ---------------------------------------------------------------------------
// Panel GANEMOS copiado desde la web. Al pegarlo en Excel queda todo en una columna:
// ID, fecha, operación, iniciador, de, a, monto, saldo (8 renglones por movimiento).
// También acepta el mismo contenido con las columnas separadas.
const OP_GANEMOS = /^(dep[oó]sito|retiro|bonus|bono|bonificaci[oó]n)$/i;

// Si la primera columna es un contador 1..8 (planilla "nro | reporte"), se ignora.
function hasCounterColumn(rows) {
  const sample = rows.slice(0, 60).filter((r) => r.length >= 2);
  if (sample.length < 16) return false;
  const small = sample.filter((r) => /^[1-9]$/.test(String(r[0] ?? '').trim()));
  return small.length >= sample.length * 0.8;
}

function tokensOf(rows) {
  const toks = [];
  const skipFirst = hasCounterColumn(rows);
  for (const row of rows) {
    for (const c of skipFirst ? row.slice(1) : row) {
      if (c == null || c === '') continue;
      if (typeof c === 'string') {
        for (const part of c.split(/\t|\n/)) {
          const t = cleanText(part);
          if (t) toks.push(t);
        }
      } else toks.push(c);
    }
  }
  return toks;
}

function ganemosRecords(rows) {
  const toks = tokensOf(rows);
  const out = [];
  for (let i = 0; i < toks.length - 6; i += 1) {
    const id = toks[i];
    const idStr = typeof id === 'number' ? String(id) : id;
    if (!/^\d{8,}$/.test(String(idStr))) continue;
    const ts = parseDateTime(toks[i + 1]);
    if (ts == null) continue;
    const op = cleanText(toks[i + 2]);
    if (!OP_GANEMOS.test(op)) continue;
    const iniciador = cleanText(toks[i + 3]);
    const de = cleanText(toks[i + 4]);
    const a = cleanText(toks[i + 5]);
    const monto = parseNumber(toks[i + 6]);
    if (monto == null) continue;
    const opn = norm(op);
    const tipo = opn.startsWith('retiro') ? 'PAGO' : opn.startsWith('bon') ? 'BONO' : 'COBRO';
    // El jugador es la contraparte del cajero que inició la operación.
    const persona = a && norm(a) !== norm(iniciador) ? a : de && norm(de) !== norm(iniciador) ? de : a;
    out.push(
      mk({ lado: LADO.PANEL, origen: 'GANEMOS', cuenta: iniciador, persona, ts, tipo, monto, ref: String(idStr), detalle: op })
    );
    i += 6;
  }
  return out;
}

const ganemos = {
  key: 'GANEMOS',
  label: 'Panel GANEMOS (copiado de la web)',
  lado: LADO.PANEL,
  detect(rows) {
    const recs = ganemosRecords(rows.slice(0, 200));
    return recs.length >= 2 ? 90 : recs.length ? 40 : 0;
  },
  parse(rows) {
    return { records: ganemosRecords(rows), skipped: 0 };
  },
};

// ---------------------------------------------------------------------------
// Panel ZEUS: Nro | Fecha | Operación ("DEPOSITO (Solicitado por ...)") | Agente | Destino |
// Depósito | Retiro | Saldo. En los retiros el jugador figura en "Agente".
// Se parsea por patrón de celdas porque al pegar suelen correrse las columnas.
const OP_ZEUS = /^(DEPOSITO|RETIRO|BONUS|BONO)\b/i;

function zeusRecords(rows) {
  const out = [];
  for (const row of rows) {
    const opIdx = row.findIndex((c) => typeof c === 'string' && OP_ZEUS.test(cleanText(c)));
    if (opIdx < 0) continue;
    let ts = null;
    let ref = '';
    for (let j = opIdx - 1; j >= 0; j -= 1) {
      const t = parseDateTime(row[j]);
      if (t != null) {
        if (t < Date.UTC(2000, 0, 1)) break;
        ts = t;
        ref = cleanText(row[j - 1] ?? '');
        break;
      }
    }
    if (ts == null) continue;
    const rest = row.slice(opIdx + 1).filter((c) => c != null && cleanText(c) !== '');
    const [c1, c2, ...nums] = rest;
    const dep = parseNumber(nums[0]);
    const ret = parseNumber(nums[1]);
    const op = cleanText(row[opIdx]);
    const opn = norm(op);
    const tipo = opn.startsWith('retiro') ? 'PAGO' : opn.startsWith('bon') ? 'BONO' : 'COBRO';
    const monto = tipo === 'PAGO' ? (ret ? Math.abs(ret) : Math.abs(dep || 0)) : Math.abs(dep || ret || 0);
    if (!monto) continue;
    const agente = tipo === 'PAGO' ? cleanText(c2) : cleanText(c1);
    const persona = tipo === 'PAGO' ? cleanText(c1) : cleanText(c2);
    out.push(mk({ lado: LADO.PANEL, origen: 'ZEUS', cuenta: agente, persona, ts, tipo, monto, ref, detalle: op }));
  }
  return out;
}

const zeus = {
  key: 'ZEUS',
  label: 'Panel ZEUS',
  lado: LADO.PANEL,
  detect(rows) {
    const recs = zeusRecords(rows.slice(0, 100));
    if (!recs.length) return 0;
    const solicitado = rows.slice(0, 100).some((r) => r.some((c) => typeof c === 'string' && /solicitado por/i.test(c)));
    return solicitado ? 95 : 60;
  },
  parse(rows) {
    return { records: zeusRecords(rows), skipped: 0 };
  },
};

// ---------------------------------------------------------------------------
// Base plana de panel ya armada a mano: DIA | HORA | Operación | agente | NOMBRE | MONTO
const panelPlano = {
  key: 'PANEL_PLANO',
  label: 'Base plana de panel (DIA/HORA/Operación/agente/NOMBRE/MONTO)',
  lado: LADO.PANEL,
  header: { dia: 'dia', hora: 'hora', op: 'operacion', agente: 'agente', nombre: 'nombre', monto: 'monto' },
  detect(rows) {
    const h = findHeader(rows, this.header);
    return h && Object.keys(h.cells.filter(Boolean)).length <= 8 ? 70 : 0;
  },
  parse(rows) {
    const h = findHeader(rows, this.header);
    const out = [];
    let skipped = 0;
    for (const row of rows.slice(h.row + 1)) {
      const day = parseDateTime(get(row, h.cols.dia));
      const tod = parseTimeOfDay(get(row, h.cols.hora));
      const m = parseNumber(get(row, h.cols.monto));
      if (day == null || m == null) {
        skipped += 1;
        continue;
      }
      const dayStart = day - (((day % 86400000) + 86400000) % 86400000);
      const opn = norm(get(row, h.cols.op));
      const tipo = opn.startsWith('bon') ? 'BONO' : opn === 'pago' || opn.startsWith('retiro') || m < 0 ? 'PAGO' : 'COBRO';
      const agente = cleanText(get(row, h.cols.agente));
      const origen = / ZEUS$/i.test(agente) ? 'ZEUS' : 'PANEL';
      out.push(
        mk({
          lado: LADO.PANEL,
          origen,
          cuenta: agente.replace(/ ZEUS$/i, ''),
          persona: cleanText(get(row, h.cols.nombre)),
          ts: dayStart + (tod ?? 0),
          tipo,
          monto: m,
        })
      );
    }
    return { records: out, skipped };
  },
};

// ---------------------------------------------------------------------------
// Billetera "Cash" (reporte con ID Interno / Dirección Entrante-Saliente / COELSA).
const cashKeys = {
  monto: 'monto',
  direccion: 'direccion',
  fecha: 'fecha',
  '?cuenta': 'cuenta',
  '?canal': 'canal',
  '?estado': 'estado',
  '?concepto': 'concepto',
  '?remitente': 'nombreremitente',
  '?destinatario': 'nombredestinatario',
};

const cash = {
  key: 'CASH',
  label: 'Billetera Cash (reporte de movimientos)',
  lado: LADO.BILLETERA,
  detect(rows) {
    return findHeaderFrom(rows, 'idinterno', cashKeys) ? 100 : 0;
  },
  parse(rows) {
    const h = findHeaderFrom(rows, 'idinterno', cashKeys);
    const c = h.cols;
    const out = [];
    let skipped = 0;
    for (const row of rows.slice(h.row + 1)) {
      const monto = parseNumber(get(row, c.monto));
      const ts = parseDateTime(get(row, c.fecha));
      const estado = norm(get(row, c.estado));
      const revertida = estado.startsWith('revert');
      if (monto == null || ts == null || (estado && !revertida && estado !== 'hecha' && estado !== 'aprobada')) {
        skipped += 1;
        continue;
      }
      const entrante = norm(get(row, c.direccion)).startsWith('entr');
      const concepto = cleanText(get(row, c.concepto));
      const canal = norm(get(row, c.canal));
      let tipo = entrante ? 'COBRO' : 'PAGO';
      if (revertida) tipo = 'REVERTIDO';
      else if (norm(concepto) === 'fee') tipo = 'COMISION';
      else if (canal === 'interno') tipo = 'INTERNO';
      out.push(
        mk({
          lado: LADO.BILLETERA,
          origen: 'CASH',
          cuenta: cleanText(get(row, c.cuenta)),
          persona: cleanText(get(row, entrante ? c.remitente : c.destinatario)),
          ts,
          tipo,
          monto,
          ref: cleanText(get(row, c.idinterno)),
          detalle: [concepto, canal === 'interno' ? 'Interno' : ''].filter(Boolean).join(' '),
        })
      );
    }
    return { records: out, skipped };
  },
};

// ---------------------------------------------------------------------------
// Mercado Pago: reporte de actividad / liquidaciones (varias variantes de columnas).
const mpKeys = {
  tipoop: 'tipodeoperacion',
  valor: ['valordelacompra', 'montonetodelaoperacion'],
  '?aprob': 'fechadeaprobacion',
  '?origen': 'fechadeorigen',
  '?cuenta': 'codigodelacuentadelvendedor',
  '?pagador': 'pagador',
};

const mercadoPago = {
  key: 'MP',
  label: 'Billetera Mercado Pago (reporte de operaciones)',
  lado: LADO.BILLETERA,
  detect(rows) {
    return findHeaderFrom(rows, 'iddeoperacionenmercadopago', mpKeys) ? 100 : 0;
  },
  parse(rows) {
    const h = findHeaderFrom(rows, 'iddeoperacionenmercadopago', mpKeys);
    const c = h.cols;
    const out = [];
    let skipped = 0;
    for (const row of rows.slice(h.row + 1)) {
      const valor = parseNumber(get(row, c.valor));
      const ts = parseDateTime(get(row, c.aprob)) ?? parseDateTime(get(row, c.origen));
      const tipoOp = cleanText(get(row, c.tipoop));
      if (valor == null || !valor || ts == null || /rechaz|cancel|pendiente/i.test(tipoOp)) {
        skipped += 1;
        continue;
      }
      out.push(
        mk({
          lado: LADO.BILLETERA,
          origen: 'MERCADO PAGO',
          cuenta: cleanText(get(row, c.cuenta)),
          persona: cleanText(get(row, c.pagador)),
          ts,
          tipo: valor > 0 ? 'COBRO' : 'PAGO',
          monto: valor,
          ref: cleanText(get(row, c.iddeoperacionenmercadopago)),
          detalle: tipoOp,
        })
      );
    }
    return { records: out, skipped };
  },
};

// Reporte de retiros de Mercado Pago: aporta el titular de la cuenta destino de los PAYOUTS.
const mpRetiros = {
  key: 'MP_RETIROS',
  label: 'Mercado Pago: retiros (titulares de cuentas destino)',
  lado: LADO.BILLETERA,
  enrich: true,
  keys: {
    id: 'numeroderetiro',
    titular: 'nombredeltitular',
    '?monto': 'montoamount',
    '?fecha': 'fechadecreacion',
  },
  detect(rows) {
    return findHeader(rows, this.keys) ? 100 : 0;
  },
  parse(rows) {
    const h = findHeader(rows, this.keys);
    const nombres = {};
    for (const row of rows.slice(h.row + 1)) {
      const id = cleanText(get(row, h.cols.id));
      const titular = cleanText(get(row, h.cols.titular));
      if (id && titular) nombres[id] = titular;
    }
    return { records: [], skipped: 0, nombres };
  },
};

// ---------------------------------------------------------------------------
// GANEMOS en tabla (hoja "Consolidado"): ID | FECHA | OPERACIÓN | INICIADOR | DE | A | monto
const ganemosTablaKeys = { fecha: 'fecha', op: 'operacion', iniciador: 'iniciador', de: 'de', a: 'a', monto: 'monto', '?id': 'id' };

const ganemosTabla = {
  key: 'GANEMOS_TABLA',
  label: 'Panel GANEMOS (tabla ID / FECHA / OPERACIÓN / INICIADOR / DE / A)',
  lado: LADO.PANEL,
  detect(rows) {
    const h = findHeader(rows, ganemosTablaKeys);
    return h && h.cols.de >= 0 && h.cells[h.cols.de] === 'de' && h.cells[h.cols.a] === 'a' ? 97 : 0;
  },
  parse(rows) {
    const h = findHeader(rows, ganemosTablaKeys);
    const out = [];
    let skipped = 0;
    for (const row of rows.slice(h.row + 1)) {
      const op = cleanText(get(row, h.cols.op));
      const ts = parseDateTime(get(row, h.cols.fecha));
      const monto = parseNumber(get(row, h.cols.monto));
      if (!OP_GANEMOS.test(op) || ts == null || !monto) {
        if (op || monto) skipped += 1;
        continue;
      }
      const iniciador = cleanText(get(row, h.cols.iniciador));
      const de = cleanText(get(row, h.cols.de));
      const a = cleanText(get(row, h.cols.a));
      const opn = norm(op);
      const tipo = opn.startsWith('retiro') ? 'PAGO' : opn.startsWith('bon') ? 'BONO' : 'COBRO';
      const persona = a && norm(a) !== norm(iniciador) ? a : de && norm(de) !== norm(iniciador) ? de : a;
      out.push(mk({ lado: LADO.PANEL, origen: 'GANEMOS', cuenta: iniciador, persona, ts, tipo, monto, ref: cleanText(get(row, h.cols.id)), detalle: op }));
    }
    return { records: out, skipped };
  },
};

// ---------------------------------------------------------------------------
// Movimientos leídos de capturas de pantalla (ver capturas.js). Solo traen el día, no la hora:
// se ubican al mediodía y se marcan sinHora para que el cruce use el día completo.
const capturas = {
  key: 'CAPTURAS',
  label: 'Billetera: capturas de pantalla (OCR)',
  lado: LADO.BILLETERA,
  detect(rows) {
    return rows[0] && rows[0].some((c) => norm(c) === 'origencapturadepantalla') ? 100 : 0;
  },
  parse(rows) {
    const out = [];
    let skipped = 0;
    for (const row of rows.slice(1)) {
      // Trabajos guardados con versiones anteriores no tienen la columna Leyenda.
      const conLeyenda = norm(rows[0][6]) === 'leyenda';
      const [fecha, titular, op, monto, cuenta, imagen] = row;
      const leyenda = conLeyenda ? cleanText(row[6]) : '';
      const day = parseDateTime(fecha);
      const m = parseNumber(monto);
      if (day == null || !m) {
        skipped += 1;
        continue;
      }
      const nombre = cleanText(titular);
      out.push(
        mk({
          lado: LADO.BILLETERA,
          origen: 'CAPTURA',
          cuenta: cleanText(cuenta),
          persona: nombre.replace(/(\.\.\.|…)$/, '').trim(),
          ts: day - (((day % 86400000) + 86400000) % 86400000) + 12 * 3600000,
          sinHora: true,
          truncado: /(\.\.\.|…)$/.test(nombre),
          tipo: norm(op).startsWith('cobro') ? 'COBRO' : 'PAGO',
          monto: m,
          detalle: leyenda,
          imagen: cleanText(imagen),
        })
      );
    }
    return { records: out, skipped };
  },
};

export const IMPORTERS = [bets, ganemos, ganemosTabla, zeus, cash, mercadoPago, mpRetiros, capturas, panelPlano];

export function importerByKey(key) {
  return IMPORTERS.find((i) => i.key === key) || null;
}

// Devuelve el importador más probable para una tabla (o null si no se reconoce).
// Solo se acepta si al parsear devuelve movimientos (o nombres, en el caso de retiros MP).
export function detect(rows) {
  const scored = [];
  for (const imp of IMPORTERS) {
    let score = 0;
    try {
      score = imp.detect(rows);
    } catch {
      score = 0;
    }
    if (score > 0) scored.push({ imp, score });
  }
  scored.sort((a, b) => b.score - a.score);
  for (const { imp } of scored) {
    try {
      const res = imp.parse(rows);
      if (res.records.length || Object.keys(res.nombres || {}).length) return imp;
    } catch {
      // probar el siguiente
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Importador genérico con mapeo de columnas elegido por el usuario.
// mapping: { lado, origen, headerRow, fecha, hora?, monto, tipo?, persona?, cuenta?, ref?,
//            cobroSi?: texto que identifica cobros en la columna tipo }
export function parseGeneric(rows, mapping) {
  const out = [];
  let skipped = 0;
  const col = (row, k) => (mapping[k] == null || mapping[k] === '' ? null : row[+mapping[k]]);
  for (const row of rows.slice((mapping.headerRow ?? 0) + 1)) {
    let ts = parseDateTime(col(row, 'fecha'));
    const tod = parseTimeOfDay(col(row, 'hora'));
    let monto = parseNumber(col(row, 'monto'));
    if (ts == null || monto == null || monto === 0) {
      skipped += 1;
      continue;
    }
    if (tod != null) ts = ts - (((ts % 86400000) + 86400000) % 86400000) + tod;
    let tipo;
    const tipoTxt = norm(col(row, 'tipo'));
    if (tipoTxt) {
      if (/bon/.test(tipoTxt)) tipo = 'BONO';
      else if (mapping.cobroSi) tipo = tipoTxt.includes(norm(mapping.cobroSi)) ? 'COBRO' : 'PAGO';
      else if (/cobro|deposit|entra|ingres|credit|carga/.test(tipoTxt)) tipo = 'COBRO';
      else if (/pago|retir|sal|egres|debit|descarga/.test(tipoTxt)) tipo = 'PAGO';
    }
    if (!tipo) tipo = monto >= 0 ? 'COBRO' : 'PAGO';
    out.push(
      mk({
        lado: mapping.lado,
        origen: mapping.origen || (mapping.lado === LADO.PANEL ? 'PANEL' : 'BILLETERA'),
        cuenta: cleanText(col(row, 'cuenta')),
        persona: cleanText(col(row, 'persona')),
        ts,
        tipo,
        monto,
        ref: cleanText(col(row, 'ref')),
      })
    );
  }
  return { records: out, skipped };
}

// Asigna ids estables (para que las decisiones manuales sobrevivan a recargar archivos).
export function assignIds(records) {
  const seen = new Map();
  for (const r of records) {
    const base = r.ref
      ? `${r.origen}|${r.ref}|${r.tipo}`
      : `${r.origen}|${r.ts}|${r.tipo}|${r.monto}|${norm(r.persona)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    r.id = n > 1 ? `${base}#${n}` : base;
  }
  return records;
}
