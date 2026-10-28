const test = require('node:test');
const assert = require('node:assert/strict');
const { loadStatusConfig, resolveStatus } = require('../modules/ticket-report/statuses');
const { aggregate } = require('../modules/ticket-report/aggregate');

const config = loadStatusConfig();
const issue = (key, status, created) => ({ key, fields: { summary: `S ${key}`, status: { name: status }, created } });

test('normaliza alias sin importar mayúsculas ni tildes', () => {
  assert.equal(resolveStatus(config, 'to do').key, 'todo');
  assert.equal(resolveStatus(config, 'Esperando Informacion').key, 'waiting-info');
  assert.equal(resolveStatus(config, 'REVISIÓN').key, 'review');
  assert.equal(resolveStatus(config, 'Cerrado').key, 'resolved');
  assert.equal(resolveStatus(config, 'Otro'), null);
});

test('incluye todos los estados aunque estén en 0, más los desconocidos', () => {
  const unknown = [];
  const report = aggregate([issue('A-1', 'Done', '2026-01-01'), issue('A-2', 'Bloqueado', '2026-01-02')], config, 'es', { onUnknownStatus: (n) => unknown.push(n) });

  assert.equal(report.total, 2);
  assert.deepEqual(report.rows.map((r) => r.label), ['Por Hacer', 'En Progreso', 'Esperando Información', 'En Desarrollo', 'Revisión', 'Resuelto', 'Bloqueado']);
  const blocked = report.rows.at(-1);
  assert.equal(blocked.color, '#9AA3B2');
  assert.equal(blocked.known, false);
  assert.deepEqual(unknown, ['Bloqueado']);
  assert.equal(report.rows.find((r) => r.key === 'resolved').percent, 50);
  assert.deepEqual(report.segments.map((s) => s.label), ['Resuelto', 'Bloqueado']);
});

test('tickets abiertos: solo estados abiertos, por estado y luego más antiguo primero', () => {
  const report = aggregate([
    issue('A-1', 'En Progreso', '2026-03-01T10:00:00.000-0300'),
    issue('A-2', 'To Do', '2026-05-01T10:00:00.000-0300'),
    issue('A-3', 'Por Hacer', '2026-02-01T10:00:00.000-0300'),
    issue('A-4', 'Resuelto', '2026-01-01T10:00:00.000-0300'),
    issue('A-5', 'Revision', '2026-01-01T10:00:00.000-0300'),
    issue('A-6', 'Raro', '2026-01-01T10:00:00.000-0300'),
  ], config, 'es');

  assert.deepEqual(report.openTickets.map((t) => t.key), ['A-3', 'A-2', 'A-1', 'A-5']);
  assert.equal(report.openTickets[0].status.label, 'Por Hacer');
});

test('etiquetas en portugués', () => {
  const report = aggregate([issue('A-1', 'In Progress', '2026-01-01')], config, 'pt');
  assert.equal(report.openTickets[0].status.label, 'Em Andamento');
});

test('sin tickets: porcentajes en 0', () => {
  const report = aggregate([], config, 'es');
  assert.equal(report.total, 0);
  assert.ok(report.rows.every((r) => r.percent === 0));
  assert.equal(report.segments.length, 0);
});
