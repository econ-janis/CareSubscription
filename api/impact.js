const { requireUser } = require('../lib/auth');
const { listOrganizations, searchPage, fieldIdsByName } = require('../lib/jira');
const { fetchLogo } = require('../lib/logo');
const store = require('../lib/impact/store');
const { runSync } = require('../lib/impact/sync');
const { computeImpact } = require('../lib/impact/metrics');
const db = require('../lib/db');
const { sendJson, readBody, handleError, HttpError, isAuthorizedCron } = require('../lib/http');

// Impacto Care y Clientes PMC.
// GET    /api/impact?view=dashboard[&weeks=26]       -> métricas semanales + estado de la sincronización
// GET    /api/impact?view=config                     -> ajustes, niveles y clientes PMC
// GET    /api/impact?view=suggestions                -> Organizations con tickets "Cuenta Janis: PMC" sin configurar
// PUT    /api/impact?view=settings                   -> agentes de Care, proyectos de escalamiento, zona horaria
// POST   /api/impact?view=levels                     -> crear / modificar nivel { id?, name, firstResponseHours, resolutionHours }
// DELETE /api/impact?view=levels&id=N
// PUT    /api/impact?view=clients                    -> crear / modificar cliente { organizationId, levelId, pmcSince, logoUrl, active }
// DELETE /api/impact?view=clients&id=<orgId>
// POST   /api/impact?action=sync[&reset=1]           -> una parte de la sincronización con Jira (sesión o CRON_SECRET)
const MAX_AGENTS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function hours(value, field) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 10000) throw new HttpError(400, `${field}: ingresa una cantidad de horas válida`);
  return number;
}

