const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createJsonStorage } = require('../src/services/json-storage');

test('Given a new storage file When it saves data Then it reloads the schema-versioned document', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'memory.json');
  const storage = createJsonStorage({ filePath, schemaVersion: 1, defaults: { memories: [] } });

  storage.save({ memories: [{ text: '主人喜欢团子' }] });

  assert.deepEqual(storage.load(), { memories: [{ text: '主人喜欢团子' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
    schemaVersion: 1,
    data: { memories: [{ text: '主人喜欢团子' }] },
  });
});

test('Given stored personal data When erase is requested Then its document and recovery copies are deleted', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'memory.json');
  const storage = createJsonStorage({ filePath, schemaVersion: 1, defaults: { memories: [] } });

  storage.save({ memories: [{ text: 'private' }] });
  fs.writeFileSync(`${filePath}.corrupt-fixture`, 'private backup');
  storage.erase();

  assert.deepEqual(fs.readdirSync(directory), []);
});

test('Given a save When the adapter writes Then it atomically renames a sibling temporary file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  const storage = createJsonStorage({ filePath, schemaVersion: 1, defaults: {} });
  const originalRename = fs.renameSync;
  const renameCalls = [];
  fs.renameSync = (from, to) => {
    renameCalls.push({ from, to });
    return originalRename(from, to);
  };
  t.after(() => { fs.renameSync = originalRename; });

  storage.save({ enabled: true });

  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0].to, filePath);
  assert.match(renameCalls[0].from, /^.*settings\.json\.tmp-/);
  assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
});

test('Given an older schema document When load migrates it Then the upgraded document is persisted', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, data: { theme: 'dark' } }));
  const storage = createJsonStorage({
    filePath,
    schemaVersion: 2,
    defaults: { theme: 'light', notifications: true },
    migrate(document) {
      assert.deepEqual(document, { schemaVersion: 1, data: { theme: 'dark' } });
      return { ...document.data, notifications: true };
    },
  });

  assert.deepEqual(storage.load(), { theme: 'dark', notifications: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
    schemaVersion: 2,
    data: { theme: 'dark', notifications: true },
  });
});

test('Given corrupt JSON When load runs Then it quarantines bytes and recovers safe defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'memory.json');
  const corruptBytes = '{not-json';
  fs.writeFileSync(filePath, corruptBytes, 'utf8');
  const storage = createJsonStorage({ filePath, schemaVersion: 1, defaults: { memories: [] } });

  assert.deepEqual(storage.load(), { memories: [] });
  const entries = fs.readdirSync(directory);
  const quarantine = entries.find((entry) => /^memory\.json\.corrupt-/.test(entry));
  assert.ok(quarantine);
  assert.equal(fs.readFileSync(path.join(directory, quarantine), 'utf8'), corruptBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
    schemaVersion: 1,
    data: { memories: [] },
  });
});
