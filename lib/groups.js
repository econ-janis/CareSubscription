const { LANGUAGES } = require('../modules/ticket-report/i18n');
const { validateSchedule } = require('./schedule');
const { validateInternalRecipients } = require('./recipients');
const db = require('./db');

// Valida el payload de un envío agrupado (spec §10.1) y lo normaliza al
// shape de lib/db.js. requireRecipients: false para vista previa / prueba.
async function validateGroupInput(body = {}, { requireRecipients = true } = {}) {
  const errors = [];
  const warnings = [];

  const name = String(body.name || '').trim();
  if (!name) errors.push('El título es obligatorio');
  if (name.length > 200) errors.push('El título no puede superar 200 caracteres');

  const requested = [...new Set((Array.isArray(body.subscriptionIds) ? body.subscriptionIds : []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  const subscriptions = await db.getSubscriptionsByIds(requested);
  if (!requested.length) errors.push('Elegí al menos una suscripción');
  if (subscriptions.length !== requested.length) errors.push('Alguna de las suscripciones elegidas ya no existe');

  const { schedule, errors: scheduleErrors } = validateSchedule(body.schedule);
  errors.push(...scheduleErrors);

  const { recipients, errors: recipientErrors } = validateInternalRecipients(body.recipients);
  if (requireRecipients) errors.push(...recipientErrors);

  return {
    errors,
    warnings,
    subscriptions,
    data: {
      name,
      recipients,
      subject: String(body.subject || '').trim().slice(0, 250),
      schedule,
      language: LANGUAGES.includes(body.language) ? body.language : 'es',
      subscriptionIds: subscriptions.map((s) => s.id),
      active: body.active !== false,
    },
  };
}

module.exports = { validateGroupInput };
