// 小未来的本地生活编排器。只依据时间与 Core 生活状态选虚拟活动；
// 不调用 LLM、不执行真实购买或系统操作，活动结果仍由 Python Core 单点落库。
const E = require('../contracts/events');

let bus = null;
let life = null;
let offTick = null;
let chain = Promise.resolve();

function localDay(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function countToday(state, now, activityId) {
  const today = localDay(now);
  return (Array.isArray(state?.recentActivities) ? state.recentActivities : [])
    .filter((item) => item?.activityId === activityId && Number.isFinite(item.completedAt) && localDay(item.completedAt) === today)
    .length;
}

function chooseActivity(state, now = Date.now()) {
  if (!state || !Number.isFinite(now)) return null;
  if (Number.isFinite(state.updatedAt) && now < state.updatedAt) return null;
  const hour = new Date(now).getHours();
  const count = (id) => countToday(state, now, id);
  if (state.health < 35 || state.energy < 25) return count('rest') < 3 ? 'rest' : null;
  if (state.hunger >= 65) return 'meal';
  if (state.stress >= 65) return 'walk';
  if (state.boredom >= 60) return 'play';
  if (hour >= 8 && hour < 15 && state.energy >= 45 && count('school') < 1) return 'school';
  if (hour >= 15 && hour < 18 && state.energy >= 55 && count('work') < 1) return 'work';
  if (hour >= 18 && hour < 21 && state.money >= 100 && count('shopping') < 1) return 'shopping';
  if (hour >= 21 || hour < 7) return count('rest') < 2 ? 'rest' : null;
  return count('think') < 2 ? 'think' : null;
}

function tick(now = Date.now()) {
  if (!life) return Promise.resolve(null);
  chain = chain.catch(() => {}).then(async () => {
    const current = await life.advance(now);
    const activityId = chooseActivity(current, now);
    if (!activityId) return { state: current, activityId: null };
    const next = await life.performActivity(activityId, now);
    bus?.emit(E.LIFE.ACTIVITY_COMPLETED, { activityId, completedAt: now, state: next });
    return { state: next, activityId };
  });
  return chain;
}

function init({ eventBus, lifeState } = {}) {
  stop();
  bus = eventBus || null;
  life = lifeState || null;
  if (bus) offTick = bus.on(E.SENSING_TICK, ({ now } = {}) => { void tick(Number(now)); });
}

function stop() {
  try { offTick?.(); } catch {}
  offTick = null;
  bus = null;
  life = null;
  chain = Promise.resolve();
}

module.exports = { chooseActivity, tick, init, stop, _reset: stop };
