const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const runtimePath = path.join(root, 'assets', 'live2d', 'runtime', 'live2dcubismcore.min.js');
const modelPath = path.join(root, 'assets', 'live2d', 'models', 'hiyori_free_zh', 'runtime', 'hiyori_free_t08.model3.json');

test('bundled Live2D model has its Core runtime and referenced files', () => {
  assert.ok(fs.statSync(runtimePath).size > 0);

  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const base = path.dirname(modelPath);
  const refs = model.FileReferences;
  const files = [refs.Moc, refs.Physics, refs.DisplayInfo, ...refs.Textures];

  for (const motions of Object.values(refs.Motions)) {
    for (const motion of motions) files.push(motion.File);
  }

  for (const file of files) {
    assert.ok(fs.existsSync(path.join(base, file)), `missing Live2D asset: ${file}`);
  }
});
