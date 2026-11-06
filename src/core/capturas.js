// Capturas de pantalla de billeteras ("Mis movimientos"): convierte las líneas que
// devuelve el OCR en movimientos y une capturas que se superponen al hacer scroll.
//
// Formato típico de cada movimiento (dos renglones):
//   [ícono]  Guillermo Ricardo Corbalan ...        +$2.500,00
//            Transferencia recibida                     28/09
import { nameTokens, parseNumber } from './util.js';

// El grupo de miles admite 4 cifras ("1550.000,00"): el OCR a veces duplica un dígito.
const MONEY = /([+\-−–]?)\s*\$\s*(\d{1,4}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/;
// Si el OCR no vio el "$" (a veces lo lee como 8, S o §), se toma el importe al final
// del renglón y la fila queda marcada para revisar.
// También "3.000 00" (la coma perdida en un renglón cortado).
const MONEY_SIN_SIGNO = /([+\-−–]?)\s*([8S§])?(\d{1,3}(?:\.\d{3})*,\d{2}|\d{1,3}(?:\.\d{3})+ \d{2})[\s—–-]*$/;
const PALABRA_MONTO = /^[+\-−–]?[$8S§]?[\d.]+,\d{1,2}$/;

// Tipo según el signo del monto ("- $ 95.000,00" sale, "+ $ 5.000,00" entra), o null si no tiene.
// Una flecha del ícono pegada al monto ("<- $ 6.000,00") no cuenta como signo.
function tipoPorSigno(m) {
  if (m.flecha) return null;
  if (m.signo === '+') return 'COBRO';
  if (/[-−–]/.test(m.signo)) return 'PAGO';
  return null;
}

// Tipo del movimiento: manda el signo del monto; si no hay, la leyenda. Si se contradicen,
// o no hay ninguno de los dos, la fila queda para revisar.
// porDefecto: en las listas donde los pagos llevan "-", un monto sin signo ni leyenda es cobro.
function tipoMovimiento(m, textoTipo, porDefecto = 'PAGO') {
  const signo = tipoPorSigno(m);
  const leyenda = COBRO_RE.test(textoTipo) ? 'COBRO' : PAGO_RE.test(textoTipo) ? 'PAGO' : null;
  return { tipo: signo || leyenda || porDefecto, dudoso: !(signo || leyenda) || (signo && leyenda && signo !== leyenda) || !!m.dudoso };
}

function buscarMonto(text) {
  const r = buscarMontoTexto(text);
  if (r && r.signo && r.index > 0 && /[<=←]/.test(text[r.index - 1])) r.flecha = true;
  return r;
}

// "1550.000,00": un grupo de miles de 4 cifras no existe. Si tiene un dígito repetido se saca
// uno ("150.000,00"); la fila queda siempre para revisar.
function corregirMiles(txt) {
  const m = /^(\d{4})(\..*)$/.exec(txt);
  if (!m) return null;
  const g = m[1];
  const i = [0, 1, 2].find((k) => g[k] === g[k + 1]);
  return (i == null ? g.slice(1) : g.slice(0, i) + g.slice(i + 1)) + m[2];
}

function buscarMontoTexto(text) {
  const m = text.match(MONEY);
  const corregido = m && corregirMiles(m[2]);
  if (corregido) return { signo: m[1], monto: parseNumber(corregido), index: m.index, dudoso: true };
  // "$ 12:14": el ícono de la billetera leído como "$" delante de la hora; no es un monto.
  if (m && /^:\d{2}/.test(text.slice(m.index + m[0].length))) return null;
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
  // "80.000,00" sin "$": el 8 es una cifra (un número no empieza con 0), no el "$" mal leído.
  if (f) return { signo: f[1], monto: parseNumber((f[2] === '8' && /^0/.test(f[3]) ? `8${f[3]}` : f[3]).replace(/ (\d{2})$/, ',$1')), index: f.index, dudoso: true };
  return null;
}

const HORA_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)(?:[:.]([0-5]\d))?\s*(?:hs?\b)?/i;

// Contraparte en el segundo renglón ("a Miriam Marcela Brun", "de Victor Javier Villa").
// El OCR a veces pega la preposición al nombre ("aMiriam") o deja restos del ícono ("> ", "€ ").
// Con la leyenda de Personal Pay arriba ("Te enviaron dinero"), el renglón siempre es
// "de …"/"a …": se acepta también pegado y en minúscula ("devirginia", "delJose").
function contraparte(txt, seguro = false) {
  const t = String(txt || '').replace(/^[^A-Za-zÁÉÍÓÚÑáéíóúñ]+/, '');
  if (seguro) {
    const s = t.match(/^(de|a)(?:\s+|[lI|](?=[A-ZÁÉÍÓÚÑ])|(?=[A-Za-zÁÉÍÓÚÑáéíóúñ]))(.+)$/);
    if (s) return s[2].charAt(0).toUpperCase() + s[2].slice(1);
  }
  const m = t.match(/^(de|a|para)(\s?)(.*)$/i);
  if (!m || !m[3] || !/^[A-ZÁÉÍÓÚÑ]/.test(m[3])) return null;
  // "a"/"de" pegados solo si siguen con mayúscula ("aMiriam"); "Acreditación" no califica.
  if (!m[2] && m[1].length > 0 && m[1][0] === m[1][0].toUpperCase()) return null;
  return m[3];
}

const FECHA = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const COBRO_RE = /recibid|recibiste|te enviaron|te transfiri|te pag[oó]|cobr|ingres|acredit|deposit|reintegr|devoluci|\bcarga\b|transferencia de\b|prex a prex de\b/i;
const PAGO_RE = /enviad|enviaste|pagast|pago|retir|debit|extracci|transferiste|transferencia a |prex a prex a /i;

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

