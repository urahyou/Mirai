// 独立气泡窗口渲染器：收到主进程的渲染命令显示/隐藏气泡；可拖到屏幕任意位置并记住位置。
const $ = (id) => document.getElementById(id);

const balloon = $('#balloon');
const balloonText = $('#balloon-text');
const BUBBLE_POSITION_STORAGE_KEY = 'mirai.balloon-position.v1';

let balloonDragging = false;
let dragOffset = null;
let balloonPosition = loadBalloonPosition();

function loadBalloonPosition() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(BUBBLE_POSITION_STORAGE_KEY));
    const x = Number(saved?.x);
    const y = Number(saved?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

function saveBalloonPosition() {
  if (!balloonPosition) return;
  window.localStorage.setItem(BUBBLE_POSITION_STORAGE_KEY, JSON.stringify(balloonPosition));
}

function render(message) {
  if (!message || typeof message !== 'object') return;
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

window.desktopPet.balloonWindow.onRender(render);

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

window.addEventListener('mouseup', () => {
  if (balloonDragging) saveBalloonPosition();
  balloonDragging = false;
  dragOffset = null;
  window.desktopPet.balloonWindow.release();
});

// 双击气泡空白处（非文字）→ 重新跟随角色头顶
balloon.addEventListener('dblclick', (event) => {
  if (event.target.closest('#balloon-text')) return;
  balloonPosition = null;
  try { window.localStorage.removeItem(BUBBLE_POSITION_STORAGE_KEY); } catch { /* ignore */ }
  window.desktopPet.balloonWindow.reanchor();
});

// 启动时若上次拖离过，恢复那个屏幕位置
if (balloonPosition) {
  window.desktopPet.balloonWindow.restore(balloonPosition.x, balloonPosition.y);
}
