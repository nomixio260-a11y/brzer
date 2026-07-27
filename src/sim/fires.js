// 曲射火力 ── 弾種・射撃要領・射程・射撃指揮。
//
// 砲は「撃て」と言えば落ちるものではない。射程の限りがあり、諸元があり、
// 陣地を変えれば出し直すまで黙る。そして、どう撃つか ── 着発か曳火か、
// 一気にか薄く長くか ── で、同じ弾数の持つ意味がまるで変わる。
// 指揮官が本当に選んでいるのは、そこである。

import { clamp, dist, toGrid } from '../util.js';
import { lineOfSight } from './terrain.js';

/**
 * 射撃要領。
 * 弾数が同じでも、撃ち方で効き方が変わる ─ そこが火力の運用である。
 */
export const FIRE_MODES = Object.freeze({
  impact: {
    key: 'impact',
    label: '着発',
    note: '標準の効力射。開豁地の敵・移動中の敵に効く。',
    rounds: 6, interval: 7,
    lethality: 1, suppression: 1,
    coverPierce: 0, armorMul: 1, spread: 1, delayMul: 1,
  },
  airburst: {
    key: 'airburst',
    label: '曳火',
    note: '空中で破裂させる。掩体・塹壕の敵に通る。装甲には効かない。諸元に手間がかかる。',
    rounds: 6, interval: 8,
    lethality: 0.95, suppression: 1.2,
    coverPierce: 0.72, armorMul: 0.4, spread: 1.1, delayMul: 1.3,
  },
  sustained: {
    key: 'sustained',
    label: '制圧',
    note: '薄く長く撃ち続ける。撃破は望めないが、その間ずっと敵は頭を上げられない。',
    rounds: 8, interval: 16,
    lethality: 0.35, suppression: 2.1,
    coverPierce: 0, armorMul: 1, spread: 1.2, delayMul: 1,
  },
  salvo: {
    key: 'salvo',
    label: '一斉射',
    note: '全弾を一度に落とす。奇襲の効果は最大。外せば全弾が無駄になる。',
    rounds: 8, interval: 2.2,
    lethality: 1.32, suppression: 1.3,
    coverPierce: 0.15, armorMul: 1, spread: 0.92, delayMul: 1.15,
  },
});

export const FIRE_MODE_ORDER = Object.freeze(['impact', 'airburst', 'sustained', 'salvo']);

export function fireMode(key) {
  return FIRE_MODES[key] ?? FIRE_MODES.impact;
}

/* ------------------------------------------------------------------ */
/* 砲の状態                                                            */
/* ------------------------------------------------------------------ */

// 最小射程。曲射砲は近すぎる目標には撃てない。
export const MIN_RANGE = 240;
// 陣地変換のあと、諸元を出し直して撃てるようになるまで。
export const LAY_TIME = 105;
// これより近くに味方がいれば危近弾。砲側は必ず言ってくる。
export const DANGER_CLOSE = 260;

/** その戦闘で曲射を担当している自軍部隊 */
export function supportGun(world) {
  return world.units.find((u) => u.alive && u.side === 'friend' && u.tpl.indirect) ?? null;
}

/** 陣地変換後、撃てるようになるまでの残り秒 */
export function layingLeft(world, gun) {
  if (!gun) return 0;
  if (gun.path.length) return LAY_TIME;
  const moved = gun._movingAt ?? -Infinity;
  return Math.max(0, LAY_TIME - (world.now - moved));
}

/**
 * その点を撃てるか。撃てないなら、砲側が無線で何と言うかまで返す。
 * 「撃てない」ことを指揮官が知る手段は、それしかない。
 */
export function fireCheck(world, x, y, opts = {}) {
  const gun = supportGun(world);
  if (!gun) {
    return { ok: false, text: '砲兵は沈黙している。要請に応じられる部隊がない。' };
  }
  if (gun.state === 'broken') {
    return { ok: false, gun, text: `こちら${gun.callsign}……砲側がもたない！今は撃てない！` };
  }
  const d = dist(gun.x, gun.y, x, y);
  if (d > gun.tpl.indirect) {
    return {
      ok: false,
      gun,
      text:
        `こちら${gun.callsign}、その目標は射程外だ。およそ${Math.round(d / 100) * 100}m。` +
        `陣地を前へ出さねば届かない。`,
    };
  }
  if (d < MIN_RANGE) {
    return { ok: false, gun, text: `こちら${gun.callsign}、近すぎる。最小射程の内側だ。` };
  }
  const laying = opts.ignoreLaying ? 0 : layingLeft(world, gun);
  if (laying > 0) {
    return {
      ok: false,
      gun,
      text: `こちら${gun.callsign}、陣地変換中。諸元が出るまであと約${Math.round(laying)}秒。`,
    };
  }
  return { ok: true, gun, range: d };
}