// Mes escrito, tolerando errores del OCR ("0ctubre", "o0ctubre", "ju1io", "setiembre").
const NOMBRES_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function distancia(a, b) {
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
function mesDeTexto(tok) {
  const t = String(tok || '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/[^a-z]/g, '');
  if (t.length < 3) return null;
  if (MESES[t.slice(0, 3)] && (t.length <= 4 || NOMBRES_MES.some((n) => distancia(t, n) <= 2))) return MESES[t.slice(0, 3)];
  let mejor = null;
  NOMBRES_MES.forEach((n, i) => {
    const d = distancia(t, n);
    if (d <= 2 && (!mejor || d < mejor.d)) mejor = { d, mes: i + 1 };
  });
  return mejor ? mejor.mes : null;
}

function fechaEnTexto(text, hoy) {
  const t = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const f = t.match(FECHA);
  // Con el año escrito la fecha es confiable; sin año se controla que esté cerca del día de la captura.
  if (f) return f[3] ? inferirFecha(+f[1], +f[2], f[3], hoy) : razonable(inferirFecha(+f[1], +f[2], f[3], hoy), hoy);
  const ymd = (d) => `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  if (/\bhoy\b/.test(t)) return ymd(hoy);
  if (/\bayer\b/.test(t)) return ymd(new Date(hoy.getTime() - 86400000));
  const m = t.match(/\b(\d{1,2})\s*(?:de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)[a-z]*\.?(?:\s+(?:de\s+)?(\d{4}))?/);
  if (m) return m[3] ? inferirFecha(+m[1], MESES[m[2]], m[3], hoy) : razonable(inferirFecha(+m[1], MESES[m[2]], m[3], hoy), hoy);
  return '';
}

// Una fecha mal leída ("02/11" leído "02/1", que sería el 2 de enero) queda lejos del día de la
// captura: se descarta y la fila toma la fecha de la de arriba o la del archivo.
function razonable(fecha, hoy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha || '');
  if (!m) return fecha;
  const dif = (Date.UTC(+m[3], +m[2] - 1, +m[1]) - hoy.getTime()) / 86400000;
  return dif < -60 || dif > 3 ? '' : fecha;
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
// Estado y origen del dinero que muestra Mercado Pago en la compu ("Aprobado", "Dinero
// disponible"), con los íconos que el OCR lee como letras sueltas ("O", "G", "€").
function sinEstado(t) {
  return String(t || '')
    .replace(/(?:^|\s)\S?\s*(dinero disponible|aprobad[oa]|rechazad[oa]|pendiente|cancelad[oa]|en proceso)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// La leyenda de transferencia ocupa el lugar del titular (el OCR a veces junta las palabras).
const OMITIDAS_JUNTAS = new Set(LEYENDAS_OMITIDAS.map((x) => normLeyenda(x).replace(/ /g, '')));
export const esLeyendaTransferencia = (s) => {
  const k = normLeyenda(s).replace(/ /g, '');
  // También con alguna letra mal leída ("Iransferencia recibida", "Te envlaron dinero").
  return [...OMITIDAS_JUNTAS].some((o) => k === o || (k.length >= o.length && k.length - o.length <= 3 && distancia(k.slice(-o.length), o) <= 2));
};

export function leyendaVisible(detalle) {
  const t = String(detalle || '').replace(/\s+/g, ' ').trim();
  if (!/[a-záéíóúñ]{2,}/i.test(t)) return '';
  // "Hoy" / "Ayer" son la fecha, no una leyenda (Ualá: "Hoy 13:46").
  if (/^(hoy|ayer)$/i.test(t)) return '';
  // Tolera palabras pegadas ("Transferenciarecibida") y restos del ícono delante ("ls Transferencia enviada").
  return esLeyendaTransferencia(t) ? '' : t;
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
  // Restos de la fecha mal leída al final ("Marcelino Ruben Ovie.. 07n0/2026").
  s = s.replace(/\s+\S*\d\S*\/\d{2,4}$/, '');
  const truncado = /(\.{2,}|…)\s*[—–-]?\s*$/.test(s);
  s = s.replace(/(\.{2,}|…)\s*[—–-]?\s*$/, '').replace(/[\s—–-]+$/, '').trim();
  // Restos del ícono a la izquierda: "7", "y )", "»", "A", "V".
  const toks = s.split(' ');
  // Y basura a la derecha ("FABRIZIO MOLINA y y"); una inicial en mayúscula ("Oscar L") se deja.
  while (toks.length > 1 && /^([a-zñ]|[^A-Za-zÁÉÍÓÚÑáéíóúñ]+)$/.test(toks[toks.length - 1])) toks.pop();
  // Restos del avatar: "ta Alejandra Antonia…".
  if (toks.length > 2 && /^[a-zñ]{1,2}$/.test(toks[0]) && /^[A-ZÁÉÍÓÚÑ]/.test(toks[1])) toks.shift();
  // "Raul Victor Jaime < O": un símbolo suelto seguido solo de letras sueltas.
  const sim = toks.findIndex((t, i) => i > 0 && /^[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9]+$/.test(t) && toks.slice(i + 1).every((x) => x.length <= 1));
  if (sim > 0) toks.splice(sim);
  while (toks.length > 1 && (toks[0].length <= 1 || !/[a-záéíóúñ]{2,}/i.test(toks[0]))) toks.shift();
  // Iniciales del avatar ("JP Juan Perez", "Pp Pedro…"): letras que coinciden con el inicio del nombre.
  if (toks.length > 2 && toks[0].length <= 3 && /^[a-záéíóúñ]+$/i.test(toks[0])) {
    const ini = toks[0].toLowerCase();
    const sig = toks.slice(1).map((t) => t[0].toLowerCase()).join('');
    if (sig.startsWith(ini) || (ini.length === 2 && ini[0] === ini[1] && ini[0] === sig[0])) toks.shift();
  }
  s = toks.join(' ').replace(/^[^A-Za-zÁÉÍÓÚÑáéíóúñ]+/, '');
  // Palabras pegadas por el OCR: "SoniaZunilda Gomez" -> "Sonia Zunilda Gomez".
  s = s.replace(/([a-záéíóúñ]{2})([A-ZÁÉÍÓÚÑ][a-záéíóúñ])/g, '$1 $2');
  return { nombre: s.replace(/:\s/g, ', ').trim(), truncado };
}

// Día escrito en el nombre del archivo o en el título del PDF: "07-10", "07.10", "7/10/2026", "DIA 7".
export function fechaDeNombre(texto, hoy = new Date()) {
  const t = String(texto || '');
  const m = t.match(/(?<![\d])(\d{1,2})[-./_](\d{1,2})(?:[-./_](\d{4}|\d{2}))?(?![\d])/);
  // Sin año, una fecha que no puede ser la del archivo ("v1.1", "(1.2)") no se toma: daría enero.
  if (m && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) {
    const f = inferirFecha(+m[1], +m[2], m[3], hoy);
    if (m[3] || razonable(f, hoy)) return f;
  }
  const d = t.match(/(?<![A-Za-z])d[ií]a[\s_-]*(\d{1,2})(?!\d)/i);
  if (d && +d[1] >= 1 && +d[1] <= 31) {
    // Mes de la fecha de referencia, o el anterior si ese día todavía no llegó.
    let mes = hoy.getUTCMonth() + 1;
    let anio = hoy.getUTCFullYear();
    if (+d[1] > hoy.getUTCDate() + 1) {
      mes -= 1;
      if (!mes) {
        mes = 12;
        anio -= 1;
      }
    }
    return inferirFecha(+d[1], mes, anio, hoy);
  }
  return '';
}

// ---------------------------------------------------------------------------
// AstroPay ("Transacciones"): montos en formato inglés con "ARS" ("+8,000.00 ARS"), el nombre a
// veces en dos renglones y "Transferencia CVU" abajo; las transferencias "Fallida" no cuentan.
// Se reescribe al formato A ("Nombre +$8.000,00" / "Transferencia CVU").
// El OCR a veces lee el "+" como "F" y los dígitos como "O" o "U" ("F10,000.00", "+O000.00").
// También sin signo ("50,000.00 ARS") o con una barra pegada ("+/7,000.00 ARS").
const MONTO_ARS = /(?:^|\s)([+\-−–F]?)\s*[/|]?\s*([\dOoU][\dOoU.,-]*?)\s*-?ARS\b/;
// Monto ilegible del todo: después de "Transferencia CVU" queda basura ("FOO RES").
const MONTO_ROTO = /transferencia cvu\s+(\S.*)$/i;
// O un monto con algún carácter raro antes de "ARS" ("+7,/400.00 ARS").
const MONTO_RARO = /[+\-−–]?\s*\d[^A-Za-z]*\bARS\s*$/;
const esMontoArs = (t) => MONTO_ARS.test(t) || MONTO_ROTO.test(t) || MONTO_RARO.test(t);

function aMontoLocal(signo, txt) {
  // "8,000.00" -> 8000.00 (también tolera "15,000-00" de un monto tachado).
  const m = txt
    .replace(/[OoU]/g, '0')
    .replace(/-/g, '.')
    .match(/^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/);
  if (!m || !Number(m[1].replace(/,/g, ''))) return null;
  const entero = m[1].replace(/,/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${signo === '+' || signo === 'F' ? '+' : '-'}$${entero},${(m[2] || '00').padEnd(2, '0')}`;
}

export function normalizarAstroPay(lines) {
  if (lines.filter((l) => esMontoArs(l.text)).length < 2) return null;
  const out = [];
  let nombre = [];
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].text;
    // Encabezados de fecha ("Ayer" a veces se lee "Aver").
    if (/^(a[vy]er|hoy)$/i.test(t)) {
      out.push({ text: /^h/i.test(t) ? 'Hoy' : 'Ayer', confidence: 95 });
      nombre = [];
      continue;
    }
    if (!esMontoArs(t)) {
      // La leyenda ("Transferencia CVU", a veces mal leída: "Iransterencia CVU") no es parte del nombre.
      if (/\bcvu$/i.test(t) && t.split(' ').length <= 3) continue;
      nombre.push(t);
      continue;
    }
    const roto = !MONTO_ARS.test(t);
    const idxRoto = /transferencia cvu/i.test(t) ? t.search(/transferencia cvu/i) : t.search(MONTO_RARO);
    const m = roto ? { index: idxRoto, 1: /^[\-−–]/.test(t.slice(idxRoto)) ? '-' : '', 2: '' } : t.match(MONTO_ARS);
    const siguiente = lines[i + 1]?.text || '';
    // Fallida (monto tachado): no se movió plata.
    if (/fallid/i.test(t) || /fallid/i.test(siguiente)) {
      nombre = [];
      if (/fallid/i.test(siguiente)) i += 1;
      continue;
    }
    // Lo que está a la izquierda del monto: el resto del nombre o la leyenda, sin la flecha del ícono.
    const izquierda = t
      .slice(0, m.index)
      .replace(/transferencia cvu/i, ' ')
      .split(' ')
      .filter(Boolean);
    while (izquierda.length && izquierda[0].length <= 2) izquierda.shift();
    // Sin signo, la flecha del ícono dice el sentido: ↑ (el OCR la lee "T") sale, ↓ entra.
    // Igual queda para revisar.
    const sinSigno = !roto && !m[1];
    if (sinSigno) m[1] = /^[T↑]\s/.test(t) ? '-' : '+';
    const monto = roto ? null : aMontoLocal(m[1], m[2]);
    const conf = sinSigno ? 40 : Math.min(lines[i].confidence ?? 90, 90);
    const quien = [...nombre, ...izquierda]
      .join(' ')
      .split(' ')
      .filter((x) => /[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/.test(x))
      .join(' ');
    if (monto) out.push({ text: `${quien} ${monto}`.trim(), confidence: conf });
    // Monto ilegible: la fila queda igual, sin monto y para revisar, para no perder el movimiento.
    else out.push({ text: `${quien} ${m[1] === '-' ? '-' : '+'}$0,00`.trim(), confidence: 0, montoIlegible: true });
    nombre = [];
  }
  return out;
}

// El ícono redondo de la izquierda (Prex) se lee como "-", "=" o "—" en el renglón del monto,
// pero queda lejos del "$": no es el signo. El "-" de verdad va pegado al "$" ("- $ 50.000,00").
function sinIconoSuelto(l) {
  const ws = l.words;
  if (!ws?.length || !ws.every((w) => w.bbox)) return l;
  const alto = Math.max(...ws.map((w) => w.bbox.y1 - w.bbox.y0));
  const fuera = new Set();
  for (let k = 0; k < ws.length - 1; k += 1) {
    const t = String(ws[k].text || '').trim();
    const s = String(ws[k + 1].text || '').trim();
    const icono = /^[+\-−–—=_~]+$/.test(t) || (k === 0 && /^[^\d$]{1,2}$/.test(t));
    if (icono && /^\$/.test(s) && ws[k + 1].bbox.x0 - ws[k].bbox.x1 > 3 * alto) fuera.add(k);
  }
  if (!fuera.size) return l;
  const words = ws.filter((_, k) => !fuera.has(k));
  // La confianza del renglón la bajaba el ícono: se toma la de lo que queda.
  const confs = words.map((w) => w.confidence).filter((c) => c != null);
  const confidence = confs.length ? Math.min(...confs) : l.confidence;
  return { ...l, words, confidence, text: words.map((w) => String(w.text || '').trim()).join(' ') };
}

// "TRANSFERENCIA CVU/CBU" (Prex): transferencia saliente sin titular.
const CVU_CBU = /^c\s*v[a-z]{0,2}\s*\/\s*c\s*b\s*u$/i;

// lines: [{ text, bbox:{x0,y0,x1,y1}, words:[{text,bbox}] }] en orden de lectura.
// fechaDefecto: día a usar si la captura no muestra ninguno (por ejemplo, el del nombre del PDF).
export function parsearCaptura(lines, { hoy = new Date(), imagen = '', fechaDefecto = '' } = {}) {
  let ls = lines
    .map((l) => sinIconoSuelto(l))
    .map((l) => ({ ...l, text: String(l.text || '').replace(/\s+/g, ' ').trim() }))
    // "+7,/400.00", "+/7/,000.00 ARS": trazos de más ("/", "'", "|") en medio del monto.
    .map((l) => {
      const text = l.text.replace(/(\d[.,])[\/|'`´]+(\d{3}\b)/g, '$1$2').replace(/([+\-−–])([\d\/|'.,]*\d[\d\/|'.,]*)(?=\s*ARS\b)/g, (_, s, n) => s + n.replace(/[\/|']/g, ''));
      // Corregido: puede faltar una cifra ("+7,/600" leído "+/7/,000"), la fila queda para revisar.
      return text === l.text ? l : { ...l, text, confidence: Math.min(l.confidence ?? 90, 55) };
    })
    // "+$ 10,000" (Personal Pay, sin centavos): la coma con tres cifras detrás es de miles, no de
    // centavos; si no, se leía $10,00.
    .map((l) => ({ ...l, text: l.text.replace(/(\$\s*\d{1,3}),(\d{3})(?![\d.,])/g, '$1.$2') }))
    // "4 Sonia Aline Seguel 30/10/26" debajo de "Transferencia enviada": el "A" leído como 4.
    .map((l, i, arr) =>
      i > 0 && /enviad|transferiste/i.test(arr[i - 1].text) && /^[4Á]\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+\s/.test(l.text) && /\d{1,2}\/\d{1,2}/.test(l.text)
        ? { ...l, text: l.text.replace(/^[4Á]\s+/, 'A ') }
        : l
    )
    // "+5 11.000": el "$" leído como 5 (o S) entre el signo y el monto, separado por un espacio.
    .map((l) => {
      const text = l.text.replace(/([+\-−–])\s*[5S§]\s+(\d{1,3}(?:[.,]\d{3})+(?:,\d{2})?)(?![\d])/g, (_, s, n) => `${s}$ ${n.replace(/,(\d{3})/g, '.$1')}`);
      return text === l.text ? l : { ...l, text, confidence: Math.min(l.confidence ?? 90, 55) };
    })
    // "Oe Hector…", "Dz Ariel…", "Os Pedro…": el "De" de Personal Pay mal leído.
    .map((l) => ({ ...l, text: l.text.replace(/^(?:\S{1,2}\s+)?(?:Oe|Dz|Ds|Des|Os|Oz|D[eo]s?|0e)\s+(?=[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+\s+[A-ZÁÉÍÓÚÑ])/, 'De ') }))
    .filter((l) => l.text);
  const astro = normalizarAstroPay(ls);
  if (astro) ls = astro;
  // Columna de texto: donde empiezan los renglones de detalle ("Transferencia recibida 28/09").
  const detalleX = ls
    .filter((l) => !buscarMonto(l.text) && !esEncabezadoFecha(l.text) && (FECHA.test(l.text) || HORA_RE.test(l.text)) && l.bbox)
    .map((l) => l.bbox.x0)
    .sort((a, b) => a - b);
  const colX = detalleX.length ? detalleX[Math.floor(detalleX.length / 2)] : null;

  // Formato D: dos renglones de texto ("CARGA TRANSFERENCIA DE" / "TITULAR") con el monto
  // centrado entre los dos: el OCR deja el monto en un renglón propio, sin nombre.
  const sinTexto = (t) => !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(t);
  const conMonto = ls.map((l) => buscarMonto(l.text));
  const nMontos = conMonto.filter(Boolean).length;
  const nSolos = ls.filter((l, i) => conMonto[i] && sinTexto(l.text.slice(0, conMonto[i].index))).length;
  const enMedio = nMontos >= 2 && nSolos >= nMontos / 2;
  const textoVecino = (j) => (j >= 0 && j < ls.length && !conMonto[j] && !esEncabezadoFecha(ls[j].text) ? ls[j].text.replace(/^[^A-Za-zÁÉÍÓÚÑáéíóúñ]+/, '').replace(/[\s—–-]+$/, '') : '');

  const filas = [];
  let ultimaFecha = '';
  // Para el formato E: último renglón con monto y último encabezado de fecha.
  let anteriorMonto = -1;
  let anteriorFecha = -1;
  for (let i = 0; i < ls.length; i += 1) {
    const l = ls[i];
    const m = buscarMonto(l.text);
    if (!m) {
      // Encabezados de fecha entre movimientos ("Hoy", "Ayer", "5 de octubre").
      const fh = fechaEnTexto(l.text, hoy);
      if (fh) {
        ultimaFecha = fh;
        anteriorFecha = i;
      }
      continue;
    }
    const desdeArriba = Math.max(anteriorMonto, anteriorFecha) + 1;
    anteriorMonto = i;
    const { monto } = m;
    if (monto == null || (monto === 0 && !l.montoIlegible)) continue;
    // Nombre: palabras a la izquierda del monto, sin el ícono.
    let nombreTxt;
    if (l.words?.length && colX != null) {
      nombreTxt = l.words
        .filter((w) => w.bbox.x0 >= colX - 10 && !MONEY.test(w.text) && !/^[+\-−–]?\$/.test(w.text) && !PALABRA_MONTO.test(w.text) && !/^([+\-−–]|\d[\d.,]*)$/.test(w.text))
        .map((w) => w.text)
        .join(' ');
    } else nombreTxt = l.text.slice(0, m.index);
    nombreTxt = sinEstado(nombreTxt.replace(MONEY, '').replace(/[+\-−–]?\$[\d.,]*$/, '').replace(MONEY_SIN_SIGNO, ''));
    const ln = limpiarNombre(nombreTxt);
    // Prex: el rendimiento diario de la cuenta no es un movimiento de un cliente.
    if (/^rendimientos?\b/i.test(ln.nombre)) continue;
    // Prex: "PREX A PREX DE DAISY": leyenda y titular en el mismo renglón.
    const pp = ln.nombre.match(/^(prex a prex (?:de|a))\s+(.+)$/i);
    const { nombre, truncado } = pp ? { nombre: pp[2], truncado: ln.truncado } : ln;
    const leyendaPrex = pp ? pp[1] : '';
    // Un renglón de leyenda cortado arriba de la captura se lee como basura (confianza baja).
    const cortado = l.confidence != null && l.confidence < 50;
    if (enMedio && (sinTexto(nombre) || cortado)) {
      const vecino = textoVecino(i - 1);
      const arriba = sinTexto(vecino) || (ls[i - 1]?.confidence ?? 100) < 50 ? '' : vecino;
      const abajo = textoVecino(i + 1);
      const junto = `${arriba} ${abajo}`.replace(/\s+/g, ' ').trim();
      // "CARGA TRANSFERENCIA DE BRIAN" / "FABRIZIO MOLINA": la leyenda termina en "de"/"a".
      const p = junto.match(/^(.*?\b(?:de|desde|a|para))\s+(.+)$/i);
      let [ley, quien] = p && (COBRO_RE.test(p[1]) || PAGO_RE.test(p[1])) ? [p[1], p[2]] : [arriba, abajo];
      // Prex: "TRANSFERENCIA" / "CVU/CBU" (sale, sin titular) y "CARGA" / "TRANSFERENCIA DE…"
      // (entra, con el titular cortado por la app): la leyenda sola, sin nombre.
      const sinTitular = CVU_CBU.test(quien) || /^(.*\b(?:transferencia|prex a prex)\s+(?:de|a))\s*(\.{2,}|…)?$/i.test(junto);
      if (sinTitular) [ley, quien] = [junto.replace(/\s*(\.{2,}|…)$/, '').replace(/c\s*v[a-z]{0,2}\s*\/\s*c\s*b\s*u$/i, 'CVU/CBU'), ''];
      if (quien || sinTitular) {
        const c = sinTitular ? { nombre: '', truncado: /(\.{2,}|…)$/.test(junto) } : limpiarNombre(quien);
        const textoTipo = ley || '';
        const r = tipoMovimiento(m, textoTipo, 'COBRO');
        const { tipo } = r;
        const dudoso = r.dudoso || cortado;
        const fecha = ultimaFecha || fechaDefecto;
        filas.push({
          fecha,
          hora: '',
          nombre: c.nombre,
          tipo,
          monto,
          truncado: c.truncado,
          leyenda: leyendaVisible(ley),
          dudoso: dudoso || !fecha || (!c.nombre && !sinTitular) || (l.confidence != null && l.confidence < 60),
          imagen,
        });
        continue;
      }
    }
    // Formato E (Mercado Pago en la compu, "Actividad"): titular arriba (con la hora) y
    // leyenda + estado + monto abajo. El titular es el renglón de texto entre el movimiento
    // anterior (o el encabezado de fecha) y este.
    let arriba = null;
    // Si abajo viene "de …"/"a …", es el formato B (Personal Pay), no este.
    const debajo = ls[i + 1] && !conMonto[i + 1] ? ls[i + 1].text.replace(FECHA, ' ').replace(HORA_RE, ' ').trim() : '';
    if (esLeyendaTransferencia(nombre) && !contraparte(debajo, true)) {
      for (let j = desdeArriba; j < i && !arriba; j += 1) {
        const t = sinEstado(ls[j].text.replace(HORA_RE, ' '));
        const c = limpiarNombre(t);
        const palabras = c.nombre.split(' ');
        const largas = palabras.filter((x) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(x)).length;
        // Un nombre: dos o más palabras y la mayoría de verdad (no la barra de estado del celular).
        const pareceNombre = largas >= 2 && largas * 2 >= palabras.length && (ls[j].confidence ?? 100) >= 50;
        if (pareceNombre && !esLeyendaTransferencia(c.nombre) && !COBRO_RE.test(c.nombre) && !PAGO_RE.test(c.nombre)) arriba = c;
      }
      if (arriba) {
        const hr = ls.slice(desdeArriba, i).map((x) => x.text.match(HORA_RE)).find(Boolean);
        arriba.hora = hr ? `${String(hr[1]).padStart(2, '0')}:${hr[2]}${hr[3] ? `:${hr[3]}` : ''}` : '';
      }
    }
    // Detalle: renglones siguientes hasta el próximo monto.
    let detalle = '';
    // En el formato D, un movimiento de un solo renglón ("TRANSFERENCIA CVU/CBU - $ 95.000,00")
    // no tiene detalle: los renglones de abajo son del movimiento siguiente.
    const limite = enMedio || arriba ? i : i + 2;
    for (let j = i + 1; j < ls.length && j <= limite && !buscarMonto(ls[j].text) && !esEncabezadoFecha(ls[j].text); j += 1) detalle += ` ${ls[j].text}`;
    detalle = detalle.trim();
    let fecha = fechaEnTexto(detalle, hoy) || fechaEnTexto(l.text.slice(0, m.index), hoy) || ultimaFecha || fechaDefecto;
    if (fecha) ultimaFecha = fecha;
    // Hora, si la billetera la muestra ("13:45", "13:45 hs").
    const sinFecha = (x) => x.replace(FECHA, ' ');
    const h = sinFecha(detalle).match(HORA_RE) || sinFecha(nombreTxt).match(HORA_RE);
    const hora = arriba ? arriba.hora : h ? `${String(h[1]).padStart(2, '0')}:${h[2]}${h[3] ? `:${h[3]}` : ''}` : '';
    // Solo la hora y ningún día arriba: las billeteras muestran así los movimientos de hoy.
    // Se toma el día de la captura y la fila queda para revisar.
    let fechaSupuesta = false;
    if (!fecha && hora) {
      fecha = inferirFecha(hoy.getUTCDate(), hoy.getUTCMonth() + 1, hoy.getUTCFullYear());
      fechaSupuesta = true;
    }
    // Tres formatos de lista:
    //   A) renglón 1: titular + monto; renglón 2: leyenda + fecha ("Transferencia recibida").
    //   B) renglón 1: leyenda + monto ("Te enviaron dinero"); renglón 2: "de/a Titular" + fecha.
    //   C) (Prex, Naranja X) fecha arriba; renglón 1: leyenda + monto; renglón 2: titular solo.
    let nombreFinal = nombre;
    let truncadoFinal = truncado;
    // Sin los botones del celular que el OCR lee al pie ("Transferencia recibida II O <").
    let leyendaTxt = sinFecha(detalle)
      .replace(HORA_RE, ' ')
      .replace(/(\s+(I{1,3}|l{1,3}|\||[O0o]|[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s]+))+\s*$/, '');
    let textoTipo = detalle;
    const resto = sinFecha(detalle).replace(HORA_RE, ' ').trim();
    const nombreEsLeyenda = esLeyendaTransferencia(nombre);
    const otro = contraparte(resto, nombreEsLeyenda);
    if (arriba) {
      leyendaTxt = nombre;
      nombreFinal = arriba.nombre;
      truncadoFinal = arriba.truncado;
      textoTipo = nombre;
    } else if (otro || (nombreEsLeyenda && resto && !COBRO_RE.test(resto) && !PAGO_RE.test(resto))) {
      const c = limpiarNombre(otro || resto);
      leyendaTxt = nombre;
      nombreFinal = c.nombre;
      truncadoFinal = c.truncado;
      textoTipo = nombre;
    }
    if (leyendaPrex) [leyendaTxt, textoTipo] = [leyendaPrex, leyendaPrex];
    const { tipo, dudoso } = tipoMovimiento(m, textoTipo);
    filas.push({
      fecha,
      hora,
      nombre: nombreFinal,
      tipo,
      monto,
      truncado: truncadoFinal,
      leyenda: leyendaVisible(leyendaTxt),
      dudoso: dudoso || fechaSupuesta || !fecha || !nombreFinal || esLeyendaTransferencia(nombreFinal) || (l.confidence != null && l.confidence < 60),
      imagen,
    });
  }
  // Filas sin día en una captura que sí lo tiene en otras filas (por ejemplo, la hora no se pudo
  // leer): toman el de la fila de arriba y quedan para revisar.
  filas.forEach((f, k) => {
    if (f.fecha) return;
    const vecina = filas.slice(0, k).reverse().find((x) => x.fecha) || filas.slice(k + 1).find((x) => x.fecha);
    if (vecina) Object.assign(f, { fecha: vecina.fecha, dudoso: true });
  });
  ajustarFechas(filas, hoy, fechaDefecto);
  return filas;
}

// Cifras que el OCR confunde en las fechas ("30/10" leído "20/10", "02/11/2026" leído "02/1/2026").
const CIFRAS_PARECIDAS = { 0: '869', 1: '74', 2: '3', 3: '258', 4: '1', 5: '36', 6: '508', 7: '1', 8: '0365', 9: '0' };
const diaUTC = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || '');
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
};

