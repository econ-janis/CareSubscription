const { resolveStatus } = require('./statuses');

// Arma el modelo del reporte a partir de los issues de Jira (solo se usan
// key, summary, status y created; nada de esto se persiste).
//
// - rows: todos los estados configurados (aunque estén en 0, salvo los
//   marcados `hideWhenZero`) + los estados desconocidos con valor, en gris y
//   con su nombre original. `open` indica si el estado cuenta como abierto.
// - openTickets: solo estados marcados `open`, ordenados por estado y
//   después por fecha de creación ascendente.
function aggregate(issues, statusConfig, language = 'es', { onUnknownStatus = () => {} } = {}) {
  const counts = new Map(statusConfig.statuses.map((s) => [s.key, 0]));
  const unknown = new Map();
  const openTickets = [];

  for (const issue of issues) {
    const fields = issue.fields || {};
    const jiraStatus = fields.status ? fields.status.name : '';
    const status = resolveStatus(statusConfig, jiraStatus);

    if (!status) {
      if (!unknown.has(jiraStatus)) onUnknownStatus(jiraStatus);
      unknown.set(jiraStatus, (unknown.get(jiraStatus) || 0) + 1);
      continue;
    }

    counts.set(status.key, counts.get(status.key) + 1);
    if (status.open) {
      openTickets.push({
        key: issue.key,
        summary: fields.summary || '',
        created: fields.created || '',
        assignee: fields.assignee ? fields.assignee.displayName || '' : '',
        status: { key: status.key, label: status.label[language] || status.label.es, color: status.color, textColor: status.textColor },
        order: status.order,
      });
    }
  }

  const total = issues.length;
  const pct = (value) => (total ? (value * 100) / total : 0);

  const rows = [
    ...statusConfig.statuses.filter((s) => counts.get(s.key) > 0 || !s.hideWhenZero).map((s) => ({
      key: s.key,
      label: s.label[language] || s.label.es,
      color: s.color,
      textColor: s.textColor,
      total: counts.get(s.key),
      percent: pct(counts.get(s.key)),
      known: true,
      open: Boolean(s.open),
    })),
    ...[...unknown.entries()].map(([name, value]) => ({
      key: `unknown:${name}`,
      label: name || '—',
      color: statusConfig.unknown.color,
      textColor: statusConfig.unknown.textColor,
      total: value,
      percent: pct(value),
      known: false,
      open: false,
    })),
  ];

  openTickets.sort((a, b) => a.order - b.order || String(a.created).localeCompare(String(b.created)));

  return {
    total,
    rows,
    segments: rows.filter((r) => r.total > 0),
    openTickets: openTickets.map(({ order, ...ticket }) => ticket),
  };
}

module.exports = { aggregate };
