// 地図原図の生成。
//
// 目指しているのは「暗い画面に描いた図」ではなく、指揮所の卓に広げられた
// 1:50,000 の地形図そのものである。等高線、植生の記号、建物の輪郭、
// 朱の道路、青の水部 ― 紙の地図が持っているものを一通り持たせる。
// 指揮官が書き込む記号は、この上に重ねたアセテートに載る。

import { WORLD, Rng } from '../util.js';
import { T, elevationAt, elevationRange, riverCenterY } from '../sim/terrain.js';

/* 標高段彩。低地は淡い緑、高地に向かって黄土色へ抜ける。 */
const HYPSO = [
  { t: 0.0, c: [214, 224, 196] },
  { t: 0.28, c: [223, 228, 196] },
  { t: 0.5, c: [231, 224, 186] },
  { t: 0.72, c: [232, 213, 172] },
  { t: 1.0, c: [222, 196, 152] },
];

const COLOR = {
  water: [150, 194, 219],
  waterLine: 'rgba(58, 116, 152, 0.85)',
  forest: [172, 203, 160],
  town: [206, 197, 180],
  building: 'rgba(48, 44, 40, 0.82)',
  marsh: 'rgba(58, 116, 152, 0.7)',
  contour: 'rgba(150, 110, 68, 0.55)',
  contourIndex: 'rgba(132, 92, 52, 0.8)',
  contourLabel: 'rgba(120, 82, 44, 0.95)',
  tree: 'rgba(66, 106, 60, 0.65)',
};

const CONTOUR_INTERVAL = 10; // m
const CONTOUR_INDEX_EVERY = 5; // 50m ごとに主曲線

// 原図の解像度。1px ≒ 3.1m。等高線や建物が潰れない程度に大きく取る。
const SHEET_SCALE = 0.32; // px / m
const SHEET_W = Math.round(WORLD.width * SHEET_SCALE);
const SHEET_H = Math.round(WORLD.height * SHEET_SCALE);

const cache = new WeakMap();

/** 地図原図を1枚作る（同じ地形なら作り直さない） */
export function createMapViewBase(terrain) {
  const hit = cache.get(terrain);
  if (hit) return hit;

  const sheet = document.createElement('canvas');
  sheet.width = SHEET_W;
  sheet.height = SHEET_H;
  const g = sheet.getContext('2d');

  g.imageSmoothingEnabled = true;
  g.drawImage(paintGround(terrain), 0, 0, SHEET_W, SHEET_H);

  drawContours(g, terrain);
  drawVegetation(g, terrain);
  drawBuiltUp(g, terrain);
  drawMarsh(g, terrain);
  drawWaterEdge(g, terrain);
  drawPaperGrain(g, terrain.seed);

  cache.set(terrain, sheet);
  return sheet;
}

/* ------------------------------------------------------------------ */
/* 地色（段彩＋陰影）                                                    */
/* ------------------------------------------------------------------ */

function paintGround(terrain) {
  // 段彩と陰影は滑らかでよいので、粗いラスタを拡大して使う
  const W = WORLD.cols * 4;
  const H = WORLD.rows * 4;
  const step = WORLD.cell / 4;

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

      const elev = elevationAt(terrain, x, y);
      hypso((elev - lo) / span, rgb);

      // 植生・市街・水部は地色そのものを差し替える（記号は後から重ねる）
      blendCover(terrain, x, y, rgb);

      // 北西からの斜光。紙の地図でも起伏は影で読ませる。
      const dzdx = elevationAt(terrain, x + WORLD.cell, y) - elevationAt(terrain, x - WORLD.cell, y);
      const dzdy = elevationAt(terrain, x, y + WORLD.cell) - elevationAt(terrain, x, y - WORLD.cell);
      const shade = clamp01(1 + (-dzdx - dzdy) * 0.0075);

      const o = (r * W + col) * 4;
      img.data[o] = Math.min(255, rgb[0] * shade);
      img.data[o + 1] = Math.min(255, rgb[1] * shade);
      img.data[o + 2] = Math.min(255, rgb[2] * shade);
      img.data[o + 3] = 255;
    }
  }

  g.putImageData(img, 0, 0);
  return c;
}

