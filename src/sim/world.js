// シミュレーション全体の組み立てと1ティックの進行。
// DOM非依存 ― node からそのまま import してテストできる。

import { Rng, toGrid, dist } from '../util.js';
import { generateTerrain } from './terrain.js';
import { createUnit, stepMovement, stepMorale, setDestination } from './units.js';
import { stepPerception } from './perception.js';
import { stepDirectFire, stepFireMissions } from './combat.js';
import { createRadio, stepComms, stepCommsStatus, enqueue, PRI } from './comms.js';
import { stepReporting, composeSpotReport } from './reports.js';
import { deliverOrders, stepOrders } from './orders.js';
import { stepAI } from './ai.js';
import { createEnemyCommand, stepEnemyCommand, stepEnemyRecovery } from './enemyCommand.js';
import { stepFriendlyInitiative } from './friendlyAI.js';
import { pruneSmoke } from './smoke.js';
import { createTrains, stepLogistics, stepAttrition } from './logistics.js';
import { getMission, friendlyOrderOfBattle, timeline, evaluate } from './scenario.js';

export function createWorld(opts = {}) {
  const mission = getMission(opts.missionId);
  const seed = opts.seed ?? mission.seed;
  const terrain = generateTerrain(seed, mission.mapId);
  const rng = new Rng(seed ^ 0x2f6e2b1);
  // 敵の企図を振る場合だけ、盤ごとに違う目を使う（地形は常に同じ）
  const planRng = opts.variable ? new Rng((Math.floor(opts.planSeed ?? 0) || 1) >>> 0) : null;

  const world = {
    mission,
    terrain,
    rng,
    now: mission.startTime,
    tickCount: 0,

    units: [],
    unitsById: new Map(),

    radio: createRadio(),
    orders: [],
    fireMissions: [],
    smokes: [],
    registrations: [], // 概定射点

    enemyIntel: new Map(),
    // 長期戦の敵は、半日ぶんの弾を持ってくる
    enemyArty: {
      rounds: mission.duration === 'long' ? 40 : 16,
      nextAt: mission.startTime + (mission.duration === 'long' ? 4200 : 2700),
    },
    enemyCommand: null, // 下で組み立てる（world 参照が要るため）

    support: {
      artillery: { name: mission.support.artillery.name, rounds: mission.support.artillery.rounds },
      smoke: { name: mission.support.smoke.name, rounds: mission.support.smoke.rounds },
    },

    commandPost: mission.commandPost,

    // 時刻順に並べ直す（シナリオ側の記述順に依存しないように）
    events: timeline(planRng, { variable: !!opts.variable, mission }).sort((a, b) => a.at - b.at),
    variable: !!opts.variable,
    eventIndex: 0,

    outcome: null,
    outcomeReason: null,
    bridgeLostSince: null,

    stats: {
      ordersIssued: 0,
      ordersRefused: 0,
      fireMissions: 0,
      responseTimes: [],
    },
  };

  world.enemyCommand = createEnemyCommand(world);
  world.trains = createTrains(mission);

  for (const def of friendlyOrderOfBattle(mission)) {
    addUnit(world, def);
  }

  return world;
}

export function addUnit(world, def) {
  const u = createUnit(def);
  u.role = def.role;
  u.ai = def.ai ? structuredCloneSafe(def.ai) : null;
  world.units.push(u);
  world.unitsById.set(u.id, u);
  return u;
}

