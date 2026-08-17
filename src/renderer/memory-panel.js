const $ = (id) => document.getElementById(id);

async function refreshStatus() {
  const box = $('statusBox');
  try {
    const status = await window.desktopPet.memory.getStatus();
    box.className = `status ${status?.ok ? 'ok' : 'bad'}`;
    box.textContent = status?.ok ? '本地记忆库已就绪' : 'Python Core 尚未就绪，聊天将暂不读取长期记忆';
    $('statsLine').textContent = status?.ok
      ? `情景 ${status.episodes} · 事实 ${status.facts} · 关系 ${status.edges} · 事件 ${status.events} · 日记 ${status.dailyJournals}/${status.weeklyJournals}`
      : '等待本地后端启动…';
  } catch (error) {
    box.className = 'status bad';
    box.textContent = `无法读取本地记忆状态：${error.message || error}`;
  }
}

$('closeBtn').addEventListener('click', () => window.desktopPet.memory.closePanel());
refreshStatus();
