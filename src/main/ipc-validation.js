const IPC_ERROR = Object.freeze({
  ok: false,
  error: {
    code: 'INVALID_PAYLOAD',
    message: '请求参数不合法或超出允许范围',
    recoverable: true,
  },
});

// 把每个 ipcMain.handle 包装成：入参先经 validatePayload（按通道校验白名单/上限），
// 不合法直接回 IPC_ERROR，合法再交给真实 handler。供各 IPC 子系统复用。
function guarded(channel, handler) {
  return (_event, ...args) => {
    const result = validatePayload(channel, args);
    return result.ok ? handler(...result.data) : IPC_ERROR;
  };
}

function isText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validatePersonalityPatch(args) {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) return null;
  const patch = args[0];
  if ('name' in patch && !isText(patch.name, 40)) return null;
  if ('personality' in patch && patch.personality != null) {
    const personality = patch.personality;
    if (typeof personality !== 'object' || Array.isArray(personality)) return null;
    for (const key of ['mood', 'age', 'tone', 'selfIntro']) {
      if (key in personality && !isText(personality[key], 1000)) return null;
    }
    for (const key of ['likes', 'dislikes', 'catchphrases']) {
      if (key in personality && (!Array.isArray(personality[key]) || !personality[key].every((item) => isText(item, 50)))) return null;
    }
  }
  return args;
}

function validateDisplaySettingsPatch(args) {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) return null;
  const patch = args[0];
  if ('scale' in patch && (typeof patch.scale !== 'number' || !Number.isFinite(patch.scale) || patch.scale < 0.7 || patch.scale > 1.5)) return null;
  if ('alwaysOnTop' in patch && typeof patch.alwaysOnTop !== 'boolean') return null;
  if ('outlineShadow' in patch && typeof patch.outlineShadow !== 'boolean') return null;
  return args;
}

function validateVoiceSettingsPatch(args) {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) return null;
  const patch = {};
  for (const [key, value] of Object.entries(args[0])) {
    if (!/^SIDECAR_[A-Z0-9_]+$/.test(key)) continue;
    const v = value == null ? '' : String(value).trim();
    if (v.length > 500) return null;
    patch[key] = v;
  }
  return Object.keys(patch).length ? [patch] : null;
}

function validateChatExpanded(args) {
  return args.length === 1 && typeof args[0] === 'boolean' ? args : null;
}

function validateMemoryList(args) {
  const kinds = new Set(['messages', 'episodes', 'vectors', 'facts', 'candidates', 'profiles', 'edges', 'events']);
  return args.length === 1 && kinds.has(args[0]) ? args : null;
}

function validateMindList(args) {
  const kinds = new Set(['thoughts', 'dreams', 'reflections']);
  return args.length === 1 && kinds.has(args[0]) ? args : null;
}

function validateDay(args) {
  return args.length === 1 && typeof args[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args[0]) ? args : null;
}

function validateContextSettingsPatch(args, upper = 131072) {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) return null;
  const patch = args[0];
  if ('maxContextTokens' in patch) {
    const v = patch.maxContextTokens;
    // 上限跟随探测到的模型上下文（默认软上限 128k），不硬编码，否则探测出更大模型时会“拉不动”
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1000 || v > upper) return null;
  }
  return Object.keys(patch).length ? args : null;
}

function validatePayload(channel, args, ctx = {}) {
  const values = Array.isArray(args) ? args : [];
  const data = channel === 'personality:set'
    ? validatePersonalityPatch(values)
    : channel === 'voiceSettings:set'
      ? validateVoiceSettingsPatch(values)
      : channel === 'display:set' || channel === 'display:preview'
        ? validateDisplaySettingsPatch(values)
        : channel === 'chat:setExpanded'
          ? validateChatExpanded(values)
          : channel === 'memory:list'
            ? validateMemoryList(values)
            : channel === 'memory:listMind'
              ? validateMindList(values)
            : channel === 'memory:getDailyJournal'
              ? validateDay(values)
          : channel === 'context:set'
            ? validateContextSettingsPatch(values, ctx.contextMaxTokens)
            : null;
  return data ? { ok: true, data } : IPC_ERROR;
}

module.exports = { validatePayload, IPC_ERROR, guarded };
