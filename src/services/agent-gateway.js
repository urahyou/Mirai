const crypto = require('crypto');
const { getCapability, RISK } = require('../contracts/agent');

const MAX_TASKS = 100;
const MAX_SNAPSHOT_BYTES = 16 * 1024;
const EXECUTION_TIMEOUT_MS = 60_000;
const SECRET_KEY = /(api.?key|authorization|cookie|credential|password|secret|token)/i;
const SECRET_VALUE = /(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{8,}|bearer\s+[a-z0-9._-]{8,}/i;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SNAPSHOT_SCHEMA = Object.freeze({
  weather: new Set(['summary', 'condition', 'temperatureC', 'windSpeedKmh']),
  screen: new Set(['category', 'activity']),
  life: new Set(['activity', 'location', 'energy', 'health', 'needs']),
});
const SNAPSHOT_KEYS = new Set(['now', 'weather', 'screen', 'life', 'request']);

function sanitize(value, depth = 0) {
  if (depth > 4) throw new TypeError('任务快照嵌套过深');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('任务快照包含非法数字');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 1000) throw new RangeError('任务快照文本过长');
    if (SECRET_VALUE.test(value)) throw new TypeError('任务数据疑似包含密钥或凭据');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 20) throw new RangeError('任务快照数组过大');
    return value.map((item) => sanitize(item, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new TypeError('任务快照包含不支持的数据');
  const entries = Object.entries(value);
  if (entries.length > 30) throw new RangeError('任务快照字段过多');
  const result = {};
  for (const [key, item] of entries) {
    if (key.length > 80) throw new RangeError('任务快照字段名过长');
    if (DANGEROUS_KEYS.has(key)) throw new TypeError('任务快照包含危险字段');
    if (SECRET_KEY.test(key)) throw new TypeError('任务快照不得包含密钥或凭据');
    result[key] = sanitize(item, depth + 1);
  }
  return result;
}

function safeSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (!Object.keys(source).every((key) => SNAPSHOT_KEYS.has(key))) throw new TypeError('任务快照包含未授权字段');
  if (Object.hasOwn(source, 'request') && typeof source.request !== 'string') throw new TypeError('任务请求上下文必须是文本');
  if (Object.hasOwn(source, 'now') && !['string', 'number'].includes(typeof source.now)) throw new TypeError('任务时间上下文不合法');
  for (const [key, allowed] of Object.entries(SNAPSHOT_SCHEMA)) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).every((field) => allowed.has(field))) {
      throw new TypeError(`任务 ${key} 上下文包含未授权字段`);
    }
  }
  const snapshot = sanitize(source);
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) throw new RangeError('任务快照过大');
  return snapshot;
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function normalizeResult(value, task) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Provider 结果必须是对象');
  if (!Object.keys(value).every((key) => key === 'summary' || key === 'proposal')) throw new TypeError('Provider 结果包含未授权字段');
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 2000) throw new TypeError('Provider 结果摘要不合法');
  const result = { summary: value.summary.trim() };
  if (value.proposal != null) {
    const proposal = value.proposal;
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new TypeError('Provider 提案不合法');
    if (!Object.keys(proposal).every((key) => key === 'capability' || key === 'parameters')) throw new TypeError('Provider 提案包含未授权字段');
    if (proposal.capability !== task.capability) throw new TypeError('Provider 提案能力与任务不一致');
    result.proposal = { capability: task.capability, parameters: sanitize(proposal.parameters || {}) };
  }
  return result;
}

function publicTask(task) {
  return {
    id: task.id,
    capability: task.capability,
    risk: task.risk,
    objective: task.objective,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    requiresApproval: task.requiresApproval,
    result: clone(task.result),
    error: task.error,
  };
}

