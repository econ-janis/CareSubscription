const fs = require('node:fs');
const path = require('node:path');
const { searchAll, validateJql, browseUrl } = require('../../lib/jira');
const { fetchLogo } = require('../../lib/logo');
const { formatDate } = require('../../lib/schedule');
const { DEFAULT_JQL, resolveJql, filtersByOrganization } = require('./jql');
const { loadStatusConfig } = require('./statuses');
const { aggregate } = require('./aggregate');
const { renderDonutPng } = require('./chart');
const { renderReportHtml } = require('./template');
const { t } = require('./i18n');
const { buildSlackComment } = require('./slack');

// Módulo "Reporte de tickets de los últimos 3 meses" (spec §1-§8).
// Contrato de módulo (ver modules/index.js): defaultConfig, validateConfig
// y build. Lo genérico (programación, envío, historial, destinatarios)
// vive en lib/ y se reutiliza para los próximos módulos.
const BRAND_DIR = path.join(__dirname, '..', '..', 'assets', 'brand');
const JANIS_ISO = fs.readFileSync(path.join(BRAND_DIR, 'janis-iso.png'));
const JANIS_LOGO = fs.readFileSync(path.join(BRAND_DIR, 'janis-logo.png'));
const JANIS_LOGO_DARK = fs.readFileSync(path.join(BRAND_DIR, 'janis-logo-dark.png'));
// assignee: solo para agrupar por Responsable en el preaviso de Slack (el
// correo no lo muestra).
const FIELDS = ['summary', 'status', 'created', 'assignee'];

function defaultConfig() {
  return { jql: DEFAULT_JQL, logoUrl: '', skipIfEmpty: false };
}

// Normaliza y valida la config del módulo. `checkRemote` = validar contra
// Jira y descargar el logo (se hace al guardar; la vista previa lo tolera).
async function validateConfig(input = {}, { organization, checkRemote = true } = {}) {
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
    if (checkRemote && organization) {
      const jiraError = await validateJql(resolveJql(config.jql, organization.name));
      if (jiraError) errors.push(`Jira rechazó el JQL: ${jiraError}`);
    }
  }

  if (config.logoUrl && checkRemote) {
    try {
      await fetchLogo(config.logoUrl);
    } catch (error) {
      errors.push(`Logo URL: ${error.message}`);
    }
  }

  return { config, errors, warnings };
}

async function resolveLogo(logoUrl, warnings) {
  if (logoUrl) {
    try {
      return await fetchLogo(logoUrl);
    } catch (error) {
      console.warn(`[ticket-report] logo inválido (${logoUrl}): ${error.message}`);
      warnings.push(`Logo no disponible, se usó el isotipo de Janis: ${error.message}`);
    }
  }
  return { buffer: JANIS_ISO, contentType: 'image/png' };
}

// Dibuja el correo a partir de un snapshot (los datos ya agregados, sin
// consultar Jira). mode: 'email' (imágenes por CID) o 'preview' (imágenes
// como data: URI para mostrar en la UI). Se usa al enviar, en la vista
// previa y para reconstruir un envío del historial tal como salió.
async function render(snapshot, { mode = 'email', warnings = [] } = {}) {
  const { title, cutoffDate, language, report } = snapshot;
  const tx = t(language);

  const logo = await resolveLogo(snapshot.logoUrl, warnings);
  const images = [
    { cid: 'logo@caresubscription', name: 'logo', ...logo },
    { cid: 'footer@caresubscription', name: 'janis-commerce.png', buffer: JANIS_LOGO, contentType: 'image/png' },
    { cid: 'footer-dark@caresubscription', name: 'janis-commerce-dark.png', buffer: JANIS_LOGO_DARK, contentType: 'image/png' },
  ];
  if (report.total > 0) {
    images.push(
      { cid: 'chart@caresubscription', name: 'distribucion.png', buffer: renderDonutPng(report.segments, report.total, tx.donutCenter, 'light'), contentType: 'image/png' },
      { cid: 'chart-dark@caresubscription', name: 'distribucion-oscuro.png', buffer: renderDonutPng(report.segments, report.total, tx.donutCenter, 'dark'), contentType: 'image/png' },
    );
  }

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
      logo: src('logo@caresubscription'),
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
  const statusConfig = loadStatusConfig();
  const jql = resolveJql(subscription.config.jql, subscription.organization.name);

  const issues = await searchAll(jql, FIELDS);
  const report = aggregate(issues, statusConfig, language, {
    onUnknownStatus: (name) => {
      console.warn(`[ticket-report] estado de Jira sin mapear en config/statuses.json: "${name}" (suscripción ${subscription.id ?? 'sin guardar'})`);
      warnings.push(`Estado sin mapear: ${name}`);
    },
  });

  const snapshot = {
    title: subscription.title,
    subject: subscription.subject || subscription.title,
    cutoffDate: formatDate(now, subscription.schedule.timezone, language),
    language,
    logoUrl: subscription.config.logoUrl || '',
    report: {
      total: report.total,
      rows: report.rows,
      segments: report.segments,
      openTickets: report.openTickets.map(({ key, summary, status, assignee }) => ({ key, summary, status, assignee })),
    },
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
};
