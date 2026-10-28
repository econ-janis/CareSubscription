const { dispatch } = require('../lib/dispatcher');
const { sendJson, isAuthorizedCron, handleError } = require('../lib/http');

// Disparado cada hora por .github/workflows/dispatch.yml (o por un cron de
// Vercel en plan Pro) con `Authorization: Bearer $CRON_SECRET`.
module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    sendJson(res, 401, { error: 'No autorizado' });
    return;
  }
  try {
    sendJson(res, 200, await dispatch());
  } catch (error) {
    handleError(res, error);
  }
};
