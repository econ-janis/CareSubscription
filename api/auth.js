const { verifyGoogleCredential, createSessionCookie, clearSessionCookie, getSessionUser, ssoDomain } = require('../lib/auth');
const { sendJson, readBody, handleError } = require('../lib/http');

// GET    /api/auth -> { user, googleClientId, ssoDomain }
// POST   /api/auth { credential } -> login con el ID token de Google
// DELETE /api/auth -> logout
module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const user = await getSessionUser(req);
      sendJson(res, 200, { user, googleClientId: process.env.GOOGLE_CLIENT_ID || '', ssoDomain: ssoDomain() });
      return;
    }

    if (req.method === 'POST') {
      const { credential } = readBody(req);
      const user = await verifyGoogleCredential(String(credential || ''));
      res.setHeader('Set-Cookie', await createSessionCookie(user));
      sendJson(res, 200, { user });
      return;
    }

    if (req.method === 'DELETE') {
      res.setHeader('Set-Cookie', clearSessionCookie());
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    handleError(res, error);
  }
};
