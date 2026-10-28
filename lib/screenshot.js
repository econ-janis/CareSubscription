const fs = require('node:fs');
const path = require('node:path');

// Captura en PNG de un HTML (el reporte, tal como se ve en el correo) con
// un Chromium sin interfaz. En Vercel se usa @sparticuz/chromium (binario
// para funciones serverless); en local se puede apuntar a otro Chromium con
// CHROME_PATH. Ambos paquetes son ESM-only: se cargan con import()
// dinámico, que sí funciona desde CommonJS (require() no, ver jose).
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
// Ruta fija al binario comprimido de Chromium: así el empaquetado de Vercel
// lo incluye en la función (includeFiles no toma archivos de node_modules).
const CHROMIUM_BIN_DIR = path.join(__dirname, '..', 'node_modules', '@sparticuz', 'chromium', 'bin');

// El HTML usa la fuente del sistema; el Chromium serverless casi no trae
// fuentes, así que se fuerza Inter (la que se ve como system-ui en el
// boceto) embebida, para que la imagen sea igual en cualquier entorno.
function fontCss() {
  const face = (file, weight) => `@font-face{font-family:'CS Inter';font-weight:${weight};src:url(data:font/ttf;base64,${fs.readFileSync(path.join(FONT_DIR, file)).toString('base64')}) format('truetype');}`;
  return `${face('Inter-Regular.ttf', 400)}${face('Inter-SemiBold.ttf', 600)}${face('Inter-Bold.ttf', 700)}
*{font-family:'CS Inter',sans-serif !important;}`;
}

async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer-core');
  if (process.env.CHROME_PATH) {
    return puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  }
  const { default: chromium } = await import('@sparticuz/chromium');
  return puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(CHROMIUM_BIN_DIR), headless: true });
}

// width 1000px: el reporte queda en dos columnas (como en escritorio) y,
// con deviceScaleFactor 2, se ve nítido al ampliarlo en Slack.
async function htmlToPng(html, { width = 1000, scale = 2 } = {}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 800, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 });
    await page.addStyleTag({ content: fontCss() });
    await page.evaluateHandle('document.fonts.ready');
    return Buffer.from(await page.screenshot({ type: 'png', fullPage: true }));
  } finally {
    await browser.close();
  }
}

module.exports = { htmlToPng };
