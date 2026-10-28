const { createRemoteJWKSet, jwtVerify, SignJWT } = require('jose');
const { HttpError } = require('./http');

// Acceso a la UI solo con usuarios de Janis: login con Google (SSO de
// Workspace). El ID token de Google se verifica en el server y se exige
// que la cuenta pertenezca al dominio SSO_DOMAIN (claim `hd`, que Google
// solo emite para cuentas de Workspace). Después se emite una cookie de
// sesión propia, firmada con SESSION_SECRET, HttpOnly y SameSite=Lax (los
// POST cross-site no la llevan, así que sirve también como defensa CSRF).
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const COOKIE_NAME = 'cs_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function ssoDomain() {
  return (process.env.SSO_DOMAIN || 'janiscommerce.com').toLowerCase();
}

function sessionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('Falta SESSION_SECRET (mínimo 32 caracteres)');
  }
  return new TextEncoder().encode(secret);
}

async function verifyGoogleCredential(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Falta GOOGLE_CLIENT_ID');

  let payload;
  try {
    ({ payload } = await jwtVerify(credential, GOOGLE_JWKS, {
      audience: clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    }));
  } catch (error) {
    throw new HttpError(401, 'Credencial de Google inválida');
  }

  const email = String(payload.email || '').toLowerCase();
  if (!payload.email_verified || payload.hd !== ssoDomain() || !email.endsWith(`@${ssoDomain()}`)) {
    throw new HttpError(403, `Solo usuarios de ${ssoDomain()}`);
  }
  return { email, name: payload.name || email };
}

async function createSessionCookie(user) {
  const token = await new SignJWT({ email: user.email, name: user.name })
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
    if (!String(payload.email || '').endsWith(`@${ssoDomain()}`)) return null;
    return { email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

async function requireUser(req) {
  const user = await getSessionUser(req);
  if (!user) throw new HttpError(401, 'No autenticado');
  return user;
}

module.exports = { verifyGoogleCredential, createSessionCookie, clearSessionCookie, getSessionUser, requireUser, ssoDomain };
