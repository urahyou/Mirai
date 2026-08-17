const menu = document.querySelector('#menu');

function addItem(label, action) {
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.type = 'button';
  item.textContent = label;
  item.addEventListener('click', () => {
    action();
    window.desktopPet.closeMenu();
  });
  menu.appendChild(item);
}

const title = document.createElement('div');
title.className = 'menu-title';
title.textContent = '小未来';
menu.appendChild(title);
addItem('开始聊天', () => window.desktopPet.openChatInput());

// 设置中心内容展开为一级菜单（与「开始聊天」同级），无需先进入设置中心首页。
const separator = document.createElement('div');
separator.className = 'menu-separator';
menu.appendChild(separator);
addItem('与小未来相处', () => window.desktopPet.openCompanionPanel());
addItem('外观', () => window.desktopPet.openAppearancePanel());
addItem('桌面行为', () => window.desktopPet.openBehaviorPanel());
addItem('聊天 · 上下文', () => window.desktopPet.openContextPanel());
addItem('记忆', () => window.desktopPet.memory.openPanel());
addItem('性格', () => window.desktopPet.openPersonalityPanel());
addItem('语音', () => window.desktopPet.openVoiceSettingsPanel());
addItem('模型', () => window.desktopPet.openProviderPanel());

const separator2 = document.createElement('div');
separator2.className = 'menu-separator';
menu.appendChild(separator2);
addItem('退出', () => window.desktopPet.quit());

let dragging = false;
let lastMouse = null;
title.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  lastMouse = { x: event.screenX, y: event.screenY };
  event.preventDefault();
});
window.addEventListener('mousemove', (event) => {
  if (!dragging || !lastMouse) return;
  const dx = event.screenX - lastMouse.x;
  const dy = event.screenY - lastMouse.y;
  if (dx || dy) window.desktopPet.moveBy(dx, dy);
  lastMouse = { x: event.screenX, y: event.screenY };
});
window.addEventListener('mouseup', () => { dragging = false; lastMouse = null; });
window.addEventListener('blur', () => window.desktopPet.closeMenu());
window.desktopPet.menuReady();