function hypso(t, out) {
  const v = Math.min(1, Math.max(0, t));
  for (let i = 1; i < HYPSO.length; i++) {
    if (v <= HYPSO[i].t || i === HYPSO.length - 1) {
      const a = HYPSO[i - 1];
      const b = HYPSO[i];
      const k = (v - a.t) / Math.max(1e-6, b.t - a.t);
      for (let j = 0; j < 3; j++) out[j] = a.c[j] + (b.c[j] - a.c[j]) * Math.min(1, Math.max(0, k));
      return;
    }
  }
}

/** 被覆の色を、近傍4セルで混ぜながら被せる（境界が階段状に出ないように） */
function blendCover(terrain, x, y, rgb) {
  const fx = Math.min(Math.max(x / WORLD.cell - 0.5, 0), WORLD.cols - 1.001);
  const fy = Math.min(Math.max(y / WORLD.cell - 0.5, 0), WORLD.rows - 1.001);
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const tx = fx - c0;
  const ty = fy - r0;

  const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  const idx = [
    r0 * WORLD.cols + c0,
    r0 * WORLD.cols + c0 + 1,
    (r0 + 1) * WORLD.cols + c0,
    (r0 + 1) * WORLD.cols + c0 + 1,
  ];

  let wWater = 0;
  let wForest = 0;
  let wTown = 0;
  for (let i = 0; i < 4; i++) {
    const t = terrain.type[idx[i]];
    if (t === T.WATER || t === T.FORD) wWater += w[i];
    else if (t === T.FOREST) wForest += w[i];
    else if (t === T.TOWN) wTown += w[i];
  }

  mix(rgb, COLOR.forest, wForest);
  mix(rgb, COLOR.town, wTown);
  // 水際は「にじませない」。中間色で広がると川幅が実際の倍に見える。
  if (wWater > 0.45) mix(rgb, COLOR.water, 1);
  else if (wWater > 0) mix(rgb, COLOR.water, wWater * 0.5);
}

function mix(rgb, target, k) {
  if (k <= 0) return;
  const a = Math.min(1, k);
  for (let i = 0; i < 3; i++) rgb[i] += (target[i] - rgb[i]) * a;
}

const clamp01 = (v) => (v < 0.55 ? 0.55 : v > 1.4 ? 1.4 : v);

/* ------------------------------------------------------------------ */
/* 等高線（マーチングスクエア）                                          */
/* ------------------------------------------------------------------ */

function drawContours(g, terrain) {
  const { lo, hi } = elevationRange(terrain);
  const first = Math.ceil(lo / CONTOUR_INTERVAL) * CONTOUR_INTERVAL;

  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';

  let levelIndex = Math.round(first / CONTOUR_INTERVAL);
  for (let level = first; level < hi; level += CONTOUR_INTERVAL, levelIndex++) {
    const isIndex = levelIndex % CONTOUR_INDEX_EVERY === 0;
    const segments = marchingSquares(terrain, level);
    if (!segments.length) continue;

    g.strokeStyle = isIndex ? COLOR.contourIndex : COLOR.contour;
    g.lineWidth = isIndex ? 1.5 : 0.8;
    g.beginPath();
    for (const s of segments) {
      g.moveTo(s[0] * SHEET_SCALE, s[1] * SHEET_SCALE);
      g.lineTo(s[2] * SHEET_SCALE, s[3] * SHEET_SCALE);
    }
    g.stroke();

    if (isIndex) labelContour(g, segments, level);
  }
  g.restore();
}

