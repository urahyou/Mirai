// 低频内心活动编排器：只消费本地领域事件，不轮询 LLM，也不把梦境写成事实。
const E = require('../contracts/events');

let bus = null;
let memory = null;
let offActivity = null;
let offTick = null;
let chain = Promise.resolve();

function localDay(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function activityThought(activityId) {
  const lines = {
    school: '今天去上学的时候，我有认真记笔记。虽然有一点点累，但学到东西还是很开心。',
    work: '刚才认真做完了一件小事，心里有种悄悄变厉害的感觉。',
    play: '玩了一会儿以后，脑袋里那些乱糟糟的小念头都松开了一点。',
    walk: '散步的时候，我想起主人也应该偶尔停下来喘口气。',
    shopping: '逛街时看到一些可爱的东西，我忍不住想：主人会不会喜欢呢？',
    meal: '吃饱以后暖暖的，我希望主人今天也有好好吃东西。',
    rest: '休息了一会儿，终于觉得自己可以慢一点，也没有关系。',
    think: '刚才发了一会儿呆。我在想，陪伴有时候是不是只要安静待在旁边就够了。',
  };
  return lines[activityId] || '刚刚发生的小事让我停下来想了一会儿，我想把它好好记住。';
}

async function hasEntry(kind, day) {
  const rows = await memory.listMind(kind, 50);
  return rows.some((row) => (kind === 'dreams' ? row.dreamDate : String(row.createdAt || '').slice(0, 10)) === day);
}

function enqueue(task) {
  chain = chain.catch(() => {}).then(task).catch(() => null);
  return chain;
}

function recordActivityThought({ activityId, completedAt, state } = {}) {
  if (!memory || !activityId || !Number.isFinite(completedAt)) return Promise.resolve(null);
  const sourceId = state?.recentActivities?.at?.(-1)?.id || `activity:${activityId}:${completedAt}`;
  return enqueue(() => memory.recordThought({
    createdAt: new Date(completedAt).toISOString(), kind: 'activity', content: activityThought(activityId),
    sourceIds: [sourceId], emotion: { focus: activityId === 'school' || activityId === 'work' ? 0.65 : 0.5 }, certainty: 0.7,
    expiresAt: new Date(completedAt + 12 * 60 * 60 * 1000).toISOString(),
  }));
}

function nightly(now) {
  if (!memory || !Number.isFinite(now)) return Promise.resolve(null);
  const hour = new Date(now).getHours();
  if (hour !== 22 && hour !== 23) return Promise.resolve(null);
  return enqueue(async () => {
    const day = localDay(now);
    const thoughts = await memory.listMind('thoughts', 8);
    const sources = thoughts.slice(0, 3).map((item) => item.id);
    if (hour === 22 && !await hasEntry('reflections', day)) {
      return memory.recordReflection({ periodStart: day, periodEnd: day, createdAt: new Date(now).toISOString(), kind: 'daily', sourceIds: sources, confidence: 0.45, content: '今天发生的事情有些已经变成小小的念头了。我想慢慢学着分清楚：哪些是真的发生过，哪些只是我希望能发生。' });
    }
    if (hour === 23 && !await hasEntry('dreams', day)) {
      return memory.recordDream({ dreamDate: day, createdAt: new Date(now).toISOString(), sourceIds: sources, emotion: { calm: 0.6 }, content: '我做了一个轻轻的梦。梦里没有需要完成的事，只有我和一些不会熄灭的小灯。醒来以后，我知道那只是梦，可还是觉得心里暖暖的。' });
    }
    return null;
  });
}

function init({ eventBus, companionMemory } = {}) {
  stop();
  bus = eventBus || null;
  memory = companionMemory || null;
  if (bus) {
    offActivity = bus.on(E.LIFE.ACTIVITY_COMPLETED, (event) => { void recordActivityThought(event); });
    offTick = bus.on(E.SENSING_TICK, ({ now } = {}) => { void nightly(Number(now)); });
  }
}

function stop() {
  try { offActivity?.(); } catch {}
  try { offTick?.(); } catch {}
  offActivity = null; offTick = null; bus = null; memory = null; chain = Promise.resolve();
}

module.exports = { init, stop, activityThought, recordActivityThought, nightly, _reset: stop };
