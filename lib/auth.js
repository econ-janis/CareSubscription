const { HttpError } = require('./http');
const { setSealedCookie, readSealedCookie, hasSealedCookie, clearSealedCookie } = require('./session');
const { refreshTokens, expiresAtOf, AuthError } = require('./janis-id');

// Acceso exclusivo con Janis ID (OpenID Connect, ver lib/janis-id.js).
//
// La sesión es una cookie cifrada (HttpOnly, Secure, SameSite=Lax: los POST
// cross-site no la llevan, así que sirve también como defensa CSRF) con sub,
// email, name y los tokens de Janis ID. Los tokens nunca llegan al
// navegador: solo se usan del lado del servidor.
//
// Janis ID también lo usan los clientes de Janis: solo entran correos de
// USER_DOMAIN (por defecto janiscommerce.com).
const SESSION_COOKIE = 'cs_session';
const SESSION_PURPOSE = 'session';
// Duración máxima de una sesión, aunque se renueven los tokens.
const SESSION_TTL_SECONDS = 12 * 60 * 60;
// Se renueva el access token un poco antes de que venza.
const REFRESH_MARGIN_MS = 30 * 1000;

function userDomain() {
  return (process.env.USER_DOMAIN || 'janiscommerce.com').toLowerCase();
}

function isAllowedEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(normalized) && normalized.endsWith(`@${userDomain()}`);
}

// Solo rutas relativas de la app (nada de //otro-sitio ni /\otro-sitio).
function safeReturnTo(value) {
  const path = String(value || '');
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\') || /[\r\n]/.test(path)) return '/';
  if (path === '/login' || path.startsWith('/login?') || path.startsWith('/logout')) return '/';
  return path;
}

function saveSession(res, session) {
  const maxAge = Math.max(0, Math.floor((session.sessionExp - Date.now()) / 1000));
  setSealedCookie(res, SESSION_COOKIE, session, SESSION_PURPOSE, maxAge);
}

// Crea la sesión con lo que devolvió el token endpoint y los claims ya
// validados del id_token.
function createSession(res, tokens, claims, now = Date.now()) {
  const email = String(claims.email || '').trim().toLowerCase();
  if (!isAllowedEmail(email)) throw new HttpError(403, `Solo pueden ingresar cuentas de ${userDomain()}`);
  const session = {
    sub: String(claims.sub || ''),
    email,
    name: String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email),
    accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token || '',
    expiresAt: expiresAtOf(tokens, claims, now),
    sessionExp: now + SESSION_TTL_SECONDS * 1000,
  };
  saveSession(res, session);
  return session;
}

function clearSession(res) {
  clearSealedCookie(res, SESSION_COOKIE);
}

// Sesión completa (incluye tokens: solo para usar del lado del servidor).
// Si el access token venció y hay refresh_token, lo renueva y actualiza la
// cookie; si no se puede, cierra la sesión. null = sin sesión válida.
async function getSession(req, res, { now = Date.now(), refresh = refreshTokens } = {}) {
  if (!hasSealedCookie(req, SESSION_COOKIE)) return null;
  const session = readSealedCookie(req, SESSION_COOKIE, SESSION_PURPOSE);
  if (!session || !session.sessionExp || session.sessionExp < now || !isAllowedEmail(session.email)) {
    if (res) clearSession(res);
    return null;
  }
  if (session.expiresAt - REFRESH_MARGIN_MS > now) return session;

  if (!session.refreshToken) {
    if (res) clearSession(res);
    return null;
  }
  try {
    const tokens = await refresh(session.refreshToken);
    if (!tokens.access_token) throw new AuthError('respuesta sin access_token');
    const renewed = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || session.refreshToken,
      expiresAt: expiresAtOf(tokens, null, now),
    };
    if (res) saveSession(res, renewed);
    return renewed;
  } catch (error) {
    console.warn(`[auth] no se pudo renovar la sesión: ${error instanceof AuthError ? error.message : 'error inesperado'}`);
    if (res) clearSession(res);
    return null;
  }
}

// Usuario visible para la UI y la auditoría (sin tokens).
function publicUser(session) {
  return session ? { sub: session.sub, email: session.email, name: session.name } : null;
}

async function getSessionUser(req, res) {
  return publicUser(await getSession(req, res));
}

async function requireUser(req, res) {
  const user = await getSessionUser(req, res);
  if (!user) throw new HttpError(401, 'No autenticado');
  return user;
}

module.exports = {
  createSession,
  clearSession,
  getSession,
  getSessionUser,
  requireUser,
  publicUser,
  safeReturnTo,
  isAllowedEmail,
  userDomain,
  SESSION_COOKIE,
};
