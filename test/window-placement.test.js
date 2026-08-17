const assert = require('node:assert/strict');
const test = require('node:test');
const { clampRect, findAdjacentPanelPosition } = require('../src/services/window-placement');

const workArea = { x: 0, y: 0, width: 1440, height: 900 };

test('Given a panel near an edge When clamped Then it remains inside the usable display area', () => {
  assert.deepEqual(clampRect({ x: 1400, y: -12, width: 320, height: 200 }, workArea), {
    x: 1112, y: 8, width: 320, height: 200,
  });
});

test('Given a settings center and child panel When there is horizontal room Then they are placed side by side', () => {
  const wideWorkArea = { x: 0, y: 0, width: 1920, height: 900 };
  const result = findAdjacentPanelPosition({
    parent: { x: 440, y: 210, width: 560, height: 480 }, width: 460, height: 380, workArea: wideWorkArea,
  });
  assert.equal(result.adjacent, true);
  assert.equal(result.child.x, 1016);
  assert.equal(result.parent, null);
});

test('Given a narrow display When a child panel opens Then the parent is repositioned when a side-by-side pair fits', () => {
  const result = findAdjacentPanelPosition({
    parent: { x: 440, y: 210, width: 560, height: 480 }, width: 520, height: 560, workArea,
  });
  assert.equal(result.adjacent, true);
  assert.deepEqual(result.parent, { x: 172, y: 170, width: 560, height: 480 });
  assert.deepEqual(result.child, { x: 748, y: 170, width: 520, height: 560 });
});
