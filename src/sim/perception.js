// 索敵・認識。誰が誰を「見えている」かを決める。
// ここで生まれた contact が、そのまま無線報告の素になる。

import { clamp, dist } from '../util.js';
import { lineOfSight, concealAt } from './terrain.js';
import { POSTURES } from './units.js';
import { smokeAttenuation } from './smoke.js';
import { mistAttenuation, localSpotFactor } from './weather.js';

/** 相手の兵種をどう見誤るか（近い見た目のものと取り違える） */
const CONFUSION = {
  infantry: ['infantry', 'recon', 'at_team'],
  recon: ['recon', 'infantry'],
  at_team: ['at_team', 'infantry'],
  mech: ['mech', 'tank'],
  tank: ['tank', 'mech'],
  mortar: ['mortar', 'infantry'],
  convoy: ['convoy', 'mech'],
  drone: ['drone'],
};

/**
 * 1ユニット分の索敵処理。
 * @param {object} u 観測側
 * @param {Array} others 全ユニット
 */
export function stepPerception(u, others, terrain, now, dt, rng, smokes, world) {
  if (!u.alive) return;

  const posture = POSTURES[u.posture] ?? POSTURES.normal;
  // 撃たずに見ることに徹している部隊は、遠くまでよく見える
  const watching = u.weaponsHold ? 1.15 : 1;
  // 何時間も起きている部隊は、見落とす
  const alert = 1 - clamp(u.fatigue / 700, 0, 0.3);
  const baseSpot =
    u.tpl.spot * posture.spot * watching * alert *
    (1 - clamp(u.suppression / 200, 0, 0.5));

  for (const t of others) {
    if (t === u || !t.alive) continue;
    if (t.side === u.side) continue;
    // 闇夜では目が利かない。上空の機体だけが熱で見る。
    // 照明弾が掛かっていれば、その下だけは見える ─ 明るさは目標側で決まる。
    const lit = world ? localSpotFactor(world, t.x, t.y) : 1;
    const light = u.tpl.flying ? 0.55 + 0.45 * lit : lit;
    const spotRange = baseSpot * light;

    // 民間人は敵ではないが、目視対象にはなる
    const d = dist(u.x, u.y, t.x, t.y);
    if (d > spotRange) {
      decayContact(u, t, now);
      continue;
    }

    const eye = u.tpl.flying ? 220 : 2;
    const los = lineOfSight(terrain, u.x, u.y, t.x, t.y, eye, t.tpl.flying ? 60 : 1.7);
    if (!los.visible) {
      decayContact(u, t, now);
      continue;
    }

    // 発煙も川霧も、上空からの観測にはあまり効かない
    const air = u.tpl.flying ? 0.35 : 1;
    const smokeCut = smokeAttenuation(smokes, now, u.x, u.y, t.x, t.y) * air;
    const mistCut = world ? mistAttenuation(world, u.x, u.y, t.x, t.y) * air : 0;
    los.quality *= (1 - smokeCut) * (1 - mistCut);
    if (los.quality < 0.06) {
      decayContact(u, t, now);
      continue;
    }

    // 発見確率
    const tPosture = POSTURES[t.posture] ?? POSTURES.normal;
    const rangeFactor = 1 - clamp(d / spotRange, 0, 1) * 0.75;
    const conceal = concealAt(terrain, t.x, t.y);
    const moving = t.path.length > 0 ? 1.5 : 1.0;
    const firing = now - t.lastFiredAt < 8 ? 2.1 : 1.0;

    let p =
      0.42 *
      dt *
      los.quality *
      rangeFactor *
      (1 - conceal * 0.8) *
      tPosture.exposure *
      moving *
      firing *
      (0.5 + u.skill * 0.7);

    // 既に捕捉している目標は見失いにくい
    const existing = u.contacts.get(t.id);
    if (existing && now - existing.lastSeenAt < 25) p = Math.min(1, p * 3.2);

    if (!rng.chance(clamp(p, 0, 0.96))) continue;

    // 観測の質: 距離・視程・観測者の練度・自身の動揺で決まる
    const quality = clamp(
      los.quality * (0.45 + 0.55 * rangeFactor) * (0.55 + u.skill * 0.5) -
        clamp(u.suppression / 240, 0, 0.35),
      0.05,
      1
    );

    let c = u.contacts.get(t.id);
    if (!c) {
      c = {
        targetId: t.id,
        side: t.side,
        firstSeenAt: now,
        firstX: t.x,
        firstY: t.y,
        reportedAt: -Infinity,
        reportDueAt: null,
        classified: t.type,
        classifiedStrength: t.strength,
        isNew: true,
      };
      u.contacts.set(t.id, c);
    }

    c.lastSeenAt = now;
    c.x = t.x;
    c.y = t.y;
    c.quality = quality;
    c.trueType = t.type;
    c.trueStrength = t.strength;
    c.lost = false;

    // 兵種の同定は質が低いと外す
    const pool = CONFUSION[t.type] ?? [t.type];
    if (quality > 0.72 || pool.length === 1) {
      c.classified = t.type;
    } else if (rng.chance(clamp(0.62 - quality, 0.05, 0.55))) {
      c.classified = rng.pick(pool);
    }

    // 規模の見積もりも揺れる
    const err = rng.gauss(0, (1 - quality) * 0.55);
    c.classifiedStrength = clamp(Math.round(t.strength * (1 + err)), 1, t.maxStrength * 2);
  }
}

function decayContact(u, t, now) {
  const c = u.contacts.get(t.id);
  if (!c) return;
  if (!c.lost && now - c.lastSeenAt > 45) {
    c.lost = true;
    c.lostAt = now;
  }
}

/** 現在このユニットが交戦できる（見えている）敵の一覧 */
export function visibleEnemies(u, unitsById, now, maxAge = 18) {
  const out = [];
  for (const c of u.contacts.values()) {
    if (now - c.lastSeenAt > maxAge) continue;
    const t = unitsById.get(c.targetId);
    if (!t || !t.alive) continue;
    if (t.side === u.side) continue;
    out.push(t);
  }
  return out;
}
