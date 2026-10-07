# Conciliador de Fichas

Aplicación de escritorio para Windows que concilia los movimientos de fichas de los paneles
(BETS, GANEMOS, ZEUS) contra los movimientos de dinero de las billeteras (Cash, Mercado Pago).
Funciona sin conexión a internet, corre directo desde un pendrive y no necesita instalación.

## Qué hace

1. **Lee los reportes tal como se descargan**, sin tener que armar la base plana a mano:

   | Formato | Lado | Cómo se reconoce |
   | --- | --- | --- |
   | BETS: export "User Transactions" (.csv/.xlsx) | Panel | Columnas `Transaction Type`, `Owner Type`… Se usa solo la fila del jugador. |
   | GANEMOS: copiado de la web (8 renglones por movimiento) | Panel | Se puede pegar directo en la app o cargar la planilla. |
   | ZEUS: tabla Nro / Fecha / Operación / Agente / Destino / Depósito / Retiro | Panel | En los retiros el jugador figura en "Agente". |
   | Base plana DIA / HORA / Operación / agente / NOMBRE / MONTO | Panel | Planillas ya armadas a mano. |
   | Cash: reporte con ID Interno / Dirección / COELSA | Billetera | Los "Fee" van como comisión, los "Interno" como movimiento interno y las "Revertida" se informan aparte. |
   | Mercado Pago: reporte de operaciones | Billetera | Se usa la fecha de aprobación (pasada a hora argentina). PAYOUTS cuenta como pago. |
   | Mercado Pago: reporte de retiros | Billetera | Completa el titular de los PAYOUTS. |
   | GANEMOS en tabla (hoja "Consolidado": ID / FECHA / OPERACIÓN / INICIADOR / DE / A) | Panel | Si también se carga la hoja original, los repetidos se descartan. |
   | **Capturas de pantalla** (.png/.jpg) de "Mis movimientos" de una billetera | Billetera | Se leen con OCR en la propia computadora. Ver más abajo. |
   | Cualquier otro Excel o CSV | Cualquiera | Se mapean las columnas una vez y el formato queda guardado. |

2. **Concilia automáticamente** con las reglas del negocio:
   - **Cobro:** primero entra el dinero a la billetera y después se cargan las fichas (por defecto, hasta 30 minutos).
   - **Pago:** primero se retiran las fichas y después sale el dinero (por defecto, hasta 60 minutos).
   - **Bonificación:** el panel carga un 10% o un 20% más de lo cobrado. Los porcentajes se pueden configurar.
   - **Compensado:** carga y retiro del mismo jugador que en la billetera aparecen como un solo movimiento por la diferencia.
   - **Agrupado:** dos transferencias que corresponden a una sola carga de fichas, o al revés.
   - **Pago duplicado:** mismo titular y mismo monto pagados dos veces.
   - **Usuarios y titulares:** la app aprende qué titular de billetera corresponde a cada usuario del panel (por ejemplo, `lucas0576` → "Lucas Julian Quintana") y usa lo aprendido para desempatar los días siguientes. También detecta parecidos entre nombres (`santi7342c` ~ "Santiago…").
   - Cada partida conciliada tiene una **confianza**. "Revisar" indica que el titular no coincide con el que se conocía para ese usuario.

3. **Pendientes:** se eligen movimientos de los dos lados y se concilian a mano con una nota, o se marca su estado (ingreso sin identificar, pago duplicado, error de carga, etc.). Cualquier partida automática se puede deshacer.

4. **Tiempos:** para las partidas conciliadas mide cuánto se tarda en cargar las fichas después de entrar el dinero, y en pagar después de retirar las fichas. Muestra promedio, mediana, percentil 90 y máximo, tanto en general como por turno, por cajero o agente, y por cuenta. También lista las partidas más lentas.

5. **Exportación a Excel:** genera un archivo con las hojas Resumen, Conciliación, Pendientes, Tiempos, Base panel, Base billeteras y Usuarios y titulares.

