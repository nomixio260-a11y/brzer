// 地形の生成と地形問い合わせ（視線判定・遮蔽・機動性）
// DOM非依存。シードが同じなら必ず同じ地図になる。

import { WORLD, Rng, clamp, lerp } from '../util.js';

export const T = Object.freeze({
  FIELD: 0, // 開豁地
  FOREST: 1, // 森林
  TOWN: 2, // 市街地
  ROAD: 3, // 道路
  WATER: 4, // 河川
  BRIDGE: 5, // 橋
  FORD: 6, // 浅瀬
  MARSH: 7, // 湿地
});

export const TERRAIN_NAME_JA = Object.freeze({
  [T.FIELD]: '開豁地',
  [T.FOREST]: '森林',
  [T.TOWN]: '市街地',
  [T.ROAD]: '道路',
  [T.WATER]: '河川',
  [T.BRIDGE]: '橋梁',
  [T.FORD]: '浅瀬',
  [T.MARSH]: '湿地',
});

/** 遮蔽（射撃に対する防護）。0 = 遮蔽なし、1 = 完全遮蔽。 */
const COVER = {
  [T.FIELD]: 0.1,
  [T.FOREST]: 0.5,
  [T.TOWN]: 0.65,
  [T.ROAD]: 0.05,
  [T.WATER]: 0.0,
  [T.BRIDGE]: 0.05,
  [T.FORD]: 0.0,
  [T.MARSH]: 0.15,
};

/** 隠蔽（発見されにくさ）。視線が通っていても見つかりにくくなる。 */
const CONCEAL = {
  [T.FIELD]: 0.05,
  [T.FOREST]: 0.7,
  [T.TOWN]: 0.55,
  [T.ROAD]: 0.0,
  [T.WATER]: 0.0,
  [T.BRIDGE]: 0.0,
  [T.FORD]: 0.0,
  [T.MARSH]: 0.25,
};

/** 移動速度の倍率。0 は通行不能。 */
const MOBILITY = {
  [T.FIELD]: 1.0,
  [T.FOREST]: 0.55,
  [T.TOWN]: 0.7,
  [T.ROAD]: 1.45,
  [T.WATER]: 0.0,
  [T.BRIDGE]: 1.3,
  [T.FORD]: 0.35,
  [T.MARSH]: 0.4,
};

/** これだけの厚みの植生を貫くと視線が完全に切れる（メートル） */
const VEG_BLOCK_METERS = 230;

/* ------------------------------------------------------------------ */
/* ノイズ                                                              */
/* ------------------------------------------------------------------ */

function makeValueNoise(rng, size = 128) {
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  const at = (ix, iy) => g[(iy & (size - 1)) * size + (ix & (size - 1))];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    // smoothstep で補間して格子模様を消す
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = lerp(at(xi, yi), at(xi + 1, yi), u);
    const b = lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u);
    return lerp(a, b, v);
  };
}

function fbm(noise, x, y, octaves = 4) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* 地形生成                                                            */
/* ------------------------------------------------------------------ */

// ミッション「橋梁死守」の地理: 川が西→東に流れ、北岸が敵、南岸が味方。
const RIVER_BASE_Y = 1680;
const RIVER_HALF_WIDTH = 55;
const BRIDGE_X = 2200; // グリッド F
const FORD_X = 4180; // グリッド K（東の浅瀬）

/** x における河心の y 座標 */
export function riverCenterY(x) {
  return (
    RIVER_BASE_Y +
    260 * Math.sin((x / WORLD.width) * Math.PI * 1.7 - 0.6) +
    90 * Math.sin((x / WORLD.width) * Math.PI * 4.3 + 1.2)
  );
}

/**
 * 地形を生成する。
 * @param {number} seed
 * @returns {object} terrain
 */
