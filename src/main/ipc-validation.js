const { MEMORY_TYPES } = require('../services/memory-service');

const IPC_ERROR = Object.freeze({
  ok: false,
  error: {
    code: 'INVALID_PAYLOAD',
    message: '请求参数不合法或超出允许范围',
    recoverable: true,
  },
});

const MAX_ID_LEN = 128;
const MAX_CONTENT_LEN = 1000;
const MINUTE_BOUND = 24 * 60;

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isBool(value) {
  return typeof value === 'boolean';
}
function isPositiveInt(value) {
  return Number.isInteger(value) && value >= 0;
}
function isScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isMinute(value) {
  return Number.isInteger(value) && value >= 0 && value <= MINUTE_BOUND;
}
function isText(value, { min = 1, max = Infinity } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}
function isId(value) {
  return isText(value, { max: MAX_ID_LEN });
}
function isIsoTime(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const time = new Date(value);
  return !Number.isNaN(time.getTime());
}
function isMemoryType(value) {
  return typeof value === 'string' && MEMORY_TYPES.includes(value);
}
function isCleanWeekdays(value) {
  return Array.isArray(value) && value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}
function isEmptyArgs(args) {
  return args.length === 0;
}

const SETTING_TYPES = {
  notifications: 'bool', sound: 'bool', animation: 'bool', reduceMotion: 'bool',
  networkConsent: 'bool', memorySaving: 'bool', memoryAuto: 'bool', memorySoftDelete: 'bool',
  memoryAutoInterval: 'number',
};

