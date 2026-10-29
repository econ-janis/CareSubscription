// HTML del envío agrupado v2 (caresubscribe-correo-agrupado-v2.md, reemplaza
// spec §10.2), réplica de la maqueta aprobada
// (care-weekly-status-opcion-b-graficos.html) en formato apto para correo:
// tablas role="presentation", estilos inline, ancho máx. 680 px, sin
// <style>, JS ni SVG.
//
// - Header: isotipo de Janis + título, subtítulo con la fecha de corte y
//   "Ver en la web ↗" (solo en el correo: la landing es esta misma vista).
// - Tabla resumen: una fila por Organization (logo + nombre enlazado a su
//   sección + barra apilada por estado), Total / Resueltos / Abiertos y fila
//   Total; debajo, la leyenda de colores.
// - Una sección por Organization (#org-<slug>): separador, logo + nombre
//   visible, dona chica + KPI, tarjeta "Tickets Abiertos" y "↑ Volver arriba".
//
// Colores de pills y puntos: background-color inline; barras y separadores:
// además bgcolor de celda (Gmail y Outlook descartan otros fondos). Los src
// de las imágenes vienen resueltos (URL, cid:… o data: URI en la landing /
// vista previa): nunca base64 dentro del correo (Gmail recorta
// el HTML de más de ~102 KB).
const FONT = 'Montserrat, Arial, Helvetica, sans-serif';
const C = { bg: '#F4F6F9', card: '#FFFFFF', text: '#001233', muted: '#33415C', border: '#E3E6EB', rowBorder: '#EEF0F3', link: '#2979FF', separator: '#A9B2C0' };
const TOP_ANCHOR = 'inicio';

