// 设置面板 / 菜单窗口模块。
//
// 所有「独立设置面板窗口」（人格 / Provider / 显示 / 语音设置 / 上下文 / 记忆）
// 以及右键菜单窗口的创建、定位、关闭都收在这里；主进程其它逻辑不再关心这些窗口细节。
//
// 通过依赖注入（createPanels({ getPetWindow, windowOptions })）获得所需能力：
//   - getPetWindow()：动态返回桌宠主窗口引用，用于「面板定位到主窗口所在显示器」
//   - windowOptions()：统一定制 BrowserWindow 的 webPreferences
// 以此让本模块不依赖主进程的全局状态，可独立维护/单测。
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const MENU_WINDOW_SIZE = { width: 200, height: 300 };

let menuWindow = null;
let menuPendingPosition = null;

module.exports = function createPanels({ getPetWindow, windowOptions }) {
  // 把窗口定位到桌宠主窗口所在的显示器（多显示器下避免面板跑到主屏）。
  // 参考点取主窗口中心；主窗口不可用时退回光标所在屏幕。
  function positionOnMainDisplay(win, width, height) {
    if (!win || win.isDestroyed()) return;
    const pet = getPetWindow();
    const mainBounds = pet && !pet.isDestroyed() ? pet.getBounds() : null;
    const ref = mainBounds || screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayNearestPoint({ x: ref.x, y: ref.y });
    const x = workArea.x + Math.round((workArea.width - width) / 2);
    const y = workArea.y + Math.round((workArea.height - height) / 2);
    win.setPosition(Math.max(workArea.x, x), Math.max(workArea.y, y));
  }

  // 统一「面板」工厂：一个面板 = 一组窗口选项配置，open/close 配对，close 清空引用。
  // 原先 6 个面板是各自复制粘贴的 ~20 行样板，这里收敛为一份，改一处全生效。
  function makePanel(cfg) {
    let win = null;
    function close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    }
    function open() {
      close();
      win = new BrowserWindow({
        width: cfg.width,
        height: cfg.height,
        resizable: Boolean(cfg.resizable),
        ...(cfg.minWidth ? { minWidth: cfg.minWidth } : {}),
        ...(cfg.minHeight ? { minHeight: cfg.minHeight } : {}),
        ...(cfg.frame !== undefined ? { frame: cfg.frame } : {}),
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: windowOptions(),
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      positionOnMainDisplay(win, cfg.width, cfg.height);
      win.loadFile(path.join(__dirname, '..', 'renderer', cfg.file));
      win.on('closed', () => { win = null; });
    }
    return { open, close };
  }

  const personalityPanel = makePanel({ width: 520, height: 680, file: 'personality-panel.html' });
  const providerPanel = makePanel({ width: 760, height: 560, resizable: true, minWidth: 640, minHeight: 480, file: 'provider-panel.html' });
  const displayPanel = makePanel({ width: 460, height: 360, file: 'display-panel.html' });
  const voiceSettingsPanel = makePanel({ width: 480, height: 360, file: 'voice-settings.html' });
  const contextPanel = makePanel({ width: 460, height: 380, file: 'context-panel.html' });
  const memoryPanel = makePanel({ width: 520, height: 560, file: 'memory-panel.html' });

  // —— 设置中心体系（2026-08）：显示设置拆分为清晰子面板，由中心首页统一导航。
  // 无边框(frame:false) + 自定义拖动顶栏(.drag-bar)，替代系统标题栏，保证可移动。
  const settingsCenterPanel = makePanel({ width: 560, height: 480, frame: false, resizable: true, minWidth: 480, minHeight: 400, file: 'settings-center.html' });
  const appearancePanel = makePanel({ width: 460, height: 380, frame: false, file: 'appearance-panel.html' });
  const behaviorPanel = makePanel({ width: 460, height: 360, frame: false, file: 'behavior-panel.html' });
  const companionPanel = makePanel({ width: 520, height: 560, frame: false, file: 'companion-panel.html' });

  // ---------- 右键菜单（行为比面板特殊：失焦关闭 + 按点击点定位） ----------
  function closeMenuWindow() {
    if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
    menuWindow = null;
    menuPendingPosition = null;
  }

  function setMenuPosition(point, width = MENU_WINDOW_SIZE.width, height = MENU_WINDOW_SIZE.height) {
    if (!menuWindow || menuWindow.isDestroyed() || !point) return false;
    const { workArea } = screen.getDisplayNearestPoint(point);
    const x = Math.max(workArea.x, Math.min(point.x, workArea.x + workArea.width - width - 8));
    const y = Math.max(workArea.y, Math.min(point.y, workArea.y + workArea.height - height - 8));
    menuWindow.setPosition(Math.round(x), Math.round(y));
    return true;
  }

  function openMenuWindow(point) {
    closeMenuWindow();
    menuPendingPosition = point;
    menuWindow = new BrowserWindow({
      width: MENU_WINDOW_SIZE.width,
      height: MENU_WINDOW_SIZE.height,
      transparent: true,
      frame: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      // 菜单需要通过失焦检测空白点击；不可聚焦窗口不会触发 blur。
      focusable: true,
      webPreferences: windowOptions(),
    });
    menuWindow.setAlwaysOnTop(true, 'screen-saver');
    menuWindow.on('blur', () => {
      if (menuWindow && !menuWindow.isDestroyed()) closeMenuWindow();
    });
    setMenuPosition(point);
    menuWindow.once('ready-to-show', () => {
      if (menuWindow && !menuWindow.isDestroyed()) {
        menuWindow.show();
        menuWindow.focus();
      }
    });
    menuWindow.loadFile(path.join(__dirname, '..', 'renderer', 'menu-panel.html'));
    menuWindow.on('closed', () => { menuWindow = null; });
  }

  // 菜单渲染就绪后按待显示位置重新定位（页面尺寸可能已变化）
  function repositionMenu() {
    if (!menuWindow || menuWindow.isDestroyed() || !menuPendingPosition) return false;
    const [width, height] = menuWindow.getContentSize();
    return setMenuPosition(menuPendingPosition, width, height);
  }

  return {
    openMenuWindow,
    closeMenuWindow,
    repositionMenu,
    openPersonalityPanel: personalityPanel.open,
    closePersonalityPanel: personalityPanel.close,
    openProviderPanel: providerPanel.open,
    closeProviderPanel: providerPanel.close,
    openDisplayPanel: displayPanel.open,
    closeDisplayPanel: displayPanel.close,
    openVoiceSettingsPanel: voiceSettingsPanel.open,
    closeVoiceSettingsPanel: voiceSettingsPanel.close,
    openContextPanel: contextPanel.open,
    closeContextPanel: contextPanel.close,
    openMemoryPanel: memoryPanel.open,
    closeMemoryPanel: memoryPanel.close,
    // —— 设置中心体系 ——
    openSettingsCenterPanel: settingsCenterPanel.open,
    closeSettingsCenterPanel: settingsCenterPanel.close,
    openAppearancePanel: appearancePanel.open,
    closeAppearancePanel: appearancePanel.close,
    openBehaviorPanel: behaviorPanel.open,
    closeBehaviorPanel: behaviorPanel.close,
    openCompanionPanel: companionPanel.open,
    closeCompanionPanel: companionPanel.close,
  };
};
