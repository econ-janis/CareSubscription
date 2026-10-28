// Preaviso para el equipo de Customer Care en Slack, antes de que el
// reporte salga a Consulting: próximo envío y tickets abiertos agrupados
// por Responsable (asignado en Jira), enlazados a Jira.
const MAX_CHARS = 3800; // Slack corta con "ver más" los mensajes muy largos
const UNASSIGNED = 'Sin asignar';

// Escape de mrkdwn de Slack: &, < y > (los links van como <url|texto>).
function slackEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Grupos por Responsable en orden alfabético, "Sin asignar" al final. Dentro
// de cada grupo se respeta el orden del reporte (estado y antigüedad).
function groupByAssignee(tickets) {
  const groups = new Map();
  for (const ticket of tickets) {
    const name = (ticket.assignee || '').trim() || UNASSIGNED;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(ticket);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNASSIGNED) return 1;
    if (b === UNASSIGNED) return -1;
    return a.localeCompare(b, 'es');
  });
}

// context: { organizationName, nextSendLabel, browseUrl }. Quién lo envió
// queda en el historial, no en el mensaje.
function buildSlackComment(snapshot, context) {
  const { report } = snapshot;
  const header = [
    `📣 *Preaviso: ${slackEscape(snapshot.title)}*`,
    context.nextSendLabel
      ? `Foco con estos tickets para avanzarlos, el reporte se envía el ${slackEscape(context.nextSendLabel)}`
      : 'Foco con estos tickets para avanzarlos.',
  ];

  const open = report.openTickets;
  if (!open.length) {
    return [...header, '', report.total ? 'Sin tickets abiertos 🎉' : 'No hay tickets en el período.'].join('\n');
  }

  const body = ['', `*Tickets abiertos (${open.length})*`];
  let shown = 0;
  let truncated = false;
  for (const [name, tickets] of groupByAssignee(open)) {
    const block = ['', `👤 *${slackEscape(name)}* (${tickets.length})`];
    for (const ticket of tickets) {
      block.push(`• <${context.browseUrl(ticket.key)}|${slackEscape(ticket.key)}> ${slackEscape(ticket.summary)} — _${slackEscape(ticket.status.label)}_`);
    }
    if ([...header, ...body, ...block].join('\n').length > MAX_CHARS) {
      truncated = true;
      break;
    }
    body.push(...block);
    shown += tickets.length;
  }
  if (truncated) body.push('', `_…y ${open.length - shown} tickets más (ver el reporte completo en CareSubscription)_`);

  return [...header, ...body].join('\n');
}

module.exports = { buildSlackComment, groupByAssignee, slackEscape, UNASSIGNED };
