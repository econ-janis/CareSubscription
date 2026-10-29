const { requireUser } = require('../lib/auth');
const { validateGroupInput, validateGroupRecipients } = require('../lib/groups');
const { runGroup } = require('../lib/runner');
const { isMailConfigured } = require('../lib/mailer');
const { nextSlot } = require('../lib/schedule');
const { getModule } = require('../modules');
const db = require('../lib/db');
const { sendJson, readBody, handleError, HttpError } = require('../lib/http');

// Envíos agrupados (spec §10): varias suscripciones en un solo correo.
// GET    /api/groups                         -> lista
// GET    /api/groups?id=N                    -> uno
// GET    /api/groups?id=N&view=history       -> historial (con detalle por Organization) + auditoría
// GET    /api/groups?id=N&view=landing&date=YYYY-MM-DD[&h=historyId] -> landing (HTML) de ese envío
// POST   /api/groups                         -> crear
// PUT    /api/groups?id=N                    -> modificar
// DELETE /api/groups?id=N                    -> borrar
// POST   /api/groups?action=preview          -> render con datos reales, sin enviar
// POST   /api/groups?action=test             -> envía una prueba a un solo correo (mismas reglas que los destinatarios)
const AUDITED_FIELDS = ['name', 'recipients', 'subject', 'schedule', 'language', 'subscriptionIds', 'active', 'skipIfEmpty'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const result = await validateGroupInput(body, options);
  if (result.errors.length) throw new HttpError(400, 'Hay errores en la configuración', { errors: result.errors, warnings: result.warnings });
  return result;
}

function nextSendAt(group) {
  return group.active && isMailConfigured() ? nextSlot(group.schedule) : null;
}

async function handleAction(action, req, res, user) {
  const body = readBody(req);
  const { data, subscriptions } = await validateOrFail(body, { requireRecipients: false });
  const existing = body.id ? await db.getGroup(parseId(body.id)) : null;
  const group = { ...data, id: existing ? existing.id : null };

  if (action === 'preview') {
    const built = await getModule('ticket-report').buildGroup(group, subscriptions, { mode: 'preview' });
    sendJson(res, 200, { subject: built.subject, html: built.html, itemCount: built.itemCount, warnings: built.warnings });
    return;
  }

  if (action === 'test') {
    if (!isMailConfigured()) throw new HttpError(503, 'El envío de correo todavía no está configurado; por ahora solo está disponible la vista previa');
    // 1 suscripción: dominios de sus Organizations; 2 o más: solo internos.
    const { recipients, errors } = await validateGroupRecipients([body.testRecipient || user.email], subscriptions);
    if (errors.length || recipients.length !== 1) throw new HttpError(400, errors[0] || 'Ingresá un solo correo para la prueba');
    const outcome = await runGroup(group, { kind: 'test', triggeredBy: user.email, testRecipient: recipients[0] });
    if (outcome.result !== 'ok') throw new HttpError(502, `No se pudo enviar la prueba: ${outcome.error}`);
    sendJson(res, 200, { ok: true, sentTo: recipients[0] });
    return;
  }

  throw new HttpError(400, 'Acción desconocida');
}

module.exports = async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id, view, action, date, h } = req.query || {};

    if (req.method === 'POST' && action) {
      await handleAction(String(action), req, res, user);
      return;
    }

    if (req.method === 'GET') {
      if (!id) {
        const groups = (await db.listGroups()).map((g) => ({ ...g, nextSendAt: nextSendAt(g) }));
        sendJson(res, 200, { groups });
        return;
      }
      const groupId = parseId(id);
      const group = await db.getGroup(groupId);
      if (!group) throw new HttpError(404, 'Envío agrupado inexistente');

      if (view === 'history') {
        const [history, audit] = await Promise.all([db.listGroupHistory(groupId), db.listAudit('group', groupId)]);
        sendJson(res, 200, { history, audit, nextSendAt: nextSendAt(group), snapshotRetentionDays: db.SNAPSHOT_RETENTION_DAYS });
        return;
      }

      if (view === 'landing') {
        let found;
        if (h) found = await db.getGroupHistorySnapshot(groupId, parseId(h));
        else if (DATE_RE.test(String(date || ''))) found = await db.findGroupSendByDate(groupId, String(date), group.schedule.timezone);
        else throw new HttpError(400, 'Fecha inválida');
        if (!found) throw new HttpError(404, `No hay un envío guardado de "${group.name}" para esa fecha (las copias se guardan ${db.SNAPSHOT_RETENTION_DAYS} días)`);
        const { subject, html } = await getModule('ticket-report').renderGroupSnapshot(found.snapshot);
        sendJson(res, 200, { subject, html, sentAt: found.sentAt, historyId: found.historyId });
        return;
      }

      sendJson(res, 200, { group });
      return;
    }

    if (req.method === 'POST') {
      const { data, warnings } = await validateOrFail(readBody(req));
      const created = await db.createGroup(data, user.email);
      await db.addAudit('group', created.id, 'create', user.email, diff(null, created));
      sendJson(res, 201, { group: created, warnings });
      return;
    }

    if (req.method === 'PUT') {
      const groupId = parseId(id);
      const before = await db.getGroup(groupId);
      if (!before) throw new HttpError(404, 'Envío agrupado inexistente');
      const { data, warnings } = await validateOrFail(readBody(req));
      const updated = await db.updateGroup(groupId, data, user.email);
      await db.addAudit('group', groupId, 'update', user.email, diff(before, updated));
      sendJson(res, 200, { group: updated, warnings });
      return;
    }

    if (req.method === 'DELETE') {
      const groupId = parseId(id);
      const before = await db.getGroup(groupId);
      if (!before || !(await db.deleteGroup(groupId))) throw new HttpError(404, 'Envío agrupado inexistente');
      await db.addAudit('group', groupId, 'delete', user.email, diff(before, null));
      sendJson(res, 200, { ok: true });
      return;
    }

    throw new HttpError(405, 'Method not allowed');
  } catch (error) {
    handleError(res, error);
  }
};