function variantesFecha(fecha) {
  const [d, m, y] = fecha.split('/');
  const out = new Set();
  const cambiar = (s) => {
    const r = [];
    for (let i = 0; i < s.length; i += 1) for (const c of CIFRAS_PARECIDAS[s[i]] || '') r.push(s.slice(0, i) + c + s.slice(i + 1));
    return r;
  };
  for (const dd of [d, ...cambiar(d)]) for (const mm of [m, ...cambiar(m), ...(m === '01' ? ['10', '11', '12'] : [])]) out.add(`${dd}/${mm}/${y}`);
  out.delete(fecha);
  return [...out].filter((f) => {
    const [a, b] = f.split('/').map(Number);
    return a >= 1 && a <= 31 && b >= 1 && b <= 12 && diaUTC(f) != null && new Date(diaUTC(f)).getUTCDate() === a;
  });
}

// Cada fila tiene que caer cerca del día del reporte (el del nombre del PDF o del archivo) o, si no
// lo dice, del día de la captura. Si no, se prueba con las cifras que el OCR suele confundir; si
// tampoco, toma el día de la fila de arriba (o el del reporte). En los dos casos, para revisar.
function ajustarFechas(filas, hoy, fechaDefecto) {
  const ref = diaUTC(fechaDefecto);
  const hoyDia = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());
  // Con el día del reporte: hasta 3 días antes (la lista puede seguir con "29 oct", "28 oct").
  const [desde, hasta] = ref != null ? [ref - 3 * 86400000, ref + 2 * 86400000] : [hoyDia - 20 * 86400000, hoyDia + 7 * 86400000];
  const centro = ref != null ? ref : hoyDia;
  const dentro = (f) => {
    const t = diaUTC(f);
    return t != null && t >= desde && t <= hasta;
  };
  let anterior = '';
  for (const f of filas) {
    if (!f.fecha || dentro(f.fecha)) {
      if (f.fecha) anterior = f.fecha;
      continue;
    }
    const cand = variantesFecha(f.fecha)
      .filter(dentro)
      .sort((a, b) => Math.abs(diaUTC(a) - centro) - Math.abs(diaUTC(b) - centro))[0];
    // Sin una cifra que la explique: si la fecha es absurda (meses de distancia) se toma la de arriba
    // o la del reporte; si no, se deja (puede ser un movimiento de otro día) pero para revisar.
    const absurda = Math.abs(diaUTC(f.fecha) - centro) > 60 * 86400000;
    const nueva = cand || (absurda ? (anterior && dentro(anterior) ? anterior : ref != null ? fechaDefecto : '') : '');
    if (nueva) f.fecha = nueva;
    f.dudoso = true;
    if (f.fecha) anterior = f.fecha;
  }
}

