const { getModule } = require('../modules');
const { LANGUAGES } = require('../modules/ticket-report/i18n');
const { validateSchedule } = require('./schedule');
const { validateRecipients } = require('./recipients');
const { listOrganizations } = require('./jira');
const { getOrganizationDomains } = require('./db');

// Valida el payload de la UI y lo normaliza al shape que guarda lib/db.js.
// checkRemote: valida contra Jira (JQL, Organization existente) y el logo.
// requireRecipients: false para vista previa / prueba (no usan la lista).
async function validateSubscriptionInput(body = {}, { checkRemote = true, requireRecipients = true } = {}) {
  const errors = [];
  const warnings = [];

  const module = getModule(String(body.module || 'ticket-report'));
  if (!module) return { errors: ['Módulo desconocido'], warnings };

  const title = String(body.title || '').trim();
  if (!title) errors.push('El título es obligatorio');
  if (title.length > 200) errors.push('El título no puede superar 200 caracteres');

  let organization = null;
  const organizationId = String((body.organization && body.organization.id) || '').trim();
  if (!organizationId) {
    errors.push('Elegí una Organization');
  } else {
    // El nombre se toma de la lista de Jira (no del cliente) porque es lo
    // que se inyecta en el JQL.
    const { organizations } = await listOrganizations();
    organization = organizations.find((o) => o.id === organizationId) || null;
    if (!organization) errors.push('La Organization no existe en Jira (probá refrescar la lista)');
  }

  const language = LANGUAGES.includes(body.language) ? body.language : 'es';
  const subject = String(body.subject || '').trim().slice(0, 250);

  const { schedule, errors: scheduleErrors } = validateSchedule(body.schedule);
  errors.push(...scheduleErrors);

  const organizationDomains = organization ? await getOrganizationDomains(organization.id) : [];
  const { recipients, errors: recipientErrors } = validateRecipients(body.recipients, organizationDomains);
  if (requireRecipients) errors.push(...recipientErrors);

  const configResult = await module.validateConfig(body.config, { organization, checkRemote: checkRemote && Boolean(organization) });
  errors.push(...configResult.errors);
  warnings.push(...configResult.warnings);

  return {
    errors,
    warnings,
    data: {
      module: module.id,
      title,
      organization,
      config: configResult.config,
      recipients,
      subject,
      schedule,
      language,
      active: body.active !== false,
    },
  };
}

module.exports = { validateSubscriptionInput };
