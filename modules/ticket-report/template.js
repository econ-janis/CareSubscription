const { t } = require('./i18n');

// HTML del correo, réplica del boceto aprobado
// (care-weekly-status-carrefour-ar.html) en formato apto para correo:
// tablas + estilos inline (Gmail/Outlook), sin JS ni SVG.
//
// - Ancho fluido hasta 1180px; la fila de tarjetas es una tabla con la
//   columna de la dona fija en 360px (322 + padding + borde) y el detalle ocupando el resto (como
//   `grid-template-columns: 360px 1fr`). Las tarjetas son las celdas, así
//   quedan del mismo alto. Por debajo de 820px pasan a una sola columna.
// - Modo oscuro con `prefers-color-scheme` (Apple Mail, Outlook app, etc.;
//   Gmail lo ignora y muestra el claro), con dona y logo del footer en
//   versión oscura.
//
// translate="no" / notranslate: el reporte ya está en el idioma de la
// suscripción; sin esto Gmail lo traducía solo ("Status" -> "Estado de",
// "Por Hacer" -> "Por hacer", "0.0%" -> "0,0%").
//
// `images` trae los src ya resueltos (cid:... para el correo, data: URI
// para la vista previa), así la misma plantilla sirve para ambos.
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const C = { bg: '#F6F7F9', card: '#FFFFFF', text: '#1D2330', muted: '#6B7385', border: '#E3E6EB', link: '#2979FF' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

const CARD_STYLE = `background:${C.card};border:1px solid ${C.border};border-radius:10px;padding:18px;vertical-align:top;font-family:${FONT};font-size:14px;line-height:1.45;color:${C.text};`;

function cardTitle(text) {
  return `<h2 class="cs-tx" style="font-family:${FONT};font-size:15px;font-weight:700;line-height:1.45;color:${C.text};margin:0 0 12px;">${esc(text)}</h2>`;
}

function dot(color) {
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:8px;vertical-align:middle;"></span>`;
}

function pill(label, color, textColor) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${color};color:${textColor};font-family:${FONT};font-size:12px;font-weight:600;line-height:1.45;white-space:nowrap;">${esc(label)}</span>`;
}

function th(text, align = 'left') {
  return `<th class="cs-mut cs-bd" align="${align}" style="text-align:${align};padding:8px 10px;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:12px;font-weight:600;line-height:1.45;color:${C.muted};text-transform:uppercase;letter-spacing:.02em;vertical-align:top;">${esc(text)}</th>`;
}

function td(html, { align = 'left', nowrap = false } = {}) {
  return `<td class="cs-tx cs-bd" align="${align}" style="text-align:${align};padding:8px 10px;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:14px;line-height:1.45;color:${C.text};vertical-align:top;${align === 'right' ? 'font-variant-numeric:tabular-nums;' : ''}${nowrap ? 'white-space:nowrap;' : ''}">${html}</td>`;
}

// Igual que `.tblwrap` del boceto: si la tabla no entra (ej. celular), se
// desplaza horizontalmente dentro de la tarjeta en vez de ensanchar el correo.
function table(rowsHtml) {
  return `<div style="overflow-x:auto;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rowsHtml}</table></div>`;
}

// Imagen con variante oscura: la clara se ve por defecto y la oscura solo
// con prefers-color-scheme: dark (mso-hide la oculta en Outlook escritorio).
function themedImage(lightSrc, darkSrc, attrs, style) {
  return `<img class="cs-light" src="${esc(lightSrc)}" ${attrs} style="${style}">`
    + `<div class="cs-dark" style="display:none;mso-hide:all;"><img src="${esc(darkSrc)}" ${attrs} style="${style}"></div>`;
}

function distributionCard(report, images, tx) {
  const legend = report.segments.map((s) => `<span class="cs-tx" style="display:inline-block;margin:0 7px;white-space:nowrap;font-family:${FONT};font-size:14px;color:${C.text};">${dot(s.color)}${esc(s.label)}</span>`).join('');

  return `${cardTitle(tx.distribution)}
${themedImage(images.chart, images.chartDark, `width="300" alt="${esc(tx.chartAlt(report.total))}"`, 'display:block;margin:0 auto;width:300px;max-width:100%;height:auto;border:0;')}
<div style="text-align:center;margin-top:8px;">${legend}</div>`;
}

function detailCard(report, tx) {
  const rows = report.rows.map((r) => `<tr>${td(`${dot(r.color)}${esc(r.label)}`)}${td(`<b>${r.total}</b>`, { align: 'right' })}${td(formatPercent(r.percent), { align: 'right' })}</tr>`).join('');
  const totalRow = `<tr>${td(`<b>${esc(tx.total)}</b>`)}${td(`<b>${report.total}</b>`, { align: 'right' })}${td(report.total ? '100%' : formatPercent(0), { align: 'right' })}</tr>`;

  return `${cardTitle(tx.detail)}
${table(`<tr>${th(tx.status)}${th(tx.total, 'right')}${th(tx.percent, 'right')}</tr>${rows}${totalRow}`)}`;
}

