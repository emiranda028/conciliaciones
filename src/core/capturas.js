// Capturas de pantalla de billeteras ("Mis movimientos"): convierte las líneas que
// devuelve el OCR en movimientos y une capturas que se superponen al hacer scroll.
//
// Formato típico de cada movimiento (dos renglones):
//   [ícono]  Guillermo Ricardo Corbalan ...        +$2.500,00
//            Transferencia recibida                     28/09
import { nameTokens, parseNumber } from './util.js';

const MONEY = /([+\-−–]?)\s*\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/;
// Si el OCR no vio el "$" (a veces lo lee como 8, S o §), se toma el importe al final
// del renglón y la fila queda marcada para revisar.
const MONEY_SIN_SIGNO = /([+\-−–]?)\s*([8S§])?(\d{1,3}(?:\.\d{3})*,\d{2})\s*$/;
const PALABRA_MONTO = /^[+\-−–]?[$8S§]?[\d.]+,\d{1,2}$/;

function buscarMonto(text) {
  const m = text.match(MONEY);
  if (m) {
    // Mercado Pago muestra los centavos chiquitos arriba ("$ 1.234⁵⁶"): el OCR los deja
    // pegados o separados al final. Se suman y la fila queda para revisar.
    const resto = text.slice(m.index + m[0].length);
    const c = !/,\d/.test(m[2]) && resto.match(/^\s?(\d{2})\s*$/);
    if (c) return { signo: m[1], monto: parseNumber(m[2]) + Number(c[1]) / 100, index: m.index, dudoso: true };
    // Centavos ilegibles ("$1.250%"): el monto queda sin centavos y se marca para revisar.
    const raro = !/,\d/.test(m[2]) && /^[%°ºª'"*]/.test(resto);
    return { signo: m[1], monto: parseNumber(m[2]), index: m.index, dudoso: raro };
  }
  const f = text.match(MONEY_SIN_SIGNO);
  if (f) return { signo: f[1], monto: parseNumber(f[3]), index: f.index, dudoso: true };
  return null;
}

const HORA_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)(?:[:.]([0-5]\d))?\s*(?:hs?\b)?/i;

// Contraparte en el segundo renglón ("a Miriam Marcela Brun", "de Victor Javier Villa").
// El OCR a veces pega la preposición al nombre ("aMiriam") o deja restos del ícono ("> ", "€ ").
function contraparte(txt) {
  const t = String(txt || '').replace(/^[^A-Za-zÁÉÍÓÚÑáéíóúñ]+/, '');
  const m = t.match(/^(de|a|para)(\s?)(.*)$/i);
  if (!m || !m[3] || !/^[A-ZÁÉÍÓÚÑ]/.test(m[3])) return null;
  // "a"/"de" pegados solo si siguen con mayúscula ("aMiriam"); "Acreditación" no califica.
  if (!m[2] && m[1].length > 0 && m[1][0] === m[1][0].toUpperCase()) return null;
  return m[3];
}

const FECHA = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const COBRO_RE = /recibid|recibiste|te enviaron|te transfiri|te pag[oó]|cobr|ingres|acredit|deposit|reintegr|devoluci/i;
const PAGO_RE = /enviad|enviaste|pagast|pago|retir|debit|extracci|transferiste|transferencia a /i;

