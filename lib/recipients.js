// Control de destinatarios: formato de correo + lista de dominios
// permitidos. Los dominios globales salen de ALLOWED_RECIPIENT_DOMAINS
// (por defecto janiscommerce.com); a eso se suman los dominios del cliente
// cargados para la Organization (tabla organization_domains).
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function globalAllowedDomains() {
  return String(process.env.ALLOWED_RECIPIENT_DOMAINS || 'janiscommerce.com')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeDomains(list) {
  const domains = (Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/))
    .map((d) => String(d).trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  const invalid = domains.filter((d) => !DOMAIN_RE.test(d));
  return { domains: [...new Set(domains)], invalid };
}

function parseRecipients(list) {
  return [...new Set(
    (Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/))
      .map((e) => String(e).trim().toLowerCase())
      .filter(Boolean),
  )];
}

// Devuelve { recipients, errors }. Solo dirección pura (sin "Nombre <...>"
// ni comentarios), para que no haya ambigüedad sobre el dominio real.
function validateRecipients(list, organizationDomains = []) {
  const recipients = parseRecipients(list);
  const allowed = new Set([...globalAllowedDomains(), ...organizationDomains.map((d) => d.toLowerCase())]);
  const errors = [];

  if (!recipients.length) errors.push('Agregá al menos un destinatario');

  for (const email of recipients) {
    const match = EMAIL_RE.exec(email);
    if (!match) {
      errors.push(`Correo inválido: ${email}`);
    } else if (!allowed.has(match[1])) {
      errors.push(`Dominio no permitido: ${email} (permitidos: ${[...allowed].join(', ')})`);
    }
  }

  return { recipients, errors };
}

module.exports = { validateRecipients, normalizeDomains, globalAllowedDomains, parseRecipients };
