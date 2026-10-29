const { browseUrl } = require('../../lib/jira');
const { formatDate } = require('../../lib/schedule');
const { uniqueSlugs } = require('../../lib/slug');
const { renderDonutPng } = require('./chart');
const { renderGroupHtml } = require('./group-template');
const { t } = require('./i18n');
const { fetchReport, resolveLogo, JANIS_ISO, JANIS_LOGO } = require('./report');

// Envío agrupado (spec §10): un solo correo con las secciones de varias
// suscripciones (una por Organization). Se consulta Jira por cada una; si
// una falla, el correo sale igual y esa sección dice "No se pudo obtener la
// información" (§10.4).
const JIRA_CONCURRENCY = 4;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Orden de bullets y secciones: alfabético por nombre de Organization.
function sortSubscriptions(subscriptions) {
  return [...subscriptions].sort((a, b) => a.organization.name.localeCompare(b.organization.name, 'es') || a.title.localeCompare(b.title, 'es'));
}

// Dibuja el correo (mode 'email': imágenes por CID) o la landing / vista
// previa (mode 'web' / 'preview': data: URI) a partir del snapshot.
async function render(snapshot, { mode = 'email', warnings = [] } = {}) {
  const tx = t(snapshot.language);
  const images = [
    { cid: 'iso@caresubscription', name: 'janis-iso.png', buffer: JANIS_ISO, contentType: 'image/png' },
    { cid: 'footer@caresubscription', name: 'janis-commerce.png', buffer: JANIS_LOGO, contentType: 'image/png' },
  ];
  const src = (image) => (mode === 'email' ? `cid:${image.cid}` : `data:${image.contentType};base64,${image.buffer.toString('base64')}`);

  const sections = await mapLimit(snapshot.sections, JIRA_CONCURRENCY, async (section) => {
    const logo = await resolveLogo(section.logoUrl, warnings);
    // Sin logo propio se reutiliza el isotipo (un solo adjunto).
    const logoImage = logo.fallback ? images[0] : { cid: `logo-${section.slug}@caresubscription`, name: `logo-${section.slug}`, buffer: logo.buffer, contentType: logo.contentType };
    const report = section.ok ? section.snapshot.report : null;
    const chartImage = report && report.total > 0
      ? { cid: `chart-${section.slug}@caresubscription`, name: `distribucion-${section.slug}.png`, buffer: renderDonutPng(report.segments, report.total, tx.donutCenter, 'group'), contentType: 'image/png' }
      : null;
    return { section, report, logoImage, chartImage };
  });

  for (const { logoImage, chartImage } of sections) {
    if (!images.includes(logoImage)) images.push(logoImage);
    if (chartImage) images.push(chartImage);
  }

  const html = renderGroupHtml({
    title: snapshot.title,
    cutoffDate: snapshot.cutoffDate,
    language: snapshot.language,
    webUrl: snapshot.webUrl,
    mode: mode === 'email' ? 'email' : 'web',
    browseUrl,
    images: { iso: src(images[0]), footer: src(images[1]) },
    sections: sections.map(({ section, report, logoImage, chartImage }) => ({
      slug: section.slug,
      name: section.name,
      subscriptionTitle: section.subscriptionTitle,
      logo: src(logoImage),
      chart: chartImage ? src(chartImage) : '',
      report,
    })),
  });

  const text = [
    snapshot.title,
    tx.subtitle(snapshot.cutoffDate),
    snapshot.webUrl ? snapshot.webUrl : '',
    '',
    ...snapshot.sections.map((s) => (s.ok ? `${s.name}: ${s.snapshot.report.total} tickets, ${s.snapshot.report.openTickets.length} abiertos` : `${s.name}: no se pudo obtener la información`)),
  ].join('\n');

  return {
    html,
    text,
    attachments: images.map((i) => ({ filename: i.name, content: i.buffer, contentType: i.contentType, cid: i.cid })),
  };
}

// group: { name, subject, language, schedule }, subscriptions: las
// suscripciones incluidas. webUrl: landing de este envío (o '' si no hay).
async function buildGroup(group, subscriptions, { now = new Date(), mode = 'email', webUrl = '' } = {}) {
  const warnings = [];
  const language = group.language || 'es';
  const ordered = sortSubscriptions(subscriptions);
  const slugs = uniqueSlugs(ordered.map((s) => s.organization.name));

  const sections = await mapLimit(ordered, JIRA_CONCURRENCY, async (subscription, index) => {
    const base = {
      slug: slugs[index],
      name: subscription.organization.name,
      subscriptionId: subscription.id,
      subscriptionTitle: subscription.title,
      logoUrl: subscription.config.logoUrl || '',
    };
    try {
      return { ...base, ok: true, snapshot: { report: await fetchReport(subscription, language, warnings) } };
    } catch (error) {
      console.error(`[ticket-report] envío agrupado: falló ${subscription.organization.name}: ${error.message}`);
      warnings.push(`${subscription.organization.name}: no se pudo obtener la información (${error.message})`);
      return { ...base, ok: false, error: error.message };
    }
  });

  const snapshot = {
    kind: 'group',
    title: group.name,
    subject: group.subject || group.name,
    cutoffDate: formatDate(now, group.schedule.timezone, language),
    language,
    webUrl,
    sections,
  };

  const rendered = await render(snapshot, { mode, warnings });
  const itemCount = sections.reduce((sum, s) => sum + (s.ok ? s.snapshot.report.total : 0), 0);
  if (Buffer.byteLength(rendered.html) > 100 * 1024) {
    warnings.push('El correo supera ~100 KB de HTML: Gmail podría recortarlo (usá "Ver en la web")');
  }

  return {
    subject: snapshot.subject,
    ...rendered,
    snapshot,
    itemCount,
    failedSections: sections.filter((s) => !s.ok).length,
    warnings,
  };
}

// Landing / vista de un envío del historial, reconstruida desde el snapshot.
async function renderGroupSnapshot(snapshot) {
  const warnings = [];
  const { html } = await render(snapshot, { mode: 'web', warnings });
  return { subject: snapshot.subject, html, warnings };
}

module.exports = { buildGroup, renderGroupSnapshot, sortSubscriptions };
