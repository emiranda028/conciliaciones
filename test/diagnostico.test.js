// Motivo probable de los pendientes. Datos inventados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { conciliar } from '../src/core/matcher.js';
import { diagnosticar, MOTIVOS } from '../src/core/diagnostico.js';
import { parseDateTime } from '../src/core/util.js';

test('diagnóstico: falta billetera, posible par, otro agente y sin monto', () => {
  let n = 0;
  const P = (h, monto, persona, cuenta = 'AGENTE1') => ({ id: `p${++n}`, lado: 'panel', origen: 'BETS', cuenta, persona, tipo: 'COBRO', monto, ts: parseDateTime(`30/10/2026, ${h}`), ref: '' });
  const W = (h, monto, persona) => ({ id: `w${++n}`, lado: 'billetera', origen: 'CASH', cuenta: 'SUC 1', persona, tipo: 'COBRO', monto, ts: parseDateTime(`30/10/2026, ${h}`), ref: '' });
  const sinBilletera = P('03:00:00', 4000, 'madrugada1');
  const lejos = P('10:30:00', 5000, 'lejos22');
  const sinMonto = P('11:30:00', 2222, 'raro33');
  const panel = [sinBilletera, lejos, sinMonto, P('10:00:30', 1000, 'ana44')];
  const otroAgente = W('11:00:00', 7000, 'Titular De Otro');
  const billetera = [W('09:00:00', 5000, 'Persona Lejana'), otroAgente, W('10:00:00', 1000, 'Ana Prueba'), W('12:00:00', 9000, 'Cierre Caja')];
  const excluidos = [P('11:01:00', 7000, 'otro55', 'AGENTE2')];
  const res = conciliar(panel, billetera);
  const d = diagnosticar(res, { panel, billetera, excluidos });
  assert.equal(d.get(sinBilletera.id).motivo, MOTIVOS.SIN_BILLETERA);
  assert.equal(d.get(lejos.id).motivo, MOTIVOS.POSIBLE_PAR);
  assert.match(d.get(lejos.id).detalle, /Persona Lejana .*90 min de diferencia/);
  assert.equal(d.get(otroAgente.id).motivo, MOTIVOS.OTRO_AGENTE);
  assert.match(d.get(otroAgente.id).detalle, /otro55 de AGENTE2/);
  assert.equal(d.get(sinMonto.id).motivo, MOTIVOS.SIN_MONTO);
});
