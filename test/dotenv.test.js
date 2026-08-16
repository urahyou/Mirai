const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dotenv = require('../src/services/dotenv');

function tmpFile(content = '') {
  const f = path.join(os.tmpdir(), `mirai-dotenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(f, content);
  return f;
}

test('Given a dotenv-style text When parsed Then it handles comments, export prefix, and quotes', () => {
  const values = dotenv.parse([
    '# 注释行',
    'SIMPLE=a',
    '',
    'QUOTED="hello world"',
    'SINGLE=\'it works\'',
    'export EXPORTED=zzz',
    'SPACES =   trim me   ',
    '   INDENTED=val',
  ].join('\n'));
  assert.deepEqual(values, {
    SIMPLE: 'a',
    QUOTED: 'hello world',
    SINGLE: 'it works',
    EXPORTED: 'zzz',
    SPACES: 'trim me',
    INDENTED: 'val',
  });
});

test('Given a malformed line When parsed Then it is skipped', () => {
  assert.deepEqual(dotenv.parse('KEY_WITHOUT_EQUAL\n=no_key\n# comment only\nKEY=ok\n'), { KEY: 'ok' });
});

test('Given no .env file When readAll runs Then it returns empty object', () => {
  const original = dotenv.getPath();
  try {
    dotenv.setPath(path.join(os.tmpdir(), `no-such-${Date.now()}.env`));
    assert.deepEqual(dotenv.readAll(), {});
  } finally {
    dotenv.setPath(original);
  }
});

test('Given read When a key is absent Then it returns the fallback', () => {
  dotenv.setPath(tmpFile('A=1\n'));
  try {
    assert.equal(dotenv.read('A'), '1');
    assert.equal(dotenv.read('MISSING'), '');
    assert.equal(dotenv.read('MISSING', 'fb'), 'fb');
  } finally {
    dotenv.setPath(null);
  }
});

test('Given write When updating an existing key Then it preserves comments and other lines and appends new keys', () => {
  const file = tmpFile('# top comment\nA=old\nB=keep\n');
  const original = dotenv.getPath();
  try {
    dotenv.setPath(file);
    const result = dotenv.write({ A: 'new', C: 'added' });
    assert.equal(fs.readFileSync(file, 'utf8'), '# top comment\nA=new\nB=keep\n\nC=added');
    assert.deepEqual(result, { A: 'new', B: 'keep', C: 'added' });
  } finally {
    dotenv.setPath(original);
  }
});

test('Given write When the value contains a newline or key is not uppercase Then it is ignored', () => {
  const file = tmpFile('A=1\n');
  dotenv.setPath(file);
  try {
    dotenv.write({ A: 'x\ny', 'lower_key': 'z', OK: '2' });
    assert.deepEqual(dotenv.readAll(), { A: '1', OK: '2' });
  } finally {
    dotenv.setPath(null);
  }
});

test('Given write When patch is not an object Then it throws', () => {
  dotenv.setPath(tmpFile());
  try {
    assert.throws(() => dotenv.write('nope'), /patch/);
    assert.throws(() => dotenv.write(['a']), /patch/);
  } finally {
    dotenv.setPath(null);
  }
});

test('Given SIDECAR settings written via the shared service Then a fresh parse round-trips the values', () => {
  const file = tmpFile('SIDECAR_TTS_ENGINE=edge\n');
  dotenv.setPath(file);
  try {
    dotenv.write({ SIDECAR_TTS_ENGINE: 'gpt-sovits', SIDECAR_TTS_SPEAK_LANG: 'ja' });
    const all = dotenv.readAll();
    assert.equal(all.SIDECAR_TTS_ENGINE, 'gpt-sovits');
    assert.equal(all.SIDECAR_TTS_SPEAK_LANG, 'ja');
  } finally {
    dotenv.setPath(null);
  }
});