export function generateTerrain(seed = 20260726) {
  const rng = new Rng(seed);
  const noise = makeValueNoise(rng);
  const detail = makeValueNoise(new Rng(seed ^ 0x5bf03635));

  const n = WORLD.cols * WORLD.rows;
  const type = new Uint8Array(n);
  const elev = new Float32Array(n);

  // --- 標高 ---------------------------------------------------------
  // 起伏はノイズ由来だが、戦術上意味のある高地は明示的に盛る。
  const HILLS = [
    { x: 1150, y: 2560, r: 780, h: 62, name: '西の高地' }, // 味方が取れる高地
    { x: 3980, y: 700, r: 900, h: 74, name: '北東の稜線' }, // 敵側の観測所
    { x: 2950, y: 2820, r: 620, h: 34, name: '南の丘' },
    { x: 620, y: 620, r: 700, h: 40, name: '北西の丘' },
  ];

  for (let r = 0; r < WORLD.rows; r++) {
    for (let c = 0; c < WORLD.cols; c++) {
      const i = r * WORLD.cols + c;
      const x = (c + 0.5) * WORLD.cell;
      const y = (r + 0.5) * WORLD.cell;

      let h = 18 + fbm(noise, x / 900, y / 900, 4) * 46;

      for (const hill of HILLS) {
        const d = Math.hypot(x - hill.x, y - hill.y);
        if (d < hill.r) {
          const t = 1 - d / hill.r;
          h += hill.h * t * t * (3 - 2 * t);
        }
      }

      // 川に近づくほど低くなる（河谷）
      const dRiver = Math.abs(y - riverCenterY(x));
      if (dRiver < 420) {
        const t = 1 - dRiver / 420;
        h = lerp(h, 8, t * t);
      }

      elev[i] = h;
    }
  }

  // --- 地形種別 ------------------------------------------------------
  const FORESTS = [
    { x: 780, y: 980, r: 560 },
    { x: 1700, y: 640, r: 520 },
    { x: 3350, y: 460, r: 640 },
    { x: 620, y: 2500, r: 520 },
    { x: 1560, y: 3120, r: 600 },
    { x: 3450, y: 2600, r: 700 },
    { x: 4400, y: 1180, r: 480 },
    { x: 2760, y: 900, r: 420 },
  ];
  const TOWNS = [
    { x: 2200, y: 2280, r: 400 }, // 橋の南、味方が拠る集落
    { x: 2380, y: 1180, r: 300 }, // 橋の北の小集落
  ];

  for (let r = 0; r < WORLD.rows; r++) {
    for (let c = 0; c < WORLD.cols; c++) {
      const i = r * WORLD.cols + c;
      const x = (c + 0.5) * WORLD.cell;
      const y = (r + 0.5) * WORLD.cell;
      let t = T.FIELD;

      // 森
      for (const f of FORESTS) {
        const d = Math.hypot(x - f.x, y - f.y);
        const wob = f.r * (0.72 + 0.42 * fbm(detail, x / 260, y / 260, 3));
        if (d < wob) {
          t = T.FOREST;
          break;
        }
      }

      // 市街
      for (const tw of TOWNS) {
        const d = Math.hypot(x - tw.x, y - tw.y);
        const wob = tw.r * (0.78 + 0.36 * fbm(detail, x / 200 + 40, y / 200, 3));
        if (d < wob) {
          t = T.TOWN;
          break;
        }
      }

      // 河川（湿地の縁を伴う）
      const dRiver = Math.abs(y - riverCenterY(x));
      const wobble = 14 * fbm(detail, x / 180, y / 180, 2);
      if (dRiver < RIVER_HALF_WIDTH + wobble) {
        t = T.WATER;
      } else if (dRiver < RIVER_HALF_WIDTH + 90 + wobble && t === T.FIELD) {
        t = T.MARSH;
      }

      type[i] = t;
    }
  }

  // --- 道路 ---------------------------------------------------------
  // 主要道: 北から橋を通って南へ抜ける
  const mainRoad = [
    { x: 2320, y: 0 },
    { x: 2260, y: 620 },
    { x: 2380, y: 1180 },
    { x: BRIDGE_X, y: riverCenterY(BRIDGE_X) },
    { x: 2200, y: 2280 },
    { x: 2120, y: 3000 },
    { x: 2180, y: WORLD.height },
  ];
  // 南岸の横断道: 集落から東の浅瀬方向へ
  const lateralRoad = [
    { x: 200, y: 2620 },
    { x: 1180, y: 2440 },
    { x: 2200, y: 2280 },
    { x: 3260, y: 2280 },
    { x: 4180, y: 2020 },
    { x: 4600, y: 1900 },
  ];
  // 北岸の道: 敵の進入路
  const northRoad = [
    { x: 4700, y: 520 },
    { x: 3800, y: 760 },
    { x: 2900, y: 900 },
    { x: 2380, y: 1180 },
  ];

  for (const path of [mainRoad, lateralRoad, northRoad]) {
    paintPolyline(type, elev, path, 34);
  }

  // --- 渡河点 -------------------------------------------------------
  paintDisc(type, BRIDGE_X, riverCenterY(BRIDGE_X), 105, T.BRIDGE, [T.WATER, T.MARSH, T.ROAD]);
  paintDisc(type, FORD_X, riverCenterY(FORD_X), 130, T.FORD, [T.WATER, T.MARSH]);

  const terrain = {
    seed,
    type,
    elev,
    bridge: { x: BRIDGE_X, y: riverCenterY(BRIDGE_X) },
    ford: { x: FORD_X, y: riverCenterY(FORD_X) },
    hills: HILLS,
    towns: TOWNS,
  };

  return terrain;
}

/** 折れ線に沿って道路を敷く（水上は橋にしない ― 橋は明示的に置く） */
function paintPolyline(type, elev, pts, halfWidth) {
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s];
    const b = pts[s + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(len / 12);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = lerp(a.x, b.x, t);
      const y = lerp(a.y, b.y, t);
      paintDisc(type, x, y, halfWidth, T.ROAD, [T.FIELD, T.FOREST, T.TOWN, T.MARSH]);
    }
  }
}

