// 聊天调度核心模块：多轮对话、单句点击回应、流式广播、上下文压缩预算、聊天 IPC。
//
// 通过依赖注入获得所需能力，避免直接触碰主进程其它模块的可变全局：
//   - generic / chatHistory / graphitiMemory / contextSettings / probeMaxContext / state / ipcMain
//   - voice.speak：回复生成后让小未来朗读
//   - sendToChatInput：把聊天历史/增量推给聊天输入窗
//   - windowOps：聊天输入窗的开关/缩放/置顶（由主进程提供，避免循环依赖）
//   - consts：聊天气泡输入框的紧凑/展开尺寸
// handleUserUtterance 需要穿搭给语音子系统（语音识别最终结果自动发送时用），
// 主进程通过惰性引用注入，避免 voice ⇄ chat 循环 require。
module.exports = function createChat({
  ipcMain, state, generic, chatHistory, graphitiMemory, contextSettings, probeMaxContext,
  voice, sendToChatInput,
  windowOps: { openChatInputWindow, closeChatInputWindow, resizeChatInputWindow, setMainWindowAlwaysOnTop, displaySettings },
  consts: { CHAT_INPUT_COMPACT_SIZE, CHAT_INPUT_EXPANDED_SIZE },
}) {
  const crypto = require('crypto');
  const { BrowserWindow } = require('electron');

  function broadcastChatDelta(data) {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.webContents.send('chat:delta', data);
    sendToChatInput('chat:delta', data);
  }

  function enqueueChat(work) {
    const run = state.chatQueue.then(work, work);
    state.chatQueue = run.catch(() => {});
    return run;
  }

  async function generatePetLine(purpose) {
    for (const provider of generic.providerChain()) {
      try {
        if (!(await generic.isAvailable(provider))) continue;
        const line = await generic.generatePetLine({ provider, purpose });
        if (line.trim()) return line.trim();
      } catch {
        // Try the next configured provider.
      }
    }
    return '';
  }

  async function generateChat(input, emit) {
    const graphitiResults = await graphitiMemory.search(input);
    const memoryContext = graphitiMemory.formatContext(graphitiResults);
    const contextMaxTokens = contextSettings.getSettings(state.cachedModelMaxTokens).maxContextTokens;
    for (const provider of generic.providerChain()) {
      try {
        if (!(await generic.isAvailable(provider))) continue;
        return await generic.generateReply(input, { provider, onDelta: emit, memoryContext, contextMaxTokens });
      } catch {
        // Try the next configured provider.
      }
    }
    return '现在没能连上本地模型，稍后再和我聊聊吧。';
  }

  // 探测当前 active provider 的模型最大上下文并缓存（失败返回 null，不阻塞）。
  async function refreshModelMaxTokens() {
    try {
      const chain = generic.providerChain();
      if (!chain.length) { state.cachedModelMaxTokens = null; return null; }
      const config = generic.getProviderConfig();
      const provider = chain[0] && config.providers[chain[0]];
      state.cachedModelMaxTokens = provider ? await probeMaxContext(provider, generic.authorizationHeaders) : null;
    } catch {
      state.cachedModelMaxTokens = null;
    }
    return state.cachedModelMaxTokens;
  }

  async function handleUserUtterance(rawInput) {
    const input = String(rawInput || '').trim().slice(0, 4000);
    if (!input) return '';
    const turnId = crypto.randomUUID();
    const userMessage = chatHistory.appendMessage('user', input);
    sendToChatInput('chat:history', { message: userMessage, turnId });
    broadcastChatDelta({ started: true, done: false, turnId });
    const emit = (chunk, full) => {
      broadcastChatDelta({ chunk, full, done: false, turnId });
    };
    const reply = await enqueueChat(() => generateChat(input, emit));
    const assistantMessage = chatHistory.appendMessage('assistant', reply);
    const episode = [
      { role: 'user', content: input },
      { role: 'assistant', content: reply },
    ];
    void graphitiMemory.add(episode, new Date(userMessage.createdAt).toISOString());
    sendToChatInput('chat:history', { message: assistantMessage, turnId });
    broadcastChatDelta({ chunk: '', full: reply, done: true, turnId });
    // 语音输出：让小未来开口说这句回复
    voice.speak(reply);
    return reply;
  }

  ipcMain.handle('character:greet', async () => {
    const reply = await generatePetLine('click');
    if (reply) {
      const message = chatHistory.appendMessage('assistant', reply);
      sendToChatInput('chat:history', { message, source: 'interaction' });
      voice.speak(reply);
    }
    return reply;
  });

  ipcMain.handle('chat:openInput', () => { openChatInputWindow(); return true; });
  ipcMain.handle('chat:closeInput', () => { closeChatInputWindow(); return true; });
  ipcMain.handle('chat:getHistory', () => chatHistory.getMessages());

  ipcMain.handle('chat:setExpanded', (_event, expanded) => {
    state.chatInputExpanded = expanded;
    if (state.chatInputWindow && !state.chatInputWindow.isDestroyed()) {
      if (expanded) {
        // 展开成普通窗口：聊天窗可被覆盖；人物保持 floating 置顶（不消失）
        setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
        state.chatInputWindow.setAlwaysOnTop(false);
      } else {
        // 收起成悬浮输入框：角色降到 floating（仍高于微信），对话浮动在人物之上
        setMainWindowAlwaysOnTop(displaySettings.getSettings().alwaysOnTop);
        state.chatInputWindow.setAlwaysOnTop(true, 'floating');
        state.chatInputWindow.moveTop();
      }
    }
    const target = expanded ? CHAT_INPUT_EXPANDED_SIZE : CHAT_INPUT_COMPACT_SIZE;
    return resizeChatInputWindow(state.chatInputWindow, target.width, target.height);
  });

  ipcMain.handle('chat:resizeInput', (event, requestedHeight) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    if (win !== state.chatInputWindow || state.chatInputExpanded) return true;
    const height = Math.max(96, Math.min(220, Math.round(Number(requestedHeight) || 96)));
    const [width] = win.getContentSize();
    return resizeChatInputWindow(win, width, height);
  });

  ipcMain.handle('chat:submit', async (_event, rawInput) => handleUserUtterance(rawInput));

  return { handleUserUtterance, refreshModelMaxTokens };
};
