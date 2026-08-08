const fs = require('fs');
const path = require('path');

const VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStateStore(filePath, defaults) {
  let snapshot = null;

  function load() {
    if (snapshot) return clone(snapshot);

    try {
      snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      snapshot = clone(defaults);
      save();
    }

    if (!snapshot || snapshot.version !== VERSION || !snapshot.state) {
      snapshot = {
        ...clone(defaults),
        ...(snapshot || {}),
        version: VERSION,
        state: {
          ...clone(defaults).state,
          ...((snapshot && snapshot.state) || {}),
        },
      };
      save();
    }

    return clone(snapshot);
  }

  function save(nextSnapshot = snapshot) {
    snapshot = clone(nextSnapshot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  }

  function update(updater) {
    const current = load();
    const next = updater(clone(current)) || current;
    save(next);
    return clone(next);
  }

  return { load, save, update };
}

module.exports = { createStateStore, VERSION };
