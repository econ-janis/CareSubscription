// Impacto Care: métricas semanales (lunes a domingo, en la zona horaria
// configurada) a partir de ticket_facts. Todo por equipo: nada por persona.
//
// Métricas por semana (total y por cliente PMC):
// - created / resolved / cancelled: tickets creados, resueltos y cancelados en la semana.
// - backlog: tickets abiertos al cierre de la semana.
// - firstResponseH: mediana de horas hasta la primera respuesta real de un
//   agente (tickets creados en la semana).
// - resolutionH: mediana de horas de creación a resolución (resueltos en la semana).
// - jiraSlaPct: % de resueltos dentro del SLA "Time to resolution" de Jira (A).
// - contractFirstResponsePct / contractResolutionPct: % dentro de las metas
//   del nivel PMC del cliente (B), en horas corridas.
// - noEscalationPct: % de resueltos sin escalar a desarrollo (HDI).
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const SUMMARY_WEEKS = 4;
const BEFORE_AFTER_WEEKS = 12;
const OLD_TICKET_DAYS = 30;

// ---- Fechas por semana ----

const formatters = new Map();
function localParts(iso, timezone) {
  if (!formatters.has(timezone)) {
    formatters.set(timezone, new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }));
  }
  const parts = Object.fromEntries(formatters.get(timezone).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) };
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Lunes (YYYY-MM-DD, hora local) de la semana del instante.
function weekOf(iso, timezone) {
  const { date, weekday } = localParts(iso, timezone);
  return addDays(date, -weekday);
}

// Las últimas `count` semanas hasta la actual (incluida, que puede estar en curso).
function weekList(nowIso, timezone, count) {
  const current = weekOf(nowIso, timezone);
  return Array.from({ length: count }, (_, i) => addDays(current, -7 * (count - 1 - i)));
}

// ---- Estadística ----

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(ok, total) {
  return total ? (ok * 100) / total : null;
}

