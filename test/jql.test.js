const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveJql, hasPlaceholder, filtersByOrganization, DEFAULT_JQL } = require('../modules/ticket-report/jql');

test('reemplaza {organization} por el nombre entre comillas', () => {
  assert.equal(resolveJql(DEFAULT_JQL, 'Cliente Demo'),
    'project = JCS AND Organizations = "Cliente Demo" AND created >= startOfDay(-3M) ORDER BY created DESC');
});

test('escapa comillas y barras del nombre', () => {
  assert.equal(resolveJql('Organizations = {organization}', 'A "B" \\ C'), 'Organizations = "A \\"B\\" \\\\ C"');
});

test('reemplaza todas las apariciones', () => {
  assert.equal(resolveJql('{organization} OR {organization}', 'X'), '"X" OR "X"');
});

test('detecta si falta el comodín', () => {
  assert.equal(hasPlaceholder(DEFAULT_JQL), true);
  assert.equal(hasPlaceholder('project = JCS'), false);
});

test('detecta si el JQL filtra por Organization (campo de Jira o comodín)', () => {
  assert.equal(filtersByOrganization(DEFAULT_JQL), true);
  assert.equal(filtersByOrganization('project = JCS AND Organizations = "Carrefour - Argentina" ORDER BY created DESC'), true);
  assert.equal(filtersByOrganization('project = JCS and organizations in ("A", "B")'), true);
  assert.equal(filtersByOrganization('project = JCS AND ORGANIZATIONS ~ "Carrefour"'), true);
  assert.equal(filtersByOrganization('project = JCS AND created >= startOfDay(-3M)'), false);
  assert.equal(filtersByOrganization('project = JCS AND text ~ "organizations"'), false);
});

test('sin {organization} el JQL queda igual', () => {
  const jql = 'project = JCS AND Organizations = "Carrefour - Argentina"';
  assert.equal(resolveJql(jql, 'Otra Organization'), jql);
});

test('varias Organizations: {organizations} -> lista para IN, {organization} -> la primera', () => {
  assert.equal(resolveJql('Organizations in {organizations}', ['TATA Uruguay', 'Vierci "PY"']), 'Organizations in ("TATA Uruguay", "Vierci \\"PY\\"")');
  assert.equal(resolveJql('Organizations = {organization}', ['A', 'B']), 'Organizations = "A"');
  assert.equal(resolveJql('Organizations in {organizations}', 'Sola'), 'Organizations in ("Sola")');
  assert.equal(hasPlaceholder('Organizations in {organizations}'), true);
});
