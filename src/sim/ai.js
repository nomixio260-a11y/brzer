// 敵の行動。プレイヤーには見えないので、派手さより「筋の通った圧力」を優先する。

import { clamp, dist, toGrid, bearing, compassJa } from '../util.js';

import { setDestination, clearDestination } from './units.js';
import { createFireMission } from './combat.js';
import { visibleEnemies } from './perception.js';
import { backOffPoint } from './armor.js';
import { flareLight } from './fires.js';
import { enqueue, PRI } from './comms.js';

/** 敵side内で共有される目標情報 */
function updateEnemyIntel(world) {
  const intel = world.enemyIntel;
  for (const u of world.units) {
    if (u.side !== 'enemy' || !u.alive) continue;
    for (const c of u.contacts.values()) {
      if (world.now - c.lastSeenAt > 60) continue;
      const prev = intel.get(c.targetId);
      if (!prev || prev.at < c.lastSeenAt) {
        intel.set(c.targetId, { x: c.x, y: c.y, at: c.lastSeenAt, type: c.trueType });
      }
    }
  }
  // 古い情報は捨てる
  for (const [id, v] of intel) {
    if (world.now - v.at > 300) intel.delete(id);
  }
}

export function stepAI(world, dt) {
  updateEnemyIntel(world);

  for (const u of world.units) {
    if (!u.alive) continue;
    if (u.side === 'friend') continue;

    if (u.side === 'civilian') {
      stepCivilian(world, u);
      continue;
    }

    if (world.now < (u._aiNextAt ?? -Infinity)) continue;
    u._aiNextAt = world.now + 3 + world.rng.range(0, 2.5);
    runEnemy(world, u);
  }

  stepEnemyIndirect(world);
}

