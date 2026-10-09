// Lectura de archivos a "tablas" (matriz de celdas). Una tabla por hoja de Excel,
// una por CSV y una por texto pegado.
import ExcelJS from 'exceljs';
import { cleanText } from './util.js';

function detectDelimiter(line) {
  const counts = [',', ';', '\t', '|'].map((d) => {
    let n = 0;
    let q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (!q && c === d) n += 1;
    }
    return [d, n];
  });
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
  const d = detectDelimiter(firstLine);
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const out = rows.filter((r) => r.some((c) => c !== ''));
  // Cada renglón entero entre comillas ("108647757,109758685,""07.10.2026 …"",…"): queda una sola
  // celda con todo adentro. Se vuelve a separar.
  if (out.length && out.every((r) => r.filter((c) => c !== '').length === 1) && out.every((r) => /[,;\t]/.test(r.find((c) => c !== '')))) {
    return parseCsv(out.map((r) => r.find((c) => c !== '')).join('\n'));
  }
  return out;
}

// Decodifica bytes de un CSV: UTF-8 si es válido, si no Windows-1252 (Excel en español).
export function decodeText(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
    return null;
  }
  return v;
}

export async function readXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const tables = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (r, rowNumber) => {
      const vals = [];
      const n = r.cellCount;
      for (let c = 1; c <= n; c += 1) vals.push(cellValue(r.getCell(c).value));
      rows[rowNumber - 1] = vals;
    });
    for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
    const clean = rows.filter((r) => r.some((c) => c != null && c !== ''));
    if (clean.length) tables.push({ sheet: ws.name, rows: clean });
  });
  return tables;
}

// Texto pegado desde el panel web: una fila por línea, columnas por tabulación.
export function parsePasted(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  return lines.map((l) => l.split('\t').map((c) => cleanText(c))).filter((r) => r.some((c) => c !== ''));
}

export async function readFile(name, buf) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return readXlsx(buf);
  if (lower.endsWith('.xls')) {
    throw new Error('El formato .xls (Excel 97-2003) no está soportado. Guardá el archivo como .xlsx y volvé a cargarlo.');
  }
  const text = decodeText(buf);
  if (lower.endsWith('.txt')) return [{ sheet: null, rows: parsePasted(text) }];
  return [{ sheet: null, rows: parseCsv(text) }];
}