function structuredCloneSafe(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ------------------------------------------------------------------ */
/* ティック                                                             */
/* ------------------------------------------------------------------ */

/**
 * シミュレーションを dt 秒進める。dt は 1 秒固定を想定。
 * @returns {Array} このティックで新たに配信された無線ログ
 */
export function tick(world, dt = 1) {
  if (world.outcome) return [];

  world.now += dt;
  world.tickCount++;

  fireTimelineEvents(world);

  // 敵の指揮官が決心し、そのあとで各部隊が動く
  stepEnemyCommand(world, dt);
  stepEnemyRecovery(world, dt);
  stepAI(world, dt);
  stepFriendlyInitiative(world, dt);

  for (const u of world.units) stepMovement(u, world.terrain, dt);

  world.smokes = pruneSmoke(world.smokes, world.now);
  for (const u of world.units) {
    stepPerception(u, world.units, world.terrain, world.now, dt, world.rng, world.smokes, world);
  }

  const beforeDeaths = new Set(world.units.filter((u) => !u.alive).map((u) => u.id));
  const beforeFF = new Set(world.units.filter((u) => u.killedByFriendly).map((u) => u.id));

  stepDirectFire(world, dt);
  stepFireMissions(world, dt);

  for (const u of world.units) stepMorale(u, world.now, dt);

  // 弾と疲労と傷。撃ち合いが済んだあとに残るもの。
  stepAttrition(world, dt);
  stepLogistics(world, dt);

  handleBrokenFriendlies(world);
  reportFriendlyFire(world, beforeFF);
  reportDeaths(world, beforeDeaths);
  reportFireControl(world);
  reportFireMissions(world);
  reportAmmoState(world);

  const commsEvents = stepCommsStatus(world, dt);
  reportCommsRestored(world, commsEvents);

  stepReporting(world, dt);

  const delivered = stepComms(world, dt);
  deliverOrders(world, delivered);
  stepOrders(world, dt);

  const verdict = evaluate(world);
  if (verdict.status !== 'ongoing') {
    world.outcome = verdict.status;
    world.outcomeReason = verdict.reason;
  }

  return delivered;
}

/* ------------------------------------------------------------------ */
/* イベント                                                             */
/* ------------------------------------------------------------------ */

function fireTimelineEvents(world) {
  while (world.eventIndex < world.events.length && world.events[world.eventIndex].at <= world.now) {
    const ev = world.events[world.eventIndex++];
    switch (ev.kind) {
      case 'spawn':
        for (const def of ev.units) addUnit(world, def);
        break;
      case 'jamming':
        world.radio.jamming = ev.value;
        // 妨害は永久には続かない
        world.events.push({ at: world.now + 1500, kind: 'jamming', value: 0.05, label: '妨害減衰' });
        world.events.sort((a, b) => a.at - b.at);
        break;
      case 'message':
        world.radio.log.push({
          id: `EV${world.eventIndex}`,
          at: world.now,
          from: '大隊本部',
          kind: 'hq',
          priority: PRI.PRIORITY,
          text: ev.text,
          garbled: false,
          lost: false,
          meta: {},
          observedAt: world.now,
        });
        break;
      default:
        break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 派生的な報告                                                         */
/* ------------------------------------------------------------------ */

/** 崩れた友軍は勝手に後退する（指揮官の意思とは無関係に） */
function handleBrokenFriendlies(world) {
  for (const u of world.units) {
    if (u.side !== 'friend' || !u.alive) continue;
    if (u.state !== 'broken') continue;
    if (u.path.length) continue;
    const cp = world.commandPost;
    const dx = cp.x - u.x;
    const dy = cp.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    setDestination(u, world.terrain, u.x + (dx / d) * 700, u.y + (dy / d) * 700);
  }
}

function reportFriendlyFire(world, beforeFF) {
  for (const u of world.units) {
    if (!u.killedByFriendly || beforeFF.has(u.id)) continue;
    if (u.side === 'friend' && u.commsOk) {
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'friendly_fire',
        text: `射撃中止！射撃中止！${toGrid(u.x, u.y)}、こちらに落ちている！味方だ、味方に当たっている！`,
        priority: PRI.FLASH,
        meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: world.now },
        composedAt: world.now,
        duration: 5,
      });
    }
  }
}

function reportDeaths(world, beforeDeaths) {
  for (const u of world.units) {
    if (u.alive || beforeDeaths.has(u.id)) continue;
    if (u.evacuated) continue;

    // 死んだ本人は報告できない。近くの味方が気づいた場合だけ伝わる。
    if (u.side !== 'friend' && u.side !== 'civilian') continue;

    const witness = world.units.find(
      (w) =>
        w.alive &&
        w.side === 'friend' &&
        w.id !== u.id &&
        w.commsOk &&
        w.tpl.radio > 0 &&
        dist(w.x, w.y, u.x, u.y) < 800
    );
    if (!witness) continue;

    const text =
      u.side === 'civilian'
        ? `こちら${witness.callsign}……${toGrid(u.x, u.y)}の民間車両、やられた。動くものはない。`
        : `こちら${witness.callsign}、${u.callsign}の陣地が制圧された……応答がない。全滅したものと思われる。`;

    enqueue(world, {
      from: witness.callsign,
      fromId: witness.id,
      kind: 'loss',
      text,
      priority: PRI.FLASH,
      meta: { unitId: witness.id, aboutId: u.id, grid: toGrid(u.x, u.y), observedAt: world.now },
      composedAt: world.now,
    });
  }
}

/**
 * 射撃指揮の通話。
 * 実際の火力要請は「撃った」「弾着5秒前」が返ってきて初めて成立する。
 * これが無いと、指揮官は自分の砲弾がいつ落ちるのか分からない。
 */
function reportFireControl(world) {
  for (const fm of world.fireMissions) {
    if (fm.side !== 'friend' || fm.done) continue;
    const gun = world.support[fm.kind === 'smoke' ? 'smoke' : 'artillery'].name;

    if (!fm._shotCalled && world.now >= fm.firstImpactAt - 22) {
      fm._shotCalled = true;
      const eta = Math.max(1, Math.round(fm.firstImpactAt - world.now));
      enqueue(world, {
        from: gun,
        fromId: null,
        kind: 'firecontrol',
        text: `こちら${gun}、撃った。${toGrid(fm.x, fm.y)}、弾着まで約${eta}秒。どうぞ`,
        priority: PRI.PRIORITY,
        meta: { grid: toGrid(fm.x, fm.y), missionId: fm.id, observedAt: world.now },
        composedAt: world.now,
        duration: 4,
      });
    }

    if (!fm._splashCalled && world.now >= fm.firstImpactAt - 5) {
      fm._splashCalled = true;
      enqueue(world, {
        from: gun,
        fromId: null,
        kind: 'firecontrol',
        text: `${gun}、弾着5秒前。`,
        priority: PRI.FLASH,
        meta: { grid: toGrid(fm.x, fm.y), missionId: fm.id, observedAt: world.now },
        composedAt: world.now,
        duration: 2.2,
      });
    }
  }
}

/** 弾薬が心細くなったら一度だけ言ってくる */
function reportAmmoState(world) {
  for (const u of world.units) {
    if (u.side !== 'friend' || !u.alive || !u.commsOk) continue;
    if (u.tpl.maxAmmo <= 0) continue;
    const ratio = u.ammo / u.tpl.maxAmmo;
    if (ratio > 0.3 || u._ammoWarned) continue;
    u._ammoWarned = true;
    enqueue(world, {
      from: u.callsign,
      fromId: u.id,
      kind: 'logistics',
      text: `こちら${u.callsign}、弾薬が心配だ。${toGrid(u.x, u.y)}、あと保って半刻。補給を頼みたい。`,
      priority: PRI.PRIORITY,
      meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: world.now },
      composedAt: world.now,
    });
  }
}

