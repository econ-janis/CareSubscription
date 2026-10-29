const { LANGUAGES } = require('../modules/ticket-report/i18n');
const { validateSchedule } = require('./schedule');
const { validateRecipients, validateInternalRecipients, parseRecipients } = require('./recipients');
const db = require('./db');

// Organizations de una suscripción (las anteriores a "varias Organizations"
// solo tienen organization).
function subscriptionOrganizations(subscription) {
  return subscription.organizations && subscription.organizations.length ? subscription.organizations : [subscription.organization];
}

// Destinatarios de un envío agrupado:
// - 1 suscripción: es el reporte de un cliente -> dominios globales + los
//   permitidos de sus Organizations (igual que antes por suscripción).
// - 2 o más: el correo mezcla datos de varios clientes -> solo internos
//   (spec §10.1).
async function validateGroupRecipients(list, subscriptions) {
  if (subscriptions.length === 1) {
    const domains = await db.getOrganizationsDomains(subscriptionOrganizations(subscriptions[0]).map((o) => o.id));
    return validateRecipients(list, domains);
  }
  return validateInternalRecipients(list);
}

// Valida el payload de un envío agrupado y lo normaliza al shape de
// lib/db.js. requireRecipients: false para vista previa / prueba.
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

  let recipients = parseRecipients(body.recipients);
  if (requireRecipients && subscriptions.length) {
    const check = await validateGroupRecipients(body.recipients, subscriptions);
    recipients = check.recipients;
    errors.push(...check.errors);
  }

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
      skipIfEmpty: Boolean(body.skipIfEmpty),
    },
  };
}

module.exports = { validateGroupInput, validateGroupRecipients, subscriptionOrganizations };
