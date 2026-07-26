// 共有ユーティリティ: シード付き乱数・幾何・グリッド座標・時刻整形
// このファイルはDOMに一切依存しない（node からも import 可能）。

/** マップの寸法定義。世界座標の単位はメートル。 */
export const WORLD = Object.freeze({
  width: 4800,
  height: 3600,
  cell: 50, // 地形サンプリング解像度
  cols: 96, // width / cell
  rows: 72, // height / cell
  gridSize: 400, // 無線で読み上げるグリッド1マスの辺長
  gridCols: 12, // A..L
  gridRows: 9, // 1..9
});

const GRID_LETTERS = 'ABCDEFGHIJKL';

/* ------------------------------------------------------------------ */
/* 乱数                                                                */
/* ------------------------------------------------------------------ */

/**
 * mulberry32 ベースのシード付き乱数。
 * 同じシードなら必ず同じ地形・同じ揺らぎになる（再現性のため）。
 */
export class Rng {
  constructor(seed = 1) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** [0,1) */
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [a,b) の実数 */
  range(a, b) {
    return a + this.next() * (b - a);
  }

  /** [a,b] の整数 */
  int(a, b) {
    return Math.floor(this.range(a, b + 1));
  }

  /** 確率 p で true */
  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** 標準正規分布（Box-Muller）。報告の位置誤差などに使う。 */
  gauss(mean = 0, sd = 1) {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 配列をその場でシャッフル */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/* ------------------------------------------------------------------ */
/* 幾何                                                                */
/* ------------------------------------------------------------------ */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

export function dist2(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** 世界座標を方位（北を0度とする時計回り）に変換 */
export function bearing(ax, ay, bx, by) {
  // 画面座標系なので y+ が南。北 = -y 方向。
  const deg = (Math.atan2(bx - ax, ay - by) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const COMPASS_JA = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

/** 方位角を日本語の8方位に */
export function compassJa(deg) {
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return COMPASS_JA[idx];
}

/* ------------------------------------------------------------------ */
/* グリッド座標                                                         */
/* ------------------------------------------------------------------ */

/** 世界座標 → "F5" 形式のグリッド名 */
export function toGrid(x, y) {
  const c = clamp(Math.floor(x / WORLD.gridSize), 0, WORLD.gridCols - 1);
  const r = clamp(Math.floor(y / WORLD.gridSize), 0, WORLD.gridRows - 1);
  return GRID_LETTERS[c] + (r + 1);
}

/** "F5" → そのマスの中心の世界座標。不正な文字列は null。 */
export function fromGrid(name) {
  if (typeof name !== 'string') return null;
  const m = /^([A-La-l])\s*(\d)$/.exec(name.trim());
  if (!m) return null;
  const c = GRID_LETTERS.indexOf(m[1].toUpperCase());
  const r = Number(m[2]) - 1;
  if (c < 0 || r < 0 || r >= WORLD.gridRows) return null;
  return {
    x: (c + 0.5) * WORLD.gridSize,
    y: (r + 0.5) * WORLD.gridSize,
  };
}

/** グリッドの列・行インデックス（0始まり）を返す */
export function gridIndex(x, y) {
  return {
    col: clamp(Math.floor(x / WORLD.gridSize), 0, WORLD.gridCols - 1),
    row: clamp(Math.floor(y / WORLD.gridSize), 0, WORLD.gridRows - 1),
  };
}

export function gridLetter(col) {
  return GRID_LETTERS[clamp(col, 0, WORLD.gridCols - 1)];
}

/* ------------------------------------------------------------------ */
/* 時刻                                                                */
/* ------------------------------------------------------------------ */

/** 0時からの秒数 → "0714" 形式 */
export function formatClock(secondsOfDay) {
  const s = Math.max(0, Math.floor(secondsOfDay));
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor(s / 60) % 60;
  return String(h).padStart(2, '0') + String(m).padStart(2, '0');
}

/** 0時からの秒数 → "07:14:32" */
export function formatClockFull(secondsOfDay) {
  const s = Math.max(0, Math.floor(secondsOfDay));
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor(s / 60) % 60;
  const sec = s % 60;
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(sec).padStart(2, '0')
  );
}

/** "0740" → 秒数 */
export function parseClock(hhmm) {
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(2, 4));
  return h * 3600 + m * 60;
}

/** 経過秒数を「3分前」のような相対表現に */
export function formatAgo(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.floor(m / 60)}時間${m % 60}分前`;
}