function reportFireMissions(world) {
  for (const fm of world.fireMissions) {
    if (!fm.done || fm._reported) continue;
    if (fm.side !== 'friend') {
      fm._reported = true;
      continue;
    }
    fm._reported = true;

    // 弾着を見られる味方がいれば観測報告が入る。いなければ「効果不明」すら来ない。
    const observer = world.units.find(
      (w) =>
        w.alive &&
        w.side === 'friend' &&
        w.commsOk &&
        w.tpl.radio > 0 &&
        dist(w.x, w.y, fm.x, fm.y) < w.tpl.spot * 1.3
    );
    if (!observer) continue;

    const spot = composeSpotReport(observer, fm, world);
    enqueue(world, {
      from: observer.callsign,
      fromId: observer.id,
      kind: 'spot',
      text: spot.text,
      priority: fm.friendlyCasualties > 0 ? PRI.FLASH : PRI.PRIORITY,
      meta: {
        unitId: observer.id,
        grid: toGrid(fm.x, fm.y),
        observedAt: world.now,
        // 修正が返ってきたら、指揮官は一手で修正射を命じられる
        ...(spot.correction && fm.kind === 'he'
          ? {
              correctionX: spot.correction.x,
              correctionY: spot.correction.y,
              correctionGrid: spot.correction.grid,
            }
          : {}),
      },
      composedAt: world.now,
    });
  }
}

function reportCommsRestored(world, events) {
  for (const ev of events) {
    if (ev.type !== 'comms_restored') continue;
    const u = world.unitsById.get(ev.unitId);
    if (!u || !u.alive) continue;
    // 途絶が短ければわざわざ言わない
    if (world.now - (u._lastCommsLostAt ?? -Infinity) < 45) continue;
    enqueue(world, {
      from: u.callsign,
      fromId: u.id,
      kind: 'comms',
      text: `こちら${u.callsign}、感明。しばらく届いていなかったようだ。現在地${toGrid(u.x, u.y)}。`,
      priority: PRI.PRIORITY,
      meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: world.now },
      composedAt: world.now,
    });
  }
  for (const ev of events) {
    if (ev.type === 'comms_lost') {
      const u = world.unitsById.get(ev.unitId);
      if (u) u._lastCommsLostAt = world.now;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 参照用ヘルパー                                                       */
/* ------------------------------------------------------------------ */

export function friendlyUnits(world) {
  return world.units.filter((u) => u.side === 'friend');
}

export function isFinished(world) {
  return !!world.outcome;
}
