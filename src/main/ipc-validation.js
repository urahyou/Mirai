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
  return args;
}

function validateChatExpanded(args) {
  return args.length === 1 && typeof args[0] === 'boolean' ? args : null;
}

function validatePayload(channel, args) {
  const values = Array.isArray(args) ? args : [];
  const data = channel === 'personality:set'
    ? validatePersonalityPatch(values)
    : channel === 'display:set' || channel === 'display:preview'
      ? validateDisplaySettingsPatch(values)
      : channel === 'chat:setExpanded'
        ? validateChatExpanded(values)
      : null;
  return data ? { ok: true, data } : IPC_ERROR;
}

module.exports = { validatePayload, IPC_ERROR };