6. **Trabajo guardado:** el archivo `.conciliacion` guarda los reportes y las decisiones manuales para retomar después.

### Líneas y agentes

Cada línea (AgenteZ, AgenteB, Agente777, Agente10, Flordeagente, Martin, Lourdes, Tatiana,
Oficina01) concilia los agentes de sus paneles contra sus billeteras. En GANEMOS y ZEUS vienen
mezclados agentes de varias líneas, así que al elegir una línea se toman solo sus agentes; los demás
se informan como "dejados afuera". Los agentes de cada línea se editan en Configuración → Líneas y
agentes, donde también se ven los agentes encontrados en los paneles cargados para asignarles línea.

### Capturas de pantalla

Algunas billeteras solo permiten ver los movimientos en el celular. Se pueden arrastrar las capturas
de "Mis movimientos" junto con los demás archivos:

- El texto se lee con OCR (Tesseract, en español) **en la misma computadora y sin conexión**. El
  lector y el idioma viajan dentro del `.exe`. La primera lectura tarda unos segundos; después,
  alrededor de 1 segundo por imagen.
- Antes de agregarlos se muestra una tabla para revisar y corregir fecha, titular, operación y monto,
  y para indicar a qué billetera corresponden. Las filas resaltadas conviene mirarlas con la imagen
  (por ejemplo, cuando el OCR no vio el signo "$").
- Se guarda la leyenda de cada movimiento ("Pago con QR", "Rendimientos"…) salvo las habituales de
  transferencias: "Transferencia enviada", "Transferencia recibida", "Te enviaron dinero" y
  "Enviaste dinero". La leyenda se ve en la revisión, en Pendientes y en el Excel exportado.
- Reconoce dos formatos de lista: titular arriba y leyenda abajo ("Transferencia recibida"), o
  leyenda arriba y "de/a Titular" abajo ("Te enviaron dinero" / "de Victor…", como Personal Pay).
- Si la captura muestra la hora del movimiento, se usa: ese movimiento se cruza por horario y entra
  en la medición de tiempos. Las capturas chicas se agrandan antes de leerlas para que el OCR no
  confunda el "$" con un número.
- Mercado Pago: lee los encabezados de fecha ("Hoy", "Ayer", "Lunes 5 de octubre"), la hora de cada
  movimiento y los montos sin centavos. "Hoy" y "Ayer" se calculan con la fecha del archivo de la
  captura. Si los centavos chiquitos no se pueden leer, la fila queda para revisar.
- **Comprobantes de transferencia de Mercado Pago** (una imagen por operación): se leen fecha y hora,
  monto, origen, destino, motivo y número de operación. El titular de la cuenta se deduce porque se
  repite en los comprobantes (o porque figura en el nombre de la cuenta ingresado): lo que le llega es
  cobro y lo que envía es pago. Con un solo comprobante y sin titular conocido, la fila queda para
  revisar. El número de operación evita cargar dos veces el mismo comprobante.
- **Turno:** en la revisión se puede asignar un turno a todas las capturas o a cada fila. Para los
  movimientos sin hora, el cruce se limita a las horas de ese turno en vez de todo el día, y el turno
  aparece en Pendientes y en el Excel. Los turnos de fábrica son Turno 1 (06 a 14), Turno 2 (14 a 22)
  y Turno 3 (22 a 06); se cambian en Configuración → Turnos y día.
- Si las capturas se superponen (el mismo movimiento aparece al final de una y al principio de la
  siguiente), se cuenta una sola vez.
