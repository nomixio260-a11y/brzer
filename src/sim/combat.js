// 交戦解決（直射）と火力支援（曲射・発煙・照明）。

import { clamp, dist } from '../util.js';
import { lineOfSight, terrainAt, T } from './terrain.js';
import { applyDamage, applySuppression, effectiveCover, POSTURES } from './units.js';
import { visibleEnemies } from './perception.js';
import { smokeAttenuation, createSmoke } from './smoke.js';
import { mistAttenuation } from './weather.js';
import { fatigueFactor } from './logistics.js';
import { fireMode, createFlare, walkRounds } from './fires.js';
import { isArmorDuel, canDefeat, resolveArmorShot } from './armor.js';

const LETHALITY = 0.0012; // 1秒あたりの基礎損耗率
// 目安: 掩体の1個分隊を撃破するのに、戦車2両がかりで約5分。
// これより速いと、指揮官が報告を聞いて判断する時間そのものが無くなる。
const SUPPRESSION_RATE = 1.05;
// 携行弾薬は「約1時間の連続射撃」で尽きる勘定。実際の射撃は断続的なので、
// 一回の攻撃を凌ぐぶんはある ─ だが半日となれば、必ず二度は運ばねばならない。
const AMMO_DRAIN = 0.028;

/**
 * 全ユニットの直射戦闘を1ティック分解決する。
 * @returns {Array} 発生した射撃イベント（演出・報告用）
 */
