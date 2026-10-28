const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSchedule, zonedTimeToUtc, latestSlot, dueSlot, GRACE_MS } = require('../lib/schedule');

const santiago = { days: [1, 3], time: '09:00', timezone: 'America/Santiago' };

test('convierte hora local a UTC (horario de verano de Santiago, UTC-3)', () => {
  assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 28, hour: 9, minute: 0 }, 'America/Santiago').toISOString(), '2026-10-28T12:00:00.000Z');
});

test('convierte hora local a UTC (horario de invierno de Santiago, UTC-4)', () => {
  assert.equal(zonedTimeToUtc({ year: 2026, month: 6, day: 15, hour: 9, minute: 0 }, 'America/Santiago').toISOString(), '2026-06-15T13:00:00.000Z');
});

test('último slot: mismo día si ya pasó la hora', () => {
  // miércoles 28/10/2026 12:30 hora Santiago
  assert.equal(latestSlot(santiago, new Date('2026-10-28T15:30:00Z')).toISOString(), '2026-10-28T12:00:00.000Z');
});

test('último slot: día programado anterior si todavía no llegó la hora', () => {
  // miércoles 28/10 08:00 Santiago -> lunes 26/10 09:00
  assert.equal(latestSlot(santiago, new Date('2026-10-28T11:00:00Z')).toISOString(), '2026-10-26T12:00:00.000Z');
});

test('dueSlot respeta slot ya enviado, ventana de gracia y fecha de creación', () => {
  const now = new Date('2026-10-28T12:05:00Z');
  const slot = new Date('2026-10-28T12:00:00Z');

  assert.equal(dueSlot(santiago, { now }).toISOString(), slot.toISOString());
  assert.equal(dueSlot(santiago, { now, lastSlotAt: slot }), null);
  assert.equal(dueSlot(santiago, { now, lastSlotAt: new Date('2026-10-26T12:00:00Z') }).toISOString(), slot.toISOString());
  assert.equal(dueSlot(santiago, { now, since: new Date('2026-10-28T12:01:00Z') }), null);
  assert.equal(dueSlot(santiago, { now: new Date(slot.getTime() + GRACE_MS + 1) }), null);
});

test('validateSchedule', () => {
  assert.deepEqual(validateSchedule({ days: [3, '1', 1, 9], time: '07:30' }).schedule, { days: [1, 3], time: '07:30', timezone: 'America/Santiago' });
  assert.equal(validateSchedule({ days: [], time: '25:00', timezone: 'Mars/Base' }).errors.length, 3);
});
