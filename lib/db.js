const { neon } = require('@neondatabase/serverless');

// Persistencia en Neon Postgres (driver HTTP, igual que JanisHacks). Las
// tablas se crean solas en la primera llamada (CREATE TABLE IF NOT EXISTS);
// schema.sql en la raíz es solo referencia.
//
// Privacidad: el historial registra cantidad de tickets, destinatarios y
// resultado. Para poder ver lo que se envió, cada envío guarda además un
// snapshot con lo mínimo que muestra el correo (totales por estado y, de
// los tickets abiertos, clave, resumen, estado y responsable). Los snapshots se borran
// solos a los SNAPSHOT_RETENTION_DAYS días; la fila del historial queda.
const SNAPSHOT_RETENTION_DAYS = 90;
let schemaReady = null;

function getSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Falta la variable de entorno DATABASE_URL (connection string de Neon)');
  }
  return neon(connectionString);
}

async function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id SERIAL PRIMARY KEY,
          module TEXT NOT NULL,
          title TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          organization_name TEXT NOT NULL,
          config JSONB NOT NULL DEFAULT '{}'::jsonb,
          recipients TEXT[] NOT NULL DEFAULT '{}',
          subject TEXT NOT NULL DEFAULT '',
          schedule JSONB NOT NULL,
          language TEXT NOT NULL DEFAULT 'es',
          active BOOLEAN NOT NULL DEFAULT true,
          status TEXT NOT NULL DEFAULT 'ok',
          last_error TEXT NOT NULL DEFAULT '',
          last_slot_at TIMESTAMPTZ,
          lock_until TIMESTAMPTZ,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS send_history (
          id SERIAL PRIMARY KEY,
          subscription_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          slot_at TIMESTAMPTZ,
          ticket_count INTEGER,
          recipients TEXT[] NOT NULL DEFAULT '{}',
          result TEXT NOT NULL,
          error TEXT NOT NULL DEFAULT '',
          warnings TEXT[] NOT NULL DEFAULT '{}',
          triggered_by TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`ALTER TABLE send_history ADD COLUMN IF NOT EXISTS snapshot JSONB`;
      // Envíos agrupados (spec §10): el historial guarda group_id en lugar de subscription_id.
      await sql`ALTER TABLE send_history ALTER COLUMN subscription_id DROP NOT NULL`;
      await sql`ALTER TABLE send_history ADD COLUMN IF NOT EXISTS group_id INTEGER`;
      await sql`CREATE INDEX IF NOT EXISTS send_history_group_idx ON send_history (group_id, sent_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS group_sends (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          recipients TEXT[] NOT NULL DEFAULT '{}',
          subject TEXT NOT NULL DEFAULT '',
          schedule JSONB NOT NULL,
          language TEXT NOT NULL DEFAULT 'es',
          subscription_ids INTEGER[] NOT NULL DEFAULT '{}',
          active BOOLEAN NOT NULL DEFAULT true,
          status TEXT NOT NULL DEFAULT 'ok',
          last_error TEXT NOT NULL DEFAULT '',
          last_slot_at TIMESTAMPTZ,
          lock_until TIMESTAMPTZ,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS send_history_subscription_idx ON send_history (subscription_id, sent_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS audit_log (
          id SERIAL PRIMARY KEY,
          entity TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          actor TEXT NOT NULL,
          at TIMESTAMPTZ NOT NULL DEFAULT now(),
          changes JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id, at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS organization_domains (
          organization_id TEXT PRIMARY KEY,
          domains TEXT[] NOT NULL DEFAULT '{}',
          updated_by TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS cache_entries (
          key TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function db() {
  const sql = getSql();
  await ensureSchema(sql);
  return sql;
}

function rowToSubscription(row) {
  return {
    id: row.id,
    module: row.module,
    title: row.title,
    organization: { id: row.organization_id, name: row.organization_name },
    config: row.config || {},
    recipients: row.recipients || [],
    subject: row.subject || '',
    schedule: row.schedule,
    language: row.language,
    active: row.active,
    status: row.status,
    lastError: row.last_error || '',
    lastSlotAt: row.last_slot_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

// ---- Suscripciones ----

// Incluye la fecha del último correo enviado (programado o de prueba; los
// preavisos de Slack no cuentan).
async function listSubscriptions() {
  const sql = await db();
  const rows = await sql`
    SELECT s.*, (
      SELECT max(h.sent_at) FROM send_history h
      WHERE h.subscription_id = s.id AND h.result = 'ok' AND h.kind IN ('scheduled', 'test')
    ) AS last_sent_at
    FROM subscriptions s
    ORDER BY s.organization_name, s.title
  `;
  return rows.map((row) => ({ ...rowToSubscription(row), lastSentAt: row.last_sent_at }));
}

async function getSubscription(id) {
  const sql = await db();
  const rows = await sql`SELECT * FROM subscriptions WHERE id = ${id}`;
  return rows[0] ? rowToSubscription(rows[0]) : null;
}

async function getSubscriptionsByIds(ids) {
  if (!ids.length) return [];
  const sql = await db();
  const rows = await sql`SELECT * FROM subscriptions WHERE id = ANY(${ids})`;
  return rows.map(rowToSubscription);
}

async function createSubscription(data, actor) {
  const sql = await db();
  const rows = await sql`
    INSERT INTO subscriptions (module, title, organization_id, organization_name, config, recipients, subject, schedule, language, active, created_by, updated_by)
    VALUES (${data.module}, ${data.title}, ${data.organization.id}, ${data.organization.name}, ${JSON.stringify(data.config)}::jsonb,
            ${data.recipients}, ${data.subject}, ${JSON.stringify(data.schedule)}::jsonb, ${data.language}, ${data.active}, ${actor}, ${actor})
    RETURNING *
  `;
  return rowToSubscription(rows[0]);
}

// Guardar con JQL válido limpia el estado de error (ver §8 de la spec).
async function updateSubscription(id, data, actor) {
  const sql = await db();
  const rows = await sql`
    UPDATE subscriptions SET
      title = ${data.title},
      organization_id = ${data.organization.id},
      organization_name = ${data.organization.name},
      config = ${JSON.stringify(data.config)}::jsonb,
      recipients = ${data.recipients},
      subject = ${data.subject},
      schedule = ${JSON.stringify(data.schedule)}::jsonb,
      language = ${data.language},
      active = ${data.active},
      status = 'ok',
      last_error = '',
      updated_by = ${actor},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? rowToSubscription(rows[0]) : null;
}

