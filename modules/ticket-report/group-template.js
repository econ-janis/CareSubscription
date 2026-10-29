const { t } = require('./i18n');

// HTML del envío agrupado (spec §10), réplica de la maqueta aprobada
// (care-weekly-status-agrupado-ejemplo.html) en formato apto para correo:
// tablas + estilos inline, sin JS ni SVG.
//
// - Header con el isotipo de Janis, título, subtítulo y "Ver en la web ↗"
//   (solo en el correo: la landing es esa misma vista).
// - Un bullet (pill) por Organization con su logo y nombre, enlazado a la
//   sección (#org-<slug>). Las anclas llevan name e id: funcionan en Gmail
//   web, Apple Mail y Outlook escritorio; en móviles puede que no, por eso
//   está el enlace a la landing.
// - Una sección por Organization: separador gris, logo + título de su
//   suscripción, dona, detalle por estado, tickets abiertos y "↑ Volver arriba".
//
// Los src de las imágenes vienen resueltos (cid:… en el correo, data: URI
// en la landing/vista previa): nunca base64 dentro del correo (Gmail recorta
// el HTML de más de ~102 KB).
const FONT = "Montserrat, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const C = { bg: '#F4F6F9', card: '#FFFFFF', text: '#001233', muted: '#33415C', border: '#E3E6EB', link: '#2979FF', separator: '#A9B2C0' };
const TOP_ANCHOR = 'inicio';

const TEXTS = {
  es: { web: 'Ver en la web ↗', top: '↑ Volver arriba', failed: 'No se pudo obtener la información.' },
  pt: { web: 'Ver na web ↗', top: '↑ Voltar ao topo', failed: 'Não foi possível obter as informações.' },
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const text = (size, extra = '') => `font-family:${FONT};font-size:${size}px;line-height:1.45;color:${C.text};${extra}`;
const CARD = `background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:16px;vertical-align:top;${text(14)}`;

function dot(color) {
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:7px;vertical-align:middle;"></span>`;
}

function pill(label, color, textColor) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${color};color:${textColor};font-family:${FONT};font-size:11px;font-weight:600;line-height:1.45;white-space:nowrap;">${esc(label)}</span>`;
}

function h3(value) {
  return `<h3 style="margin:0 0 10px;${text(14, 'font-weight:700;')}">${esc(value)}</h3>`;
}

function th(value, align = 'left') {
  return `<th align="${align}" style="text-align:${align};padding:7px 8px;border-bottom:1px solid ${C.border};${text(11, `font-weight:700;color:${C.muted};text-transform:uppercase;`)}${align === 'right' ? 'white-space:nowrap;' : ''}">${esc(value)}</th>`;
}

function td(html, { align = 'left', nowrap = false } = {}) {
  return `<td align="${align}" style="text-align:${align};padding:7px 8px;border-bottom:1px solid ${C.border};vertical-align:top;${text(14)}${nowrap || align === 'right' ? 'white-space:nowrap;' : ''}">${html}</td>`;
}

function table(rows) {
  return `<div style="overflow-x:auto;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rows}</table></div>`;
}

function distributionCard(report, chartSrc, tx) {
  const legend = report.segments.map((s) => `<span style="display:inline-block;margin:0 5px;white-space:nowrap;${text(12)}">${dot(s.color)}${esc(s.label)}</span>`).join('');
  return `${h3(tx.distribution)}
<img src="${esc(chartSrc)}" width="240" alt="${esc(tx.chartAlt(report.total))}" style="display:block;margin:0 auto;width:240px;max-width:100%;height:auto;border:0;">
<div style="text-align:center;margin-top:6px;">${legend}</div>`;
}

function detailCard(report, tx) {
  const rows = report.rows.map((r) => `<tr>${td(`${dot(r.color)}${esc(r.label)}`)}${td(`<b>${r.total}</b>`, { align: 'right' })}${td(`${r.percent.toFixed(1)}%`, { align: 'right' })}</tr>`).join('');
  const total = `<tr>${td(`<b>${esc(tx.total)}</b>`)}${td(`<b>${report.total}</b>`, { align: 'right' })}${td(report.total ? '100%' : '0.0%', { align: 'right' })}</tr>`;
  return `${h3(tx.detail)}${table(`<tr>${th(tx.status)}${th(tx.total, 'right')}${th(tx.percent, 'right')}</tr>${rows}${total}`)}`;
}

function openTicketsCard(report, tx, browseUrl) {
  const rows = report.openTickets.length
    ? report.openTickets.map((ticket) => `<tr>${td(`<a href="${esc(browseUrl(ticket.key))}" target="_blank" style="color:${C.link};text-decoration:none;white-space:nowrap;">${esc(ticket.key)}</a>`, { nowrap: true })}${td(esc(ticket.summary))}${td(pill(ticket.status.label, ticket.status.color, ticket.status.textColor), { align: 'right' })}</tr>`).join('')
    : `<tr><td colspan="3" style="padding:7px 8px;border-bottom:1px solid ${C.border};${text(14)}">${esc(tx.noOpenTickets)}</td></tr>`;
  return `${h3(tx.openTickets)}${table(`<tr>${th(tx.key)}${th(tx.summary)}${th(tx.status, 'right')}</tr>${rows}`)}`;
}