const round = (value, digits = 1) => (value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const hoursBetween = (from, to) => (new Date(to) - new Date(from)) / HOUR;

// ---- Agregación ----

// Pre-calcula la semana de cada fecha de un ticket.
function annotate(fact, timezone) {
  return {
    ...fact,
    createdWeek: weekOf(fact.createdAt, timezone),
    resolvedWeek: fact.resolvedAt ? weekOf(fact.resolvedAt, timezone) : null,
  };
}

// Métricas de un conjunto de tickets para un rango de semanas [from, to]
// (inclusive). level: { firstResponseHours, resolutionHours } o un
// resolver por ticket (para el total, cada ticket usa el nivel de su cliente).
function bucketStats(tickets, from, to, levelOf, nowIso) {
  const inRange = (week) => week !== null && week >= from && week <= to;
  const created = tickets.filter((t) => inRange(t.createdWeek));
  const resolved = tickets.filter((t) => t.state === 'resolved' && inRange(t.resolvedWeek));
  const cancelled = tickets.filter((t) => t.state === 'cancelled' && inRange(t.resolvedWeek));
  const backlog = tickets.filter((t) => t.createdWeek <= to && (t.state === 'open' || !t.resolvedWeek || t.resolvedWeek > to)).length;

  const responded = created.filter((t) => t.firstResponseAt);
  const withSla = resolved.filter((t) => t.jiraSlaBreached !== null && t.jiraSlaBreached !== undefined);

  // SLA de contrato (B): primera respuesta (los que todavía no tienen
  // respuesta y ya pasaron la meta cuentan como fuera de SLA) y resolución.
  let frOk = 0;
  let frTotal = 0;
  for (const t of created) {
    const goal = levelOf(t).firstResponseHours;
    if (!Number.isFinite(goal)) continue;
    if (t.firstResponseAt) {
      frTotal++;
      if (hoursBetween(t.createdAt, t.firstResponseAt) <= goal) frOk++;
    } else if (hoursBetween(t.createdAt, nowIso) > goal) {
      frTotal++;
    }
  }
  let resOk = 0;
  let resTotal = 0;
  for (const t of resolved) {
    const goal = levelOf(t).resolutionHours;
    if (!Number.isFinite(goal)) continue;
    resTotal++;
    if (hoursBetween(t.createdAt, t.resolvedAt) <= goal) resOk++;
  }

  return {
    created: created.length,
    resolved: resolved.length,
    cancelled: cancelled.length,
    backlog,
    firstResponseH: round(median(responded.map((t) => hoursBetween(t.createdAt, t.firstResponseAt)))),
    resolutionH: round(median(resolved.map((t) => hoursBetween(t.createdAt, t.resolvedAt)))),
    jiraSlaPct: round(pct(withSla.filter((t) => !t.jiraSlaBreached).length, withSla.length)),
    contractFirstResponsePct: round(pct(frOk, frTotal)),
    contractResolutionPct: round(pct(resOk, resTotal)),
    noEscalationPct: round(pct(resolved.filter((t) => !t.escalated).length, resolved.length)),
  };
}

function series(tickets, weeks, levelOf, nowIso) {
  return weeks.map((week) => ({ week, ...bucketStats(tickets, week, week, levelOf, nowIso) }));
}

// Variación porcentual (null si no hay base).
function change(current, previous) {
  if (current === null || previous === null || previous === undefined || previous === 0) return null;
  return round(((current - previous) * 100) / Math.abs(previous));
}

// ---- Logros de la semana ----

function achievements({ total, clients }) {
  const list = [];
  const complete = total.series.slice(0, -1);
  const last = complete[complete.length - 1];
  if (!last) return list;

  const fourAgo = complete[complete.length - 1 - SUMMARY_WEEKS];
  if (fourAgo && fourAgo.backlog > 0 && last.backlog < fourAgo.backlog) {
    const drop = Math.round(((fourAgo.backlog - last.backlog) * 100) / fourAgo.backlog);
    if (drop >= 10) list.push({ kind: 'backlog', text: `El backlog bajó ${drop} % en las últimas ${SUMMARY_WEEKS} semanas (de ${fourAgo.backlog} a ${last.backlog} tickets abiertos).` });
  }

  const recent = complete.slice(-26);
  const best = Math.max(...recent.map((w) => w.resolved));
  if (last.resolved > 0 && last.resolved === best && recent.length >= 8) {
    list.push({ kind: 'record', text: `Semana récord: ${last.resolved} tickets resueltos, la mejor de las últimas ${recent.length} semanas.` });
  }

  const s = total.summary.current;
  if (s.jiraSlaPct !== null && s.jiraSlaPct >= 95) list.push({ kind: 'sla', text: `${Math.round(s.jiraSlaPct)} % de los tickets resueltos dentro del SLA en las últimas ${SUMMARY_WEEKS} semanas.` });
  if (s.noEscalationPct !== null && s.noEscalationPct >= 80) list.push({ kind: 'care', text: `Care resolvió el ${Math.round(s.noEscalationPct)} % de los tickets sin escalar a desarrollo.` });
  const frChange = total.summary.change.firstResponseH;
  if (frChange !== null && frChange <= -20) list.push({ kind: 'speed', text: `La primera respuesta es ${Math.abs(Math.round(frChange))} % más rápida que en las ${SUMMARY_WEEKS} semanas anteriores.` });

  const clean = clients.filter((c) => c.openOlderThan30 === 0 && c.totalTickets > 0).map((c) => c.name);
  if (clean.length) list.push({ kind: 'clean', text: `Sin tickets abiertos de más de ${OLD_TICKET_DAYS} días: ${clean.join(', ')}.` });
  return list;
}

// ---- Punto de entrada ----

// facts: ticket_facts de las Organizations PMC. clients: activos, con
// levelId. levels: [{ id, firstResponseHours, resolutionHours }].
function computeImpact({ facts, clients, levels, timezone, weeks: weekCount = 104, now = new Date() }) {
  const nowIso = new Date(now).toISOString();
  const weeks = weekList(nowIso, timezone, weekCount);
  const tickets = facts.map((f) => annotate(f, timezone));
  const levelById = new Map(levels.map((l) => [l.id, l]));
  const noLevel = { firstResponseHours: null, resolutionHours: null };
  const clientLevel = (client) => levelById.get(client.levelId) || noLevel;
  const clientsById = new Map(clients.map((c) => [c.organizationId, c]));
  const ticketLevel = (t) => {
    const client = t.orgIds.map((id) => clientsById.get(id)).find(Boolean);
    return client ? clientLevel(client) : noLevel;
  };

  // Resumen: últimas 4 semanas completas vs las 4 anteriores.
  const lastComplete = weeks[weeks.length - 2];
  const summaryRange = (offset) => [addDays(lastComplete, -7 * (SUMMARY_WEEKS * (offset + 1) - 1)), addDays(lastComplete, -7 * SUMMARY_WEEKS * offset)];
  const summaryOf = (subset, levelOf) => {
    const [cFrom, cTo] = summaryRange(0);
    const [pFrom, pTo] = summaryRange(1);
    const current = bucketStats(subset, cFrom, cTo, levelOf, nowIso);
    const previous = bucketStats(subset, pFrom, pTo, levelOf, nowIso);
    const changes = {};
    for (const key of Object.keys(current)) changes[key] = change(current[key], previous[key]);
    return { from: cFrom, to: addDays(cTo, 6), current, previous, change: changes };
  };

  const openOlderThan = (subset) => subset.filter((t) => t.state === 'open' && new Date(nowIso) - new Date(t.createdAt) > OLD_TICKET_DAYS * DAY).length;

  const total = {
    series: series(tickets, weeks, ticketLevel, nowIso),
    summary: summaryOf(tickets, ticketLevel),
    openNow: tickets.filter((t) => t.state === 'open').length,
    openOlderThan30: openOlderThan(tickets),
  };

  const clientRows = clients.map((client) => {
    const subset = tickets.filter((t) => t.orgIds.includes(client.organizationId));
    const levelOf = () => clientLevel(client);
    const clientSeries = series(subset, weeks, levelOf, nowIso);
    const level = levelById.get(client.levelId) || null;

    // Antes y después del alta en PMC: 12 semanas antes del alta vs las
    // últimas 12 semanas completas (solo si hay datos de antes).
    let beforeAfter = null;
    if (client.pmcSince) {
      const sinceWeek = weekOf(`${client.pmcSince}T12:00:00Z`, timezone);
      const before = bucketStats(subset, addDays(sinceWeek, -7 * BEFORE_AFTER_WEEKS), addDays(sinceWeek, -7), levelOf, nowIso);
      const after = bucketStats(subset, addDays(lastComplete, -7 * (BEFORE_AFTER_WEEKS - 1)), lastComplete, levelOf, nowIso);
      const hasBefore = subset.some((t) => t.createdWeek < sinceWeek);
      beforeAfter = hasBefore && sinceWeek <= lastComplete ? { since: client.pmcSince, weeks: BEFORE_AFTER_WEEKS, before, after } : { since: client.pmcSince, weeks: BEFORE_AFTER_WEEKS, before: null, after };
    }

    return {
      organizationId: client.organizationId,
      name: client.organizationName,
      logoUrl: client.logoUrl,
      level: level ? { name: level.name, firstResponseHours: level.firstResponseHours, resolutionHours: level.resolutionHours } : null,
      pmcSince: client.pmcSince,
      totalTickets: subset.length,
      openNow: subset.filter((t) => t.state === 'open').length,
      openOlderThan30: openOlderThan(subset),
      summary: summaryOf(subset, levelOf),
      series: clientSeries,
      beforeAfter,
    };
  });

  return {
    timezone,
    generatedAt: nowIso,
    weeks,
    currentWeekPartial: true,
    total,
    clients: clientRows,
    achievements: achievements({ total, clients: clientRows }),
    definitions: { summaryWeeks: SUMMARY_WEEKS, beforeAfterWeeks: BEFORE_AFTER_WEEKS, oldTicketDays: OLD_TICKET_DAYS },
  };
}

module.exports = { computeImpact, weekOf, weekList, median, bucketStats, addDays };
