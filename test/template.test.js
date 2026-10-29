const test = require('node:test');
const assert = require('node:assert/strict');
const { loadStatusConfig } = require('../modules/ticket-report/statuses');
const { aggregate } = require('../modules/ticket-report/aggregate');
const { renderReportHtml } = require('../modules/ticket-report/template');
const { renderDonutPng } = require('../modules/ticket-report/chart');

const config = loadStatusConfig();
const images = { logo: 'cid:logo', footer: 'cid:footer', footerDark: 'cid:footer-dark', chart: 'cid:chart', chartDark: 'cid:chart-dark' };
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
  assert.ok(html.includes('>100%<'));
});

test('portugués', () => {
  const html = render([], 'pt');
  assert.ok(html.includes('Não há tickets no período.'));
});

test('porcentajes con un decimal y fila Total en 100%', () => {
  const html = render([
    { key: 'JCS-1', fields: { summary: 'x', status: { name: 'Done' }, created: '2026-01-01' } },
    { key: 'JCS-2', fields: { summary: 'y', status: { name: 'Done' }, created: '2026-01-01' } },
    { key: 'JCS-3', fields: { summary: 'z', status: { name: 'To Do' }, created: '2026-01-01' } },
  ]);
  assert.ok(html.includes('>33.3%<'));
  assert.ok(html.includes('>66.7%<'));
  assert.ok(html.includes('>0.0%<'));
  assert.ok(html.includes('>100%<'));
  assert.ok(html.includes('cid:chart-dark'));
});

test('el gráfico se genera como PNG', () => {
  for (const theme of ['light', 'dark']) {
    const png = renderDonutPng([{ total: 3, color: '#FF3200' }, { total: 1, color: '#2979FF' }], 4, 'Total', theme);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.length > 1000);
  }
});

test('renderSnapshot reconstruye el correo desde el snapshot guardado (JSON)', async () => {
  const { renderSnapshot } = require('../modules/ticket-report');
  const report = aggregate([
    { key: 'JCS-9', fields: { summary: 'Abierto', status: { name: 'To Do' }, created: '2026-01-01' } },
    { key: 'JCS-8', fields: { summary: 'Cerrado', status: { name: 'Done' }, created: '2026-01-01' } },
  ], config, 'es');
  const snapshot = JSON.parse(JSON.stringify({
    title: 'Demo', subject: 'Demo', cutoffDate: '28 oct 2026', language: 'es', logoUrl: '',
    report: { total: report.total, rows: report.rows, segments: report.segments, openTickets: report.openTickets.map(({ key, summary, status }) => ({ key, summary, status })) },
  }));

  const { subject, html } = await renderSnapshot(snapshot);
  assert.equal(subject, 'Demo');
  assert.ok(html.includes('JCS-9'));
  assert.ok(!html.includes('JCS-8'));
  assert.ok(html.includes('data:image/png;base64,'));
  assert.ok(html.includes('Corte: 28 oct 2026'));
});

test('el correo se marca como "no traducir" (Gmail lo traducía solo)', () => {
  const html = render([]);
  assert.ok(html.includes('translate="no"'));
  assert.ok(html.includes('<meta name="google" content="notranslate">'));
  assert.ok(html.includes('class="cs-bg notranslate"'));
});

test('encabezado con un logo por Organization', () => {
  const html = renderReportHtml({ title: 'T', cutoffDate: 'x', language: 'es', report: aggregate([], config, 'es'), browseUrl, images: { ...images, logos: ['cid:logo-0', 'cid:logo-1'] } });
  assert.ok(html.includes('src="cid:logo-0"'));
  assert.ok(html.includes('src="cid:logo-1"'));
});
