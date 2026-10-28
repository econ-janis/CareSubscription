const nodemailer = require('nodemailer');
const { withRetry } = require('./retry');

// Envío por SMTP (sirve tanto para AWS SES vía SMTP como para cualquier
// otro relay). Credenciales en variables de entorno. Es opcional: sin
// SMTP_HOST/SMTP_USER/SMTP_PASSWORD la app funciona solo con vista previa y
// el dispatcher no envía nada.
let transport = null;

function isMailConfigured() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD } = process.env;
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASSWORD);
}

function getTransport() {
  if (!transport) {
    if (!isMailConfigured()) throw new Error('El envío de correo no está configurado (faltan SMTP_HOST / SMTP_USER / SMTP_PASSWORD)');
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
    const port = Number(SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  return transport;
}

function mailFrom() {
  return process.env.MAIL_FROM || 'Janis Care <care@janiscommerce.com>';
}

// Errores SMTP 5xx (destinatario/mensaje rechazado) son definitivos; el
// resto (red, 4xx temporales) se reintentan.
function isTransientSmtpError(error) {
  const code = Number(error.responseCode || 0);
  return !(code >= 500 && code < 600);
}

// `to` va en Bcc para no exponer la lista de destinatarios (pueden ser de
// áreas o empresas distintas) a todos los que reciben el reporte.
// Content-Language declara el idioma real del correo: sin él, Gmail puede
// tomar el reporte por inglés (títulos como "Care Weekly Status") y
// traducirlo automáticamente.
async function sendMail({ to, subject, html, text, attachments = [], language = 'es' }) {
  const headers = { 'Content-Language': language === 'pt' ? 'pt-BR' : 'es' };
  return withRetry(
    () => getTransport().sendMail({ from: mailFrom(), to: mailFrom(), bcc: to, subject, html, text, attachments, headers }),
    { label: 'envío SMTP', isTransient: isTransientSmtpError, baseDelayMs: 2000 },
  );
}

module.exports = { sendMail, isMailConfigured };
