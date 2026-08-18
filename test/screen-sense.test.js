const assert = require('node:assert/strict');
const test = require('node:test');
const createScreenSense = require('../src/systems/screen-sense');

test('screen classifier emits only bounded semantic categories', () => {
  assert.deepEqual(createScreenSense.classify('Visual Studio Code'), { category: 'coding', activity: '专注工作' });
  assert.deepEqual(createScreenSense.classify('Google Chrome'), { category: 'browser', activity: '浏览网页' });
  assert.deepEqual(createScreenSense.classify('Unknown App'), { category: 'other', activity: '使用电脑' });
  assert.deepEqual(createScreenSense.classify(''), { category: 'unknown', activity: '状态未知' });
});

test('screen source never calls observer while disabled and stores no app name', async () => {
  let calls = 0;
  const source = createScreenSense({ observe: async () => { calls += 1; return 'Visual Studio Code'; } });
  await source.poll();
  assert.equal(calls, 0);
  source.setEnabled(true);
  await source.poll();
  assert.equal(calls, 1);
  const snapshot = source.getSnapshot();
  assert.deepEqual(snapshot.category, 'coding');
  assert.equal(snapshot.activity, '专注工作');
  assert.equal(Object.hasOwn(snapshot, 'appName'), false);
  assert.equal(source.getAwareness(), '屏幕：专注工作');
});

test('screen source turns permission errors into denied status without leaking details', async () => {
  const source = createScreenSense({ observe: async () => { throw new Error('not authorized to send Apple events'); } });
  source.setEnabled(true);
  await source.poll();
  assert.equal(source.getPermissionStatus(), 'denied');
  assert.equal(source.getAwareness(), '');
  assert.equal(source.getSnapshot().updatedAt, null);
});

test('screen clear invalidates an in-flight observation', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const source = createScreenSense({ observe: async () => pending });
  source.setEnabled(true);
  const polling = source.poll();
  source.clear();
  release('Safari');
  await polling;
  assert.equal(source.getSnapshot().updatedAt, null);
});
