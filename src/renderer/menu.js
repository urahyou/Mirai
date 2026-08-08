const $ = (sel) => document.querySelector(sel);
const menuEl = $('#menu');

const PROVIDER_LABELS = {
  deepseek: 'DeepSeek / vLLM',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

// 记忆类型中文名（用于自动沉淀勾选提示）
const AUTO_MEMORY_LABEL = '自动沉淀记忆';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionClose() {
  window.desktopPet.closeMenu();
}

/** 分组子菜单：返回父项 + 内容容器，父项点击展开/收起（互斥） */
function makeGroup(label) {
  const parent = el('div', 'menu-item menu-sub-label', label);
  const wrap = el('div', 'menu-sub-wrap', '');
  parent.appendChild(wrap);
  menuEl.appendChild(parent);
  return { parent, wrap };
}

/** 分组内的普通动作项（点击执行并关闭菜单） */
function addGroupAction(wrap, label, fn) {
  const item = el('div', 'menu-item', label);
  item.addEventListener('click', () => { fn(); actionClose(); });
  wrap.appendChild(item);
  return item;
}

/** 分组内分隔线 */
function addGroupSeparator(wrap) {
  wrap.appendChild(el('div', 'menu-separator'));
}

/** 危险项：第一次点击进入「待确认」态，3000ms 内再点才真正执行 */
function addDanger(wrap, label, confirmLabel, fn) {
  const item = el('div', 'menu-item', label);
  let armed = false;
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      item.textContent = confirmLabel;
      setTimeout(() => { armed = false; item.textContent = label; }, 3000);
      return;
    }
    fn();
    actionClose();
  });
  wrap.appendChild(item);
  return item;
}

/** 勾选项（不关闭菜单）：读 settings.memoryAuto 显示勾选态，点击即切换 */
function addAutoMemoryToggle(wrap) {
  const on = async (item) => {
    const settings = await window.desktopPet.settings.get().catch(() => ({ memoryAuto: true }));
    const enabled = settings && settings.memoryAuto !== false;
    item.classList.toggle('checked', enabled);
    item.title = enabled ? '开：对话后自动提炼记忆（已开启）' : '关：不会自动提炼记忆（可手动说「记住…」）';
  };
  const item = el('div', 'menu-item', AUTO_MEMORY_LABEL);
  item.addEventListener('click', async (e) => {
    e.stopPropagation(); // 不触发菜单关闭
    const settings = await window.desktopPet.settings.get().catch(() => ({}));
    const next = { ...settings, memoryAuto: (settings && settings.memoryAuto) === false };
    await window.desktopPet.settings.set(next).catch(() => {});
    await on(item);
  });
  wrap.appendChild(item);
  on(item);
  return item;
}

function buildMenu() {
  return (async () => {
    const data = await window.desktopPet.getMenuData();
    menuEl.innerHTML = '';

    menuEl.appendChild(el('div', 'menu-title', '小未来'));

    // ---- 选择 Provider（顶层快捷子菜单，保留原有二级展开）----
    const provItem = el('div', 'menu-item menu-sub-label', '选择 Provider');
    const provSub = el('div', 'menu-sub-wrap', '');
    (data.providers || []).forEach((p) => {
      const label = PROVIDER_LABELS[p.name] || p.label;
      const item = el('div', 'menu-item' + (p.name === data.activeProvider ? ' checked' : ''), label);
      item.addEventListener('click', () => { window.desktopPet.setProvider(p.name); actionClose(); });
      provSub.appendChild(item);
    });
    provItem.appendChild(provSub);
    menuEl.appendChild(provItem);

    menuEl.appendChild(el('div', 'menu-separator'));

    // ---- 角色 ----
    const role = makeGroup('角色');
    addGroupAction(role.wrap, '查看状态', () => window.desktopPet.showState());
    addGroupAction(role.wrap, '小未来的性格', () => window.desktopPet.openPersonalityPanel());
    addGroupAction(role.wrap, '关于主人', () => window.desktopPet.openOwnerPanel());
    addGroupAction(role.wrap, '重置位置', () => window.desktopPet.resetPosition());
    addGroupAction(role.wrap, '隐藏角色', () => window.desktopPet.hide());

    // ---- 记忆 ----
    const mem = makeGroup('记忆');
    addGroupAction(mem.wrap, '记忆库', () => window.desktopPet.openMemoryPanel());
    const autoItem = addAutoMemoryToggle(mem.wrap);
    mem.autoItem = autoItem;
    addGroupSeparator(mem.wrap);
    addDanger(mem.wrap, '清空记忆', '再点一次确认清空', () => window.desktopPet.clearMemory());

    // ---- 能力 ----
    const cap = makeGroup('能力');
    addGroupAction(cap.wrap, '开始聊天', () => window.desktopPet.openChatInput());
    addGroupAction(cap.wrap, '日程提醒', () => window.desktopPet.openSchedulePanel());
    addGroupAction(cap.wrap, 'Provider 设置', () => window.desktopPet.showPanel());

    menuEl.appendChild(el('div', 'menu-separator'));

    // ---- 系统 ----
    const sys = makeGroup('系统');
    addGroupAction(sys.wrap, '偏好设置', () => window.desktopPet.openSettings());
    addDanger(sys.wrap, '退出', '再点一次确认退出', () => window.desktopPet.quit());

    // 子菜单展开互斥
    document.querySelectorAll('.menu-sub-label').forEach((parent) => {
      parent.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.menu-sub-wrap.show').forEach((s) => s !== parent.querySelector('.menu-sub-wrap') && s.classList.remove('show'));
        parent.querySelector('.menu-sub-wrap').classList.toggle('show');
      });
    });

    // 就绪后定位到鼠标处
    window.desktopPet.menuReady();
  })();
}

// ---------- 拖拽整个菜单窗口（全屏移动） ----------

let dragging = false;
let lastMouse = null;

menuEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 只有标题栏可拖拽；若点在可点击菜单项上则忽略
  if (e.target.closest('.menu-item')) return;
  dragging = true;
  lastMouse = { x: e.screenX, y: e.screenY };
  const title = menuEl.querySelector('.menu-title');
  if (title) title.classList.add('dragging');
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragging || !lastMouse) return;
  const dx = e.screenX - lastMouse.x;
  const dy = e.screenY - lastMouse.y;
  if (dx !== 0 || dy !== 0) {
    window.desktopPet.moveBy(dx, dy);
    lastMouse = { x: e.screenX, y: e.screenY };
  }
});

window.addEventListener('mouseup', () => {
  dragging = false;
  lastMouse = null;
  const title = menuEl.querySelector('.menu-title');
  if (title) title.classList.remove('dragging');
});

// 失去焦点时自动关闭
window.addEventListener('blur', () => {
  window.desktopPet.closeMenu();
});

buildMenu();
