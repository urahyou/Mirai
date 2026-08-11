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
addItem('显示设置', () => window.desktopPet.openDisplayPanel());
addItem('小未来的性格', () => window.desktopPet.openPersonalityPanel());
addItem('模型设置', () => window.desktopPet.openProviderPanel());

const separator = document.createElement('div');
separator.className = 'menu-separator';
menu.appendChild(separator);
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