export function stepDirectFire(world, dt) {
  const events = [];
  const { units, unitsById, terrain, now, rng, smokes } = world;

  for (const u of units) {
    if (!u.alive) continue;
    if (u.tpl.civilian) continue;
    if (u.tpl.range <= 0) continue; // 迫撃砲・ドローンは直射しない
    if (u.state === 'broken') continue; // 統制を失った部隊は撃たない
    if (u.ammo <= 0) continue;
    // 射撃統制中は、自分が撃たれるまで撃たない（撃てば位置が割れる）
    if (u.weaponsHold && now - u.lastHitAt > 20) continue;
    if (u.suppression > 88 && rng.chance(0.25)) continue; // 頭を上げられない

    const candidates = visibleEnemies(u, unitsById, now);
    const target = pickTarget(u, candidates, terrain, now, smokes);
    if (!target) continue;

    const d = dist(u.x, u.y, target.x, target.y);

    const los = lineOfSight(terrain, u.x, u.y, target.x, target.y);
    const smokeCut = smokeAttenuation(smokes, now, u.x, u.y, target.x, target.y);
    const mistCut = mistAttenuation(world, u.x, u.y, target.x, target.y);
    const obscured = 1 - (1 - smokeCut) * (1 - mistCut);
    // 見えてさえいれば撃てる。視程は命中率をいくらか鈍らせるだけで、
    // ここで植生をもう一度罰すると（遮蔽と二重計上になり）撃ち合いが永遠に終わらない。
    const visibility = (0.4 + 0.6 * los.quality) * (1 - obscured * 0.85);
    if (los.quality * (1 - obscured) < 0.08) continue;

    // 撃つ相手の方を向く。これが装甲の面を決める ──
    // 一方を相手にしている戦車は、もう一方に横腹を見せている。
    u.heading = Math.atan2(target.y - u.y, target.x - u.x);

    // --- 装甲目標 ─ 一発ずつ解決する --------------------------------
    if (isArmorDuel(u, target)) {
      const shot = resolveArmorShot(world, u, target, {
        range: d,
        visibility,
        friendly: u.side === target.side,
      });
      if (shot) {
        events.push({
          type: 'armor', from: u.id, to: target.id, at: now,
          x: target.x, y: target.y, result: shot.result, aspect: shot.aspect,
        });
        world.armorEvents.push({ ...shot, at: now, range: d });
        // 講評で「どの面から抜いたか」を突きつけるために数えておく。
        // 側面と背面の数が多いほど、部隊の置き方が上手かったということである。
        if (u.side === 'friend') {
          const t = world.stats.armor;
          if (shot.result === 'kill') t.kills[shot.aspect]++;
          else if (shot.result === 'mobility') t.mobility++;
          else if (shot.result === 'bounce') t.bounces++;
        }
      }
      continue;
    }

    const rangeFactor = clamp(1 - Math.pow(d / u.tpl.range, 2) * 0.65, 0.15, 1);

    // 兵力も士気も撃つ力を鈍らせるが、両方を素直に掛けると
    // 「一度削られた部隊は二度と撃ち返せない」という一方通行になる。
    // 半減した分隊でも小銃は鳴り続ける ─ 床を高くとる。
    const strengthFrac = 0.35 + 0.65 * (u.strength / u.maxStrength);
    const moraleFactor = clamp(u.morale / 80, 0.55, 1.1);
    // 制圧は反撃を鈍らせるが、完全には黙らせない。
    // 上限を強くしすぎると「先に撃った方が一方的に勝つ」不可逆な流れになる。
    // 死守を命じられた部隊は、頭を下げたままでも撃ち返し続ける ―
    // 退がれない部隊にできることは、それしかない。
    const resolve = u.roe === 'hold_fast' ? 0.36 : 0.55;
    const suppressionFactor = 1 - clamp(u.suppression / 160, 0, resolve);
    // 移動しながらの射撃は当たらない。これが防者の最大の利点になる。
    const movingPenalty = u.path.length ? 0.5 : 1;

    // 近接では掩体の値打ちが落ちる。
    //
    // 30mまで寄られた掩体は、もはや掩体ではなく、手榴弾を投げ込まれる穴である。
    // これを見ていなかったので、市街に籠る分隊は誰にも減らせなかった ―
    // どれだけ寄せても遮蔽0.92のままで、攻撃という機動が成立していなかった。
    // 寄るのは高くつく（その間ずっと撃たれる）が、寄りさえすれば効く。
    const closeIn = clamp(d / 160, 0.55, 1);
    const cover = effectiveCover(target, terrain) * closeIn;

    // 装甲は小火器を弾く。対装甲火力だけが通る。
    const armor = target.tpl.armor;
    const power = u.tpl.firepower * (1 - armor) + u.tpl.ap * armor;

    // 何時間も撃ち合っている部隊は、当たらなくなる。
    // 短い戦闘では出てこない差だが、半日守るならここが効いてくる。
    const effectiveness =
      rangeFactor * visibility * moraleFactor * suppressionFactor * movingPenalty *
      strengthFrac * fatigueFactor(u) * (0.55 + u.skill * 0.6);

    // 的の大きさ。掩体に伏せている部隊と、開豁地を駆けている部隊とでは
    // 同じ弾でも当たり方が違う。ここを見ていなかったので、
    // 陣地に籠る意味も、急速前進の代償も、数字の上に出ていなかった。
    const exposure = exposureOf(target, now);

    // 遮蔽は防者の全てである。掩体に入った分隊と、渡河点を駆けている分隊とで
    // 一発の重みが一桁変わる ─ その差があるから、寡兵でも渡らせずに済む。
    const loss =
      LETHALITY * power * effectiveness * (1 - cover * 0.80) * exposure * target.maxStrength * dt;
    if (loss > 0) {
      const dealt = applyDamage(target, loss, now, { friendly: u.side === target.side });
      u.inflicted += dealt;
    }

    // 制圧は遮蔽を貫通する（当たらなくても頭は下がる）
    applySuppression(target, SUPPRESSION_RATE * u.tpl.firepower * effectiveness * dt);
    target.lastHitAt = now;
    target._threatFrom = { x: u.x, y: u.y, at: now };

    u.ammo = Math.max(0, u.ammo - AMMO_DRAIN * u.tpl.ammoDrain * dt);
    u.lastFiredAt = now;

    events.push({ type: 'fire', from: u.id, to: target.id, at: now, x: target.x, y: target.y });
  }

  return events;
}

