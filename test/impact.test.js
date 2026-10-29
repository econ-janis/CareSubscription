const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFacts, firstAgentResponse, isAgent, slaOf, isEscalated } = require('../lib/impact/facts');
const { computeImpact, weekOf, weekList, median } = require('../lib/impact/metrics');
const { cursorFrom } = require('../lib/impact/sync');
const { loadStatusConfig } = require('../modules/ticket-report/statuses');

const AGENTS = ['Guardia', 'Joel', 'Mauricio', 'Erwin'];
const agent = (name) => ({ displayName: name, accountType: 'atlassian' });
const customer = (name) => ({ displayName: name, accountType: 'customer' });
const automation = { displayName: 'Automation for Jira', accountType: 'app' };

test('agente de Care: por nombre, sin tildes ni mayúsculas, nunca cuentas de clientes', () => {
  assert.ok(isAgent(agent('Mauricio Oruezabal'), AGENTS));
  assert.ok(isAgent(agent('ERWIN Concha'), AGENTS));
  assert.ok(isAgent(agent('Guardia'), AGENTS));
  assert.ok(!isAgent(agent('Joelle Pérez'), AGENTS), 'no coincide por prefijo parcial');
  assert.ok(!isAgent(customer('Joel Cliente'), AGENTS), 'un cliente que se llama igual no cuenta');
  assert.ok(!isAgent(automation, AGENTS));
});

test('primera respuesta real: después de la automática, ignorando cliente y notas internas', () => {
  const comments = [
    { created: '2026-10-27T14:06:10Z', author: automation },
    { created: '2026-10-27T15:12:21Z', author: customer('Equipo IT') },
    { created: '2026-10-27T15:30:00Z', author: agent('Joel X'), jsdPublic: false },
    { created: '2026-10-27T15:49:21Z', author: agent('Mauricio Oruezabal') },
    { created: '2026-10-28T10:00:00Z', author: agent('Erwin Concha') },
  ];
  assert.equal(firstAgentResponse(comments, AGENTS), '2026-10-27T15:49:21Z');
  assert.equal(firstAgentResponse(comments.slice(0, 3), AGENTS), null);
  assert.equal(firstAgentResponse([...comments].reverse(), AGENTS), '2026-10-27T15:49:21Z', 'ordena por fecha');
});

test('SLA de Jira y escalamiento a HDI', () => {
  assert.deepEqual(slaOf({ completedCycles: [{ breached: false, elapsedTime: { millis: 1000 }, goalDuration: { millis: 5000 } }] }), { breached: false, elapsedMs: 1000, goalMs: 5000 });
  assert.equal(slaOf({ completedCycles: [{ breached: true }], ongoingCycle: { breached: false } }).breached, true);
  assert.equal(slaOf(null).breached, null);
  assert.ok(isEscalated([{ inwardIssue: { key: 'HDI-3693' } }], ['HDI']));
  assert.ok(!isEscalated([{ outwardIssue: { key: 'JCS-1' } }], ['HDI']));
});

test('extractFacts: solo métricas, sin textos ni personas', () => {
  const issue = {
    key: 'JCS-1',
    fields: {
      summary: 'Texto del cliente', description: 'secreto',
      created: '2026-10-27T11:06:08.096-0300', resolutiondate: '2026-10-29T11:54:30.076-0300',
      status: { name: 'Resuelto', statusCategory: { key: 'done' } },
      customfield_10500: [{ id: '338', name: 'Cliente' }],
      customfield_10621: { completedCycles: [{ breached: false, elapsedTime: { millis: 168003573 }, goalDuration: { millis: 720000000 } }] },
      issuelinks: [{ inwardIssue: { key: 'HDI-3693' } }],
      comment: { total: 2, comments: [{ created: '2026-10-27T11:06:10.925-0300', author: automation }, { created: '2026-10-27T12:49:21.525-0300', author: agent('Mauricio Oruezabal'), body: 'x' }] },
    },
  };
  const facts = extractFacts(issue, { fieldIds: { organizations: 'customfield_10500', slaResolution: 'customfield_10621' }, agentNames: AGENTS, escalationProjects: ['HDI'], statusConfig: loadStatusConfig() });
  assert.deepEqual(facts, {
    issueKey: 'JCS-1', orgIds: ['338'], createdAt: '2026-10-27T14:06:08.096Z', resolvedAt: '2026-10-29T14:54:30.076Z', state: 'resolved',
    firstResponseAt: '2026-10-27T15:49:21.525Z', jiraSlaBreached: false, jiraSlaElapsedMs: 168003573, jiraSlaGoalMs: 720000000, escalated: true,
  });
  assert.ok(!JSON.stringify(facts).includes('secreto') && !JSON.stringify(facts).includes('Mauricio'));

  const cancelled = extractFacts({ key: 'JCS-2', fields: { created: '2026-10-01T00:00:00Z', resolutiondate: '2026-10-02T00:00:00Z', status: { name: 'Cancelada', statusCategory: { key: 'done' } } } },
    { fieldIds: {}, agentNames: AGENTS, escalationProjects: ['HDI'], statusConfig: loadStatusConfig() });
  assert.equal(cancelled.state, 'cancelled');
});

