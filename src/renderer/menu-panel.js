const menu = document.querySelector('#menu');

const title = document.createElement('div');
title.className = 'menu-title';
title.textContent = '小未来';
menu.appendChild(title);

// 顶部实时状态行（C）：复用 petState.get() 展示心情与好感，让菜单有“活”感。
const status = document.createElement('div');
status.className = 'menu-status';
menu.appendChild(status);

function addItem(label, symbol, action) {
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.type = 'button';
  item.textContent = label;
  item.dataset.symbol = symbol;
  item.addEventListener('click', () => {
    action();
    window.desktopPet.closeMenu();
  });
  menu.appendChild(item);
}

function addGroupLabel(label) {
  const g = document.createElement('div');
  g.className = 'menu-group-label';
  g.textContent = label;
  menu.appendChild(g);
}

// 状态行数据（失败则隐藏该行，不阻塞菜单）
window.desktopPet.petState.get().then((s) => {
  const e = s && s.emotion;
  const a = s && s.affection;
  const mood = (e && e.mood) || '—';
  const score = Math.round((e && e.moodScore) || 0);
  const aff = Math.round((a && a.value) || 0);
  status.textContent = `💗 心情 ${mood}(${score}) · 好感 ${aff}`;
  window.desktopPet.menuReady(); // 状态行占据高度后再重定位
}).catch(() => { status.remove(); window.desktopPet.menuReady(); });

// —— 分组菜单（A）：按功能分类，视觉充实但不冗长 ——
addGroupLabel('互动');
addItem('开始聊天', '✉', () => window.desktopPet.openChatInput());
addItem('与小未来相处', '♥', () => window.desktopPet.openCompanionPanel());

addGroupLabel('外观与表现');
addItem('外观', '✦', () => window.desktopPet.openAppearancePanel());
addItem('桌面行为', '⌘', () => window.desktopPet.openBehaviorPanel());

addGroupLabel('系统');
addItem('设置中心', '⚙', () => window.desktopPet.openSettingsCenter());
addItem('退出', '×', () => window.desktopPet.quit());

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
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.desktopPet.closeMenu();
});
window.desktopPet.menuReady();
