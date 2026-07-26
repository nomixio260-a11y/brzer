// 視程。払暁の川霧は、この戦闘の最初の1時間を支配する。
//
// 敵が夜明けに攻めてくるのは偶然ではない。谷が霧で埋まっている間は
// 前進が見えないからである。0830頃に霧が上がるまで、指揮官は
// 「見えていない」ことを前提に考えねばならない。

import { clamp, parseClock } from '../util.js';
import { elevationAt } from './terrain.js';

const MIST_START = parseClock('0700');
const MIST_CLEAR = parseClock('0835');

/** これだけの厚みの霧を貫くと視線が完全に切れる（メートル） */
const MIST_BLOCK_METERS = 900;

/**
 * ある地点の霧の濃さ 0..1。
 * 低い所ほど濃く、時間とともに薄れる。
 */
export function mistDensity(world, x, y) {
  const t = clamp((world.now - MIST_START) / (MIST_CLEAR - MIST_START), 0, 1);
  // 立ち上がりは緩く、日が高くなると一気に上がる
  const remaining = 1 - t * t;
  if (remaining <= 0.001) return 0;

  const elev = elevationAt(world.terrain, x, y);
  // 河谷の底（標高10m前後）が最も濃く、40m を超えるとほぼ晴れている
  const lowness = clamp((38 - elev) / 26, 0, 1);
  return remaining * (0.12 + 0.88 * lowness * lowness);
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

/** 指揮所から見た全般の視程（HUD と報告の言い回しに使う） */
export function visibilityJa(world) {
  const v = mistDensity(world, world.terrain.bridge.x, world.terrain.bridge.y);
  if (v > 0.6) return { label: '不良', note: '川霧が谷を埋めている', level: 0 };
  if (v > 0.3) return { label: 'やや不良', note: '霧が薄れつつある', level: 1 };
  if (v > 0.08) return { label: '良', note: '', level: 2 };
  return { label: '良好', note: '', level: 3 };
}

/** その部隊が今どれくらい見えているか（報告の枕に使う） */
export function localVisibilityJa(world, u) {
  const v = mistDensity(world, u.x, u.y);
  if (v > 0.55) return '視界が利かない';
  if (v > 0.28) return '視界不良';
  return null;
}
