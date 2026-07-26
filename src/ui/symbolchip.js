// ツールバー用の小さな部隊記号。ボタンに文字ではなく記号そのものを載せる。

import { drawSymbol, drawObstacle, drawObjective } from './milsymbol.js';

const SIZE = 30;

/** ブリーフィングの編成表など、任意の記号を刷るための入口 */
export function symbolFor(opts, size = SIZE) {
  return symbolChip({ ...opts, _size: size });
}

export function symbolChip(spec) {
  const size = spec._size ?? SIZE;
  const c = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = size * dpr;
  c.height = size * dpr;
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  c.className = 'symchip';

  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.283;

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
      affiliation: spec.affiliation ?? 'friend',
      icon: spec.icon,
      echelon: spec.echelon ?? null,
      color: spec.color,
      lineWidth: size > 34 ? 1.9 : 1.6,
    });
  }
  return c;
}
