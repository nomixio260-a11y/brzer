// 装甲戦闘 ── 面・貫徹・一撃の重み。
//
// 装甲目標との撃ち合いは「毎秒どれだけ削るか」では表せない。
// 当たるか外れるか、貫くか弾かれるか ── その一発で車輌が一両消える。
// だからここだけは、秒あたりの損耗ではなく、一発ずつ解決する。
//
// そして装甲には向きがある。正面は硬く、側面は薄く、背面はもっと薄い。
// 対戦車班をどこに置くかで結果が変わるのは、そのためである。

import { clamp, dist } from '../util.js';
import { POSTURES, applyDamage, applySuppression } from './units.js';
import { createSmoke } from './smoke.js';

/** 面の係数。正面を 1 として、側面・背面がどれだけ薄いか。 */
export const ASPECT = Object.freeze({
  front: 1.0,
  side: 0.48,
  rear: 0.3,
});

export const ASPECT_JA = Object.freeze({
  front: '正面',
  side: '側面',
  rear: '背面',
});

/** 一発を撃つまでの間隔（秒）。装填と照準にかかる時間。 */
const RELOAD = { tank: 8, at_team: 14, mech: 10, infantry: 16, recon: 18 };
/** 一発あたりに減る弾薬（0..100 の目盛りで） */
const SHOT_COST = { tank: 4, at_team: 8.4, mech: 5, infantry: 9, recon: 9 };

/**
 * 射手から見て、目標のどの面を撃っているか。
 * 目標の向きは「最後に向いた方向」── 交戦中の車輌は敵の方を向いているので、
 * 別方向から撃てば自然に側面・背面を取ることになる。
 */
export function aspectOf(shooter, target) {
  const toShooter = Math.atan2(shooter.y - target.y, shooter.x - target.x);
  let delta = toShooter - (target.heading ?? 0);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const a = Math.abs(delta);
  if (a < Math.PI / 3) return 'front';
  if (a > (Math.PI * 2) / 3) return 'rear';
  return 'side';
}

/** その面の装甲厚（0..1） */
export function armorValueAt(shooter, target) {
  const base = target.tpl.armor;
  if (!base) return 0;
  return base * ASPECT[aspectOf(shooter, target)];
}

/**
 * 距離による貫徹力の低下。
 * 成形炸薬（対戦車ミサイル・無反動砲）は距離で威力を落とさない。
 * 運動エネルギー弾は落とす ── だから戦車は近づきたがる。
 */
function apAtRange(shooter, d) {
  if (shooter.tpl.heat) return 1;
  const r = clamp(d / Math.max(1, shooter.tpl.range), 0, 1);
  return 1 - r * 0.32;
}

/** 貫徹比。1 を超えれば貫く。 */
export function penetrationRatio(shooter, target, d) {
  const ap = shooter.tpl.ap * apAtRange(shooter, d);
  const armor = armorValueAt(shooter, target);
  return ap / Math.max(0.05, armor);
}

/** その射手が、その目標を装甲戦闘として解決すべきか */
export function isArmorDuel(shooter, target) {
  return target.tpl.armor >= 0.3 && shooter.tpl.ap >= 0.45;
}

/** 装甲目標に対して、その射手に見込みがあるか（目標選定用） */
export function canDefeat(shooter, target, d) {
  if (!target.tpl.armor) return true;
  // 背面が取れる位置なら、歩兵でも戦車を止められる
  return penetrationRatio(shooter, target, d) > 0.75;
}

/** 次弾までの残り秒 */
export function reloadLeft(world, shooter) {
  const period = RELOAD[shooter.type] ?? 12;
  return Math.max(0, (shooter._nextShotAt ?? -Infinity) - world.now);
}

/**
 * 装甲目標への一発を解決する。
 * @returns {object|null} 射撃が起きたなら結果、装填中なら null
 */
