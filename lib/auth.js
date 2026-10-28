const crypto = require('node:crypto');
const { jwtVerify, SignJWT } = require('jose');
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
    throw new Error(`Falta ACCESS_KEY (mínimo ${MIN_ACCESS_KEY_LENGTH} caracteres)`);
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

async function createSessionCookie(user) {
  const token = await new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(sessionKey());
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
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ['HS256'] });
    if (!String(payload.email || '').endsWith(`@${userDomain()}`)) return null;
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
