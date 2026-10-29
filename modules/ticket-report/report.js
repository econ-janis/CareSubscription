const fs = require('node:fs');
const path = require('node:path');
const { searchAll } = require('../../lib/jira');
const { fetchLogo } = require('../../lib/logo');
const { resolveJql } = require('./jql');
const { loadStatusConfig } = require('./statuses');
const { aggregate } = require('./aggregate');

// Piezas comunes al reporte individual y al envío agrupado: consulta a
// Jira + agregación, logos y recursos de marca.
const BRAND_DIR = path.join(__dirname, '..', '..', 'assets', 'brand');
const JANIS_ISO = fs.readFileSync(path.join(BRAND_DIR, 'janis-iso.png'));
const JANIS_LOGO = fs.readFileSync(path.join(BRAND_DIR, 'janis-logo.png'));
const JANIS_LOGO_DARK = fs.readFileSync(path.join(BRAND_DIR, 'janis-logo-dark.png'));
// assignee: solo para agrupar por Responsable en el preaviso de Slack (el
// correo no lo muestra).
const FIELDS = ['summary', 'status', 'created', 'assignee'];

// Organizations de la suscripción [{ id, name, logoUrl }]; las anteriores a
// "varias Organizations" solo tienen organization + config.logoUrl.
function organizationsOf(subscription) {
  if (Array.isArray(subscription.organizations) && subscription.organizations.length) return subscription.organizations;
  return [{ ...subscription.organization, logoUrl: (subscription.config && subscription.config.logoUrl) || '' }];
}

// Consulta Jira con el JQL de la suscripción y devuelve el reporte en la
// forma que se guarda en el snapshot (lo mínimo que muestra el correo).
async function fetchReport(subscription, language, warnings) {
  const jql = resolveJql(subscription.config.jql, organizationsOf(subscription).map((o) => o.name));
  const issues = await searchAll(jql, FIELDS);
  const report = aggregate(issues, loadStatusConfig(), language, {
    onUnknownStatus: (name) => {
      console.warn(`[ticket-report] estado de Jira sin mapear en config/statuses.json: "${name}" (suscripción ${subscription.id ?? 'sin guardar'})`);
      warnings.push(`Estado sin mapear: ${name}`);
    },
  });
  return {
    total: report.total,
    rows: report.rows,
    segments: report.segments,
    openTickets: report.openTickets.map(({ key, summary, status, assignee }) => ({ key, summary, status, assignee })),
  };
}

// Logo validado de la Organization o, si no hay / no carga, el isotipo
// de Janis (con advertencia). fallback: true si se usó el isotipo.
async function resolveLogo(logoUrl, warnings) {
  if (logoUrl) {
    try {
      return { ...(await fetchLogo(logoUrl)), fallback: false };
    } catch (error) {
      console.warn(`[ticket-report] logo inválido (${logoUrl}): ${error.message}`);
      warnings.push(`Logo no disponible, se usó el isotipo de Janis: ${error.message}`);
    }
  }
  return { buffer: JANIS_ISO, contentType: 'image/png', fallback: true };
}

module.exports = { fetchReport, resolveLogo, organizationsOf, FIELDS, JANIS_ISO, JANIS_LOGO, JANIS_LOGO_DARK };
