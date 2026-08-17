// Pure geometry helpers shared by panel windows. Keeping this independent from
// Electron makes multi-display placement deterministic and straightforward to test.
function clampRect(rect, workArea, margin = 8) {
  const maxX = Math.max(workArea.x + margin, workArea.x + workArea.width - rect.width - margin);
  const maxY = Math.max(workArea.y + margin, workArea.y + workArea.height - rect.height - margin);
  return {
    ...rect,
    x: Math.round(Math.max(workArea.x + margin, Math.min(rect.x, maxX))),
    y: Math.round(Math.max(workArea.y + margin, Math.min(rect.y, maxY))),
  };
}

function fits(rect, workArea, margin = 8) {
  return rect.x >= workArea.x + margin
    && rect.y >= workArea.y + margin
    && rect.x + rect.width <= workArea.x + workArea.width - margin
    && rect.y + rect.height <= workArea.y + workArea.height - margin;
}

function centerRect(workArea, width, height) {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

function findAdjacentPanelPosition({ parent, width, height, workArea, margin = 12, gap = 16 }) {
  const candidates = [
    { x: parent.x + parent.width + gap, y: parent.y, width, height },
    { x: parent.x - width - gap, y: parent.y, width, height },
    { x: parent.x, y: parent.y + parent.height + gap, width, height },
    { x: parent.x, y: parent.y - height - gap, width, height },
  ];
  const adjacent = candidates.find((candidate) => fits(candidate, workArea, margin));
  if (adjacent) return { child: adjacent, parent: null, adjacent: true };

  // A compact display can still fit both windows if the parent is moved aside.
  const totalWidth = parent.width + gap + width;
  if (totalWidth <= workArea.width - margin * 2) {
    const startX = Math.round(workArea.x + (workArea.width - totalWidth) / 2);
    const pairHeight = Math.max(parent.height, height);
    const startY = Math.round(workArea.y + (workArea.height - pairHeight) / 2);
    return {
      parent: { ...parent, x: startX, y: startY },
      child: { x: startX + parent.width + gap, y: startY, width, height },
      adjacent: true,
    };
  }

  return { child: clampRect(centerRect(workArea, width, height), workArea, margin), parent: null, adjacent: false };
}

module.exports = { clampRect, fits, centerRect, findAdjacentPanelPosition };
