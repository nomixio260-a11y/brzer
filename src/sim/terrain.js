// 地形の生成と地形問い合わせ（視線判定・遮蔽・機動性）
// DOM非依存。シードが同じなら必ず同じ地図になる。

import { WORLD, Rng, clamp, lerp } from '../util.js';
import { getMap } from './maps.js';

export const T = Object.freeze({
  FIELD: 0, // 開豁地
  FOREST: 1, // 森林
  TOWN: 2, // 市街地
  ROAD: 3, // 道路
  WATER: 4, // 河川
  BRIDGE: 5, // 橋
  FORD: 6, // 浅瀬
  MARSH: 7, // 湿地
  ROCK: 8, // 急斜面・岩稜（車輌はもちろん、徒歩でも越えられない）
  RAIL: 9, // 鉄道。築堤が胸壁になる ─ 線路は歩兵にとって陣地である。
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
  [T.ROCK]: '急斜面',
  [T.RAIL]: '鉄道',
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
  [T.ROCK]: 0.55,
  // 築堤の陰。線路そのものは何も遮らないが、盛土の裏には身を隠せる。
  [T.RAIL]: 0.4,
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
  [T.ROCK]: 0.2,
  [T.RAIL]: 0.1,
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
  [T.ROCK]: 0.0,
  // 枕木と砕石。歩くぶんには構わないが、車輌には向かない。
  [T.RAIL]: 0.75,
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

/**
 * 前縁 ── 攻者と防者を分ける線。
 * 川であったり、峠の鞍部であったり、運河であったりする。
 * 「北岸／南岸」を判定したい側は、この一本だけを見ればよい。
 */
export function frontLineY(terrain, x) {
  return terrain.front(x);
}

/** 後方互換。ヴォルネ川の図幅を既定として扱う。 */
export function riverCenterY(x) {
  return getMap('volne_river').frontLine(x);
}

/**
 * 地形を生成する。
 * @param {number} seed
 * @param {string} mapId 図幅（maps.js）
 * @returns {object} terrain
 */
export function generateTerrain(seed, mapId = 'volne_river') {
  const map = getMap(mapId);
  const s = seed ?? map.seed;
  const rng = new Rng(s);
  const noise = makeValueNoise(rng);
  const detail = makeValueNoise(new Rng(s ^ 0x5bf03635));

  const n = WORLD.cols * WORLD.rows;
  const type = new Uint8Array(n);
  const elev = new Float32Array(n);

  const front = map.frontLine;
  const HILLS = map.hills;
  const FORESTS = map.forests;
  const TOWNS = map.towns;
  const water = map.water;

  // --- 標高 ---------------------------------------------------------
  // 起伏はノイズ由来だが、戦術上意味のある高地は明示的に盛る。
  for (let r = 0; r < WORLD.rows; r++) {
    for (let c = 0; c < WORLD.cols; c++) {
      const i = r * WORLD.cols + c;
      const x = (c + 0.5) * WORLD.cell;
      const y = (r + 0.5) * WORLD.cell;

      let h = 18 + fbm(noise, x / 900, y / 900, 4) * 46;

      for (const hill of HILLS) {
        // 半径を揺らす。真円のままだと等高線が同心円になり、
        // 地形図としてひと目で作り物に見える。
        const wobble = 0.78 + 0.44 * fbm(noise, (x + hill.x) / 520, (y - hill.y) / 520, 3);
        const rr = hill.r * wobble;
        const d = Math.hypot(x - hill.x, y - hill.y);
        if (d < rr) {
          const t = 1 - d / rr;
          h += hill.h * t * t * (3 - 2 * t);
        }
      }

      // 前縁に近づくほど低くなる（河谷・鞍部）
      const dFront = Math.abs(y - front(x));
      const valley = map.valleyWidth ?? 420;
      if (dFront < valley) {
        const t = 1 - dFront / valley;
        h = lerp(h, map.valleyFloor ?? 8, t * t);
      }

      elev[i] = h;
    }
  }

  // --- 地形種別 ------------------------------------------------------
  for (let r = 0; r < WORLD.rows; r++) {
    for (let c = 0; c < WORLD.cols; c++) {
      const i = r * WORLD.cols + c;
      const x = (c + 0.5) * WORLD.cell;
      const y = (r + 0.5) * WORLD.cell;
      let t = T.FIELD;

      for (const f of FORESTS) {
        const d = Math.hypot(x - f.x, y - f.y);
        const wob = f.r * (0.72 + 0.42 * fbm(detail, x / 260, y / 260, 3));
        if (d < wob) {
          t = T.FOREST;
          break;
        }
      }

      for (const tw of TOWNS) {
        const d = Math.hypot(x - tw.x, y - tw.y);
        const wob = tw.r * (0.78 + 0.36 * fbm(detail, x / 200 + 40, y / 200, 3));
        if (d < wob) {
          t = T.TOWN;
          break;
        }
      }

      // 水線のある図幅だけ、前縁に水を流す
      if (water) {
        const dFront = Math.abs(y - front(x));
        const wobble = 14 * fbm(detail, x / 180, y / 180, 2);
        if (dFront < water.halfWidth + wobble) {
          t = T.WATER;
        } else if (water.marshWidth > 0 && dFront < water.halfWidth + water.marshWidth + wobble && t === T.FIELD) {
          t = T.MARSH;
        }
      }

      // 急峻な岩稜。ここが通れないから「隘路」が隘路になる。
      if (map.rockAbove != null && elev[i] > map.rockAbove && t !== T.TOWN) {
        t = T.ROCK;
      }

      type[i] = t;
    }
  }

  // --- 道路 ---------------------------------------------------------
  // 図幅側は前縁の y を知らないので 'front' と書いておき、ここで解決する。
  const roads = map.roads.map((road) => ({
    cls: road.cls,
    points: road.points.map((p) => ({ x: p.x, y: p.y === 'front' ? front(p.x) : p.y })),
  }));
  for (const road of roads) paintPolyline(type, elev, road.points, 34);

  // --- 鉄道 ---------------------------------------------------------
  // 築堤は身を隠せる線であり、車輌にとっては越えにくい線でもある。
  // 市街の図幅では、これが一本あるだけで戦い方が変わる。
  const rails = (map.rails ?? []).map((rail) => ({
    label: rail.label ?? null,
    points: rail.points.map((p) => ({ x: p.x, y: p.y === 'front' ? front(p.x) : p.y })),
  }));
  // 築堤として効かせるのは開豁地の区間だけ。森や市街にはもともと遮蔽があり、
  // そこを線路で塗り替えると、かえって地色が抜けて地図が壊れる。
  for (const rail of rails) {
    // 方眼1つ分の帯。これより細いと、格子の目をすり抜けて盤に乗らない。
    paintPolylineAs(type, rail.points, 26, T.RAIL, [T.FIELD, T.MARSH]);
  }

  // --- 通過点 -------------------------------------------------------
  const crossings = map.crossings.map((cr) => ({
    ...cr,
    y: cr.y ?? front(cr.x),
  }));
  for (const cr of crossings) {
    const kind = CROSSING_TYPE[cr.kind] ?? T.ROAD;
    const over = cr.kind === 'bridge'
      ? [T.WATER, T.MARSH, T.ROAD]
      : cr.kind === 'ford'
        ? [T.WATER, T.MARSH]
        : [T.FIELD, T.FOREST, T.MARSH, T.TOWN, T.ROCK];
    paintDisc(type, cr.x, cr.y, cr.radius ?? 110, kind, over);
  }

  // 主・副の通過点。旧来の呼び名も残す（bridge / ford）。
  const primary = crossings[0];
  const secondary = crossings[1] ?? crossings[0];

  const terrain = {
    seed: s,
    mapId: map.id,
    mapName: map.name,
    mapNote: map.note,
    type,
    elev,
    front,
    hasWater: !!water,
    crossings,
    bridge: { x: primary.x, y: primary.y },
    ford: { x: secondary.x, y: secondary.y },
    hills: HILLS,
    towns: TOWNS,
    forests: FORESTS,
    // 障害。防者が敷いたもので、攻者はここで足を止める。
    obstacles: (map.obstacles ?? []).map((o) => ({
      ...o,
      y: o.y === 'front' ? front(o.x) + (o.dy ?? 0) : o.y,
    })),
    // 描画側がベクタとして道路と水線をなぞれるように残しておく。
    roads,
    rails,
    riverHalfWidth: water ? water.halfWidth : 0,
    waterName: water ? water.name : null,
  };

  return terrain;
}

/* ------------------------------------------------------------------ */
/* 地名                                                                */
/* ------------------------------------------------------------------ */

/**
 * その点を「地図に載っている名前」で言い直す。
 *
 * 前線の兵は方眼の数字だけで喋りはしない。「C4」ではなく
 * 「第一高地の北斜面、C4」と言う ─ 聞いた側が地図のどこを見ればよいか、
 * その一言で決まるからである。名前は図に刷ってあるものだけを使う。
 */
export function landmarkAt(terrain, x, y) {
  let best = null;
  const consider = (name, cx, cy, r, kind, bias) => {
    if (!name) return;
    const d = Math.hypot(x - cx, y - cy);
    if (d > r) return;
    const score = d / r - bias;
    if (!best || score < best.score) best = { name, cx, cy, r, kind, d, score };
  };

  for (const cr of terrain.crossings) {
    // 通過点は他の何より優先する。橋のたもとに居る部隊は、まず「橋」で言う ―
    // 指揮官が真っ先に見るのもそこだからである。
    consider(cr.label, cr.x, cr.y, (cr.radius ?? 110) * 2.6, 'crossing', 1.4);
  }
  for (const tw of terrain.towns) consider(tw.name, tw.x, tw.y, tw.r * 1.25, 'town', 0.3);
  for (const h of terrain.hills) consider(h.name, h.x, h.y, h.r * 0.95, 'hill', 0);
  for (const f of terrain.forests ?? []) consider(f.name, f.x, f.y, f.r, 'forest', 0.1);
  if (!best) return null;

  return { name: best.name, kind: best.kind, phrase: landmarkPhrase(best, x, y) };
}

const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

function dirOf(cx, cy, x, y) {
  const deg = (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
  return DIR8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function landmarkPhrase(l, x, y) {
  const dir = dirOf(l.cx, l.cy, x, y);
  switch (l.kind) {
    case 'crossing':
      if (Math.abs(y - l.cy) < 90) return `${l.name}の上`;
      return y < l.cy ? `${l.name}の北詰` : `${l.name}の南詰`;
    case 'town':
      return l.d < l.r * 0.42 ? `${l.name}の中` : `${l.name}の${dir}はずれ`;
    case 'hill':
      return l.d < l.r * 0.3 ? `${l.name}の頂` : `${l.name}の${dir}斜面`;
    case 'forest':
      return l.d < l.r * 0.5 ? `${l.name}の中` : `${l.name}の${dir}縁`;
    default:
      return l.name;
  }
}

/** 障害の中にいるか（地雷原・鉄条網） */
export function obstacleAt(terrain, x, y) {
  for (const o of terrain.obstacles ?? []) {
    if (Math.hypot(x - o.x, y - o.y) <= o.r) return o;
  }
  return null;
}

/** 通過点の種別 → 地形種別 */
const CROSSING_TYPE = {
  bridge: T.BRIDGE,
  ford: T.FORD,
  defile: T.ROAD,
  track: T.FIELD,
};

/** 折れ線に沿って道路を敷く（水上は橋にしない ― 橋は明示的に置く） */
function paintPolyline(type, elev, pts, halfWidth) {
  paintPolylineAs(type, pts, halfWidth, T.ROAD, [T.FIELD, T.FOREST, T.TOWN, T.MARSH]);
}

function paintPolylineAs(type, pts, halfWidth, value, over) {
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s];
    const b = pts[s + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(len / 12);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      paintDisc(type, lerp(a.x, b.x, t), lerp(a.y, b.y, t), halfWidth, value, over);
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
