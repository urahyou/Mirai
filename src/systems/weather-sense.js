const DEFAULT_POLL_MS = 15 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

const WEATHER_CODES = Object.freeze({
  0: '晴', 1: '晴间多云', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '冰粒', 80: '阵雨',
  81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪', 95: '雷暴',
  96: '冰雹雷暴', 99: '强冰雹雷暴',
});

module.exports = function createWeatherSense({ settings, fetchImpl = (...args) => fetch(...args), now = () => Date.now(), pollMs = DEFAULT_POLL_MS } = {}) {
  let enabled = false;
  let ttlMs = DEFAULT_TTL_MS;
  let timer = null;
  let generation = 0;
  let snapshot = { condition: null, temperatureC: null, windSpeedKmh: null, updatedAt: null };

  function configured() {
    return Boolean(settings?.isConfigured?.());
  }

  function clear() {
    generation += 1;
    snapshot = { condition: null, temperatureC: null, windSpeedKmh: null, updatedAt: null };
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) { stop(); clear(); }
  }

  function setTtl(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) ttlMs = Math.max(30000, Math.min(86400000, Math.round(parsed)));
  }

  function isRunning() { return Boolean(timer); }
  function getPermissionStatus() { return configured() ? 'granted' : 'not-configured'; }
  function isFresh() { return Number.isFinite(snapshot.updatedAt) && now() - snapshot.updatedAt < ttlMs; }

  function getSnapshot() {
    if (!isFresh()) return { condition: null, temperatureC: null, windSpeedKmh: null, updatedAt: snapshot.updatedAt, stale: Boolean(snapshot.updatedAt) };
    return { ...snapshot, stale: false };
  }

  function getAwareness() {
    const current = getSnapshot();
    if (!current.condition || typeof current.temperatureC !== 'number') return '';
    const wind = typeof current.windSpeedKmh === 'number' ? `，风速 ${current.windSpeedKmh} km/h` : '';
    return `天气：${current.condition}，${current.temperatureC}°C${wind}`;
  }

  async function poll() {
    if (!enabled || !configured()) return getSnapshot();
    const location = settings.getSettings();
    const generationAtStart = generation;
    const params = new URLSearchParams({
      latitude: String(location.latitude), longitude: String(location.longitude),
      current: 'temperature_2m,weather_code,wind_speed_10m', timezone: 'auto',
    });
    const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`天气服务返回 HTTP ${response.status}`);
    const current = (await response.json())?.current;
    const temperatureC = Number(current?.temperature_2m);
    const windSpeedKmh = Number(current?.wind_speed_10m);
    const code = Number(current?.weather_code);
    if (!Number.isFinite(temperatureC) || !Number.isFinite(code)) throw new Error('天气服务响应不完整');
    if (!enabled || generationAtStart !== generation) return getSnapshot();
    snapshot = {
      condition: WEATHER_CODES[code] || '天气未知',
      temperatureC: Math.round(temperatureC * 10) / 10,
      windSpeedKmh: Number.isFinite(windSpeedKmh) ? Math.round(windSpeedKmh * 10) / 10 : null,
      updatedAt: now(),
    };
    return getSnapshot();
  }

  function start() {
    if (!enabled || !configured() || timer) return;
    void poll().catch(() => {});
    timer = setInterval(() => { void poll().catch(() => {}); }, pollMs);
  }

  function refresh() {
    stop();
    clear();
    if (enabled && configured()) start();
    return getSnapshot();
  }

  return { start, stop, refresh, poll, clear, setEnabled, setTtl, isRunning, getPermissionStatus, getSnapshot, getAwareness };
};

module.exports.WEATHER_CODES = WEATHER_CODES;
