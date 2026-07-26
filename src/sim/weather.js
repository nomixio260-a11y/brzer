// 視程 ── 光と霧。
//
// 敵が夜明けに攻めてくるのは偶然ではない。谷が霧で埋まっている間は
// 前進が見えないからである。指揮官は「見えていない」ことを前提に考えねばならない。
//
// 長い戦闘では、これが一日を通して動く。薄明の攻撃、日中の膠着、
// そして日が傾いてからの再攻撃 ── 光の量そのものが戦機を作る。

import { clamp, parseClock } from '../util.js';
import { elevationAt } from './terrain.js';
import { flareLight } from './fires.js';

/** これだけの厚みの霧を貫くと視線が完全に切れる（メートル） */
const MIST_BLOCK_METERS = 900;

// 薄明の刻限。短期戦・長期戦のどちらでも同じ空の下で戦う。
const NIGHT_END = parseClock('0455'); // 薄明始
const SUNRISE = parseClock('0620'); // 日の出。ここまでが薄明。
const SUNSET = parseClock('1900');

/* ------------------------------------------------------------------ */
/* 光                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 明るさ 0..1。0 が闇夜、1 が白昼。
 * 薄明は45分かけて明ける ─ この間が攻者にとって最も都合がよい。
 */
export function lightLevel(world) {
  const t = world.now;
  if (t <= NIGHT_END) return 0.06;
  if (t >= SUNRISE && t < SUNSET) return 1;
  if (t < SUNRISE) return 0.06 + 0.94 * smooth((t - NIGHT_END) / (SUNRISE - NIGHT_END));
  return 0.06 + 0.94 * smooth(clamp((SUNSET + 2400 - t) / 2400, 0, 1));
}

function smooth(x) {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
}

/**
 * 索敵距離にかかる係数。
 * 闇夜では目視はほとんど利かない ─ 音と閃光で「そこにいる」ことしか分からない。
 */
export function lightSpotFactor(world) {
  return 0.22 + 0.78 * lightLevel(world);
}

/**
 * その一点がどれだけ「見える明るさ」にあるか。
 *
 * 空全体の明るさと、そこに掛かっている照明弾の明るい方を採る。
 * 夜の谷でも、照明が点いているあいだ、その下だけは昼になる ─
 * 撃つ前に見る、という手順が夜間に成立するのはそのためである。
 */
export function localSpotFactor(world, x, y) {
  const base = lightLevel(world);
  if (base >= 0.98 || !world.flares?.length) return 0.22 + 0.78 * base;
  return 0.22 + 0.78 * Math.max(base, flareLight(world, x, y));
}

/** 光の状態の言い分け（HUD と報告に使う） */
export function lightJa(world) {
  const l = lightLevel(world);
  if (l < 0.12) return '夜間';
  if (l < 0.55) return '薄明';
  if (l < 0.95) return '薄暮';
  return null;
}

/* ------------------------------------------------------------------ */
/* 霧                                                                  */
/* ------------------------------------------------------------------ */

/**
 * ある地点の霧の濃さ 0..1。
 * 低い所ほど濃く、日が高くなるにつれて薄れる。
 * 長い戦闘では、夕方にもう一度立つ。
 */
export function mistDensity(world, x, y) {
  const remaining = mistStrength(world);
  if (remaining <= 0.001) return 0;

  const elev = elevationAt(world.terrain, x, y);
  // 河谷の底（標高10m前後）が最も濃く、40m を超えるとほぼ晴れている
  const lowness = clamp((38 - elev) / 26, 0, 1);
  return remaining * (0.12 + 0.88 * lowness * lowness);
}

/** 時刻から決まる霧の総量 0..1 */
function mistStrength(world) {
  const { mistStart, mistClear, eveningMistFrom } = world.mission.weather ?? {};
  if (mistStart == null) return 0;

  if (world.now <= mistClear) {
    const t = clamp((world.now - mistStart) / (mistClear - mistStart), 0, 1);
    // 立ち上がりは緩く、日が高くなると一気に上がる
    return 1 - t * t;
  }
  // 夕霧。日が傾くとまた谷から立ちのぼる。
  if (eveningMistFrom != null && world.now >= eveningMistFrom) {
    return clamp((world.now - eveningMistFrom) / 3600, 0, 0.7);
  }
  return 0;
}

/**
 * 視線が霧を貫くときの減衰量 0..1。
 * 途中の濃さを拾いながら、距離に比例して効かせる。
 */
export function mistAttenuation(world, ax, ay, bx, by) {
  const d = Math.hypot(bx - ax, by - ay);
  if (d < 1) return 0;

  const steps = Math.min(8, Math.max(2, Math.ceil(d / 300)));
  let sum = 0;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    sum += mistDensity(world, ax + (bx - ax) * t, ay + (by - ay) * t);
  }
  const avg = sum / (steps + 1);
  return clamp((avg * d) / MIST_BLOCK_METERS, 0, 1);
}

/* ------------------------------------------------------------------ */
/* 言い回し                                                             */
/* ------------------------------------------------------------------ */

/** 指揮所から見た全般の視程（HUD と報告の言い回しに使う） */
export function visibilityJa(world) {
  const v = mistDensity(world, world.terrain.bridge.x, world.terrain.bridge.y);
  const dark = lightJa(world);

  if (dark === '夜間') {
    return { label: '夜間', note: v > 0.3 ? '闇と霧' : '月明かりのみ', level: 0 };
  }
  if (v > 0.6) return { label: '不良', note: '川霧が谷を埋めている', level: 0 };
  if (v > 0.3) return { label: 'やや不良', note: '霧が薄れつつある', level: 1 };
  if (dark) return { label: dark, note: '', level: 1 };
  if (v > 0.08) return { label: '良', note: '', level: 2 };
  return { label: '良好', note: '', level: 3 };
}

/** その部隊が今どれくらい見えているか（報告の枕に使う） */
export function localVisibilityJa(world, u) {
  if (lightLevel(world) < 0.12) return '暗くて何も見えない';
  const v = mistDensity(world, u.x, u.y);
  if (v > 0.55) return '視界が利かない';
  if (v > 0.28) return '視界不良';
  if (lightLevel(world) < 0.55) return '薄明かりのなか';
  return null;
}
