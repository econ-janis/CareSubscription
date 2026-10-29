-- Referencia/documentación: lib/db.js crea estas tablas solo
-- (CREATE TABLE IF NOT EXISTS) en la primera llamada.
--
-- Privacidad (ISO 27001 / GDPR): no se guarda contenido de tickets. El
-- historial registra solo cantidad, destinatarios y resultado.

-- Una fila por suscripción. `module` identifica el apartado (hoy
-- 'ticket-report'); `config` guarda lo propio del módulo (jql, logoUrl,
-- skipIfEmpty). schedule = { days: [0..6], time: 'HH:MM', timezone }.
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
  status TEXT NOT NULL DEFAULT 'ok',          -- 'ok' | 'error' (JQL inválido)
  last_error TEXT NOT NULL DEFAULT '',
  last_slot_at TIMESTAMPTZ,                   -- último horario programado ya procesado
  lock_until TIMESTAMPTZ,                     -- lock del dispatcher
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS send_history (
  id SERIAL PRIMARY KEY,
  subscription_id INTEGER,                    -- envío de una suscripción…
  group_id INTEGER,                           -- …o de un envío agrupado (spec §10)
  kind TEXT NOT NULL,                         -- 'scheduled' | 'test'
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  slot_at TIMESTAMPTZ,
  ticket_count INTEGER,
  recipients TEXT[] NOT NULL DEFAULT '{}',
  result TEXT NOT NULL,                       -- 'ok' | 'error' | 'skipped'
  error TEXT NOT NULL DEFAULT '',
  warnings TEXT[] NOT NULL DEFAULT '{}',
  triggered_by TEXT NOT NULL DEFAULT '',
  snapshot JSONB                              -- copia mínima para "Ver correo" / landing (se borra a los 90 días)
);
CREATE INDEX IF NOT EXISTS send_history_subscription_idx ON send_history (subscription_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS send_history_group_idx ON send_history (group_id, sent_at DESC);

-- Envíos agrupados (spec §10): varias suscripciones en un solo correo,
-- solo a destinatarios internos.
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
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  entity TEXT NOT NULL,                       -- 'subscription' | 'organization_domains'
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,                       -- 'create' | 'update' | 'delete'
  actor TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changes JSONB NOT NULL DEFAULT '{}'::jsonb  -- { campo: { from, to } }
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id, at DESC);

CREATE TABLE IF NOT EXISTS organization_domains (
  organization_id TEXT PRIMARY KEY,
  domains TEXT[] NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cache_entries (
  key TEXT PRIMARY KEY,                       -- ej. 'jira-organizations' (TTL 24 h)
  data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