const validators = {
  'settings:set'(args) {
    if (args.length !== 1 || !isPlain(args[0])) return null;
    for (const key of Object.keys(args[0])) {
      const type = SETTING_TYPES[key];
      if (!type) return null;
      if (type === 'bool' ? !isBool(args[0][key]) : !(typeof args[0][key] === 'number' && Number.isFinite(args[0][key]))) return null;
    }
    return args;
  },
  'proactive:setSettings'(args) {
    if (args.length !== 1 || !isPlain(args[0])) return null;
    const settings = args[0];
    if ('enabled' in settings && !isBool(settings.enabled)) return null;
    if ('quietHours' in settings) {
      const quiet = settings.quietHours;
      if (!isPlain(quiet)) return null;
      if ('allow' in quiet) {
        if (!Array.isArray(quiet.allow)) return null;
        const allValid = quiet.allow.every((period) => Array.isArray(period)
          && period.length === 2 && isMinute(period[0]) && isMinute(period[1]));
        if (!allValid) return null;
      }
      if ('weekdays' in quiet && !isCleanWeekdays(quiet.weekdays)) return null;
    }
    for (const key of ['hourlyBudget', 'dailyBudget', 'cooldownMinutes']) {
      if (key in settings && !isPositiveInt(settings[key])) return null;
    }
    return args;
  },
  'proactive:pause'(args) {
    if (args.length !== 1 || args[0] == null || !isIsoTime(args[0])) return null;
    return args;
  },
  'proactive:resume'(args) {
    if (!isEmptyArgs(args)) return null;
    return [];
  },
  'memory:list'(args) {
    if (args.length === 0 || args.length === 1 && (args[0] === undefined || args[0] === null)) return [];
    if (args.length !== 1 || !isPlain(args[0])) return null;
    if ('includeArchived' in args[0] && !isBool(args[0].includeArchived)) return null;
    return args;
  },
  'memory:remember'(args) {
    if (args.length !== 1 || !isPlain(args[0])) return null;
    const input = args[0];
    if (!isMemoryType(input.type)) return null;
    if (!isText(input.content, { max: MAX_CONTENT_LEN })) return null;
    if ('explicit' in input && !isBool(input.explicit)) return null;
    return args;
  },
  'memory:update'(args) {
    if (args.length !== 2 || !isId(args[0]) || !isPlain(args[1])) return null;
    const changes = args[1];
    for (const key of Object.keys(changes)) {
      const value = changes[key];
      const valid = key === 'type' ? isMemoryType(value)
        : key === 'content' ? isText(value, { max: MAX_CONTENT_LEN })
        : key === 'importance' || key === 'confidence' ? isScore(value)
        : key === 'expiresAt' ? isIsoTime(value)
        : key === 'status' ? (value === 'core' || value === 'active')
        : key === 'explicit' || key === 'archived' ? isBool(value)
        : false;
      if (!valid) return null;
    }
    return args;
  },
  'memory:remove'(args) {
    if (args.length !== 1 || !isId(args[0])) return null;
    return args;
  },
  'memory:restore'(args) {
    if (args.length !== 1 || !isId(args[0])) return null;
    return args;
  },
  'memory:purge'(args) {
    if (args.length !== 1 || !isId(args[0])) return null;
    return args;
  },
  'memory:stats'(args) {
    if (!isEmptyArgs(args)) return null;
    return [];
  },
  'memory:forget'(args) {
    if (args.length !== 1 || !isPlain(args[0])) return null;
    const req = args[0];
    if (Object.keys(req).length === 0) return null;
    if ('id' in req && !isId(req.id)) return null;
    if ('type' in req && !isMemoryType(req.type)) return null;
    if ('content' in req && !isText(req.content)) return null;
    return args;
  },
  'memory:doNotRemember'(args) {
    if (args.length !== 1 || !isPlain(args[0])) return null;
    const req = args[0];
    if (!isMemoryType(req.type)) return null;
    if (!isText(req.content, { max: MAX_CONTENT_LEN })) return null;
    return args;
  },
  'memory:archive'(args) {
    if (args.length !== 1 || !isId(args[0])) return null;
    return args;
  },
  'memory:archiveExpired'(args) {
    if (!isEmptyArgs(args)) return null;
    return [];
  },
  'memory:export'(args) {
    if (!isEmptyArgs(args)) return null;
    return [];
  },
  'memory:clearAll'(args) {
    if (!isEmptyArgs(args)) return null;
    return [];
  },

  'schedule:list'(args) {
    if (args.length === 0 || args.length === 1 && (args[0] === undefined || args[0] === null)) return [];
    if (args.length !== 1 || !isPlain(args[0])) return null;
    if ('includeDisabled' in args[0] && !isBool(args[0].includeDisabled)) return null;
    return args;
  },

  'schedule:create'(args) {
    if (args.length !== 1 || !isPlain(args[0])) return null;
    const input = args[0];
    if (!isText(input.title, { max: 120 })) return null;
    if (!('runAt' in input) || !isIsoTime(input.runAt) || input.runAt == null) return null;
    if ('type' in input && !['reminder', 'deadline', 'proactive'].includes(input.type)) return null;
    if ('repeat' in input && input.repeat !== null && !(isPlain(input.repeat) && ['daily', 'weekly'].includes(input.repeat.interval))) return null;
    if ('note' in input && !isText(input.note, { max: 500 })) return null;
    return args;
  },

  'schedule:update'(args) {
    if (args.length !== 2 || !isId(args[0]) || !isPlain(args[1])) return null;
    const patch = args[1];
    if ('title' in patch && !isText(patch.title, { max: 120 })) return null;
    if ('runAt' in patch && !isIsoTime(patch.runAt)) return null;
    if ('type' in patch && !['reminder', 'deadline', 'proactive'].includes(patch.type)) return null;
    if ('repeat' in patch && patch.repeat !== null && !(isPlain(patch.repeat) && ['daily', 'weekly'].includes(patch.repeat.interval))) return null;
    if ('enabled' in patch && !isBool(patch.enabled)) return null;
    return args;
  },

  'schedule:remove'(args) {
    if (args.length !== 1 || !isId(args[0])) return null;
    return args;
  },

  'schedule:clear'(args) {
    if (!isEmptyArgs(args)) return null;
    return [];
  },

  'owner:set'(args) {
    if (args.length !== 1 || !isPlain(args[0])) return null;
    const patch = args[0];
    if ('name' in patch && !isText(patch.name, { max: 40 })) return null;
    if ('birthday' in patch && patch.birthday !== '' && !isText(patch.birthday, { max: 40 })) return null;
    if ('note' in patch && patch.note !== '' && !isText(patch.note, { max: 500 })) return null;
    if ('likes' in patch && !(Array.isArray(patch.likes) && patch.likes.every((x) => isText(x, { max: 50 })))) return null;
    return args;
  },

  'personality:set'(args) {
    if (args.length !== 1 || !isPlain(args[0])) return null;
    const patch = args[0];
    if ('name' in patch && !isText(patch.name, { max: 40 })) return null;
    if ('personality' in patch && patch.personality != null) {
      if (!isPlain(patch.personality)) return null;
      const p = patch.personality;
      const strings = ['mood', 'age', 'tone', 'selfIntro'];
      for (const key of strings) {
        if (key in p && !isText(p[key], { max: 1000 })) return null;
      }
      const lists = ['likes', 'dislikes', 'catchphrases'];
      for (const key of lists) {
        if (key in p && !(Array.isArray(p[key]) && p[key].every((x) => isText(x, { max: 50 })))) return null;
      }
    }
    return args;
  },
};

function validatePayload(channel, args) {
  const validator = validators[channel];
  if (typeof validator !== 'function') return IPC_ERROR;
  const data = validator(Array.isArray(args) ? args : []);
  return data ? { ok: true, data } : IPC_ERROR;
}

module.exports = { validatePayload, IPC_ERROR, validators };