/**
 * 的の大きさ。
 * 対戦車ミサイルを誘導している班は、撃ったあとしばらく身を隠せない ―
 * 命中まで照準器から目を離せないからである。撃つことには代償がある。
 */
function exposureOf(u, now) {
  const base = (POSTURES[u.posture] ?? POSTURES.normal).exposure;
  const guiding = now - (u._exposedUntil ?? -Infinity) < 0 ? 1.5 : 1;
  return base * guiding;
}

/** 目標選定。脅威度と「そもそも撃破できるか」で選ぶ。 */
function pickTarget(u, candidates, terrain, now, smokes) {
  let best = null;
  let bestScore = -Infinity;

  for (const t of candidates) {
    if (t.tpl.civilian) continue; // 民間人は狙わない
    const d = dist(u.x, u.y, t.x, t.y);
    if (d > u.tpl.range) continue;

    // 空中目標を撃てるのは車載火器を持つ部隊だけ
    if (t.tpl.flying && u.type !== 'mech' && u.type !== 'tank') continue;

    // 正面から抜けない相手でも、横腹や背中を取れているなら撃つ意味がある
    if (!canDefeat(u, t, d)) continue;

    // 近い目標・脅威の大きい目標を優先
    const threat = t.tpl.firepower + t.tpl.ap * 0.5;
    const armorBonus = t.tpl.armor >= 0.3 && u.tpl.ap >= 0.45 ? 2.2 : 0;
    const power = u.tpl.firepower * (1 - t.tpl.armor) + u.tpl.ap * t.tpl.armor;
    const score = power * 2 + threat + armorBonus - (d / u.tpl.range) * 2.2;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 火力支援                                                             */
/* ------------------------------------------------------------------ */

let missionSeq = 1;

/**
 * 射撃任務を作る。
 * @param {string} kind 'he' | 'smoke' | 'illum'
 */
export function createFireMission(kind, x, y, now, opts = {}) {
  const mode = fireMode(opts.mode);
  const useMode = kind === 'he';
  const rounds = opts.rounds ?? (useMode ? mode.rounds : kind === 'smoke' ? 4 : 2);
  const delay =
    opts.delay ?? (kind === 'smoke' ? 55 : kind === 'illum' ? 40 : 75) * (useMode ? mode.delayMul : 1);

  return {
    id: `FM${missionSeq++}`,
    kind,
    mode: useMode ? mode.key : null,
    x,
    y,
    side: opts.side ?? 'friend',
    requestedBy: opts.requestedBy ?? null,
    requestedAt: now,
    // 初弾までの遅延（射撃指揮・諸元計算）
    firstImpactAt: now + delay,
    interval: opts.interval ?? (useMode ? mode.interval : kind === 'illum' ? 60 : 7),
    rounds,
    roundsLeft: rounds,
    radius: opts.radius ?? (kind === 'smoke' ? 200 : kind === 'illum' ? 60 : 130),
    // 概定射点なら諸元が出ているので散布界が締まる
    spread: (opts.spread ?? 1) * (useMode ? mode.spread : 1),
    registered: opts.registered ?? false,
    nextImpactAt: now + delay,
    done: false,
    casualtiesInflicted: 0,
    friendlyCasualties: 0,
    civilianCasualties: 0,
  };
}

/**
 * 進行中の射撃任務を処理する。着弾は敵味方を区別しない。
 * @returns {Array} 着弾イベント
 */
export function stepFireMissions(world, dt) {
  const events = [];
  const { now, rng, units } = world;

  for (const fm of world.fireMissions) {
    if (fm.done) continue;
    while (!fm.done && now >= fm.nextImpactAt) {
      // 弾着点のばらつき（照準の誤差）
      const sigma = fm.radius * 0.32 * (fm.spread ?? 1);
      const jx = fm.x + rng.gauss(0, sigma);
      const jy = fm.y + rng.gauss(0, sigma);

      if (fm.kind === 'smoke') {
        world.smokes.push(createSmoke(jx, jy, now, fm.radius, 260));
      } else if (fm.kind === 'illum') {
        world.flares.push(createFlare(jx, jy, now));
      } else {
        applyBlast(world, fm, jx, jy, units);
      }

      events.push({ type: 'impact', kind: fm.kind, x: jx, y: jy, at: now, missionId: fm.id });

      fm.roundsLeft--;
      fm.nextImpactAt += fm.interval;

      // 初弾を見た者がいれば、二の矢からは修正が入る
      if (fm.roundsLeft > 0 && !fm._walked) {
        const walk = walkRounds(world, fm);
        if (walk) fm._walkEvent = walk;
      }

      if (fm.roundsLeft <= 0) {
        fm.done = true;
        fm.completedAt = now;
      }
    }
  }

  world.fireMissions = world.fireMissions.filter((fm) => !fm.done || now - (fm.completedAt ?? now) < 120);
  return events;
}

/**
 * 進行中の射撃を打ち切る。撃っていない弾は戻る。
 * @returns {{cancelled:number, returned:object}}
 */
export function checkFire(world, side = 'friend') {
  let cancelled = 0;
  const returned = { he: 0, smoke: 0, illum: 0 };
  for (const fm of world.fireMissions) {
    if (fm.done || fm.side !== side) continue;
    returned[fm.kind] = (returned[fm.kind] ?? 0) + fm.roundsLeft;
    fm.roundsLeft = 0;
    fm.done = true;
    fm.cancelled = true;
    fm.completedAt = world.now;
    fm._reported = true;
    cancelled++;
  }
  return { cancelled, returned };
}

function applyBlast(world, fm, x, y, units) {
  const { now, terrain } = world;
  const R = fm.radius;
  const mode = fireMode(fm.mode);

  for (const t of units) {
    if (!t.alive) continue;
    if (t.tpl.flying) continue;
    const d = dist(x, y, t.x, t.y);
    if (d > R * 1.5) continue;

    const falloff = clamp(1 - d / (R * 1.5), 0, 1);
    const posture = POSTURES[t.posture] ?? POSTURES.normal;
    // 掩体に入っていれば砲撃はかなり凌げる ─ ただし曳火は頭の上で割れる。
    // 装甲は直射ほどには砲弾を防げない（上面・履帯・随伴歩兵がやられる）。
    const overhead = posture.coverBonus * 1.6 * (1 - mode.coverPierce);
    const protection = clamp(overhead + t.tpl.armor * 0.3 * mode.armorMul, 0, 0.8);

    // 地形も効く。市街の建物は破片を止め、森は逆に樹上で破裂させる。
    const tt = terrainAt(terrain, t.x, t.y);
    const terrainMul = tt === T.TOWN ? 0.62 : tt === T.FOREST ? 1.28 : 1;

    // 1発で部隊が消し飛ばないように。砲撃の主効果は撃破ではなく制圧。
    const loss = 0.09 * falloff * falloff * (1 - protection) * terrainMul * mode.lethality * t.maxStrength;

    const dealt = applyDamage(t, loss, now, { friendly: t.side === fm.side });
    applySuppression(t, 65 * falloff * mode.suppression);
    // 「砲撃を受けた」ことは直射で撃たれたのとは意味が違う。AIが散開の判断に使う。
    if (falloff > 0.25) t._shelledAt = now;
    t.lastHitAt = now;

    if (dealt > 0) {
      if (t.tpl.civilian) fm.civilianCasualties += dealt;
      else if (t.side === fm.side) fm.friendlyCasualties += dealt;
      else fm.casualtiesInflicted += dealt;
    }
  }
}
