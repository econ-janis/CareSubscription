// El JQL de la suscripción es una plantilla: {organization} se reemplaza
// por el nombre de la Organization entre comillas (escapando " y \).
const PLACEHOLDER = '{organization}';
const DEFAULT_JQL = 'project = JCS AND Organizations = {organization} AND created >= startOfDay(-3M) ORDER BY created DESC';

function quoteJqlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function resolveJql(template, organizationName) {
  return String(template).split(PLACEHOLDER).join(quoteJqlString(organizationName));
}

function hasPlaceholder(template) {
  return String(template).includes(PLACEHOLDER);
}

module.exports = { PLACEHOLDER, DEFAULT_JQL, resolveJql, hasPlaceholder, quoteJqlString };