export function claveFila(f) {
  // Con número de operación (comprobantes) solo se une la misma operación.
  if (f.ref) return `ref|${f.ref}`;
  // Con hora alcanza con día, hora, tipo y monto: el nombre puede venir mal leído en una de las dos
  // capturas (por ejemplo, cortado arriba de la pantalla).
  if (f.hora) return `${f.fecha}|${f.hora}|${f.tipo}|${f.monto}`;
  return `${f.fecha}|${f.tipo}|${f.monto}|${nameTokens(f.nombre).join(' ')}`;
}

// ---------------------------------------------------------------------------
// Comprobante de transferencia de Mercado Pago (un movimiento por imagen):
//   Comprobante de transferencia / 6/octubre/2026 a las 18:49. / $ 22.500 / Motivo: Varios /
//   Origen y destino / Carlos … / Mercado Pago / CVU … / Guido … / … / N.º de operación … / 181758083051

const NO_NOMBRE = /mercado ?pago|cvu|cbu|cuit|cuil|alias|banco|brubank|uala|naranja|personal pay|^\W*$/i;

export function esComprobante(lines) {
  const t = lines.map((l) => l.text || '').join('\n');
  return /comprobante/i.test(t) && /origen y destino|de operaci/i.test(t);
}

function nombreComprobante(txt) {
  const toks = String(txt || '')
    .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ'., ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Restos del ícono a la izquierda ("G", "<", "GS", "EG").
  while (toks.length > 2 && /^[A-ZÁÉÍÓÚÑ]{1,3}$/.test(toks[0])) toks.shift();
  return toks.join(' ');
}

