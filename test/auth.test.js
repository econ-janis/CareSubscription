const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.SESSION_SECRET = crypto.randomBytes(32).toString('base64');
process.env.JANIS_CLIENT_ID = 'client-test';
process.env.JANIS_CLIENT_SECRET = 'secret-test';
process.env.JANIS_REDIRECT_URI = 'https://app.test/login';

const { seal, unseal } = require('../lib/session');
const { checkState, verifyIdToken, ISSUER, AUTHORIZE_URL } = require('../lib/janis-id');
const { createSession, getSession, safeReturnTo } = require('../lib/auth');
const handler = require('../api/auth');

// Par de claves RSA que hace de Janis ID.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const jwks = async () => [JWK];

function idToken(claims = {}, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: 'client-test', sub: 'u1', email: 'ana@janiscommerce.com', name: 'Ana Pérez', iat: now, exp: now + 300, nonce: 'n1', ...claims })).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

// Respuesta mínima compatible con la de Vercel (Node).
function mockRes() {
  const headers = {};
  return {
    statusCode: 200,
    headersSent: false,
    body: '',
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    end(body = '') { this.body = String(body); this.headersSent = true; },
    headers,
  };
}

// Set-Cookie -> header Cookie (solo las que tienen valor).
function cookiesFrom(res, previous = '') {
  const jar = new Map(previous.split(';').map((c) => c.trim()).filter(Boolean).map((c) => [c.split('=')[0], c]));
  for (const header of [].concat(res.getHeader('Set-Cookie') || [])) {
    const pair = header.split(';')[0];
    const [name, value] = [pair.split('=')[0], pair.slice(pair.indexOf('=') + 1)];
    if (value) jar.set(name, pair); else jar.delete(name);
  }
  return [...jar.values()].join('; ');
}

async function call(query, cookie = '') {
  const res = mockRes();
  await handler({ method: 'GET', query, headers: { cookie } }, res);
  return res;
}