function runEnemy(world, u) {
  const ai = u.ai ?? (u.ai = { task: 'assault' });

  // --- 統制喪失 → 北へ逃げる -----------------------------------
  if (u.state === 'broken') {
    u.posture = 'rapid';
    if (!u.path.length) {
      setDestination(u, world.terrain, u.x + world.rng.range(-300, 300), Math.max(40, u.y - 1400));
    }
    return;
  }

  // --- 履帯をやられた車輌 ----------------------------------------
  // もう動けない。動けないなら、その場を撃つ台にするしかない。
  if (u._immobile) {
    u.posture = 'dug_in';
    u.state = visibleEnemies(u, world.unitsById, world.now, 20).length ? 'attacking' : 'defending';
    clearDestination(u);
    return;
  }

  // --- 対戦車火器に撃たれた車輌は、煙を張って退がる ---------------
  // 撃たれた場所に留まる戦車はない。まず遮蔽の裏へ出て、それから考える。
  if (world.now - (u._backingOffAt ?? -Infinity) < 28) {
    if (!u.path.length && u._threatFrom) {
      const p = backOffPoint(u, u._threatFrom, 300);
      setDestination(u, world.terrain, p.x, p.y);
    }
    u.posture = 'rapid';
    u.state = 'moving';
    return;
  }

  // --- 砲撃を受けたら散る ----------------------------------------
  // 弾着の下で固まっているのは、いちばんやってはいけないことである。
  // 実際の部隊は、まず散開して弾着圏から出ようとする。
  if (world.now - (u._shelledAt ?? -Infinity) < 40) {
    if (!u.path.length) {
      const a = world.rng.range(0, Math.PI * 2);
      const d = 220 + world.rng.range(0, 160);
      setDestination(u, world.terrain, u.x + Math.cos(a) * d, u.y + Math.sin(a) * d);
    }
    u.posture = 'rapid';
    u.state = 'moving';
    return;
  }

  // --- 制圧されていたら伏せる ------------------------------------
  if (u.suppression > 82) {
    u.posture = 'cautious';
    u.path = [];
    return;
  }

  if (u.tpl.indirect) {
    u.posture = 'dug_in';
    return; // 迫撃砲は動かない
  }

  // 予備は集結地で伏せて待つ。投入は敵指揮官が決める。
  if (ai.task === 'reserve') {
    u.posture = 'cautious';
    u.state = 'holding';
    clearDestination(u);
    return;
  }

  // 陣地に籠って一点を守る敵（逆襲ミッションの守備側）。
  // 追撃はしない ─ 持ち場を離れた瞬間、その陣地は無価値になるからである。
  if (ai.task === 'hold_ground') {
    holdGround(world, u, ai);
    return;
  }

  // 攻撃を中止して北岸へ退がった部隊。集結地に着いたら伏せて立て直す。
  if (ai.task === 'retire') {
    if (u.path.length) {
      u.posture = 'rapid';
      return;
    }
    if (dist(u.x, u.y, ai.rally.x, ai.rally.y) > 160) {
      setDestination(u, world.terrain, ai.rally.x, ai.rally.y);
      return;
    }
    u.posture = 'dug_in';
    u.state = 'holding';
    clearDestination(u);
    return;
  }

  const targets = visibleEnemies(u, world.unitsById, world.now, 20).filter((t) => !t.tpl.civilian);
  const nearest = targets.reduce(
    (best, t) => {
      const d = dist(u.x, u.y, t.x, t.y);
      return d < best.d ? { t, d } : best;
    },
    { t: null, d: Infinity }
  );

  // --- 交戦判断 ---------------------------------------------------
  if (nearest.t) {
    const canHurt = u.tpl.firepower * (1 - nearest.t.tpl.armor) + u.tpl.ap * nearest.t.tpl.armor > 0.15;
    if (canHurt && nearest.d < engageRange(u, ai)) {
      // 射程内。止まって撃つ。
      u.path = [];
      u.posture = u.tpl.armor > 0.4 ? 'normal' : 'cautious';
      u.state = 'attacking';
      return;
    }
    if (canHurt && nearest.d < u.tpl.range * 2.2) {
      // 射程外だが見えている。ただし全部が同時に駆け出したりはしない ―
      // 半分が止まって撃ち、半分が動く。躍進前進である。
      if (overwatchPhase(world, u) && nearest.d < u.tpl.range) {
        u.path = [];
        u.posture = 'cautious';
        u.state = 'attacking';
        return;
      }
      u.posture = 'cautious';
      u.state = 'attacking';
      if (!u.path.length) setDestination(u, world.terrain, nearest.t.x, nearest.t.y);
      return;
    }
  }

  // --- 前進 -------------------------------------------------------
  const goal = resolveGoal(world, u, ai);
  if (!goal) {
    u.posture = 'dug_in';
    clearDestination(u);
    return;
  }

  const arrived = dist(u.x, u.y, goal.x, goal.y) < 130;
  if (arrived) {
    // 斥候と陽動部隊は、その場に居座って圧力をかけるだけ。渡河はしない。
    if (ai.task === 'probe' || ai.task === 'pressure') {
      u.posture = ai.task === 'probe' ? 'cautious' : 'dug_in';
      u.state = 'holding';
      clearDestination(u);
      return;
    }
    // 目標に着いたら、その先の最終目標へ圧力をかけ続ける。
    // 「橋の南 420m」を決め打ちにしていたせいで、峠の図幅では
    // 全部隊が隘路の出口一点に積み上がって止まっていた。
    ai.objective = enemyGoal(world, u);
    return;
  }

  // 接敵していない間は普通に歩く。慎重な態勢のまま3km歩かせると永遠に着かない。
  // 迂回部隊は渡河を終えるまで急ぐ（浅瀬の徒渉が遅いぶんを取り返す）。
  const hurrying = ai.task === 'flank' && !(u.y > world.terrain.front(u.x) + 70);
  u.posture = ai.task === 'probe' ? 'stealth' : hurrying ? 'rapid' : 'normal';
  // 照明の下を駆け抜ける部隊はいない。光が落ちるまで身を低くする。
  if (flareLight(world, u.x, u.y) > 0.45 && u.posture !== 'stealth') u.posture = 'cautious';
  u.state = 'moving';
  if (!u.path.length || u._goalKey !== goalKey(goal)) {
    u._goalKey = goalKey(goal);
    setDestination(u, world.terrain, goal.x, goal.y);
  }
}

/**
 * 躍進の位相。
 *
 * 同じ軸の部隊を二組に分け、片方が動くあいだ、もう片方は止まって撃つ。
 * 全部が同時に走り出すのは映画のなかだけである ―
 * 実際の前進は、掩護と機動の交代でできている。
 */