// lines: renglones de la primera lectura; lines2: de la segunda (segmentación automática).
export function parsearComprobante(lines, lines2 = [], { hoy = new Date(), imagen = '' } = {}) {
  const pasadas = [lines, lines2].map((ls) => ls.map((l) => String(l.text || '').replace(/\s+/g, ' ').trim()).filter(Boolean));
  const buscar = (fn) => {
    for (const ts of pasadas) {
      const r = fn(ts);
      if (r) return r;
    }
    return null;
  };
  const fh = buscar((ts) => {
    for (const t of ts) {
      const m = t
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .match(/(\d{1,2})\s*\/\s*([a-z0-9]{2,12})\s*\/\s*(\d{4})(?:\s*a\s*las\s*(\d{1,2})[:.](\d{2}))?/i);
      if (!m) continue;
      const mes = /^\d+$/.test(m[2]) ? +m[2] : mesDeTexto(m[2]);
      if (!mes) continue;
      return { fecha: inferirFecha(+m[1], mes, m[3], hoy), hora: m[4] ? `${pad(m[4])}:${m[5]}` : '' };
    }
    return null;
  });
  // Monto: el renglón que es solo "$ 22.500" (la publicidad de abajo dice "Transferí $ 3.00").
  const monto = buscar((ts) => {
    for (const t of ts) {
      const m = t.match(/^[+\-−–]?\s*\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*$/);
      if (m) return parseNumber(m[1]);
    }
    return null;
  });
  const motivo = buscar((ts) => {
    for (const t of ts) {
      const m = t.match(/motivo:?\s*(.+)$/i);
      if (m) return m[1].trim();
    }
    return null;
  });
  const partes = buscar((ts) => {
    const i = ts.findIndex((t) => /origen y destino/i.test(t));
    if (i < 0) return null;
    const nombres = [];
    for (let j = i + 1; j < ts.length && nombres.length < 2; j += 1) {
      if (/operaci/i.test(ts[j])) break;
      if (NO_NOMBRE.test(ts[j]) || /\d{4,}/.test(ts[j])) continue;
      const n = nombreComprobante(ts[j]);
      if (n.split(' ').length >= 2) nombres.push(n);
    }
    return nombres.length === 2 ? { origen: nombres[0], destino: nombres[1] } : null;
  });
  const ref = buscar((ts) => {
    const i = ts.findIndex((t) => /operaci/i.test(t));
    for (const t of i >= 0 ? ts.slice(i, i + 3) : ts) {
      const m = t.match(/\b(\d{9,16})\b/);
      if (m) return m[1];
    }
    return null;
  });
  if (!monto && !partes) return null;
  return {
    comprobante: true,
    fecha: fh?.fecha || '',
    hora: fh?.hora || '',
    nombre: partes?.origen || '',
    origen: partes?.origen || '',
    destino: partes?.destino || '',
    tipo: 'COBRO',
    monto: monto || 0,
    truncado: false,
    leyenda: motivo && !/^varios$/i.test(motivo) ? `Motivo: ${motivo}` : '',
    ref: ref || '',
    dudoso: !fh?.fecha || !monto || !partes || !ref,
    imagen,
  };
}

