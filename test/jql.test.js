const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveJql, hasPlaceholder, DEFAULT_JQL } = require('../modules/ticket-report/jql');

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
