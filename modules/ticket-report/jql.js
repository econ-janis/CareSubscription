// El JQL de la suscripción se usa tal cual en Jira. Opcionalmente puede
// incluir comodines que se reemplazan por las Organizations elegidas, entre
// comillas (escapando " y \):
//   {organization}  -> la primera: "A"
//   {organizations} -> todas, para usar con IN: ("A", "B")
// Si el JQL ya filtra por el campo Organizations de Jira, las Organizations
// elegidas no lo afectan.
const PLACEHOLDER = '{organization}';
const PLACEHOLDER_ALL = '{organizations}';
const DEFAULT_JQL = 'project = JCS AND Organizations = {organization} AND created >= startOfDay(-3M) ORDER BY created DESC';

function quoteJqlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// names: nombre de la Organization o lista de nombres (la primera es la principal).
function resolveJql(template, names) {
  const list = (Array.isArray(names) ? names : [names]).filter((n) => n !== undefined && n !== null);
  const all = `(${list.map(quoteJqlString).join(', ')})`;
  return String(template)
    .split(PLACEHOLDER_ALL).join(all)
    .split(PLACEHOLDER).join(quoteJqlString(list[0] ?? ''));
}

function hasPlaceholder(template) {
  return String(template).includes(PLACEHOLDER) || String(template).includes(PLACEHOLDER_ALL);
}

// Campo Organizations de JSM usado como condición (=, !=, ~, IN, NOT IN,
// IS, ...). Los nombres de campo en JQL no distinguen mayúsculas.
const ORGANIZATIONS_CLAUSE = /\borganizations\s*(=|!=|!~|~|\bin\b|\bnot\s+in\b|\bis\b)/i;

// true si el JQL filtra por Organization (por el campo de Jira o con
// {organization}). Si no, el reporte traería tickets de todos los clientes.
function filtersByOrganization(template) {
  return hasPlaceholder(template) || ORGANIZATIONS_CLAUSE.test(String(template));
}

module.exports = { PLACEHOLDER, PLACEHOLDER_ALL, DEFAULT_JQL, resolveJql, hasPlaceholder, filtersByOrganization, quoteJqlString };