/** 主曲線に標高を書き入れる（線に沿って傾ける） */
function labelContour(g, segments, level) {
  g.save();
  g.fillStyle = COLOR.contourLabel;
  g.font = '600 8px ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  const stride = Math.max(1, Math.floor(segments.length / 3));
  for (let i = Math.floor(stride / 2); i < segments.length; i += stride) {
    const s = segments[i];
    const x = ((s[0] + s[2]) / 2) * SHEET_SCALE;
    const y = ((s[1] + s[3]) / 2) * SHEET_SCALE;
    let a = Math.atan2(s[3] - s[1], s[2] - s[0]);
    if (a > Math.PI / 2) a -= Math.PI;
    if (a < -Math.PI / 2) a += Math.PI;

    g.save();
    g.translate(x, y);
    g.rotate(a);
    // 線を切って数字を置く（紙の地図と同じ作法）
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    g.fillRect(-9, -4.5, 18, 9);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = COLOR.contourLabel;
    g.fillText(String(Math.round(level)), 0, 0.5);
    g.restore();
  }
  g.restore();
}

/** 等高線の線分を求める。格子はセル中心。 */
function marchingSquares(terrain, level) {
  const out = [];
  const cols = WORLD.cols;
  const rows = WORLD.rows;
  const e = terrain.elev;
  const cell = WORLD.cell;

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i = r * cols + c;
      const v0 = e[i];              // 左上
      const v1 = e[i + 1];          // 右上
      const v2 = e[i + cols + 1];   // 右下
      const v3 = e[i + cols];       // 左下

      let code = 0;
      if (v0 > level) code |= 8;
      if (v1 > level) code |= 4;
      if (v2 > level) code |= 2;
      if (v3 > level) code |= 1;
      if (code === 0 || code === 15) continue;

      const x0 = (c + 0.5) * cell;
      const y0 = (r + 0.5) * cell;
      const x1 = x0 + cell;
      const y1 = y0 + cell;

      const top = () => [x0 + cell * frac(v0, v1, level), y0];
      const right = () => [x1, y0 + cell * frac(v1, v2, level)];
      const bottom = () => [x0 + cell * frac(v3, v2, level), y1];
      const left = () => [x0, y0 + cell * frac(v0, v3, level)];

      const push = (a, b) => out.push([a[0], a[1], b[0], b[1]]);

      switch (code) {
        case 1: case 14: push(left(), bottom()); break;
        case 2: case 13: push(bottom(), right()); break;
        case 3: case 12: push(left(), right()); break;
        case 4: case 11: push(top(), right()); break;
        case 5: push(left(), top()); push(bottom(), right()); break;
        case 6: case 9: push(top(), bottom()); break;
        case 7: case 8: push(left(), top()); break;
        case 10: push(left(), bottom()); push(top(), right()); break;
        default: break;
      }
    }
  }
  return out;
}

const frac = (a, b, level) => {
  const d = b - a;
  return Math.abs(d) < 1e-6 ? 0.5 : Math.min(1, Math.max(0, (level - a) / d));
};

/* ------------------------------------------------------------------ */
/* 植生・市街・湿地・水際                                                */
/* ------------------------------------------------------------------ */

