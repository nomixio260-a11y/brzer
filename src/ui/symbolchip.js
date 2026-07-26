// ツールバー用の小さな部隊記号。ボタンに文字ではなく記号そのものを載せる。

import { drawSymbol, drawObstacle, drawObjective } from './milsymbol.js';

const SIZE = 30;

export function symbolChip(spec) {
  const c = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = SIZE * dpr;
  c.height = SIZE * dpr;
  c.style.width = `${SIZE}px`;
  c.style.height = `${SIZE}px`;
  c.className = 'symchip';

  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = 8.5;

  if (spec.graphic === 'obstacle') {
    drawObstacle(ctx, cx, cy, r, spec.color, 1.6);
  } else if (spec.graphic === 'objective') {
    drawObjective(ctx, cx, cy, r * 0.9, spec.color, 1.5);
  } else if (spec.graphic === 'note') {
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [dy, w] of [[-4, 8], [0, 6], [4, 7]]) {
      ctx.moveTo(cx - 7, cy + dy);
      ctx.lineTo(cx - 7 + w, cy + dy);
    }
    ctx.stroke();
  } else {
    drawSymbol(ctx, {
      x: cx,
      y: cy,
      r,
      affiliation: spec.affiliation,
      icon: spec.icon,
      color: spec.color,
      lineWidth: 1.6,
    });
  }
  return c;
}
