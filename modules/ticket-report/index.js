const { validateJql, browseUrl } = require('../../lib/jira');
const { fetchLogo } = require('../../lib/logo');
const { formatDate } = require('../../lib/schedule');
const { DEFAULT_JQL, resolveJql, filtersByOrganization } = require('./jql');
const { renderDonutPng } = require('./chart');
const { renderReportHtml } = require('./template');
const { t } = require('./i18n');
const { buildSlackComment } = require('./slack');
const { fetchReport, resolveLogo, organizationsOf, JANIS_LOGO, JANIS_LOGO_DARK } = require('./report');
const group = require('./group');

// Módulo "Reporte de tickets de los últimos 3 meses" (spec §1-§8).
// Contrato de módulo (ver modules/index.js): defaultConfig, validateConfig
// y build. Lo genérico (programación, envío, historial, destinatarios)
// vive en lib/ y se reutiliza para los próximos módulos.

function defaultConfig() {
  return { jql: DEFAULT_JQL, logoUrl: '', skipIfEmpty: false };
}

// Normaliza y valida la config del módulo. `checkRemote` = validar contra
// Jira y descargar el logo (se hace al guardar; la vista previa lo tolera).
// organizations: [{ id, name, logoUrl }] (la primera es la principal).
async function validateConfig(input = {}, { organizations = [], checkRemote = true } = {}) {
  const errors = [];
  const warnings = [];
  const config = {
    jql: String(input.jql || '').trim(),
    logoUrl: String(input.logoUrl || '').trim(),
    skipIfEmpty: Boolean(input.skipIfEmpty),
  };

  if (!config.jql) {
    errors.push('El JQL es obligatorio');
  } else {
    if (!filtersByOrganization(config.jql)) {
      warnings.push('El JQL no filtra por Organization: el reporte incluiría tickets de todos los clientes del proyecto');
    }
    if (checkRemote && organizations.length) {
      const jiraError = await validateJql(resolveJql(config.jql, organizations.map((o) => o.name)));
      if (jiraError) errors.push(`Jira rechazó el JQL: ${jiraError}`);
    }
  }

  if (checkRemote) {
    for (const organization of organizations) {
      if (!organization.logoUrl) continue;
      try {
        await fetchLogo(organization.logoUrl);
      } catch (error) {
        errors.push(`Logo URL de ${organization.name}: ${error.message}`);
      }
    }
  }

  return { config, errors, warnings };
}

// Dibuja el correo a partir de un snapshot (los datos ya agregados, sin
// consultar Jira). mode: 'email' (imágenes por CID) o 'preview' (imágenes
// como data: URI para mostrar en la UI). Se usa al enviar, en la vista
// previa y para reconstruir un envío del historial tal como salió.
async function render(snapshot, { mode = 'email', warnings = [] } = {}) {
  const { title, cutoffDate, language, report } = snapshot;
  const tx = t(language);

  // Un logo por Organization (snapshots anteriores: solo logoUrl). Sin logo
  // propio se usa el isotipo de Janis, una sola vez como adjunto.
  const logoUrls = snapshot.organizations ? snapshot.organizations.map((o) => o.logoUrl) : [snapshot.logoUrl];
  const logos = await Promise.all(logoUrls.map((url) => resolveLogo(url, warnings)));
  const images = [
    { cid: 'footer@caresubscription', name: 'janis-commerce.png', buffer: JANIS_LOGO, contentType: 'image/png' },
    { cid: 'footer-dark@caresubscription', name: 'janis-commerce-dark.png', buffer: JANIS_LOGO_DARK, contentType: 'image/png' },
  ];
  if (report.total > 0) {
    images.push(
      { cid: 'chart@caresubscription', name: 'distribucion.png', buffer: renderDonutPng(report.segments, report.total, tx.donutCenter, 'light'), contentType: 'image/png' },
      { cid: 'chart-dark@caresubscription', name: 'distribucion-oscuro.png', buffer: renderDonutPng(report.segments, report.total, tx.donutCenter, 'dark'), contentType: 'image/png' },
    );
  }

  const logoCids = logos.map((logo, i) => {
    const cid = logo.fallback ? 'logo-janis@caresubscription' : `logo-${i}@caresubscription`;
    if (!images.some((img) => img.cid === cid)) images.push({ cid, name: logo.fallback ? 'janis-iso.png' : `logo-${i}`, buffer: logo.buffer, contentType: logo.contentType });
    return cid;
  });

  const src = (cid) => {
    const image = images.find((i) => i.cid === cid);
    if (!image) return '';
    return mode === 'preview' ? `data:${image.contentType};base64,${image.buffer.toString('base64')}` : `cid:${cid}`;
  };

  const html = renderReportHtml({
    title,
    cutoffDate,
    language,
    report,
    browseUrl,
    images: {
      logos: logoCids.map(src),
      footer: src('footer@caresubscription'),
      footerDark: src('footer-dark@caresubscription'),
      chart: src('chart@caresubscription'),
      chartDark: src('chart-dark@caresubscription'),
    },
  });

  const text = [
    title,
    tx.subtitle(cutoffDate),
    '',
    ...report.rows.map((r) => `${r.label}: ${r.total}`),
    `${tx.total}: ${report.total}`,
  ].join('\n');

  return {
    html,
    text,
    attachments: images.map((i) => ({ filename: i.name, content: i.buffer, contentType: i.contentType, cid: i.cid })),
  };
}

