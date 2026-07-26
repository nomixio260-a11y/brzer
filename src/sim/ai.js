// 敵の行動。プレイヤーには見えないので、派手さより「筋の通った圧力」を優先する。

import { clamp, dist } from '../util.js';
import { riverCenterY } from './terrain.js';
import { setDestination, clearDestination } from './units.js';
import { createFireMission } from './combat.js';
import { visibleEnemies } from './perception.js';

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
    if (canHurt && nearest.d < u.tpl.range * 0.95) {
      // 射程内。止まって撃つ。
      u.path = [];
      u.posture = u.tpl.armor > 0.4 ? 'normal' : 'cautious';
      u.state = 'attacking';
      return;
    }
    if (canHurt && nearest.d < u.tpl.range * 2.2) {
      // 射程外だが見えている。詰める。
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
    // 主攻は目標に着いたら橋へ圧力をかけ続ける
    ai.objective = { x: world.terrain.bridge.x, y: world.terrain.bridge.y + 420 };
    return;
  }

  // 接敵していない間は普通に歩く。慎重な態勢のまま3km歩かせると永遠に着かない。
  // 迂回部隊は渡河を終えるまで急ぐ（浅瀬の徒渉が遅いぶんを取り返す）。
  const hurrying = ai.task === 'flank' && !(u.y > riverCenterY(u.x) + 70);
  u.posture = ai.task === 'probe' ? 'stealth' : hurrying ? 'rapid' : 'normal';
  u.state = 'moving';
  if (!u.path.length || u._goalKey !== goalKey(goal)) {
    u._goalKey = goalKey(goal);
    setDestination(u, world.terrain, goal.x, goal.y);
  }
}

function goalKey(g) {
  return `${Math.round(g.x / 50)}:${Math.round(g.y / 50)}`;
}

/** 渡河が済んでいなければまず渡河点、済んでいれば最終目標 */
function resolveGoal(world, u, ai) {
  const onSouthBank = u.y > riverCenterY(u.x) + 70;

  if (ai.crossing && !onSouthBank) {
    const dCross = dist(u.x, u.y, ai.crossing.x, ai.crossing.y);
    if (dCross > 90) return ai.crossing;
    // 渡河点の上。対岸へ押し出す。
    return { x: ai.crossing.x, y: riverCenterY(ai.crossing.x) + 220 };
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

  const rounds = Math.min(world.enemyArty.rounds, 4);
  world.enemyArty.rounds -= rounds;
  world.enemyArty.nextAt = world.now + 150 + world.rng.range(0, 90);

  // 敵の照準もずれる
  const ex = best.v.x + world.rng.gauss(0, 110);
  const ey = best.v.y + world.rng.gauss(0, 110);

  world.fireMissions.push(
    createFireMission('he', ex, ey, world.now, {
      side: 'enemy',
      rounds,
      delay: 45 + world.rng.range(0, 25),
      radius: 120,
    })
  );
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