function drawVegetation(g, terrain) {
  const rng = new Rng((terrain.seed ^ 0x7f4a) >>> 0);
  g.save();
  g.fillStyle = COLOR.tree;
  // 森は「面の色」だけでなく、樹木の記号を散らして表す
  for (let r = 0; r < WORLD.rows; r++) {
    for (let c = 0; c < WORLD.cols; c++) {
      if (terrain.type[r * WORLD.cols + c] !== T.FOREST) continue;
      // 1セルに1本程度。等間隔に見えないよう間引きと大小をつける。
      if (rng.next() > 0.62) continue;
      const x = (c + rng.next()) * WORLD.cell * SHEET_SCALE;
      const y = (r + rng.next()) * WORLD.cell * SHEET_SCALE;
      const rr = 0.9 + rng.next() * rng.next() * 2.2;
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

function drawBuiltUp(g, terrain) {
  const rng = new Rng((terrain.seed ^ 0x22b1) >>> 0);
  g.save();
  g.fillStyle = COLOR.building;
  for (let r = 0; r < WORLD.rows; r++) {
    for (let c = 0; c < WORLD.cols; c++) {
      if (terrain.type[r * WORLD.cols + c] !== T.TOWN) continue;
      // 1セル（50m四方）につき建物を2〜3棟。道路に沿うように少し向きを揃える。
      const n = 2 + (rng.next() < 0.4 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const x = (c + 0.15 + rng.next() * 0.7) * WORLD.cell * SHEET_SCALE;
        const y = (r + 0.15 + rng.next() * 0.7) * WORLD.cell * SHEET_SCALE;
        const w = 2.2 + rng.next() * 2.6;
        const h = 1.8 + rng.next() * 2.0;
        g.save();
        g.translate(x, y);
        g.rotate(rng.next() < 0.75 ? 0 : (rng.next() - 0.5) * 0.5);
        g.fillRect(-w / 2, -h / 2, w, h);
        g.restore();
      }
    }
  }
  g.restore();
}

function drawMarsh(g, terrain) {
  const rng = new Rng((terrain.seed ^ 0x9c31) >>> 0);
  g.save();
  g.strokeStyle = COLOR.marsh;
  g.lineWidth = 0.75;
  g.lineCap = 'butt';
  g.beginPath();
  for (let r = 0; r < WORLD.rows; r++) {
    for (let c = 0; c < WORLD.cols; c++) {
      if (terrain.type[r * WORLD.cols + c] !== T.MARSH) continue;
      // 湿地は短い横線の三段重ね。密に敷くと谷が記号で埋まるので間引く。
      if (rng.next() > 0.4) continue;
      const x = (c + 0.25 + rng.next() * 0.3) * WORLD.cell * SHEET_SCALE;
      const y = (r + 0.5) * WORLD.cell * SHEET_SCALE;
      for (const [dx, dy, len] of [[0, -1.7, 3.4], [1.1, 0, 2.4], [0.2, 1.7, 3.2]]) {
        g.moveTo(x + dx, y + dy);
        g.lineTo(x + dx + len, y + dy);
      }
    }
  }
  g.stroke();
  g.restore();
}

/**
 * 岸線。セルの辺をなぞると階段になるので、河心線から一定幅だけ
 * 離した2本の曲線として引く。
 */
function drawWaterEdge(g, terrain) {
  const half = terrain.riverHalfWidth ?? 55;
  g.save();
  g.strokeStyle = COLOR.waterLine;
  g.lineWidth = 1.1;
  g.lineJoin = 'round';
  for (const side of [-1, 1]) {
    g.beginPath();
    for (let x = 0; x <= WORLD.width; x += 25) {
      const y = riverCenterY(x) + side * half;
      const bx = x * SHEET_SCALE;
      const by = y * SHEET_SCALE;
      if (x === 0) g.moveTo(bx, by);
      else g.lineTo(bx, by);
    }
    g.stroke();
  }
  g.restore();
}

/* ------------------------------------------------------------------ */
/* 紙                                                                  */
/* ------------------------------------------------------------------ */

function drawPaperGrain(g, seed) {
  const rng = new Rng((seed ^ 0x51ed) >>> 0);
  const tile = document.createElement('canvas');
  tile.width = 96;
  tile.height = 96;
  const tg = tile.getContext('2d');
  const img = tg.createImageData(96, 96);
  for (let i = 0; i < 96 * 96; i++) {
    const v = 118 + rng.next() * 26;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  tg.putImageData(img, 0, 0);

  g.save();
  g.globalCompositeOperation = 'overlay';
  g.globalAlpha = 0.14;
  g.fillStyle = g.createPattern(tile, 'repeat');
  g.fillRect(0, 0, SHEET_W, SHEET_H);
  g.restore();

  // 折り目。紙は必ずどこかで折られている。
  g.save();
  g.globalAlpha = 0.055;
  for (const fx of [0.333, 0.666]) {
    const grad = g.createLinearGradient(SHEET_W * fx - 6, 0, SHEET_W * fx + 6, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, 'rgba(40,30,20,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(SHEET_W * fx - 6, 0, 12, SHEET_H);
  }
  const grad = g.createLinearGradient(0, SHEET_H * 0.5 - 6, 0, SHEET_H * 0.5 + 6);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.5, 'rgba(40,30,20,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, SHEET_H * 0.5 - 6, SHEET_W, 12);
  g.restore();
}
