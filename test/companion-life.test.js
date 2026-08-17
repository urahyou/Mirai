const assert = require('node:assert/strict');
const test = require('node:test');

const createCompanionLife = require('../src/services/companion-life');

test('companion life advances through Python and exposes a compact prompt summary', async () => {
  const calls = [];
  const backend = {
    getStatus: () => ({ ready: true }),
    request: async (method, params) => {
      calls.push([method, params]);
      return { currentActivityId: 'study', location: 'home', health: 88, energy: 70, hunger: 32, boredom: 12 };
    },
  };
  const life = createCompanionLife({ pythonBackend: backend });
  await life.advance(123);
  assert.equal(calls[0][0], 'life.advance');
  assert.match(life.describe(), /正在study/);
  await life.performActivity('play', 456);
  assert.deepEqual(calls[1], ['life.perform_activity', { activityId: 'play', now: 456 }]);
});
