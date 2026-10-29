const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { slugify, uniqueSlugs } = require('../lib/slug');
const { validateInternalRecipients } = require('../lib/recipients');
const { renderGroupHtml } = require('../modules/ticket-report/group-template');
const { sortSubscriptions } = require('../modules/ticket-report/group');
const { loadStatusConfig } = require('../modules/ticket-report/statuses');
const { aggregate } = require('../modules/ticket-report/aggregate');

test('slug: minúsculas, sin tildes ni espacios y único dentro del envío', () => {
  assert.equal(slugify('Carrefour - Brasil'), 'carrefour-brasil');
  assert.equal(slugify('Ñandú  S.A.'), 'nandu-s-a');
  assert.deepEqual(uniqueSlugs(['Carrefour Brasil', 'Carrefour - Brasil', 'Otra']), ['carrefour-brasil', 'carrefour-brasil-2', 'otra']);
});

test('envío agrupado: solo destinatarios internos', () => {
  assert.deepEqual(validateInternalRecipients('Ana@JanisCommerce.com').errors, []);
  const { errors } = validateInternalRecipients(['ana@janiscommerce.com', 'x@carrefour.com', 'y@gmail.com']);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Solo destinatarios @janiscommerce\.com/);
  assert.equal(validateInternalRecipients([]).errors.length, 1);
});

test('orden alfabético por Organization', () => {
  const sub = (name, title) => ({ title, organization: { name } });
  assert.deepEqual(sortSubscriptions([sub('Zeta', 'b'), sub('alfa', 'x'), sub('Beta', 'a')]).map((s) => s.organization.name), ['alfa', 'Beta', 'Zeta']);
});

const report = aggregate([
  { key: 'JCS-1', fields: { summary: 'Falla <b>', status: { name: 'To Do' }, created: '2026-01-01' } },
  { key: 'JCS-2', fields: { summary: 'Hecho', status: { name: 'Done' }, created: '2026-01-01' } },
], loadStatusConfig(), 'es');

function render(overrides = {}) {
  return renderGroupHtml({
    title: 'Care Weekly <Status>',
    cutoffDate: '29 oct 2026',
    language: 'es',
    webUrl: 'https://app.test/reportes/5/2026-10-29',
    mode: 'email',
    browseUrl: (k) => `https://j.test/browse/${k}`,
    images: { iso: 'cid:iso', footer: 'cid:footer' },
    sections: [
      { slug: 'cliente-alfa', name: 'Cliente Alfa', subscriptionTitle: 'Care Weekly — Cliente Alfa', logo: 'cid:logo-a', chart: 'cid:chart-a', report },
      { slug: 'cliente-beta', name: 'Cliente Beta', subscriptionTitle: 'Care Weekly — Cliente Beta', logo: 'cid:iso', chart: '', report: null },
    ],
    ...overrides,
  });
}

test('correo agrupado: bullets enlazados a anclas, secciones, volver arriba y "Ver en la web"', () => {
  const html = render();
  for (const slug of ['cliente-alfa', 'cliente-beta']) {
    assert.ok(html.includes(`href="#org-${slug}"`), `bullet ${slug}`);
    assert.ok(html.includes(`<a name="org-${slug}" id="org-${slug}"></a>`), `ancla ${slug}`);
  }
  assert.equal((html.match(/href="#inicio"/g) || []).length, 2);
  assert.ok(html.includes('<a name="inicio" id="inicio"></a>'));
  assert.ok(html.includes('background:#A9B2C0'));
  assert.ok(html.includes('href="https://app.test/reportes/5/2026-10-29"'));
  assert.ok(html.includes('Ver en la web ↗'));
  assert.ok(html.includes('No se pudo obtener la información.'));
  assert.ok(html.includes('Care Weekly &lt;Status&gt;'));
  assert.ok(html.includes('Falla &lt;b&gt;'));
  assert.ok(!html.includes('base64'));
  // Bullets: solo logo + nombre (sin contadores).
  assert.ok(/<img src="cid:logo-a"[^>]*>Cliente Alfa<\/a>/.test(html));
});

test('landing (mode web): sin "Ver en la web"', () => {
  assert.ok(!render({ mode: 'web' }).includes('Ver en la web'));
  assert.ok(!render({ webUrl: '' }).includes('Ver en la web'));
});

// runGroup con db, mailer y módulo simulados.
const sub = (id, orgId) => ({ id, organization: { id: orgId, name: `Org ${orgId}` }, organizations: [{ id: orgId, name: `Org ${orgId}`, logoUrl: '' }] });