test('semanas de lunes a domingo en la zona horaria configurada', () => {
  const tz = 'America/Argentina/Buenos_Aires';
  assert.equal(weekOf('2026-10-29T15:00:00Z', tz), '2026-10-26'); // jueves
  assert.equal(weekOf('2026-11-02T02:00:00Z', tz), '2026-10-26'); // domingo 23:00 local
  assert.equal(weekOf('2026-11-02T03:30:00Z', tz), '2026-11-02'); // lunes 00:30 local
  assert.deepEqual(weekList('2026-10-29T15:00:00Z', tz, 3), ['2026-10-12', '2026-10-19', '2026-10-26']);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('cursor de la carga inicial: un día antes del último ticket', () => {
  assert.equal(cursorFrom('2026-03-01T02:00:00.000Z'), '2026-02-28');
});

// Datos de ejemplo: 2 clientes, nivel Gold con metas de 4 h / 48 h.
function sample() {
  const facts = [];
  const add = (key, org, created, { resolved = null, state = resolved ? 'resolved' : 'open', fr = null, breached = false, escalated = false } = {}) => facts.push({
    issueKey: key, orgIds: [org], createdAt: created, resolvedAt: resolved, state, firstResponseAt: fr, jiraSlaBreached: resolved ? breached : null, jiraSlaElapsedMs: null, jiraSlaGoalMs: null, escalated,
  });
  // Semana del 19/10 (completa): A crea 3 y resuelve 2; B crea 1.
  add('A-1', '1', '2026-10-19T13:00:00Z', { resolved: '2026-10-20T13:00:00Z', fr: '2026-10-19T14:00:00Z' }); // 24 h, respuesta 1 h
  add('A-2', '1', '2026-10-20T13:00:00Z', { resolved: '2026-10-23T13:00:00Z', fr: '2026-10-20T19:00:00Z', breached: true, escalated: true }); // 72 h, respuesta 6 h
  add('A-3', '1', '2026-10-21T13:00:00Z', { fr: '2026-10-21T15:00:00Z' }); // abierto
  add('B-1', '2', '2026-10-22T13:00:00Z', { state: 'cancelled', resolved: '2026-10-22T20:00:00Z' });
  // Ticket viejo abierto de B (más de 30 días).
  add('B-0', '2', '2026-08-03T13:00:00Z');
  return facts;
}

test('métricas semanales: creados, resueltos, backlog, medianas y SLA A y B', () => {
  const clients = [
    { organizationId: '1', organizationName: 'Cliente A', levelId: 1, pmcSince: '2026-09-01', logoUrl: '', active: true },
    { organizationId: '2', organizationName: 'Cliente B', levelId: null, pmcSince: null, logoUrl: '', active: true },
  ];
  const impact = computeImpact({ facts: sample(), clients, levels: [{ id: 1, name: 'Gold', firstResponseHours: 4, resolutionHours: 48 }], timezone: 'America/Argentina/Buenos_Aires', weeks: 8, now: new Date('2026-10-29T15:00:00Z') });

  const week = impact.total.series.find((w) => w.week === '2026-10-19');
  assert.equal(week.created, 4);
  assert.equal(week.resolved, 2);
  assert.equal(week.cancelled, 1);
  assert.equal(week.backlog, 2, 'A-3 y el viejo B-0');
  assert.equal(week.firstResponseH, 2, 'mediana de 1, 6 y 2 h');
  assert.equal(week.resolutionH, 48, 'mediana de 24 y 72 h');
  assert.equal(week.jiraSlaPct, 50);
  assert.equal(week.contractResolutionPct, 50, 'Gold 48 h: A-1 sí, A-2 no');
  assert.equal(week.contractFirstResponsePct, 66.7, 'Gold 4 h: 2 de 3 (B sin nivel no cuenta)');
  assert.equal(week.noEscalationPct, 50);

  // La semana en curso es la última de la serie.
  assert.equal(impact.weeks.at(-1), '2026-10-26');
  const a = impact.clients.find((c) => c.name === 'Cliente A');
  const b = impact.clients.find((c) => c.name === 'Cliente B');
  assert.equal(a.level.name, 'Gold');
  assert.equal(a.openNow, 1);
  assert.equal(b.openOlderThan30, 1);
  assert.equal(impact.total.openOlderThan30, 1);
  assert.ok(impact.achievements.some((x) => x.kind === 'clean' && x.text.includes('Cliente A')));
  assert.ok(!impact.achievements.some((x) => x.kind === 'clean' && x.text.includes('Cliente B')));
  // Las series por cliente suman lo mismo que el total.
  const sum = (key) => impact.clients.reduce((acc, c) => acc + c.series.find((w) => w.week === '2026-10-19')[key], 0);
  assert.equal(sum('created'), week.created);
  assert.equal(sum('resolved'), week.resolved);
});
