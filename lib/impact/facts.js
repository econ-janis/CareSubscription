const { normalizeName, resolveStatus } = require('../../modules/ticket-report/statuses');

// Impacto Care: de cada ticket de Jira se guardan SOLO métricas (fechas,
// Organizations, SLA y si se escaló). Nunca resumen, descripción,
// comentarios ni personas: los comentarios se leen en memoria para ubicar la
// primera respuesta real y se descartan (ISO 27001 + GDPR).

// ¿El autor del comentario es un agente de Care? Se compara el nombre
// visible con la lista configurada (ej. "Mauricio" coincide con "Mauricio
// Oruezabal"), sin mayúsculas ni tildes, y nunca con cuentas de clientes.
function isAgent(author, agentNames) {
  if (!author || author.accountType === 'customer' || author.accountType === 'app') return false;
  const name = normalizeName(author.displayName);
  if (!name) return false;
  return agentNames.some((agent) => {
    const wanted = normalizeName(agent);
    return wanted && (name === wanted || name.startsWith(`${wanted} `));
  });
}

// Primera respuesta real: el primer comentario público de un agente de Care
// después del primer comentario del ticket (la respuesta automática "en
// breve un Agente tomará este caso…", que no es de un agente y por eso no
// cuenta). Se ignoran las notas internas y los comentarios del cliente. Si
// el primer comentario ya es de un agente (tickets anteriores a la
// automatización), cuenta ese.
function firstAgentResponse(comments, agentNames) {
  const sorted = [...(comments || [])].sort((a, b) => String(a.created).localeCompare(String(b.created)));
  const first = sorted.find((comment) => comment.jsdPublic !== false && isAgent(comment.author, agentNames));
  return first ? first.created : null;
}

// SLA de Jira (ej. "Time to resolution"): ciclo completado más reciente o el
// que está en curso. breached = se venció en algún ciclo.
function slaOf(value) {
  if (!value || typeof value !== 'object') return { breached: null, elapsedMs: null, goalMs: null };
  const cycles = [...(value.completedCycles || []), ...(value.ongoingCycle ? [value.ongoingCycle] : [])];
  if (!cycles.length) return { breached: null, elapsedMs: null, goalMs: null };
  const last = cycles[cycles.length - 1];
  return {
    breached: cycles.some((c) => c.breached === true),
    elapsedMs: last.elapsedTime && Number.isFinite(last.elapsedTime.millis) ? last.elapsedTime.millis : null,
    goalMs: last.goalDuration && Number.isFinite(last.goalDuration.millis) ? last.goalDuration.millis : null,
  };
}

// ¿Se escaló a desarrollo? = tiene un enlace a un ticket de los proyectos de
// escalamiento (por defecto HDI).
function isEscalated(issueLinks, escalationProjects) {
  const prefixes = escalationProjects.map((p) => `${String(p).trim().toUpperCase()}-`).filter((p) => p.length > 1);
  return (issueLinks || []).some((link) => {
    const other = link.inwardIssue || link.outwardIssue;
    return other && prefixes.some((prefix) => String(other.key || '').toUpperCase().startsWith(prefix));
  });
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// issue: respuesta de /search/jql con los campos pedidos en sync.js.
// options: { fieldIds: { organizations, slaResolution }, agentNames, escalationProjects, statusConfig, comments }
function extractFacts(issue, { fieldIds, agentNames, escalationProjects, statusConfig, comments }) {
  const fields = issue.fields || {};
  const status = fields.status || {};
  const category = status.statusCategory ? status.statusCategory.key : '';
  const known = statusConfig ? resolveStatus(statusConfig, status.name) : null;
  let state = 'open';
  if (known && known.key === 'cancelled') state = 'cancelled';
  else if (category === 'done' || (known && known.key === 'resolved')) state = 'resolved';

  const sla = slaOf(fieldIds.slaResolution ? fields[fieldIds.slaResolution] : null);
  const organizations = (fieldIds.organizations && fields[fieldIds.organizations]) || [];
  const allComments = comments || (fields.comment && fields.comment.comments) || [];

  return {
    issueKey: issue.key,
    orgIds: organizations.map((o) => String(o.id)),
    createdAt: toIso(fields.created),
    resolvedAt: state === 'open' ? null : toIso(fields.resolutiondate || fields.statuscategorychangedate),
    state,
    firstResponseAt: toIso(firstAgentResponse(allComments, agentNames)),
    jiraSlaBreached: sla.breached,
    jiraSlaElapsedMs: sla.elapsedMs,
    jiraSlaGoalMs: sla.goalMs,
    escalated: isEscalated(fields.issuelinks, escalationProjects),
  };
}

// ¿Hace falta pedir más comentarios? La búsqueda puede traerlos truncados.
function commentsTruncated(issue) {
  const c = issue.fields && issue.fields.comment;
  return Boolean(c && Number(c.total) > (c.comments || []).length);
}

module.exports = { extractFacts, firstAgentResponse, isAgent, slaOf, isEscalated, commentsTruncated };
