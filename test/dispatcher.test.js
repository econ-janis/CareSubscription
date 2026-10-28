const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Dispatcher con db y runner simulados (sin red ni base de datos).
function loadDispatcher({ subscriptions, outcomes }) {
  const calls = { marked: [], runs: [] };
  const byId = new Map(subscriptions.map((s) => [s.id, s]));
  const stub = (file, exports) => {
    const id = require.resolve(path.join(__dirname, '..', file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('lib/db.js', {
    listActiveSubscriptions: async () => subscriptions,
    getSubscription: async (id) => byId.get(id),
    acquireLock: async () => true,
    releaseLock: async () => {},
    markSlotDone: async (id, slot) => calls.marked.push([id, slot.toISOString()]),
  });
  stub('lib/runner.js', {
    runSubscription: async (s, options) => {
      calls.runs.push([s.id, options.slotAt.toISOString()]);
      return outcomes[s.id];
    },
  });
  delete require.cache[require.resolve('../lib/dispatcher')];
  return { dispatch: require('../lib/dispatcher').dispatch, calls };
}

const base = { active: true, schedule: { days: [3], time: '09:00', timezone: 'America/Santiago' }, createdAt: '2026-01-01T00:00:00Z' };

test('envía slots pendientes; un fallo transitorio no marca el slot (se reintenta)', async () => {
  const { dispatch, calls } = loadDispatcher({
    subscriptions: [
      { ...base, id: 1, lastSlotAt: null },
      { ...base, id: 2, lastSlotAt: '2026-10-28T12:00:00Z' },
      { ...base, id: 3, lastSlotAt: null },
      { ...base, id: 4, lastSlotAt: null },
    ],
    outcomes: { 1: { result: 'ok' }, 3: { result: 'error', transient: true }, 4: { result: 'error', transient: false } },
  });

  const summary = await dispatch({ now: new Date('2026-10-28T12:10:00Z') });

  assert.deepEqual(calls.runs.map(([id]) => id), [1, 3, 4]);
  assert.deepEqual(calls.marked.map(([id]) => id), [1, 4]);
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 2);
});
