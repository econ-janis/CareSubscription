const { getModule } = require('../modules');
const { sendMail } = require('./mailer');
const { validateRecipients } = require('./recipients');
const { JiraError } = require('./jira');
const { postMessage, slackChannel } = require('./slack');
const { nextSlot } = require('./schedule');
const { isMailConfigured } = require('./mailer');
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
      text: `La suscripción "${subscription.title}" (${subscription.organization.name}) quedó marcada con error y no se pudo enviar.\n\nDetalle: ${message}\n\nRevisá la configuración (por ejemplo, si la Organization fue renombrada en Jira) y guardala de nuevo.`,
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
      const domains = await db.getOrganizationDomains(subscription.organization.id);
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

    const next = subscription.active && isMailConfigured() ? nextSlot(subscription.schedule, now) : null;
    // Ej. "lun 02-11, 10:00 a. m." en la zona horaria de la suscripción.
    const nextSendLabel = next
      ? next.toLocaleString('es-AR', { timeZone: subscription.schedule.timezone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';

    await postMessage(module.slackComment(built.snapshot, { organizationName: subscription.organization.name, nextSendLabel, actor: triggeredBy }), channel);
    await record({ ...history, result: 'ok', snapshot: built.snapshot });
    return { result: 'ok', channel };
  } catch (error) {
    const message = isInvalidJql(error) ? `JQL inválido: ${error.message}` : error.message;
    console.error(`[runner] preaviso Slack de la suscripción ${subscription.id} falló: ${message}`);
    await record({ ...history, result: 'error', error: message });
    return { result: 'error', error: message };
  }
}

module.exports = { runSubscription, runSlackPreview };
