const test = require('node:test');
const assert = require('node:assert/strict');
const { postMessage, slackChannel } = require('../lib/slack');
const { buildSlackComment, groupByAssignee, slackEscape } = require('../modules/ticket-report/slack');

function mockFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const [status, body] = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const ctx = { organizationName: 'Demo', nextSendLabel: 'mié 04/11, 09:00 (America/Santiago)', actor: 'ana@janiscommerce.com', browseUrl: (k) => `https://j.test/browse/${k}` };
const ticket = (key, assignee, status = 'Revisión', summary = `Resumen ${key}`) => ({ key, summary, assignee, status: { label: status } });

test('canal por defecto: #care-test (configurable con SLACK_CHANNEL)', () => {
  const previous = process.env.SLACK_CHANNEL;
  delete process.env.SLACK_CHANNEL;
  assert.equal(slackChannel(), '#care-test');
  process.env.SLACK_CHANNEL = '#care-talks';
  assert.equal(slackChannel(), '#care-talks');
  if (previous === undefined) delete process.env.SLACK_CHANNEL; else process.env.SLACK_CHANNEL = previous;
});

test('publica con chat.postMessage, sin vista previa de links', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  const { calls, restore } = mockFetch(() => [200, { ok: true }]);
  try {
    await postMessage('hola', '#care-test');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/chat.postMessage'));
    assert.equal(calls[0].init.headers.Authorization, 'Bearer xoxb-test');
    assert.deepEqual(JSON.parse(calls[0].init.body), { channel: '#care-test', text: 'hola', mrkdwn: true, unfurl_links: false, unfurl_media: false });
  } finally {
    restore();
  }
});

test('los errores de Slack traen una pista', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  const { restore } = mockFetch(() => [200, { ok: false, error: 'not_in_channel' }]);
  try {
    await assert.rejects(postMessage('hola', '#care-test'), /not_in_channel.*invitá al bot/);
  } finally {
    restore();
  }
});

test('agrupa por Responsable: alfabético y "Sin asignar" al final, respetando el orden del reporte', () => {
  const groups = groupByAssignee([ticket('A-1', 'Zoe'), ticket('A-2', ''), ticket('A-3', 'Ana'), ticket('A-4', 'Zoe'), ticket('A-5', null)]);
  assert.deepEqual(groups.map(([name, list]) => [name, list.map((t) => t.key)]), [
    ['Ana', ['A-3']],
    ['Zoe', ['A-1', 'A-4']],
    ['Sin asignar', ['A-2', 'A-5']],
  ]);
});

test('mensaje: próximo envío, grupos con cantidad, links a Jira y escape de mrkdwn', () => {
  const snapshot = { title: 'Care <Weekly> & Co', cutoffDate: '28 oct 2026', report: { total: 5, openTickets: [ticket('JCS-1', 'Ana <QA>', 'Por Hacer', 'Falla <b> & más'), ticket('JCS-2', '', 'En Progreso')] } };
  const text = buildSlackComment(snapshot, ctx);
  assert.ok(text.includes('*Preaviso: Care &lt;Weekly&gt; &amp; Co*'));
  assert.ok(text.includes('Próximo envío a Consulting: *mié 04/11, 09:00 (America/Santiago)*'));
  assert.ok(text.includes('*Tickets abiertos (2)*'));
  assert.ok(text.includes('👤 *Ana &lt;QA&gt;* (1)\n• <https://j.test/browse/JCS-1|JCS-1> Falla &lt;b&gt; &amp; más — _Por Hacer_'));
  assert.ok(text.indexOf('👤 *Ana') < text.indexOf('👤 *Sin asignar* (1)'));
  assert.ok(!text.includes('ana@janiscommerce.com'));
  assert.ok(!text.includes('Enviado desde'));
  assert.equal(slackEscape('a<b>&c'), 'a&lt;b&gt;&amp;c');
});

test('mensaje: sin tickets abiertos, sin envío programado y recorte de mensajes largos', () => {
  const none = buildSlackComment({ title: 'T', cutoffDate: 'x', report: { total: 2, openTickets: [] } }, { ...ctx, nextSendLabel: '' });
  assert.ok(none.includes('Sin tickets abiertos'));
  assert.ok(none.includes('Sin envío programado'));

  const many = Array.from({ length: 120 }, (_, i) => ticket(`JCS-${i}`, `Persona ${String(i % 12).padStart(2, '0')}`, 'Revisión', 'Un resumen bastante largo para llenar el mensaje de Slack'));
  const text = buildSlackComment({ title: 'T', cutoffDate: 'x', report: { total: 120, openTickets: many } }, ctx);
  assert.ok(text.length <= 3800);
  const shown = text.split('\n').filter((l) => l.startsWith('• ')).length;
  assert.ok(shown > 0 && shown < 120);
  assert.ok(text.includes(`…y ${120 - shown} tickets más`));
});
