const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractJsonCandidates,
  normalizeCandidate,
  postFilterCandidates,
  layerFor,
} = require('../src/services/memory-judge');

test('Given a fenced JSON body When extracting candidates Then only the inner candidates array is returned', () => {
  const text = '好的，我分析如下：\n```json\n{"candidates":[{"type":"preference","content":"喜欢喝茶","importance":0.9}]}\n```';
  const candidates = extractJsonCandidates(text);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].content, '喜欢喝茶');
});

test('Given an empty or malformed body When extracting candidates Then an empty array is returned', () => {
  assert.deepEqual(extractJsonCandidates(''), []);
  assert.deepEqual(extractJsonCandidates('nothing here'), []);
  assert.deepEqual(extractJsonCandidates('{"candidates": "not an array"}'), []);
  assert.deepEqual(extractJsonCandidates('not json at all {oops'), []);
});

test('Given raw candidates When normalizing Then invalid types/empty content are dropped and scores are clamped', () => {
  assert.equal(normalizeCandidate({ type: 'bogus', content: 'x', importance: 0.9 }), null);
  assert.equal(normalizeCandidate({ type: 'preference', content: '  ' }), null);
  assert.equal(normalizeCandidate(null), null);

  const ok = normalizeCandidate({ type: 'preference', content: '喜欢茶', importance: 5, confidence: -1, stability: 'weird', certainty: 'explicit' });
  assert.equal(ok.importance, 1);   // 越界夹到 0..1
  assert.equal(ok.confidence, 0);
  assert.equal(ok.stability, 'situational'); // 非法回落
});

test('Given candidates When post-filtering Then shouldWrite=false, unsupported absolutes, and bad types are removed', () => {
  const raw = [
    { type: 'preference', content: '喜欢奶茶', importance: 0.9, confidence: 0.9, shouldWrite: true },
    { type: 'preference', content: '以后都喝咖啡', importance: 0.9, confidence: 0.9, shouldWrite: true }, // 绝对化，无用户原话 → 挡
    { type: 'preference', content: '讨厌下雨', importance: 0.7, confidence: 0.9, shouldWrite: false }, // 明确拒绝写 → 挡
    { type: 'nope', content: '坏类型', importance: 0.9, shouldWrite: true }, // 非法类型 → 挡
  ];
  const kept = postFilterCandidates(raw);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content, '喜欢奶茶');
});

test('Given a quantifier-only 只 in source text When post-filtering with source Then the quantifier usage is exempted, not misread as absoluteness', () => {
  // 「是只橘猫」的量词「只」出现在用户原话里 → 应放行（正文测真实 Judge 误杀场景）
  const raw = [{ type: 'profile', content: '用户养了一只猫叫团子，是只橘猫', importance: 0.6, confidence: 0.95, shouldWrite: true }];
  const withSource = postFilterCandidates(raw, '我养了一只猫叫团子，是只橘猫');
  assert.equal(withSource.length, 1);
  // 但若用户原话没有该绝对词，则仍拦截
  const noSource = postFilterCandidates(raw, '');
  assert.equal(noSource.length, 0);
});

test('Given filtered candidates When layerFor Then explicit+stable+high fit the core, anything else stays archival', () => {
  const core = { certainty: 'explicit', stability: 'stable', importance: 0.9, confidence: 0.9 };
  const archivalByConfidence = { certainty: 'explicit', stability: 'stable', importance: 0.9, confidence: 0.5 };
  const archivalByInference = { certainty: 'inferred', stability: 'stable', importance: 0.9, confidence: 0.9 };
  const archivalByOneOff = { certainty: 'explicit', stability: 'one_off', importance: 0.9, confidence: 0.9 };

  assert.equal(layerFor(core), 'core');
  assert.equal(layerFor(archivalByConfidence), 'active');
  assert.equal(layerFor(archivalByInference), 'active');
  assert.equal(layerFor(archivalByOneOff), 'active');
});
