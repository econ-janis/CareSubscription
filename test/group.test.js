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
function loadRunner({ subscriptions = [{ id: 1 }], built }) {
  const calls = { sent: [], history: [] };
  const stub = (file, exports) => {
    const id = require.resolve(path.join(__dirname, '..', file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('lib/db.js', {
    getSubscriptionsByIds: async () => subscriptions,
    addHistory: async (entry) => calls.history.push(entry),
    getOrganizationDomains: async () => [],
    getOrganizationsDomains: async () => [],
  });
  stub('lib/mailer.js', { sendMail: async (mail) => calls.sent.push(mail), isMailConfigured: () => true });
  stub('modules/index.js', { getModule: () => ({ buildGroup: async (group, subs, options) => ({ subject: 'S', html: '<p>', text: '', attachments: [], snapshot: { webUrl: options.webUrl }, itemCount: 3, failedSections: 0, warnings: [], ...built }) }) });
  delete require.cache[require.resolve('../lib/runner')];
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

test('runGroup: nunca envía a destinatarios externos', async () => {
  const { runGroup, calls } = loadRunner({});
  const outcome = await runGroup({ ...group, recipients: ['x@carrefour.com'] });
  assert.equal(outcome.result, 'error');
  assert.equal(outcome.transient, false);
  assert.equal(calls.sent.length, 0);
});

test('runGroup: si fallan todas las Organizations no envía y se reintenta', async () => {
  const { runGroup, calls } = loadRunner({ built: { failedSections: 1 } });
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
