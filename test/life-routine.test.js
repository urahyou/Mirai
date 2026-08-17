const assert = require('node:assert/strict');
const test = require('node:test');
const { createEventBus } = require('../src/services/event-bus');
const E = require('../src/contracts/events');
const routine = require('../src/systems/life-routine');

function at(hour) { return new Date(2026, 7, 18, hour, 0, 0).getTime(); }
function state(overrides = {}) {
  return {
    updatedAt: null, health: 100, energy: 80, hunger: 20, boredom: 20, stress: 10,
    money: 1200, recentActivities: [], ...overrides,
  };
}

test('life routine chooses activities from local time and needs without external actions', () => {
  assert.equal(routine.chooseActivity(state(), at(10)), 'school');
  assert.equal(routine.chooseActivity(state({ hunger: 70 }), at(10)), 'meal');
  assert.equal(routine.chooseActivity(state({ stress: 80 }), at(16)), 'walk');
  assert.equal(routine.chooseActivity(state({ boredom: 80 }), at(16)), 'play');
  assert.equal(routine.chooseActivity(state({ energy: 10 }), at(10)), 'rest');
  assert.equal(routine.chooseActivity(state({ updatedAt: at(10) + 1 }), at(10)), null);
});

test('life routine advances then records one virtual activity and emits a domain event', async (t) => {
  const bus = createEventBus();
  const calls = [];
  const events = [];
  const now = at(10);
  const current = state();
  const completed = { ...current, currentActivityId: 'school', updatedAt: now + 120 * 60 * 1000 };
  const lifeState = {
    advance: async (value) => { calls.push(['advance', value]); return current; },
    performActivity: async (activityId, value) => { calls.push(['perform', activityId, value]); return completed; },
  };
  bus.on(E.LIFE.ACTIVITY_COMPLETED, (payload) => events.push(payload));
  routine.init({ eventBus: bus, lifeState });
  t.after(() => routine.stop());
  const result = await routine.tick(now);
  assert.equal(result.activityId, 'school');
  assert.deepEqual(calls, [['advance', now], ['perform', 'school', now]]);
  assert.equal(events[0].activityId, 'school');
});