const TEXTS = {
  es: {
    subtitle: (date) => `Tickets creados en los últimos 3 meses · Corte: ${date}`,
    web: 'Ver en la web ↗',
    top: '↑ Volver arriba',
    failed: 'No se pudo obtener la información.',
    client: 'Cliente',
    total: 'Total',
    resolved: 'Resueltos',
    open: 'Abiertos',
    openTickets: 'Tickets Abiertos',
    noOpenTickets: 'Sin tickets abiertos.',
    kpi: (total, resolved, percent, open) => `${total} ${total === 1 ? 'ticket' : 'tickets'} · ${resolved} ${resolved === 1 ? 'resuelto' : 'resueltos'} (${percent} %) · <b>${open} ${open === 1 ? 'abierto' : 'abiertos'}</b>`,
    cancelled: (n) => `${n} ${n === 1 ? 'cancelado' : 'cancelados'}`,
    chartAlt: (total) => `Distribución por estado: ${total} tickets`,
  },
  pt: {
    subtitle: (date) => `Tickets criados nos últimos 3 meses · Corte: ${date}`,
    web: 'Ver na web ↗',
    top: '↑ Voltar ao topo',
    failed: 'Não foi possível obter as informações.',
    client: 'Cliente',
    total: 'Total',
    resolved: 'Resolvidos',
    open: 'Abertos',
    openTickets: 'Tickets Abertos',
    noOpenTickets: 'Sem tickets abertos.',
    kpi: (total, resolved, percent, open) => `${total} ${total === 1 ? 'ticket' : 'tickets'} · ${resolved} ${resolved === 1 ? 'resolvido' : 'resolvidos'} (${percent} %) · <b>${open} ${open === 1 ? 'aberto' : 'abertos'}</b>`,
    cancelled: (n) => `${n} ${n === 1 ? 'cancelado' : 'cancelados'}`,
    chartAlt: (total) => `Distribuição por status: ${total} tickets`,
  },
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

function dot(color) {
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background-color:${color};font-size:0;line-height:0;vertical-align:middle;">&nbsp;</span>`;
}

// Leyenda: [{ label, color, total? }] (total solo en la de cada sección).
function legend(items) {
  return items.map((s) => `<span style="white-space:nowrap;">${dot(s.color)}&nbsp;${esc(s.label)}${s.total === undefined ? '' : ` <b>${s.total}</b>`}</span>`).join(' &nbsp; ');
}

// Pill: <span> con background-color, color, padding y border-radius inline
// (Gmail descarta los fondos que no van así).
function pill(status) {
  return `<span style="background-color:${status.color};color:${status.textColor};border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;font-family:${FONT};white-space:nowrap;">${esc(status.label)}</span>`;
}

// Barra apilada (§3.1): una celda por estado con valor, ancho proporcional.
function stackedBar(segments, total) {
  if (!total || !segments.length) return '';
  const cells = segments.map((s) => `<td width="${((s.total * 100) / total).toFixed(2)}%" height="8" bgcolor="${s.color}" style="background-color:${s.color};font-size:0;line-height:0;">&nbsp;</td>`).join('');
  return `<table ${TABLE} width="100%" style="margin-top:6px;border-radius:999px;overflow:hidden;max-width:220px;border-collapse:collapse;"><tr>${cells}</tr></table>`;
}

function logosHtml(logos, size) {
  return logos.map((src, i) => `<img src="${esc(src)}" height="${size}" alt="" style="display:inline-block;vertical-align:middle;height:${size}px;width:auto;border:0;${i ? 'margin-left:4px;' : ''}">`).join('');
}

const TH = `padding:8px;border-bottom:2px solid ${C.border};font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.03em;font-family:${FONT};`;
const CELL = `padding:10px 8px;border-bottom:1px solid ${C.border};font-family:${FONT};`;

// section: { slug, name, title, logos, chart, stats | null, segments, openTickets }
function summaryRow(section) {
  const name = `${logosHtml(section.logos, 24)}&nbsp;&nbsp;<a href="#org-${esc(section.slug)}" style="color:${C.link};text-decoration:none;font-weight:600;vertical-align:middle;">${esc(section.name)}</a>`;
  const st = section.stats;
  const num = (value, bold = false) => `<td align="right" style="${CELL}${bold ? 'font-weight:700;' : ''}">${st ? value : '—'}</td>`;
  return `<tr><td style="${CELL}">${name}${st ? stackedBar(section.segments, st.total) : ''}</td>${num(st && st.total)}${num(st && st.resolved)}${num(st && st.open, true)}</tr>`;
}

function summaryTable(sections, gx) {
  const ok = sections.filter((s) => s.stats);
  const sum = (field) => ok.reduce((acc, s) => acc + s.stats[field], 0);
  const totalCell = (value, align = 'right') => `<td align="${align}" style="padding:10px 8px;font-weight:700;font-family:${FONT};">${value}</td>`;
  return `<table ${TABLE} width="100%" style="background-color:${C.card};border:1px solid ${C.border};border-radius:12px;padding:8px 12px;font-size:14px;border-collapse:separate;">
<tr><th align="left" style="${TH}">${esc(gx.client)}</th><th align="right" style="${TH}">${esc(gx.total)}</th><th align="right" style="${TH}">${esc(gx.resolved)}</th><th align="right" style="${TH}">${esc(gx.open)}</th></tr>
${sections.map(summaryRow).join('\n')}
<tr>${totalCell(esc(gx.total), 'left')}${totalCell(sum('total'))}${totalCell(sum('resolved'))}${totalCell(sum('open'))}</tr>
</table>`;
}

function kpiBlock(section, gx) {
  const st = section.stats;
  const percent = st.total ? Math.round((st.resolved * 100) / st.total) : 0;
  const line = `${gx.kpi(st.total, st.resolved, percent, st.open)}${st.cancelled ? ` · ${esc(gx.cancelled(st.cancelled))}` : ''}`;
  const chart = section.chart
    ? `<img src="${esc(section.chart)}" width="96" height="96" alt="${esc(gx.chartAlt(st.total))}" style="display:block;width:96px;height:96px;border:0;">`
    : '';
  return `<tr><td style="padding:6px 0 12px;"><table ${TABLE}><tr>
<td width="100" valign="middle" style="width:100px;">${chart}</td>
<td valign="middle" style="padding-left:14px;color:${C.muted};font-size:13px;line-height:1.7;font-family:${FONT};">${line}${section.segments.length ? `<br>${legend(section.segments)}` : ''}</td>
</tr></table></td></tr>`;
}

function openTicketsCard(section, gx, browseUrl) {
  const td = `padding:7px 8px;border-bottom:1px solid ${C.rowBorder};font-family:${FONT};`;
  const rows = section.openTickets.length
    ? section.openTickets.map((ticket) => `<tr><td valign="top" style="${td}white-space:nowrap;"><a href="${esc(browseUrl(ticket.key))}" target="_blank" style="color:${C.link};text-decoration:none;">${esc(ticket.key)}</a></td><td style="${td}">${esc(ticket.summary)}</td><td valign="top" align="right" style="${td}white-space:nowrap;">${pill(ticket.status)}</td></tr>`).join('\n')
    : `<tr><td colspan="3" style="${td}color:${C.muted};">${esc(gx.noOpenTickets)}</td></tr>`;
  return `<tr><td><table ${TABLE} width="100%" style="background-color:${C.card};border:1px solid ${C.border};border-radius:12px;padding:4px 12px 10px;font-size:14px;border-collapse:separate;">
<tr><td colspan="3" style="padding:12px 8px 8px;font-size:15px;font-weight:700;color:${C.text};font-family:${FONT};">${esc(gx.openTickets)}</td></tr>
${rows}
</table></td></tr>`;
}

function sectionHtml(section, gx, browseUrl) {
  const anchor = `org-${section.slug}`;
  const body = section.stats
    ? `${kpiBlock(section, gx)}\n${openTicketsCard(section, gx, browseUrl)}`
    : `<tr><td style="padding:6px 0 0;"><table ${TABLE} width="100%" style="background-color:${C.card};border:1px solid ${C.border};border-radius:12px;border-collapse:separate;"><tr><td style="padding:16px;color:${C.muted};font-size:14px;font-family:${FONT};">${esc(gx.failed)}</td></tr></table></td></tr>`;
  return `<tr><td style="padding:28px 0 0;"><table ${TABLE} width="100%"><tr><td height="6" bgcolor="${C.separator}" style="background-color:${C.separator};border-radius:999px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
<tr><td id="${esc(anchor)}" style="padding:18px 0 4px;"><a name="${esc(anchor)}" id="${esc(anchor)}-a"></a>${logosHtml(section.logos, 30)}&nbsp;&nbsp;<span style="font-size:18px;font-weight:700;vertical-align:middle;">${esc(section.title)}</span></td></tr>
${body}
<tr><td align="right" style="padding:8px 0;font-size:12px;"><a href="#${TOP_ANCHOR}" style="color:${C.link};text-decoration:none;">${esc(gx.top)}</a></td></tr>`;
}

// legendItems: todos los estados en el orden del gráfico [{ label, color }].
// mode 'email': incluye "Ver en la web ↗" (si hay webUrl). mode 'web': la landing.
function renderGroupHtml({ title, cutoffDate, language = 'es', sections, legendItems = [], images, webUrl = '', mode = 'email', browseUrl }) {
  const gx = TEXTS[language] || TEXTS.es;
  const webLink = mode === 'email' && webUrl
    ? `<tr><td style="padding:0 0 16px;font-size:12px;"><a href="${esc(webUrl)}" target="_blank" style="color:${C.link};">${esc(gx.web)}</a></td></tr>`
    : '<tr><td style="padding:0 0 12px;font-size:0;line-height:0;">&nbsp;</td></tr>';

  return `<!DOCTYPE html>
<html lang="${language === 'pt' ? 'pt-BR' : 'es'}" translate="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="google" content="notranslate">
<title>${esc(title)}</title>
</head>
<body class="notranslate" translate="no" style="margin:0;padding:0;background-color:${C.bg};color:${C.text};font-family:${FONT};">
<table ${TABLE} width="100%" bgcolor="${C.bg}" style="width:100%;background-color:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table ${TABLE} width="100%" style="width:100%;max-width:680px;font-family:${FONT};color:${C.text};">
<tr><td id="${TOP_ANCHOR}"><a name="${TOP_ANCHOR}" id="${TOP_ANCHOR}-a"></a><img src="${esc(images.iso)}" height="32" alt="Janis" style="height:32px;width:auto;border:0;vertical-align:middle;">&nbsp;&nbsp;<span style="font-size:22px;font-weight:700;vertical-align:middle;">${esc(title)}</span></td></tr>
<tr><td style="padding:6px 0 4px;color:${C.muted};font-size:13px;">${esc(gx.subtitle(cutoffDate))}</td></tr>
${webLink}
<tr><td>${summaryTable(sections, gx)}</td></tr>
<tr><td style="padding:8px 4px 0;font-size:12px;color:${C.muted};">${legend(legendItems)}</td></tr>
${sections.map((s) => sectionHtml(s, gx, browseUrl)).join('\n')}
<tr><td align="center" style="border-top:1px solid ${C.border};padding:24px 0 8px;"><img src="${esc(images.footer)}" height="32" alt="Janis Commerce" style="display:block;margin:0 auto;height:32px;width:auto;border:0;"></td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

module.exports = { renderGroupHtml, TOP_ANCHOR, TEXTS };
