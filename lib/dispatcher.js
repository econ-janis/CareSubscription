const { dueSlot } = require('./schedule');
const { runSubscription, runGroup } = require('./runner');
const { isMailConfigured } = require('./mailer');
const db = require('./db');

// Corre cada hora (ver .github/workflows/dispatch.yml). Para cada
// suscripción y envío agrupado activos con un slot pendiente: lock, envío y
// marca del slot.
// Si el fallo es transitorio (Jira/SMTP caídos) el slot NO se marca, así
// la corrida de la hora siguiente lo reintenta mientras siga dentro de la
// ventana de gracia (lib/schedule.js).
// Recorre los elementos activos (suscripciones o envíos agrupados) y envía
// los que tienen un slot pendiente. `ops` adapta el lock/lectura/envío.
async function dispatchAll(items, ops, { now, started, deadlineMs, summary }) {
  for (const item of items) {
    summary.checked++;
    const slot = dueSlot(item.schedule, { now, lastSlotAt: item.lastSlotAt, since: item.createdAt });
    if (!slot) continue;

    // Sin tiempo para otro envío dentro de esta invocación: queda para la próxima.
    if (Date.now() - started > deadlineMs) {
      summary.pending++;
      continue;
    }
    if (!(await ops.lock(item.id))) continue;

    try {
      // Re-leer con el lock tomado: otra corrida pudo haber enviado el slot entre medio.
      const fresh = await ops.get(item.id);
      if (!fresh || !fresh.active || (fresh.lastSlotAt && new Date(fresh.lastSlotAt) >= slot)) continue;

      const outcome = await ops.run(fresh, { kind: 'scheduled', slotAt: slot, now });
      if (outcome.result === 'ok') summary.sent++;
      else if (outcome.result === 'skipped') summary.skipped++;
      else summary.failed++;

      if (!(outcome.result === 'error' && outcome.transient)) await ops.markDone(item.id, slot);
    } finally {
      await ops.release(item.id);
    }
  }
}

async function dispatch({ now = new Date(), deadlineMs = 50000 } = {}) {
  const started = Date.now();
  const summary = { checked: 0, sent: 0, skipped: 0, failed: 0, pending: 0 };

  // Sin SMTP no hay nada que enviar: no se consulta Jira ni se registran
  // errores cada hora. Los horarios que pasen mientras tanto no se recuperan
  // (fuera de la ventana de gracia) al configurar el correo.
  if (!isMailConfigured()) return { ...summary, mailDisabled: true };

  const context = { now, started, deadlineMs, summary };
  await dispatchAll(await db.listActiveSubscriptions(), {
    lock: db.acquireLock, release: db.releaseLock, get: db.getSubscription, markDone: db.markSlotDone, run: runSubscription,
  }, context);
  await dispatchAll(await db.listActiveGroups(), {
    lock: db.acquireGroupLock, release: db.releaseGroupLock, get: db.getGroup, markDone: db.markGroupSlotDone, run: runGroup,
  }, context);
  return summary;
}

module.exports = { dispatch };
