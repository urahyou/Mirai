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
const { centerRect, findAdjacentPanelPosition } = require('../services/window-placement');

const MENU_WINDOW_SIZE = { width: 264, height: 360 };

let menuWindow = null;
let menuPendingPosition = null;
let menuInteractionActive = false;

module.exports = function createPanels({ getPetWindow, windowOptions, setInteractionWindowActive = () => {} }) {
  let settingsCenterWindow = null;

  function setMenuInteractionActive(active) {
    if (menuInteractionActive === active) return;
    menuInteractionActive = active;
    setInteractionWindowActive(active);
  }

  function panelWorkArea() {
    const pet = getPetWindow();
    const bounds = pet && !pet.isDestroyed() ? pet.getBounds() : null;
    const point = bounds
      ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      : screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(point).workArea;
  }

  // 把窗口定位到桌宠主窗口所在的显示器（多显示器下避免面板跑到主屏）。
  // 参考点取主窗口中心；主窗口不可用时退回光标所在屏幕。
  function positionOnMainDisplay(win, width, height) {
    if (!win || win.isDestroyed()) return;
    const workArea = panelWorkArea();
    const rect = centerRect(workArea, width, height);
    win.setPosition(rect.x, rect.y);
  }

  function positionSettingsChild(win, width, height) {
    const parent = settingsCenterWindow;
    if (!parent || parent.isDestroyed()) {
      positionOnMainDisplay(win, width, height);
      return;
    }
    const result = findAdjacentPanelPosition({ parent: parent.getBounds(), width, height, workArea: panelWorkArea() });
    if (result.parent) settingsCenterWindow.setBounds(result.parent);
    win.setPosition(result.child.x, result.child.y);
  }

  // 统一「面板」工厂：一个面板 = 一组窗口选项配置，open/close 配对，close 清空引用。
  // 原先 6 个面板是各自复制粘贴的 ~20 行样板，这里收敛为一份，改一处全生效。
  function makePanel(cfg) {
    let win = null;
    let interactionWindow = null;
    function releaseInteraction(target) {
      if (interactionWindow !== target) return;
      interactionWindow = null;
      setInteractionWindowActive(false);
    }
    function close() {
      const target = win;
      if (!target) return;
      win = null;
      releaseInteraction(target);
      if (!target.isDestroyed()) target.destroy();
    }
    function open() {
      close();
      const createdWin = new BrowserWindow({
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
      win = createdWin;
      interactionWindow = createdWin;
      setInteractionWindowActive(true);
      // 面板在用户当前操作期间高于桌宠，但不应像 screen-saver 一样长期压住其他应用。
      createdWin.setAlwaysOnTop(true, 'floating');
      if (cfg.settingsChild) positionSettingsChild(createdWin, cfg.width, cfg.height);
      else positionOnMainDisplay(createdWin, cfg.width, cfg.height);
      createdWin.loadFile(path.join(__dirname, '..', 'renderer', cfg.file));
      createdWin.once('ready-to-show', () => {
        if (!createdWin.isDestroyed()) {
          createdWin.show();
          createdWin.focus();
          createdWin.moveTop();
        }
      });
      createdWin.on('closed', () => {
        if (cfg.settingsCenter && settingsCenterWindow === createdWin) settingsCenterWindow = null;
        if (win === createdWin) win = null;
        releaseInteraction(createdWin);
      });
      if (cfg.settingsCenter) settingsCenterWindow = createdWin;
    }
    return { open, close, getWindow: () => win };
  }

  const personalityPanel = makePanel({ width: 520, height: 680, settingsChild: true, file: 'personality-panel.html' });
  const providerPanel = makePanel({ width: 760, height: 560, resizable: true, minWidth: 640, minHeight: 480, settingsChild: true, file: 'provider-panel.html' });
  const displayPanel = makePanel({ width: 460, height: 360, settingsChild: true, file: 'display-panel.html' });
  const voiceSettingsPanel = makePanel({ width: 480, height: 360, settingsChild: true, file: 'voice-settings.html' });
  const contextPanel = makePanel({ width: 460, height: 380, settingsChild: true, file: 'context-panel.html' });
  const memoryPanel = makePanel({ width: 520, height: 560, settingsChild: true, file: 'memory-panel.html' });

  // —— 设置中心体系（2026-08）：显示设置拆分为清晰子面板，由中心首页统一导航。
  // 无边框(frame:false) + 自定义拖动顶栏(.drag-bar)，替代系统标题栏，保证可移动。
  const settingsCenterPanel = makePanel({ width: 560, height: 480, frame: false, resizable: true, minWidth: 480, minHeight: 400, settingsCenter: true, file: 'settings-center.html' });
  const appearancePanel = makePanel({ width: 460, height: 380, frame: false, settingsChild: true, file: 'appearance-panel.html' });
  const behaviorPanel = makePanel({ width: 460, height: 500, frame: false, settingsChild: true, file: 'behavior-panel.html' });
  const companionPanel = makePanel({ width: 520, height: 560, frame: false, settingsChild: true, file: 'companion-panel.html' });

  // ---------- 右键菜单（行为比面板特殊：失焦关闭 + 按点击点定位） ----------
  function closeMenuWindow() {
      if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
      menuWindow = null;
      menuPendingPosition = null;
      setMenuInteractionActive(false);
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
    const createdMenu = new BrowserWindow({
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
    menuWindow = createdMenu;
    setMenuInteractionActive(true);
    createdMenu.setAlwaysOnTop(true, 'floating');
    createdMenu.on('blur', () => {
      if (menuWindow === createdMenu && !createdMenu.isDestroyed()) closeMenuWindow();
    });
    setMenuPosition(point);
    createdMenu.once('ready-to-show', () => {
      if (menuWindow === createdMenu && !createdMenu.isDestroyed()) {
        menuWindow.show();
        menuWindow.focus();
      }
    });
    createdMenu.loadFile(path.join(__dirname, '..', 'renderer', 'menu-panel.html'));
    createdMenu.on('closed', () => {
      if (menuWindow !== createdMenu) return;
      menuWindow = null;
      menuPendingPosition = null;
      setMenuInteractionActive(false);
    });
  }

  // 菜单渲染就绪后按待显示位置重新定位（页面尺寸可能已变化）
  // 菜单渲染/状态行填充就绪后，按内容自适应尺寸并重新定位（分组菜单项数多，超高需自适应）
  function repositionMenu() {
    if (!menuWindow || menuWindow.isDestroyed() || !menuPendingPosition) return false;
    menuWindow.webContents.executeJavaScript(
      `(() => { const m = document.getElementById('menu'); let h=0,w=0; for (const c of m.children){ h=Math.max(h,c.offsetTop+c.offsetHeight); w=Math.max(w,c.offsetLeft+c.offsetWidth);} return { h, w }; })()`
    ).then(({ h, w }) => {
      const winW = Math.max(MENU_WINDOW_SIZE.width, Math.min(w + 14, 340));
      const winH = Math.max(MENU_WINDOW_SIZE.height, Math.min(h + 8, 620));
      menuWindow.setBounds({ width: winW, height: winH });
      setMenuPosition(menuPendingPosition, winW, winH);
    }).catch(() => {
      setMenuPosition(menuPendingPosition);
    });
    return true;
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
