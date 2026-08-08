const assert = require('node:assert/strict');
const test = require('node:test');

const { createConversationOrchestrator } = require('../src/services/conversation-orchestrator');
const { createMemoryService } = require('../src/services/memory-service');
const { createProactivePolicy } = require('../src/services/proactive-policy');

test('Given legacy chat callbacks When the facade is used Then it preserves send and stream contracts', async () => {
  const sent = [];
  const facade = createConversationOrchestrator({
    send(input) {
      sent.push(input);
      return Promise.resolve({ source: 'rule', reply: '你好' });
    },
    sendStream(input, emit) {
      sent.push(input);
      emit('你', '你');
      return Promise.resolve('你好');
    },
  });
  const deltas = [];

  assert.deepEqual(await facade.send('hi'), { source: 'rule', reply: '你好' });
  assert.equal(await facade.sendStream('hello', (chunk, full) => deltas.push({ chunk, full })), '你好');
  assert.deepEqual(sent, ['hi', 'hello']);
  assert.deepEqual(deltas, [{ chunk: '你', full: '你' }]);
});

test('Given no proactive evaluator When the policy decides Then prompting stays disabled', () => {
  assert.deepEqual(createProactivePolicy().decide({}), { shouldPrompt: false, reason: 'disabled' });
});

test('Given storage When the memory facade is used Then it permits inspection and full erasure without an arbitrary persistence bypass', () => {
  const calls = [];
  const memory = createMemoryService({
    load: () => ({ facts: [] }),
    save: () => calls.push(['save']),
    erase: () => calls.push(['erase']),
  });

  assert.deepEqual(memory.read(), { facts: [] });
  assert.equal(Object.hasOwn(memory, 'save'), false);
  memory.eraseAll();
  assert.deepEqual(calls, [['erase']]);
});
