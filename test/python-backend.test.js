const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const createPythonBackend = require('../src/services/python-backend');

test('Python backend: queues an event during startup and persists its clock projection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-python-backend-'));
  const backend = createPythonBackend();
  try {
    const queued = await backend.ingest({ type: 'sensing:tick', payload: { now: 1234 } });
    assert.deepEqual(queued, { accepted: false, queued: true });

    await backend.start({ dataDir: dir });
    assert.equal(backend.getStatus().ready, true);
    let snapshot = await backend.snapshot();
    assert.equal(snapshot.tickCount, 1);
    assert.equal(snapshot.lastTickAt, 1234);

    await backend.ingest({ type: 'sensing:tick', source: 'test', payload: { now: 5678 } });
    snapshot = await backend.snapshot();
    assert.equal(snapshot.tickCount, 2);
    assert.equal(snapshot.lastTickAt, 5678);
  } finally {
    await backend.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Python backend: invalid startup arguments reject before a child process is created', async () => {
  const backend = createPythonBackend();
  await assert.rejects(backend.start({}), /dataDir/);
  assert.equal(backend.getStatus().running, false);
});
