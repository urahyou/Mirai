const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const createVoice = require('../src/main/voice');

test('voice queue waits for renderer playback completion before synthesizing the next segment', () => {
  const bridge = new EventEmitter();
  const spoken = [];
  const sent = [];
  const listeners = new Map();
  bridge.getSidecarEnv = () => ({ SIDECAR_TTS_ENGINE: 'gpt-sovits' });
  bridge.speak = (text) => spoken.push(text);
  bridge.getStatus = () => ({});
  const state = { _ttsEnabledCache: null, _speakBusy: false, _speakRequestId: null, _speakPending: null, _speakActiveAudioId: null, mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } }, isVoiceListening: { value: false } };
  const api = createVoice({ voiceBridge: bridge, generic: { translate: async (text) => text }, voiceEnv: { read: () => ({ SIDECAR_TTS_ENABLED: 'true' }), write: () => {} }, ipcMain: { handle: () => {}, on: (channel, handler) => listeners.set(channel, handler) }, state, sendToChatInput: () => {}, handleUserUtterance: () => {} });
  api.speak('第一句。');
  api.speak('第二句。');
  assert.deepEqual(spoken, ['第一句。']);
  bridge.emit('audio', { id: 1, format: 'wav', data: Buffer.from([1]) });
  assert.deepEqual(spoken, ['第一句。']);
  assert.equal(sent[0][0], 'voice:audio');
  listeners.get('voice:playback-finished')({}, 1, 'ended');
  assert.deepEqual(spoken, ['第一句。', '第二句。']);
  bridge.emit('audio', { id: 2, format: 'wav', data: Buffer.from([2]) });
  listeners.get('voice:playback-finished')({}, 2, 'ended');
});

test('voice queue releases immediately when sidecar reports a TTS error', () => {
  const bridge = new EventEmitter();
  const spoken = [];
  const listeners = new Map();
  let nextId = 0;
  bridge.getSidecarEnv = () => ({ SIDECAR_TTS_ENGINE: 'gpt-sovits' });
  bridge.speak = (text) => { spoken.push(text); return ++nextId; };
  bridge.getStatus = () => ({});
  const state = { _ttsEnabledCache: null, _speakBusy: false, _speakRequestId: null, _speakPending: null, _speakActiveAudioId: null, mainWindow: { isDestroyed: () => true }, isVoiceListening: { value: false } };
  const api = createVoice({ voiceBridge: bridge, generic: { translate: async (text) => text }, voiceEnv: { read: () => ({ SIDECAR_TTS_ENABLED: 'true' }), write: () => {} }, ipcMain: { handle: () => {}, on: (channel, handler) => listeners.set(channel, handler) }, state, sendToChatInput: () => {}, handleUserUtterance: () => {} });
  api.speak('第一句。');
  api.speak('第二句。');
  bridge.emit('tts-error', { id: 1, error: 'HTTP 400' });
  assert.deepEqual(spoken, ['第一句。', '第二句。']);
  assert.equal(state._speakBusy, true);
  void api;
});
