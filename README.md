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

### Día operativo

Por defecto va de las 06:00 del día elegido a las 06:00 del día siguiente, y la hora de inicio se puede cambiar. Se concilian todos los movimientos cargados, así una partida que cruza las 06:00 igual encuentra su par, y después se muestran solo las del día elegido.

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

- La app no usa la red: cualquier conexión saliente está bloqueada desde el proceso principal y además por la política de contenido (CSP).
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
```

Estructura:

```
src/core/        motor sin interfaz (se prueba con node)
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

- **Turnos:** el documento menciona 3 turnos (00–06, 06–12, 12–18), pero no cubre de 18 a 24. Por defecto se configuraron 4 turnos de 6 horas, y se pueden editar en Configuración → Turnos y día.
- **Cajero:** los reportes no identifican al cajero de cada turno. Los tiempos se agrupan por el agente del panel (AgenteFB1, josefina.2332, agentez…), que es el usuario con el que opera cada cajero.
- **PAYOUTS de Mercado Pago:** se toman como pagos a jugadores. Si alguno es un retiro a una cuenta propia, se marca como "Movimiento interno" en Pendientes.