/**
 * 危近弾の判定。
 * 砲側は自軍の配置を知っている（射撃計画に載っている）ので、
 * 指揮官が知らない危険でも、砲側からは見える ── だから必ず言ってくる。
 */
export function dangerClose(world, x, y) {
  let nearest = null;
  for (const u of world.units) {
    if (!u.alive || u.side !== 'friend') continue;
    if (u.tpl.flying || u.tpl.indirect) continue;
    const d = dist(x, y, u.x, u.y);
    if (d > DANGER_CLOSE) continue;
    if (!nearest || d < nearest.d) nearest = { u, d };
  }
  return nearest;
}

/* ------------------------------------------------------------------ */
/* 照明弾                                                              */
/* ------------------------------------------------------------------ */

export function createFlare(x, y, now, opts = {}) {
  return {
    x, y,
    bornAt: now,
    radius: opts.radius ?? 820,
    duration: opts.duration ?? 200,
  };
}

/**
 * その地点がどれだけ照らされているか 0..1。
 * 照明は敵味方を区別しない ── 自分の部隊を照らせば、敵からも見える。
 */
export function flareLight(world, x, y) {
  const flares = world.flares;
  if (!flares || !flares.length) return 0;
  let best = 0;
  for (const f of flares) {
    const age = world.now - f.bornAt;
    if (age < 0 || age > f.duration) continue;
    const d = dist(x, y, f.x, f.y);
    if (d > f.radius) continue;
    // 吊光弾は落ちながら消えていく
    const fade = 1 - Math.max(0, (age - f.duration * 0.7) / (f.duration * 0.3));
    const near = 1 - (d / f.radius) * 0.5;
    const v = clamp(fade * near, 0, 1);
    if (v > best) best = v;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 観測による修正                                                       */
/* ------------------------------------------------------------------ */

/**
 * 弾着を見ている味方がいれば、二の矢からは弾が寄っていく。
 *
 * 寄せる先は「観測している者に見えている敵の位置」であって、真実ではない。
 * 見ている者の腕が悪ければ、ずれたまま寄る ─ 観測員を置く意味はそこにある。
 */
export function walkRounds(world, fm) {
  if (fm._walked || fm.kind !== 'he' || fm.side !== 'friend') return null;

  for (const o of world.units) {
    if (!o.alive || o.side !== 'friend' || !o.commsOk) continue;
    if (o.tpl.indirect) continue; // 砲側は自分の弾着を見ていない
    const dObs = dist(o.x, o.y, fm.x, fm.y);
    if (dObs > o.tpl.spot * (o.mods?.spot ?? 1) * 1.25) continue;
    if (!o.tpl.flying && !lineOfSight(world.terrain, o.x, o.y, fm.x, fm.y).visible) continue;

    // その観測者に見えている敵のうち、弾着圏の近くにいるもの
    let best = null;
    for (const c of o.contacts.values()) {
      if (world.now - c.lastSeenAt > 30) continue;
      const d = dist(c.x, c.y, fm.x, fm.y);
      if (d > fm.radius * 1.9) continue;
      if (!best || d < best.d) best = { c, d };
    }
    if (!best) continue;

    fm._walked = true;
    // 観測の質のぶんだけ、修正そのものにも誤差が乗る
    const err = (1 - (best.c.quality ?? 0.5)) * 70;
    const tx = best.c.x + world.rng.gauss(0, err);
    const ty = best.c.y + world.rng.gauss(0, err);
    fm.x += (tx - fm.x) * 0.6;
    fm.y += (ty - fm.y) * 0.6;
    fm.spread = (fm.spread ?? 1) * 0.6;
    fm.correctedBy = o.id;
    fm.correctedAt = world.now;
    return { observer: o, grid: toGrid(fm.x, fm.y) };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 毎ティック                                                          */
/* ------------------------------------------------------------------ */

/**
 * 照明弾の寿命と、砲の陣地変換を見る。
 * 砲が動いている間は撃てない ─ それを覚えておくのがここの仕事である。
 */
export function stepFires(world) {
  if (world.flares?.length) {
    world.flares = world.flares.filter((f) => world.now - f.bornAt <= f.duration);
  }
  for (const u of world.units) {
    if (!u.alive || !u.tpl.indirect) continue;
    if (u.path.length) u._movingAt = world.now;
  }
}
