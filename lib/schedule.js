// Programación de envíos: cada suscripción define días de la semana
// (0 = domingo ... 6 = sábado), una hora local "HH:MM" y una zona horaria.
// El dispatcher corre cada hora; en cada corrida busca el último "slot"
// (día+hora local convertido a UTC) que ya pasó y lo envía si todavía no
// se mandó y no pasó más de GRACE_MS (así un cron atrasado o un fallo
// transitorio se recupera en la corrida siguiente, sin mandar slots viejos).
const DEFAULT_TIMEZONE = 'America/Santiago';
const GRACE_MS = 6 * 60 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateSchedule(input = {}) {
  const errors = [];
  const days = [...new Set((input.days || []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  const time = String(input.time || '').trim();
  const timezone = String(input.timezone || DEFAULT_TIMEZONE).trim();

  if (!days.length) errors.push('Elegí al menos un día de la semana');
  if (!TIME_RE.test(time)) errors.push('Hora inválida (formato HH:MM)');
  if (!isValidTimezone(timezone)) errors.push(`Zona horaria inválida: ${timezone}`);

  return { schedule: { days, time, timezone }, errors };
}

// Partes de fecha/hora de `date` vistas en la zona `timezone`.
function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function offsetMs(date, timezone) {
  const p = zonedParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Hora local (en `timezone`) -> instante UTC. Dos pasadas para cubrir
// cambios de horario. Si la hora local no existe (salto de DST), cae en la
// hora inmediata posterior.
function zonedTimeToUtc({ year, month, day, hour, minute }, timezone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - offsetMs(new Date(guess), timezone);
  result = guess - offsetMs(new Date(result), timezone);
  return new Date(result);
}

// Último slot programado <= now (mirando hasta 8 días atrás), o null.
function latestSlot(schedule, now = new Date()) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const local = zonedParts(now, schedule.timezone);

  for (let back = 0; back <= 8; back++) {
    const dayDate = new Date(Date.UTC(local.year, local.month - 1, local.day - back));
    if (!schedule.days.includes(dayDate.getUTCDay())) continue;

    const slot = zonedTimeToUtc({
      year: dayDate.getUTCFullYear(),
      month: dayDate.getUTCMonth() + 1,
      day: dayDate.getUTCDate(),
      hour,
      minute,
    }, schedule.timezone);

    if (slot <= now) return slot;
  }
  return null;
}

// Próximo slot programado > now (hasta 8 días adelante), o null.
function nextSlot(schedule, now = new Date()) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const local = zonedParts(now, schedule.timezone);

  for (let ahead = 0; ahead <= 8; ahead++) {
    const dayDate = new Date(Date.UTC(local.year, local.month - 1, local.day + ahead));
    if (!schedule.days.includes(dayDate.getUTCDay())) continue;

    const slot = zonedTimeToUtc({
      year: dayDate.getUTCFullYear(),
      month: dayDate.getUTCMonth() + 1,
      day: dayDate.getUTCDate(),
      hour,
      minute,
    }, schedule.timezone);

    if (slot > now) return slot;
  }
  return null;
}

// Slot a enviar ahora, o null. `lastSlotAt`: último slot ya procesado;
// `since`: no enviar slots anteriores a esta fecha (ej. creación).
function dueSlot(schedule, { now = new Date(), lastSlotAt = null, since = null } = {}) {
  const slot = latestSlot(schedule, now);
  if (!slot) return null;
  if (now - slot > GRACE_MS) return null;
  if (lastSlotAt && slot <= new Date(lastSlotAt)) return null;
  if (since && slot < new Date(since)) return null;
  return slot;
}

// "28 oct 2026" / "28 out 2026" (formato del boceto aprobado).
function formatDate(date, timezone, language = 'es') {
  const parts = new Intl.DateTimeFormat(language === 'pt' ? 'pt-BR' : 'es-AR', {
    timeZone: timezone,
    day: '2-digit', month: 'short', year: 'numeric',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value.replace(/\./g, '');
  return `${get('day')} ${get('month')} ${get('year')}`;
}

module.exports = { DEFAULT_TIMEZONE, GRACE_MS, validateSchedule, zonedTimeToUtc, latestSlot, nextSlot, dueSlot, formatDate, isValidTimezone };
