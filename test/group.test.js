const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { slugify, uniqueSlugs } = require('../lib/slug');
const { validateInternalRecipients } = require('../lib/recipients');
const { renderGroupHtml } = require('../modules/ticket-report/group-template');
const { sortSubscriptions, sectionStats, displayName } = require('../modules/ticket-report/group');
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

const statusConfig = loadStatusConfig();
const report = aggregate([
  { key: 'JCS-1', fields: { summary: 'Falla <b>', status: { name: 'To Do' }, created: '2026-01-01' } },
  { key: 'JCS-2', fields: { summary: 'Hecho', status: { name: 'Done' }, created: '2026-01-01' } },
  { key: 'JCS-3', fields: { summary: 'Otro', status: { name: 'Done' }, created: '2026-01-02' } },
  { key: 'JCS-4', fields: { summary: 'Revisar', status: { name: 'REVISIÓN' }, created: '2026-01-03' } },
  { key: 'JCS-5', fields: { summary: 'No va', status: { name: 'Cancelada' }, created: '2026-01-04' } },
], statusConfig, 'es');

test('sectionStats: resueltos, abiertos, cancelados y segmentos en el orden del gráfico', () => {
  const { stats, segments } = sectionStats(report, statusConfig);
  assert.deepEqual(stats, { total: 5, resolved: 2, open: 2, cancelled: 1 });
  assert.deepEqual(segments.map((s) => s.key), ['resolved', 'review', 'todo', 'cancelled']);
  assert.equal(segments.reduce((sum, s) => sum + s.total, 0), stats.total);
});

test('Cancelada solo aparece si tiene tickets; ESPERANDO INFORMACIÓN se normaliza', () => {
  const empty = aggregate([{ key: 'A', fields: { status: { name: 'ESPERANDO INFORMACIÓN' } } }], statusConfig, 'es');
  assert.ok(!empty.rows.some((r) => r.key === 'cancelled'));
  assert.equal(empty.rows.find((r) => r.key === 'waiting-info').total, 1);
  assert.ok(report.rows.some((r) => r.key === 'cancelled' && r.total === 1));
});

test('nombre visible: título sin el prefijo común', () => {
  assert.equal(displayName('Care Weekly Status — Carrefour Argentina · PMC Gold'), 'Carrefour Argentina · PMC Gold');
  assert.equal(displayName('Carrefour Argentina'), 'Carrefour Argentina');
  assert.equal(displayName('', 'Org'), 'Org');
});

function section(slug, name, withReport = true) {
  const { stats, segments } = withReport ? sectionStats(report, statusConfig) : { stats: null, segments: [] };
  return { slug, name, title: `${name} · PMC Gold`, logos: ['cid:logo'], chart: withReport ? 'cid:chart' : '', stats, segments, openTickets: withReport ? report.openTickets : [] };
}

function render(overrides = {}) {
  return renderGroupHtml({
    title: 'Care Weekly <Status>',
    cutoffDate: '29 oct 2026',
    language: 'es',
    webUrl: 'https://app.test/reportes/5/2026-10-29',
    mode: 'email',
    browseUrl: (k) => `https://j.test/browse/${k}`,
    images: { iso: 'https://app.test/brand/janis-iso.png', footer: 'https://app.test/brand/janis-logo.png' },
    legendItems: [{ label: 'Resuelto', color: '#2979FF' }, { label: 'Cancelada', color: '#9AA3B2' }],
    sections: [section('cliente-alfa', 'Cliente Alfa'), section('cliente-beta', 'Cliente Beta', false)],
    ...overrides,
  });
}

test('correo agrupado v2: resumen con anclas, barra, totales, secciones y "Ver en la web"', () => {
  const html = render();
  for (const slug of ['cliente-alfa', 'cliente-beta']) {
    assert.ok(html.includes(`href="#org-${slug}"`), `enlace ${slug}`);
    assert.ok(html.includes(`<td id="org-${slug}"`) && html.includes(`<a name="org-${slug}"`), `ancla ${slug}`);
  }
  assert.equal((html.match(/href="#inicio"/g) || []).length, 2);
  assert.ok(html.includes('<a name="inicio"'));
  assert.ok(html.includes('max-width:680px'));
  assert.ok(html.includes('Tickets creados en los últimos 3 meses · Corte: 29 oct 2026'));
  assert.ok(html.includes('href="https://app.test/reportes/5/2026-10-29"'));
  assert.ok(html.includes('Ver en la web ↗'));
  // Barra apilada por celdas con bgcolor; 2/5 resueltos = 40 %.
  assert.ok(html.includes('<td width="40.00%" height="8" bgcolor="#2979FF"'));
  // Fila de la Organization que falló: "—"; la fila Total suma solo las que respondieron.
  assert.ok(html.includes('>—</td>'));
  assert.ok(/>Total<\/td><td[^>]*>5<\/td><td[^>]*>2<\/td><td[^>]*>2<\/td>/.test(html));
  assert.ok(html.includes('5 tickets · 2 resueltos (40 %) · <b>2 abiertos</b> · 1 cancelado'));
  assert.ok(html.includes('Cliente Alfa · PMC Gold'));
  assert.ok(html.includes('No se pudo obtener la información.'));
  assert.ok(html.includes('Tickets Abiertos'));
  // Pills y puntos con background-color inline (Gmail).
  assert.ok(html.includes('<span style="background-color:#FF3200;color:#FFFFFF;border-radius:999px;'));
  assert.ok(html.includes('background-color:#9AA3B2'));
  assert.ok(html.includes('Care Weekly &lt;Status&gt;'));
  assert.ok(html.includes('Falla &lt;b&gt;'));
  assert.ok(!html.includes('base64'));
  assert.ok(!html.includes('<style'));
  assert.ok(!html.includes('<svg'));
  assert.ok(!html.includes('Detalle por estado'));
});

test('landing (mode web): sin "Ver en la web"; sin abiertos: "Sin tickets abiertos."', () => {
  assert.ok(!render({ mode: 'web' }).includes('Ver en la web'));
  assert.ok(!render({ webUrl: '' }).includes('Ver en la web'));
  const none = render({ sections: [{ ...section('a', 'A'), openTickets: [] }] });
  assert.ok(none.includes('Sin tickets abiertos.'));
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