function loadRunner({ subscriptions = [sub(1, '10'), sub(2, '20')], built, orgDomains = [] }) {
  const calls = { sent: [], history: [] };
  const stub = (file, exports) => {
    const id = require.resolve(path.join(__dirname, '..', file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('lib/db.js', {
    getSubscriptionsByIds: async () => subscriptions,
    addHistory: async (entry) => calls.history.push(entry),
    getOrganizationDomains: async () => [],
    getOrganizationsDomains: async () => orgDomains,
  });
  stub('lib/mailer.js', { sendMail: async (mail) => calls.sent.push(mail), isMailConfigured: () => true });
  stub('modules/index.js', { getModule: () => ({ buildGroup: async (group, subs, options) => ({ subject: 'S', html: '<p>', text: '', attachments: [], snapshot: { webUrl: options.webUrl }, itemCount: 3, failedSections: 0, warnings: [], ...built }) }) });
  delete require.cache[require.resolve('../lib/runner')];
  delete require.cache[require.resolve('../lib/groups')];
  return { runGroup: require('../lib/runner').runGroup, calls };
}

const group = { id: 5, name: 'G', recipients: ['a@janiscommerce.com'], schedule: { timezone: 'America/Santiago' }, language: 'es', subscriptionIds: [1] };

test('runGroup: envía, registra el historial y arma el link a la landing', async () => {
  process.env.APP_URL = 'https://app.test';
  const { runGroup, calls } = loadRunner({});
  const outcome = await runGroup(group, { now: new Date('2026-10-29T12:00:00Z') });
  assert.equal(outcome.result, 'ok');
  assert.deepEqual(calls.sent[0].to, ['a@janiscommerce.com']);
  assert.equal(calls.history[0].groupId, 5);
  assert.equal(calls.history[0].snapshot.webUrl, 'https://app.test/reportes/5/2026-10-29');
});

test('runGroup con 2 o más suscripciones: nunca envía a destinatarios externos', async () => {
  const { runGroup, calls } = loadRunner({ orgDomains: ['carrefour.com'] });
  const outcome = await runGroup({ ...group, recipients: ['x@carrefour.com'] });
  assert.equal(outcome.result, 'error');
  assert.equal(outcome.transient, false);
  assert.match(outcome.error, /Solo destinatarios @janiscommerce\.com/);
  assert.equal(calls.sent.length, 0);
});

test('runGroup con 1 suscripción: acepta los dominios permitidos de sus Organizations', async () => {
  const ok = loadRunner({ subscriptions: [sub(1, '10')], orgDomains: ['carrefour.com'] });
  assert.equal((await ok.runGroup({ ...group, recipients: ['x@carrefour.com'] })).result, 'ok');
  assert.deepEqual(ok.calls.sent[0].to, ['x@carrefour.com']);

  const blocked = loadRunner({ subscriptions: [sub(1, '10')], orgDomains: ['carrefour.com'] });
  assert.equal((await blocked.runGroup({ ...group, recipients: ['x@gmail.com'] })).result, 'error');
  assert.equal(blocked.calls.sent.length, 0);
});

test('runGroup: "no enviar si está vacío" en envíos programados', async () => {
  const { runGroup, calls } = loadRunner({ built: { itemCount: 0 } });
  const outcome = await runGroup({ ...group, skipIfEmpty: true }, { kind: 'scheduled' });
  assert.equal(outcome.result, 'skipped');
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.history[0].result, 'skipped');
});

test('runGroup: si fallan todas las Organizations no envía y se reintenta', async () => {
  const { runGroup, calls } = loadRunner({ built: { failedSections: 2 } });
  const outcome = await runGroup(group);
  assert.equal(outcome.result, 'error');
  assert.equal(outcome.transient, true);
  assert.equal(calls.sent.length, 0);
});

test('suscripción con varias Organizations: nombre y orden por sus Organizations', () => {
  const { sectionName } = require('../modules/ticket-report/group');
  const multi = { title: 't', organization: { name: 'TATA Uruguay' }, organizations: [{ name: 'TATA Uruguay' }, { name: 'Vierci Paraguay' }] };
  const legacy = { title: 't', organization: { name: 'Alfa' }, config: {} };
  assert.equal(sectionName(multi), 'TATA Uruguay · Vierci Paraguay');
  assert.equal(sectionName(legacy), 'Alfa');
  assert.deepEqual(sortSubscriptions([multi, legacy]).map(sectionName), ['Alfa', 'TATA Uruguay · Vierci Paraguay']);
});