// Logos de la sección (varias Organizations) o el único logo (formato anterior).
function logosOf(section) {
  return section.logos || [section.logo];
}

function messageCard(message) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;"><tr><td style="${CARD}"><span style="color:${C.muted};">${esc(message)}</span></td></tr></table>`;
}

// section: { slug, name, subscriptionTitle, logos: [src], chart, report | null }
function sectionHtml(section, tx, gx, browseUrl) {
  let body;
  if (!section.report) {
    body = messageCard(gx.failed);
  } else if (section.report.total === 0) {
    body = messageCard(tx.noTickets);
  } else {
    body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;table-layout:fixed;">
  <tr>
    <td class="cg-col" width="266" style="${CARD}width:266px;">${distributionCard(section.report, section.chart, tx)}</td>
    <td class="cg-gap" width="14" style="width:14px;font-size:0;line-height:0;">&nbsp;</td>
    <td class="cg-col cg-col-2" style="${CARD}">${detailCard(section.report, tx)}</td>
  </tr>
</table>
<div style="height:14px;line-height:14px;font-size:0;">&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;"><tr><td style="${CARD}">${openTicketsCard(section.report, tx, browseUrl)}</td></tr></table>`;
  }

  const anchor = `org-${section.slug}`;
  return `<tr><td style="padding:28px 0 0;">
<a name="${esc(anchor)}" id="${esc(anchor)}"></a>
<div style="height:6px;line-height:6px;font-size:0;border-radius:999px;background:${C.separator};margin:0 0 20px;">&nbsp;</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;border-collapse:collapse;"><tr>
  <td style="vertical-align:middle;padding:0 10px 0 0;white-space:nowrap;">${logosOf(section).map((src, i) => `<img src="${esc(src)}" height="28" alt="" style="display:inline-block;vertical-align:middle;height:28px;width:auto;border:0;${i ? 'margin-left:6px;' : ''}">`).join('')}</td>
  <td style="vertical-align:middle;"><h2 style="margin:0;${text(18, 'font-weight:700;')}">${esc(section.subscriptionTitle)}</h2></td>
</tr></table>
${body}
<div style="text-align:right;margin:10px 0 18px;${text(12)}"><a href="#${TOP_ANCHOR}" style="color:${C.link};text-decoration:none;">${esc(gx.top)}</a></div>
</td></tr>`;
}

// mode 'email': incluye "Ver en la web ↗" (si hay webUrl). mode 'web': la landing.
function renderGroupHtml({ title, cutoffDate, language = 'es', sections, images, webUrl = '', mode = 'email', browseUrl }) {
  const tx = t(language);
  const gx = TEXTS[language] || TEXTS.es;

  const bullets = sections.map((s) => `<a href="#org-${esc(s.slug)}" style="display:inline-block;margin:0 8px 8px 0;background:${C.card};border:1px solid ${C.border};border-radius:999px;padding:6px 14px 6px 10px;font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${C.link};text-decoration:none;white-space:nowrap;">${logosOf(s).map((src) => `<img src="${esc(src)}" height="20" alt="" style="display:inline-block;vertical-align:middle;height:20px;width:auto;border:0;margin-right:8px;">`).join('')}${esc(s.name)}</a>`).join('');

  const webLink = mode === 'email' && webUrl
    ? `<tr><td style="padding:0 0 16px;${text(12)}"><a href="${esc(webUrl)}" target="_blank" style="color:${C.link};">${esc(gx.web)}</a></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="${language === 'pt' ? 'pt-BR' : 'es'}" translate="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="google" content="notranslate">
<title>${esc(title)}</title>
<style>
@media only screen and (max-width: 700px) {
  .cg-col { display: block !important; width: auto !important; }
  .cg-gap { display: none !important; }
  .cg-col-2 { margin-top: 14px !important; }
}
</style>
</head>
<body class="notranslate" translate="no" style="margin:0;padding:0;background:${C.bg};">
<a name="${TOP_ANCHOR}" id="${TOP_ANCHOR}"></a>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${C.bg};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:900px;table-layout:fixed;">
<tr><td style="padding:0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
    <td style="vertical-align:middle;padding:0 14px 0 0;"><img src="${esc(images.iso)}" height="34" alt="Janis" style="display:block;height:34px;width:auto;border:0;"></td>
    <td style="vertical-align:middle;"><h1 style="margin:0;${text(22, 'font-weight:700;')}">${esc(title)}</h1></td>
  </tr></table>
</td></tr>
<tr><td style="padding:4px 0 16px;${text(14, `color:${C.muted};`)}">${esc(tx.subtitle(cutoffDate))}</td></tr>
${webLink}
<tr><td style="padding:0 0 16px;font-size:0;line-height:0;">${bullets}</td></tr>
${sections.map((s) => sectionHtml(s, tx, gx, browseUrl)).join('\n')}
<tr><td align="center" style="padding:8px 0 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid ${C.border};">
    <tr><td align="center" style="padding:24px 0 8px;"><img src="${esc(images.footer)}" height="32" alt="Janis Commerce" style="display:block;margin:0 auto;height:32px;width:auto;border:0;"></td></tr>
  </table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { renderGroupHtml, TOP_ANCHOR };