// Consulta Jira y arma el correo. Devuelve además el snapshot que se
// guarda en el historial para poder ver después lo que se envió: solo lo
// que muestra el correo (totales por estado y, de los tickets abiertos,
// clave, resumen, estado y responsable).
async function build(subscription, { now = new Date(), mode = 'email' } = {}) {
  const warnings = [];
  const language = subscription.language || 'es';
  const report = await fetchReport(subscription, language, warnings);

  const snapshot = {
    title: subscription.title,
    subject: subscription.subject || subscription.title,
    cutoffDate: formatDate(now, subscription.schedule.timezone, language),
    language,
    logoUrl: subscription.config.logoUrl || '',
    organizations: organizationsOf(subscription).map(({ name, logoUrl }) => ({ name, logoUrl: logoUrl || '' })),
    report,
  };

  const rendered = await render(snapshot, { mode, warnings });

  return {
    subject: snapshot.subject,
    ...rendered,
    snapshot,
    itemCount: report.total,
    empty: report.total === 0,
    skipIfEmpty: subscription.config.skipIfEmpty,
    warnings,
  };
}

// Envío de 1 suscripción: el reporte individual con el idioma, el asunto y
// la zona horaria del envío agrupado.
async function buildSingle(groupConfig, subscription, { now = new Date(), mode = 'email' } = {}) {
  const built = await build({
    ...subscription,
    language: groupConfig.language || 'es',
    subject: groupConfig.subject || groupConfig.name,
    schedule: groupConfig.schedule,
  }, { now, mode });
  return {
    ...built,
    snapshot: { ...built.snapshot, kind: 'single' },
    failedSections: 0,
  };
}

// Vista de un envío del historial, reconstruida desde su snapshot.
async function renderSnapshot(snapshot) {
  const warnings = [];
  const { html } = await render(snapshot, { mode: 'preview', warnings });
  return { subject: snapshot.subject, html, warnings };
}

module.exports = {
  id: 'ticket-report',
  name: 'Reporte de tickets (últimos 3 meses)',
  defaultConfig,
  validateConfig,
  build,
  renderSnapshot,
  // Mensaje del preaviso en Slack (tickets abiertos por Responsable).
  slackComment: (snapshot, context) => buildSlackComment(snapshot, { ...context, browseUrl }),
  // Envío agrupado (spec §10): 1 suscripción -> reporte individual (formato
  // aprobado); 2 o más -> un correo con una sección por suscripción.
  buildGroup: (groupConfig, subscriptions, options = {}) => (subscriptions.length === 1
    ? buildSingle(groupConfig, subscriptions[0], options)
    : group.buildGroup(groupConfig, subscriptions, options)),
  renderGroupSnapshot: (snapshot) => (snapshot.kind === 'group' ? group.renderGroupSnapshot(snapshot) : renderSnapshot(snapshot)),
};