function openTicketsCard(report, tx, browseUrl) {
  const rows = report.openTickets.length
    ? report.openTickets.map((ticket) => `<tr>
${td(`<a href="${esc(browseUrl(ticket.key))}" target="_blank" style="color:${C.link};text-decoration:none;white-space:nowrap;">${esc(ticket.key)}</a>`, { nowrap: true })}
${td(esc(ticket.summary))}
${td(pill(ticket.status.label, ticket.status.color, ticket.status.textColor), { nowrap: true })}</tr>`).join('')
    : `<tr><td class="cs-tx cs-bd" colspan="3" style="padding:8px 10px;border-bottom:1px solid ${C.border};font-family:${FONT};font-size:14px;color:${C.text};">${esc(tx.noOpenTickets)}</td></tr>`;

  return `${cardTitle(tx.openTickets)}
${table(`<tr>${th(tx.key)}${th(tx.summary)}${th(tx.status)}</tr>${rows}`)}`;
}

function renderReportHtml({ title, cutoffDate, language = 'es', report, images, browseUrl }) {
  const tx = t(language);

  const content = report.total === 0
    ? `<tr><td class="cs-card" style="${CARD_STYLE}"><span class="cs-mut" style="color:${C.muted};">${esc(tx.noTickets)}</span></td></tr>`
    : `<tr><td style="padding:0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;table-layout:fixed;">
    <tr>
      <td class="cs-card cs-col" width="322" style="${CARD_STYLE}width:322px;">${distributionCard(report, images, tx)}</td>
      <td class="cs-gap" width="16" style="width:16px;font-size:0;line-height:0;">&nbsp;</td>
      <td class="cs-card cs-col cs-col-2" style="${CARD_STYLE}">${detailCard(report, tx)}</td>
    </tr>
  </table>
</td></tr>
<tr><td style="height:16px;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td class="cs-card" style="${CARD_STYLE}">${openTicketsCard(report, tx, browseUrl)}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="${language === 'pt' ? 'pt-BR' : 'es'}" translate="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="google" content="notranslate">
<title>${esc(title)}</title>
<style>
@media only screen and (max-width: 820px) {
  .cs-col { display: block !important; width: auto !important; }
  .cs-gap { display: none !important; }
  .cs-col-2 { margin-top: 16px !important; }
}
@media only screen and (max-width: 680px) {
  .cs-hdr-logo { display: block !important; margin: 0 0 16px !important; width: auto !important; }
}
@media (prefers-color-scheme: dark) {
  .cs-bg { background: #14161B !important; }
  .cs-card { background: #1D2027 !important; border-color: #2C303A !important; }
  .cs-tx { color: #E6E8EC !important; }
  .cs-mut { color: #9AA1AE !important; }
  .cs-bd { border-color: #2C303A !important; }
  .cs-light { display: none !important; }
  .cs-dark { display: block !important; }
}
</style>
</head>
<body class="cs-bg notranslate" translate="no" style="margin:0;padding:0;background:${C.bg};">
<table class="cs-bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${C.bg};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:1180px;table-layout:fixed;">
<tr><td style="padding:0 0 4px;font-size:0;line-height:0;">
  <span class="cs-hdr-logo" style="display:inline-block;vertical-align:middle;margin-right:16px;">${(images.logos || [images.logo]).map((src, i) => `<img src="${esc(src)}" height="30" alt="" style="display:inline-block;vertical-align:middle;height:30px;width:auto;border:0;${i ? 'margin-left:8px;' : ''}">`).join('')}</span><h1 class="cs-tx" style="display:inline-block;vertical-align:middle;margin:0;font-family:${FONT};font-size:22px;font-weight:700;line-height:1.45;color:${C.text};">${esc(title)}</h1>
</td></tr>
<tr><td class="cs-mut" style="padding:0 0 20px;font-family:${FONT};font-size:14px;line-height:1.45;color:${C.muted};">${esc(tx.subtitle(cutoffDate))}</td></tr>
${content}
<tr><td style="padding-top:16px;">
  <table class="cs-bd" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid ${C.border};">
    <tr><td align="center" style="padding:28px 0 8px;">${themedImage(images.footer, images.footerDark, 'height="32" alt="Janis Commerce"', 'display:block;margin:0 auto;height:32px;width:auto;border:0;')}</td></tr>
  </table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { renderReportHtml, esc, formatPercent };