- **Las capturas no muestran la hora**, solo el día. Esos movimientos se cruzan por día, monto y
  titular, y no entran en la medición de tiempos. Los nombres cortados ("Joana Maria Del Rosario
  Aco...") se comparan por el principio. La confianza es alta si el diccionario ya conocía al
  titular, media si el usuario se parece al nombre, y "Revisar" si solo coincide el monto.

### Día operativo

Por defecto va de las 06:00 del día elegido a las 06:00 del día siguiente, y la hora de inicio se puede cambiar. Se concilian todos los movimientos cargados, así una partida que cruza las 06:00 igual encuentra su par, y después se muestran solo las del día elegido.

## Descargar el ejecutable

Última versión: **https://github.com/emiranda028/conciliaciones/releases/latest/download/ConciliadorFichas.exe**

Cada cambio que se sube a `main` genera el `.exe` en una máquina Windows de GitHub, lo prueba (abre la
app, concilia datos de ejemplo y verifica que la red esté bloqueada) y lo publica en
[Releases](https://github.com/emiranda028/conciliaciones/releases). Si el build falla, no se publica.

## Uso

1. Copiar `ConciliadorFichas.exe` al pendrive y abrirlo con doble clic.
2. En **Cargar reportes**, arrastrar los archivos del día o pegar lo copiado del panel.
3. Revisar que cada archivo se haya reconocido con el formato correcto (se puede cambiar en la lista) y apretar **Conciliar**.
4. Revisar **Pendientes** y las partidas marcadas como "Revisar" en **Conciliadas**.
5. Hacer clic en **Exportar a Excel**.

La configuración (reglas, turnos, usuarios y titulares, formatos guardados) se guarda en la carpeta
`ConciliadorDatos` junto al `.exe`. Si el pendrive está protegido contra escritura, se guarda en la
carpeta del usuario de Windows.

## Seguridad y privacidad

- La app no usa la red: cualquier conexión saliente está bloqueada desde el proceso principal y además por la política de contenido (CSP). También se desactiva el tráfico de fondo de Chromium (actualización de componentes y similares).
- El código de la interfaz no tiene acceso a Node. Solo se exponen las funciones para leer y guardar la configuración y para abrir y guardar archivos.
- El código se entrega empaquetado (asar), minificado y ofuscado, sin herramientas de desarrollo ni menú.
  La ofuscación dificulta leer y modificar el código, pero no es un cifrado: alguien con tiempo y
  conocimientos puede extraerlo.

## Desarrollo

Requiere Node 20 o superior.

```bash
npm install
npm test                 # pruebas del motor con datos sintéticos
npm start                # build sin ofuscar + app con DevTools
npm run dist             # build ofuscado + dist/ConciliadorFichas.exe (Windows x64 portable)
node scripts/smoke-electron.mjs "dist/win-unpacked/Conciliador de Fichas.exe"   # prueba de la app (requiere playwright)
```

Estructura:

```
src/core/        motor sin interfaz (se prueba con node)
  capturas.js    capturas de pantalla: texto del OCR -> movimientos, unión de capturas
  util.js        números, fechas (hora argentina), textos
  tabular.js     lectura de xlsx / csv / texto pegado
  importers.js   reconocimiento y normalización de cada reporte
  matcher.js     conciliación automática
  report.js      resumen, tiempos y exportación a Excel
  session.js     flujo completo, diccionario, trabajo guardado
src/renderer/    interfaz (HTML + JS sin frameworks)
src/main/        proceso principal de Electron y preload
scripts/build.mjs  empaquetado con esbuild + ofuscación
```

**No subir reportes reales al repositorio.** El `.gitignore` excluye `.xlsx` y `.csv`, y las pruebas usan datos inventados.

## Supuestos a confirmar con el cliente

- **Turnos:** por defecto, 3 turnos de 8 horas alineados con el día operativo (06 a 14, 14 a 22 y 22 a 06). Se editan en Configuración → Turnos y día.
- **Cajero:** los reportes no identifican al cajero de cada turno. Los tiempos se agrupan por el agente del panel (AgenteFB1, josefina.2332, agentez…), que es el usuario con el que opera cada cajero.
- **PAYOUTS de Mercado Pago:** se toman como pagos a jugadores. Si alguno es un retiro a una cuenta propia, se marca como "Movimiento interno" en Pendientes.
