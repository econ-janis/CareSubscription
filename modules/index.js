// Registro de módulos de notificación. Cada módulo exporta:
//   id, name
//   defaultConfig()                       -> config inicial para la UI
//   validateConfig(input, { organization, checkRemote }) -> { config, errors, warnings }
//   build(subscription, { now, mode })    -> { subject, html, text, attachments, snapshot, itemCount, empty, skipIfEmpty, warnings }
//   renderSnapshot(snapshot)              -> { subject, html, warnings }: vista de un envío del historial
//   slackComment(snapshot, context)       -> texto mrkdwn del preaviso en Slack (opcional)
// Programación, envío, historial, auditoría y control de destinatarios son
// comunes (lib/) y no dependen del módulo.
const ticketReport = require('./ticket-report');

const MODULES = new Map([[ticketReport.id, ticketReport]]);

function getModule(id) {
  return MODULES.get(id) || null;
}

function listModules() {
  return [...MODULES.values()].map((m) => ({ id: m.id, name: m.name, defaultConfig: m.defaultConfig() }));
}

module.exports = { getModule, listModules };
