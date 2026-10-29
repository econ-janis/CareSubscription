const { getModule } = require('../modules');
const { sendMail } = require('./mailer');
const { validateRecipients } = require('./recipients');
const { validateGroupRecipients } = require('./groups');
const { JiraError } = require('./jira');
const { postMessage, slackChannel } = require('./slack');
const { nextSlot } = require('./schedule');
const { isMailConfigured } = require('./mailer');
const { appUrl } = require('./app-url');
const db = require('./db');

// Ejecuta un envío de una suscripción y lo registra en el historial.
// kind: 'scheduled' (dispatcher), 'test' (solo al usuario que configura).
// Devuelve { result: 'ok'|'skipped'|'error', transient, error }.
class PermanentError extends Error {}

function isTransient(error) {
  if (error instanceof PermanentError) return false;
  if (error instanceof JiraError) return error.transient;
  const code = Number(error.responseCode || 0);
  return !(code >= 500 && code < 600);
}

function isInvalidJql(error) {
  return error instanceof JiraError && error.status === 400;
}

async function notifyCreator(subscription, message) {
  try {
    await sendMail({
      to: [subscription.createdBy],
      subject: `[CareSubscription] Error en la suscripción "${subscription.title}"`,
      text: `La suscripción "${subscription.title}" (${(subscription.organizations || [subscription.organization]).map((o) => o.name).join(', ')}) quedó marcada con error y no se pudo enviar.\n\nDetalle: ${message}\n\nRevisá la configuración (por ejemplo, si la Organization fue renombrada en Jira) y guardala de nuevo.`,
    });
  } catch (error) {
    console.error(`[runner] no se pudo notificar al creador de la suscripción ${subscription.id}`, error);
  }
}

// Una prueba desde el formulario puede ser de una suscripción todavía no
// guardada (sin id): en ese caso no hay historial que registrar.
async function record(history) {
  if (history.subscriptionId) await db.addHistory(history);
}

async function runSubscription(subscription, { kind = 'scheduled', slotAt = null, triggeredBy = 'cron', testRecipient = null, now = new Date() } = {}) {
  const module = getModule(subscription.module);
  const history = { subscriptionId: subscription.id, kind, slotAt, triggeredBy, recipients: [], warnings: [] };

  try {
    if (!module) throw new PermanentError(`Módulo desconocido: ${subscription.module}`);

    let recipients;
    if (kind === 'test') {
      recipients = [testRecipient];
    } else {
      // Se re-validan al enviar: los dominios permitidos pueden haber cambiado.
      const domains = await db.getOrganizationsDomains((subscription.organizations || [subscription.organization]).map((o) => o.id));
      const check = validateRecipients(subscription.recipients, domains);
      if (check.errors.length) throw new PermanentError(check.errors.join(' · '));
      recipients = check.recipients;
    }
    history.recipients = recipients;

    const built = await module.build(subscription, { now, mode: 'email' });
    history.ticketCount = built.itemCount;
    history.warnings = built.warnings;

    if (kind === 'scheduled' && built.empty && built.skipIfEmpty) {
      await record({ ...history, result: 'skipped', error: 'Sin datos en el período (configurada para no enviar vacío)' });
      return { result: 'skipped' };
    }

    // Mismo asunto en pruebas y envíos programados: la prueba queda
    // identificada en el historial (kind 'test'), no en el correo.
    await sendMail({ to: recipients, subject: built.subject, html: built.html, text: built.text, attachments: built.attachments, language: subscription.language });

    await record({ ...history, result: 'ok', snapshot: built.snapshot });
    if (kind === 'scheduled' && subscription.status === 'error') await db.setSubscriptionStatus(subscription.id, 'ok');
    return { result: 'ok' };
  } catch (error) {
    const message = isInvalidJql(error) ? `JQL inválido: ${error.message}` : error.message;
    console.error(`[runner] suscripción ${subscription.id} (${kind}) falló: ${message}`);
    await record({ ...history, result: 'error', error: message });

    // §8: JQL que deja de ser válido -> suscripción marcada con error y aviso al creador (una vez).
    if (kind === 'scheduled' && isInvalidJql(error)) {
      if (subscription.status !== 'error') await notifyCreator(subscription, message);
      await db.setSubscriptionStatus(subscription.id, 'error', message);
    }
    return { result: 'error', transient: isTransient(error), error: message };
  }
}

// Próximo envío (el más cercano) de los envíos agrupados activos que
// incluyen la suscripción: { at, timezone } o null.
async function nextGroupSendFor(subscriptionId, now = new Date()) {
  if (!isMailConfigured()) return null;
  const groups = (await db.listActiveGroups()).filter((g) => g.subscriptionIds.includes(subscriptionId));
  return groups
    .map((g) => ({ at: nextSlot(g.schedule, now), timezone: g.schedule.timezone }))
    .filter((n) => n.at)
    .sort((a, b) => a.at - b.at)[0] || null;
}