function cleanList(values, max) {
  return [...new Set((Array.isArray(values) ? values : String(values || '').split(/[,\n]/)).map((v) => String(v).trim()).filter(Boolean))].slice(0, max);
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('es', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

async function dashboard(query) {
  const [settings, levels, clients, syncState, factsInfo] = await Promise.all([
    store.getSettings(), store.listLevels(), store.listClients(), store.getSyncState(), store.factsSummary(),
  ]);
  const active = clients.filter((c) => c.active);
  const weeks = Math.min(104, Math.max(4, Number(query.weeks) || 104));
  const since = new Date(Date.now() - (weeks + 60) * 7 * 24 * 3600 * 1000).toISOString();
  const facts = await store.listFacts(active.map((c) => c.organizationId), since);
  return {
    impact: computeImpact({ facts, clients: active, levels, timezone: settings.timezone, weeks }),
    sync: { state: syncState, facts: factsInfo },
  };
}

// Organizations con tickets marcados "Cuenta Janis: PMC" en los últimos 90
// días que todavía no están configuradas como cliente PMC.
async function suggestions() {
  const ids = await fieldIdsByName(['Organizations', 'Cuenta Janis']);
  if (!ids.Organizations || !ids['Cuenta Janis']) return { suggestions: [] };
  const settings = await store.getSettings();
  const configured = new Set((await store.listClients()).map((c) => c.organizationId));
  const counts = new Map();
  let nextPageToken;
  let pages = 0;
  do {
    const page = await searchPage(`project = "${settings.project}" AND "Cuenta Janis" ~ "PMC" AND created >= -90d`, { fields: [ids.Organizations], maxResults: 100, nextPageToken });
    for (const issue of page.issues || []) {
      for (const org of issue.fields[ids.Organizations] || []) {
        const id = String(org.id);
        if (configured.has(id)) continue;
        const entry = counts.get(id) || { organizationId: id, organizationName: org.name, tickets: 0 };
        entry.tickets++;
        counts.set(id, entry);
      }
    }
    nextPageToken = page.isLast ? undefined : page.nextPageToken;
    pages++;
  } while (nextPageToken && pages < 10);
  return { suggestions: [...counts.values()].sort((a, b) => b.tickets - a.tickets) };
}

async function saveClient(body, user) {
  const organizationId = String(body.organizationId || '');
  const { organizations } = await listOrganizations();
  const organization = organizations.find((o) => o.id === organizationId);
  if (!organization) throw new HttpError(400, 'Elige una Organization de Jira');

  const levels = await store.listLevels();
  const levelId = body.levelId ? Number(body.levelId) : null;
  if (levelId && !levels.some((l) => l.id === levelId)) throw new HttpError(400, 'Nivel inexistente');

  const pmcSince = body.pmcSince ? String(body.pmcSince) : null;
  if (pmcSince && (!DATE_RE.test(pmcSince) || Number.isNaN(new Date(pmcSince).getTime()))) throw new HttpError(400, 'Fecha de alta en PMC inválida');

  const logoUrl = String(body.logoUrl || '').trim();
  if (logoUrl) {
    try {
      await fetchLogo(logoUrl);
    } catch (error) {
      throw new HttpError(400, `Logo URL: ${error.message}`);
    }
  }

  const clients = await store.listClients();
  const before = clients.find((c) => c.organizationId === organizationId) || null;
  const saved = await store.saveClient({ organizationId, organizationName: organization.name, levelId, pmcSince, logoUrl, active: body.active !== false }, user.email);
  await db.addAudit('pmc_client', organizationId, before ? 'update' : 'create', user.email, { before, after: saved });
  return saved;
}

module.exports = async (req, res) => {
  try {
    const query = req.query || {};

    // Sincronización: con sesión (botón) o desde el workflow horario.
    if (query.action === 'sync') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const user = isAuthorizedCron(req) ? null : await requireUser(req, res);
      const reset = query.reset === '1';
      if (reset && user) await db.addAudit('impact', 'sync', 'reset', user.email, {});
      sendJson(res, 200, await runSync({ reset }));
      return;
    }

    const user = await requireUser(req, res);
    const view = String(query.view || '');

    if (req.method === 'GET' && view === 'dashboard') {
      sendJson(res, 200, await dashboard(query));
      return;
    }

    if (req.method === 'GET' && view === 'config') {
      const [settings, levels, clients, syncState, factsInfo] = await Promise.all([
        store.getSettings(), store.listLevels(), store.listClients(), store.getSyncState(), store.factsSummary(),
      ]);
      sendJson(res, 200, { settings, levels, clients, sync: { state: syncState, facts: factsInfo } });
      return;
    }

    if (req.method === 'GET' && view === 'suggestions') {
      sendJson(res, 200, await suggestions());
      return;
    }

    if (req.method === 'PUT' && view === 'settings') {
      const body = readBody(req);
      const before = await store.getSettings();
      const agents = cleanList(body.agents, MAX_AGENTS);
      if (!agents.length) throw new HttpError(400, 'Ingresa al menos un agente de Care');
      const escalationProjects = cleanList(body.escalationProjects, 10).map((p) => p.toUpperCase());
      if (escalationProjects.some((p) => !/^[A-Z][A-Z0-9_]{0,19}$/.test(p))) throw new HttpError(400, 'Proyectos de escalamiento: usa claves de proyecto de Jira (ej. HDI)');
      const timezone = String(body.timezone || before.timezone);
      if (!isValidTimezone(timezone)) throw new HttpError(400, 'Zona horaria inválida');
      const settings = { ...before, agents, escalationProjects, timezone };
      await store.saveSettings(settings, user.email);
      await db.addAudit('impact', 'settings', 'update', user.email, { before, after: settings });
      // Agentes y escalamiento cambian cómo se calcula cada ticket: hay que recalcular.
      const needsResync = JSON.stringify(before.agents) !== JSON.stringify(agents) || JSON.stringify(before.escalationProjects) !== JSON.stringify(escalationProjects);
      sendJson(res, 200, { settings, needsResync });
      return;
    }

    if (view === 'levels') {
      if (req.method === 'POST') {
        const body = readBody(req);
        const name = String(body.name || '').trim();
        if (!name || name.length > 40) throw new HttpError(400, 'El nombre del nivel es obligatorio (máx. 40 caracteres)');
        const level = await store.saveLevel({
          id: body.id ? Number(body.id) : null,
          name,
          firstResponseHours: hours(body.firstResponseHours, 'Primera respuesta'),
          resolutionHours: hours(body.resolutionHours, 'Resolución'),
        }, user.email).catch((error) => {
          if (/unique|duplicate/i.test(error.message)) throw new HttpError(400, 'Ya existe un nivel con ese nombre');
          throw error;
        });
        if (!level) throw new HttpError(404, 'Nivel inexistente');
        await db.addAudit('pmc_level', String(level.id), body.id ? 'update' : 'create', user.email, { level });
        sendJson(res, 200, { level });
        return;
      }
      if (req.method === 'DELETE') {
        const id = Number(query.id);
        if (!Number.isInteger(id) || !(await store.deleteLevel(id))) throw new HttpError(404, 'Nivel inexistente');
        await db.addAudit('pmc_level', String(id), 'delete', user.email, {});
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (view === 'clients') {
      if (req.method === 'PUT') {
        sendJson(res, 200, { client: await saveClient(readBody(req), user) });
        return;
      }
      if (req.method === 'DELETE') {
        const id = String(query.id || '');
        if (!id || !(await store.deleteClient(id))) throw new HttpError(404, 'Cliente PMC inexistente');
        await db.addAudit('pmc_client', id, 'delete', user.email, {});
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    throw new HttpError(404, 'Ruta desconocida');
  } catch (error) {
    handleError(res, error);
  }
};