function overwatchPhase(world, u) {
  if (u._boundParity == null) {
    let h = 0;
    for (let i = 0; i < u.id.length; i++) h = (h * 31 + u.id.charCodeAt(i)) | 0;
    u._boundParity = Math.abs(h) % 2;
  }
  const phase = Math.floor(world.now / 45) % 2;
  return u._boundParity === phase;
}

/**
 * 陣地を守る。
 *
 * 目の前に敵が出れば撃つが、追いかけはしない。押し出されたら持ち場へ戻る。
 * 守る側の強みは陣地そのものなので、そこを離れた時点で強みが消える。
 */
function holdGround(world, u, ai) {
  const anchor = ai.anchor ?? { x: u.x, y: u.y };
  const away = dist(u.x, u.y, anchor.x, anchor.y);

  // 押し出されたら戻る
  if (away > 220) {
    u.state = 'moving';
    u.posture = 'cautious';
    if (!u.path.length) setDestination(u, world.terrain, anchor.x, anchor.y);
    return;
  }

  clearDestination(u);
  const seen = visibleEnemies(u, world.unitsById, world.now, 20).filter((t) => !t.tpl.civilian);
  u.state = seen.length ? 'attacking' : 'defending';
  // 掘ってあるものは掘り直さない
  if (u.posture !== 'dug_in' && u.posture !== 'fortified') u.posture = 'dug_in';
}

/**
 * どこまで詰めてから撃つか。
 *
 * 最大射程で止まる戦車は、渡河点を掩護できない。橋を奪るには前へ出るしかなく、
 * 出れば守り手の射程にも入る ─ 攻者が払うべき代償である。
 * 逆に陽動部隊は遠くから撃っていればよい。それが陽動の役目だから。
 */
function engageRange(u, ai) {
  const max = u.tpl.range * 0.95;
  if (ai.task === 'pressure' || ai.task === 'probe') return max;
  // 突撃・迂回する部隊は目標を取りにいく。装甲でも900mまでは寄る。
  return Math.min(max, u.tpl.armor > 0.4 ? 900 : 620);
}

/**
 * 敵の最終目標。
 * ミッションが指定していればそれ、なければ主通過点の南。
 * 同じ点に全部隊が重なると縦隊が一点に潰れるので、部隊ごとに散らす。
 */
export function enemyGoal(world, u) {
  const base = world.mission.enemyGoal ?? {
    x: world.terrain.bridge.x,
    y: world.terrain.bridge.y + 420,
  };
  if (!u) return base;
  // 呼出符号から決まる固定の散らし方（毎回同じ盤面になるように）
  let h = 0;
  for (let i = 0; i < u.id.length; i++) h = (h * 31 + u.id.charCodeAt(i)) | 0;
  const a = ((Math.abs(h) % 360) / 180) * Math.PI;
  const r = 120 + (Math.abs(h >> 3) % 220);
  return { x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r * 0.6 };
}

function goalKey(g) {
  return `${Math.round(g.x / 50)}:${Math.round(g.y / 50)}`;
}

/** 渡河が済んでいなければまず渡河点、済んでいれば最終目標 */
function resolveGoal(world, u, ai) {
  const onSouthBank = u.y > world.terrain.front(u.x) + 70;

  if (ai.crossing && !onSouthBank) {
    const dCross = dist(u.x, u.y, ai.crossing.x, ai.crossing.y);
    if (dCross > 90) return ai.crossing;
    // 渡河点の上。対岸へ押し出す。
    return { x: ai.crossing.x, y: world.terrain.front(ai.crossing.x) + 220 };
  }
  return ai.objective ?? null;
}

/* ------------------------------------------------------------------ */
/* 敵の曲射                                                             */
/* ------------------------------------------------------------------ */

