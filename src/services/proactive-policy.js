function inAllowedPeriod(now, quietHours) {
  const minute = now.getHours() * 60 + now.getMinutes();
  const periods = quietHours && Array.isArray(quietHours.allow) ? quietHours.allow : [];
  if (quietHours && Array.isArray(quietHours.weekdays) && !quietHours.weekdays.includes(now.getDay())) return false;
  return periods.some(([start, end]) => (start <= end ? minute >= start && minute < end : minute >= start || minute < end));
}

function historyForPeriod(history, now, start) {
  return history.filter((entry) => {
    const at = new Date(entry.at);
    return !Number.isNaN(at.getTime()) && at >= start && at <= now;
  });
}

function createProactivePolicy(options) {
  if (typeof options === 'function') {
    return Object.freeze({ decide: (context) => options(context) });
  }
  if (options !== undefined && (!options || typeof options !== 'object' || typeof options.getSettings !== 'function')) {
    throw new TypeError('options.getSettings must be a function when provided');
  }

  function decide(context = {}) {
    const settings = options ? options.getSettings() : { enabled: false };
    if (!settings.enabled) return { shouldPrompt: false, reason: 'disabled' };

    const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
    const history = Array.isArray(context.promptHistory) ? context.promptHistory : [];
    if (settings.pausedUntil && new Date(settings.pausedUntil) > now) return { shouldPrompt: false, reason: 'paused' };
    if (!inAllowedPeriod(now, settings.quietHours)) return { shouldPrompt: false, reason: 'quiet-hours' };

    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    if (historyForPeriod(history, now, hourStart).length >= settings.hourlyBudget) return { shouldPrompt: false, reason: 'hourly-budget' };
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    if (historyForPeriod(history, now, dayStart).length >= settings.dailyBudget) return { shouldPrompt: false, reason: 'daily-budget' };

    const latest = history.reduce((latestEntry, entry) => {
      const at = new Date(entry.at);
      return !Number.isNaN(at.getTime()) && (!latestEntry || at > new Date(latestEntry.at)) ? entry : latestEntry;
    }, null);
    if (latest && now - new Date(latest.at) < settings.cooldownMinutes * 60 * 1000) return { shouldPrompt: false, reason: 'cooldown' };
    if (context.content && history.some((entry) => entry.content === context.content)) return { shouldPrompt: false, reason: 'repeated-content' };
    return { shouldPrompt: true, reason: 'eligible' };
  }

  return Object.freeze({ decide });
}

module.exports = { createProactivePolicy, inAllowedPeriod };
