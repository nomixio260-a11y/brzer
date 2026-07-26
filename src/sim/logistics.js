// 兵站。
//
// 短い戦闘では弾は尽きない。だから今まで数えなくてよかった。
// だが半日守るとなれば話が変わる ── 撃てば減り、減れば運ばねばならず、
// 運ぶ者は前線へ出ていく間じゅう無防備である。
//
// 長期戦で指揮官が本当に管理するのは、部隊の位置ではなく「あと何時間撃てるか」だ。
// 静穏な30分を補給に使うか、休養に使うか、陣地の構築に使うか ──
// その配分が、次の攻撃を凌げるかどうかを決める。

import { clamp, dist, toGrid } from '../util.js';
import { setDestination } from './units.js';
import { riverCenterY } from './terrain.js';
import { enqueue, PRI } from './comms.js';

/** 補給を渡せる距離（m）。手渡しなので、ほぼ同じ場所にいる必要がある。 */
const HANDOVER_RANGE = 90;
/** 1秒あたりに渡せる弾薬（％ポイント） */
const TRANSFER_RATE = 1.6;
/** 補給を受けられる下限間隔。連続で呼び続けても意味はない。 */
const RESUPPLY_COOLDOWN = 240;
/** 掘ってある態勢（休息と回復が利く） */
const DUG = new Set(['dug_in', 'hasty', 'fortified']);

export function createTrains(mission) {
  const spec = mission.trains;
  if (!spec) return null;
  return {
    unitId: spec.unitId,
    // 携行できる基数。これを使い切れば、その日はもう運べない。
    loads: spec.loads,
    loadsLeft: spec.loads,
    task: null, // { targetId, phase:'moving'|'issuing' }
    issuedTo: new Map(), // unitId -> 最後に渡した時刻
    log: [],
  };
}

/* ------------------------------------------------------------------ */
/* 消耗                                                                */
/* ------------------------------------------------------------------ */

/**
 * 時間そのものによる消耗。
 * 撃たなくても、人は疲れ、水を飲み、夜通し起きていれば鈍る。
 */
export function stepAttrition(world, dt) {
  for (const u of world.units) {
    if (!u.alive || u.tpl.civilian) continue;

    const inContact = world.now - u.lastHitAt < 90;
    const moving = u.path.length > 0;

    // 疲労。
    //
    // 起きて警戒しているだけでも人は消耗する ── 半日となれば、
    // それだけで午後には当たらなくなる。掩体で静かにしていれば緩やかに戻るが、
    // 本当に抜けるのは交代で眠らせたときだけである。
    let rate = u.resting ? -0.14 : 0.006;
    if (!u.resting) {
      if (inContact) rate += 0.05;
      else if (!moving && DUG.has(u.posture)) rate -= 0.006;
    }
    u.fatigue = clamp(u.fatigue + dt * rate, 0, 400);

    // 休止中の部隊は交代で眠る。回復は早いが、その間は見張りが薄い。
    if (u.resting && (inContact || moving)) u.resting = false;

    // 軽傷者の復帰。手当てが行き届いていれば、数十分で戻ってくる者がいる。
    if (u.side === 'friend' && u.walkingWounded > 0 && !inContact && !moving) {
      const back = Math.min(u.walkingWounded, dt * 0.0016 * u.maxStrength);
      u.walkingWounded -= back;
      u.strength = Math.min(u.maxStrength, u.strength + back);
    }
  }
}

/** 疲労が射撃と判断に与える影響 0.65..1 */
export function fatigueFactor(u) {
  return 1 - clamp(u.fatigue / 400, 0, 0.35);
}

/** 疲労の言語化（数値は指揮官に見せない） */
export function fatigueJa(u) {
  if (u.fatigue > 300) return '消耗が激しい';
  if (u.fatigue > 190) return '疲労';
  if (u.fatigue > 90) return 'やや疲労';
  return null;
}

/* ------------------------------------------------------------------ */
/* 補給                                                                */
/* ------------------------------------------------------------------ */

/** 補給隊に「この部隊へ運べ」と指示する。 */
export function orderResupply(world, targetId) {
  const trains = world.trains;
  if (!trains) return { ok: false, reason: '補給隊がいない' };
  if (trains.loadsLeft <= 0) return { ok: false, reason: '弾薬集積所は空だ' };

  const carrier = world.unitsById.get(trains.unitId);
  const target = world.unitsById.get(targetId);
  if (!carrier?.alive) return { ok: false, reason: '補給隊は失われた' };
  if (!target?.alive) return { ok: false, reason: 'その部隊とは連絡がつかない' };

  const last = trains.issuedTo.get(targetId) ?? -Infinity;
  if (world.now - last < RESUPPLY_COOLDOWN) {
    return { ok: false, reason: 'さきほど渡したばかりだ' };
  }

  // 手ぶらで出ても意味がない。積んでいなければ、まず集積所へ戻る。
  const dump = world.mission.trains.dump;
  const atDump = dist(carrier.x, carrier.y, dump.x, dump.y) < 140;
  const loaded = carrier.carrying || atDump;

  trains.task = { targetId, phase: loaded ? 'moving' : 'fetching', startedAt: world.now };
  if (loaded) {
    carrier.carrying = true;
    setDestination(carrier, world.terrain, target.x, target.y);
  } else {
    setDestination(carrier, world.terrain, dump.x, dump.y);
  }
  carrier.state = 'moving';
  carrier.posture = carrierPace(world, carrier);
  return { ok: true, fetching: !loaded };
}