function paintDisc(type, cx, cy, radius, value, onlyOver) {
  const c0 = clamp(Math.floor((cx - radius) / WORLD.cell), 0, WORLD.cols - 1);
  const c1 = clamp(Math.ceil((cx + radius) / WORLD.cell), 0, WORLD.cols - 1);
  const r0 = clamp(Math.floor((cy - radius) / WORLD.cell), 0, WORLD.rows - 1);
  const r1 = clamp(Math.ceil((cy + radius) / WORLD.cell), 0, WORLD.rows - 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = (c + 0.5) * WORLD.cell;
      const y = (r + 0.5) * WORLD.cell;
      if (Math.hypot(x - cx, y - cy) > radius) continue;
      const i = r * WORLD.cols + c;
      if (onlyOver && !onlyOver.includes(type[i])) continue;
      type[i] = value;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 問い合わせ                                                           */
/* ------------------------------------------------------------------ */

export function cellIndex(x, y) {
  const c = clamp(Math.floor(x / WORLD.cell), 0, WORLD.cols - 1);
  const r = clamp(Math.floor(y / WORLD.cell), 0, WORLD.rows - 1);
  return r * WORLD.cols + c;
}

export function terrainAt(terrain, x, y) {
  return terrain.type[cellIndex(x, y)];
}

export function elevationAt(terrain, x, y) {
  // バイリニア補間（視線判定がガタつかないように）
  const fx = clamp(x / WORLD.cell - 0.5, 0, WORLD.cols - 1.001);
  const fy = clamp(y / WORLD.cell - 0.5, 0, WORLD.rows - 1.001);
  const c = Math.floor(fx);
  const r = Math.floor(fy);
  const tx = fx - c;
  const ty = fy - r;
  const e = terrain.elev;
  const i00 = r * WORLD.cols + c;
  const i10 = i00 + 1;
  const i01 = i00 + WORLD.cols;
  const i11 = i01 + 1;
  return lerp(lerp(e[i00], e[i10], tx), lerp(e[i01], e[i11], tx), ty);
}

export function coverAt(terrain, x, y) {
  return COVER[terrainAt(terrain, x, y)] ?? 0.1;
}

export function concealAt(terrain, x, y) {
  return CONCEAL[terrainAt(terrain, x, y)] ?? 0.05;
}

export function mobilityAt(terrain, x, y) {
  return MOBILITY[terrainAt(terrain, x, y)] ?? 1;
}

/** 地上部隊が進入できるか（車輌は浅瀬・湿地も苦手だが不可ではない） */
export function isPassable(terrain, x, y) {
  return mobilityAt(terrain, x, y) > 0;
}

/**
 * 視線判定。
 * 標高による遮蔽と、森林・市街による減衰の両方を見る。
 * @returns {{visible:boolean, quality:number}} quality は 0..1（1 = 完全に見通せる）
 */
export function lineOfSight(terrain, ax, ay, bx, by, eyeHeight = 2, targetHeight = 1.7, opts) {
  // 電波は木の葉では止まらない。無線の見通し判定は稜線だけを見る。
  const ignoreVegetation = opts?.ignoreVegetation ?? false;
  const d = Math.hypot(bx - ax, by - ay);
  if (d < 1) return { visible: true, quality: 1 };

  const steps = Math.max(2, Math.ceil(d / 40));
  const stepLen = d / steps;
  const za = elevationAt(terrain, ax, ay) + eyeHeight;
  const zb = elevationAt(terrain, bx, by) + targetHeight;

  // 遮蔽は「何メートル分の植生・建物を貫いたか」で数える。
  // サンプル1点ごとに固定量を足すと、解像度次第で森が絶対的な壁になってしまう。
  let vegMeters = 0;
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const x = lerp(ax, bx, t);
    const y = lerp(ay, by, t);
    const ground = elevationAt(terrain, x, y);
    const rayZ = lerp(za, zb, t);
    if (ground > rayZ + 0.5) {
      return { visible: false, quality: 0 }; // 稜線に切られた
    }
    if (ignoreVegetation) continue;

    const tt = terrainAt(terrain, x, y);
    if (tt === T.FOREST) vegMeters += stepLen;
    else if (tt === T.TOWN) vegMeters += stepLen * 1.3;
  }

  // 遮蔽物の「厚み」が視程を食う。目標自身の隠蔽は索敵側で別に効かせる
  // （ここで足すと二重計上になり、森にいるだけで不可視かつ無敵になる）。
  const quality = clamp(1 - vegMeters / VEG_BLOCK_METERS, 0, 1);
  return { visible: quality > 0.06, quality };
}

/** 標高の統計（描画の色域決定に使う） */
export function elevationRange(terrain) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < terrain.elev.length; i++) {
    const v = terrain.elev[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}
