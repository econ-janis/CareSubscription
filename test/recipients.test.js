const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRecipients, normalizeDomains } = require('../lib/recipients');

test('acepta dominios globales y del cliente, normaliza y deduplica', () => {
  const { recipients, errors } = validateRecipients('A@JanisCommerce.com, b@cliente.com\nb@cliente.com', ['cliente.com']);
  assert.deepEqual(recipients, ['a@janiscommerce.com', 'b@cliente.com']);
  assert.deepEqual(errors, []);
});

test('bloquea dominios no permitidos y correos inválidos', () => {
  const { errors } = validateRecipients(['x@gmail.com', 'no-es-correo', 'x@cliente.com.evil.com'], ['cliente.com']);
  assert.equal(errors.length, 3);
});

test('bloquea subdominios no declarados y formato con nombre', () => {
  assert.equal(validateRecipients(['x@mail.janiscommerce.com']).errors.length, 1);
  assert.equal(validateRecipients(['"Ana" <ana@janiscommerce.com>']).errors.length > 0, true);
});

test('exige al menos un destinatario', () => {
  assert.equal(validateRecipients([]).errors.length, 1);
});

test('normalizeDomains', () => {
  assert.deepEqual(normalizeDomains('@Cliente.com, cliente.com.ar  bad_domain'), { domains: ['cliente.com', 'cliente.com.ar', 'bad_domain'], invalid: ['bad_domain'] });
});
