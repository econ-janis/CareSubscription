const { browseUrl } = require('../../lib/jira');
const { formatDate } = require('../../lib/schedule');
const { uniqueSlugs } = require('../../lib/slug');
const { appUrl } = require('../../lib/app-url');
const { renderSmallDonutPng } = require('./chart');
const { renderGroupHtml, TEXTS } = require('./group-template');
const { loadStatusConfig } = require('./statuses');
const { fetchReport, resolveLogo, organizationsOf, JANIS_ISO, JANIS_LOGO } = require('./report');

// Envío agrupado (spec §10, correo v2): un solo correo con una tabla resumen
// y una sección por suscripción (una o más Organizations). Se consulta Jira
// por cada una; si una falla, el correo sale igual, su fila del resumen
// muestra "—" y su sección dice "No se pudo obtener la información".
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

// Nombre de una suscripción en la tabla resumen: sus Organizations.
function sectionName(subscription) {
  return organizationsOf(subscription).map((o) => o.name).join(' · ');
}

// Nombre visible en el encabezado de la sección: el título de la suscripción
// sin el prefijo común ("Care Weekly Status — Carrefour Argentina · PMC Gold"
// -> "Carrefour Argentina · PMC Gold"); sin prefijo, el título completo.
function displayName(title, fallback = '') {
  const value = String(title || '').trim();
  const index = value.search(/\s[—–]\s/);
  if (index >= 0) return value.slice(index + 3).trim() || fallback || value;
  return value || fallback;
}

// Orden de filas y secciones: alfabético por nombre de Organization.
function sortSubscriptions(subscriptions) {
  return [...subscriptions].sort((a, b) => sectionName(a).localeCompare(sectionName(b), 'es') || a.title.localeCompare(b.title, 'es'));
}

