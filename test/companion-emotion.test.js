const assert = require('node:assert/strict');
const test = require('node:test');

const createCompanionEmotion = require('../src/services/companion-emotion');

test('companion emotion reads a Core projection and renders bounded prompt state', async () => {
  const backend = { getStatus: () => ({ ready: true }), request: async () => ({ valence: .7, arousal: .2, security: .8, attachment: .5, curiosity: .6, focus: .4 }) };
  const emotion = createCompanionEmotion({ pythonBackend: backend });
  await emotion.refresh(123);
  assert.match(emotion.describe(), /愉快、安静/);
  assert.match(emotion.describe(), /安全感 80\/100/);
});