module.exports = function createAgentGateway({ providers = {}, audit, now = () => Date.now(), timeoutMs = EXECUTION_TIMEOUT_MS } = {}) {
  const providerMap = new Map(Object.entries(providers));
  const tasks = new Map();
  const deadline = Math.max(1000, Math.min(5 * 60_000, Number(timeoutMs) || EXECUTION_TIMEOUT_MS));

  function timestamp() { return new Date(now()).toISOString(); }
  function record(type, task, reason) {
    audit?.record(type, { taskId: task.id, capability: task.capability, state: task.state, reason, provider: task.provider });
  }
  function remember(task) {
    tasks.set(task.id, task);
    while (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value);
  }

  async function execute(task) {
    const provider = providerMap.get(task.provider);
    if (!provider || typeof provider.execute !== 'function') {
      task.state = 'failed'; task.error = '执行 Provider 不可用'; task.updatedAt = timestamp();
      record('agent.execution.failed', task, task.error);
      return publicTask(task);
    }
    task.state = 'running'; task.updatedAt = timestamp();
    record('agent.execution.started', task);
    let controller = null;
    try {
      controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadline);
      let result;
      try {
        result = await Promise.race([
          provider.execute(Object.freeze({
            id: task.id, capability: task.capability, objective: task.objective,
            snapshot: clone(task.snapshot), signal: controller.signal,
          })),
          new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('执行超时')), { once: true })),
        ]);
      } finally { clearTimeout(timer); }
      const normalized = normalizeResult(result, task);
      task.result = normalized;
      task.state = 'completed'; task.updatedAt = timestamp();
      record('agent.execution.completed', task);
    } catch (error) {
      const timedOut = controller?.signal?.aborted;
      task.state = 'failed'; task.error = timedOut ? '执行超时' : 'Provider 执行失败'; task.updatedAt = timestamp();
      record('agent.execution.failed', task, task.error);
    }
    return publicTask(task);
  }

  async function request(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Agent 任务必须是对象');
    const capability = getCapability(input.capability);
    if (!capability) throw new TypeError('Agent 能力未登记');
    const objective = typeof input.objective === 'string' ? input.objective.trim().slice(0, 1000) : '';
    if (!objective) throw new TypeError('Agent 任务目标不能为空');
    if (SECRET_VALUE.test(objective)) throw new TypeError('Agent 任务目标疑似包含密钥或凭据');
    const task = {
      id: `agent-task:${crypto.randomUUID()}`,
      capability: capability.id,
      risk: capability.risk,
      objective,
      snapshot: safeSnapshot(input.snapshot),
      provider: typeof input.provider === 'string' && /^[a-z0-9_-]{1,40}$/i.test(input.provider) ? input.provider : 'pi',
      state: 'proposed', result: null, error: null,
      requiresApproval: capability.risk === RISK.CONFIRM || capability.risk === RISK.FORCED_CONFIRM,
      createdAt: timestamp(), updatedAt: timestamp(),
    };
    remember(task);
    record('agent.task.proposed', task);
    if (capability.risk === RISK.FORBIDDEN) {
      task.state = 'blocked'; task.error = '该能力被安全策略禁止'; task.updatedAt = timestamp();
      record('agent.task.blocked', task, task.error);
      return publicTask(task);
    }
    if (task.requiresApproval) {
      task.state = 'pending-approval'; task.updatedAt = timestamp();
      record('agent.approval.required', task);
      return publicTask(task);
    }
    return execute(task);
  }

  async function approve(taskId) {
    const task = tasks.get(taskId);
    if (!task) throw new TypeError('Agent 任务不存在');
    if (task.state !== 'pending-approval') throw new Error('Agent 任务当前不可审批');
    task.state = 'approved'; task.updatedAt = timestamp();
    record('agent.approval.granted', task);
    return execute(task);
  }

  function reject(taskId, reason = 'user-rejected') {
    const task = tasks.get(taskId);
    if (!task) throw new TypeError('Agent 任务不存在');
    if (task.state !== 'pending-approval') throw new Error('Agent 任务当前不可拒绝');
    task.state = 'rejected'; task.error = String(reason || 'user-rejected').slice(0, 300); task.updatedAt = timestamp();
    record('agent.approval.rejected', task, task.error);
    return publicTask(task);
  }

  function get(taskId) { const task = tasks.get(taskId); return task ? publicTask(task) : null; }
  function list(limit = 50) { return [...tasks.values()].slice(-Math.max(1, Math.min(100, Number(limit) || 50))).reverse().map(publicTask); }

  return { request, approve, reject, get, list };
};

module.exports.safeSnapshot = safeSnapshot;