function stepEnemyIndirect(world) {
  const mortars = world.units.filter((u) => u.alive && u.side === 'enemy' && u.tpl.indirect);
  if (!mortars.length) return;
  if (world.now < (world.enemyArty.nextAt ?? -Infinity)) return;
  if (world.enemyArty.rounds <= 0) return;

  // 共有情報の中から最も新しいものを狙う
  let best = null;
  for (const [id, v] of world.enemyIntel) {
    const t = world.unitsById.get(id);
    if (!t || !t.alive || t.side !== 'friend') continue;
    if (t.tpl.flying) continue;
    if (world.now - v.at > 180) continue;
    if (!best || v.at > best.v.at) best = { id, v };
  }
  if (!best) {
    world.enemyArty.nextAt = world.now + 60;
    return;
  }

  // 突撃が始まっていれば制圧射に切り替える。
  // 敵の砲もまた、撃破のためでなく「頭を上げさせない」ために撃つ。
  const assaulting = world.units.filter(
    (e) => e.alive && e.side === 'enemy' && e.state === 'attacking'
  ).length;
  const mode = assaulting >= 3 ? 'sustained' : world.rng.chance(0.35) ? 'salvo' : 'impact';
  const rounds = Math.min(world.enemyArty.rounds, mode === 'sustained' ? 6 : 4);
  world.enemyArty.rounds -= rounds;
  world.enemyArty.nextAt = world.now + 150 + world.rng.range(0, 90);

  // 敵の照準もずれる
  const ex = best.v.x + world.rng.gauss(0, 110);
  const ey = best.v.y + world.rng.gauss(0, 110);

  world.fireMissions.push(
    createFireMission('he', ex, ey, world.now, {
      side: 'enemy',
      rounds,
      mode,
      delay: 45 + world.rng.range(0, 25),
      radius: 120,
    })
  );

  reportGunSound(world, mortars[0]);
}

/**
 * 砲声。
 *
 * 発射音は隠せない。近くにいる部隊は「どちらで撃ったか」を聞き取り、
 * おおよその方向と距離を言ってくる ── 音源標定である。
 * 正確ではない。だが、敵の迫がどのあたりにいるかは、それで分かる。
 * 分かれば、こちらの砲で潰せる。
 */
function reportGunSound(world, gun) {
  if (!gun) return;
  for (const o of world.units) {
    if (o.side !== 'friend' || !o.alive || !o.commsOk || !o.tpl.radio) continue;
    if (o.tpl.flying) continue;
    const d = dist(o.x, o.y, gun.x, gun.y);
    if (d > 3400) continue;
    if (world.now - (o._gunSoundAt ?? -Infinity) < 300) continue;
    o._gunSoundAt = world.now;

    // 音だけで出せる精度には限りがある。遠いほど、大きく外す。
    const err = 130 + d * 0.15;
    const gx = gun.x + world.rng.gauss(0, err);
    const gy = gun.y + world.rng.gauss(0, err);
    const dir = compassJa(bearing(o.x, o.y, gx, gy));

    enqueue(world, {
      from: o.callsign,
      fromId: o.id,
      kind: 'contact',
      text:
        `こちら${o.callsign}、砲声を聞いた。${dir}、${toGrid(gx, gy)}付近と見る。` +
        `敵の迫だ ─ 潰せるなら潰してほしい。`,
      priority: PRI.PRIORITY,
      meta: {
        unitId: o.id,
        grid: toGrid(gx, gy),
        reportedX: gx,
        reportedY: gy,
        classified: 'mortar',
        quality: 0.35,
        observedAt: world.now,
      },
      composedAt: world.now,
      duration: 4.5,
    });
    return; // 一人が言えば足りる
  }
}

/* ------------------------------------------------------------------ */
/* 民間人                                                              */
/* ------------------------------------------------------------------ */

function stepCivilian(world, u) {
  const ai = u.ai ?? (u.ai = { task: 'transit', waypoints: [] });

  // 撃たれたら止まって散る
  if (world.now - u.lastHitAt < 25) {
    u.path = [];
    u.posture = 'cautious';
    u.panicked = true;
    return;
  }

  if (u.panicked && world.now - u.lastHitAt < 90) return;
  u.panicked = false;

  if (!u.path.length) {
    const next = ai.waypoints?.shift();
    if (next) {
      setDestination(u, world.terrain, next.x, next.y);
      u.state = 'moving';
    } else {
      // 地図外へ抜けた＝退避成功
      u.evacuated = true;
      u.alive = false;
      u.state = 'destroyed';
      u.deathAt = world.now;
    }
  }
}

/** 民間車列が無事に抜けたか */
export function civiliansSafe(world) {
  const civ = world.units.filter((u) => u.side === 'civilian');
  if (!civ.length) return null;
  return civ.every((u) => u.evacuated || u.losses < 1);
}
