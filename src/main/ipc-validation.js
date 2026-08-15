const IPC_ERROR = Object.freeze({
  ok: false,
  error: {
    code: 'INVALID_PAYLOAD',
    message: '请求参数不合法或超出允许范围',
    recoverable: true,
  },
});

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

const GRAPHITI_SETTING_KEYS = new Set([
  'GRAPHITI_ENABLED', 'GRAPHITI_BASE_URL', 'GRAPHITI_GROUP_ID',
  'GRAPHITI_NEO4J_URI', 'GRAPHITI_NEO4J_USER', 'GRAPHITI_NEO4J_PASSWORD',
  'GRAPHITI_NEO4J_DATABASE', 'GRAPHITI_LLM_BASE_URL', 'GRAPHITI_LLM_API_KEY',
  'GRAPHITI_LLM_MODEL', 'GRAPHITI_LLM_SMALL_MODEL', 'GRAPHITI_LLM_MAX_TOKENS',
  'GRAPHITI_OLLAMA_THINK', 'GRAPHITI_EMBED_BASE_URL', 'GRAPHITI_EMBED_API_KEY',
  'GRAPHITI_EMBED_MODEL', 'GRAPHITI_EPISODE_TIMEOUT', 'GRAPHITI_SEARCH_TIMEOUT',
]);

function validateGraphitiSettingsPatch(args) {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) return null;
  const patch = args[0];
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !GRAPHITI_SETTING_KEYS.has(key))) return null;
  if (keys.some((key) => typeof patch[key] !== 'string' || patch[key].length > 500)) return null;
  return args;
}

function validateContextSettingsPatch(args) {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) return null;
  const patch = args[0];
  if ('maxContextTokens' in patch) {
    const v = patch.maxContextTokens;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1000 || v > 131072) return null;
  }
  return Object.keys(patch).length ? args : null;
}

function validatePayload(channel, args) {
  const values = Array.isArray(args) ? args : [];
  const data = channel === 'personality:set'
    ? validatePersonalityPatch(values)
    : channel === 'voiceSettings:set'
      ? validateVoiceSettingsPatch(values)
      : channel === 'display:set' || channel === 'display:preview'
        ? validateDisplaySettingsPatch(values)
        : channel === 'chat:setExpanded'
          ? validateChatExpanded(values)
          : channel === 'context:set'
            ? validateContextSettingsPatch(values)
            : channel === 'memory:setSettings'
              ? validateGraphitiSettingsPatch(values)
              : null;
  return data ? { ok: true, data } : IPC_ERROR;
}

module.exports = { validatePayload, IPC_ERROR };
