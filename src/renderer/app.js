// Interfaz del Conciliador (sin frameworks: se arma HTML y se delegan eventos).
import {
  DEFAULT_CONFIG,
  mergeConfig,
  fuentesDesdeArchivo,
  fuenteDesdeTexto,
  parseFuente,
  headerSignature,
  IMPORTER_OPTIONS,
  ejecutar,
  sugerirDia,
  unirDiccionario,
  agregarAlDiccionario,
  quitarDelDiccionario,
  diccionarioDesdeTabla,
  serializarTrabajo,
  deserializarTrabajo,
  tableToFuente,
  agentesDePaneles,
  DEFAULT_LINEAS,
} from '../core/session.js';
import { parsearCaptura, unirCapturas, filasATabla } from '../core/capturas.js';
import { readFile, decodeText } from '../core/tabular.js';
import { exportarExcel, TRAMOS, turnoDe } from '../core/report.js';
import { ESTADOS, DEFAULT_PARAMS } from '../core/matcher.js';
import { fmtDate, fmtTime, horaDe, fmtDateTime, fmtDuration, fmtMoney, round2, cleanText, isoDay, parseNumber } from '../core/util.js';
import ExcelJS from 'exceljs';

// ---------------------------------------------------------------------------
// Estado

const api = window.api || {
  // Modo navegador (pruebas): guarda en localStorage y descarga archivos.
  loadConfig: async () => JSON.parse(localStorage.getItem('conciliador-config') || 'null'),
  saveConfig: async (d) => localStorage.setItem('conciliador-config', JSON.stringify(d)),
  dataDir: async () => '(navegador)',
  saveFile: async (name, data) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = name;
    a.click();
    return name;
  },
  openFile: async () => null,
};

const state = {
  view: 'cargar',
  config: mergeConfig(null),
  fuentes: [],
  manual: { forzados: [], estados: {}, rechazados: [] },
  dia: '',
  run: null,
  dataDir: '',
  // filtros y selección por vista
  f: {
    conc: { q: '', estado: '', conf: '', tipo: '' },
    pend: { q: '', tipo: '', info: false },
    tiempos: 'COBRO',
    config: 'lineas',
    dicQ: '',
  },
  sel: new Set(),
};

const VIEWS = [
  { key: 'cargar', label: 'Cargar reportes' },
  { key: 'resumen', label: 'Resumen' },
  { key: 'conciliacion', label: 'Conciliadas' },
  { key: 'pendientes', label: 'Pendientes' },
  { key: 'tiempos', label: 'Tiempos' },
  { key: 'config', label: 'Configuración' },
];

const ESTADOS_MANUALES = [
  ESTADOS.COBRO_SIN_FICHA,
  ESTADOS.PAGO_DUPLICADO,
  'Error de carga',
  ESTADOS.BONO,
  ESTADOS.INTERNO,
  'Se compensa con otra partida',
  'Corresponde a otro día',
  'A revisar',
  'Otro',
];

const INFORMATIVOS = new Set([ESTADOS.BONO, ESTADOS.INTERNO, ESTADOS.COMISION, ESTADOS.REVERTIDO]);

// ---------------------------------------------------------------------------
// Utilidades de UI

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const money = (n) => (n == null ? '' : `$ ${fmtMoney(n)}`);
const signed = (r) => (r.tipo === 'PAGO' ? -r.monto : r.monto);

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), err ? 7000 : 3500);
}

