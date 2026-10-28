const test = require('node:test');
const assert = require('node:assert/strict');
const { loadStatusConfig } = require('../modules/ticket-report/statuses');
const { aggregate } = require('../modules/ticket-report/aggregate');
const { renderReportHtml } = require('../modules/ticket-report/template');
const { renderDonutPng } = require('../modules/ticket-report/chart');

const config = loadStatusConfig();
const images = { logo: 'cid:logo', footer: 'cid:footer', chart: 'cid:chart' };
const browseUrl = (key) => `https://janiscommerce.atlassian.net/browse/${key}`;
const render = (issues, language = 'es') => renderReportHtml({ title: 'Reporte <Demo>', cutoffDate: '28/10/2026', language, report: aggregate(issues, config, language), images, browseUrl });

test('escapa contenido de los tickets y el título', () => {
  const html = render([{ key: 'JCS-1', fields: { summary: '<script>alert(1)</script>', status: { name: 'To Do' }, created: '2026-01-01' } }]);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Reporte &lt;Demo&gt;'));
  assert.ok(html.includes('href="https://janiscommerce.atlassian.net/browse/JCS-1"'));
  assert.ok(html.includes('Creadas en los últimos 3 meses · Corte: 28/10/2026'));
  assert.ok(!/<script/i.test(html));
});

test('sin tickets: mensaje de período vacío y sin gráfico', () => {
  const html = render([]);
  assert.ok(html.includes('No hay tickets en el período.'));
  assert.ok(!html.includes('cid:chart'));
});

test('sin tickets abiertos: "Sin tickets abiertos"', () => {
  const html = render([{ key: 'JCS-1', fields: { summary: 'x', status: { name: 'Done' }, created: '2026-01-01' } }]);
  assert.ok(html.includes('Sin tickets abiertos'));
  assert.ok(html.includes('100,0%'));
});

test('portugués', () => {
  const html = render([], 'pt');
  assert.ok(html.includes('Não há tickets no período.'));
});

test('el gráfico se genera como PNG', () => {
  const png = renderDonutPng([{ total: 3, color: '#FF3200', textColor: '#FFFFFF' }, { total: 1, color: '#2979FF', textColor: '#FFFFFF' }], 4, 'tickets');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.ok(png.length > 1000);
});
