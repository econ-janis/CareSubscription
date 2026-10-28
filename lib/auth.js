const crypto = require('node:crypto');
const { HttpError } = require('./http');

// Acceso a la UI con una clave compartida (ACCESS_KEY) en lugar de SSO,
// para arrancar sin configurar un OAuth client. La UI y la API exponen
// datos de clientes (tickets, destinatarios), así que nunca quedan
// abiertas: sin ACCESS_KEY configurada no se puede entrar.
//
// Al entrar, el usuario declara su correo de Janis (no verificado) para la
// auditoría y para "Enviar prueba". Después se emite una cookie de sesión
// HttpOnly, Secure y SameSite=Lax (los POST cross-site no la llevan, así
// que sirve también como defensa CSRF), firmada con una clave derivada de
// ACCESS_KEY: rotar la clave cierra todas las sesiones.
const COOKIE_NAME = 'cs_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_ACCESS_KEY_LENGTH = 16;

function userDomain() {
  return (process.env.USER_DOMAIN || 'janiscommerce.com').toLowerCase();
}

function accessKey() {
  const key = process.env.ACCESS_KEY || '';
  if (key.length < MIN_ACCESS_KEY_LENGTH) {
    throw new HttpError(503, `La app no tiene configurada ACCESS_KEY (mínimo ${MIN_ACCESS_KEY_LENGTH} caracteres) en el despliegue`);
  }
  return key;
}

function sessionKey() {
  return crypto.createHash('sha256').update(`caresubscription-session:${accessKey()}`).digest();
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifyAccess(key, email) {
  if (!safeEqual(key, accessKey())) throw new HttpError(401, 'Clave de acceso incorrecta');

  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(normalized) || !normalized.endsWith(`@${userDomain()}`)) {
    throw new HttpError(400, `Ingresá tu correo de ${userDomain()}`);
  }
  return { email: normalized };
}

// Token de sesión: base64url(JSON) + "." + HMAC-SHA256 del payload. Se
// arma con node:crypto (sin dependencias ESM-only, que no cargan con
// require() en el runtime de Vercel).
function sign(payload) {
  return crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
}

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ email: user.email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const [payload, signature, extra] = String(token).split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!data.exp || data.exp < Date.now() / 1000) return null;
  return data;
}

async function createSessionCookie(user) {
  const token = createToken(user);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function getSessionUser(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  try {
    const payload = readToken(token);
    if (!payload || !String(payload.email || '').endsWith(`@${userDomain()}`)) return null;
    return { email: payload.email };
  } catch {
    return null;
  }
}

async function requireUser(req) {
  const user = await getSessionUser(req);
  if (!user) throw new HttpError(401, 'No autenticado');
  return user;
}

module.exports = { verifyAccess, createSessionCookie, clearSessionCookie, getSessionUser, requireUser, userDomain };