function modal({ title, body, foot, narrow, onMount, persistente }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal${narrow ? ' narrow' : ''}">
    <div class="modal-head">${esc(title)}</div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${foot || '<button class="btn" data-close>Cerrar</button>'}</div>
  </div></div>`;
  const el = $('.modal', root);
  const close = () => (root.innerHTML = '');
  $$('[data-close]', el).forEach((b) => b.addEventListener('click', close));
  if (!persistente)
    $('.modal-back', root).addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('modal-back')) close();
    });
  if (onMount) onMount(el, close);
  return close;
}

function prompt({ title, label, value = '', okText = 'Aceptar', extra = '' }) {
  return new Promise((resolve) => {
    modal({
      title,
      narrow: true,
      body: `${extra}<label class="field"><span>${esc(label)}</span><input id="pr-in" value="${esc(value)}" /></label>`,
      foot: `<button class="btn" data-close>Cancelar</button><button class="btn primary" id="pr-ok">${esc(okText)}</button>`,
      onMount(el, close) {
        const inp = $('#pr-in', el);
        inp.focus();
        const ok = () => {
          const extraVals = {};
          $$('[data-extra]', el).forEach((x) => (extraVals[x.dataset.extra] = x.value));
          close();
          resolve({ value: inp.value, ...extraVals });
        };
        $('#pr-ok', el).addEventListener('click', ok);
        inp.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
        $$('[data-close]', el).forEach((b) => b.addEventListener('click', () => resolve(null)));
      },
    });
  });
}

function estadoBadge(estado) {
  let cls = 'warn';
  if (estado.startsWith('Conciliado') || estado.startsWith('Compensado')) cls = 'ok';
  else if (INFORMATIVOS.has(estado)) cls = 'info';
  else if ([ESTADOS.PAGO_DUPLICADO, ESTADOS.COBRO_SIN_FICHA, 'Error de carga'].includes(estado)) cls = 'bad';
  return `<span class="badge ${cls}">${esc(estado)}</span>`;
}

function confBadge(c) {
  const map = { alta: ['ok', 'Alta'], media: ['warn', 'Media'], baja: ['bad', 'Revisar'], manual: ['info', 'Manual'] };
  const [cls, txt] = map[c] || ['', c];
  return `<span class="badge ${cls}">${txt}</span>`;
}

const tipoTxt = (t) => ({ COBRO: 'Cobro', PAGO: 'Pago', BONO: 'Bono', INTERNO: 'Interno', COMISION: 'Comisión', REVERTIDO: 'Revertido' })[t] || t;

// ---------------------------------------------------------------------------
// Persistencia y recálculo

let saveTimer = null;
function saveConfigSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveConfig(state.config).catch((e) => toast(`No se pudo guardar la configuración: ${e.message}`, true)), 400);
}

function recompute() {
  const hayDatos = state.fuentes.some((f) => f.activa && f.records.length);
  if (!hayDatos) {
    state.run = null;
    return;
  }
  state.run = ejecutar({ fuentes: state.fuentes, config: state.config, manual: state.manual, dia: state.dia, linea: state.config.lineaActiva });
  const antes = JSON.stringify(state.config.diccionario);
  state.config.diccionario = unirDiccionario(state.config.diccionario, state.run.diccionarioAprendido);
  if (JSON.stringify(state.config.diccionario) !== antes) saveConfigSoon();
  // La selección solo conserva ids que siguen pendientes.
  const pend = new Set(state.run.vista.pendientes.map((p) => p.registro.id));
  for (const id of [...state.sel]) if (!pend.has(id)) state.sel.delete(id);
}

function refresh() {
  recompute();
  render();
}

// ---------------------------------------------------------------------------
// Render general

function render() {
  const run = state.run;
  const nPend = run ? run.vista.pendientes.filter((p) => !INFORMATIVOS.has(p.estado)).length : 0;
  const counts = {
    conciliacion: run ? run.vista.matches.length : 0,
    pendientes: nPend,
  };
  $('#nav').innerHTML = VIEWS.map((v) => {
    const disabled = !run && ['resumen', 'conciliacion', 'pendientes', 'tiempos'].includes(v.key);
    const c = counts[v.key];
    return `<button data-view="${v.key}" class="${state.view === v.key ? 'active' : ''}" ${disabled ? 'disabled' : ''}>
      <span>${v.label}</span>${c != null && run ? `<span class="count">${c}</span>` : ''}</button>`;
  }).join('');
  $('#sidebar-foot').innerHTML = `Funciona sin conexión.<br>Datos: ${esc(state.dataDir)}`;

  const view = VIEWS.find((v) => v.key === state.view);
  $('#view-title').textContent = view.label;
  $('#view-sub').innerHTML = run?.ventana
    ? `Día operativo ${esc(fmtDateTime(run.ventana.from))} a ${esc(fmtDateTime(run.ventana.to))}`
    : run
      ? 'Sin filtro de día'
      : '';

  $('#topbar-actions').innerHTML = `
    ${run ? diaSelectorHtml() : ''}
    <button class="btn" data-act="abrir-trabajo">Abrir trabajo</button>
    <button class="btn" data-act="guardar-trabajo" ${state.fuentes.length ? '' : 'disabled'}>Guardar trabajo</button>
    <button class="btn primary" data-act="exportar" ${run ? '' : 'disabled'}>Exportar a Excel</button>`;

  // Conservar la posición de scroll al redibujar la misma vista (p. ej. al tildar un pendiente).
  const mismaVista = render.last === state.view;
  const scrolls = mismaVista ? $$('#view .scroll').map((e) => e.scrollTop) : [];
  const viewScroll = mismaVista ? $('#view').scrollTop : 0;
  render.last = state.view;
  const fn = { cargar: viewCargar, resumen: viewResumen, conciliacion: viewConciliacion, pendientes: viewPendientes, tiempos: viewTiempos, config: viewConfig }[state.view];
  $('#view').innerHTML = fn();
  $$('#view .scroll').forEach((e, i) => (e.scrollTop = scrolls[i] || 0));
  $('#view').scrollTop = viewScroll;
  afterRender[state.view]?.();
}

function lineaSelectHtml(id) {
  const act = state.config.lineaActiva;
  return `<select id="${id}" data-linea-select title="Concilia solo los agentes de esa línea">
    <option value="">Todas las líneas</option>
    ${state.config.lineas.map((l) => `<option ${l.nombre === act ? 'selected' : ''}>${esc(l.nombre)}</option>`).join('')}
  </select>`;
}

function diaSelectorHtml() {
  return `<label class="row small muted">Línea ${lineaSelectHtml('linea')}</label><label class="row small muted" title="El día operativo va de las ${state.config.horaInicioDia}:00 hasta las ${state.config.horaInicioDia}:00 del día siguiente">
    Día operativo <input type="date" id="dia" value="${esc(state.dia)}" />
    <button class="btn sm" data-act="dia-todo" ${state.dia ? '' : 'disabled'}>Ver todo</button></label>`;
}

const afterRender = {};

// ---------------------------------------------------------------------------
// Vista: Cargar

function viewCargar() {
  const opts = (f) =>
    [
      `<option value="">No usar</option>`,
      ...IMPORTER_OPTIONS.map((o) => `<option value="${o.key}" ${f.importerKey === o.key ? 'selected' : ''}>${esc(o.label)}</option>`),
      `<option value="GENERICO" ${f.importerKey === 'GENERICO' ? 'selected' : ''}>Otro formato: mapear columnas…</option>`,
    ].join('');
  const filas = state.fuentes
    .map((f) => {
      const cobros = f.records.filter((r) => r.tipo === 'COBRO').length;
      const pagos = f.records.filter((r) => r.tipo === 'PAGO').length;
      const otros = f.records.length - cobros - pagos;
      const cant = f.nombres
        ? `${Object.keys(f.nombres).length} titulares`
        : `${f.records.length} <span class="muted small">(${cobros} cobros, ${pagos} pagos${otros ? `, ${otros} otros` : ''})</span>`;
      return `<tr class="${f.activa ? '' : 'off'}">
        <td><input type="checkbox" data-fuente-activa="${f.id}" ${f.activa ? 'checked' : ''} ${f.importerKey ? '' : 'disabled'} /></td>
        <td><div>${esc(f.nombre)}</div>${f.hoja ? `<div class="muted small">Hoja: ${esc(f.hoja)}</div>` : ''}${f.error ? `<div class="neg small">${esc(f.error)}</div>` : ''}</td>
        <td><select data-fuente-tipo="${f.id}">${opts(f)}</select></td>
        <td>${f.lado ? `<span class="badge ${f.lado === 'panel' ? 'info' : 'ok'}">${f.lado === 'panel' ? 'Panel (fichas)' : 'Billetera (dinero)'}</span>` : ''}</td>
        <td>${cant}${f.skipped ? `<div class="muted small">${f.skipped} filas ignoradas</div>` : ''}</td>
        <td class="nowrap small">${f.desde ? `${esc(fmtDateTime(f.desde))}<br>${esc(fmtDateTime(f.hasta))}` : ''}</td>
        <td class="nowrap"><button class="btn sm" data-fuente-ver="${f.id}">Ver</button> <button class="btn sm danger" data-fuente-quitar="${f.id}">Quitar</button></td>
      </tr>`;
    })
    .join('');
  const noReconocidas = state.fuentes.filter((f) => !f.importerKey).length;
  return `
    <div class="grid2">
      <div class="card">
        <h2>1. Reportes descargados</h2>
        <label class="dropzone" id="drop">
          <div class="big">Arrastrá acá los archivos o hacé clic para elegirlos</div>
          <div class="muted">Excel (.xlsx) o CSV: User Transactions de BETS, reporte de Cash, reportes de Mercado Pago, planillas de GANEMOS o ZEUS.</div>
          <div class="muted">También capturas de pantalla (.png, .jpg) de "Mis movimientos" de las billeteras.</div>
          <input type="file" id="file-in" multiple accept=".xlsx,.xlsm,.csv,.txt,.png,.jpg,.jpeg,.webp,.bmp" hidden />
        </label>
      </div>
      <div class="card">
        <h2>2. Pegar desde el panel</h2>
        <div class="row" style="margin-bottom:8px">
          <select id="paste-tipo">
            <option value="AUTO">Detectar plataforma</option>
            <option value="GANEMOS">GANEMOS</option>
            <option value="ZEUS">ZEUS</option>
          </select>
          <span class="muted small">Seleccioná todo en la web del panel, copiá (Ctrl+C) y pegá acá (Ctrl+V).</span>
        </div>
        <textarea id="paste-txt" placeholder="Pegá acá el contenido copiado del panel…"></textarea>
        <div class="row" style="margin-top:8px"><span class="spacer"></span><button class="btn" data-act="pegar">Agregar lo pegado</button></div>
      </div>
    </div>
    <div class="card">
      <div class="row"><h2 style="margin:0">Fuentes cargadas</h2><span class="spacer"></span>
        ${state.fuentes.length ? '<button class="btn sm danger" data-act="quitar-todo">Quitar todo</button>' : ''}</div>
      ${noReconocidas ? `<div class="notice warn" style="margin-top:12px">${noReconocidas} hoja(s) no se reconocieron y quedaron sin usar. Si alguna tiene movimientos, elegí "Otro formato: mapear columnas…".</div>` : ''}
      ${
        state.fuentes.length
          ? `<div class="scroll" style="margin-top:12px"><table class="tbl"><thead><tr><th></th><th>Archivo</th><th>Formato</th><th>Lado</th><th>Movimientos</th><th>Desde / hasta</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>`
          : '<div class="empty"><div class="big">Todavía no cargaste reportes</div>Cargá el panel (fichas) y las billeteras (dinero) del día a conciliar.</div>'
      }
    </div>
    ${
      state.fuentes.some((f) => f.activa && f.records.length)
        ? `<div class="card"><h2>3. Conciliar</h2><div class="row">
            <label class="field"><span>Línea</span>${lineaSelectHtml('linea-cargar')}</label>
            <label class="field"><span>Día operativo (desde las ${state.config.horaInicioDia}:00)</span><input type="date" id="dia-cargar" value="${esc(state.dia)}" /></label>
            <span class="muted small" style="max-width:420px">Se concilian todos los movimientos cargados y se muestran los del día elegido. Dejalo vacío para ver todo.
              Con una línea elegida, de los paneles solo se toman los agentes de esa línea.</span>
            <span class="spacer"></span><button class="btn primary" data-act="conciliar">Conciliar</button></div>
            ${agentesResumenHtml()}</div>`
        : ''
    }`;
}

// Agentes encontrados en los paneles cargados y a qué línea pertenecen.
function agentesResumenHtml() {
  const ags = agentesDePaneles(state.fuentes, state.config);
  if (!ags.length) return '';
  const act = state.config.lineaActiva;
  const sinLinea = ags.filter((a) => !a.linea);
  return `<h3>Agentes en los paneles cargados</h3><div class="row">
    ${ags
      .map((a) => {
        const cls = !a.linea ? 'bad' : act && a.linea !== act ? '' : 'ok';
        const txt = !a.linea ? 'sin línea' : a.linea;
        return `<span class="badge ${cls}" title="${esc(a.origenes.join(', '))}">${esc(a.agente)} · ${a.movimientos} · ${esc(txt)}</span>`;
      })
      .join('')}
    </div>${sinLinea.length ? `<p class="small neg">Hay agentes sin línea asignada. Asignalos en Configuración → Líneas y agentes; si no, quedan afuera al elegir una línea.</p>` : ''}
    ${act ? `<p class="small muted">En verde, los agentes que entran en la línea ${esc(act)}. Los demás se dejan afuera.</p>` : ''}`;
}

afterRender.cargar = () => {
  const drop = $('#drop');
  const input = $('#file-in');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    cargarArchivos([...e.dataTransfer.files]);
  });
  input.addEventListener('change', () => cargarArchivos([...input.files]));
};

const ES_IMAGEN = /\.(png|jpe?g|webp|bmp)$/i;

async function cargarArchivos(files) {
  if (!files.length) return;
  const imagenes = files.filter((f) => ES_IMAGEN.test(f.name));
  files = files.filter((f) => !ES_IMAGEN.test(f.name));
  if (imagenes.length) leerCapturas(imagenes);
  if (!files.length) return;
  let n = 0;
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const nuevas = await fuentesDesdeArchivo(file.name, buf, state.config);
      state.fuentes.push(...nuevas);
      n += nuevas.filter((f) => f.activa).length;
    } catch (e) {
      toast(`${file.name}: ${e.message}`, true);
    }
  }
  if (!state.dia) state.dia = sugerirDia(state.fuentes, state.config);
  toast(`${n} fuente(s) reconocida(s).`);
  refresh();
}

// ---------------------------------------------------------------------------
// Capturas de pantalla: OCR local, revisión y alta como fuente

async function leerCapturas(files) {
  if (!api.leerCaptura) {
    toast('La lectura de capturas solo está disponible en la aplicación de escritorio.', true);
    return;
  }
  files = [...files].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  const cap = { listas: [], unir: true, cuenta: state.config.ultimaCuentaCaptura || '', errores: [] };
  const close = modal({
    title: `Leyendo ${files.length} captura(s)…`,
    persistente: true,
    body: '<div class="empty"><div class="big" id="cap-prog">Preparando el lector…</div>La primera lectura tarda unos segundos más.</div>',
    foot: '<span class="muted small">Todo se procesa en esta computadora, sin conexión.</span>',
  });
  for (let i = 0; i < files.length; i += 1) {
    const prog = $('#cap-prog');
    if (prog) prog.textContent = `Leyendo imagen ${i + 1} de ${files.length}: ${files[i].name}`;
    try {
      const lines = await api.leerCaptura(new Uint8Array(await files[i].arrayBuffer()));
      const filas = parsearCaptura(lines, { imagen: files[i].name });
      if (!filas.length) cap.errores.push(`${files[i].name}: no se encontraron movimientos.`);
      cap.listas.push(filas);
    } catch (e) {
      cap.errores.push(`${files[i].name}: ${e.message || e}`);
    }
  }
  close();
  revisarCapturas(cap);
}

function capFilas(cap) {
  const listas = cap.listas.map((l) => l.filter((f) => !f.borrada));
  if (!cap.unir) return { filas: listas.flat(), quitadas: 0 };
  return unirCapturas(listas);
}

function revisarCapturas(cap) {
  const cuerpo = () => {
    const { filas, quitadas } = capFilas(cap);
    const cob = filas.filter((f) => f.tipo === 'COBRO');
    const pag = filas.filter((f) => f.tipo === 'PAGO');
    const sum = (a) => a.reduce((s, f) => s + (Number(f.monto) || 0), 0);
    const dudosas = filas.filter((f) => f.dudoso).length;
    return `
      ${cap.errores.map((e) => `<div class="notice warn">${esc(e)}</div>`).join('')}
      <div class="notice info">Las capturas no muestran la hora: estos movimientos se cruzan por día, monto y titular, y no entran en la medición de tiempos.
        Revisá lo leído antes de agregarlo; las filas resaltadas conviene mirarlas con la imagen.</div>
      <div class="row" style="align-items:flex-end;margin-bottom:12px">
        <label class="field"><span>Billetera / cuenta de estas capturas *</span><input id="cap-cuenta" value="${esc(cap.cuenta)}" placeholder="Ej.: Personal Pay caja 3" style="width:280px" /></label>
        <label class="row small"><input type="checkbox" id="cap-unir" ${cap.unir ? 'checked' : ''} /> Quitar movimientos repetidos entre capturas que se superponen${quitadas ? ` (${quitadas} quitados)` : ''}</label>
        <span class="spacer"></span>
        <div class="small muted">${filas.length} movimientos · ${cob.length} cobros ${money(sum(cob))} · ${pag.length} pagos ${money(sum(pag))}${dudosas ? ` · <b class="neg">${dudosas} a revisar</b>` : ''}</div>
      </div>
      <div class="scroll" style="max-height:52vh"><table class="tbl"><thead><tr><th>Imagen</th><th>Fecha</th><th>Titular</th><th>Operación</th><th class="num">Monto</th><th>Leyenda</th><th></th></tr></thead><tbody>
      ${filas
        .map(
          (f) => `<tr class="${f.dudoso ? 'sel' : ''}" data-cap-row>
          <td class="small muted">${esc(f.imagen)}</td>
          <td><input data-cap="fecha" value="${esc(f.fecha)}" style="width:110px" /></td>
          <td><input data-cap="nombre" value="${esc(f.nombre)}${f.truncado ? '...' : ''}" style="width:290px" /></td>
          <td><select data-cap="tipo"><option value="COBRO" ${f.tipo === 'COBRO' ? 'selected' : ''}>Cobro (entra)</option><option value="PAGO" ${f.tipo === 'PAGO' ? 'selected' : ''}>Pago (sale)</option></select></td>
          <td class="num"><input data-cap="monto" value="${esc(fmtMoney(f.monto))}" style="width:120px;text-align:right" /></td>
          <td><input data-cap="leyenda" value="${esc(f.leyenda || '')}" placeholder="—" style="width:170px" /></td>
          <td><button class="btn sm danger" data-cap-borrar>Quitar</button></td></tr>`
        )
        .join('')}
      </tbody></table></div>`;
  };
  modal({
    title: 'Revisar movimientos leídos de las capturas',
    persistente: true,
    body: `<div id="cap-body">${cuerpo()}</div>`,
    foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" id="cap-ok">Agregar a la conciliación</button>',
    onMount(el, close) {
      const body = $('#cap-body', el);
      const filasVisibles = () => capFilas(cap).filas;
      const redraw = () => {
        const top = $('.scroll', body)?.scrollTop || 0;
        body.innerHTML = cuerpo();
        const sc = $('.scroll', body);
        if (sc) sc.scrollTop = top;
      };
      body.addEventListener('change', (e) => {
        const t = e.target;
        if (t.id === 'cap-unir') {
          cap.unir = t.checked;
          redraw();
          return;
        }
        if (t.id === 'cap-cuenta') {
          cap.cuenta = t.value.trim();
          return;
        }
        if (!t.dataset.cap) return;
        const idx = $$('[data-cap-row]', body).indexOf(t.closest('tr'));
        const f = filasVisibles()[idx];
        if (!f) return;
        if (t.dataset.cap === 'monto') f.monto = parseNumber(t.value) ?? f.monto;
        else if (t.dataset.cap === 'nombre') {
          f.truncado = /(\.\.\.|…)\s*$/.test(t.value);
          f.nombre = t.value.replace(/(\.\.\.|…)\s*$/, '').trim();
        } else f[t.dataset.cap] = t.value.trim();
        f.dudoso = false;
        redraw();
      });
      body.addEventListener('click', (e) => {
        if (!e.target.matches('[data-cap-borrar]')) return;
        const idx = $$('[data-cap-row]', body).indexOf(e.target.closest('tr'));
        const f = filasVisibles()[idx];
        if (f) f.borrada = true;
        redraw();
      });
      $('#cap-ok', el).addEventListener('click', () => {
        cap.cuenta = ($('#cap-cuenta', el)?.value || cap.cuenta).trim();
        if (!cap.cuenta) return toast('Indicá a qué billetera o cuenta corresponden las capturas.', true);
        const filas = filasVisibles();
        const malas = filas.filter((f) => !/^\d{2}\/\d{2}\/\d{4}$/.test(f.fecha) || !(f.monto > 0));
        if (malas.length) return toast(`Hay ${malas.length} fila(s) sin fecha (dd/mm/aaaa) o monto válido. Corregilas o quitálas.`, true);
        if (!filas.length) return toast('No hay movimientos para agregar.', true);
        const nImg = new Set(filas.map((f) => f.imagen)).size;
        const fuente = tableToFuente(`Capturas: ${cap.cuenta} (${nImg} imágenes)`, { sheet: null, rows: filasATabla(filas, cap.cuenta) }, state.config);
        state.fuentes.push(fuente);
        state.config.ultimaCuentaCaptura = cap.cuenta;
        saveConfigSoon();
        if (!state.dia) state.dia = sugerirDia(state.fuentes, state.config);
        close();
        toast(`${fuente.records.length} movimientos agregados desde las capturas.`);
        refresh();
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Vista: Resumen

function viewResumen() {
  const r = state.run.resumen;
  const pct = Math.round(r.avance * 100);
  const dif = r.diferenciaNeta;
  const avisos = [];
  const sinUsar = state.fuentes.filter((f) => !f.activa || !f.importerKey).length;
  if (sinUsar) avisos.push(`${sinUsar} hoja(s) o archivo(s) cargados no se están usando.`);
  const excl = Object.entries(state.run.excluidosLinea || {});
  if (excl.length) {
    const txt = excl
      .sort((a, b) => b[1] - a[1])
      .map(([ag, n]) => {
        const l = state.config.lineas.find((x) => x.agentes.some((a) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === ag.toLowerCase().replace(/[^a-z0-9]/g, '')));
        return `${ag} (${n}${l ? `, línea ${l.nombre}` : ', sin línea'})`;
      })
      .join(', ');
    avisos.push(`Línea ${state.run.linea}: de los paneles cargados (todos los días) se dejaron afuera ${excl.reduce((s, e) => s + e[1], 0)} movimientos de otros agentes: ${txt}.`);
  }
  if (state.run.duplicadosDescartados) avisos.push(`Se descartaron ${state.run.duplicadosDescartados} movimientos que venían repetidos en más de un archivo u hoja.`);
  if (!state.run.panel.length) avisos.push('No hay movimientos de panel (fichas) cargados.');
  if (!state.run.billetera.length) avisos.push('No hay movimientos de billeteras (dinero) cargados.');
  const revisar = state.run.vista.matches.filter((m) => m.confianza === 'baja').length;
  if (revisar) avisos.push(`${revisar} partida(s) conciliadas automáticamente conviene revisarlas: el titular no coincide con el que se conocía para ese usuario.`);

  const estadoRows = r.porEstado
    .sort((a, b) => (a.grupo === b.grupo ? b.cantidad - a.cantidad : a.grupo === 'conciliado' ? -1 : 1))
    .map(
      (e) => `<tr><td>${estadoBadge(e.estado)}</td><td class="num">${e.cantidad}</td><td class="num">${money(e.montoPanel)}</td><td class="num">${money(e.montoBilletera)}</td></tr>`
    )
    .join('');
  const origenRows = r.porOrigen
    .map(
      (o) => `<tr><td>${o.lado === 'panel' ? 'Panel' : 'Billetera'}</td><td>${esc(o.origen)}</td><td>${esc(o.cuenta)}</td>
      <td class="num">${o.nCobros}</td><td class="num">${money(o.cobros)}</td><td class="num">${o.nPagos}</td><td class="num">${money(o.pagos)}</td><td class="num">${money(o.neto)}</td></tr>`
    )
    .join('');
  const tc = state.run.tiempos.COBRO.general;
  const tp = state.run.tiempos.PAGO.general;
  return `
    ${avisos.map((a) => `<div class="notice warn">${esc(a)}</div>`).join('')}
    <div class="kpis">
      <div class="kpi ${pct === 100 ? 'good' : ''}"><div class="lbl">Avance de conciliación</div><div class="val">${pct}%</div>
        <div class="sub">${r.nConciliados} de ${r.nPanelOperables} movimientos de panel</div><div class="progress"><div style="width:${pct}%"></div></div></div>
      <div class="kpi"><div class="lbl">Cobros: fichas / dinero</div><div class="val">${money(r.panel.cobros)}</div><div class="sub">Billeteras: ${money(r.billetera.cobros)}</div></div>
      <div class="kpi"><div class="lbl">Pagos: fichas / dinero</div><div class="val">${money(r.panel.pagos)}</div><div class="sub">Billeteras: ${money(r.billetera.pagos)}</div></div>
      <div class="kpi ${Math.abs(dif) < 0.01 ? 'good' : 'bad'}"><div class="lbl">Diferencia neta (panel - billeteras)</div><div class="val">${money(dif)}</div>
        <div class="sub">Neto panel ${money(r.panel.neto)} · billeteras ${money(r.billetera.neto)}</div></div>
      <div class="kpi"><div class="lbl">Demora cobro → fichas</div><div class="val">${fmtDuration(tc.mediana) || '-'}</div><div class="sub">mediana · promedio ${fmtDuration(tc.promedio) || '-'}</div></div>
      <div class="kpi"><div class="lbl">Demora retiro → pago</div><div class="val">${fmtDuration(tp.mediana) || '-'}</div><div class="sub">mediana · promedio ${fmtDuration(tp.promedio) || '-'}</div></div>
    </div>
    <div>
      <div class="card"><h2>Partidas por estado</h2>
        <table class="tbl"><thead><tr><th>Estado</th><th class="num">Cant.</th><th class="num">Panel</th><th class="num">Billeteras</th></tr></thead><tbody>${estadoRows}</tbody></table>
        <p class="muted small">Montos con signo: cobros positivos, pagos negativos.</p></div>
      <div class="card xscroll"><h2>Por panel y cuenta</h2>
        <table class="tbl"><thead><tr><th>Lado</th><th>Origen</th><th>Agente / cuenta</th><th class="num">Cobros</th><th class="num">$</th><th class="num">Pagos</th><th class="num">$</th><th class="num">Neto</th></tr></thead><tbody>${origenRows}</tbody></table>
        ${r.panel.bonos ? `<p class="muted small">Bonificaciones cargadas en panel (sin dinero): ${money(r.panel.bonos)}</p>` : ''}
        ${r.billetera.comisiones ? `<p class="muted small">Comisiones en billeteras: ${money(r.billetera.comisiones)}</p>` : ''}
        ${r.billetera.internos ? `<p class="muted small">Movimientos internos entre cuentas: ${money(r.billetera.internos)}</p>` : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Vista: Conciliadas

function filtrarMatches() {
  const f = state.f.conc;
  const q = f.q.trim().toLowerCase();
  return state.run.vista.matches.filter((m) => {
    if (f.estado && m.estado !== f.estado) return false;
    if (f.conf && m.confianza !== f.conf) return false;
    if (f.tipo && m.tipo !== f.tipo) return false;
    if (q) {
      const txt = [...m.panel, ...m.billetera].map((r) => `${r.persona} ${r.cuenta} ${r.monto} ${r.ref}`).join(' ').toLowerCase();
      if (!txt.includes(q)) return false;
    }
    return true;
  });
}

function viewConciliacion() {
  const f = state.f.conc;
  const estados = [...new Set(state.run.vista.matches.map((m) => m.estado))];
  const list = filtrarMatches();
  const lim = 1500;
  const rows = list
    .slice(0, lim)
    .map((m) => {
      const p = m.panel;
      const w = m.billetera;
      const lines = (arr, fn) => arr.map((r) => `<div>${fn(r)}</div>`).join('');
      return `<tr>
        <td>${estadoBadge(m.estado)}${m.nota ? `<div class="muted small">${esc(m.nota)}</div>` : ''}</td>
        <td>${confBadge(m.confianza)}</td>
        <td>${tipoTxt(m.tipo)}</td>
        <td class="nowrap">${lines(p, (r) => esc(horaDe(r)))}</td>
        <td>${lines(p, (r) => `${esc(r.cuenta)} <span class="muted small">${esc(r.origen)}</span>`)}</td>
        <td>${lines(p, (r) => esc(r.persona))}</td>
        <td class="num">${lines(p, (r) => money(signed(r)))}</td>
        <td class="nowrap">${lines(w, (r) => esc(horaDe(r)))}</td>
        <td>${lines(w, (r) => `${esc(r.cuenta)} <span class="muted small">${esc(r.origen)}</span>`)}</td>
        <td>${lines(w, (r) => `${esc(r.persona)}${r.sinHora && r.detalle ? ` <span class="muted small">(${esc(r.detalle)})</span>` : ''}`)}</td>
        <td class="num">${lines(w, (r) => money(signed(r)))}</td>
        <td class="num ${m.diferencia ? 'neg' : ''}">${m.diferencia ? money(m.diferencia) : ''}</td>
        <td class="nowrap">${esc(fmtDuration(m.demora))}</td>
        <td><button class="btn sm" data-deshacer="${esc(m.id)}" title="Separar esta partida y volver a dejarla pendiente">Deshacer</button></td>
      </tr>`;
    })
    .join('');
  return `
    <div class="filters">
      <input type="search" id="conc-q" placeholder="Buscar usuario, titular, monto…" value="${esc(f.q)}" />
      <select id="conc-estado"><option value="">Todos los estados</option>${estados.map((e) => `<option ${f.estado === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>
      <select id="conc-conf"><option value="">Toda confianza</option>
        ${['alta', 'media', 'baja', 'manual'].map((c) => `<option value="${c}" ${f.conf === c ? 'selected' : ''}>${{ alta: 'Alta', media: 'Media', baja: 'Revisar', manual: 'Manual' }[c]}</option>`).join('')}</select>
      <select id="conc-tipo"><option value="">Cobros y pagos</option><option value="COBRO" ${f.tipo === 'COBRO' ? 'selected' : ''}>Cobros</option><option value="PAGO" ${f.tipo === 'PAGO' ? 'selected' : ''}>Pagos</option></select>
      <span class="muted small">${list.length} partidas${list.length > lim ? ` (se muestran ${lim})` : ''}</span>
    </div>
    <div class="scroll" style="max-height:calc(100vh - 210px)"><table class="tbl">
      <thead><tr><th>Estado</th><th>Confianza</th><th>Op.</th>
      <th>Hora panel</th><th>Agente</th><th>Usuario</th><th class="num">Fichas</th>
      <th>Hora billetera</th><th>Cuenta</th><th>Titular</th><th class="num">Dinero</th><th class="num">Dif.</th><th>Demora</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="14" class="empty">No hay partidas con esos filtros.</td></tr>'}</tbody></table></div>`;
}

afterRender.conciliacion = () => {
  const bind = (id, key) =>
    $(id).addEventListener(id === '#conc-q' ? 'input' : 'change', (e) => {
      state.f.conc[key] = e.target.value;
      const pos = e.target.selectionStart;
      render();
      if (id === '#conc-q') {
        $(id).focus();
        $(id).setSelectionRange(pos, pos);
      }
    });
  bind('#conc-q', 'q');
  bind('#conc-estado', 'estado');
  bind('#conc-conf', 'conf');
  bind('#conc-tipo', 'tipo');
};

function deshacer(matchId) {
  const m = state.run.vista.matches.find((x) => x.id === matchId);
  if (!m) return;
  if (m.estado === ESTADOS.MANUAL) {
    const key = (ids) => ids.slice().sort().join(',');
    const pk = key(m.panel.map((r) => r.id));
    const wk = key(m.billetera.map((r) => r.id));
    state.manual.forzados = state.manual.forzados.filter((f) => !(key(f.panel) === pk && key(f.billetera) === wk));
  } else {
    for (const p of m.panel) for (const w of m.billetera) state.manual.rechazados.push(`${p.id}|${w.id}`);
    // Si el diccionario asociaba a este usuario con este titular por esta partida, se olvida.
    if (m.panel.length === 1 && m.billetera.length === 1 && m.confianza !== 'alta') {
      state.config.diccionario = quitarDelDiccionario(state.config.diccionario, cleanKey(m.panel[0].persona), nameKeyOf(m.billetera[0].persona));
      saveConfigSoon();
    }
  }
  toast('Partida separada. Quedó en Pendientes.');
  refresh();
}

// ---------------------------------------------------------------------------
// Vista: Pendientes

function filtrarPend() {
  const f = state.f.pend;
  const q = f.q.trim().toLowerCase();
  return state.run.vista.pendientes.filter((p) => {
    const r = p.registro;
    if (!f.info && INFORMATIVOS.has(p.estado) && !state.sel.has(r.id)) return false;
    if (f.tipo && r.tipo !== f.tipo) return false;
    if (q && !`${r.persona} ${r.cuenta} ${r.monto} ${r.ref} ${p.estado}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function pendTable(list, lado, hints) {
  const rows = list
    .map((p) => {
      const r = p.registro;
      const sel = state.sel.has(r.id);
      const man = state.manual.estados[r.id];
      return `<tr class="${sel ? 'sel' : hints.has(r.id) ? 'hint' : ''}" data-pend-row="${esc(r.id)}">
        <td><input type="checkbox" data-pend="${esc(r.id)}" ${sel ? 'checked' : ''} /></td>
        <td class="nowrap">${esc(horaDe(r))}<div class="muted small">${esc(fmtDate(r.ts))}</div></td>
        <td>${tipoTxt(r.tipo)}</td>
        <td>${esc(r.persona)}<div class="muted small">${esc(r.cuenta)} · ${esc(r.origen)}${r.sinHora && r.detalle ? ` · <b>${esc(r.detalle)}</b>` : ''}</div></td>
        <td class="num">${money(signed(r))}</td>
        <td>${estadoBadge(p.estado)}${p.nota ? `<div class="muted small">${esc(p.nota)}</div>` : ''}
          ${man ? `<div><button class="link small" data-quitar-estado="${esc(r.id)}">Quitar marca</button></div>` : ''}</td>
      </tr>`;
    })
    .join('');
  return `<div class="scroll" style="max-height:calc(100vh - 290px)"><table class="tbl"><thead><tr><th></th><th>Hora</th><th>Op.</th><th>${lado === 'panel' ? 'Usuario / agente' : 'Titular / cuenta'}</th><th class="num">Monto</th><th>Estado</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="empty">Nada pendiente.</td></tr>'}</tbody></table></div>`;
}

function viewPendientes() {
  const f = state.f.pend;
  const list = filtrarPend();
  const panel = list.filter((p) => p.registro.lado === 'panel');
  const bill = list.filter((p) => p.registro.lado !== 'panel');
  const todos = new Map(state.run.vista.pendientes.map((p) => [p.registro.id, p.registro]));
  const selRecs = [...state.sel].map((id) => todos.get(id)).filter(Boolean);
  const selP = selRecs.filter((r) => r.lado === 'panel');
  const selW = selRecs.filter((r) => r.lado !== 'panel');
  const sum = (arr) => round2(arr.reduce((s, r) => s + signed(r), 0));
  // Sugerencias: con un solo movimiento elegido, resaltar los del otro lado con el mismo monto.
  const hints = new Set();
  if (selRecs.length === 1) {
    const s = selRecs[0];
    for (const p of state.run.vista.pendientes) {
      const r = p.registro;
      if (r.lado !== s.lado && r.tipo === s.tipo && Math.abs(r.monto - s.monto) < 0.01) hints.add(r.id);
    }
  }
  const sumP = sum(selP);
  const sumW = sum(selW);
  return `
    <div class="filters">
      <input type="search" id="pend-q" placeholder="Buscar usuario, titular, monto…" value="${esc(f.q)}" />
      <select id="pend-tipo"><option value="">Cobros y pagos</option><option value="COBRO" ${f.tipo === 'COBRO' ? 'selected' : ''}>Cobros</option><option value="PAGO" ${f.tipo === 'PAGO' ? 'selected' : ''}>Pagos</option></select>
      <label class="row small"><input type="checkbox" id="pend-info" ${f.info ? 'checked' : ''} /> Mostrar bonos, internos, comisiones y revertidos</label>
      <span class="muted small">Elegí movimientos de ambos lados para conciliarlos a mano, o marcá su estado. Al elegir uno solo se resaltan en verde los del otro lado con el mismo monto.</span>
    </div>
    <div class="grid2">
      <div class="card" style="padding:12px"><h2>Panel · fichas <span class="muted small">(${panel.length})</span></h2>${pendTable(panel, 'panel', hints)}</div>
      <div class="card" style="padding:12px"><h2>Billeteras · dinero <span class="muted small">(${bill.length})</span></h2>${pendTable(bill, 'billetera', hints)}</div>
    </div>
    ${
      selRecs.length
        ? `<div class="selbar">
        <div>Panel: <b>${selP.length}</b> · ${money(sumP)}</div>
        <div>Billeteras: <b>${selW.length}</b> · ${money(sumW)}</div>
        <div>Diferencia: <b class="${Math.abs(sumP - sumW) > 0.009 ? 'neg' : ''}">${money(round2(sumP - sumW))}</b></div>
        <span class="spacer"></span>
        <button class="btn" data-act="sel-limpiar">Limpiar selección</button>
        <button class="btn" data-act="sel-marcar">Marcar estado…</button>
        <button class="btn primary" data-act="sel-conciliar" ${selP.length && selW.length ? '' : 'disabled'}>Conciliar selección</button>
      </div>`
        : ''
    }`;
}

afterRender.pendientes = () => {
  $('#pend-q').addEventListener('input', (e) => {
    state.f.pend.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    $('#pend-q').focus();
    $('#pend-q').setSelectionRange(pos, pos);
  });
  $('#pend-tipo').addEventListener('change', (e) => {
    state.f.pend.tipo = e.target.value;
    render();
  });
  $('#pend-info').addEventListener('change', (e) => {
    state.f.pend.info = e.target.checked;
    render();
  });
};

async function conciliarSeleccion() {
  const todos = new Map(state.run.vista.pendientes.map((p) => [p.registro.id, p.registro]));
  const recs = [...state.sel].map((id) => todos.get(id)).filter(Boolean);
  const ps = recs.filter((r) => r.lado === 'panel');
  const ws = recs.filter((r) => r.lado !== 'panel');
  const dif = round2(ps.reduce((s, r) => s + signed(r), 0) - ws.reduce((s, r) => s + signed(r), 0));
  const r = await prompt({
    title: 'Conciliar a mano',
    label: 'Nota (opcional)',
    okText: 'Conciliar',
    extra: dif ? `<div class="notice warn">Hay una diferencia de ${money(dif)} entre lo elegido. Dejá una nota explicándola.</div>` : '',
  });
  if (!r) return;
  for (const x of recs) delete state.manual.estados[x.id];
  state.manual.forzados.push({ panel: ps.map((x) => x.id), billetera: ws.map((x) => x.id), nota: r.value });
  if (ps.length === 1 && ws.length === 1 && ps[0].persona && ws[0].persona) {
    state.config.diccionario = agregarAlDiccionario(state.config.diccionario, ps[0].persona, ws[0].persona);
    saveConfigSoon();
  }
  state.sel.clear();
  toast('Conciliado.');
  refresh();
}

async function marcarSeleccion() {
  const r = await prompt({
    title: `Marcar ${state.sel.size} movimiento(s)`,
    label: 'Nota (opcional)',
    okText: 'Marcar',
    extra: `<label class="field" style="margin-bottom:10px"><span>Estado</span><select data-extra="estado">${ESTADOS_MANUALES.map((e) => `<option>${esc(e)}</option>`).join('')}</select></label>`,
  });
  if (!r) return;
  for (const id of state.sel) state.manual.estados[id] = { estado: r.estado, nota: r.value };
  state.sel.clear();
  refresh();
}

// ---------------------------------------------------------------------------
// Vista: Tiempos

function statsTable(titulo, list) {
  return `<h3>${esc(titulo)}</h3><table class="tbl"><thead><tr><th></th><th class="num">Partidas</th><th class="num">Promedio</th><th class="num">Mediana</th><th class="num">Percentil 90</th><th class="num">Máximo</th></tr></thead><tbody>
    ${list.map((s) => `<tr><td>${esc(s.clave)}</td><td class="num">${s.cantidad}</td><td class="num">${fmtDuration(s.promedio)}</td><td class="num">${fmtDuration(s.mediana)}</td><td class="num">${fmtDuration(s.p90)}</td><td class="num">${fmtDuration(s.maximo)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin datos</td></tr>'}
  </tbody></table>`;
}

function viewTiempos() {
  const tipo = state.f.tiempos;
  const t = state.run.tiempos[tipo];
  const g = t.general;
  const max = Math.max(1, ...t.tramos.map((x) => x.cantidad));
  const desc =
    tipo === 'COBRO'
      ? 'Tiempo desde que entra el dinero a la billetera hasta que se cargan las fichas en el panel.'
      : 'Tiempo desde que se retiran las fichas del panel hasta que sale el pago de la billetera.';
  return `
    <div class="tabs">
      <button data-tiempos="COBRO" class="${tipo === 'COBRO' ? 'active' : ''}">Cobros: dinero → fichas</button>
      <button data-tiempos="PAGO" class="${tipo === 'PAGO' ? 'active' : ''}">Pagos: fichas → dinero</button>
    </div>
    <p class="muted">${desc} Solo se miden partidas conciliadas. Un valor negativo indica que en los reportes el orden aparece invertido (diferencia de relojes).</p>
    <div class="kpis">
      <div class="kpi"><div class="lbl">Partidas medidas</div><div class="val">${g.cantidad || 0}</div></div>
      <div class="kpi"><div class="lbl">Promedio</div><div class="val">${fmtDuration(g.promedio) || '-'}</div></div>
      <div class="kpi"><div class="lbl">Mediana</div><div class="val">${fmtDuration(g.mediana) || '-'}</div></div>
      <div class="kpi"><div class="lbl">9 de cada 10 en menos de</div><div class="val">${fmtDuration(g.p90) || '-'}</div></div>
      <div class="kpi"><div class="lbl">Máximo</div><div class="val">${fmtDuration(g.maximo) || '-'}</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>Distribución</h2><div class="bars">
        ${t.tramos.map((x) => `<div class="bar-row"><div>${esc(x.nombre)}</div><div class="bar"><div style="width:${(x.cantidad / max) * 100}%"></div></div><div class="num">${x.cantidad}</div></div>`).join('')}
      </div>
      ${statsTable('Por turno', t.porTurno)}</div>
      <div class="card">${statsTable('Por cajero / agente del panel', t.porCajero)}${statsTable('Por cuenta de billetera', t.porCuenta)}</div>
    </div>
    <div class="card"><h2>Las más lentas</h2><table class="tbl"><thead><tr><th>Demora</th><th>Turno</th><th>Hora billetera</th><th>Hora panel</th><th>Agente</th><th>Usuario</th><th>Titular</th><th class="num">Monto</th></tr></thead><tbody>
      ${t.lentas
        .slice(0, 15)
        .map(
          (m) => `<tr><td class="nowrap"><b>${fmtDuration(m.demora)}</b></td><td>${esc(turnoDe(m.panel[0].ts, state.config.turnos))}</td><td>${esc(fmtTime(m.billetera[0].ts))}</td><td>${esc(fmtTime(m.panel[0].ts))}</td>
          <td>${esc(m.panel[0].cuenta)}</td><td>${esc(m.panel[0].persona)}</td><td>${esc(m.billetera[0].persona)}</td><td class="num">${money(m.montoBilletera)}</td></tr>`
        )
        .join('')}
    </tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Vista: Configuración

function viewConfig() {
  const tab = state.f.config;
  const tabs = [
    ['lineas', 'Líneas y agentes'],
    ['parametros', 'Reglas de cruce'],
    ['turnos', 'Turnos y día'],
    ['diccionario', 'Usuarios y titulares'],
    ['cuentas', 'Nombres de cuentas'],
    ['plantillas', 'Formatos guardados'],
  ];
  let body = '';
  const p = state.config.params;
  if (tab === 'parametros') {
    const num = (k, label, help, step = 1) =>
      `<label class="field"><span>${label}</span><input type="number" step="${step}" min="0" data-param="${k}" value="${esc(p[k])}" /><em class="small">${help}</em></label>`;
    body = `<div class="grid3">
      ${num('demoraMaxCobroMin', 'Demora máxima de un cobro (min)', 'Desde que entra el dinero hasta que se cargan las fichas.')}
      ${num('demoraMaxPagoMin', 'Demora máxima de un pago (min)', 'Desde que se retiran las fichas hasta que sale el dinero.')}
      ${num('toleranciaRelojMin', 'Tolerancia de orden invertido (min)', 'Diferencia de relojes entre panel y billetera.')}
      ${num('toleranciaMonto', 'Tolerancia de monto ($)', 'Diferencia máxima para considerar dos montos iguales.', 0.01)}
      ${num('duplicadoMaxMin', 'Ventana de pagos duplicados (min)', 'Mismo titular y monto dentro de este lapso.')}
      <label class="field"><span>Bonificaciones (%)</span><input data-param="bonificaciones" value="${esc(p.bonificaciones.join(', '))}" /><em class="small">Porcentajes extra de fichas, separados por coma. Ej.: 10, 20</em></label>
      <label class="field"><span>Agrupar y compensar</span><select data-param="agrupar"><option value="1" ${p.agrupar ? 'selected' : ''}>Sí</option><option value="0" ${p.agrupar ? '' : 'selected'}>No</option></select>
        <em class="small">Buscar dos movimientos que sumen uno del otro lado, y cargas y retiros del mismo jugador que se netean.</em></label>
    </div><div class="row" style="margin-top:16px"><span class="spacer"></span><button class="btn" data-act="params-default">Restablecer valores</button></div>`;
  } else if (tab === 'turnos') {
    body = `<label class="field" style="max-width:280px"><span>El día operativo empieza a las (hora)</span><input type="number" min="0" max="23" id="hora-inicio" value="${state.config.horaInicioDia}" />
      <em class="small">Ej.: 6 = del día 24 a las 06:00 al día 25 a las 06:00.</em></label>
      <h3>Turnos</h3>
      <table class="tbl" style="max-width:640px"><thead><tr><th>Nombre</th><th>Desde</th><th>Hasta</th><th></th></tr></thead><tbody>
      ${state.config.turnos.map((t, i) => `<tr><td><input data-turno="${i}" data-k="nombre" value="${esc(t.nombre)}" /></td><td><input data-turno="${i}" data-k="desde" value="${esc(t.desde)}" style="width:80px" /></td><td><input data-turno="${i}" data-k="hasta" value="${esc(t.hasta)}" style="width:80px" /></td><td><button class="btn sm danger" data-turno-quitar="${i}">Quitar</button></td></tr>`).join('')}
      </tbody></table><div class="row" style="margin-top:8px"><button class="btn sm" data-act="turno-agregar">Agregar turno</button><span class="muted small">Horas en formato HH:MM (usar 24:00 para fin del día).</span></div>`;
  } else if (tab === 'diccionario') {
    const q = state.f.dicQ.trim().toLowerCase();
    const rows = [];
    for (const [k, e] of Object.entries(state.config.diccionario)) {
      for (const [nk, n] of Object.entries(e.nombres)) {
        if (q && !`${e.usuario} ${n.nombre}`.toLowerCase().includes(q)) continue;
        rows.push({ k, nk, usuario: e.usuario, nombre: n.nombre, veces: n.veces });
      }
    }
    rows.sort((a, b) => a.usuario.localeCompare(b.usuario));
    body = `<p class="muted">La app aprende qué titular de billetera corresponde a cada usuario del panel a medida que concilia. Estas asociaciones mejoran los cruces de los días siguientes. Un usuario puede tener varios titulares (familiares, otra cuenta).</p>
      <div class="filters"><input type="search" id="dic-q" placeholder="Buscar…" value="${esc(state.f.dicQ)}" />
        <button class="btn sm" data-act="dic-agregar">Agregar</button>
        <label class="btn sm">Importar Excel<input type="file" id="dic-import" accept=".xlsx,.csv" hidden /></label>
        <button class="btn sm" data-act="dic-exportar">Exportar Excel</button>
        <span class="muted small">${rows.length} asociaciones</span></div>
      <div class="scroll"><table class="tbl"><thead><tr><th>Usuario del panel</th><th>Titular de billetera</th><th class="num">Veces</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 2000).map((r) => `<tr><td>${esc(r.usuario)}</td><td>${esc(r.nombre)}</td><td class="num">${r.veces}</td><td><button class="btn sm danger" data-dic-quitar="${esc(r.k)}" data-nk="${esc(r.nk)}">Quitar</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Vacío</td></tr>'}
      </tbody></table></div>`;
  } else if (tab === 'cuentas') {
    const cuentas = new Set();
    for (const f of state.fuentes) for (const r of f.records) if (r.lado === 'billetera' && r.cuenta) cuentas.add(r.cuenta);
    for (const k of Object.keys(state.config.alias)) cuentas.add(k);
    body = `<p class="muted">Poné un nombre legible a las cuentas que vienen con código (por ejemplo las de Mercado Pago: "2431937166" → "MP Jose Labourdette").</p>
      <table class="tbl" style="max-width:700px"><thead><tr><th>Cuenta en el reporte</th><th>Nombre a mostrar</th></tr></thead><tbody>
      ${[...cuentas].sort().map((c) => `<tr><td>${esc(c)}</td><td><input data-alias="${esc(c)}" value="${esc(state.config.alias[c.toLowerCase().replace(/[^a-z0-9]/g, '')] || '')}" placeholder="(sin cambios)" style="width:320px" /></td></tr>`).join('') || '<tr><td colspan="2" class="muted">Cargá reportes de billeteras para ver sus cuentas.</td></tr>'}
      </tbody></table>`;
  } else if (tab === 'lineas') {
    const ags = agentesDePaneles(state.fuentes, state.config);
    body = `<p class="muted">Cada línea concilia los agentes de sus paneles contra sus billeteras. En GANEMOS y ZEUS vienen mezclados agentes de varias líneas:
      al elegir una línea, se toman solo sus agentes (el agente es el usuario del cajero: AgenteFB1, josefina.2332, agentez…).</p>
      <table class="tbl"><thead><tr><th>Línea</th><th>Agentes (separados por coma)</th><th></th></tr></thead><tbody>
      ${state.config.lineas
        .map(
          (l, i) => `<tr><td><input data-linea="${i}" data-k="nombre" value="${esc(l.nombre)}" style="width:160px" /></td>
          <td><input data-linea="${i}" data-k="agentes" value="${esc(l.agentes.join(', '))}" style="width:100%" /></td>
          <td><button class="btn sm danger" data-linea-quitar="${i}">Quitar</button></td></tr>`
        )
        .join('')}
      </tbody></table>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="linea-agregar">Agregar línea</button><span class="spacer"></span><button class="btn sm" data-act="lineas-default">Restablecer líneas</button></div>
      <h3>Agentes en los paneles cargados</h3>
      ${
        ags.length
          ? `<table class="tbl" style="max-width:760px"><thead><tr><th>Agente</th><th>Panel</th><th class="num">Movimientos</th><th>Línea</th></tr></thead><tbody>
        ${ags
          .map(
            (a) => `<tr><td>${esc(a.agente)}</td><td>${esc(a.origenes.join(', '))}</td><td class="num">${a.movimientos}</td>
            <td><select data-agente-linea="${esc(a.agente)}"><option value="">(sin línea)</option>${state.config.lineas.map((l) => `<option ${l.nombre === a.linea ? 'selected' : ''}>${esc(l.nombre)}</option>`).join('')}</select></td></tr>`
          )
          .join('')}</tbody></table>`
          : '<p class="muted">Cargá paneles para ver sus agentes.</p>'
      }`;
  } else if (tab === 'plantillas') {
    const pl = Object.entries(state.config.plantillas);
    body = `<p class="muted">Formatos de columnas que mapeaste a mano. Se aplican solos cuando cargás un archivo con los mismos encabezados.</p>
      <table class="tbl"><thead><tr><th>Nombre</th><th>Lado</th><th>Encabezados</th><th></th></tr></thead><tbody>
      ${pl.map(([sig, m]) => `<tr><td>${esc(m.origen)}</td><td>${esc(m.lado)}</td><td class="small muted">${esc(sig.slice(0, 120))}</td><td><button class="btn sm danger" data-plantilla-quitar="${esc(sig)}">Quitar</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No hay formatos guardados.</td></tr>'}
      </tbody></table>`;
  }
  return `<div class="tabs">${tabs.map(([k, l]) => `<button data-config-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="card">${body}</div>
    <p class="muted small">La configuración se guarda en: ${esc(state.dataDir)}</p>`;
}

const normAg = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

afterRender.config = () => {
  $$('[data-linea]').forEach((el) =>
    el.addEventListener('change', () => {
      const l = state.config.lineas[+el.dataset.linea];
      const anterior = l.nombre;
      if (el.dataset.k === 'nombre') {
        l.nombre = el.value.trim() || anterior;
        if (state.config.lineaActiva === anterior) state.config.lineaActiva = l.nombre;
      } else l.agentes = el.value.split(',').map((x) => x.trim()).filter(Boolean);
      saveConfigSoon();
      refresh();
    })
  );
  $$('[data-agente-linea]').forEach((el) =>
    el.addEventListener('change', () => {
      const ag = el.dataset.agenteLinea;
      for (const l of state.config.lineas) l.agentes = l.agentes.filter((a) => normAg(a) !== normAg(ag));
      const l = state.config.lineas.find((x) => x.nombre === el.value);
      if (l) l.agentes.push(ag);
      saveConfigSoon();
      refresh();
    })
  );
  $$('[data-param]').forEach((el) =>
    el.addEventListener('change', () => {
      const k = el.dataset.param;
      let v;
      if (k === 'bonificaciones') v = el.value.split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      else if (k === 'agrupar') v = el.value === '1';
      else v = Math.max(0, Number(el.value) || 0);
      state.config.params[k] = v;
      saveConfigSoon();
      recompute();
    })
  );
  const hi = $('#hora-inicio');
  if (hi)
    hi.addEventListener('change', () => {
      state.config.horaInicioDia = Math.min(23, Math.max(0, parseInt(hi.value, 10) || 0));
      saveConfigSoon();
      refresh();
    });
  $$('[data-turno]').forEach((el) =>
    el.addEventListener('change', () => {
      state.config.turnos[+el.dataset.turno][el.dataset.k] = el.value.trim();
      saveConfigSoon();
      recompute();
    })
  );
  $$('[data-alias]').forEach((el) =>
    el.addEventListener('change', () => {
      const k = el.dataset.alias.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (el.value.trim()) state.config.alias[k] = el.value.trim();
      else delete state.config.alias[k];
      saveConfigSoon();
      recompute();
    })
  );
  const dq = $('#dic-q');
  if (dq)
    dq.addEventListener('input', () => {
      state.f.dicQ = dq.value;
      const pos = dq.selectionStart;
      render();
      $('#dic-q').focus();
      $('#dic-q').setSelectionRange(pos, pos);
    });
  const di = $('#dic-import');
  if (di)
    di.addEventListener('change', async () => {
      const file = di.files[0];
      if (!file) return;
      try {
        const tables = await readFile(file.name, await file.arrayBuffer());
        const r = diccionarioDesdeTabla(tables[0]?.rows || [], state.config.diccionario);
        state.config.diccionario = r.diccionario;
        saveConfigSoon();
        toast(`${r.agregados} asociaciones importadas.`);
        refresh();
      } catch (e) {
        toast(e.message, true);
      }
    });
};

// ---------------------------------------------------------------------------
// Modales: vista previa y mapeo de columnas

function previewHtml(rows, max = 40) {
  const ncol = Math.min(30, Math.max(...rows.slice(0, max).map((r) => r.length), 1));
  const cell = (c) => esc(c instanceof Date ? fmtDateTime(c.getTime()) : c ?? '');
  return `<div class="scroll" style="max-height:50vh"><table class="tbl"><thead><tr><th>#</th>${Array.from({ length: ncol }, (_, i) => `<th>${colName(i)}</th>`).join('')}</tr></thead><tbody>
    ${rows.slice(0, max).map((r, i) => `<tr><td class="muted">${i + 1}</td>${Array.from({ length: ncol }, (_, j) => `<td class="nowrap">${cell(r[j])}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div>`;
}

function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function verFuente(f) {
  const recs = f.records.slice(0, 30);
  modal({
    title: `${f.nombre}${f.hoja ? ` / ${f.hoja}` : ''}`,
    body: `<h3>Así se leyó (${f.records.length} movimientos)</h3>
      <div class="scroll" style="max-height:30vh"><table class="tbl"><thead><tr><th>Fecha y hora</th><th>Op.</th><th>Agente / cuenta</th><th>Usuario / titular</th><th class="num">Monto</th><th>Ref.</th></tr></thead><tbody>
      ${recs.map((r) => `<tr><td class="nowrap">${esc(r.sinHora ? `${fmtDate(r.ts)} s/h` : fmtDateTime(r.ts))}</td><td>${tipoTxt(r.tipo)}</td><td>${esc(r.cuenta)}</td><td>${esc(r.persona)}</td><td class="num">${money(signed(r))}</td><td class="small">${esc(r.ref)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin movimientos</td></tr>'}
      </tbody></table></div>
      <h3>Contenido original</h3>${previewHtml(f.rows)}`,
  });
}

function mapearColumnas(f) {
  const m = f.mapping || { lado: 'panel', origen: '', headerRow: 0 };
  const campos = [
    ['fecha', 'Fecha (o fecha y hora)', true],
    ['hora', 'Hora (si está en otra columna)'],
    ['monto', 'Monto', true],
    ['tipo', 'Tipo de operación (si no, se usa el signo del monto)'],
    ['persona', 'Usuario / titular'],
    ['cuenta', 'Agente / cuenta'],
    ['ref', 'Referencia / ID'],
  ];
  const render = (el) => {
    const hr = +$('#map-hr', el).value - 1;
    const header = f.rows[hr] || [];
    const opts = (k) =>
      `<option value="">(ninguna)</option>` +
      header.map((h, i) => `<option value="${i}" ${String(m[k]) === String(i) ? 'selected' : ''}>${colName(i)}: ${esc(cleanText(h instanceof Date ? fmtDateTime(h.getTime()) : h)).slice(0, 40)}</option>`).join('');
    $('#map-campos', el).innerHTML = campos
      .map(([k, l, req]) => `<label class="field"><span>${l}${req ? ' *' : ''}</span><select data-map="${k}">${opts(k)}</select></label>`)
      .join('');
  };
  modal({
    title: 'Mapear columnas',
    body: `<div class="row" style="align-items:flex-end">
        <label class="field"><span>Fila de encabezados</span><input type="number" id="map-hr" min="1" value="${(m.headerRow ?? 0) + 1}" /></label>
        <label class="field"><span>Lado</span><select id="map-lado"><option value="panel" ${m.lado === 'panel' ? 'selected' : ''}>Panel (fichas)</option><option value="billetera" ${m.lado === 'billetera' ? 'selected' : ''}>Billetera (dinero)</option></select></label>
        <label class="field"><span>Nombre de la plataforma o billetera</span><input id="map-origen" value="${esc(m.origen || '')}" placeholder="Ej.: BANCO GALICIA" /></label>
        <label class="field"><span>Texto que indica cobro (opcional)</span><input id="map-cobro" value="${esc(m.cobroSi || '')}" placeholder="Ej.: Crédito" /></label>
      </div>
      <div class="grid3" id="map-campos" style="margin-top:12px"></div>
      <label class="row small" style="margin-top:12px"><input type="checkbox" id="map-guardar" checked /> Recordar este formato para los próximos archivos con los mismos encabezados</label>
      <h3>Contenido</h3>${previewHtml(f.rows, 15)}`,
    foot: `<button class="btn" data-close>Cancelar</button><button class="btn primary" id="map-ok">Aplicar</button>`,
    onMount(el, close) {
      render(el);
      $('#map-hr', el).addEventListener('change', () => render(el));
      $('#map-ok', el).addEventListener('click', () => {
        const mapping = { lado: $('#map-lado', el).value, origen: $('#map-origen', el).value.trim().toUpperCase(), headerRow: Math.max(0, +$('#map-hr', el).value - 1), cobroSi: $('#map-cobro', el).value.trim() };
        $$('[data-map]', el).forEach((s) => (mapping[s.dataset.map] = s.value === '' ? null : +s.value));
        if (mapping.fecha == null || mapping.monto == null) {
          toast('Elegí al menos las columnas de fecha y monto.', true);
          return;
        }
        f.importerKey = 'GENERICO';
        f.mapping = mapping;
        parseFuente(f);
        f.activa = f.records.length > 0;
        if (!f.records.length) toast('Con ese mapeo no se leyó ningún movimiento. Revisá las columnas.', true);
        if ($('#map-guardar', el).checked && f.records.length) {
          const { headerRow, ...plantilla } = mapping;
          state.config.plantillas[headerSignature(f.rows, headerRow)] = plantilla;
          saveConfigSoon();
        }
        close();
        refresh();
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Acciones

async function exportar() {
  const run = state.run;
  const titulo = `${run.ventana ? `Conciliación del día operativo ${fmtDate(run.ventana.from)}` : 'Conciliación'}${run.linea ? ` · Línea ${run.linea}` : ''}`;
  const buf = await exportarExcel({
    res: run.vista,
    resumenData: run.resumen,
    tiemposData: run.tiempos,
    panel: run.ventana ? run.panel.filter((r) => r.ts >= run.ventana.from && r.ts < run.ventana.to) : run.panel,
    billetera: run.ventana ? run.billetera.filter((r) => r.ts >= run.ventana.from && r.ts < run.ventana.to) : run.billetera,
    diccionario: state.config.diccionario,
    turnos: state.config.turnos,
    titulo,
  });
  const nombre = `Conciliacion_${run.linea ? `${run.linea}_` : ''}${state.dia || isoDay(Date.now())}.xlsx`;
  const p = await api.saveFile(nombre, new Uint8Array(buf), [{ name: 'Excel', extensions: ['xlsx'] }]);
  if (p) toast(`Guardado: ${p}`);
}

async function guardarTrabajo() {
  const txt = serializarTrabajo({ fuentes: state.fuentes, manual: state.manual, dia: state.dia });
  const p = await api.saveFile(`Trabajo_${state.dia || isoDay(Date.now())}.conciliacion`, new TextEncoder().encode(txt), [
    { name: 'Trabajo de conciliación', extensions: ['conciliacion'] },
  ]);
  if (p) toast(`Trabajo guardado: ${p}`);
}

async function abrirTrabajo() {
  const r = await api.openFile([{ name: 'Trabajo de conciliación', extensions: ['conciliacion'] }]);
  if (!r) return;
  try {
    const t = deserializarTrabajo(decodeText(r.data));
    state.fuentes = t.fuentes;
    state.manual = t.manual;
    state.dia = t.dia;
    state.sel.clear();
    state.view = 'resumen';
    toast('Trabajo abierto.');
    refresh();
  } catch (e) {
    toast(`No se pudo abrir: ${e.message}`, true);
  }
}

async function exportarDiccionario() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Usuarios y titulares');
  ws.columns = [
    { header: 'Usuario panel', width: 24 },
    { header: 'Titular billetera', width: 36 },
    { header: 'Veces', width: 8 },
  ];
  for (const e of Object.values(state.config.diccionario)) for (const n of Object.values(e.nombres)) ws.addRow([e.usuario, n.nombre, n.veces]);
  const buf = await wb.xlsx.writeBuffer();
  const p = await api.saveFile('Usuarios_y_titulares.xlsx', new Uint8Array(buf), [{ name: 'Excel', extensions: ['xlsx'] }]);
  if (p) toast(`Guardado: ${p}`);
}

const cleanKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const nameKeyOf = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 2).join(' ');

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, input[type=checkbox], [data-pend-row]');
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.view) {
      state.view = d.view;
      render();
      $('#view').scrollTop = 0;
    } else if (d.act === 'conciliar') {
      state.view = 'resumen';
      refresh();
    } else if (d.act === 'exportar') await exportar();
    else if (d.act === 'guardar-trabajo') await guardarTrabajo();
    else if (d.act === 'abrir-trabajo') await abrirTrabajo();
    else if (d.act === 'dia-todo') {
      state.dia = '';
      refresh();
    } else if (d.act === 'pegar') {
      const txt = $('#paste-txt').value;
      if (!txt.trim()) return toast('No hay nada pegado.', true);
      const f = fuenteDesdeTexto(txt, $('#paste-tipo').value, state.config);
      state.fuentes.push(f);
      if (!f.records.length) toast('No se reconocieron movimientos en el texto pegado. Probá eligiendo la plataforma o mapeando columnas.', true);
      else toast(`${f.records.length} movimientos agregados.`);
      if (!state.dia) state.dia = sugerirDia(state.fuentes, state.config);
      refresh();
    } else if (d.act === 'quitar-todo') {
      state.fuentes = [];
      state.manual = { forzados: [], estados: {}, rechazados: [] };
      state.sel.clear();
      state.dia = '';
      refresh();
    } else if (d.fuenteVer) verFuente(state.fuentes.find((f) => f.id === d.fuenteVer));
    else if (d.fuenteQuitar) {
      state.fuentes = state.fuentes.filter((f) => f.id !== d.fuenteQuitar);
      refresh();
    } else if (d.fuenteActiva) {
      const f = state.fuentes.find((x) => x.id === d.fuenteActiva);
      f.activa = t.checked;
      refresh();
    } else if (d.deshacer) deshacer(d.deshacer);
    else if (d.pend) {
      if (t.checked) state.sel.add(d.pend);
      else state.sel.delete(d.pend);
      render();
    } else if (d.pendRow && e.target.tagName !== 'BUTTON') {
      const id = d.pendRow;
      if (state.sel.has(id)) state.sel.delete(id);
      else state.sel.add(id);
      render();
    } else if (d.quitarEstado) {
      delete state.manual.estados[d.quitarEstado];
      refresh();
    } else if (d.act === 'sel-limpiar') {
      state.sel.clear();
      render();
    } else if (d.act === 'sel-conciliar') await conciliarSeleccion();
    else if (d.act === 'sel-marcar') await marcarSeleccion();
    else if (d.tiempos) {
      state.f.tiempos = d.tiempos;
      render();
    } else if (d.configTab) {
      state.f.config = d.configTab;
      render();
    } else if (d.act === 'linea-agregar') {
      state.config.lineas.push({ nombre: `Línea ${state.config.lineas.length + 1}`, agentes: [] });
      saveConfigSoon();
      render();
    } else if (d.lineaQuitar != null) {
      const [l] = state.config.lineas.splice(+d.lineaQuitar, 1);
      if (l && state.config.lineaActiva === l.nombre) state.config.lineaActiva = '';
      saveConfigSoon();
      refresh();
    } else if (d.act === 'lineas-default') {
      state.config.lineas = DEFAULT_LINEAS.map((l) => ({ ...l, agentes: [...l.agentes] }));
      saveConfigSoon();
      refresh();
    } else if (d.act === 'params-default') {
      state.config.params = { ...DEFAULT_PARAMS };
      saveConfigSoon();
      refresh();
    } else if (d.act === 'turno-agregar') {
      state.config.turnos.push({ nombre: `Turno ${state.config.turnos.length + 1}`, desde: '00:00', hasta: '06:00' });
      saveConfigSoon();
      refresh();
    } else if (d.turnoQuitar != null) {
      state.config.turnos.splice(+d.turnoQuitar, 1);
      saveConfigSoon();
      refresh();
    } else if (d.dicQuitar) {
      state.config.diccionario = quitarDelDiccionario(state.config.diccionario, d.dicQuitar, d.nk);
      saveConfigSoon();
      refresh();
    } else if (d.act === 'dic-agregar') {
      const r = await prompt({
        title: 'Agregar asociación',
        label: 'Titular de la billetera',
        extra: `<label class="field" style="margin-bottom:10px"><span>Usuario del panel</span><input data-extra="usuario" /></label>`,
      });
      if (r && r.usuario && r.value) {
        state.config.diccionario = agregarAlDiccionario(state.config.diccionario, r.usuario, r.value);
        saveConfigSoon();
        refresh();
      }
    } else if (d.act === 'dic-exportar') await exportarDiccionario();
    else if (d.plantillaQuitar) {
      delete state.config.plantillas[d.plantillaQuitar];
      saveConfigSoon();
      render();
    }
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.fuenteTipo) {
    const f = state.fuentes.find((x) => x.id === t.dataset.fuenteTipo);
    if (t.value === 'GENERICO') {
      mapearColumnas(f);
      t.value = f.importerKey || '';
      return;
    }
    f.importerKey = t.value || null;
    f.mapping = null;
    parseFuente(f);
    f.activa = !!f.importerKey && (f.records.length > 0 || !!f.nombres);
    refresh();
  } else if (t.dataset.lineaSelect != null) {
    state.config.lineaActiva = t.value;
    saveConfigSoon();
    refresh();
  } else if (t.id === 'dia' || t.id === 'dia-cargar') {
    state.dia = t.value;
    refresh();
  }
});

// Evita que soltar un archivo fuera de la zona abra el archivo en la ventana.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function init() {
  try {
    state.config = mergeConfig(await api.loadConfig());
  } catch {
    state.config = mergeConfig(DEFAULT_CONFIG);
  }
  try {
    state.dataDir = await api.dataDir();
  } catch {
    state.dataDir = '';
  }
  render();
}

init();
