const fs = require('fs');
const path = require('path');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createJsonStorage(options) {
  const { filePath, schemaVersion, defaults, migrate } = options || {};
  if (!filePath || !Number.isInteger(schemaVersion) || schemaVersion < 1 || defaults === undefined) {
    throw new TypeError('filePath, positive integer schemaVersion, and defaults are required');
  }

  function documentFor(data) {
    return { schemaVersion, data: clone(data) };
  }

  function write(document) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(tempPath, JSON.stringify(document, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  }

  function quarantine() {
    const corruptPath = `${filePath}.corrupt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.renameSync(filePath, corruptPath);
    return corruptPath;
  }

  function load() {
    if (!fs.existsSync(filePath)) return clone(defaults);

    let document;
    try {
      document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      quarantine();
      const recovered = clone(defaults);
      write(documentFor(recovered));
      return recovered;
    }

    if (!document || !Number.isInteger(document.schemaVersion) || !Object.hasOwn(document, 'data')) {
      quarantine();
      const recovered = clone(defaults);
      write(documentFor(recovered));
      return recovered;
    }

    if (document.schemaVersion === schemaVersion) return clone(document.data);

    const migrated = typeof migrate === 'function'
      ? migrate({ schemaVersion: document.schemaVersion, data: clone(document.data) })
      : undefined;
    const recovered = migrated === undefined ? clone(defaults) : migrated;
    write(documentFor(recovered));
    return clone(recovered);
  }

  function save(data) {
    write(documentFor(data));
  }

  function erase() {
    const directory = path.dirname(filePath);
    const baseName = path.basename(filePath);
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory)) {
      if (entry === baseName || entry.startsWith(`${baseName}.corrupt-`) || entry.startsWith(`${baseName}.tmp-`)) {
        fs.rmSync(path.join(directory, entry), { force: true });
      }
    }
  }

  return Object.freeze({ load, save, erase });
}

module.exports = { createJsonStorage };
