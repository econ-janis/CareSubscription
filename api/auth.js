const { verifyAccess, createSessionCookie, clearSessionCookie, getSessionUser, userDomain } = require('../lib/auth');
const { isMailConfigured } = require('../lib/mailer');
const { isSlackConfigured, slackChannel } = require('../lib/slack');
const { sendJson, readBody, handleError } = require('../lib/http');

// GET    /api/auth -> { user, userDomain, mailEnabled, slackEnabled, slackChannel, accessConfigured }
// POST   /api/auth { accessKey, email } -> login con la clave compartida
// DELETE /api/auth -> logout
module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const accessConfigured = (process.env.ACCESS_KEY || '').length >= 16;
      const user = accessConfigured ? await getSessionUser(req) : null;
      sendJson(res, 200, {
        user,
        userDomain: userDomain(),
        mailEnabled: isMailConfigured(),
        slackEnabled: isSlackConfigured(),
        slackChannel: slackChannel(),
        accessConfigured,
      });
      return;
    }

    if (req.method === 'POST') {
      const { accessKey, email } = readBody(req);
      const user = verifyAccess(String(accessKey || ''), email);
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
