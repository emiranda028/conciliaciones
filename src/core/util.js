// Utilidades de parseo compartidas.
//
// Convención de fechas: todas las marcas de tiempo se guardan como "hora de pared"
// de Argentina (UTC-3) codificada en milisegundos con Date.UTC. Así las cuentas de
// diferencias y los formatos no dependen de la zona horaria de la PC.

export const MIN = 60 * 1000;
export const HORA = 60 * MIN;
export const DIA = 24 * HORA;
const OFFSET_LOCAL_MIN = -180; // Argentina, UTC-3

// Corrige texto mal decodificado (UTF-8 leído como Latin-1: "DirecciÃ³n").
export function fixMojibake(s) {
  if (typeof s !== 'string' || !/[ÃÂ]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
    const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return out;
  } catch {
    return s;
  }
}

// Normaliza para comparar encabezados y nombres: minúsculas, sin acentos ni símbolos.
export function norm(s) {
  if (s == null) return '';
  return fixMojibake(String(s))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Palabras de un nombre propio, normalizadas ("SANTIAGO MIGUEL BOSSI" -> [santiago, miguel, bossi]).
export function nameTokens(s) {
  if (s == null) return [];
  return fixMojibake(String(s))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
}

export function cleanText(v) {
  if (v == null) return '';
  return fixMojibake(String(v)).replace(/ /g, ' ').trim();
}

// Convierte "10.000", "ARS 37,20", "26710.1848", "-30.000 ", 1500 a número.
export function parseNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[ \s]/g, '').replace(/[A-Za-z$]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    if (/^\d{1,3}(,\d{3})+$/.test(s) && s.split(',').length > 2) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (lastDot >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  return neg ? -n : n;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

function wall(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

function applyAmPm(h, ampm) {
  if (!ampm) return h;
  const pm = /p/i.test(ampm);
  if (pm && h < 12) return h + 12;
  if (!pm && h === 12) return 0;
  return h;
}

// Número de serie de Excel (días desde 1899-12-30).
export function excelSerialToWall(n) {
  return Math.round((n - 25569) * DIA);
}

// Devuelve la hora de pared (ms) o null. Acepta Date, serial de Excel y los textos
// que aparecen en los reportes de las plataformas y billeteras.
export function parseDateTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return excelSerialToWall(v);
    return null;
  }
  const s = cleanText(v);
  // ISO: 2026-09-15T00:42:00,000-03:00 | 2026-09-21 03:31:00 | 2026-09-21
  let m = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?/
  );
  if (m) {
    let t = wall(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +(m[7] || 0));
    if (t == null) return null;
    if (m[8]) {
      let off = 0;
      if (m[8] !== 'Z') {
        const sign = m[8][0] === '-' ? -1 : 1;
        const digits = m[8].slice(1).replace(':', '');
        off = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2));
      }
      t = t - off * MIN + OFFSET_LOCAL_MIN * MIN;
    }
    return t;
  }
  // Día primero: 21.09.2026 06:04:46.088 | 21/09/2026, 01:25:52 | 20/09/26 23:54 PM
  m = s.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?\s*([AaPp]\.?\s?[Mm]\.?)?)?/
  );
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const h = applyAmPm(+(m[4] || 0), m[8]);
    return wall(y, +m[2], +m[1], h, +(m[5] || 0), +(m[6] || 0), +(m[7] || 0));
  }
  return null;
}

// Solo hora "06:05:15" o Date/serial con parte horaria -> ms desde medianoche.
export function parseTimeOfDay(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return ((v.getTime() % DIA) + DIA) % DIA;
  if (typeof v === 'number') return v < 1 ? Math.round(v * DIA) : null;
  const m = cleanText(v).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?$/);
  if (!m) return null;
  return (applyAmPm(+m[1], m[4]) * 60 + +m[2]) * MIN + +(m[3] || 0) * 1000;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function fmtDate(t) {
  if (t == null) return '';
  const d = new Date(t);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

export function fmtTime(t) {
  if (t == null) return '';
  const d = new Date(t);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Hora de un movimiento; los leídos de capturas no la traen ("s/h").
export function horaDe(r) {
  return r.sinHora ? 's/h' : fmtTime(r.ts);
}

export function fmtDateTime(t) {
  return t == null ? '' : `${fmtDate(t)} ${fmtTime(t)}`;
}

// "2026-09-21" (para inputs type=date) <-> ms
export function isoDay(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function dayFromIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

// Duración legible: 95000 -> "1 min 35 s"
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (!h && (s || !m)) parts.push(`${s} s`);
  return (neg ? '-' : '') + parts.join(' ');
}

const moneyFmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function fmtMoney(n) {
  return n == null || !Number.isFinite(n) ? '' : moneyFmt.format(n);
}

export function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function percentile(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[idx];
}

let seq = 0;
export function uid(prefix = 'x') {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}