// Totales de una sección a partir de las filas del reporte. Resueltos: el
// estado "resolved"; abiertos: los estados marcados `open` en la
// configuración; cancelados: "cancelled". Segmentos de barra y dona: solo
// estados con valor, en el orden del gráfico (los no mapeados al final).
function sectionStats(report, statusConfig) {
  const byKey = new Map(statusConfig.statuses.map((s) => [s.key, s]));
  const isOpen = (row) => (row.open !== undefined ? row.open : Boolean(byKey.get(row.key) && byKey.get(row.key).open));
  const count = (key) => (report.rows.find((r) => r.key === key) || { total: 0 }).total;
  const rank = (row) => {
    const index = statusConfig.chartOrder.indexOf(row.key);
    return index >= 0 ? index : statusConfig.chartOrder.length;
  };
  const segments = report.rows.filter((r) => r.total > 0)
    .map((r, i) => ({ row: r, i }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i)
    .map(({ row }) => ({ key: row.key, label: row.label, color: row.color, total: row.total }));
  return {
    stats: {
      total: report.total,
      resolved: count('resolved'),
      open: report.rows.filter(isOpen).reduce((sum, r) => sum + r.total, 0),
      cancelled: count('cancelled'),
    },
    segments,
  };
}

// Leyenda de la tabla resumen: todos los estados configurados, en el orden
// del gráfico.
function legendItems(statusConfig, language) {
  const byKey = new Map(statusConfig.statuses.map((s) => [s.key, s]));
  return statusConfig.chartOrder.filter((key) => byKey.has(key)).map((key) => {
    const status = byKey.get(key);
    return { label: status.label[language] || status.label.es, color: status.color };
  });
}

// Dibuja el correo (mode 'email') o la landing / vista previa (mode 'web' /
// 'preview': imágenes como data: URI). En el correo, la marca de Janis va
// por URL pública (/brand/*.png) si se conoce la URL de la app; si no, y
// para logos y donas, como imágenes CID inline (nunca base64 en el HTML).
async function render(snapshot, { mode = 'email', warnings = [], baseUrl = appUrl() } = {}) {
  const statusConfig = loadStatusConfig();
  const brandUrl = mode === 'email' && baseUrl ? baseUrl : '';
  const iso = { cid: 'iso@caresubscription', name: 'janis-iso.png', buffer: JANIS_ISO, contentType: 'image/png', url: brandUrl && `${brandUrl}/brand/janis-iso.png` };
  const footer = { cid: 'footer@caresubscription', name: 'janis-commerce.png', buffer: JANIS_LOGO, contentType: 'image/png', url: brandUrl && `${brandUrl}/brand/janis-logo.png` };
  const used = new Set();
  const src = (image) => {
    if (mode !== 'email') return `data:${image.contentType};base64,${image.buffer.toString('base64')}`;
    if (image.url) return image.url;
    used.add(image);
    return `cid:${image.cid}`;
  };

  const sections = await mapLimit(snapshot.sections, JIRA_CONCURRENCY, async (section) => {
    // Un logo por Organization de la suscripción (snapshots anteriores: logoUrl).
    // Sin logo propio se reutiliza el isotipo (un solo adjunto).
    const urls = section.logoUrls || [section.logoUrl];
    const logoImages = await Promise.all(urls.map(async (url, i) => {
      const logo = await resolveLogo(url, warnings);
      return logo.fallback ? iso : { cid: `logo-${section.slug}-${i}@caresubscription`, name: `logo-${section.slug}-${i}`, buffer: logo.buffer, contentType: logo.contentType };
    }));
    const report = section.ok ? section.snapshot.report : null;
    const { stats, segments } = report ? sectionStats(report, statusConfig) : { stats: null, segments: [] };
    const chartImage = report
      ? { cid: `chart-${section.slug}@caresubscription`, name: `distribucion-${section.slug}.png`, buffer: renderSmallDonutPng(segments, report.total), contentType: 'image/png' }
      : null;
    return { section, report, stats, segments, logoImages, chartImage };
  });

  const html = renderGroupHtml({
    title: snapshot.title,
    cutoffDate: snapshot.cutoffDate,
    language: snapshot.language,
    webUrl: snapshot.webUrl,
    mode: mode === 'email' ? 'email' : 'web',
    browseUrl,
    legendItems: legendItems(statusConfig, snapshot.language),
    images: { iso: src(iso), footer: src(footer) },
    sections: sections.map(({ section, report, stats, segments, logoImages, chartImage }) => ({
      slug: section.slug,
      name: section.name,
      title: section.displayName || displayName(section.subscriptionTitle, section.name),
      logos: logoImages.map(src),
      chart: chartImage ? src(chartImage) : '',
      stats,
      segments,
      openTickets: report ? report.openTickets : [],
    })),
  });

  const gx = TEXTS[snapshot.language] || TEXTS.es;
  const text = [
    snapshot.title,
    gx.subtitle(snapshot.cutoffDate),
    snapshot.webUrl ? snapshot.webUrl : '',
    '',
    ...sections.map(({ section, stats }) => (stats ? `${section.name}: ${stats.total} tickets, ${stats.resolved} resueltos, ${stats.open} abiertos` : `${section.name}: no se pudo obtener la información`)),
  ].join('\n');

  return {
    html,
    text,
    attachments: [...used].map((i) => ({ filename: i.name, content: i.buffer, contentType: i.contentType, cid: i.cid })),
  };
}

// group: { name, subject, language, schedule }, subscriptions: las
// suscripciones incluidas. webUrl: landing de este envío (o '' si no hay).
async function buildGroup(group, subscriptions, { now = new Date(), mode = 'email', webUrl = '', baseUrl } = {}) {
  const warnings = [];
  const language = group.language || 'es';
  const ordered = sortSubscriptions(subscriptions);
  const slugs = uniqueSlugs(ordered.map(sectionName));

  const sections = await mapLimit(ordered, JIRA_CONCURRENCY, async (subscription, index) => {
    const base = {
      slug: slugs[index],
      name: sectionName(subscription),
      subscriptionId: subscription.id,
      subscriptionTitle: subscription.title,
      displayName: displayName(subscription.title, sectionName(subscription)),
      logoUrls: organizationsOf(subscription).map((o) => o.logoUrl || ''),
    };
    try {
      return { ...base, ok: true, snapshot: { report: await fetchReport(subscription, language, warnings) } };
    } catch (error) {
      console.error(`[ticket-report] envío agrupado: falló ${base.name}: ${error.message}`);
      warnings.push(`${base.name}: no se pudo obtener la información (${error.message})`);
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

  const rendered = await render(snapshot, { mode, warnings, baseUrl });
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

module.exports = { buildGroup, renderGroupSnapshot, sortSubscriptions, sectionName, displayName, sectionStats };
