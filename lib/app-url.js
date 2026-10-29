// URL pública de la app (APP_URL o, en Vercel, el dominio de producción).
// '' si no se conoce: entonces no hay "Ver en la web" y las imágenes de
// marca van adjuntas por CID.
function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return '';
}

module.exports = { appUrl };
