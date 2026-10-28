const { requireUser } = require('../lib/auth');
const { validateSubscriptionInput } = require('../lib/subscriptions');
const { runSubscription } = require('../lib/runner');
const { getModule, listModules } = require('../modules');
const { isMailConfigured } = require('../lib/mailer');
const db = require('../lib/db');
const { sendJson, readBody, handleError, HttpError } = require('../lib/http');

// GET    /api/subscriptions                 -> lista + módulos disponibles
// GET    /api/subscriptions?id=N            -> una suscripción
// GET    /api/subscriptions?id=N&view=history -> historial de envíos + auditoría
// POST   /api/subscriptions                 -> crear
// PUT    /api/subscriptions?id=N            -> modificar
// DELETE /api/subscriptions?id=N            -> borrar
// POST   /api/subscriptions?action=preview  -> render con datos reales, sin enviar
// POST   /api/subscriptions?action=test     -> envía solo al usuario logueado
// (todo en un archivo para no sumar Serverless Functions al plan Hobby)
const AUDITED_FIELDS = ['title', 'organization', 'config', 'recipients', 'subject', 'schedule', 'language', 'active'];

function diff(before, after) {
  const changes = {};
  for (const field of AUDITED_FIELDS) {
    const from = before ? before[field] : undefined;
    const to = after ? after[field] : undefined;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return changes;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id inválido');
  return id;
}

async function validateOrFail(body, options) {
  const { data, errors, warnings } = await validateSubscriptionInput(body, options);
  if (errors.length) throw new HttpError(400, 'Hay errores en la configuración', { errors, warnings });
  return { data, warnings };
}

async function handleAction(action, req, res, user) {
  const body = readBody(req);
  const { data, warnings } = await validateOrFail(body, { checkRemote: false, requireRecipients: false });
  const existing = body.id ? await db.getSubscription(parseId(body.id)) : null;
  const subscription = { ...data, id: existing ? existing.id : null, status: existing ? existing.status : 'ok', createdBy: existing ? existing.createdBy : user.email };

  if (action === 'preview') {
    const built = await getModule(data.module).build(subscription, { mode: 'preview' });
    sendJson(res, 200, { subject: built.subject, html: built.html, itemCount: built.itemCount, warnings: [...warnings, ...built.warnings] });
    return;
  }

  if (action === 'test') {
    if (!isMailConfigured()) throw new HttpError(503, 'El envío de correo todavía no está configurado; por ahora solo está disponible la vista previa');
    const outcome = await runSubscription(subscription, { kind: 'test', triggeredBy: user.email, testRecipient: user.email });
    if (outcome.result !== 'ok') throw new HttpError(502, `No se pudo enviar la prueba: ${outcome.error}`);
    sendJson(res, 200, { ok: true, sentTo: user.email, warnings });
    return;
  }

  throw new HttpError(400, 'Acción desconocida');
}

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id, view, action } = req.query || {};

    if (req.method === 'POST' && action) {
      await handleAction(String(action), req, res, user);
      return;
    }

    if (req.method === 'GET') {
      if (!id) {
        sendJson(res, 200, { subscriptions: await db.listSubscriptions(), modules: listModules() });
        return;
      }
      const subscriptionId = parseId(id);
      const subscription = await db.getSubscription(subscriptionId);
      if (!subscription) throw new HttpError(404, 'Suscripción inexistente');

      if (view === 'history') {
        const [history, audit] = await Promise.all([db.listHistory(subscriptionId), db.listAudit('subscription', subscriptionId)]);
        sendJson(res, 200, { history, audit });
        return;
      }
      sendJson(res, 200, { subscription });
      return;
    }

    if (req.method === 'POST') {
      const { data, warnings } = await validateOrFail(readBody(req));
      const created = await db.createSubscription(data, user.email);
      await db.addAudit('subscription', created.id, 'create', user.email, diff(null, created));
      sendJson(res, 201, { subscription: created, warnings });
      return;
    }

    if (req.method === 'PUT') {
      const subscriptionId = parseId(id);
      const before = await db.getSubscription(subscriptionId);
      if (!before) throw new HttpError(404, 'Suscripción inexistente');

      const { data, warnings } = await validateOrFail(readBody(req));
      if (data.module !== before.module) throw new HttpError(400, 'No se puede cambiar el módulo de una suscripción');

      const updated = await db.updateSubscription(subscriptionId, data, user.email);
      await db.addAudit('subscription', subscriptionId, 'update', user.email, diff(before, updated));
      sendJson(res, 200, { subscription: updated, warnings });
      return;
    }

    if (req.method === 'DELETE') {
      const subscriptionId = parseId(id);
      const before = await db.getSubscription(subscriptionId);
      if (!before || !(await db.deleteSubscription(subscriptionId))) throw new HttpError(404, 'Suscripción inexistente');
      await db.addAudit('subscription', subscriptionId, 'delete', user.email, diff(before, null));
      sendJson(res, 200, { ok: true });
      return;
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (error) {
    handleError(res, error);
  }
};
