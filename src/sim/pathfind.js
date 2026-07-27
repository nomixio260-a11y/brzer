// 粗いナビゲーショングリッド上での A*。
// 川があるので「橋か浅瀬を通らないと対岸に行けない」ことを経路探索で保証する。

import { WORLD, clamp } from '../util.js';
import { mobilityAt, terrainAt, obstacleAt, T } from './terrain.js';

const NAV_CELL = 100; // メートル
const NAV_COLS = Math.ceil(WORLD.width / NAV_CELL);
const NAV_ROWS = Math.ceil(WORLD.height / NAV_CELL);

/** ナビグリッドを構築して terrain にキャッシュする */
function navGrid(terrain, heavy = false) {
  const key = heavy ? '_navHeavy' : '_nav';
  if (terrain[key]) return terrain[key];

  const cost = new Float32Array(NAV_COLS * NAV_ROWS);
  for (let r = 0; r < NAV_ROWS; r++) {
    for (let c = 0; c < NAV_COLS; c++) {
      const x = (c + 0.5) * NAV_CELL;
      const y = (r + 0.5) * NAV_CELL;
      // ノード内を数点サンプルして最悪値寄りに評価する
      let worst = Infinity;
      let sum = 0;
      let count = 0;
      for (const [ox, oy] of [
        [0, 0],
        [-30, -30],
        [30, -30],
        [-30, 30],
        [30, 30],
      ]) {
        const m = mobilityAt(
          terrain, clamp(x + ox, 0, WORLD.width - 1), clamp(y + oy, 0, WORLD.height - 1), heavy
        );
        worst = Math.min(worst, m);
        sum += m;
        count++;
      }
      let avg = sum / count;
      // 障害。通れなくはないが、通りたい場所ではない ―
      // 迂回する余地があれば迂回する。隘路のように余地が無ければ、通る。
      // これが無いと、部隊は障害へ真っ直ぐ突っ込んでそこで止まり続けた。
      const obs = obstacleAt(terrain, x, y);
      if (obs) avg *= obs.kind === 'mines' ? 0.14 : 0.3;
      // 1点でも水域なら通れない扱い（川の細い部分をすり抜けさせない）
      cost[r * NAV_COLS + c] = worst <= 0 ? 0 : avg;
    }
  }

  terrain[key] = { cost, cols: NAV_COLS, rows: NAV_ROWS, cell: NAV_CELL };
  return terrain[key];
}

function navIndex(x, y) {
  const c = clamp(Math.floor(x / NAV_CELL), 0, NAV_COLS - 1);
  const r = clamp(Math.floor(y / NAV_CELL), 0, NAV_ROWS - 1);
  return r * NAV_COLS + c;
}

/** 通行不能な地点を指定された場合に、最も近い通行可能ノードへ寄せる */
function nearestPassable(nav, idx) {
  if (nav.cost[idx] > 0) return idx;
  const c0 = idx % NAV_COLS;
  const r0 = Math.floor(idx / NAV_COLS);
  for (let ring = 1; ring <= 12; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= NAV_ROWS || c >= NAV_COLS) continue;
        const i = r * NAV_COLS + c;
        if (nav.cost[i] > 0) return i;
      }
    }
  }
  return -1;
}

const NEIGHBORS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/**
 * A* 経路探索。
 * @returns {Array<{x:number,y:number}>} 経由点の配列（目的地を含む）。到達不能なら空配列。
 */