async function deleteSubscription(id) {
  const sql = await db();
  const rows = await sql`DELETE FROM subscriptions WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

async function listActiveSubscriptions() {
  const sql = await db();
  const rows = await sql`SELECT * FROM subscriptions WHERE active = true ORDER BY id`;
  return rows.map(rowToSubscription);
}

// Lock corto por suscripción para que dos corridas del dispatcher que se
// pisen no manden el mismo slot dos veces.
async function acquireLock(id, seconds = 300) {
  const sql = await db();
  const rows = await sql`
    UPDATE subscriptions SET lock_until = now() + make_interval(secs => ${seconds})
    WHERE id = ${id} AND (lock_until IS NULL OR lock_until < now())
    RETURNING id
  `;
  return rows.length > 0;
}

async function releaseLock(id) {
  const sql = await db();
  await sql`UPDATE subscriptions SET lock_until = NULL WHERE id = ${id}`;
}

async function markSlotDone(id, slotAt) {
  const sql = await db();
  await sql`UPDATE subscriptions SET last_slot_at = ${slotAt.toISOString()} WHERE id = ${id}`;
}

async function setSubscriptionStatus(id, status, lastError = '') {
  const sql = await db();
  await sql`UPDATE subscriptions SET status = ${status}, last_error = ${lastError} WHERE id = ${id}`;
}

// ---- Historial ----

// entry.subscriptionId o entry.groupId (envío agrupado).
async function addHistory(entry) {
  const sql = await db();
  await sql`
    INSERT INTO send_history (subscription_id, group_id, kind, slot_at, ticket_count, recipients, result, error, warnings, triggered_by, snapshot)
    VALUES (${entry.subscriptionId ?? null}, ${entry.groupId ?? null}, ${entry.kind}, ${entry.slotAt ? entry.slotAt.toISOString() : null}, ${entry.ticketCount ?? null},
            ${entry.recipients || []}, ${entry.result}, ${entry.error || ''}, ${entry.warnings || []}, ${entry.triggeredBy || ''},
            ${entry.snapshot ? JSON.stringify(entry.snapshot) : null}::jsonb)
  `;
  await sql`
    UPDATE send_history SET snapshot = NULL
    WHERE snapshot IS NOT NULL AND sent_at < now() - make_interval(days => ${SNAPSHOT_RETENTION_DAYS})
  `;
}

async function getHistorySnapshot(subscriptionId, historyId) {
  const sql = await db();
  const rows = await sql`
    SELECT snapshot, sent_at FROM send_history WHERE id = ${historyId} AND subscription_id = ${subscriptionId}
  `;
  return rows[0] && rows[0].snapshot ? { snapshot: rows[0].snapshot, sentAt: rows[0].sent_at } : null;
}

function rowToHistory(row) {
  return {
    id: row.id,
    kind: row.kind,
    sentAt: row.sent_at,
    slotAt: row.slot_at,
    ticketCount: row.ticket_count,
    recipients: row.recipients || [],
    result: row.result,
    error: row.error || '',
    warnings: row.warnings || [],
    triggeredBy: row.triggered_by || '',
    hasSnapshot: row.has_snapshot,
  };
}

async function listHistory(subscriptionId, limit = 100) {
  const sql = await db();
  const rows = await sql`
    SELECT id, kind, sent_at, slot_at, ticket_count, recipients, result, error, warnings, triggered_by,
           (snapshot IS NOT NULL) AS has_snapshot
    FROM send_history WHERE subscription_id = ${subscriptionId}
    ORDER BY sent_at DESC LIMIT ${limit}
  `;
  return rows.map(rowToHistory);
}

// Historial de un envío agrupado: incluye el detalle por Organization
// (nombre, tickets, error) sacado del snapshot, sin devolver el snapshot entero.
async function listGroupHistory(groupId, limit = 100) {
  const sql = await db();
  const rows = await sql`
    SELECT id, kind, sent_at, slot_at, ticket_count, recipients, result, error, warnings, triggered_by,
           (snapshot IS NOT NULL) AS has_snapshot,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('name', s->>'name', 'ok', s->'ok', 'total', s->'snapshot'->'report'->'total', 'error', s->>'error')), '[]'::jsonb)
              FROM jsonb_array_elements(coalesce(snapshot->'sections', '[]'::jsonb)) s) AS sections
    FROM send_history WHERE group_id = ${groupId}
    ORDER BY sent_at DESC LIMIT ${limit}
  `;
  return rows.map((row) => ({ ...rowToHistory(row), sections: row.sections || [] }));
}

async function getGroupHistorySnapshot(groupId, historyId) {
  const sql = await db();
  const rows = await sql`SELECT snapshot, sent_at FROM send_history WHERE id = ${historyId} AND group_id = ${groupId}`;
  return rows[0] && rows[0].snapshot ? { snapshot: rows[0].snapshot, sentAt: rows[0].sent_at, historyId } : null;
}

// Envío (ok, con snapshot) de un agrupado en una fecha local (YYYY-MM-DD en
// la zona horaria del envío). Si hay varios ese día, el último.
async function findGroupSendByDate(groupId, date, timezone) {
  const sql = await db();
  const rows = await sql`
    SELECT id, snapshot, sent_at FROM send_history
    WHERE group_id = ${groupId} AND result = 'ok' AND snapshot IS NOT NULL
      AND to_char(sent_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') = ${date}
    ORDER BY sent_at DESC LIMIT 1
  `;
  return rows[0] ? { snapshot: rows[0].snapshot, sentAt: rows[0].sent_at, historyId: rows[0].id } : null;
}

// ---- Envíos agrupados ----

function rowToGroup(row) {
  return {
    id: row.id,
    name: row.name,
    recipients: row.recipients || [],
    subject: row.subject || '',
    schedule: row.schedule,
    language: row.language,
    subscriptionIds: row.subscription_ids || [],
    active: row.active,
    status: row.status,
    lastError: row.last_error || '',
    lastSlotAt: row.last_slot_at,
    lastSentAt: row.last_sent_at || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function listGroups() {
  const sql = await db();
  const rows = await sql`
    SELECT g.*, (
      SELECT max(h.sent_at) FROM send_history h WHERE h.group_id = g.id AND h.result = 'ok' AND h.kind IN ('scheduled', 'test')
    ) AS last_sent_at
    FROM group_sends g ORDER BY g.name
  `;
  return rows.map(rowToGroup);
}

async function getGroup(id) {
  const sql = await db();
  const rows = await sql`SELECT * FROM group_sends WHERE id = ${id}`;
  return rows[0] ? rowToGroup(rows[0]) : null;
}

async function createGroup(data, actor) {
  const sql = await db();
  const rows = await sql`
    INSERT INTO group_sends (name, recipients, subject, schedule, language, subscription_ids, active, created_by, updated_by)
    VALUES (${data.name}, ${data.recipients}, ${data.subject}, ${JSON.stringify(data.schedule)}::jsonb, ${data.language},
            ${data.subscriptionIds}, ${data.active}, ${actor}, ${actor})
    RETURNING *
  `;
  return rowToGroup(rows[0]);
}

async function updateGroup(id, data, actor) {
  const sql = await db();
  const rows = await sql`
    UPDATE group_sends SET
      name = ${data.name}, recipients = ${data.recipients}, subject = ${data.subject},
      schedule = ${JSON.stringify(data.schedule)}::jsonb, language = ${data.language},
      subscription_ids = ${data.subscriptionIds}, active = ${data.active},
      status = 'ok', last_error = '', updated_by = ${actor}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? rowToGroup(rows[0]) : null;
}

