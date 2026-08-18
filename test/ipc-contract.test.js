const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { IPC_ERROR, validatePayload } = require('../src/main/ipc-validation');
const IPC = require('../src/contracts/ipc');

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
  assertRejected('display:set', [{ outlineShadow: 'yes' }]);
  assertRejected('tool:execute', [{ command: 'whoami' }]);
});

test('Given display settings When validation receives a bounded patch Then it accepts the patch', () => {
  assert.deepEqual(validatePayload('display:set', [{ scale: 1.25, alwaysOnTop: false, outlineShadow: true }]), {
    ok: true,
    data: [{ scale: 1.25, alwaysOnTop: false, outlineShadow: true }],
  });
});

test('Given a voice settings patch When validation runs Then it accepts SIDECAR keys and rejects others', () => {
  assert.deepEqual(validatePayload('voiceSettings:set', [{ SIDECAR_TTS_SPEAK_LANG: 'ja', SIDECAR_TTS_ENGINE: 'edge' }]), {
    ok: true,
    data: [{ SIDECAR_TTS_SPEAK_LANG: 'ja', SIDECAR_TTS_ENGINE: 'edge' }],
  });
  // 空串合法（选择“跟随回复”→ 中文发音）
  assert.deepEqual(validatePayload('voiceSettings:set', [{ SIDECAR_TTS_SPEAK_LANG: '' }]), {
    ok: true,
    data: [{ SIDECAR_TTS_SPEAK_LANG: '' }],
  });
  // 非法键 / 非对象 / 长度超限一律拒绝
  assertRejected('voiceSettings:set', [{ TEMP: 'x' }]);
  assertRejected('voiceSettings:set', [{ SIDECAR_TTS_ENGINE: 'x'.repeat(501) }]);
  assertRejected('voiceSettings:set', ['not-an-object']);
});

test('Given the preload bridge When its public surface is inspected Then it exposes no tool-execution or Node capability', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');

  assert.doesNotMatch(preload, /\b(tool|execute|exec|spawn|child_process|require\(['"](?:fs|node:fs|child_process))/i);
  assert.doesNotMatch(preload, /proactive|schedule|owner/i);
  assert.match(preload, /personality:\s*Object\.freeze/);
  assert.match(preload, /display:\s*Object\.freeze/);
  assert.match(preload, /providers:\s*Object\.freeze/);
  assert.match(preload, /chatSubmit/);
  assert.match(preload, /getChatHistory/);
  assert.match(preload, /setChatExpanded/);
  assert.match(preload, /playbackFinished/);
  assert.match(preload, /memory:\s*Object\.freeze/);
  assert.match(preload, /debug:\s*Object\.freeze/);
  assert.match(preload, /setMousePassthrough/);
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

test('Given the diary panel When generation is requested Then it uses an explicit action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'display-panel.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'display-panel.js'), 'utf8');
  assert.match(html, /id="diaryGenerateBtn"/);
  assert.match(script, /diary\.generateToday\(\)/);
  assert.match(script, /diaryGenerateBtn.*addEventListener\('click'/s);
});

test('Given the diary and memory readers When they are inspected Then they are separate read-only entries', () => {
  const diaryHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'diary-panel.html'), 'utf8');
  const diaryScript = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'diary-panel.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'memory-panel.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'memory-panel.js'), 'utf8');
  assert.match(diaryHtml, /id="diaryList"/);
  assert.match(diaryScript, /diary\.list\(\)/);
  assert.match(diaryScript, /diary\.get\(item\.date\)/);
  assert.doesNotMatch(html, /diaryList|diaryView|日记册/);
  assert.match(html, /id="memoryList"/);
  assert.match(html, /data-kind="vectors"/);
  assert.match(html, /data-kind="graph"/);
  assert.match(html, /data-kind="thoughts"/);
  assert.match(script, /memory\.list\(kind\)/);
  assert.match(script, /memory\.getGraph\(\)/);
  assert.match(script, /memory\.listMind\(kind\)/);
  assert.doesNotMatch(script, /innerHTML/);
});

test('Given a streamed reply When it contains a stage direction Then only the cue reaches Live2D', () => {
  const chat = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'chat.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  assert.match(chat, /parseResponseMarkup\(full\)/);
  assert.match(chat, /cues: latestCues/);
  assert.match(renderer, /applyStateCues\(data\.cues\)/);
  assert.match(renderer, /playMotion\('Tap'/);
});

test('Given a long reply When the balloon is inspected Then its text area can receive scroll input', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'balloon.css'), 'utf8');

  assert.match(style, /#balloon\s*\{[\s\S]*?pointer-events:\s*auto/);
  assert.match(style, /#balloon-text\s*\{[\s\S]*?overflow-y:\s*auto/);
});

