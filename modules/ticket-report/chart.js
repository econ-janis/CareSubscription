const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

// Gráfico de dona en PNG generado en el servidor (los clientes de correo no
// ejecutan JS y muchos no muestran SVG): se arma un SVG y se rasteriza con
// resvg usando Montserrat embebida en el repo (sin fuentes del sistema, así
// el resultado es igual en local y en Vercel).
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_FILES = [path.join(FONT_DIR, 'Montserrat-Bold.ttf'), path.join(FONT_DIR, 'Montserrat-SemiBold.ttf')];

const DISPLAY_SIZE = 220;
const SCALE = 2;
const OUTER_R = 100;
const INNER_R = 62;
const MIN_LABEL_ANGLE = 0.15; // ~8.6°: segmentos más chicos no llevan número (no entra)

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function polar(cx, cy, r, angle) {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

function arcPath(cx, cy, start, end) {
  const large = end - start > Math.PI ? 1 : 0;
  const [x1, y1] = polar(cx, cy, OUTER_R, start);
  const [x2, y2] = polar(cx, cy, OUTER_R, end);
  const [x3, y3] = polar(cx, cy, INNER_R, end);
  const [x4, y4] = polar(cx, cy, INNER_R, start);
  return `M${x1},${y1} A${OUTER_R},${OUTER_R} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${INNER_R},${INNER_R} 0 ${large} 0 ${x4},${y4} Z`;
}

// segments: [{ total, color, textColor }], solo con total > 0.
function buildDonutSvg(segments, total, centerLabel) {
  const c = 110;
  const parts = [];
  const labels = [];

  if (!total) {
    parts.push(`<circle cx="${c}" cy="${c}" r="${(OUTER_R + INNER_R) / 2}" fill="none" stroke="#E6E9EF" stroke-width="${OUTER_R - INNER_R}"/>`);
  } else if (segments.length === 1) {
    const s = segments[0];
    parts.push(`<circle cx="${c}" cy="${c}" r="${(OUTER_R + INNER_R) / 2}" fill="none" stroke="${s.color}" stroke-width="${OUTER_R - INNER_R}"/>`);
    const [lx, ly] = polar(c, c, (OUTER_R + INNER_R) / 2, 0);
    labels.push({ x: lx, y: ly, value: s.total, color: s.textColor });
  } else {
    let angle = 0;
    for (const s of segments) {
      const sweep = (s.total / total) * Math.PI * 2;
      parts.push(`<path d="${arcPath(c, c, angle, angle + sweep)}" fill="${s.color}" stroke="#FFFFFF" stroke-width="2"/>`);
      if (sweep >= MIN_LABEL_ANGLE) {
        const [lx, ly] = polar(c, c, (OUTER_R + INNER_R) / 2, angle + sweep / 2);
        labels.push({ x: lx, y: ly, value: s.total, color: s.textColor });
      }
      angle += sweep;
    }
  }

  const labelSvg = labels.map((l) => `<text x="${l.x.toFixed(1)}" y="${(l.y + 5).toFixed(1)}" text-anchor="middle" font-family="Montserrat" font-weight="700" font-size="14" fill="${l.color}">${l.value}</text>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
${parts.join('\n')}
${labelSvg}
<text x="${c}" y="${c + 6}" text-anchor="middle" font-family="Montserrat" font-weight="700" font-size="34" fill="#001233">${total}</text>
<text x="${c}" y="${c + 26}" text-anchor="middle" font-family="Montserrat" font-weight="600" font-size="12" fill="#33415C">${escapeXml(centerLabel)}</text>
</svg>`;
}

function renderDonutPng(segments, total, centerLabel) {
  const svg = buildDonutSvg(segments, total, centerLabel);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: DISPLAY_SIZE * SCALE },
    background: '#FFFFFF',
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Montserrat' },
  });
  return resvg.render().asPng();
}

module.exports = { buildDonutSvg, renderDonutPng, DISPLAY_SIZE };
