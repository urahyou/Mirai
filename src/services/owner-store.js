const { createJsonStorage } = require('./json-storage');

const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
  name: '',       // 主人怎么称呼（空表示尚未认识这位主人）
  birthday: '',   // 自定义日期字符串，供提示语占位
  likes: [],      // 主人喜欢的事物
  note: '',       // 主人希望小未来记住的一句备注
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOwner(value) {
  const owner = value && typeof value === 'object' ? value : {};
  return {
    name: typeof owner.name === 'string' ? owner.name : DEFAULTS.name,
    birthday: typeof owner.birthday === 'string' ? owner.birthday : DEFAULTS.birthday,
    likes: Array.isArray(owner.likes) ? owner.likes.filter((x) => typeof x === 'string') : clone(DEFAULTS.likes),
    note: typeof owner.note === 'string' ? owner.note : DEFAULTS.note,
  };
}

function createOwnerStore({ filePath }) {
  const storage = createJsonStorage({
    filePath,
    schemaVersion: SCHEMA_VERSION,
    defaults: DEFAULTS,
    migrate: () => clone(DEFAULTS),
  });

  function get() {
    return normalizeOwner(storage.load());
  }

  function set(owner) {
    const next = normalizeOwner({ ...get(), ...(owner || {}) });
    storage.save(next);
    return next;
  }

  function eraseAll() {
    storage.erase();
  }

  return Object.freeze({ get, set, eraseAll });
}

module.exports = { createOwnerStore, DEFAULTS };