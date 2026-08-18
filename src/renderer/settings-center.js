// 设置中心首页：卡片导航到各子面板。
const $ = (id) => document.getElementById(id);

const routes = {
  cardCompanion: () => window.desktopPet.openCompanionPanel(),
  cardAppearance: () => window.desktopPet.openAppearancePanel(),
  cardBehavior: () => window.desktopPet.openBehaviorPanel(),
  cardChat: () => window.desktopPet.openContextPanel(),
  cardMemory: () => window.desktopPet.memory.openPanel(),
  cardDiary: () => window.desktopPet.diary.openPanel(),
  cardPersonality: () => window.desktopPet.openPersonalityPanel(),
  cardVoice: () => window.desktopPet.openVoiceSettingsPanel(),
  cardModel: () => window.desktopPet.openProviderPanel(),
  cardDebug: () => window.desktopPet.debug.openPanel(),
};

function init() {
  $('closeBtn').addEventListener('click', () => window.desktopPet.closeSettingsCenter());
  $('dragClose')?.addEventListener('click', () => window.desktopPet.closeSettingsCenter());
  for (const [id, fn] of Object.entries(routes)) {
    const el = $(id);
    if (el) el.addEventListener('click', fn);
  }
}

init();