export function findPath(terrain, ax, ay, bx, by, heavy = false) {
  const nav = navGrid(terrain, heavy);
  const start = nearestPassable(nav, navIndex(ax, ay));
  const goal = nearestPassable(nav, navIndex(bx, by));
  if (start < 0 || goal < 0) return [];
  if (start === goal) return [{ x: bx, y: by }];

  const n = NAV_COLS * NAV_ROWS;
  const gScore = new Float32Array(n).fill(Infinity);
  const fScore = new Float32Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  const gc = goal % NAV_COLS;
  const gr = Math.floor(goal / NAV_COLS);
  const heuristic = (i) => {
    const c = i % NAV_COLS;
    const r = Math.floor(i / NAV_COLS);
    return Math.hypot(c - gc, r - gr);
  };

  gScore[start] = 0;
  fScore[start] = heuristic(start);

  // ノード数が 1700 程度なので単純な配列 open list で十分速い
  const open = [start];

  while (open.length) {
    let bestAt = 0;
    for (let k = 1; k < open.length; k++) {
      if (fScore[open[k]] < fScore[open[bestAt]]) bestAt = k;
    }
    const current = open.splice(bestAt, 1)[0];
    if (current === goal) break;
    closed[current] = 1;

    const cc = current % NAV_COLS;
    const cr = Math.floor(current / NAV_COLS);

    for (const [dc, dr, stepLen] of NEIGHBORS) {
      const c = cc + dc;
      const r = cr + dr;
      if (r < 0 || c < 0 || r >= NAV_ROWS || c >= NAV_COLS) continue;
      const ni = r * NAV_COLS + c;
      if (closed[ni]) continue;
      const mob = nav.cost[ni];
      if (mob <= 0) continue;
      // 斜め移動で角を抜けないようにする
      if (dc !== 0 && dr !== 0) {
        if (nav.cost[cr * NAV_COLS + c] <= 0 || nav.cost[r * NAV_COLS + cc] <= 0) continue;
      }
      const tentative = gScore[current] + stepLen / mob;
      if (tentative < gScore[ni]) {
        cameFrom[ni] = current;
        gScore[ni] = tentative;
        fScore[ni] = tentative + heuristic(ni);
        if (!open.includes(ni)) open.push(ni);
      }
    }
  }

  if (cameFrom[goal] < 0 && start !== goal) return [];

  // 復元
  const nodes = [];
  let cur = goal;
  let guard = 0;
  while (cur !== -1 && guard++ < 5000) {
    nodes.push(cur);
    if (cur === start) break;
    cur = cameFrom[cur];
  }
  nodes.reverse();

  // 先頭は「ノードの中心」ではなく部隊の実位置にする。
  // ここをノード中心にしていたせいで、実位置から第1経由点までの一脚だけが
  // 誰にも検査されず、川べりの角を横切って水に入り込むことがあった。
  const raw = [{ x: ax, y: ay }];
  for (const i of nodes) {
    raw.push({
      x: ((i % NAV_COLS) + 0.5) * NAV_CELL,
      y: (Math.floor(i / NAV_COLS) + 0.5) * NAV_CELL,
    });
  }
  // 終点をそのまま足すと、目的地が水上や岩稜のときにそこへ歩き込んでしまう。
  // 通れる場所であることを確かめてから足す ─
  // 「そこへ行け」と言われても、行けない所には行けない。
  if (mobilityAt(terrain, bx, by, heavy) > 0) {
    raw.push({ x: bx, y: by });
  } else if (raw.length <= 1) {
    return [];
  }

  return simplify(terrain, raw, heavy);
}

/** 直線で行ける区間はまとめて、経由点を減らす */
function simplify(terrain, pts, heavy = false) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let anchor = 0;
  for (let i = 2; i < pts.length; i++) {
    if (!walkable(terrain, pts[anchor], pts[i], heavy)) {
      out.push(pts[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(pts[pts.length - 1]);
  out.shift(); // 始点は現在地なので落とす
  return out;
}

function walkable(terrain, a, b, heavy = false) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.ceil(d / 40);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (mobilityAt(terrain, x, y, heavy) <= 0) return false;
  }
  return true;
}

/** 指定地点が渡河点かどうか（AI が渡河軸を選ぶのに使う） */
export function isCrossing(terrain, x, y) {
  const t = terrainAt(terrain, x, y);
  return t === T.BRIDGE || t === T.FORD;
}
