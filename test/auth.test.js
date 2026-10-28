const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyAccess, createSessionCookie, getSessionUser } = require('../lib/auth');

const KEY = 'clave-de-prueba-suficientemente-larga';

function withAccessKey(value, fn) {
  const previous = process.env.ACCESS_KEY;
  process.env.ACCESS_KEY = value;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.ACCESS_KEY;
    else process.env.ACCESS_KEY = previous;
  });
}

test('acepta la clave correcta y un correo de Janis', () => withAccessKey(KEY, () => {
  assert.deepEqual(verifyAccess(KEY, ' Ana@JanisCommerce.com '), { email: 'ana@janiscommerce.com' });
}));

test('rechaza clave incorrecta y correos de otros dominios', () => withAccessKey(KEY, () => {
  assert.throws(() => verifyAccess('otra', 'ana@janiscommerce.com'), /incorrecta/);
  assert.throws(() => verifyAccess(KEY, 'ana@gmail.com'), /janiscommerce\.com/);
  assert.throws(() => verifyAccess(KEY, 'x@janiscommerce.com.evil.com'), /janiscommerce\.com/);
}));

test('sin ACCESS_KEY (o muy corta) no se puede entrar', () => withAccessKey('corta', () => {
  assert.throws(() => verifyAccess('corta', 'ana@janiscommerce.com'), /ACCESS_KEY/);
}));

test('la sesión se valida y deja de valer al rotar la clave', async () => {
  const cookie = await withAccessKey(KEY, () => createSessionCookie({ email: 'ana@janiscommerce.com' }));
  const req = { headers: { cookie: cookie.split(';')[0] } };

  assert.deepEqual(await withAccessKey(KEY, () => getSessionUser(req)), { email: 'ana@janiscommerce.com' });
  assert.equal(await withAccessKey(`${KEY}-rotada`, () => getSessionUser(req)), null);
});