test('cookie cifrada: no se puede leer ni alterar, ni usar con otro propósito', () => {
  const sealed = seal({ a: 1, token: 'secreto' }, 'session');
  assert.ok(!sealed.includes('secreto'));
  assert.deepEqual(unseal(sealed, 'session'), { a: 1, token: 'secreto' });
  assert.equal(unseal(sealed, 'login'), null);
  const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`;
  assert.equal(unseal(tampered, 'session'), null);
});

test('state alterado o vencido se rechaza', () => {
  const pending = { state: 'abc', exp: Date.now() + 1000 };
  assert.doesNotThrow(() => checkState(pending, 'abc'));
  assert.throws(() => checkState(pending, 'abd'), /state inválido/);
  assert.throws(() => checkState(null, 'abc'), /state inválido/);
  assert.throws(() => checkState({ state: 'abc', exp: Date.now() - 1 }, 'abc'), /state vencido/);
});

test('id_token: firma, algoritmo, issuer, audience, vencimiento y nonce', async () => {
  const opts = { nonce: 'n1', clientId: 'client-test', jwks };
  assert.equal((await verifyIdToken(idToken(), opts)).email, 'ana@janiscommerce.com');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyIdToken(idToken({}, { key: other }), opts), /firma/);
  await assert.rejects(verifyIdToken(idToken({}, { alg: 'HS256' }), opts), /algoritmo/);
  await assert.rejects(verifyIdToken(idToken({}, { kid: 'otra' }), opts), /clave desconocida/);
  await assert.rejects(verifyIdToken(idToken({ iss: 'https://evil.test' }), opts), /issuer/);
  await assert.rejects(verifyIdToken(idToken({ aud: 'otra-app' }), opts), /audience/);
  await assert.rejects(verifyIdToken(idToken({ exp: Math.floor(Date.now() / 1000) - 600 }), opts), /vencido/);
  await assert.rejects(verifyIdToken(idToken({ nonce: 'otro' }), opts), /nonce/);
  await assert.rejects(verifyIdToken('a.b', opts), /mal formado/);
});

test('returnTo: solo rutas relativas de la app', () => {
  assert.equal(safeReturnTo('/reportes/5/2026-10-29?h=3#org-a'), '/reportes/5/2026-10-29?h=3#org-a');
  for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '', '/login?x=1', '/logout']) assert.equal(safeReturnTo(bad), '/', bad);
});

test('solo cuentas del dominio de Janis', () => {
  assert.throws(() => createSession(mockRes(), { access_token: 'x' }, { sub: 'c', email: 'cliente@carrefour.com', exp: 1 }), /janiscommerce\.com/);
});

test('refresh: renueva el access token vencido; si falla, cierra la sesión', async () => {
  const res = mockRes();
  createSession(res, { access_token: 'viejo', refresh_token: 'r1', expires_in: 1 }, { sub: 'u1', email: 'ana@janiscommerce.com', name: 'Ana' });
  const req = { headers: { cookie: cookiesFrom(res) } };
  const later = Date.now() + 10 * 60 * 1000;

  const renewedRes = mockRes();
  const renewed = await getSession(req, renewedRes, { now: later, refresh: async (token) => ({ access_token: `nuevo-${token}`, refresh_token: 'r2', expires_in: 3600 }) });
  assert.equal(renewed.accessToken, 'nuevo-r1');
  assert.equal(renewed.refreshToken, 'r2');
  assert.ok(cookiesFrom(renewedRes).includes('cs_session.0='));

  const failedRes = mockRes();
  assert.equal(await getSession(req, failedRes, { now: later, refresh: async () => { throw new Error('invalid_grant'); } }), null);
  assert.ok([].concat(failedRes.getHeader('Set-Cookie')).some((c) => c.startsWith('cs_session.0=;') && c.includes('Max-Age=0')));
});

test('flujo completo: /login -> Janis ID -> callback -> sesión -> /api/me -> /logout', async () => {
  // Sin sesión, /api/me responde 401.
  assert.equal((await call({ action: 'me' })).statusCode, 401);

  // Pantalla de ingreso.
  const page = await call({ action: 'login', returnTo: '/reportes/5/2026-10-29' });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('Ingresar con Janis'));

  // Inicio: redirige al authorize con state, nonce y PKCE.
  const start = await call({ action: 'login', start: '1', returnTo: '/reportes/5/2026-10-29' });
  assert.equal(start.statusCode, 302);
  const authorize = new URL(start.getHeader('Location'));
  assert.equal(`${authorize.origin}${authorize.pathname}`, AUTHORIZE_URL);
  assert.equal(authorize.searchParams.get('client_id'), 'client-test');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://app.test/login');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const loginCookie = cookiesFrom(start);
  assert.ok(!loginCookie.includes(authorize.searchParams.get('state')), 'el state no va en claro en la cookie');

  // Callback con un state alterado: rechazado, sin sesión.
  const forged = await call({ action: 'login', code: 'c1', state: 'otro' }, loginCookie);
  assert.equal(forged.statusCode, 400);
  assert.ok(!cookiesFrom(forged).includes('cs_session.0='));

  // Callback válido (Janis ID simulado).
  const realFetch = global.fetch;
  const sent = [];
  global.fetch = async (url, options = {}) => {
    sent.push({ url: String(url), body: String(options.body || '') });
    if (String(url).includes('jwks')) return new Response(JSON.stringify({ keys: [JWK] }));
    return new Response(JSON.stringify({ access_token: 'AT-secreto', refresh_token: 'RT-secreto', expires_in: 3600, id_token: idToken({ nonce: authorize.searchParams.get('nonce') }) }));
  };
  let callback;
  try {
    callback = await call({ action: 'login', code: 'c1', state: authorize.searchParams.get('state') }, loginCookie);
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.getHeader('Location'), '/reportes/5/2026-10-29');
  const tokenCall = new URLSearchParams(sent.find((s) => s.url.includes('/token')).body);
  assert.equal(tokenCall.get('grant_type'), 'authorization_code');
  assert.equal(tokenCall.get('client_secret'), 'secret-test');
  assert.ok(tokenCall.get('code_verifier'));
  const sessionCookie = cookiesFrom(callback);
  assert.ok(sessionCookie.includes('cs_session.0='));
  assert.ok(!sessionCookie.includes('cs_login.0='), 'la cookie del login en curso se borra');
  assert.ok(!sessionCookie.includes('AT-secreto') && !sessionCookie.includes('RT-secreto'), 'tokens cifrados');
  assert.ok([].concat(callback.getHeader('Set-Cookie')).every((c) => /HttpOnly; Secure; SameSite=Lax/.test(c)));

  // El mismo code/state no se puede reutilizar (la cookie del login ya no está).
  assert.equal((await call({ action: 'login', code: 'c1', state: authorize.searchParams.get('state') }, sessionCookie)).statusCode, 400);

  // /api/me y /api/auth: usuario sin tokens.
  const me = await call({ action: 'me' }, sessionCookie);
  assert.deepEqual(JSON.parse(me.body), { sub: 'u1', email: 'ana@janiscommerce.com', name: 'Ana Pérez' });
  const auth = await call({}, sessionCookie);
  assert.ok(!auth.body.includes('secreto'));
  assert.equal(JSON.parse(auth.body).user.email, 'ana@janiscommerce.com');

  // Logout: borra la sesión y vuelve a /login.
  const logout = await call({ action: 'logout' }, sessionCookie);
  assert.equal(logout.statusCode, 302);
  assert.equal(logout.getHeader('Location'), '/login');
  assert.equal((await call({ action: 'me' }, cookiesFrom(logout, sessionCookie))).statusCode, 401);
});

test('Janis ID devuelve error: mensaje amigable con opción de reintentar', async () => {
  const res = await call({ action: 'login', error: 'access_denied' });
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.includes('Se canceló el ingreso con Janis'));
  assert.ok(res.body.includes('Reintentar'));
});
