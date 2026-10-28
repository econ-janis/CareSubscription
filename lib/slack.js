const { withRetry } = require('./retry');

// Slack con Bot Token (chat.postMessage), igual que JanisHacks: se puede
// reusar el mismo bot. Scope: chat:write (y el bot invitado al canal, o
// chat:write.public para canales públicos). Opcional: sin SLACK_BOT_TOKEN
// el botón "Avisar en Slack" queda deshabilitado.
// Por defecto #care-test para validar el formato; en producción, SLACK_CHANNEL=#care-talks (o su ID).
const DEFAULT_CHANNEL = '#care-test';

const HINTS = {
  not_in_channel: 'invitá al bot al canal',
  channel_not_found: 'invitá al bot al canal o revisá SLACK_CHANNEL',
  missing_scope: 'al bot le falta el permiso chat:write',
  invalid_auth: 'revisá SLACK_BOT_TOKEN',
};

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

// `text`: mensaje en mrkdwn. Los links se ven sin vista previa.
async function postMessage(text, channel = slackChannel()) {
  if (!isSlackConfigured()) throw new SlackError('Slack no está configurado (falta SLACK_BOT_TOKEN)');

  return withRetry(async () => {
    let response;
    try {
      response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text, mrkdwn: true, unfurl_links: false, unfurl_media: false }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw new SlackError(`No se pudo conectar con Slack: ${error.message}`, { transient: true });
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.ok) {
      const detail = payload && payload.error ? payload.error : `HTTP ${response.status}`;
      const hint = HINTS[detail] ? ` (${HINTS[detail]})` : '';
      throw new SlackError(`Slack respondió ${detail}${hint}`, { transient: response.status === 429 || response.status >= 500 });
    }
    return payload;
  }, { label: 'Slack chat.postMessage', isTransient: (error) => error instanceof SlackError && error.transient });
}

module.exports = { isSlackConfigured, slackChannel, postMessage, SlackError };
