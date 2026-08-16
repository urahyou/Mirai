// 独立气泡窗口渲染器：收到主进程的渲染命令显示/隐藏气泡；可拖到屏幕任意位置并记住位置。
//
// 注意：这个 transparent 独立渲染进程在脚本执行时 document 可能尚未解析完，
// 实测直接 document.getElementById / querySelector 稳定可靠（而经由局部 $ 闭包
// 捕获的引用会拿到旧 document），因此这里一律直接使用 document 访问，并轮询
// 等待 #balloon 元素出现再初始化（参考 chatInputWindow 的 did-finish-load 模式）。
const BUBBLE_POSITION_STORAGE_KEY = 'mirai.balloon-position.v1';

let balloon = null;
let balloonText = null;
let balloonDragging = false;
let dragOffset = null;
let balloonPosition = null;
let lastClickTime = 0;
let lastClickPos = null;

function saveBalloonPosition() {
  if (!balloonPosition) return;
  window.localStorage.setItem(BUBBLE_POSITION_STORAGE_KEY, JSON.stringify(balloonPosition));
}

function render(message) {
  if (!message || typeof message !== 'object' || !balloon || !balloonText) return;
  switch (message.action) {
    case 'show': {
      balloonText.classList.toggle('typing', Boolean(message.typing));
      if (message.typing) {
        balloonText.textContent = '';
      } else {
        balloonText.textContent = String(message.text || '');
        balloonText.scrollTop = balloonText.scrollHeight;
      }
      balloon.classList.remove('hidden');
      balloon.classList.add('show');
      break;
    }
    case 'update': {
      balloonText.classList.remove('typing');
      balloonText.textContent = String(message.full || '');
      balloonText.scrollTop = balloonText.scrollHeight;
      balloon.classList.remove('hidden');
      balloon.classList.add('show');
      break;
    }
    case 'finish': {
      balloonText.classList.remove('typing');
      balloonText.textContent = String(message.text || '');
      balloonText.scrollTop = balloonText.scrollHeight;
      balloon.classList.remove('hidden');
      balloon.classList.add('show');
      break;
    }
    case 'hide': {
      balloon.classList.remove('show');
      setTimeout(() => { balloon.classList.add('hidden'); }, 300);
      break;
    }
  }
}

function init() {
  // 直接取真实 document 下的元素（绕过 $ 闭包可能捕获的旧 document）
  balloon = document.getElementById('balloon');
  balloonText = document.getElementById('balloon-text');
  if (!balloon || !balloonText) return; // 轮询 start() 会继续等到就绪再进这里

  window.desktopPet.balloonWindow.onRender(render);
  // onRender 监听已注册，通知主进程可以 flush 掉加载阶段积压的首条渲染消息；
  // 否则 did-finish-load 时轮询可能还没跑完、监听未挂上，首条 show 会丢失。
  window.desktopPet.balloonWindow.ready();

  // 拖拽气泡：用屏幕坐标把独立气泡窗口移动到屏幕任意位置（不再被宠物窗口框住）
  balloon.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('#balloon-text')) return;
    balloonDragging = true;
    dragOffset = { x: event.screenX - window.screenX, y: event.screenY - window.screenY };
    event.preventDefault();
    event.stopPropagation();
  });

  window.addEventListener('mousemove', (event) => {
    if (balloonDragging && dragOffset) {
      const targetX = event.screenX - dragOffset.x;
      const targetY = event.screenY - dragOffset.y;
      balloonPosition = { x: targetX, y: targetY };
      window.desktopPet.balloonWindow.dragMove(targetX, targetY);
    }
  });

  window.addEventListener('mouseup', (event) => {
    const now = Date.now();
    const moved = lastClickPos
      && (Math.abs(event.screenX - lastClickPos.x) > 4 || Math.abs(event.screenY - lastClickPos.y) > 4);
    if (balloonDragging) saveBalloonPosition();
    balloonDragging = false;
    dragOffset = null;
    window.desktopPet.balloonWindow.release();
    // 双击检测（不依赖原生 dblclick，避免被拖拽 preventDefault 吞掉）：
    // 两次点击间隔短、位移小、且点在空白（非文字）→ 重新跟随角色头顶
    if (lastClickTime && now - lastClickTime < 350 && !moved && !event.target.closest('#balloon-text')) {
      balloonPosition = null;
      try { window.localStorage.removeItem(BUBBLE_POSITION_STORAGE_KEY); } catch { /* ignore */ }
      window.desktopPet.balloonWindow.reanchor();
      lastClickTime = 0;
    } else {
      lastClickTime = now;
      lastClickPos = { x: event.screenX, y: event.screenY };
    }
  });
}

// 轮询等待 DOM 就绪：transparent 窗口脚本执行时 document 可能尚未就绪/元素尚未注入，
// 直接反复用 document.getElementById 探测（实测 try=2 即稳定就绪）。
let initTries = 0;
function start() {
  initTries += 1;
  balloon = document.getElementById('balloon');
  balloonText = document.getElementById('balloon-text');
  if (!balloon || !balloonText) {
    setTimeout(start, 60);
    return;
  }
  init();
}
start();
