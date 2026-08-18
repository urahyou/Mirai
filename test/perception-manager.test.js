const assert = require('node:assert/strict');
const test = require('node:test');
const createPerceptionManager = require('../src/services/perception-manager');

test('perception manager applies policy, reports TTL, and clears source data', () => {
  let clock = 1000;
  const calls = [];
  let snapshot = { updatedAt: 1000, value: 'private-local' };
  const source = {
    setTtl: (value) => calls.push(['ttl', value]),
    setEnabled: (value) => calls.push(['enabled', value]),
    start: () => calls.push(['start']),
    stop: () => calls.push(['stop']),
    isRunning: () => true,
    getPermissionStatus: () => 'granted',
    getSnapshot: () => snapshot,
    clear: () => { snapshot = { updatedAt: null }; calls.push(['clear']); },
  };
  const state = { system: { enabled: true, ttlSeconds: 30 } };
  const settings = {
    listSources: () => [{ id: 'system', ...state.system }],
    getSource: (id) => id === 'system' ? { id, ...state.system } : null,
    setSource: (id, patch) => { state[id] = { ...state[id], ...patch }; return { id, ...state[id] }; },
  };
  const manager = createPerceptionManager({ settings, sources: { system: source }, now: () => clock });
  manager.start();
  assert.deepEqual(calls.slice(0, 3), [['ttl', 30000], ['enabled', true], ['start']]);
  assert.equal(manager.get('system').hasData, true);
  clock = 31001;
  assert.equal(manager.get('system').stale, true);
  manager.clear('system');
  assert.equal(manager.get('system').hasData, false);
  manager.set('system', { enabled: false });
  assert.equal(calls.at(-2)[0], 'enabled');
  assert.equal(calls.at(-1)[0], 'stop');
});

test('perception manager reports unavailable registered policy without starting it', () => {
  const manager = createPerceptionManager({
    settings: {
      listSources: () => [{ id: 'screen', enabled: false, ttlSeconds: 300 }],
      getSource: () => ({ id: 'screen', enabled: false, ttlSeconds: 300 }),
    },
  });
  assert.deepEqual(manager.list()[0], {
    id: 'screen', enabled: false, ttlSeconds: 300, available: false,
    running: false, permission: 'unavailable', updatedAt: null, expiresAt: null, stale: false, hasData: false,
  });
  assert.throws(() => manager.set('screen', { enabled: true }), /不可用/);
});
