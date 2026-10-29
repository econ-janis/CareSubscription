const { getModule } = require('../modules');
const { LANGUAGES } = require('../modules/ticket-report/i18n');
const { validateSchedule } = require('./schedule');
const { validateRecipients } = require('./recipients');
const { listOrganizations } = require('./jira');
const { getOrganizationsDomains } = require('./db');

const MAX_ORGANIZATIONS = 10;

// body.organizations: [{ id, logoUrl }]. Compatibilidad: si no viene, se
// arma con body.organization + body.config.logoUrl (formato anterior).
function requestedOrganizations(body) {
  if (Array.isArray(body.organizations)) return body.organizations;
  return [{ id: body.organization && body.organization.id, logoUrl: body.config && body.config.logoUrl }];
}

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

  // Una o más Organizations, cada una con su logo. El nombre se toma de la
  // lista de Jira (no del cliente) porque es lo que se inyecta en el JQL.
  const requested = requestedOrganizations(body)
    .map((o) => ({ id: String((o && o.id) || '').trim(), logoUrl: String((o && o.logoUrl) || '').trim() }))
    .filter((o) => o.id);
  const organizations = [];
  if (!requested.length) {
    errors.push('Elegí una Organization');
  } else if (requested.length > MAX_ORGANIZATIONS) {
    errors.push(`Máximo ${MAX_ORGANIZATIONS} Organizations por suscripción`);
  } else {
    const { organizations: jiraOrganizations } = await listOrganizations();
    for (const item of requested) {
      const found = jiraOrganizations.find((o) => o.id === item.id);
      if (!found) errors.push(`La Organization ${item.id} no existe en Jira (probá refrescar la lista)`);
      else if (organizations.some((o) => o.id === found.id)) errors.push(`La Organization "${found.name}" está repetida`);
      else organizations.push({ id: found.id, name: found.name, logoUrl: item.logoUrl });
    }
  }
  const organization = organizations[0] ? { id: organizations[0].id, name: organizations[0].name } : null;

  const language = LANGUAGES.includes(body.language) ? body.language : 'es';
  const subject = String(body.subject || '').trim().slice(0, 250);

  const { schedule, errors: scheduleErrors } = validateSchedule(body.schedule);
  errors.push(...scheduleErrors);

  // Se aceptan los dominios de cualquiera de las Organizations de la suscripción.
  const organizationDomains = await getOrganizationsDomains(organizations.map((o) => o.id));
  const { recipients, errors: recipientErrors } = validateRecipients(body.recipients, organizationDomains);
  if (requireRecipients) errors.push(...recipientErrors);

  // config.logoUrl = logo de la primera Organization (compatibilidad).
  const configInput = { ...(body.config || {}), logoUrl: organizations[0] ? organizations[0].logoUrl : '' };
  const configResult = await module.validateConfig(configInput, { organizations, checkRemote: checkRemote && organizations.length > 0 });
  errors.push(...configResult.errors);
  warnings.push(...configResult.warnings);

  return {
    errors,
    warnings,
    data: {
      module: module.id,
      title,
      organization,
      organizations,
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
