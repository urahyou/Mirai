const personalityRuntime = require('../services/personality-runtime');

let config = null;

function loadConfig() {
  if (config) return config;
  config = personalityRuntime.getPersonality();
  return config;
}

// 人格被用户编辑后调用，使各引擎立即读到最新人格
function resetConfig() {
  config = null;
}

module.exports = { loadConfig, resetConfig };
