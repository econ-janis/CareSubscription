const { dueSlot } = require('./schedule');
const { runSubscription } = require('./runner');
const { isMailConfigured } = require('./mailer');
const db = require('./db');

// Corre cada hora (ver .github/workflows/dispatch.yml). Para cada
// suscripción activa con un slot pendiente: lock, envío y marca del slot.
// Si el fallo es transitorio (Jira/SMTP caídos) el slot NO se marca, así
// la corrida de la hora siguiente lo reintenta mientras siga dentro de la
// ventana de gracia (lib/schedule.js).
async function dispatch({ now = new Date(), deadlineMs = 50000 } = {}) {
  const started = Date.now();
  const summary = { checked: 0, sent: 0, skipped: 0, failed: 0, pending: 0 };

  // Sin SMTP no hay nada que enviar: no se consulta Jira ni se registran
  // errores cada hora. Los horarios que pasen mientras tanto no se recuperan
  // (fuera de la ventana de gracia) al configurar el correo.
  if (!isMailConfigured()) return { ...summary, mailDisabled: true };

  const subscriptions = await db.listActiveSubscriptions();
  for (const subscription of subscriptions) {
    summary.checked++;
    const slot = dueSlot(subscription.schedule, { now, lastSlotAt: subscription.lastSlotAt, since: subscription.createdAt });
    if (!slot) continue;

    // Sin tiempo para otro envío dentro de esta invocación: queda para la próxima.
    if (Date.now() - started > deadlineMs) {
      summary.pending++;
      continue;
    }
    if (!(await db.acquireLock(subscription.id))) continue;

    try {
      // Re-leer con el lock tomado: otra corrida pudo haber enviado el slot entre medio.
      const fresh = await db.getSubscription(subscription.id);
      if (!fresh || !fresh.active || (fresh.lastSlotAt && new Date(fresh.lastSlotAt) >= slot)) continue;

      const outcome = await runSubscription(fresh, { kind: 'scheduled', slotAt: slot, now });
      if (outcome.result === 'ok') summary.sent++;
      else if (outcome.result === 'skipped') summary.skipped++;
      else summary.failed++;

      if (!(outcome.result === 'error' && outcome.transient)) await db.markSlotDone(subscription.id, slot);
    } finally {
      await db.releaseLock(subscription.id);
    }
  }
  return summary;
}

module.exports = { dispatch };
