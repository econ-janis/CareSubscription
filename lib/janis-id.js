const crypto = require('node:crypto');
const { HttpError } = require('./http');

// Cliente OpenID Connect de Janis ID (authorization code flow, app
// Confidential, client_secret_post). Endpoints tomados del discovery
// (https://id.janis.in/.well-known/openid-configuration).
//
// Nunca se loguean tokens, secretos ni datos personales (ISO 27001 + GDPR):
// los errores solo dicen qué paso falló.
const ISSUER = 'https://id.janis.in';
const AUTHORIZE_URL = 'https://app.janis.in/oauth/authorize';
const TOKEN_URL = 'https://id.janis.in/api/oauth/2.0/token';
const JWKS_URL = 'https://cdn.id.janis.in/.well-known/jwks.json';
const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10000;

class AuthError extends Error {}

function oidcConfig() {
  const clientId = process.env.JANIS_CLIENT_ID || '';
  const clientSecret = process.env.JANIS_CLIENT_SECRET || '';
  const redirectUri = process.env.JANIS_REDIRECT_URI || '';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new HttpError(503, 'La app no tiene configurado el ingreso con Janis (faltan JANIS_CLIENT_ID, JANIS_CLIENT_SECRET o JANIS_REDIRECT_URI)');
  }
  return { clientId, clientSecret, redirectUri, scope: process.env.JANIS_SCOPE || 'openid profile email' };
}

function isLoginConfigured() {
  return Boolean(process.env.JANIS_CLIENT_ID && process.env.JANIS_CLIENT_SECRET && process.env.JANIS_REDIRECT_URI);
}

const randomToken = () => crypto.randomBytes(32).toString('base64url');

// Datos del login en curso (van a una cookie cifrada de corta vida) y URL
// del authorize. PKCE S256 además del client secret.
function startLogin(returnTo) {
  const { clientId, redirectUri, scope } = oidcConfig();
  const pending = { state: randomToken(), nonce: randomToken(), codeVerifier: randomToken(), returnTo, exp: Date.now() + 10 * 60 * 1000 };
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: crypto.createHash('sha256').update(pending.codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return { pending, url: `${AUTHORIZE_URL}?${params}` };
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// El state del callback tiene que coincidir con el guardado y no estar vencido.
function checkState(pending, state, now = Date.now()) {
  if (!pending || !state || !safeEqual(pending.state, state)) throw new AuthError('state inválido');
  if (!pending.exp || pending.exp < now) throw new AuthError('state vencido');
}

async function tokenRequest(fields, fetchImpl = fetch) {
  const { clientId, clientSecret } = oidcConfig();
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AuthError('no se pudo conectar con el token endpoint');
  }
  const payload = await response.json().catch(() => ({}));
  // Solo el código de error de OAuth (ej. invalid_grant), nunca el cuerpo.
  if (!response.ok) throw new AuthError(`token endpoint respondió ${response.status}${payload.error ? ` (${String(payload.error).slice(0, 40)})` : ''}`);
  return payload;
}

function exchangeCode(code, codeVerifier, fetchImpl) {
  const { redirectUri } = oidcConfig();
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }, fetchImpl);
}

function refreshTokens(refreshToken, fetchImpl) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
}

// JWKS en memoria (por instancia de la función); si llega un kid que no
// está, se vuelve a pedir una vez (rotación de claves).
let jwksCache = { keys: [], fetchedAt: 0 };

async function getJwks(force, fetchImpl = fetch) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  let response;
  try {
    response = await fetchImpl(JWKS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AuthError('no se pudo obtener la JWKS');
  }
  if (!response.ok) throw new AuthError(`JWKS respondió ${response.status}`);
  const { keys } = await response.json();
  jwksCache = { keys: Array.isArray(keys) ? keys : [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('id_token mal formado');
  }
}

// Valida el id_token: firma RS256 con la JWKS de Janis ID, issuer, audience
// (= client_id), vencimiento y nonce. Devuelve los claims.
async function verifyIdToken(idToken, { nonce, clientId = oidcConfig().clientId, now = Date.now(), jwks = getJwks } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new AuthError('id_token mal formado');
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (header.alg !== 'RS256') throw new AuthError('id_token con algoritmo no permitido');

  const findKey = (keys) => keys.find((k) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig'));
  const jwk = findKey(await jwks(false)) || findKey(await jwks(true));
  if (!jwk) throw new AuthError('id_token firmado con una clave desconocida');

  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!valid) throw new AuthError('firma del id_token inválida');

  const seconds = Math.floor(now / 1000);
  if (claims.iss !== ISSUER) throw new AuthError('issuer del id_token inválido');
  const audiences = [].concat(claims.aud || []);
  if (!audiences.includes(clientId)) throw new AuthError('audience del id_token inválida');
  if (audiences.length > 1 && claims.azp && claims.azp !== clientId) throw new AuthError('azp del id_token inválido');
  if (!claims.exp || claims.exp + CLOCK_SKEW_SECONDS < seconds) throw new AuthError('id_token vencido');
  if (claims.iat && claims.iat - CLOCK_SKEW_SECONDS > seconds) throw new AuthError('id_token emitido en el futuro');
  if (!nonce || !claims.nonce || !safeEqual(claims.nonce, nonce)) throw new AuthError('nonce del id_token inválido');
  return claims;
}

// Vencimiento del access token: expires_in de la respuesta o, si no viene,
// el exp del id_token.
function expiresAtOf(tokens, claims, now = Date.now()) {
  if (Number(tokens.expires_in) > 0) return now + Number(tokens.expires_in) * 1000;
  return claims && claims.exp ? claims.exp * 1000 : now + 5 * 60 * 1000;
}

// Llama una API de Janis con el access token del usuario (para cuando se
// agreguen scopes de servicio, ej. oms:order:read). session: la de
// getSession(); headers extra, ej. { 'janis-client': '<cliente>' }.
async function janisFetch(session, url, { method = 'GET', headers = {}, body } = {}) {
  if (!session || !session.accessToken) throw new HttpError(401, 'No autenticado');
  return fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers, Authorization: `Bearer ${session.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

module.exports = {
  ISSUER,
  AUTHORIZE_URL,
  AuthError,
  oidcConfig,
  isLoginConfigured,
  startLogin,
  checkState,
  exchangeCode,
  refreshTokens,
  verifyIdToken,
  expiresAtOf,
  janisFetch,
};
