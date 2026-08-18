const assert = require('node:assert/strict');
const test = require('node:test');
const createWeatherSense = require('../src/systems/weather-sense');

test('weather source does not request network while disabled or unconfigured', async () => {
  let calls = 0;
  const source = createWeatherSense({
    settings: { isConfigured: () => false, getSettings: () => ({}) },
    fetchImpl: async () => { calls += 1; },
  });
  source.setEnabled(true);
  source.start();
  await source.poll();
  assert.equal(calls, 0);
  assert.equal(source.getPermissionStatus(), 'not-configured');
  assert.equal(source.getAwareness(), '');
  source.stop();
});

test('weather source fetches only current weather after explicit enablement', async () => {
  let calls = [];
  let clock = 1000;
  const source = createWeatherSense({
    settings: { isConfigured: () => true, getSettings: () => ({ latitude: 31.2304, longitude: 121.4737 }) },
    now: () => clock,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ current: { temperature_2m: 27.36, weather_code: 1, wind_speed_10m: 12.4 } }), { status: 200 });
    },
  });
  source.setEnabled(true);
  await source.poll();
  assert.match(calls[0][0], /api\.open-meteo\.com\/v1\/forecast/);
  assert.match(calls[0][0], /latitude=31\.2304/);
  assert.match(calls[0][0], /current=temperature_2m%2Cweather_code%2Cwind_speed_10m/);
  assert.equal(calls[0][1].method, undefined);
  assert.deepEqual(source.getSnapshot(), { condition: '晴间多云', temperatureC: 27.4, windSpeedKmh: 12.4, updatedAt: 1000, stale: false });
  assert.match(source.getAwareness(), /天气：晴间多云，27.4°C/);
  clock = 31_001;
  source.setTtl(30_000);
  assert.equal(source.getSnapshot().stale, true);
});

test('weather refresh clears a prior location snapshot before the next request', async () => {
  let calls = 0;
  const source = createWeatherSense({
    settings: { isConfigured: () => true, getSettings: () => ({ latitude: 1, longitude: 2 }) },
    fetchImpl: async () => new Response(JSON.stringify({ current: { temperature_2m: 20, weather_code: 0 } }), { status: 200 }),
  });
  source.setEnabled(true);
  await source.poll();
  assert.equal(source.getSnapshot().condition, '晴');
  source.refresh();
  assert.equal(source.getSnapshot().updatedAt, null);
  source.stop();
  assert.equal(calls, 0);
});

test('weather clear invalidates in-flight response', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const source = createWeatherSense({
    settings: { isConfigured: () => true, getSettings: () => ({ latitude: 1, longitude: 2 }) },
    fetchImpl: async () => pending,
  });
  source.setEnabled(true);
  const polling = source.poll();
  source.clear();
  release(new Response(JSON.stringify({ current: { temperature_2m: 20, weather_code: 0 } }), { status: 200 }));
  await polling;
  assert.equal(source.getSnapshot().updatedAt, null);
});
