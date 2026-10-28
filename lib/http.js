// Helpers compartidos por las funciones de /api (formato Node de Vercel).

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

// Error con status HTTP: los handlers lo traducen a la respuesta. Cualquier
// otro error se responde como 500 sin detalle (puede traer datos internos).
class HttpError extends Error {
  constructor(statusCode, message, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function handleError(res, error) {
  if (error instanceof HttpError) {
    sendJson(res, error.statusCode, { error: error.message, ...error.extra });
    return;
  }
  // Errores de Jira (lib/jira.js): su mensaje es útil en la UI (ej. JQL
  // inválido) y no trae datos de tickets.
  if (error && error.name === 'JiraError') {
    sendJson(res, error.status === 400 ? 400 : 502, { error: `Jira: ${error.message}` });
    return;
  }
  console.error('[api] error interno', error);
  sendJson(res, 500, { error: 'Error interno' });
}

// El dispatcher solo se ejecuta con CRON_SECRET: a diferencia de otros
// crons, sin el secreto queda cerrado (envía datos de clientes por correo).
function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers['authorization'] === `Bearer ${secret}`;
}

module.exports = { sendJson, readBody, HttpError, handleError, isAuthorizedCron };
