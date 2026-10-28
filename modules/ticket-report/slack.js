// Preaviso para el equipo de Customer Care en Slack: va la imagen del
// reporte (igual a la vista del correo) y este comentario corto, con el
// próximo envío a Consulting y los tickets abiertos enlazados a Jira.
const MAX_OPEN_TICKETS = 30;
const MAX_COMMENT_CHARS = 3800;

// Escape de mrkdwn de Slack: &, < y > (los links van como <url|texto>).
function slackEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// context: { organizationName, nextSendLabel, actor, browseUrl }
function buildSlackComment(snapshot, context) {
  const { report } = snapshot;
  const lines = [
    `📣 *Preaviso: ${slackEscape(snapshot.title)}*`,
    [
      `Organization: ${slackEscape(context.organizationName)}`,
      `Corte: ${slackEscape(snapshot.cutoffDate)}`,
      context.nextSendLabel ? `Próximo envío a Consulting: *${slackEscape(context.nextSendLabel)}*` : 'Sin envío programado',
    ].join('  ·  '),
  ];

  const open = report.openTickets;
  if (open.length) {
    lines.push('', `*Tickets abiertos (${open.length})*`);
    for (const ticket of open.slice(0, MAX_OPEN_TICKETS)) {
      const line = `• <${context.browseUrl(ticket.key)}|${slackEscape(ticket.key)}> ${slackEscape(ticket.summary)} — _${slackEscape(ticket.status.label)}_`;
      if (lines.join('\n').length + line.length > MAX_COMMENT_CHARS) break;
      lines.push(line);
    }
    const shown = lines.filter((l) => l.startsWith('• ')).length;
    if (shown < open.length) lines.push(`_…y ${open.length - shown} más (ver la imagen)_`);
  } else {
    lines.push('', report.total ? 'Sin tickets abiertos 🎉' : 'No hay tickets en el período.');
  }

  lines.push('', `_Enviado desde CareSubscription por ${slackEscape(context.actor)}_`);
  return lines.join('\n');
}

module.exports = { buildSlackComment, slackEscape, MAX_OPEN_TICKETS };
