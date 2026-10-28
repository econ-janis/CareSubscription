const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadImage, slackChannel } = require('../lib/slack');
const { buildSlackComment, slackEscape } = require('../modules/ticket-report/slack');

function mockFetch(handlers) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = handlers.find(([match]) => String(url).includes(match));
    if (!handler) throw new Error(`fetch inesperado: ${url}`);
    const [status, body] = handler[1](init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('canal por defecto: #care-test (configurable con SLACK_CHANNEL)', () => {
  const previous = process.env.SLACK_CHANNEL;
  delete process.env.SLACK_CHANNEL;
  assert.equal(slackChannel(), '#care-test');
  process.env.SLACK_CHANNEL = '#care-talks';
  assert.equal(slackChannel(), '#care-talks');
  if (previous === undefined) delete process.env.SLACK_CHANNEL; else process.env.SLACK_CHANNEL = previous;
});

test('sube la imagen al canal: busca el ID por nombre y completa con el comentario', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  let completed;
  const { calls, restore } = mockFetch([
    ['conversations.list', () => [200, { ok: true, channels: [{ id: 'C111', name: 'otro' }, { id: 'C222', name: 'care-test' }], response_metadata: { next_cursor: '' } }]],
    ['files.getUploadURLExternal', () => [200, { ok: true, upload_url: 'https://files.slack.test/upload/1', file_id: 'F1' }]],
    ['files.slack.test/upload', () => [200, 'OK - 4']],
    ['files.completeUploadExternal', (init) => { completed = JSON.parse(init.body); return [200, { ok: true }]; }],
  ]);
  try {
    const result = await uploadImage({ png: Buffer.from('fake'), filename: 'r.png', title: 'Título', comment: 'hola', channel: '#care-test' });
    assert.deepEqual(result, { channel: '#care-test', channelId: 'C222' });
    assert.deepEqual(completed, { files: [{ id: 'F1', title: 'Título' }], channel_id: 'C222', initial_comment: 'hola' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer xoxb-test');
    assert.equal(calls.length, 4);
  } finally {
    restore();
  }
});

test('con un ID de canal no hace falta buscarlo; los errores traen una pista', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  const { calls, restore } = mockFetch([
    ['files.getUploadURLExternal', () => [200, { ok: false, error: 'missing_scope' }]],
  ]);
  try {
    await assert.rejects(uploadImage({ png: Buffer.from('x'), filename: 'r.png', title: 't', comment: 'c', channel: 'C0123456789' }), /missing_scope.*files:write/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('comentario: próximo envío, tickets abiertos con link y escape de mrkdwn', () => {
  const snapshot = {
    title: 'Care <Weekly> & Co', cutoffDate: '28 oct 2026',
    report: { total: 3, openTickets: [{ key: 'JCS-1', summary: 'Falla <b> & más', status: { label: 'Por Hacer' } }] },
  };
  const text = buildSlackComment(snapshot, { organizationName: 'Demo', nextSendLabel: 'mié 04/11, 09:00 (America/Santiago)', actor: 'ana@janiscommerce.com', browseUrl: (k) => `https://j.test/browse/${k}` });
  assert.ok(text.includes('*Preaviso: Care &lt;Weekly&gt; &amp; Co*'));
  assert.ok(text.includes('Próximo envío a Consulting: *mié 04/11, 09:00 (America/Santiago)*'));
  assert.ok(text.includes('• <https://j.test/browse/JCS-1|JCS-1> Falla &lt;b&gt; &amp; más — _Por Hacer_'));
  assert.ok(text.includes('ana@janiscommerce.com'));
  assert.equal(slackEscape('a<b>&c'), 'a&lt;b&gt;&amp;c');
});

test('comentario: sin tickets abiertos y recorte a 30 con "y N más"', () => {
  const ctx = { organizationName: 'Demo', nextSendLabel: '', actor: 'a@janiscommerce.com', browseUrl: (k) => k };
  assert.ok(buildSlackComment({ title: 'T', cutoffDate: 'x', report: { total: 2, openTickets: [] } }, ctx).includes('Sin tickets abiertos'));
  const many = Array.from({ length: 45 }, (_, i) => ({ key: `JCS-${i}`, summary: 's', status: { label: 'Revisión' } }));
  const text = buildSlackComment({ title: 'T', cutoffDate: 'x', report: { total: 45, openTickets: many } }, ctx);
  assert.equal(text.split('\n').filter((l) => l.startsWith('• ')).length, 30);
  assert.ok(text.includes('…y 15 más'));
  assert.ok(text.includes('Sin envío programado'));
});
