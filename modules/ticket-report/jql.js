// El JQL de la suscripción se usa tal cual en Jira. Opcionalmente puede
// incluir {organization}, que se reemplaza por el nombre de la Organization
// elegida entre comillas (escapando " y \); si el JQL ya filtra por el campo
// Organizations de Jira, la Organization elegida no lo afecta.
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

// Campo Organizations de JSM usado como condición (=, !=, ~, IN, NOT IN,
// IS, ...). Los nombres de campo en JQL no distinguen mayúsculas.
const ORGANIZATIONS_CLAUSE = /\borganizations\s*(=|!=|!~|~|\bin\b|\bnot\s+in\b|\bis\b)/i;

// true si el JQL filtra por Organization (por el campo de Jira o con
// {organization}). Si no, el reporte traería tickets de todos los clientes.
function filtersByOrganization(template) {
  return hasPlaceholder(template) || ORGANIZATIONS_CLAUSE.test(String(template));
}

module.exports = { PLACEHOLDER, DEFAULT_JQL, resolveJql, hasPlaceholder, filtersByOrganization, quoteJqlString };
