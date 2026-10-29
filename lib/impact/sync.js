const jira = require('../jira');
const store = require('./store');
const { extractFacts, firstAgentResponse, commentsTruncated } = require('./facts');
const { loadStatusConfig } = require('../../modules/ticket-report/statuses');

// Sincronización de Jira -> ticket_facts, en partes que entran en una
// función de Vercel (60 s):
// 1. Carga inicial (backfill): todos los tickets del proyecto creados en los
//    últimos `historyDays` días, en orden de creación. Guarda un cursor
//    (fecha) para seguir en la próxima corrida.
// 2. Incremental: los tickets actualizados desde la última corrida completa.
// La dispara el botón "Sincronizar" de Impacto Care y el workflow horario.
const PAGE_SIZE = 50;
const DEFAULT_BUDGET_MS = 40000;
const FIELD_NAMES = { organizations: 'Organizations', slaResolution: 'Time to resolution' };

function jqlString(value) {
  return `"${String(value).replace(/["\\]/g, '')}"`;
}

// Fecha (YYYY-MM-DD) del día anterior al último ticket procesado: el margen
// cubre la zona horaria con la que Jira interpreta la fecha del JQL. Releer
// un día no duplica nada (upsert por clave).
function cursorFrom(createdIso) {
  const date = new Date(createdIso);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

async function resolveFieldIds() {
  const ids = await jira.fieldIdsByName(Object.values(FIELD_NAMES));
  return { organizations: ids[FIELD_NAMES.organizations], slaResolution: ids[FIELD_NAMES.slaResolution] };
}

// Si la búsqueda trajo los comentarios truncados y entre ellos no hay
// respuesta de un agente, se piden los que faltan.
async function commentsFor(issue, agentNames) {
  const first = (issue.fields.comment && issue.fields.comment.comments) || [];
  if (!commentsTruncated(issue) || firstAgentResponse(first, agentNames)) return first;
  const all = [...first];
  let startAt = first.length;
  for (;;) {
    const page = await jira.issueComments(issue.key, { startAt });
    all.push(...(page.comments || []));
    startAt += (page.comments || []).length;
    if (!(page.comments || []).length || startAt >= page.total || firstAgentResponse(all, agentNames)) break;
  }
  return all;
}

async function processPage(issues, context) {
  const facts = [];
  for (const issue of issues) {
    const comments = await commentsFor(issue, context.agentNames);
    facts.push(extractFacts(issue, { ...context, comments }));
  }
  await store.upsertFacts(facts);
  return facts;
}

// Corre una parte de la sincronización. Devuelve el estado y cuántos tickets
// procesó. { reset: true } vuelve a empezar la carga inicial (ej. al cambiar
// los agentes o los proyectos de escalamiento).
async function runSync({ budgetMs = DEFAULT_BUDGET_MS, reset = false, now = Date.now } = {}) {
  const started = now();
  if (!(await store.acquireSyncLock(Math.ceil(budgetMs / 1000) + 30))) {
    return { skipped: true, reason: 'Ya hay una sincronización en curso' };
  }
  try {
    const settings = await store.getSettings();
    const fieldIds = await resolveFieldIds();
    if (!fieldIds.organizations) throw new Error('No se encontró el campo "Organizations" en Jira');
    const context = { fieldIds, agentNames: settings.agents, escalationProjects: settings.escalationProjects, statusConfig: loadStatusConfig() };
    const fields = ['created', 'resolutiondate', 'statuscategorychangedate', 'status', 'issuelinks', 'comment', fieldIds.organizations, fieldIds.slaResolution].filter(Boolean);

    let state = reset ? null : await store.getSyncState();
    if (!state || !state.phase) state = { phase: 'backfill', cursor: null, processed: 0, lastIncrementalAt: null, backfillStartedAt: started };

    const project = jqlString(settings.project || 'JCS');
    let jql;
    if (state.phase === 'backfill') {
      const since = state.cursor ? `created >= ${jqlString(state.cursor)}` : `created >= -${Number(settings.historyDays) || 730}d`;
      jql = `project = ${project} AND ${since} ORDER BY created ASC`;
    } else {
      const minutes = Math.ceil((started - (state.lastIncrementalAt || started - 24 * 3600 * 1000)) / 60000) + 15;
      jql = `project = ${project} AND updated >= -${minutes}m ORDER BY updated ASC`;
    }

    let nextPageToken;
    let processed = 0;
    let finished = false;
    do {
      const page = await jira.searchPage(jql, { fields, maxResults: PAGE_SIZE, nextPageToken });
      const issues = page.issues || [];
      const facts = await processPage(issues, context);
      processed += facts.length;
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
      finished = !nextPageToken;
      if (state.phase === 'backfill' && facts.length) {
        state = { ...state, cursor: cursorFrom(facts[facts.length - 1].createdAt), processed: (state.processed || 0) + facts.length };
        await store.saveSyncState(state);
      }
    } while (!finished && now() - started < budgetMs);

    if (finished) {
      state = { ...state, phase: 'incremental', cursor: null, lastIncrementalAt: started };
      if (!state.backfillDoneAt) state.backfillDoneAt = now();
    }
    state = { ...state, lastRunAt: now() };
    await store.saveSyncState(state);
    return { processed, phase: state.phase, done: finished, state };
  } finally {
    await store.releaseSyncLock();
  }
}

module.exports = { runSync, cursorFrom };
