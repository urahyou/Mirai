const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const createPiExecutionProvider = require('../src/services/pi-execution-provider');

function fakeProcess(onCommand) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedWith = [];
  child.kill = (signal) => { child.killedWith.push(signal); return true; };
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const command = JSON.parse(buffer.slice(0, newline));
    onCommand(command, child);
  });
  return child;
}

const enabledEnv = {
  MIRAI_AGENT_ENABLED: 'true',
  MIRAI_AGENT_PI_PROVIDER: 'codexcn',
  MIRAI_AGENT_PI_MODEL: 'gpt-5.6-sol',
  MIRAI_AGENT_PI_THINKING: 'high',
};
const task = {
  id: 'agent-task:test', capability: 'context.weather', objective: 'summarize weather',
  snapshot: { weather: { summary: '晴，28°C' } }, signal: new AbortController().signal,
};

test('Pi provider stays disabled without explicit complete configuration', async () => {
  let spawned = 0;
  const provider = createPiExecutionProvider({ readEnv: () => ({}), spawnImpl: () => { spawned += 1; } });
  assert.deepEqual(provider.getStatus(), { enabled: false, ready: false, provider: '', model: '' });
  await assert.rejects(provider.propose(task), /未启用/);
  assert.equal(spawned, 0);
});

test('Pi provider spawns an ephemeral no-builtin RPC worker and returns one proposal', async () => {
  let invocation;
  const provider = createPiExecutionProvider({
    readEnv: () => enabledEnv,
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return fakeProcess((request, child) => {
        assert.equal(request.type, 'prompt');
        assert.equal(request.id, task.id);
        assert.match(request.message, /context\.weather/);
        child.stdout.write(`${JSON.stringify({ type: 'response', id: task.id, command: 'prompt', success: true })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'tool_execution_start', toolName: 'mirai_submit_proposal', args: { summary: '天气已读取', capability: 'context.weather', parameters: { condition: '晴' } } })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'tool_execution_end', toolName: 'mirai_submit_proposal', isError: false })}\n`);
        child.stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`);
      });
    },
  });
  const result = await provider.propose(task);
  assert.deepEqual(result, { summary: '天气已读取', proposal: { capability: 'context.weather', parameters: { condition: '晴' } } });
  assert.equal(invocation.command, 'pi');
  for (const flag of ['--mode', '--no-session', '--no-extensions', '--no-skills', '--no-context-files', '--no-builtin-tools', '--tools', '--extension', '--no-approve']) {
    assert.ok(invocation.args.includes(flag), `missing ${flag}`);
  }
  assert.equal(invocation.args.includes('bash'), false);
  assert.equal(invocation.args.includes('edit'), false);
  assert.equal(invocation.args.includes('write'), false);
  assert.equal(invocation.options.env.PI_SKIP_VERSION_CHECK, '1');
  assert.equal(invocation.options.env.PI_TELEMETRY, '0');
});

test('Mirai Pi extension registers only a terminating proposal tool', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent', 'mirai-proposal.ts'), 'utf8');
  assert.match(source, /name:\s*"mirai_submit_proposal"/);
  assert.match(source, /terminate:\s*true/);
  assert.doesNotMatch(source, /pi\.exec|child_process|node:fs|registerCommand|sendUserMessage/);
  assert.equal((source.match(/registerTool\(/g) || []).length, 1);
});

test('Pi provider environment drops inherited credentials and agent session metadata', () => {
  const env = createPiExecutionProvider.childEnvironment({
    HOME: '/tmp/home', PATH: '/bin', LANG: 'zh_CN.UTF-8', OPENAI_API_KEY: 'secret',
    PI_SESSION_ID: 'parent', AWS_SECRET_ACCESS_KEY: 'secret', NODE_OPTIONS: '--require attack.js',
  });
  assert.deepEqual(env, { HOME: '/tmp/home', PATH: '/bin', LANG: 'zh_CN.UTF-8', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
});

test('Pi provider rejects unauthorized tools, multiple proposals, and malformed JSON', async () => {
  async function failsWith(records, pattern) {
    const provider = createPiExecutionProvider({
      readEnv: () => enabledEnv,
      spawnImpl: () => fakeProcess((_request, child) => {
        for (const record of records) child.stdout.write(typeof record === 'string' ? `${record}\n` : `${JSON.stringify(record)}\n`);
      }),
    });
    await assert.rejects(provider.propose(task), pattern);
  }
  await failsWith([{ type: 'tool_execution_start', toolName: 'bash', args: {} }], /未授权工具/);
  await failsWith([
    { type: 'tool_execution_start', toolName: 'mirai_submit_proposal', args: { summary: 'one' } },
    { type: 'tool_execution_start', toolName: 'mirai_submit_proposal', args: { summary: 'two' } },
  ], /多个提案/);
  await failsWith([
    { type: 'tool_execution_start', toolName: 'mirai_submit_proposal', args: { summary: 'unverified' } },
    { type: 'agent_settled' },
  ], /未返回已验证提案/);
  await failsWith(['not-json'], /malformed JSON/);
});

test('Pi provider abort terminates its worker', async () => {
  const controller = new AbortController();
  let child;
  const provider = createPiExecutionProvider({
    readEnv: () => enabledEnv,
    spawnImpl: () => { child = fakeProcess(() => {}); return child; },
  });
  const pending = provider.propose({ ...task, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.ok(child.killedWith.includes('SIGTERM'));
});