// Preaviso en Slack (SLACK_CHANNEL; #care-test por defecto, después #care-talks) para que Customer Care se ponga al día
// antes del envío a Consulting. Consulta Jira en el momento, publica el
// mensaje (tickets abiertos por Responsable) y lo registra en el historial
// (kind 'slack', con su snapshot).
async function runSlackPreview(subscription, { triggeredBy, now = new Date() } = {}) {
  const module = getModule(subscription.module);
  const channel = slackChannel();
  const history = { subscriptionId: subscription.id, kind: 'slack', triggeredBy, recipients: [channel], warnings: [] };

  try {
    if (!module || !module.slackComment) throw new PermanentError('Este módulo no tiene preaviso en Slack');

    const built = await module.build(subscription, { now, mode: 'email' });
    history.ticketCount = built.itemCount;
    history.warnings = built.warnings;

    // Ej. "lun 02-11, 10:00 a. m.": el próximo envío agrupado activo que la incluye.
    const next = await nextGroupSendFor(subscription.id, now);
    const nextSendLabel = next
      ? next.at.toLocaleString('es-AR', { timeZone: next.timezone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';

    await postMessage(module.slackComment(built.snapshot, { organizationName: (subscription.organizations || [subscription.organization]).map((o) => o.name).join(' · '), nextSendLabel, actor: triggeredBy }), channel);
    await record({ ...history, result: 'ok', snapshot: built.snapshot });
    return { result: 'ok', channel };
  } catch (error) {
    const message = isInvalidJql(error) ? `JQL inválido: ${error.message}` : error.message;
    console.error(`[runner] preaviso Slack de la suscripción ${subscription.id} falló: ${message}`);
    await record({ ...history, result: 'error', error: message });
    return { result: 'error', error: message };
  }
}

// Fecha local YYYY-MM-DD en la zona horaria del envío (la usa la landing).
function localDate(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function landingUrl(group, now) {
  const base = appUrl();
  return base && group.id ? `${base}/reportes/${group.id}/${localDate(now, group.schedule.timezone)}` : '';
}

// Envío agrupado (spec §10), único lugar donde se configura un envío:
// - 1 suscripción: reporte individual; destinatarios de los dominios de sus
//   Organizations.
// - 2 o más: una sección por suscripción; solo destinatarios internos.
// Los destinatarios se re-validan al enviar. En el agrupado, si una
// Organization falla sale igual con su sección marcada; si fallan todas no
// se envía (probable caída de Jira: transitorio, se reintenta).
async function runGroup(group, { kind = 'scheduled', slotAt = null, triggeredBy = 'cron', testRecipient = null, now = new Date() } = {}) {
  const module = getModule('ticket-report');
  const history = { groupId: group.id, kind, slotAt, triggeredBy, recipients: [], warnings: [] };

  try {
    const subscriptions = await db.getSubscriptionsByIds(group.subscriptionIds);
    if (!subscriptions.length) throw new PermanentError('El envío agrupado no tiene suscripciones (¿se borraron?)');

    let recipients;
    if (kind === 'test') {
      recipients = [testRecipient];
    } else {
      const check = await validateGroupRecipients(group.recipients, subscriptions);
      if (check.errors.length) throw new PermanentError(check.errors.join(' · '));
      recipients = check.recipients;
    }
    history.recipients = recipients;

    const built = await module.buildGroup(group, subscriptions, { now, mode: 'email', webUrl: landingUrl(group, now) });
    history.ticketCount = built.itemCount;
    history.warnings = built.warnings;
    if (built.failedSections === subscriptions.length) {
      const error = new Error('No se pudo obtener la información de ninguna Organization');
      error.transientGroup = true;
      throw error;
    }
    if (kind === 'scheduled' && group.skipIfEmpty && built.itemCount === 0) {
      if (group.id) await db.addHistory({ ...history, result: 'skipped', error: 'Sin datos en el período (configurado para no enviar vacío)' });
      return { result: 'skipped' };
    }

    await sendMail({ to: recipients, subject: built.subject, html: built.html, text: built.text, attachments: built.attachments, language: group.language });
    if (group.id) await db.addHistory({ ...history, result: 'ok', snapshot: built.snapshot });
    return { result: 'ok' };
  } catch (error) {
    console.error(`[runner] envío agrupado ${group.id} (${kind}) falló: ${error.message}`);
    if (group.id) await db.addHistory({ ...history, result: 'error', error: error.message });
    return { result: 'error', transient: error.transientGroup || isTransient(error), error: error.message };
  }
}

module.exports = { runSubscription, runSlackPreview, runGroup, appUrl, nextGroupSendFor };
