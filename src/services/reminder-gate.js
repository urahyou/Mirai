const { inAllowedPeriod } = require('./proactive-policy');

function reminderGate({ now, proactiveSettings }) {
  const settings = proactiveSettings && typeof proactiveSettings === 'object' ? proactiveSettings : { enabled: false };
  if (settings.pausedUntil && new Date(settings.pausedUntil) > now) {
    return { deliver: false, reason: 'paused' };
  }
  if (!inAllowedPeriod(now, settings.quietHours)) {
    return { deliver: false, reason: 'quiet-hours' };
  }
  return { deliver: true, reason: 'ok' };
}

module.exports = { reminderGate, inAllowedPeriod };