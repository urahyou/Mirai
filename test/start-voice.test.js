const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('start:voice verifies the GPT-SoVITS NLTK tagger before launching Electron', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'start-voice.js'), 'utf8');
  assert.match(script, /function ensureNltkTagger/);
  assert.match(script, /averaged_perceptron_tagger_eng/);
  assert.match(script, /NLTK_ALLOW_PROXIED_URLOPEN/);
  assert.match(script, /if \(root && !ensureNltkTagger\(root\)\) process\.exit\(1\)/);
});
