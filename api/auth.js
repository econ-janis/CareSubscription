const { createSession, clearSession, getSession, getSessionUser, publicUser, safeReturnTo, userDomain } = require('../lib/auth');
const { setSealedCookie, readSealedCookie, clearSealedCookie } = require('../lib/session');
const { isLoginConfigured, startLogin, checkState, exchangeCode, verifyIdToken, AuthError } = require('../lib/janis-id');
const { isMailConfigured } = require('../lib/mailer');
const { isSlackConfigured, slackChannel } = require('../lib/slack');
const { sendJson, handleError, HttpError } = require('../lib/http');

// Ingreso con Janis ID (rewrites en vercel.json):
// GET /login                    -> pantalla "Ingresar con Janis"
// GET /login?start=1&returnTo=  -> inicia el flujo (state, nonce y PKCE en cookie cifrada) y va al authorize
// GET /login?code=&state=       -> callback: valida state, canjea el code, valida el id_token y crea la sesión
// GET /login?error=             -> Janis ID canceló o rechazó el ingreso
// GET /logout                   -> borra la sesión y vuelve a /login
// GET /api/me                   -> { sub, email, name }
// GET /api/auth                 -> { user, userDomain, mailEnabled, slackEnabled, slackChannel, loginConfigured }
const PENDING_COOKIE = 'cs_login';
const PENDING_PURPOSE = 'login';
const PENDING_TTL_SECONDS = 10 * 60;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function loginUrl(returnTo, extra = '') {
  return `/login?${extra}returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

// Pantalla de ingreso / error (HTML simple, mismo estilo que la app).
function sendLoginPage(res, { statusCode = 200, returnTo = '/', error = '', configured = true } = {}) {
  const button = configured
    ? `<a class="btn" href="${esc(loginUrl(returnTo, 'start=1&'))}">${error ? 'Reintentar' : 'Ingresar con Janis'}</a>`
    : '';
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ingresar · CareSubscription</title>
<link rel="icon" href="/brand/iso-color.svg">
<style>
  :root { color-scheme: light dark; --bg: #F4F6F9; --card: #FFFFFF; --text: #001233; --muted: #33415C; --border: #E3E6EB; --primary: #2979FF; --err-bg: #FFF1EE; --err: #B42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14161B; --card: #1D2027; --text: #E6E8EC; --muted: #A9B2C0; --border: #2C303A; --err-bg: #3A1D1A; --err: #FFB4A8; } }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: Montserrat, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .card { max-width: 420px; margin: 12vh auto; padding: 32px 24px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; text-align: center; }
  img { height: 40px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: var(--muted); font-size: 14px; margin: 0 0 20px; }
  .btn { display: inline-block; width: 100%; box-sizing: border-box; padding: 11px 16px; border-radius: 8px; background: var(--primary); color: #fff; font-weight: 600; text-decoration: none; }
  .err { background: var(--err-bg); color: var(--err); border-radius: 8px; padding: 10px 12px; font-size: 14px; margin: 0 0 16px; text-align: left; }
  @media (max-width: 480px) { .card { margin: 8vh 16px; } }
</style>
</head>
<body>
<main class="card">
  <img src="/brand/iso-color.svg" alt="Janis">
  <h1>CareSubscription</h1>
  <p>Acceso restringido al equipo de Janis.</p>
  ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
  ${button}
</main>
</body>
</html>`);
}

async function handleLogin(req, res) {
  const query = req.query || {};
  const returnTo = safeReturnTo(query.returnTo);

  if (!isLoginConfigured()) {
    sendLoginPage(res, { statusCode: 503, configured: false, error: 'El ingreso con Janis todavía no está configurado en este despliegue.' });
    return;
  }

  // Janis ID devolvió un error (ej. el usuario canceló).
  if (query.error) {
    const pending = readSealedCookie(req, PENDING_COOKIE, PENDING_PURPOSE);
    clearSealedCookie(res, PENDING_COOKIE);
    console.warn(`[auth] Janis ID devolvió error: ${String(query.error).slice(0, 40)}`);
    const message = query.error === 'access_denied' ? 'Se canceló el ingreso con Janis.' : 'Janis no pudo completar el ingreso.';
    sendLoginPage(res, { statusCode: 400, returnTo: pending ? pending.returnTo : returnTo, error: `${message} Vuelve a intentarlo.` });
    return;
  }

  // Callback.
  if (query.code) {
    const pending = readSealedCookie(req, PENDING_COOKIE, PENDING_PURPOSE);
    clearSealedCookie(res, PENDING_COOKIE);
    try {
      checkState(pending, query.state);
      const tokens = await exchangeCode(String(query.code), pending.codeVerifier);
      const claims = await verifyIdToken(tokens.id_token, { nonce: pending.nonce });
      createSession(res, tokens, claims);
      redirect(res, safeReturnTo(pending.returnTo));
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 403) {
        console.warn('[auth] ingreso rechazado: la cuenta no es del dominio permitido');
        sendLoginPage(res, { statusCode: 403, returnTo: '/', error: `${error.message}. Ingresa con tu cuenta de Janis.` });
        return;
      }
      if (!(error instanceof AuthError)) throw error;
      console.warn(`[auth] ingreso rechazado: ${error.message}`);
      sendLoginPage(res, { statusCode: 400, returnTo: pending ? pending.returnTo : '/', error: 'No se pudo completar el ingreso (la solicitud no es válida o venció). Vuelve a intentarlo.' });
    }
    return;
  }

  // Ya hay sesión: no hace falta ingresar de nuevo.
  if (await getSession(req, res)) {
    redirect(res, returnTo);
    return;
  }

  if (query.start) {
    const { pending, url } = startLogin(returnTo);
    setSealedCookie(res, PENDING_COOKIE, pending, PENDING_PURPOSE, PENDING_TTL_SECONDS);
    redirect(res, url);
    return;
  }

  sendLoginPage(res, { returnTo });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const action = String((req.query || {}).action || '');

    if (action === 'login') {
      await handleLogin(req, res);
      return;
    }

    if (action === 'logout') {
      clearSession(res);
      clearSealedCookie(res, PENDING_COOKIE);
      redirect(res, '/login');
      return;
    }

    if (action === 'me') {
      const user = publicUser(await getSession(req, res));
      if (!user) throw new HttpError(401, 'No autenticado');
      sendJson(res, 200, user);
      return;
    }

    sendJson(res, 200, {
      user: isLoginConfigured() ? await getSessionUser(req, res) : null,
      userDomain: userDomain(),
      mailEnabled: isMailConfigured(),
      slackEnabled: isSlackConfigured(),
      slackChannel: slackChannel(),
      loginConfigured: isLoginConfigured(),
    });
  } catch (error) {
    if ((req.query || {}).action === 'login' && !res.headersSent) {
      if (!(error instanceof HttpError)) console.error('[auth] error interno en el ingreso', error && error.name);
      sendLoginPage(res, { statusCode: error instanceof HttpError ? error.statusCode : 500, configured: false, error: error instanceof HttpError ? error.message : 'Ocurrió un error inesperado. Vuelve a intentarlo en unos minutos.' });
      return;
    }
    handleError(res, error);
  }
};
