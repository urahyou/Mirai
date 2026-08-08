const assert = require('node:assert/strict');
const test = require('node:test');

const { MOOD_MAP, MOODS, resolveMapping } = require('../src/core/mood-map');

test('Given the seven moods When mapped Then every mood has a valid face, name, tone and nothing depends on animation alone', () => {
  assert.deepEqual(MOODS, ['calm', 'happy', 'excited', 'sad', 'bored', 'tired', 'overwhelmed']);
  for (const mood of MOODS) {
    const entry = MOOD_MAP[mood];
    assert.ok(['idle', 'happy', 'sad'].includes(entry.face), `${mood} face must map to an existing character image`);
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.tone, 'string');
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length > 0);
  }
});

test('Given the mood copy When audited for manipulation Then it never threatens, guilt-trips, guilts, or punishes the user', () => {
  const forbidden = /内疚|愧疚|嫉妒|忌妒|惩罚|报复|关机|拒绝服务|降好感|都是你的错|你伤害我|你害我|活该|生病也是因为你|求求|再不理|不理你|再也|怪你|因为你才/;
  for (const entry of Object.values(MOOD_MAP)) {
    const copy = `${entry.name} ${entry.tone} ${entry.reason}`;
    assert.doesNotMatch(copy, forbidden, `mood copy must stay humane: ${copy}`);
  }
});

test('Given an unknown mood When resolved Then it falls back to a calm presentation', () => {
  assert.deepEqual(resolveMapping({}), { mood: 'calm', ...MOOD_MAP.calm });
  assert.deepEqual(resolveMapping(null), { mood: 'calm', ...MOOD_MAP.calm });
  assert.equal(resolveMapping({ mood: 'happy' }).mood, 'happy');
});