// Cobro o pago según quién es el titular de la cuenta: el nombre que se repite como origen
// o destino en los comprobantes, o el que figura en el nombre de la cuenta ingresado.
export function resolverComprobantes(filas, cuenta = '') {
  const comps = filas.filter((f) => f.comprobante && f.origen && f.destino);
  if (!comps.length) return null;
  const k = (n) => nameTokens(n).join(' ');
  const cuentaK = k(cuenta);
  const cuenta2 = new Map();
  for (const f of comps) for (const n of [f.origen, f.destino]) cuenta2.set(k(n), (cuenta2.get(k(n)) || 0) + 1);
  let titular = [...cuenta2.entries()].find(([n]) => n && cuentaK.includes(n))?.[0];
  if (!titular) {
    const [n, veces] = [...cuenta2.entries()].sort((a, b) => b[1] - a[1])[0];
    if (veces >= 2) titular = n;
  }
  for (const f of comps) {
    if (titular && k(f.destino) === titular) {
      f.tipo = 'COBRO';
      f.nombre = f.origen;
    } else if (titular && k(f.origen) === titular) {
      f.tipo = 'PAGO';
      f.nombre = f.destino;
    } else {
      f.tipo = 'COBRO';
      f.nombre = f.origen;
      f.dudoso = true;
    }
  }
  return titular || null;
}

