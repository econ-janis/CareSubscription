const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

// Gráfico de dona en PNG generado en el servidor (los clientes de correo no
// ejecutan JS y muchos no muestran SVG). Geometría y tipografía idénticas al
// boceto aprobado (viewBox 280, R=110, r=78, arranca arriba y gira en
// sentido horario); se rasteriza con resvg usando Inter embebida en el repo
// (la fuente con la que se ve el `system-ui` del boceto), sin fuentes del
// sistema, así el resultado es igual en local y en Vercel.
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_FILES = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf'].map((f) => path.join(FONT_DIR, f));

const DISPLAY_SIZE = 300;
const SCALE = 2;
const SIZE = 280;
const CX = 140;
const CY = 140;
const OUTER_R = 110;
const INNER_R = 78;

// Colores de fondo de la tarjeta y del texto del boceto, en claro y oscuro.
const THEMES = {
  light: { card: '#FFFFFF', text: '#1D2330' },
  dark: { card: '#1D2027', text: '#E6E8EC' },
  // Maqueta del envío agrupado (spec §10): texto central #001233.
  group: { card: '#FFFFFF', text: '#001233' },
};

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function point(radius, angle) {
  return [CX + radius * Math.cos(angle), CY + radius * Math.sin(angle)];
}

function arcPath(start, end) {
  const large = end - start > Math.PI ? 1 : 0;
  const [x0, y0] = point(OUTER_R, start);
  const [x1, y1] = point(OUTER_R, end);
  const [x2, y2] = point(INNER_R, end);
  const [x3, y3] = point(INNER_R, start);
  return `M${x0},${y0}A${OUTER_R},${OUTER_R} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${INNER_R},${INNER_R} 0 ${large} 0 ${x3},${y3}Z`;
}

function label(x, y, value) {
  return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-family="Inter" font-size="12" font-weight="600" fill="#FFFFFF">${value}</text>`;
}

// segments: [{ total, color }], solo con total > 0.
function buildDonutSvg(segments, total, centerLabel, theme = 'light') {
  const colors = THEMES[theme] || THEMES.light;
  const parts = [];
  const middle = (OUTER_R + INNER_R) / 2;

  if (!total) {
    parts.push(`<circle cx="${CX}" cy="${CY}" r="${middle}" fill="none" stroke="#E3E6EB" stroke-width="${OUTER_R - INNER_R}"/>`);
  } else if (segments.length === 1) {
    // Un solo estado: un arco de 360° no se puede dibujar como path.
    parts.push(`<circle cx="${CX}" cy="${CY}" r="${middle}" fill="none" stroke="${segments[0].color}" stroke-width="${OUTER_R - INNER_R}"/>`);
    parts.push(label(...point(middle, -Math.PI / 2), segments[0].total));
  } else {
    let start = -Math.PI / 2;
    for (const s of segments) {
      const end = start + (s.total / total) * 2 * Math.PI;
      parts.push(`<path d="${arcPath(start, end)}" fill="${s.color}" stroke="${colors.card}" stroke-width="2"/>`);
      parts.push(label(...point(middle, (start + end) / 2), s.total));
      start = end;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
${parts.join('\n')}
<text x="${CX}" y="${CY - 6}" text-anchor="middle" font-family="Inter" font-size="34" font-weight="700" fill="${colors.text}">${total}</text>
<text x="${CX}" y="${CY + 20}" text-anchor="middle" font-family="Inter" font-size="13" font-weight="400" fill="${colors.text}">${escapeXml(centerLabel)}</text>
</svg>`;
}

function renderDonutPng(segments, total, centerLabel, theme = 'light') {
  const svg = buildDonutSvg(segments, total, centerLabel, theme);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: DISPLAY_SIZE * SCALE },
    background: (THEMES[theme] || THEMES.light).card,
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  return resvg.render().asPng();
}

module.exports = { buildDonutSvg, renderDonutPng, DISPLAY_SIZE };
