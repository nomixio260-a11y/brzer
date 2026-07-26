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
import { stepFires, FIRE_MODES } from './fires.js';
import { ASPECT_JA } from './armor.js';
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
    flares: [], // 照明弾。夜の谷を、しばらくのあいだ昼にする。
    registrations: [], // 概定射点
    // 装甲戦闘の結果。報告を組み立てるあいだだけ置いておく。
    armorEvents: [],

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
      // 照明弾。夜明け前の戦闘では、これが弾薬より効くことがある。
      illum: {
        name: mission.support.illum?.name ?? mission.support.artillery.name,
        rounds: mission.support.illum?.rounds ?? (mission.duration === 'long' ? 8 : 4),
      },
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

  world.armorEvents.length = 0;
  stepDirectFire(world, dt);
  stepFireMissions(world, dt);
  stepFires(world);

  for (const u of world.units) stepMorale(u, world.now, dt);

  // 弾と疲労と傷。撃ち合いが済んだあとに残るもの。
  stepAttrition(world, dt);
  stepLogistics(world, dt);

  handleBrokenFriendlies(world);
  reportFriendlyFire(world, beforeFF);
  reportDeaths(world, beforeDeaths);
  reportArmorEngagements(world);
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
 * 装甲戦闘の報告。
 *
 * 対戦車の撃ち合いは一発ごとに決着がつくので、そのつど無線に乗る。
 * 「効果なし」も必ず伝える ─ 正面から抜けなかったという事実こそが、
 * 指揮官に「回り込ませろ」と決心させる材料になるからである。
 */
function reportArmorEngagements(world) {
  for (const ev of world.armorEvents) {
    const shooter = ev.shooter;
    const target = ev.target;

    // 撃ったのが自軍なら、撃った本人が報告する
    if (shooter.side === 'friend' && shooter.commsOk && shooter.tpl.radio > 0) {
      if (ev.result === 'kill') {
        enqueue(world, {
          from: shooter.callsign,
          fromId: shooter.id,
          kind: 'kill',
          text:
            `こちら${shooter.callsign}、命中！${toGrid(target.x, target.y)}、` +
            `${target.tpl.label}1${target.tpl.unitJa}撃破。炎上している。`,
          priority: PRI.FLASH,
          meta: { unitId: shooter.id, grid: toGrid(target.x, target.y), observedAt: world.now },
          composedAt: world.now,
          duration: 4.5,
        });
        continue;
      }
      if (ev.result === 'mobility') {
        enqueue(world, {
          from: shooter.callsign,
          fromId: shooter.id,
          kind: 'kill',
          text:
            `こちら${shooter.callsign}、命中。${toGrid(target.x, target.y)}の${target.tpl.label}、` +
            `動きが止まった。まだ撃ってくる。`,
          priority: PRI.PRIORITY,
          meta: { unitId: shooter.id, grid: toGrid(target.x, target.y), observedAt: world.now },
          composedAt: world.now,
          duration: 4,
        });
        continue;
      }
      // 弾かれたことは、そう何度も言わない。一度言えば十分である。
      if (ev.result === 'bounce' && world.now - (shooter._bounceReportedAt ?? -Infinity) > 180) {
        shooter._bounceReportedAt = world.now;
        enqueue(world, {
          from: shooter.callsign,
          fromId: shooter.id,
          kind: 'engagement',
          text:
            `こちら${shooter.callsign}、命中したが効果なし。${ASPECT_JA[ev.aspect]}では抜けない。` +
            `横を取れる位置がほしい。`,
          priority: PRI.PRIORITY,
          meta: { unitId: shooter.id, grid: toGrid(target.x, target.y), observedAt: world.now },
          composedAt: world.now,
          duration: 4.5,
        });
      }
      continue;
    }

    // 撃たれたのが自軍の車輌なら、撃たれた側が叫ぶ
    if (target.side === 'friend' && target.alive && target.commsOk && target.tpl.radio > 0) {
      if (ev.result !== 'kill' && ev.result !== 'mobility') continue;
      if (world.now - (target._hitReportedAt ?? -Infinity) < 40) continue;
      target._hitReportedAt = world.now;
      enqueue(world, {
        from: target.callsign,
        fromId: target.id,
        kind: 'contact',
        text:
          `こちら${target.callsign}、被弾！${toGrid(target.x, target.y)}、` +
          (ev.result === 'kill' ? '1両やられた！' : '動けない、履帯をやられた！') +
          `${toGrid(ev.shooter.x, ev.shooter.y)}方向から撃たれている！`,
        priority: PRI.FLASH,
        meta: { unitId: target.id, grid: toGrid(target.x, target.y), observedAt: world.now },
        composedAt: world.now,
        duration: 5,
      });
    }
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
    const pool = fm.kind === 'smoke' ? 'smoke' : fm.kind === 'illum' ? 'illum' : 'artillery';
    const gun = world.support[pool].name;

    if (!fm._shotCalled && world.now >= fm.firstImpactAt - 22) {
      fm._shotCalled = true;
      const eta = Math.max(1, Math.round(fm.firstImpactAt - world.now));
      const how =
        fm.kind === 'smoke' ? '発煙' : fm.kind === 'illum' ? '照明' : `${FIRE_MODES[fm.mode]?.label ?? '着発'}`;
      enqueue(world, {
        from: gun,
        fromId: null,
        kind: 'firecontrol',
        text: `こちら${gun}、撃った。${toGrid(fm.x, fm.y)}、${how}、弾着まで約${eta}秒。どうぞ`,
        priority: PRI.PRIORITY,
        meta: { grid: toGrid(fm.x, fm.y), missionId: fm.id, observedAt: world.now },
        composedAt: world.now,
        duration: 4,
      });
    }

    // 観測員が弾を引っ張ったら、そのことも無線に乗る
    if (fm._walkEvent && !fm._walkReported) {
      fm._walkReported = true;
      const o = fm._walkEvent.observer;
      if (o.alive && o.commsOk) {
        enqueue(world, {
          from: o.callsign,
          fromId: o.id,
          kind: 'spot',
          text:
            `こちら${o.callsign}、弾着を見ている。修正 ─ ${fm._walkEvent.grid}。` +
            `そのまま続けてくれ。`,
          priority: PRI.PRIORITY,
          meta: { unitId: o.id, grid: fm._walkEvent.grid, observedAt: world.now },
          composedAt: world.now,
          duration: 4,
        });
      }
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
    if (fm.side !== 'friend' || fm.kind === 'illum') {
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
