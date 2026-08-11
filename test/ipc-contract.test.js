const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { IPC_ERROR, validatePayload } = require('../src/main/ipc-validation');

function assertRejected(channel, args) {
  assert.deepEqual(validatePayload(channel, args), IPC_ERROR);
}

test('Given a personality patch When validation receives valid data Then it returns normalized arguments', () => {
  assert.deepEqual(validatePayload('personality:set', [{ name: '小暖', personality: { mood: '元気', likes: ['团子'], tone: '俏皮', selfIntro: 'test' } }]), {
    ok: true,
    data: [{ name: '小暖', personality: { mood: '元気', likes: ['团子'], tone: '俏皮', selfIntro: 'test' } }],
  });
});

test('Given malformed or unrelated IPC payloads When validation runs Then every rejection uses the uniform error', () => {
  assertRejected('personality:set', [null]);
  assertRejected('personality:set', [{ name: 'x'.repeat(41) }]);
  assertRejected('personality:set', [{ personality: { likes: ['ok', 42] } }]);
  assertRejected('personality:set', [{ personality: { tone: 'x'.repeat(1001) } }]);
  assertRejected('display:set', [{ scale: 0.69 }]);
  assertRejected('display:set', [{ scale: 1, alwaysOnTop: 'yes' }]);
  assertRejected('tool:execute', [{ command: 'whoami' }]);
});

test('Given display settings When validation receives a bounded patch Then it accepts the patch', () => {
  assert.deepEqual(validatePayload('display:set', [{ scale: 1.25, alwaysOnTop: false }]), {
    ok: true,
    data: [{ scale: 1.25, alwaysOnTop: false }],
  });
});

test('Given the preload bridge When its public surface is inspected Then it exposes no tool-execution or Node capability', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');

  assert.doesNotMatch(preload, /\b(tool|execute|exec|spawn|child_process|require\(['"](?:fs|node:fs|child_process))/i);
  assert.doesNotMatch(preload, /memory|proactive|schedule|owner/i);
  assert.match(preload, /personality:\s*Object\.freeze/);
  assert.match(preload, /display:\s*Object\.freeze/);
  assert.match(preload, /providers:\s*Object\.freeze/);
  assert.match(preload, /chatSubmit/);
  assert.match(preload, /getChatHistory/);
  assert.match(preload, /setChatExpanded/);
});

test('Given chat expansion IPC When validation receives a boolean Then it accepts only that boolean', () => {
  assert.deepEqual(validatePayload('chat:setExpanded', [true]), { ok: true, data: [true] });
  assertRejected('chat:setExpanded', ['true']);
});

test('Given a pending chat request When the input window is inspected Then the composer remains editable', () => {
  const chatInput = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat-input.js'), 'utf8');

  assert.doesNotMatch(chatInput, /input\.disabled\s*=/);
  assert.match(chatInput, /sendButton\.disabled\s*=\s*true/);
});

test('Given the chat window When its markup is inspected Then compact and expanded modes both expose close control', () => {
  const chatInput = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat-input.html'), 'utf8');
  const chatScript = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat-input.js'), 'utf8');

  assert.match(chatInput, /id="close-button"/);
  assert.match(chatInput, /id="history-list"/);
  assert.match(chatScript, /closeChatInput\(\)/);
  assert.match(chatScript, /expanded \? '−' : '⤢'/);
});

test('Given a long reply When the balloon is inspected Then its text area can receive scroll input', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

  assert.match(style, /#balloon\s*\{[\s\S]*?pointer-events:\s*auto/);
  assert.match(style, /#balloon-text\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('Given the character renderer When it is inspected Then rendering and hit testing are Live2D-only', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const style = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

  assert.match(renderer, /live2dAvatar\?\.isHit/);
  assert.match(renderer, /live2dAvatar\?\.setState/);
  assert.doesNotMatch(renderer, /assets\/character|character-img|getImageData/);
  assert.doesNotMatch(index, /character-img|assets\/character/);
  assert.doesNotMatch(style, /character-img|live2d-fallback/);
});

test('Given concurrent character and chat replies When the renderer handles them Then stale interactions cannot replace formal chat', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

  assert.match(renderer, /formalChatActive/);
  assert.match(renderer, /requestToken === bubbleToken/);
  assert.match(renderer, /GREET_COOLDOWN_MS/);
  assert.match(renderer, /data\.started/);
});

test('Given the Live2D avatar When hit testing is inspected Then it checks model geometry', () => {
  const avatar = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'live2d-avatar.js'), 'utf8');

  assert.match(avatar, /this\.model\.hitTest/);
  assert.match(avatar, /this\.model\.containsPoint/);
});