test('Given the pet speaks When the balloon is positioned Then it is centered above the character head', () => {
  const style = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'balloon.css'), 'utf8');

  assert.match(style, /#balloon\s*\{[\s\S]*?top:\s*4px;[\s\S]*?left:\s*50%/);
  assert.match(style, /#balloon\.show\s*\{[\s\S]*?translate\(-50%,\s*0\)/);
  assert.match(style, /\.balloon-tail\s*\{[\s\S]*?left:\s*50%[\s\S]*?translateX\(-50%\) rotate\(45deg\)/);
});

test('Given the compact chat opens When positioned Then its center overlays the character belly', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const windows = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window.js'), 'utf8');
  const openChatSection = windows.slice(windows.indexOf('function openChatInputWindow'), windows.indexOf('function resizeChatInputWindow'));

  assert.match(main, /CHAT_INPUT_BELLY_CENTER_RATIO\s*=\s*0\.68/);
  assert.match(openChatSection, /bellyCenterX - width \/ 2/);
  assert.match(openChatSection, /bellyCenterY - height \/ 2/);
  assert.match(openChatSection, /workArea\.x \+ WORK_AREA_MARGIN/);
});

test('Given the character renderer When it is inspected Then rendering and hit testing are Live2D-only', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const style = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

  assert.match(renderer, /live2dAvatar\?\.isHit/);
  assert.match(renderer, /live2dAvatar\?\.setState/);
  const avatar = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'live2d-avatar.js'), 'utf8');
  assert.match(avatar, /state === 'happy'.*playMotion\('Tap'/s);
  assert.match(avatar, /state === 'sad'.*playMotion\('FlickDown'/s);
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

test('Given the Live2D avatar When hit testing is inspected Then it checks rendered alpha only', () => {
  const avatar = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'live2d-avatar.js'), 'utf8');

  assert.match(avatar, /isRenderedPixelHit/);
  assert.match(avatar, /ALPHA_HIT_THRESHOLD/);
  assert.match(avatar, /preserveDrawingBuffer:\s*true/);
  assert.match(avatar, /gl\.readPixels\(pixelX, pixelY, 1, 1, gl\.RGBA, gl\.UNSIGNED_BYTE, pixel\)/);
  assert.doesNotMatch(avatar, /generateTexture/);
  assert.doesNotMatch(avatar, /this\.model\.hitTest/);
  assert.doesNotMatch(avatar, /this\.model\.containsPoint/);
});

test('Given always-on-top display settings When the main window is updated Then it remains visible over macOS fullscreen workspaces', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window.js'), 'utf8');
  const balloons = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'balloon.js'), 'utf8');

  assert.match(main, /setVisibleOnAllWorkspaces\(shouldStayVisible,\s*\{\s*visibleOnFullScreen:\s*shouldStayVisible/);
  // 气泡窗始终置顶（screen-saver）已在独立气泡窗模块内实现
  assert.match(balloons, /setAlwaysOnTop\(true, 'screen-saver'\)/);
});

test('Given a context menu opens When its content loads Then it is positioned before becoming visible', () => {
  const panels = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'panel.js'), 'utf8');
  const menuSection = panels.slice(panels.indexOf('function openMenuWindow'), panels.indexOf('function repositionMenu'));

  assert.match(menuSection, /show:\s*false/);
  assert.match(menuSection, /setMenuPosition\(point\)/);
  assert.match(menuSection, /once\('ready-to-show',[\s\S]*?menuWindow\.show\(\)/);
});

test('Given a repositioned chat or balloon When it closes or hides Then its relative position is persisted', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'window.js'), 'utf8');
  const balloon = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'balloon.js'), 'utf8');

  assert.match(main, /windowLayout\.setLayout\([\s\S]*?chatOffset/);
  assert.match(main, /windowLayout\.getLayout\(\)\.chatOffset/);
  assert.match(balloon, /BUBBLE_POSITION_STORAGE_KEY/);
  assert.match(balloon, /window\.localStorage\.setItem/);
  assert.match(balloon, /balloon\.addEventListener\('mousedown'/);
  assert.match(balloon, /if \(balloonDragging\) saveBalloonPosition\(\)/);
});

