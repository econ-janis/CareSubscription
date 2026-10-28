const { t } = require('./i18n');

// HTML del correo: tablas + estilos inline (Gmail/Outlook), ancho máximo
// 640px. Las dos tarjetas (dona y detalle) son columnas "híbridas"
// (inline-block de 300px): en pantallas angostas caen solas a una columna,
// y para Outlook de escritorio se envuelven en una tabla condicional.
//
// `images` trae los src ya resueltos (cid:... para el correo, data: URI
// para la vista previa), así la misma plantilla sirve para ambos.
const FONT = "Montserrat, 'Segoe UI', Helvetica, Arial, sans-serif";
const C = { text: '#001233', muted: '#33415C', border: '#E6E9EF', soft: '#F5F7FA', link: '#2979FF' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatPercent(value, language) {
  return `${new Intl.NumberFormat(language === 'pt' ? 'pt-BR' : 'es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}%`;
}

function pill(label, color, textColor) {
  return `<span style="display:inline-block;padding:3px 10px;border-radius:9999px;background:${color};color:${textColor};font-family:${FONT};font-size:11px;font-weight:600;line-height:16px;white-space:nowrap;">${esc(label)}</span>`;
}

function dot(color) {
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:9999px;background:${color};vertical-align:middle;"></span>`;
}

function card(innerHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.border};border-radius:16px;background:#FFFFFF;">
<tr><td style="padding:16px;font-size:14px;line-height:1.4;text-align:left;">${innerHtml}</td></tr></table>`;
}

function cardTitle(text) {
  return `<div style="font-family:${FONT};font-size:14px;font-weight:700;color:${C.text};margin:0 0 12px;">${esc(text)}</div>`;
}

function distributionCard(report, images, tx) {
  const legend = report.segments.map((s) => `<tr>
<td style="padding:2px 6px 2px 0;width:14px;">${dot(s.color)}</td>
<td style="padding:2px 0;font-family:${FONT};font-size:12px;color:${C.muted};">${esc(s.label)} (${s.total})</td></tr>`).join('');

  return card(`${cardTitle(tx.distribution)}
<div style="text-align:center;"><img src="${esc(images.chart)}" width="220" height="220" alt="${esc(tx.chartAlt(report.total))}" style="display:block;margin:0 auto;width:220px;max-width:100%;height:auto;border:0;"></div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px auto 0;">${legend}</table>`);
}

function detailCard(report, tx, language) {
  const th = (text, align) => `<th align="${align}" style="padding:6px 4px;border-bottom:2px solid ${C.border};font-family:${FONT};font-size:11px;font-weight:700;color:${C.muted};text-align:${align};text-transform:uppercase;">${esc(text)}</th>`;
  const td = (html, align, extra = '') => `<td align="${align}" style="padding:7px 4px;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:12px;color:${C.text};text-align:${align};${extra}">${html}</td>`;

  const rows = report.rows.map((r) => `<tr>
${td(`${dot(r.color)}&nbsp;&nbsp;${esc(r.label)}`, 'left')}
${td(String(r.total), 'right')}
${td(formatPercent(r.percent, language), 'right', `color:${C.muted};`)}</tr>`).join('');

  const totalRow = `<tr>
${td(`<strong>${esc(tx.total)}</strong>`, 'left', 'border-bottom:0;')}
${td(`<strong>${report.total}</strong>`, 'right', 'border-bottom:0;')}
${td(`<strong>${formatPercent(report.total ? 100 : 0, language)}</strong>`, 'right', 'border-bottom:0;')}</tr>`;

  return card(`${cardTitle(tx.detail)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>${th(tx.status, 'left')}${th(tx.total, 'right')}${th(tx.percent, 'right')}</tr>
${rows}${totalRow}</table>`);
}

function openTicketsCard(report, tx, browseUrl) {
  if (!report.openTickets.length) {
    return card(`${cardTitle(tx.openTickets)}
<div style="font-family:${FONT};font-size:13px;color:${C.muted};padding:8px 0;">${esc(tx.noOpenTickets)}</div>`);
  }

  const th = (text) => `<th align="left" style="padding:6px 4px;border-bottom:2px solid ${C.border};font-family:${FONT};font-size:11px;font-weight:700;color:${C.muted};text-align:left;text-transform:uppercase;">${esc(text)}</th>`;
  const rows = report.openTickets.map((ticket) => `<tr>
<td style="padding:8px 4px;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:12px;white-space:nowrap;vertical-align:top;"><a href="${esc(browseUrl(ticket.key))}" style="color:${C.link};font-weight:600;text-decoration:none;">${esc(ticket.key)}</a></td>
<td style="padding:8px 4px;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:12px;color:${C.text};vertical-align:top;">${esc(ticket.summary)}</td>
<td style="padding:8px 4px;border-bottom:1px solid ${C.border};vertical-align:top;">${pill(ticket.status.label, ticket.status.color, ticket.status.textColor)}</td></tr>`).join('');

  return card(`${cardTitle(`${tx.openTickets} (${report.openTickets.length})`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>${th(tx.key)}${th(tx.summary)}${th(tx.status)}</tr>
${rows}</table>`);
}

function renderReportHtml({ title, cutoffDate, language = 'es', report, images, browseUrl }) {
  const tx = t(language);

  const column = (html) => `<div class="cs-col" style="display:inline-block;width:100%;max-width:316px;vertical-align:top;margin:0 0 8px;">${html}</div>`;

  // Sin tickets: un solo mensaje en lugar de las tarjetas.
  const rows = report.total === 0
    ? `<tr><td>${card(`<div style="font-family:${FONT};font-size:14px;color:${C.muted};text-align:center;padding:24px 0;">${esc(tx.noTickets)}</div>`)}</td></tr>`
    : `<tr><td align="center" style="font-size:0;line-height:0;">
<!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td width="316" valign="top"><![endif]-->
${column(distributionCard(report, images, tx))}<!--[if mso]></td><td width="8"></td><td width="316" valign="top"><![endif]--><div class="cs-gap" style="display:inline-block;width:8px;"></div>${column(detailCard(report, tx, language))}
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
<tr><td style="padding-top:8px;">${openTicketsCard(report, tx, browseUrl)}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="${language === 'pt' ? 'pt-BR' : 'es'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap" rel="stylesheet">
<style>
@media only screen and (max-width: 620px) {
  .cs-col { max-width: 100% !important; }
  .cs-gap { display: none !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${C.soft};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.soft};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;">
<tr><td style="padding:0 0 16px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="vertical-align:middle;padding-right:12px;"><img src="${esc(images.logo)}" height="30" alt="" style="display:block;height:30px;width:auto;border:0;"></td>
    <td style="vertical-align:middle;font-family:${FONT};font-size:20px;font-weight:700;color:${C.text};line-height:26px;">${esc(title)}</td>
  </tr></table>
  <div style="font-family:${FONT};font-size:12px;color:${C.muted};margin-top:6px;">${esc(tx.subtitle(cutoffDate))}</div>
</td></tr>
${rows}
<tr><td align="center" style="padding:24px 0 0;">
  <div style="border-top:1px solid ${C.border};padding-top:20px;"><img src="${esc(images.footer)}" width="160" alt="Janis Commerce" style="display:block;margin:0 auto;width:160px;height:auto;border:0;"></div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { renderReportHtml, esc, formatPercent };
