const crypto = require('node:crypto');
const { HttpError } = require('./http');

// Cookies cifradas (AES-256-GCM con clave derivada de SESSION_SECRET): el
// navegador no puede leer ni modificar su contenido (tokens de Janis ID
// incluidos). Se arma con node:crypto y no con `jose`: las versiones
// actuales de jose son solo ESM y no cargan con require() en el runtime de
// Vercel (ya pasó: ERR_REQUIRE_ESM y error 500 en producción).
//
// Formato: base64url(iv[12] | tag[16] | cifrado). El "propósito" (sesión o
// login en curso) va como dato autenticado: una cookie no sirve por otra.
const MIN_SECRET_BYTES = 32;
// Los navegadores aceptan ~4 KB por cookie: la sesión (con los tokens) se
// parte en varias si hace falta.
const CHUNK_SIZE = 3800;
const MAX_CHUNKS = 5;

function sessionSecret() {
  const raw = process.env.SESSION_SECRET || '';
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length < MIN_SECRET_BYTES) {
    throw new HttpError(503, `La app no tiene configurada SESSION_SECRET (${MIN_SECRET_BYTES} bytes en base64) en el despliegue`);
  }
  return crypto.createHash('sha256').update(decoded).digest();
}

function seal(data, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionSecret(), iv);
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

// Devuelve el objeto o null si la cookie fue alterada, es de otro propósito
// o se cifró con otra clave (rotar SESSION_SECRET cierra todas las sesiones).
function unseal(value, purpose) {
  try {
    const raw = Buffer.from(String(value || ''), 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionSecret(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return null;
  }
}

function readCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  return cookies;
}

function cookieHeader(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// Agrega Set-Cookie sin pisar los que ya tenga la respuesta.
function appendCookies(res, cookies) {
  const current = res.getHeader('Set-Cookie');
  const list = current ? [].concat(current) : [];
  res.setHeader('Set-Cookie', [...list, ...cookies]);
}

// Cookie cifrada repartida en <name>.0, <name>.1, ...; borra las partes que
// sobren de una versión anterior más larga.
function setSealedCookie(res, name, data, purpose, maxAge) {
  const value = seal(data, purpose);
  const chunks = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) chunks.push(value.slice(i, i + CHUNK_SIZE));
  if (chunks.length > MAX_CHUNKS) throw new Error('La sesión no entra en las cookies');
  appendCookies(res, Array.from({ length: MAX_CHUNKS }, (_, i) => (i < chunks.length ? cookieHeader(`${name}.${i}`, chunks[i], maxAge) : cookieHeader(`${name}.${i}`, '', 0))));
}

function readSealedCookie(req, name, purpose) {
  const cookies = readCookies(req);
  let value = '';
  for (let i = 0; i < MAX_CHUNKS && cookies[`${name}.${i}`]; i++) value += cookies[`${name}.${i}`];
  return value ? unseal(value, purpose) : null;
}

function hasSealedCookie(req, name) {
  return Boolean(readCookies(req)[`${name}.0`]);
}

function clearSealedCookie(res, name) {
  appendCookies(res, Array.from({ length: MAX_CHUNKS }, (_, i) => cookieHeader(`${name}.${i}`, '', 0)));
}

module.exports = { seal, unseal, setSealedCookie, readSealedCookie, hasSealedCookie, clearSealedCookie, sessionSecret };
