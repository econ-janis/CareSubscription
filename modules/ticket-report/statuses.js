const path = require('node:path');
const fs = require('node:fs');

// Tabla de estados en config/statuses.json (ajustable sin tocar código).
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'statuses.json');

function normalizeName(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function loadStatusConfig(raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))) {
  const byAlias = new Map();
  raw.statuses.forEach((status, index) => {
    for (const alias of status.aliases) byAlias.set(normalizeName(alias), { ...status, order: index });
  });
  const chartOrder = raw.chartOrder || raw.statuses.map((s) => s.key);
  return { statuses: raw.statuses.map((s, order) => ({ ...s, order })), unknown: raw.unknown, chartOrder, byAlias };
}

// Nombre de Jira -> estado conocido, o null si no está en la tabla.
function resolveStatus(config, jiraName) {
  return config.byAlias.get(normalizeName(jiraName)) || null;
}

module.exports = { loadStatusConfig, resolveStatus, normalizeName };