test('Given transparent space around the character When pointer hit testing runs Then the pet window becomes mouse-transparent', () => {
  const win = fs.readFileSync(path.join(__dirname, '..', 'src', 'subsystems', 'window.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

  assert.match(win, /IPC\.WindowSetMousePassthrough/);
  assert.match(win, /setIgnoreMouseEvents\(true, \{ forward: true \}\)/);
  assert.match(renderer, /setMousePassthrough\(!characterHit && !bubbleHit\)/);
  assert.match(renderer, /if \(dragging\)[\s\S]*?setMousePassthrough\(false\)/);
});

test('Given model max context larger than the 128k soft limit When saving context Then values up to the probe limit are accepted', () => {
  const ctx = { contextMaxTokens: 393216 }; // 探测到 384K 的模型上限
  assert.deepEqual(validatePayload('context:set', [{ maxContextTokens: 200000 }], ctx), { ok: true, data: [{ maxContextTokens: 200000 }] });
  assert.deepEqual(validatePayload('context:set', [{ maxContextTokens: 393216 }], ctx), { ok: true, data: [{ maxContextTokens: 393216 }] });
  // 超过探测上限仍拒绝
  assertRejected('context:set', [{ maxContextTokens: 393217 }]);
  // 不让 ctx 时默认软上限 128k
  assertRejected('context:set', [{ maxContextTokens: 200000 }]);
});

test('Given no model context info When saving context Then the soft limit 128k applies', () => {
  assert.deepEqual(validatePayload('context:set', [{ maxContextTokens: 131072 }]), { ok: true, data: [{ maxContextTokens: 131072 }] });
  assertRejected('context:set', [{ maxContextTokens: 131073 }]);
});

test('Given the IPC contract single source When compared to the preload bridge Then every channel matches bidirectionally', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');  const ipcValues = Object.values(IPC);

  // preload 每次出现的 channel 字面量都必须来自契约（无多余/拼写漂移）
  const preloadChannels = [...preload.matchAll(/'([a-zA-Z]+:[a-zA-Z-]+)'/g)].map((m) => m[1]);
  for (const ch of preloadChannels) {
    assert.ok(ipcValues.includes(ch), `preload 用了契约外的通道: ${ch}`);
  }

  // 契约里每个 channel 都必须被 preload 桥显式引用（无遗漏）
  const unique = new Set(preloadChannels);
  for (const v of ipcValues) {
    assert.ok(unique.has(v), `契约通道未被 preload 桥引用: ${v}`);
  }

  // 契约常量全部为字符串通道名
  for (const v of ipcValues) assert.equal(typeof v, 'string');
  assert.ok(ipcValues.length >= 60, '契约通道数量应覆盖全部 IPC');
});

test('Given IPC handlers are decomposed into subsystems, main.js stays a pure assembler', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  // L3：IPC 处理器一律收拢到 src/subsystems/*.js，main.js 只做装配，不再直接注册 IPC。
  assert.doesNotMatch(main, /ipcMain\.(handle|on)\(/);
  assert.doesNotMatch(main, /IPC\.[A-Za-z]/);

  // 每个能力子系统都从契约引用通道（无裸字符串/拼写漂移）
  const ipcKeys = Object.keys(IPC);
  for (const f of ['personality', 'display', 'voice', 'provider', 'context', 'memory', 'balloon', 'window', 'menu']) {
    const sub = fs.readFileSync(path.join(__dirname, '..', 'src', 'subsystems', `${f}.js`), 'utf8');
    for (const m of sub.matchAll(/IPC\.([A-Za-z]+)/g)) {
      assert.ok(ipcKeys.includes(m[1]), `subsystems/${f}.js 用了契约外的通道: ${m[0]}`);
    }
    assert.doesNotMatch(sub, /'(?:[a-zA-Z]+:[a-zA-Z-]+)'/); // 不该出现裸通道字面量
  }
});

test('Given IPC subsystems use actual module paths, they can all be required', () => {
  // 回归守卫：require 路径错误（如 './subsystems' vs '../subsystems'）只能靠运行或本测试暴露。
  const mountIpc = require('../src/subsystems');
  assert.equal(typeof mountIpc, 'function');
  for (const f of ['personality', 'display', 'voice', 'provider', 'context', 'memory', 'balloon', 'window', 'menu']) {
    assert.equal(typeof require(`../src/subsystems/${f}`), 'function', `${f} 子系统应导出 setup(api)`);
  }
  // main.js 引用的子系统路径必须真实存在（避免 './subsystems' 这类相对路径错误）
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const m = main.match(/const mountIpc = require\(['"]([^'"]+)['"]\)/);
  assert.ok(m, 'main.js 应 require subsystems');
  const resolved = require.resolve(path.join(__dirname, '..', 'src', 'main', m[1]));
  assert.ok(fs.existsSync(resolved), `main.js 引用的子系统模块不存在: ${m[1]}`);
});

test('Given the debug panel When inspected Then it reads runtime entries without injecting model content as HTML', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'debug-panel.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'debug-panel.js'), 'utf8');
  assert.match(html, /id="entryList"/);
  assert.match(script, /debug\.getEntries\(\)/);
  assert.match(script, /textContent = JSON\.stringify/);
  assert.doesNotMatch(script, /innerHTML/);
});

test('Given more settings cards than the initial viewport When the settings center is inspected Then its card area scrolls independently', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings-center.css'), 'utf8');
  assert.match(css, /\.center-content\s*\{[\s\S]*?flex:\s*1 1 auto[\s\S]*?min-height:\s*0[\s\S]*?overflow-y:\s*auto/);
});
