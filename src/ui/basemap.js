// 地形ラスタの生成。ゲーム画面と講評画面で共有する。
// 標高で明暗をつけ、北西からの陰影を足して起伏を読ませる。

import { WORLD } from '../util.js';
import { T, elevationAt, elevationRange } from '../sim/terrain.js';

const TERRAIN_COLOR = {
  [T.FIELD]: [58, 66, 48],
  [T.FOREST]: [38, 56, 40],
  [T.TOWN]: [72, 66, 56],
  [T.ROAD]: [96, 89, 78],
  [T.WATER]: [30, 52, 72],
  [T.BRIDGE]: [116, 105, 88],
  [T.FORD]: [46, 76, 96],
  [T.MARSH]: [48, 58, 48],
};

const cache = new WeakMap();

// 地形データは50m刻みだが、そのまま拡大すると眠い絵になる。
// 4倍に細かくサンプリングして、地形の境界を立たせつつ陰影を滑らかにする。
const SS = 4;

/** 同じ地形なら作り直さない */
export function createMapViewBase(terrain) {
  const hit = cache.get(terrain);
  if (hit) return hit;

  const W = WORLD.cols * SS;
  const H = WORLD.rows * SS;
  const step = WORLD.cell / SS;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const { lo, hi } = elevationRange(terrain);
  const span = Math.max(1, hi - lo);

  const rgb = [0, 0, 0];

  for (let r = 0; r < H; r++) {
    const y = (r + 0.5) * step;
    for (let col = 0; col < W; col++) {
      const x = (col + 0.5) * step;
      // 地形の色は隣接セルと混ぜる。境界が階段状に出ると地図に見えなくなる。
      sampleColor(terrain, x, y, rgb);

      const elev = elevationAt(terrain, x, y);
      const h = (elev - lo) / span;
      const dzdx = elevationAt(terrain, x + WORLD.cell, y) - elevationAt(terrain, x - WORLD.cell, y);
      const dzdy = elevationAt(terrain, x, y + WORLD.cell) - elevationAt(terrain, x, y - WORLD.cell);
      const shade = 1 + (-dzdx - dzdy) * 0.014;

      const tone = (0.72 + h * 0.5) * Math.max(0.55, Math.min(1.45, shade));
      const o = (r * W + col) * 4;
      img.data[o] = Math.min(255, rgb[0] * tone);
      img.data[o + 1] = Math.min(255, rgb[1] * tone);
      img.data[o + 2] = Math.min(255, rgb[2] * tone);
      img.data[o + 3] = 255;
    }
  }

  g.putImageData(img, 0, 0);
  cache.set(terrain, c);
  return c;
}

/** 近傍4セルの色をバイリニアに混ぜる */
function sampleColor(terrain, x, y, out) {
  const fx = Math.min(Math.max(x / WORLD.cell - 0.5, 0), WORLD.cols - 1.001);
  const fy = Math.min(Math.max(y / WORLD.cell - 0.5, 0), WORLD.rows - 1.001);
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const tx = fx - c0;
  const ty = fy - r0;

  const i00 = r0 * WORLD.cols + c0;
  const a = TERRAIN_COLOR[terrain.type[i00]] ?? TERRAIN_COLOR[T.FIELD];
  const b = TERRAIN_COLOR[terrain.type[i00 + 1]] ?? TERRAIN_COLOR[T.FIELD];
  const cc = TERRAIN_COLOR[terrain.type[i00 + WORLD.cols]] ?? TERRAIN_COLOR[T.FIELD];
  const d = TERRAIN_COLOR[terrain.type[i00 + WORLD.cols + 1]] ?? TERRAIN_COLOR[T.FIELD];

  for (let k = 0; k < 3; k++) {
    const top = a[k] + (b[k] - a[k]) * tx;
    const bot = cc[k] + (d[k] - cc[k]) * tx;
    out[k] = top + (bot - top) * ty;
  }
}
