const { db: baseDb } = require('../db');

// Tablas de Impacto Care (se crean solas, como el resto de lib/db.js).
// - pmc_levels: niveles del plan PMC con sus metas de SLA de contrato.
// - pmc_clients: qué Organizations de Jira son clientes PMC, su nivel y alta.
// - impact_settings: agentes de Care, proyectos de escalamiento, zona horaria
//   y estado de la sincronización.
// - ticket_facts: SOLO métricas por ticket (fechas, Organizations, SLA,
//   escalado). Sin textos ni personas.
let schemaReady = null;

const DEFAULT_SETTINGS = {
  agents: ['Guardia', 'Joel', 'Mauricio', 'Erwin'],
  escalationProjects: ['HDI'],
  timezone: 'America/Argentina/Buenos_Aires',
  project: 'JCS',
  historyDays: 730,
};

async function db() {
  const sql = await baseDb();
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS pmc_levels (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          first_response_hours NUMERIC,
          resolution_hours NUMERIC,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS pmc_clients (
          organization_id TEXT PRIMARY KEY,
          organization_name TEXT NOT NULL,
          level_id INTEGER REFERENCES pmc_levels(id) ON DELETE SET NULL,
          pmc_since DATE,
          logo_url TEXT NOT NULL DEFAULT '',
          active BOOLEAN NOT NULL DEFAULT TRUE,
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS impact_settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_by TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS ticket_facts (
          issue_key TEXT PRIMARY KEY,
          org_ids JSONB NOT NULL DEFAULT '[]',
          created_at TIMESTAMPTZ NOT NULL,
          resolved_at TIMESTAMPTZ,
          state TEXT NOT NULL,
          first_response_at TIMESTAMPTZ,
          jira_sla_breached BOOLEAN,
          jira_sla_elapsed_ms BIGINT,
          jira_sla_goal_ms BIGINT,
          escalated BOOLEAN NOT NULL DEFAULT FALSE,
          synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS ticket_facts_created_idx ON ticket_facts (created_at)`;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
  return sql;
}

// ---- Configuración ----

async function getSettings() {
  const sql = await db();
  const rows = await sql`SELECT key, value FROM impact_settings WHERE key = 'config'`;
  return { ...DEFAULT_SETTINGS, ...(rows[0] ? rows[0].value : {}) };
}

async function saveSettings(settings, actor) {
  const sql = await db();
  await sql`
    INSERT INTO impact_settings (key, value, updated_by, updated_at) VALUES ('config', ${JSON.stringify(settings)}::jsonb, ${actor}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
}

async function getSyncState() {
  const sql = await db();
  const rows = await sql`SELECT value, updated_at FROM impact_settings WHERE key = 'sync'`;
  return rows[0] ? { ...rows[0].value, updatedAt: rows[0].updated_at } : null;
}

async function saveSyncState(state) {
  const sql = await db();
  await sql`
    INSERT INTO impact_settings (key, value, updated_at) VALUES ('sync', ${JSON.stringify(state)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

// Evita dos sincronizaciones a la vez (botón + cron). Vence sola.
async function acquireSyncLock(seconds = 90) {
  const sql = await db();
  const rows = await sql`
    INSERT INTO impact_settings (key, value, updated_at) VALUES ('sync-lock', ${JSON.stringify({ until: Date.now() + seconds * 1000 })}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE (impact_settings.value->>'until')::bigint < ${Date.now()}
    RETURNING key
  `;
  return rows.length > 0;
}

async function releaseSyncLock() {
  const sql = await db();
  await sql`DELETE FROM impact_settings WHERE key = 'sync-lock'`;
}

// ---- Niveles PMC ----

function rowToLevel(row) {
  return {
    id: row.id,
    name: row.name,
    firstResponseHours: row.first_response_hours === null ? null : Number(row.first_response_hours),
    resolutionHours: row.resolution_hours === null ? null : Number(row.resolution_hours),
  };
}

async function listLevels() {
  const sql = await db();
  return (await sql`SELECT * FROM pmc_levels ORDER BY name`).map(rowToLevel);
}

async function saveLevel(level, actor) {
  const sql = await db();
  const rows = level.id
    ? await sql`
        UPDATE pmc_levels SET name = ${level.name}, first_response_hours = ${level.firstResponseHours}, resolution_hours = ${level.resolutionHours},
          updated_by = ${actor}, updated_at = now()
        WHERE id = ${level.id} RETURNING *`
    : await sql`
        INSERT INTO pmc_levels (name, first_response_hours, resolution_hours, updated_by)
        VALUES (${level.name}, ${level.firstResponseHours}, ${level.resolutionHours}, ${actor}) RETURNING *`;
  return rows[0] ? rowToLevel(rows[0]) : null;
}

async function deleteLevel(id) {
  const sql = await db();
  return (await sql`DELETE FROM pmc_levels WHERE id = ${id} RETURNING id`).length > 0;
}

// ---- Clientes PMC ----

function rowToClient(row) {
  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    levelId: row.level_id,
    pmcSince: row.pmc_since ? new Date(row.pmc_since).toISOString().slice(0, 10) : null,
    logoUrl: row.logo_url,
    active: row.active,
  };
}

async function listClients() {
  const sql = await db();
  return (await sql`SELECT * FROM pmc_clients ORDER BY organization_name`).map(rowToClient);
}

async function saveClient(client, actor) {
  const sql = await db();
  const rows = await sql`
    INSERT INTO pmc_clients (organization_id, organization_name, level_id, pmc_since, logo_url, active, updated_by, updated_at)
    VALUES (${client.organizationId}, ${client.organizationName}, ${client.levelId}, ${client.pmcSince}, ${client.logoUrl}, ${client.active}, ${actor}, now())
    ON CONFLICT (organization_id) DO UPDATE SET organization_name = EXCLUDED.organization_name, level_id = EXCLUDED.level_id,
      pmc_since = EXCLUDED.pmc_since, logo_url = EXCLUDED.logo_url, active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING *
  `;
  return rowToClient(rows[0]);
}

async function deleteClient(organizationId) {
  const sql = await db();
  return (await sql`DELETE FROM pmc_clients WHERE organization_id = ${organizationId} RETURNING organization_id`).length > 0;
}

// ---- Métricas por ticket ----

// facts: salida de extractFacts. Upsert en bloque.
async function upsertFacts(facts) {
  if (!facts.length) return 0;
  const sql = await db();
  const rows = facts.map((f) => ({
    issue_key: f.issueKey,
    org_ids: f.orgIds,
    created_at: f.createdAt,
    resolved_at: f.resolvedAt,
    state: f.state,
    first_response_at: f.firstResponseAt,
    jira_sla_breached: f.jiraSlaBreached,
    jira_sla_elapsed_ms: f.jiraSlaElapsedMs,
    jira_sla_goal_ms: f.jiraSlaGoalMs,
    escalated: f.escalated,
  }));
  await sql`
    INSERT INTO ticket_facts (issue_key, org_ids, created_at, resolved_at, state, first_response_at, jira_sla_breached, jira_sla_elapsed_ms, jira_sla_goal_ms, escalated, synced_at)
    SELECT issue_key, org_ids, created_at, resolved_at, state, first_response_at, jira_sla_breached, jira_sla_elapsed_ms, jira_sla_goal_ms, escalated, now()
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
      issue_key TEXT, org_ids JSONB, created_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ, state TEXT, first_response_at TIMESTAMPTZ,
      jira_sla_breached BOOLEAN, jira_sla_elapsed_ms BIGINT, jira_sla_goal_ms BIGINT, escalated BOOLEAN
    )
    WHERE created_at IS NOT NULL
    ON CONFLICT (issue_key) DO UPDATE SET org_ids = EXCLUDED.org_ids, created_at = EXCLUDED.created_at, resolved_at = EXCLUDED.resolved_at,
      state = EXCLUDED.state, first_response_at = EXCLUDED.first_response_at, jira_sla_breached = EXCLUDED.jira_sla_breached,
      jira_sla_elapsed_ms = EXCLUDED.jira_sla_elapsed_ms, jira_sla_goal_ms = EXCLUDED.jira_sla_goal_ms, escalated = EXCLUDED.escalated, synced_at = now()
  `;
  return rows.length;
}

// Tickets de las Organizations indicadas creados desde `since`.
async function listFacts(organizationIds, since) {
  if (!organizationIds.length) return [];
  const sql = await db();
  const rows = await sql`
    SELECT issue_key, org_ids, created_at, resolved_at, state, first_response_at, jira_sla_breached, jira_sla_elapsed_ms, jira_sla_goal_ms, escalated
    FROM ticket_facts
    WHERE created_at >= ${since} AND org_ids ?| ${organizationIds}
  `;
  return rows.map((r) => ({
    issueKey: r.issue_key,
    orgIds: r.org_ids,
    createdAt: new Date(r.created_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    state: r.state,
    firstResponseAt: r.first_response_at ? new Date(r.first_response_at).toISOString() : null,
    jiraSlaBreached: r.jira_sla_breached,
    jiraSlaElapsedMs: r.jira_sla_elapsed_ms === null ? null : Number(r.jira_sla_elapsed_ms),
    jiraSlaGoalMs: r.jira_sla_goal_ms === null ? null : Number(r.jira_sla_goal_ms),
    escalated: r.escalated,
  }));
}

async function factsSummary() {
  const sql = await db();
  const rows = await sql`SELECT count(*)::int AS total, min(created_at) AS oldest, max(synced_at) AS last_synced FROM ticket_facts`;
  return { total: rows[0].total, oldest: rows[0].oldest, lastSynced: rows[0].last_synced };
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettings, saveSettings, getSyncState, saveSyncState, acquireSyncLock, releaseSyncLock,
  listLevels, saveLevel, deleteLevel,
  listClients, saveClient, deleteClient,
  upsertFacts, listFacts, factsSummary,
};