/**
 * 段列の歩き方。
 * 後方では普通に歩く ─ 慎重に運んでいては半日で二度しか届かない。
 * 前線に近づいたら身を低くする。運び屋が撃たれれば、弾は届かない。
 */
function carrierPace(world, carrier) {
  const nearFront = carrier.y < riverCenterY(carrier.x) + 900;
  return nearFront ? 'cautious' : 'normal';
}

/**
 * 補給隊の毎ティック処理。
 * 動いている間は無防備であり、渡している間は双方とも足が止まる。
 */
export function stepLogistics(world, dt) {
  const trains = world.trains;
  if (!trains) return;
  const carrier = world.unitsById.get(trains.unitId);
  if (!carrier?.alive) {
    if (trains.task) {
      trains.task = null;
      trains.log.push({ at: world.now, text: '補給隊が失われた' });
    }
    return;
  }

  const task = trains.task;
  if (!task) {
    // 手が空いていれば集積所へ戻る
    returnToDump(world, carrier);
    return;
  }

  const target = world.unitsById.get(task.targetId);
  if (!target?.alive) {
    trains.task = null;
    return;
  }

  const d = dist(carrier.x, carrier.y, target.x, target.y);

  // --- 集積所へ弾を取りに戻っている ---------------------------------
  if (task.phase === 'fetching') {
    const dump = world.mission.trains.dump;
    if (dist(carrier.x, carrier.y, dump.x, dump.y) > 140) {
      if (!carrier.path.length) setDestination(carrier, world.terrain, dump.x, dump.y);
      return;
    }
    carrier.carrying = true;
    task.phase = 'moving';
    setDestination(carrier, world.terrain, target.x, target.y);
    return;
  }

  if (task.phase === 'moving') {
    // 相手が動いていれば追いかける
    if (d > HANDOVER_RANGE) {
      carrier.posture = carrierPace(world, carrier);
      if (!carrier.path.length || world.now - (task.retargetAt ?? 0) > 45) {
        task.retargetAt = world.now;
        setDestination(carrier, world.terrain, target.x, target.y);
      }
      return;
    }
    task.phase = 'issuing';
    task.issueStartedAt = world.now;
    carrier.path = [];
    carrier.state = 'holding';
    carrier.posture = 'cautious';
    if (carrier.commsOk) {
      enqueue(world, {
        from: carrier.callsign,
        fromId: carrier.id,
        kind: 'logistics',
        text: `こちら${carrier.callsign}、${toGrid(carrier.x, carrier.y)}で${target.callsign}と接触。弾薬を渡す。`,
        priority: PRI.ROUTINE,
        meta: { unitId: carrier.id, grid: toGrid(carrier.x, carrier.y), observedAt: world.now },
        composedAt: world.now,
      });
    }
    return;
  }

  // --- 手渡し中 ----------------------------------------------------
  if (d > HANDOVER_RANGE * 1.6) {
    task.phase = 'moving'; // 相手が動いた
    return;
  }

  const room = target.tpl.maxAmmo - target.ammo;
  const give = Math.min(room, TRANSFER_RATE * dt);
  target.ammo += give;
  // 弾だけでなく水と食糧も届く。何より「見捨てられていない」ことが効く。
  target.fatigue = Math.max(0, target.fatigue - dt * 0.35);
  target.morale = Math.min(100, target.morale + dt * 0.03);

  if (target.ammo >= target.tpl.maxAmmo - 0.5 || room <= 0.5) {
    trains.loadsLeft = Math.max(0, trains.loadsLeft - 1);
    carrier.carrying = false; // 積み荷は置いてきた
    trains.issuedTo.set(target.id, world.now);
    trains.task = null;
    trains.log.push({ at: world.now, text: `${target.callsign}へ補給（残り${trains.loadsLeft}基数）` });
    if (carrier.commsOk) {
      enqueue(world, {
        from: carrier.callsign,
        fromId: carrier.id,
        kind: 'logistics',
        text:
          `こちら${carrier.callsign}、${target.callsign}への補給を完了。` +
          `手持ちの弾薬はあと${trains.loadsLeft}基数。`,
        priority: PRI.ROUTINE,
        meta: { unitId: carrier.id, grid: toGrid(carrier.x, carrier.y), observedAt: world.now },
        composedAt: world.now,
      });
    }
  }
}

function returnToDump(world, carrier) {
  const dump = world.mission.trains?.dump;
  if (!dump) return;
  if (dist(carrier.x, carrier.y, dump.x, dump.y) < 120) {
    carrier.path = [];
    carrier.state = 'holding';
    carrier.posture = 'dug_in';
    return;
  }
  if (!carrier.path.length) {
    setDestination(carrier, world.terrain, dump.x, dump.y);
    carrier.state = 'moving';
    carrier.posture = 'cautious';
  }
}

/** 弾薬の残りを「あとどれだけ撃てるか」で言う */
export function enduranceJa(u) {
  const ratio = u.ammo / (u.tpl.maxAmmo || 100);
  if (ratio > 0.6) return '当分は保つ';
  if (ratio > 0.3) return '激しい撃ち合いなら20分';
  if (ratio > 0.1) return '長くは撃てない';
  if (ratio > 0.02) return '次の攻撃は凌げない';
  return '撃ち尽くした';
}
