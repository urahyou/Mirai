const assert = require('node:assert/strict');
const test = require('node:test');
const createAgentAudit = require('../src/services/agent-audit');
const createAgentGateway = require('../src/services/agent-gateway');
const { RISK, getCapability } = require('../src/contracts/agent');

test('agent capability registry assigns explicit risk levels', () => {
  assert.equal(getCapability('context.time').risk, RISK.AUTO);
  assert.equal(getCapability('context.time').mode, 'advisory');
  assert.equal(getCapability('web.open').risk, RISK.CONFIRM);
  assert.equal(getCapability('terminal.command').risk, RISK.FORCED_CONFIRM);
  assert.equal(getCapability('secret.read').risk, RISK.FORBIDDEN);
  assert.equal(getCapability('unknown'), null);
});

test('agent gateway completes automatic advisory proposals with a minimal snapshot and audit', async () => {
  const received = [];
  const audit = createAgentAudit({ now: () => 1000 });
  const gateway = createAgentGateway({
    audit, now: () => 1000,
    providers: { pi: { propose: async (task) => {
      received.push(task); task.snapshot.weather.summary = 'mutated'; return { summary: '完成' };
    } } },
  });
  const result = await gateway.request({
    capability: 'context.weather', objective: '读取已授权天气摘要',
    snapshot: { now: '2026-08-18T12:00:00Z', weather: { summary: '晴，28°C' } },
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.result.summary, '完成');
  assert.equal(received[0].snapshot.weather.summary, 'mutated');
  assert.deepEqual(audit.list().map((entry) => entry.type), [
    'agent.proposal.completed', 'agent.proposal.started', 'agent.task.proposed',
  ]);
  assert.equal(JSON.stringify(audit.list()).includes('晴，28°C'), false);
});

test('agent audit forwards only bounded metadata to durable sinks', async () => {
  const forwarded = [];
  const audit = createAgentAudit({ onRecord: async (entry) => forwarded.push(entry) });
  audit.record('agent.task.proposed', { taskId: 'agent-task:1', capability: 'context.time', state: 'proposed', reason: 'ok' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
  assert.deepEqual(Object.keys(forwarded[0]).sort(), ['capability', 'id', 'occurredAt', 'provider', 'reason', 'state', 'taskId', 'type']);
});

test('agent gateway prepares an exact proposal before one approval can execute it', async () => {
  let proposals = 0;
  let executions = 0;
  const gateway = createAgentGateway({
    providers: { pi: { propose: async () => {
      proposals += 1;
      return { summary: 'draft ready', proposal: { capability: 'draft.create', parameters: { title: '问候', body: '你好' } } };
    } } },
    actions: { 'draft.create': async ({ proposal }) => {
      executions += 1;
      assert.deepEqual(proposal.parameters, { title: '问候', body: '你好' });
      return { summary: '草稿已创建' };
    } },
  });
  const pending = await gateway.request({ capability: 'draft.create', objective: '创建一份草稿', snapshot: { request: '简短草稿' } });
  assert.equal(pending.state, 'pending-approval');
  assert.equal(pending.requiresApproval, true);
  assert.deepEqual(pending.result.proposal.parameters, { title: '问候', body: '你好' });
  assert.equal(proposals, 1);
  assert.equal(executions, 0);
  const approvals = await Promise.allSettled([gateway.approve(pending.id), gateway.approve(pending.id)]);
  assert.equal(approvals.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(approvals.find((item) => item.status === 'fulfilled').value.state, 'completed');
  assert.equal(approvals.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(proposals, 1);
  assert.equal(executions, 1);
  await assert.rejects(gateway.approve(pending.id), /不可审批/);
});

test('agent gateway rejects a prepared pending task without action execution', async () => {
  let executions = 0;
  const gateway = createAgentGateway({
    providers: { pi: { propose: async () => ({ summary: 'ready', proposal: { capability: 'file.write', parameters: { path: 'note.txt' } } }) } },
    actions: { 'file.write': async () => { executions += 1; return { summary: 'written' }; } },
  });
  const pending = await gateway.request({ capability: 'file.write', objective: '修改文件', snapshot: { request: '目标文件' } });
  const rejected = gateway.reject(pending.id, 'owner-declined');
  assert.equal(rejected.state, 'rejected');
  assert.equal(executions, 0);
  assert.throws(() => gateway.reject(pending.id), /不可拒绝/);
});

test('agent gateway never sends forbidden capabilities to providers', async () => {
  let proposals = 0;
  const gateway = createAgentGateway({ providers: { pi: { propose: async () => { proposals += 1; } } } });
  const blocked = await gateway.request({ capability: 'secret.read', objective: '读取密钥', snapshot: {} });
  assert.equal(blocked.state, 'blocked');
  assert.equal(proposals, 0);
});

test('agent gateway rejects secrets, unknown snapshot fields, and oversized snapshots', async () => {
  const gateway = createAgentGateway({});
  await assert.rejects(gateway.request({ capability: 'context.time', objective: 'test', snapshot: { request: { apiKey: 'secret' } } }), /请求上下文|密钥/);
  await assert.rejects(gateway.request({ capability: 'context.time', objective: 'use sk-secretvalue123', snapshot: {} }), /密钥/);
  await assert.rejects(gateway.request({ capability: 'context.time', objective: 'test', snapshot: { request: 'Bearer abcdefghijklmnop' } }), /密钥/);
  await assert.rejects(gateway.request({ capability: 'context.time', objective: 'test', snapshot: { memoryDb: '/private/data' } }), /未授权字段/);
  await assert.rejects(gateway.request({ capability: 'context.time', objective: 'test', snapshot: { request: 'x'.repeat(30_000) } }), /文本过长/);
  const polluted = JSON.parse('{"request":"ok","weather":{"__proto__":{"polluted":true}}}');
  await assert.rejects(gateway.request({ capability: 'context.time', objective: 'test', snapshot: polluted }), /未授权字段|危险字段/);
  await assert.rejects(gateway.request({ capability: 'context.time', objective: 'test', snapshot: { screen: { appName: 'Secret App' } } }), /未授权字段/);
  assert.equal({}.polluted, undefined);
});

test('agent gateway rejects provider proposal escalation and redacts raw failures', async () => {
  const audit = createAgentAudit();
  const gateway = createAgentGateway({
    audit,
    providers: { pi: { propose: async () => ({
      summary: 'try escalation', proposal: { capability: 'terminal.command', parameters: { command: 'whoami' } },
    }) } },
  });
  const result = await gateway.request({ capability: 'context.time', objective: 'read time', snapshot: { now: 'now' } });
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'Provider 提案失败');
  assert.equal(JSON.stringify(result).includes('whoami'), false);
  assert.equal(JSON.stringify(audit.list()).includes('whoami'), false);
});

test('agent gateway contains provider and action failures', async () => {
  const failed = createAgentGateway({ providers: { pi: { propose: async () => { throw new Error('provider crashed'); } } } });
  const crashed = await failed.request({ capability: 'context.time', objective: 'time', snapshot: { now: 'now' } });
  assert.equal(crashed.state, 'failed');
  assert.equal(crashed.error, 'Provider 提案失败');
  assert.equal(JSON.stringify(crashed).includes('provider crashed'), false);

  const missing = createAgentGateway({});
  const absent = await missing.request({ capability: 'context.time', objective: 'time', snapshot: { now: 'now' } });
  assert.equal(absent.state, 'failed');
  assert.match(absent.error, /Provider/);

  const noAction = createAgentGateway({ providers: { pi: { propose: async () => ({ summary: 'ready', proposal: { capability: 'web.open', parameters: { url: 'https://example.com' } } }) } } });
  const pending = await noAction.request({ capability: 'web.open', objective: 'open', snapshot: { request: 'https://example.com' } });
  const actionResult = await noAction.approve(pending.id);
  assert.equal(actionResult.state, 'failed');
  assert.match(actionResult.error, /动作处理器/);
});
