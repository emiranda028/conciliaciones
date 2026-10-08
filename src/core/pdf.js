// PDF con capturas (por ejemplo, los que arma CamScanner): saca las imágenes JPEG
// de cada página, en orden, para leerlas con el OCR como si fueran capturas sueltas.
// No es un lector de PDF completo: solo lo necesario para las imágenes y el título.

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};

// Índice de objetos "n 0 obj": número -> posición donde empieza su contenido.
function indexarObjetos(txt) {
  const objs = new Map();
  const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(txt))) objs.set(Number(m[1]), m.index + m[0].length);
  return objs;
}

// Diccionario de nivel superior que empieza en pos (devuelve el texto entre << y >>).
function leerDicc(txt, pos) {
  const ini = txt.indexOf('<<', pos);
  if (ini < 0) return null;
  let prof = 0;
  for (let i = ini; i < txt.length - 1; i += 1) {
    if (txt[i] === '<' && txt[i + 1] === '<') {
      prof += 1;
      i += 1;
    } else if (txt[i] === '>' && txt[i + 1] === '>') {
      prof -= 1;
      i += 1;
      if (!prof) return { texto: txt.slice(ini, i + 1), fin: i + 1 };
    }
  }
  return null;
}

const ref = (s) => {
  const m = /^\s*(\d+)\s+\d+\s+R/.exec(s || '');
  return m ? Number(m[1]) : null;
};

// Valor de una clave en un diccionario: número, referencia, nombre, arreglo o subdiccionario.
function valor(dicc, clave) {
  const re = new RegExp(`/${clave}(?![A-Za-z0-9])\\s*`, 'g');
  let m;
  while ((m = re.exec(dicc))) {
    // Solo claves del nivel superior.
    const antes = dicc.slice(0, m.index);
    const prof = (antes.match(/<</g) || []).length - (antes.match(/>>/g) || []).length;
    if (prof !== 1) continue;
    const resto = dicc.slice(re.lastIndex);
    if (resto.startsWith('<<')) return leerDicc(resto, 0)?.texto ?? null;
    if (resto.startsWith('[')) return resto.slice(0, resto.indexOf(']') + 1);
    const r = /^(\d+\s+\d+\s+R|[^\s/<>[\]()]+|\/[^\s/<>[\]()]+|\([^)]*\)|<[0-9A-Fa-f\s]*>)/.exec(resto);
    return r ? r[1] : null;
  }
  return null;
}

export function esPdf(bytes) {
  return bytes.length > 5 && latin1(bytes.subarray(0, 1024)).includes('%PDF-');
}

// Devuelve { titulo, imagenes: [{ pagina, ancho, alto, bytes }] }.
export function imagenesDePdf(bytes, { minLado = 200 } = {}) {
  const txt = latin1(bytes);
  const objs = indexarObjetos(txt);
  const dicc = (n) => (objs.has(n) ? leerDicc(txt, objs.get(n)) : null);
  const resolver = (v) => {
    const n = ref(v);
    if (n == null) return v;
    const d = dicc(n);
    if (d && txt.slice(objs.get(n), objs.get(n) + 40).trimStart().startsWith('<<')) return d.texto;
    const m = /^\s*([^\s]+)/.exec(txt.slice(objs.get(n) ?? 0, (objs.get(n) ?? 0) + 40));
    return m ? m[1] : null;
  };

  const imagen = (n, pagina) => {
    const d = dicc(n);
    if (!d || !/\/Subtype\s*\/Image/.test(d.texto) || !/\/DCTDecode/.test(d.texto)) return null;
    const ancho = Number(resolver(valor(d.texto, 'Width')));
    const alto = Number(resolver(valor(d.texto, 'Height')));
    if (!(ancho >= minLado && alto >= minLado)) return null;
    const s = txt.indexOf('stream', d.fin);
    if (s < 0) return null;
    let ini = s + 6;
    if (txt[ini] === '\r') ini += 1;
    if (txt[ini] === '\n') ini += 1;
    let fin = null;
    const largo = Number(resolver(valor(d.texto, 'Length')));
    if (largo > 0 && txt.slice(ini + largo, ini + largo + 12).includes('endstream')) fin = ini + largo;
    if (fin == null) {
      fin = txt.indexOf('endstream', ini);
      if (fin < 0) return null;
      while (fin > ini && (txt[fin - 1] === '\n' || txt[fin - 1] === '\r')) fin -= 1;
    }
    const datos = bytes.slice(ini, fin);
    if (datos[0] !== 0xff || datos[1] !== 0xd8) return null;
    return { pagina, ancho, alto, bytes: datos };
  };

  // Páginas en orden, siguiendo el árbol /Pages desde el catálogo.
  const paginas = [];
  const raiz = ref(valor(leerDicc(txt, txt.lastIndexOf('trailer'))?.texto || '', 'Root'));
  const visitar = (n, prof = 0) => {
    const d = dicc(n);
    if (!d || prof > 20) return;
    if (/\/Type\s*\/Pages\b/.test(d.texto)) {
      const kids = valor(d.texto, 'Kids') || '';
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) visitar(Number(k[1]), prof + 1);
    } else if (/\/Type\s*\/Page\b/.test(d.texto)) paginas.push(d.texto);
  };
  if (raiz != null) visitar(ref(valor(dicc(raiz)?.texto || '', 'Pages')));

  const imagenes = [];
  const vistas = new Set();
  paginas.forEach((p, i) => {
    const res = resolver(valor(p, 'Resources')) || '';
    const xo = resolver(valor(res, 'XObject')) || '';
    for (const m of xo.matchAll(/\/[^\s/<>[\]]+\s+(\d+)\s+\d+\s+R/g)) {
      const n = Number(m[1]);
      if (vistas.has(n)) continue;
      vistas.add(n);
      const img = imagen(n, i + 1);
      if (img) imagenes.push(img);
    }
  });
  // Sin árbol de páginas legible: todas las imágenes en el orden del archivo.
  if (!paginas.length) {
    let pag = 0;
    for (const n of [...objs.keys()].sort((a, b) => objs.get(a) - objs.get(b))) {
      const img = imagen(n, (pag += 1));
      if (img) imagenes.push(img);
    }
  }

  return { titulo: tituloPdf(txt), imagenes };
}

function tituloPdf(txt) {
  const info = ref(valor(leerDicc(txt, txt.lastIndexOf('trailer'))?.texto || '', 'Info'));
  if (info == null) return '';
  const objs = indexarObjetos(txt);
  const d = objs.has(info) ? leerDicc(txt, objs.get(info)) : null;
  const m = d && /\/Title\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(d.texto);
  if (!m) return '';
  let s = m[1];
  if (s.startsWith('<')) {
    const hex = s.slice(1, -1).replace(/\s/g, '');
    s = '';
    for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  } else {
    s = s
      .slice(1, -1)
      .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\(.)/g, '$1');
  }
  if (s.startsWith('\xfe\xff')) {
    let u = '';
    for (let i = 2; i + 1 < s.length; i += 2) u += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    s = u;
  } else {
    // Texto en UTF-8 guardado como bytes.
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
    } catch {
      /* queda como latin1 */
    }
  }
  return s.trim();
}