export function resolveArmorShot(world, shooter, target, ctx) {
  const { now, rng } = world;
  const period = RELOAD[shooter.type] ?? 12;

  if (shooter._nextShotAt == null) {
    // 初弾は照準ぶんだけ待つ（いきなり撃ち始めない）
    shooter._nextShotAt = now + period * 0.5;
    return null;
  }
  if (now < shooter._nextShotAt) return null;
  shooter._nextShotAt = now + period * (0.85 + rng.next() * 0.4);

  const d = ctx.range;
  const posture = POSTURES[target.posture] ?? POSTURES.normal;

  // 命中公算。距離・射手の腕・射撃中の動揺・目標の大きさで決まる。
  const rangeTerm = 1 - Math.pow(clamp(d / Math.max(1, shooter.tpl.range), 0, 1), 1.6) * 0.72;
  const moving = shooter.path.length ? 0.35 : 1; // 行進間射撃は当たらない
  const targetMoving = target.path.length ? 0.82 : 1;
  const suppressed = 1 - clamp(shooter.suppression / 130, 0, 0.7);
  const p = clamp(
    0.62 * rangeTerm * moving * targetMoving * suppressed *
      ctx.visibility * (0.45 + shooter.skill * 0.75) * clamp(posture.exposure, 0.35, 1.5),
    0.02,
    0.95
  );

  shooter.ammo = Math.max(0, shooter.ammo - (SHOT_COST[shooter.type] ?? 6));
  shooter.lastFiredAt = now;
  // 撃てば位置が割れる。誘導しているあいだは、なおのこと動けない。
  if (shooter.tpl.heat) shooter._exposedUntil = now + 22;

  // 撃たれた側は、少なくとも「どちらから撃たれたか」は分かる
  target.lastHitAt = now;
  target._threatFrom = { x: shooter.x, y: shooter.y, at: now };

  if (!rng.chance(p)) {
    applySuppression(target, 18);
    return { result: 'miss', shooter, target, aspect: aspectOf(shooter, target) };
  }

  const aspect = aspectOf(shooter, target);
  const ratio = penetrationRatio(shooter, target, d);
  applySuppression(target, 42);

  // 貫けなければ弾かれる。乗員は無傷だが、撃たれたことは分かる。
  if (ratio < 1) {
    // 際どい当たりは、外板・照準器・履帯を壊す
    const graze = ratio > 0.72 && rng.chance(0.35);
    if (graze) {
      applyDamage(target, target.maxStrength * 0.12, now, { friendly: ctx.friendly });
      reactToHit(world, shooter, target);
      return { result: 'graze', shooter, target, aspect };
    }
    reactToHit(world, shooter, target);
    return { result: 'bounce', shooter, target, aspect };
  }

  // 貫いた。履帯・機関をやられるか、車輌そのものが失われるか。
  const catastrophic = ratio > 1.45 || rng.chance(clamp(ratio - 0.55, 0.15, 0.9));
  if (!catastrophic) {
    target._immobile = true;
    target.path = [];
    target.dest = null;
    applyDamage(target, target.maxStrength * 0.3, now, { friendly: ctx.friendly });
    applySuppression(target, 30);
    reactToHit(world, shooter, target);
    return { result: 'mobility', shooter, target, aspect };
  }

  const dealt = applyDamage(target, 1, now, { friendly: ctx.friendly });
  shooter.inflicted += dealt;
  reactToHit(world, shooter, target);
  return { result: 'kill', shooter, target, aspect, dealt };
}

/**
 * 撃たれた車輌の反射。
 *
 * 生き残った戦車がその場に留まることはない。発煙弾を放ち、
 * 遮蔽の裏へ退がる ── 教範どおりの動きであり、これがあるから
 * 対戦車陣地は「一撃で仕留められなければ二撃目が撃てない」。
 */
function reactToHit(world, shooter, target) {
  if (!target.alive) return;
  if (target.tpl.armor < 0.3) return;
  if (world.now - (target._poppedSmokeAt ?? -Infinity) < 100) return;
  target._poppedSmokeAt = world.now;
  target._backingOffAt = world.now;
  // 車載の発煙弾発射機。自分の周りに一瞬で幕を張る。
  world.smokes.push(createSmoke(target.x, target.y, world.now, 130, 95));
}

/** 撃たれた戦車が退がる先（射手の反対側） */
export function backOffPoint(target, from, meters = 260) {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: target.x + (dx / d) * meters, y: target.y + (dy / d) * meters };
}

/** 撃破・行動不能を日本語で（無線報告に使う） */
export function shotResultJa(res) {
  switch (res.result) {
    case 'kill': return '撃破';
    case 'mobility': return '行動不能';
    case 'graze': return '損傷';
    case 'bounce': return '効果なし';
    default: return '外れ';
  }
}

/** 目標がもう動けないか（履帯をやられた車輌は、その場の掩体になる） */
export function isImmobile(u) {
  return !!u._immobile;
}

/** 距離を測るだけの薄い包み（呼び出し側の読みやすさのため） */
export function rangeTo(a, b) {
  return dist(a.x, a.y, b.x, b.y);
}
