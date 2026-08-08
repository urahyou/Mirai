const { createStateStore } = require('./state-store');

const DEFAULT_SNAPSHOT = {
  version: 1,
  state: {
    mood: 'calm',
    moodScore: 55,
    affection: 30,
    energy: 80,
    health: 100,
    stress: 10,
    loneliness: 5,
    updatedAt: new Date().toISOString(),
  },
  events: [],
  dayKey: null,
  affectionGain: 0,
  affectionLoss: 0,
};

const MAX_EVENTS = 200;
const DAILY_GAIN_CAP = 20;
const DAILY_LOSS_CAP = -20;
const AFFECT_KEYS = ['moodScore', 'affection', 'energy', 'health', 'stress', 'loneliness'];

const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));

function moveToward(value, target, factor) {
  return value + (target - value) * factor;
}

function deriveMood(state) {
  if (state.health < 25 || state.energy < 15) return 'tired';
  if (state.stress > 75) return 'overwhelmed';
  if (state.moodScore >= 78) return 'excited';
  if (state.moodScore >= 62) return 'happy';
  if (state.moodScore <= 25) return 'sad';
  if (state.moodScore <= 42 || state.loneliness > 75) return 'bored';
  return 'calm';
}

function dayKeyOf(date) {
  return date.toISOString().slice(0, 10);
}

function createEmotionService(filePath) {
  const store = createStateStore(filePath, DEFAULT_SNAPSHOT);

  function applyDecay(snapshot) {
    const state = snapshot.state;
    const previousTime = Date.parse(state.updatedAt);
    const elapsedHours = Number.isFinite(previousTime)
      ? Math.max(0, (Date.now() - previousTime) / 3600000)
      : 0;

    if (elapsedHours < 0.01) return false;

    const factor = Math.min(0.4, elapsedHours * 0.02);
    state.energy = clamp(moveToward(state.energy, 70, factor));
    state.stress = clamp(moveToward(state.stress, 20, factor));
    state.affection = clamp(moveToward(state.affection, 30, Math.min(0.08, elapsedHours * 0.002)));
    state.loneliness = clamp(state.loneliness + Math.min(15, elapsedHours * 0.5));
    state.moodScore = clamp(moveToward(state.moodScore, 55, factor));
    state.mood = deriveMood(state);
    state.updatedAt = new Date().toISOString();
    return true;
  }

  function getSnapshot() {
    const snapshot = store.load();
    if (applyDecay(snapshot)) store.save(snapshot);
    return JSON.parse(JSON.stringify(snapshot));
  }

  // 每次事件把好感按「每日增减上限」钳制，防止连续夸奖无限刷分。
  function boundedDelta(snapshot, delta) {
    const now = new Date();
    const key = dayKeyOf(now);
    if (snapshot.dayKey !== key) {
      snapshot.dayKey = key;
      snapshot.affectionGain = 0;
      snapshot.affectionLoss = 0;
    }

    const projected = {};
    for (const field of AFFECT_KEYS) {
      const raw = typeof delta[field] === 'number' ? delta[field] : 0;
      let value = raw;
      if (field === 'affection') {
        if (raw > 0) {
          value = Math.min(raw, Math.max(0, DAILY_GAIN_CAP - snapshot.affectionGain));
          snapshot.affectionGain += value;
        } else if (raw < 0) {
          value = Math.max(raw, Math.min(0, DAILY_LOSS_CAP - snapshot.affectionLoss));
          snapshot.affectionLoss += value;
        }
      }
      if (value !== 0) projected[field] = value;
    }
    return projected;
  }

  function recordEvent(type, delta = {}, options = {}) {
    const snapshot = getSnapshot();
    const state = snapshot.state;
    const now = new Date();

    const effective = boundedDelta(snapshot, delta);
    for (const field of Object.keys(effective)) {
      state[field] = clamp(state[field] + effective[field]);
    }
    state.mood = deriveMood(state);
    state.updatedAt = now.toISOString();

    const event = {
      type,
      source: typeof options.source === 'string' ? options.source : 'conversation',
      reason: typeof options.reason === 'string' ? options.reason : '',
      deltas: effective,
      createdAt: state.updatedAt,
    };
    snapshot.events = [...(Array.isArray(snapshot.events) ? snapshot.events : []), event].slice(-MAX_EVENTS);
    snapshot.lastEvent = { type, createdAt: state.updatedAt, reason: event.reason };

    store.save(snapshot);
    return getSnapshot();
  }

  function recordInteraction(input) {
    const text = String(input || '').toLowerCase();
    if (['谢谢', '感谢', '辛苦', '厉害', '棒', '喜欢'].some((word) => text.includes(word))) {
      return recordEvent('USER_PRAISE', { moodScore: 4, affection: 2, loneliness: -2, stress: -1 });
    }
    if (['讨厌', '烦', '闭嘴', '笨', '滚'].some((word) => text.includes(word))) {
      return recordEvent('USER_NEGATIVE', { moodScore: -4, affection: -1, stress: 2 });
    }
    return recordEvent('USER_CHAT', { moodScore: 1, loneliness: -1 });
  }

  function getEvents(options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : MAX_EVENTS;
    const events = Array.isArray(getSnapshot().events) ? getSnapshot().events : [];
    const filtered = options.type
      ? events.filter((event) => event.type === options.type)
      : events;
    return filtered.slice(-limit);
  }

  return {
    getState: () => getSnapshot().state,
    recordEvent,
    recordInteraction,
    getEvents,
  };
}

module.exports = { createEmotionService, deriveMood, DEFAULT_SNAPSHOT };