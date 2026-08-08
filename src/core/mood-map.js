// 7 类情绪 → 表现映射。face 只允许已有立绘 idle/happy/sad；
// 无专属立绘的情绪用 accessible 的 class + 文字状态表达，不依赖动画。
// 所有文案坚持「不操控、不内疚、不嫉妒、不惩罚」，与 SPEC 2.4 / negative copy 约定一致。
const MOOD_MAP = Object.freeze({
  calm: {
    face: 'idle', name: '平静', tone: '平和',
    moodClass: 'mood-calm', animation: '',
    reason: '一直相安无事，状态平稳。',
  },
  happy: {
    face: 'happy', name: '开心', tone: '欢快',
    moodClass: 'mood-happy', animation: 'bounce',
    reason: '心情正不错。',
  },
  excited: {
    face: 'happy', name: '兴奋', tone: '雀跃',
    moodClass: 'mood-excited', animation: 'pop',
    reason: '有点兴奋。',
  },
  sad: {
    face: 'sad', name: '低落', tone: '低落',
    moodClass: 'mood-sad', animation: 'none',
    reason: '心情有些低落。',
  },
  bored: {
    face: 'idle', name: '无聊', tone: '慵懒',
    moodClass: 'mood-bored', animation: 'sway',
    reason: '有点无聊。',
  },
  tired: {
    face: 'idle', name: '累', tone: '疲惫',
    moodClass: 'mood-tired', animation: 'none',
    reason: '有点累。',
  },
  overwhelmed: {
    face: 'sad', name: '压力大', tone: '紧张',
    moodClass: 'mood-overwhelmed', animation: 'none',
    reason: '压力有点大。',
  },
});

const MOODS = Object.freeze(Object.keys(MOOD_MAP));

function resolveMapping(state) {
  const mood = state && MOOD_MAP[state.mood] ? state.mood : 'calm';
  return { mood, ...MOOD_MAP[mood] };
}

module.exports = { MOOD_MAP, MOODS, resolveMapping };