// Fechas escritas como en Mercado Pago: "Hoy", "Ayer", "lunes 5 de octubre", "5 oct".
const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
// Renglón que es solo un encabezado de fecha ("Hoy", "Ayer", "Lunes 5 de octubre").
function esEncabezadoFecha(text) {
  const t = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  return /^(hoy|ayer|((lunes|martes|miercoles|jueves|viernes|sabado|domingo),?\s*)?\d{1,2}\s*(de\s+)?[a-z]{3,10}\.?(\s+(de\s+)?\d{4})?|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/.test(t);
}

function fechaEnTexto(text, hoy) {
  const t = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const f = t.match(FECHA);
  if (f) return inferirFecha(+f[1], +f[2], f[3], hoy);
  const ymd = (d) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  if (/\bhoy\b/.test(t)) return ymd(hoy);
  if (/\bayer\b/.test(t)) return ymd(new Date(hoy.getTime() - 86400000));
  const m = t.match(/\b(\d{1,2})\s*(?:de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)[a-z]*\.?(?:\s+(?:de\s+)?(\d{4}))?/);
  if (m) return inferirFecha(+m[1], MESES[m[2]], m[3], hoy);
  return '';
}

// Leyendas habituales de transferencias: no se guardan porque no aportan nada.
// Cualquier otra ("Pago con QR", "Rendimientos"…) queda en el movimiento para revisarla.
export const LEYENDAS_OMITIDAS = ['Transferencia enviada', 'Transferencia recibida', 'Te enviaron dinero', 'Enviaste dinero'];
const normLeyenda = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
const OMITIDAS = new Set(LEYENDAS_OMITIDAS.map(normLeyenda));

export function leyendaVisible(detalle) {
  const t = String(detalle || '').replace(/\s+/g, ' ').trim();
  return OMITIDAS.has(normLeyenda(t)) ? '' : t;
}

const pad = (n) => String(n).padStart(2, '0');

// Año del movimiento: el de la fecha de referencia, salvo que quede en el futuro.
export function inferirFecha(dia, mes, anio, hoy = new Date()) {
  let y = anio ? +anio : hoy.getUTCFullYear();
  if (y < 100) y += 2000;
  if (!anio) {
    const t = Date.UTC(y, mes - 1, dia);
    if (t > hoy.getTime() + 2 * 86400000) y -= 1;
  }
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return '';
  return `${pad(dia)}/${pad(mes)}/${y}`;
}

function limpiarNombre(txt) {
  let s = txt.replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const truncado = /(\.\.\.|…)\s*[—–-]?\s*$/.test(s);
  s = s.replace(/(\.\.\.|…)\s*[—–-]?\s*$/, '').replace(/[\s—–-]+$/, '').trim();
  // Restos del ícono a la izquierda: "7", "y )", "»", "A", "V".
  const toks = s.split(' ');
  while (toks.length > 1 && (toks[0].length <= 1 || !/[a-záéíóúñ]{2,}/i.test(toks[0]))) toks.shift();
  // Iniciales del avatar ("JP Juan Perez", "Pp Pedro…"): letras que coinciden con el inicio del nombre.
  if (toks.length > 2 && toks[0].length <= 3 && /^[a-záéíóúñ]+$/i.test(toks[0])) {
    const ini = toks[0].toLowerCase();
    const sig = toks.slice(1).map((t) => t[0].toLowerCase()).join('');
    if (sig.startsWith(ini) || (ini.length === 2 && ini[0] === ini[1] && ini[0] === sig[0])) toks.shift();
  }
  s = toks.join(' ').replace(/^[^A-Za-zÁÉÍÓÚÑáéíóúñ]+/, '');
  return { nombre: s.replace(/:\s/g, ', ').trim(), truncado };
}

// lines: [{ text, bbox:{x0,y0,x1,y1}, words:[{text,bbox}] }] en orden de lectura.
export function parsearCaptura(lines, { hoy = new Date(), imagen = '' } = {}) {
  const ls = lines.map((l) => ({ ...l, text: String(l.text || '').replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
  // Columna de texto: donde empiezan los renglones de detalle ("Transferencia recibida 28/09").
  const detalleX = ls
    .filter((l) => !buscarMonto(l.text) && !esEncabezadoFecha(l.text) && (FECHA.test(l.text) || HORA_RE.test(l.text)) && l.bbox)
    .map((l) => l.bbox.x0)
    .sort((a, b) => a - b);
  const colX = detalleX.length ? detalleX[Math.floor(detalleX.length / 2)] : null;

  const filas = [];
  let ultimaFecha = '';
  for (let i = 0; i < ls.length; i += 1) {
    const l = ls[i];
    const m = buscarMonto(l.text);
    if (!m) {
      // Encabezados de fecha entre movimientos ("Hoy", "Ayer", "5 de octubre").
      const fh = fechaEnTexto(l.text, hoy);
      if (fh) ultimaFecha = fh;
      continue;
    }
    const { monto } = m;
    if (monto == null || monto === 0) continue;
    // Nombre: palabras a la izquierda del monto, sin el ícono.
    let nombreTxt;
    if (l.words?.length && colX != null) {
      nombreTxt = l.words
        .filter((w) => w.bbox.x0 >= colX - 10 && !MONEY.test(w.text) && !/^[+\-−–]?\$/.test(w.text) && !PALABRA_MONTO.test(w.text) && !/^([+\-−–]|\d[\d.,]*)$/.test(w.text))
        .map((w) => w.text)
        .join(' ');
    } else nombreTxt = l.text.slice(0, m.index);
    nombreTxt = nombreTxt.replace(MONEY, '').replace(/[+\-−–]?\$[\d.,]*$/, '').replace(MONEY_SIN_SIGNO, '');
    const { nombre, truncado } = limpiarNombre(nombreTxt);
    // Detalle: renglones siguientes hasta el próximo monto.
    let detalle = '';
    for (let j = i + 1; j < ls.length && j <= i + 2 && !buscarMonto(ls[j].text) && !esEncabezadoFecha(ls[j].text); j += 1) detalle += ` ${ls[j].text}`;
    detalle = detalle.trim();
    const fecha = fechaEnTexto(detalle, hoy) || fechaEnTexto(l.text.slice(0, m.index), hoy) || ultimaFecha;
    if (fecha) ultimaFecha = fecha;
    // Hora, si la billetera la muestra ("13:45", "13:45 hs").
    const sinFecha = (x) => x.replace(FECHA, ' ');
    const h = sinFecha(detalle).match(HORA_RE) || sinFecha(nombreTxt).match(HORA_RE);
    const hora = h ? `${String(h[1]).padStart(2, '0')}:${h[2]}${h[3] ? `:${h[3]}` : ''}` : '';
    // Dos formatos de lista:
    //   A) renglón 1: titular + monto; renglón 2: leyenda + fecha ("Transferencia recibida").
    //   B) renglón 1: leyenda + monto ("Te enviaron dinero"); renglón 2: "de/a Titular" + fecha.
    let nombreFinal = nombre;
    let truncadoFinal = truncado;
    let leyendaTxt = sinFecha(detalle).replace(HORA_RE, ' ');
    let textoTipo = detalle;
    const otro = contraparte(sinFecha(detalle).replace(HORA_RE, ' ').trim());
    if (otro) {
      const c = limpiarNombre(otro);
      leyendaTxt = nombre;
      nombreFinal = c.nombre;
      truncadoFinal = c.truncado;
      textoTipo = nombre;
    }
    let tipo;
    let dudoso = false;
    if (COBRO_RE.test(textoTipo)) tipo = 'COBRO';
    else if (PAGO_RE.test(textoTipo)) tipo = 'PAGO';
    else {
      tipo = m.signo === '+' ? 'COBRO' : 'PAGO';
      dudoso = true;
    }
    if ((m.signo === '+' && tipo === 'PAGO') || m.dudoso) dudoso = true;
    filas.push({
      fecha,
      hora,
      nombre: nombreFinal,
      tipo,
      monto,
      truncado: truncadoFinal,
      leyenda: leyendaVisible(leyendaTxt),
      dudoso: dudoso || !fecha || !nombreFinal || (l.confidence != null && l.confidence < 60),
      imagen,
    });
  }
  return filas;
}

export function claveFila(f) {
  return `${f.fecha}|${f.tipo}|${f.monto}|${nameTokens(f.nombre).join(' ')}`;
}

// Une capturas consecutivas: si el final de una coincide con el principio de otra
// (el mismo movimiento aparece en las dos), se cuenta una sola vez.
export function unirCapturas(listas) {
  let grupos = listas.filter((l) => l.length).map((l) => [...l]);
  let quitadas = 0;
  for (;;) {
    let best = null;
    for (let a = 0; a < grupos.length; a += 1) {
      for (let b = 0; b < grupos.length; b += 1) {
        if (a === b) continue;
        const A = grupos[a];
        const B = grupos[b];
        const max = Math.min(A.length, B.length);
        for (let k = max; k >= 1; k -= 1) {
          let ok = true;
          for (let t = 0; t < k && ok; t += 1) ok = claveFila(A[A.length - k + t]) === claveFila(B[t]);
          if (ok) {
            if (!best || k > best.k) best = { a, b, k };
            break;
          }
        }
      }
    }
    if (!best) break;
    const merged = [...grupos[best.a], ...grupos[best.b].slice(best.k)];
    quitadas += best.k;
    grupos = grupos.filter((_, i) => i !== best.a && i !== best.b);
    grupos.unshift(merged);
  }
  return { filas: grupos.flat(), quitadas };
}

export const CAPTURA_HEADER = ['Fecha', 'Titular', 'Operación', 'Monto', 'Cuenta', 'Imagen', 'Leyenda', 'Hora', 'Turno', 'Origen: captura de pantalla'];

// Tabla que se guarda como fuente (así se puede guardar en el trabajo y volver a leer).
export function filasATabla(filas, cuenta) {
  return [CAPTURA_HEADER, ...filas.map((f) => [f.fecha, f.nombre + (f.truncado ? '...' : ''), f.tipo === 'COBRO' ? 'Cobro' : 'Pago', f.monto, cuenta, f.imagen || '', leyendaVisible(f.leyenda), f.hora || '', f.hora ? '' : f.turno || ''])];
}