async function deleteGroup(id) {
  const sql = await db();
  const rows = await sql`DELETE FROM group_sends WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

async function listActiveGroups() {
  const sql = await db();
  const rows = await sql`SELECT * FROM group_sends WHERE active = true ORDER BY id`;
  return rows.map(rowToGroup);
}

async function acquireGroupLock(id, seconds = 300) {
  const sql = await db();
  const rows = await sql`
    UPDATE group_sends SET lock_until = now() + make_interval(secs => ${seconds})
    WHERE id = ${id} AND (lock_until IS NULL OR lock_until < now())
    RETURNING id
  `;
  return rows.length > 0;
}

async function releaseGroupLock(id) {
  const sql = await db();
  await sql`UPDATE group_sends SET lock_until = NULL WHERE id = ${id}`;
}

async function markGroupSlotDone(id, slotAt) {
  const sql = await db();
  await sql`UPDATE group_sends SET last_slot_at = ${slotAt.toISOString()} WHERE id = ${id}`;
}

// ---- Auditoría ----

async function addAudit(entity, entityId, action, actor, changes = {}) {
  const sql = await db();
  await sql`
    INSERT INTO audit_log (entity, entity_id, action, actor, changes)
    VALUES (${entity}, ${String(entityId)}, ${action}, ${actor}, ${JSON.stringify(changes)}::jsonb)
  `;
}

async function listAudit(entity, entityId, limit = 100) {
  const sql = await db();
  const rows = await sql`
    SELECT * FROM audit_log WHERE entity = ${entity} AND entity_id = ${String(entityId)}
    ORDER BY at DESC LIMIT ${limit}
  `;
  return rows.map((row) => ({ action: row.action, actor: row.actor, at: row.at, changes: row.changes }));
}

// ---- Dominios permitidos por Organization ----

async function getOrganizationDomains(organizationId) {
  const sql = await db();
  const rows = await sql`SELECT domains FROM organization_domains WHERE organization_id = ${String(organizationId)}`;
  return rows[0] ? rows[0].domains : [];
}

async function setOrganizationDomains(organizationId, domains, actor) {
  const sql = await db();
  await sql`
    INSERT INTO organization_domains (organization_id, domains, updated_by, updated_at)
    VALUES (${String(organizationId)}, ${domains}, ${actor}, now())
    ON CONFLICT (organization_id) DO UPDATE SET domains = EXCLUDED.domains, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
}

// ---- Cache genérica (ej. lista de Organizations de Jira) ----

async function getCache(key) {
  const sql = await db();
  const rows = await sql`SELECT data, fetched_at FROM cache_entries WHERE key = ${key}`;
  return rows[0] ? { data: rows[0].data, fetchedAt: rows[0].fetched_at } : null;
}

async function setCache(key, data) {
  const sql = await db();
  await sql`
    INSERT INTO cache_entries (key, data, fetched_at) VALUES (${key}, ${JSON.stringify(data)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()
  `;
}

module.exports = {
  listSubscriptions, getSubscription, getSubscriptionsByIds, createSubscription, updateSubscription, deleteSubscription,
  listActiveSubscriptions, acquireLock, releaseLock, markSlotDone, setSubscriptionStatus,
  addHistory, listHistory, getHistorySnapshot, addAudit, listAudit, SNAPSHOT_RETENTION_DAYS,
  listGroupHistory, getGroupHistorySnapshot, findGroupSendByDate,
  listGroups, getGroup, createGroup, updateGroup, deleteGroup, listActiveGroups,
  acquireGroupLock, releaseGroupLock, markGroupSlotDone,
  getOrganizationDomains, setOrganizationDomains, getCache, setCache,
};
