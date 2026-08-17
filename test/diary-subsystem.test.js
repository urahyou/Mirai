const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const setupDiary = require('../src/subsystems/diary');

test('Given saved Core material When the user explicitly generates a diary Then prose is saved and exported', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirai-diary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const calls = [];
  const material = { date: new Date().toLocaleDateString('en-CA'), sources: { episodes: [{ sourceId: 'episode:1' }], events: [], activities: [] } };
  setupDiary({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    app: { getPath: () => root },
    systemSense: { getAwareness: () => '', getSnapshot: () => null },
    companionMemory: {
      getDailyJournal: async () => null,
      buildDailyJournal: async (day, offset) => { calls.push(['build', day, offset]); return { ...material, date: day }; },
      saveDailyJournal: async (day, prose) => { calls.push(['save', day, prose]); return { material, sourceIds: ['episode:1'], prose }; },
    },
    generic: { generateDiary: async (input) => { calls.push(['generate', input]); return '今天和主人一起整理了好多事情，心里暖暖的。'; } },
  });

  const result = await handlers.get('diary:generateToday')();
  assert.equal(result.ok, true);
  assert.equal(result.sourceCount, 1);
  assert.deepEqual(calls.map(([name]) => name), ['build', 'generate', 'save']);
  const file = path.join(root, 'journals', `${result.date}.md`);
  assert.match(fs.readFileSync(file, 'utf8'), /今天和主人一起整理了好多事情/);
});