// Une capturas consecutivas: si el final de una coincide con el principio de otra
// (el mismo movimiento aparece en las dos), se cuenta una sola vez.
// consecutivas: las listas están en orden (páginas de un PDF) y solo se une cada una con la siguiente.
export function unirCapturas(listas, { consecutivas = false } = {}) {
  if (consecutivas) {
    // Cuántas filas del final de "a" son las primeras de "b".
    const solape = (a, b) => {
      let k = Math.min(a.length, b.length);
      for (; k >= 1; k -= 1) {
        let ok = true;
        for (let t = 0; t < k && ok; t += 1) ok = claveFila(a[a.length - k + t]) === claveFila(b[t]);
        if (ok) break;
      }
      return k;
    };
    const filas = [];
    let quitadas = 0;
    let anterior = null;
    for (const l of listas.filter((x) => x.length)) {
      if (!anterior) {
        filas.push(...l);
        anterior = l;
        continue;
      }
      // Las capturas pueden ir hacia abajo (el final de la anterior se repite al principio de
      // esta) o hacia arriba (el final de esta se repite al principio de la anterior).
      const abajo = solape(anterior, l);
      const arriba = abajo ? 0 : solape(l, anterior);
      quitadas += abajo + arriba;
      filas.push(...l.slice(abajo, l.length - arriba));
      anterior = l;
    }
    return { filas, quitadas };
  }
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

export const CAPTURA_HEADER = ['Fecha', 'Titular', 'Operación', 'Monto', 'Cuenta', 'Imagen', 'Leyenda', 'Hora', 'Turno', 'Referencia', 'Origen: captura de pantalla'];

// Tabla que se guarda como fuente (así se puede guardar en el trabajo y volver a leer).
export function filasATabla(filas, cuenta) {
  return [CAPTURA_HEADER, ...filas.map((f) => [f.fecha, f.nombre + (f.truncado ? '...' : ''), f.tipo === 'COBRO' ? 'Cobro' : 'Pago', f.monto, f.cuenta || cuenta, f.imagen || '', leyendaVisible(f.leyenda), f.hora || '', f.hora ? '' : f.turno || '', f.ref || ''])];
}

// ---------------------------------------------------------------------------
// Capturas anchas de la compu (Mercado Pago "Actividad"): el titular, la hora, el estado y el
// monto quedan en columnas separadas y a alturas distintas, y la lectura por renglones las mezcla.
// Con las palabras sueltas del OCR (cada una con su posición) se arma cada movimiento alrededor
// de su monto: el texto de arriba es el titular, el de abajo la leyenda, y la hora la que esté
// a la misma altura. Devuelve renglones en el formato A ("Titular $monto" / "Leyenda hora").
const PALABRA_PLATA = /^[+\-−–]?\$[\d.,]+$/;
// Sin "$" pero con signo ("+3.100,00", "-308.100,00"), como en Ualá.
const PALABRA_PLATA_SIN_PESOS = /^[+\-−–]\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$/;
export function lineasPorMonto(lines) {
  const words = lines
    .flatMap((l) => (l.words || []).map((w) => ({ text: String(w.text || '').trim(), bbox: w.bbox, conf: w.confidence ?? l.confidence })))
    .filter((w) => w.text && w.bbox);
  const cy = (w) => (w.bbox.y0 + w.bbox.y1) / 2;
  // Montos: "+$2.500" en una palabra, o "-" / "$" sueltos delante del número.
  const montos = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (PALABRA_PLATA.test(w.text) && /\d/.test(w.text)) montos.push({ w, texto: w.text });
    else if (PALABRA_PLATA_SIN_PESOS.test(w.text)) montos.push({ w, texto: `${w.text[0]}$${w.text.slice(1)}` });
    else if (/^[+\-−–]$/.test(w.text) && words[i + 1] && PALABRA_PLATA.test(words[i + 1].text) && Math.abs(cy(words[i + 1]) - cy(w)) < 20) {
      montos.push({ w: words[i + 1], texto: `${w.text}${words[i + 1].text}` });
      i += 1;
    }
  }
  if (montos.length < 2) return [];
  montos.sort((a, b) => cy(a.w) - cy(b.w));
  const xMonto = Math.min(...montos.map((m) => m.w.bbox.x0));
  const usados = new Set(montos.map((m) => m.w));
  // Altura típica de una palabra: los íconos y avatares (mucho más altos) se descartan.
  const alturas = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const altoTipico = alturas[Math.floor(alturas.length / 2)] || 20;
  const renglonesDe = (ws) => {
    const rs = [];
    for (const w of [...ws].filter((x) => x.bbox.y1 - x.bbox.y0 <= 1.6 * altoTipico).sort((a, b) => cy(a) - cy(b))) {
      const r = rs.find((x) => Math.abs(x.cy - cy(w)) < 0.5 * altoTipico);
      if (r) r.ws.push(w);
      else rs.push({ cy: cy(w), ws: [w] });
    }
    return rs
      .sort((a, b) => a.cy - b.cy)
      .map((r) => ({ y0: Math.min(...r.ws.map((w) => w.bbox.y0)), y1: Math.max(...r.ws.map((w) => w.bbox.y1)), ws: r.ws, text: r.ws.sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join(' ') }));
  };
  const out = [];
  // Encabezados arriba del primer movimiento ("Hoy", "Ayer", "5 de octubre").
  const alto = montos[0].w.bbox.y1 - montos[0].w.bbox.y0;
  const inicio = cy(montos[0].w) - 3 * alto;
  for (const r of renglonesDe(words.filter((w) => cy(w) < inicio))) out.push({ text: r.text, confidence: 90 });
  montos.forEach((m, k) => {
    const y = cy(m.w);
    const desde = k ? (cy(montos[k - 1].w) + y) / 2 : inicio;
    const hasta = k < montos.length - 1 ? (cy(montos[k + 1].w) + y) / 2 : y + 3 * alto;
    const zona = words.filter((w) => !usados.has(w) && cy(w) >= desde && cy(w) < hasta && w.bbox.x1 <= xMonto);
    const hora = zona.find((w) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(w.text));
    const texto = renglonesDe(zona.filter((w) => w !== hora).map((w) => ({ ...w, text: sinEstado(w.text) })).filter((w) => w.text));
    // Lo que está a la altura del monto (ícono, "Dinero disponible", "Aprobado") no es ni titular ni leyenda.
    const centro = (r) => (r.y0 + r.y1) / 2;
    const arriba = texto.filter((r) => centro(r) < y - 0.5 * altoTipico && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(r.text));
    const abajo = texto.filter((r) => centro(r) > y + 0.5 * altoTipico);
    // Las iniciales del avatar ("GR", "VS") quedan a la izquierda, separadas del nombre.
    const fila = arriba.at(-1);
    const ws = fila ? [...fila.ws] : [];
    if (ws.length > 2 && /^[A-ZÁÉÍÓÚÑ]{1,3}$/.test(ws[0].text) && ws[1].bbox.x0 - ws[0].bbox.x1 > 1.5 * altoTipico) ws.shift();
    const titular = sinEstado(ws.map((w) => w.text).join(' '));
    const leyenda = sinEstado(abajo.map((r) => r.text).join(' '));
    const conf = Math.min(...[...(arriba.at(-1)?.ws || []), m.w].map((w) => w.conf ?? 90));
    out.push({ text: `${titular} ${m.texto}`, confidence: conf });
    out.push({ text: `${leyenda} ${hora ? hora.text : ''}`.trim(), confidence: 90 });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Varias lecturas de la misma captura (a distintas escalas): el monto de cada fila se decide
// por mayoría. Una fila que falta en la lectura principal pero aparece igual en las otras dos se
// agrega. Lo que se cambió o no tiene mayoría queda para revisar.
const claveNombre = (f) =>
  String(f.nombre || '')
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase()
    .slice(0, 8);
const mismaFila = (a, b) => {
  if (a.tipo !== b.tipo) return false;
  const [x, y] = [claveNombre(a), claveNombre(b)];
  if (!x || !y) return !x && !y;
  const n = Math.min(x.length, y.length, 6);
  return n >= 4 && x.slice(0, n) === y.slice(0, n);
};

export function votarLecturas(base, otras) {
  const usadas = otras.map(() => new Set());
  // Para cada lectura extra: índice de la fila de la base con la que se emparejó cada una de sus filas.
  const aBase = otras.map(() => new Map());
  const res = base.map((f, i) => {
    const montos = [f.monto];
    otras.forEach((o, k) => {
      let mejor = -1;
      o.forEach((g, j) => {
        if (usadas[k].has(j) || !mismaFila(f, g)) return;
        if (mejor < 0 || Math.abs(j - i) < Math.abs(mejor - i)) mejor = j;
      });
      if (mejor >= 0) {
        usadas[k].add(mejor);
        aBase[k].set(mejor, i);
        montos.push(o[mejor].monto);
      }
    });
    if (montos.length < 2) return f;
    const cuenta = new Map();
    // "+$3.000" leído "+53.000": un monto igual a otro con un 5 (u 8) adelante es el "$" mal leído.
    const sinPeso = (m) => montos.find((u) => u && u !== m && /^[58]$/.test(String(m).slice(0, String(m).length - String(u).length)) && String(m).endsWith(String(u))) ?? m;
    for (const m of montos) if (m) cuenta.set(sinPeso(m), (cuenta.get(sinPeso(m)) || 0) + 1);
    const orden = [...cuenta].sort((a, b) => b[1] - a[1]);
    const [ganador, votos] = orden[0] || [];
    // Empate (2 y 2): no se elige; queda el de la lectura principal, para revisar.
    if (orden[1] && orden[1][1] === votos) return { ...f, dudoso: true };
    if (votos >= 2 && ganador !== f.monto) return { ...f, monto: ganador, dudoso: true };
    if (!(votos >= 2) && montos.length >= 3) return { ...f, dudoso: true };
    return f;
  });
  // Filas que la lectura principal perdió: están en las otras dos lecturas, iguales.
  if (otras.length >= 2) {
    const [o1, o2] = otras;
    const agregadas = [];
    const usadas2 = new Set();
    o1.forEach((g, j) => {
      if (usadas[0].has(j)) return;
      const j2 = o2.findIndex((h, n) => !usadas[1].has(n) && !usadas2.has(n) && mismaFila(g, h) && g.monto === h.monto && g.monto);
      if (j2 < 0) return;
      usadas2.add(j2);
      // Va después de la fila de la base que corresponde a la anterior en esa lectura.
      let antes = -1;
      for (let p = j - 1; p >= 0 && antes < 0; p -= 1) if (aBase[0].has(p)) antes = aBase[0].get(p);
      // Si al lado ya hay una fila con el mismo monto, es la misma con el nombre mal leído.
      const vecinas = [base[antes], base[antes + 1]].filter(Boolean);
      if (vecinas.some((v) => v.tipo === g.tipo && v.monto === g.monto)) return;
      agregadas.push({ antes, fila: { ...g, dudoso: true } });
    });
    for (const a of agregadas.reverse()) res.splice(a.antes + 1, 0, a.fila);
  }
  return res;
}
