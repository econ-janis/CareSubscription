const { withRetry } = require('./retry');

// Slack con Bot Token, igual que JanisHacks: se puede reusar el mismo bot,
// invitándolo al canal. Scopes: chat:write y files:write (más
// channels:read si SLACK_CHANNEL es un nombre y no un ID). Opcional: sin
// SLACK_BOT_TOKEN el botón "Avisar en Slack" queda deshabilitado.
// Por defecto #care-test para validar el formato; en producción, SLACK_CHANNEL=#care-talks (o su ID).
const DEFAULT_CHANNEL = '#care-test';

function isSlackConfigured() {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

function slackChannel() {
  return (process.env.SLACK_CHANNEL || DEFAULT_CHANNEL).trim();
}

class SlackError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.name = 'SlackError';
    this.transient = transient;
  }
}

const HINTS = {
  not_in_channel: 'invitá al bot al canal',
  channel_not_found: 'invitá al bot al canal o revisá SLACK_CHANNEL',
  missing_scope: 'al bot le falta un permiso: chat:write, files:write (y channels:read si SLACK_CHANNEL es un nombre)',
  invalid_auth: 'revisá SLACK_BOT_TOKEN',
};

async function slackFetch(url, init, label) {
  return withRetry(async () => {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    } catch (error) {
      throw new SlackError(`No se pudo conectar con Slack: ${error.message}`, { transient: true });
    }
    return response;
  }, { label, isTransient: (error) => error instanceof SlackError && error.transient });
}

// Llamada a la Web API (JSON o form). Tira SlackError con una pista si falla.
async function slackApi(method, { json, form } = {}) {
  if (!isSlackConfigured()) throw new SlackError('Slack no está configurado (falta SLACK_BOT_TOKEN)');
  const headers = { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` };
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(json);
  } else if (form) {
    body = new URLSearchParams(form);
  }

  const response = await slackFetch(`https://slack.com/api/${method}`, { method: 'POST', headers, body }, `Slack ${method}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !payload.ok) {
    const detail = payload && payload.error ? payload.error : `HTTP ${response.status}`;
    const hint = HINTS[detail] ? ` (${HINTS[detail]})` : '';
    throw new SlackError(`Slack respondió ${detail} en ${method}${hint}`);
  }
  return payload;
}

// La subida de archivos exige el ID del canal (C…/G…). Si SLACK_CHANNEL es
// un nombre (ej. #care-test), se busca su ID (requiere channels:read).
async function resolveChannelId(channel = slackChannel()) {
  if (/^[CG][A-Z0-9]{6,}$/.test(channel)) return channel;
  const name = channel.replace(/^#/, '');
  let cursor = '';
  do {
    const page = await slackApi('conversations.list', { form: { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000', ...(cursor ? { cursor } : {}) } });
    const found = (page.channels || []).find((c) => c.name === name);
    if (found) return found.id;
    cursor = page.response_metadata && page.response_metadata.next_cursor;
  } while (cursor);
  throw new SlackError(`No se encontró el canal ${channel}: cargá su ID en SLACK_CHANNEL (Slack → detalles del canal → ID) o invitá al bot`);
}

// Sube una imagen al canal con un comentario (mrkdwn): flujo de archivos
// actual de Slack (getUploadURLExternal -> subida -> completeUploadExternal).
async function uploadImage({ png, filename, title, comment, channel = slackChannel() }) {
  const channelId = await resolveChannelId(channel);
  const { upload_url: uploadUrl, file_id: fileId } = await slackApi('files.getUploadURLExternal', { form: { filename, length: String(png.length) } });

  const upload = await slackFetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png }, 'Slack subida de archivo');
  if (!upload.ok) throw new SlackError(`Slack rechazó la subida del archivo (HTTP ${upload.status})`);

  await slackApi('files.completeUploadExternal', { json: { files: [{ id: fileId, title }], channel_id: channelId, initial_comment: comment } });
  return { channel, channelId };
}

module.exports = { isSlackConfigured, slackChannel, uploadImage, SlackError };
