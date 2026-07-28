// シミュレーション全体の組み立てと1ティックの進行。
// DOM非依存 ― node からそのまま import してテストできる。

import { Rng, toGrid, dist } from '../util.js';
import { generateTerrain, obstacleAt, nearestPassable } from './terrain.js';
import { createUnit, stepMovement, stepMorale, setDestination, applyDamage, applySuppression } from './units.js';
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
import { createCreative, reinforcementDef } from './creative.js';
import { ASPECT_JA } from './armor.js';
import { getMission, friendlyOrderOfBattle, timeline, evaluate } from './scenario.js';
import { officerFactors } from './officers.js';
import { attachmentMods, isObserver } from './attachments.js';

/**
 * 戦役の持ち越しを一個の部隊に適用する。
 *
 * 「昨日の続き」を作るのはここ一箇所だけにしてある ─
 * 途中で湧く増援も同じ道を通るので、二日目の増援が満員で来ることはない。
 */
function applyCarry(world, u) {
  const setup = world.setup;
  if (!setup) return;

  // 率いる者。名前と気質は、部隊そのものより長く残る。
  const officer = setup.officers?.get?.(u.id) ?? null;
  if (officer) u.officer = officer;

  // 任務編成。今朝どの分隊に何を付けたか。
  const attached = setup.attach?.[u.id];
  if (attached?.length) {
    u.attach = [...attached];
    u.mods = attachmentMods(attached);
  }

  const c = setup.units?.[u.id];
  if (c) {
    if (c.dead) {
      // 昨日消えた部隊は、補充を入れて再編するしかない。
      // 中身は新兵ばかりで、率いる者も代わっている。
      u.strength = Math.max(1, Math.min(u.maxStrength, c.strength));
      u.skill = Math.max(0.42, u.skill - 0.12);
      u.morale = Math.min(u.morale, 72);
    } else {
      u.strength = Math.max(0.6, Math.min(u.maxStrength, c.strength));
      u.morale = c.morale ?? u.morale;
    }
    u.ammo = Math.round((u.tpl.maxAmmo || 100) * (c.ammoRatio ?? 1));
    u.fatigue = c.fatigue ?? 0;
    if (c.skillBias) u.skill = Math.max(0.4, u.skill + c.skillBias);
  }

  // 熟練は腕に出る。三日目の分隊は、初日の分隊とは別物である。
  if (officer) {
    const f = officerFactors(officer);
    u.skill = Math.min(0.97, u.skill * (0.94 + f.aim * 0.06));
  }

  // 国の状態。民心が高ければ士気の下駄が付き、低ければ最初から重い。
  // 統制は崩れにくさに効く ─ 崩れ方が変わるわけではない。
  const war = setup.war;
  if (war) {
    u.morale = Math.max(12, Math.min(100, u.morale + (war.startMorale ?? 0)));
    u.skill = Math.max(0.4, Math.min(0.97, u.skill * (war.recruit ?? 1)));
    u.stateHold = war.hold ?? 1;
  }

  // 夜通し掘った陣地。防御を命じられている部隊にだけ意味がある。
  if (setup.fortify && (u.posture === 'dug_in' || u.state === 'defending') && !u.tpl.flying) {
    u.posture = 'fortified';
  }
}

export function createWorld(opts = {}) {
  const mission = getMission(opts.missionId);
  const seed = opts.seed ?? mission.seed;
  const terrain = generateTerrain(seed, mission.mapId);
  const rng = new Rng(seed ^ 0x2f6e2b1);
  // 文面を組み立てるための乱数を、盤を回す乱数から分ける。
  //
  // 同じ列を使っていたので、「報告の言い回しが一語変わる」だけで
  // 以後の弾着点も敵の判断もずれていた ─ つまり情報統制を敷くと
  // 敵砲兵の落ちる場所が変わっていた。真実は belief の設定で動いてはならない。
  const textRng = new Rng((seed ^ 0x7a11c3) >>> 0);
  // 敵の企図を振る場合だけ、盤ごとに違う目を使う（地形は常に同じ）
  const planRng = opts.variable ? new Rng((Math.floor(opts.planSeed ?? 0) || 1) >>> 0) : null;

  const world = {
    mission,
    terrain,
    rng,
    textRng,
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

    // 戦役の持ち越し。単発の戦闘では null のまま。
    setup: opts.setup ?? null,

    // H時前。作戦命令を下達し、火力計画を立てている間。
    // この間は時計が止まっており、命令は無線ではなく口頭で渡る。
    planning: !!opts.planning,

    // 国政が前線に返してくるもの。
    // fear が高いほど、部下は悪い報せを上げなくなる ─
    // 指揮官が見る盤そのものが、統治の仕方で歪む。
    distortion: opts.setup?.war
      ? { fear: opts.setup.war.fear ?? 0, honesty: opts.setup.war.honesty ?? 1 }
      : { fear: 0, honesty: 1 },

    support: {
      // 戦役では、前の晩に段列から回してきたぶんが積み増しになる。
      artillery: {
        name: mission.support.artillery.name,
        rounds: mission.support.artillery.rounds + (opts.setup?.support?.rounds ?? 0),
      },
      smoke: {
        name: mission.support.smoke.name,
        rounds: mission.support.smoke.rounds + (opts.setup?.support?.smoke ?? 0),
      },
      // 照明弾。夜明け前の戦闘では、これが弾薬より効くことがある。
      illum: {
        name: mission.support.illum?.name ?? mission.support.artillery.name,
        rounds: (mission.support.illum?.rounds ?? (mission.duration === 'long' ? 8 : 4)) +
          (opts.setup?.support?.illum ?? 0),
      },
    },

    commandPost: mission.commandPost,

    // 時刻順に並べ直す（シナリオ側の記述順に依存しないように）
    // 戦役から来た支度をそのまま渡す。
    //
    // ここで setup を落としていたので、戦線を展開表へ届ける手が
    // 「模組の外に取り置く」しか無くなっていた ─ 取り置きは、
    // 使い残しが次の単発戦闘に混ざれば盤が変わる類の仕掛けである。
    events: timeline(planRng, { variable: !!opts.variable, mission, setup: opts.setup })
      .sort((a, b) => a.at - b.at),
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
      // 装甲戦闘の戦果。どの面から抜いたかを面ごとに数える。
      armor: { kills: { front: 0, side: 0, rear: 0 }, mobility: 0, bounces: 0 },
    },
  };

  world.enemyCommand = createEnemyCommand(world);
  world.trains = createTrains(mission);
  // 演習モード。制約を外した盤 ─ 弾は減らず、部隊は呼べば来る。
  world.creative = createCreative(opts.creative ?? {});

  for (const def of friendlyOrderOfBattle(mission)) {
    addUnit(world, def);
  }

  // 夜のうちに斥候を出していれば、夜明けに一報が入っている。
  if (world.setup?.recon) nightReconReport(world);

  return world;
}

/**
 * 夜間偵察の成果。
 *
 * 斥候が見てきたのは「どちらに何が集まっているか」だけである。
 * 敵がそれを夜明け後に振り替えることまでは分からない ―
 * 夜の報告が翌昼まで正しい保証は、どこにも無い。
 */
function nightReconReport(world) {
  // 渡河点は二つとは限らない。
  //
  // 中央と側面の二分割で数えていたので、三本目の橋に集まっている敵は
  // どちらかに吸収されて消えていた ─ 斥候は見てきたのに、
  // 報告する言葉が「主正面か側面か」しか無かった、ということである。
  const crossings = world.terrain.crossings ?? [];
  const tally = new Map(crossings.map((c) => [c.id ?? c.label, 0]));
  let armor = 0;
  let total = 0;

  for (const ev of world.events) {
    if (ev.kind !== 'spawn' || !ev.units) continue;
    // 夜が明ける前に出てくるぶんだけが、斥候の目に入る。
    if (ev.at > world.now + 5400) continue;
    for (const u of ev.units) {
      if (u.side !== 'enemy') continue;
      const x = u.ai?.crossing?.x ?? u.x;
      const y = u.ai?.crossing?.y ?? u.y;
      let near = null;
      let bestD = Infinity;
      for (const c of crossings) {
        const d = Math.hypot(c.x - x, c.y - y);
        if (d < bestD) { bestD = d; near = c; }
      }
      if (near) {
        const k = near.id ?? near.label;
        tally.set(k, (tally.get(k) ?? 0) + 1);
        total++;
      }
      if (u.type === 'tank' || u.type === 'mech') armor++;
    }
  }

  let top = null;
  let topN = -1;
  for (const c of crossings) {
    const n = tally.get(c.id ?? c.label) ?? 0;
    if (n > topN) { topN = n; top = c; }
  }
  const heavier = top?.label ?? '主正面';
  const ratio = topN / Math.max(1, total);
  const firmness = ratio > 0.68 ? '間違いない' : ratio > 0.55 ? 'そう見える' : '半々だ、断定はできない';

  world.radio.log.push({
    id: 'RECON0',
    at: world.now,
    from: '夜間斥候',
    fromId: null,
    kind: 'hq',
    priority: PRI.PRIORITY,
    text:
      `夜間偵察の報告。敵の集結は${heavier}に厚い ─ ${firmness}。` +
      (armor > 0 ? `履帯の音を${armor}両ぶん数えた。` : '車輌の音は聞かなかった。') +
      '夜のうちの話である。明るくなってから振り替えられれば、この報告は外れる。',
    garbled: false,
    lost: false,
    meta: { observedAt: world.now },
    composedAt: world.now,
    observedAt: world.now,
  });
}

/**
 * H時。計画を畳んで時計を回し始める。
 * これ以後、指揮官と部下を繋ぐのは無線だけになる。
 */
export function endPlanning(world) {
  if (!world.planning) return false;
  world.planning = false;
  world.planEndedAt = world.now;
  return true;
}

export function addUnit(world, def) {
  const u = createUnit(def);
  // 岩や水の上には置かない。置いてしまうと、その部隊はそこから動けない。
  if (!u.tpl.flying) {
    const p = nearestPassable(world.terrain, u.x, u.y, 1200, !!u.tpl.vehicle);
    u.x = p.x;
    u.y = p.y;
  }
  u.role = def.role;
  u.ai = def.ai ? structuredCloneSafe(def.ai) : null;
  // 戦役では、昨日の続きから始まる。人も弾も士気も、昨日のままである。
  if (u.side === 'friend') applyCarry(world, u);
  // 演習では味方は倒れない。ここで一括して掛けておく ―
  // 途中で湧く増援にも同じ扱いが要るからである。
  if (world.creative?.invulnerable && u.side === 'friend') u.invulnerable = true;
  world.units.push(u);
  world.unitsById.set(u.id, u);
  return u;
}

/**
 * 演習の増援。0コスト・即時・地図上の任意の点に。
 * @returns {object|null} 生成された部隊
 */
export function spawnReinforcement(world, opts) {
  const def = reinforcementDef(world, opts);
  if (!def) return null;
  const u = addUnit(world, def);
  if (u.side === 'friend') {
    world.radio.log.push({
      id: `CRE${world.radio.log.length}`,
      at: world.now,
      from: '演習統裁',
      kind: 'system',
      priority: PRI.PRIORITY,
      text: `${u.callsign}（${u.tpl.label}）が ${toGrid(u.x, u.y)} に到着。指揮下に入った。`,
      garbled: false,
      lost: false,
      meta: { unitId: u.id, grid: toGrid(u.x, u.y) },
      observedAt: world.now,
    });
  }
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

  // このティックで通信記録簿に増えたぶんを、まとめて返す。
  // 「無線で届いたもの」だけを返していたので、指揮所が自分で書いた覚書
  //（弾が無い・射程外・作戦命令の下達）は、どこにも出ないまま消えていた。
  const logMark = world.radio.log.length;

  world.now += dt;
  world.tickCount++;

  fireTimelineEvents(world);

  // 敵の指揮官が決心し、そのあとで各部隊が動く
  stepEnemyCommand(world, dt);
  stepEnemyRecovery(world, dt);
  stepAI(world, dt);
  stepFriendlyInitiative(world, dt);

  for (const u of world.units) stepMovement(u, world.terrain, dt);
  stepObstacles(world, dt);

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

  return world.radio.log.slice(logMark);
}

/**
 * H時前の一手。時計は動かさずに、命令のやり取りだけを進める。
 * @returns {Array} 記録簿に増えたぶん
 */
export function planningTick(world) {
  const logMark = world.radio.log.length;
  stepOrders(world, 0);
  return world.radio.log.slice(logMark);
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
/* 障害                                                                */
/* ------------------------------------------------------------------ */

/**
 * 地雷原。
 *
 * 踏むのは動いているときだけである。伏せている部隊は踏まない ―
 * だから地雷原の本当の効果は、そこで部隊を止めることであり、
 * 止まったところに砲を落とすのが、障害と火力の組み合わせというものである。
 */
function stepObstacles(world, dt) {
  for (const u of world.units) {
    if (!u.alive || u.tpl.flying) continue;
    const o = obstacleAt(world.terrain, u.x, u.y);
    if (!o) continue;

    // 敵が敷いた障害は、当たって初めて分かる。当たった部隊がそう言ってくる。
    if (!o.known && u.side === 'friend' && u.commsOk && u.tpl.radio > 0 && !u._sawObstacle?.[o.id]) {
      (u._sawObstacle ??= {})[o.id] = true;
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'contact',
        text:
          `こちら${u.callsign}、${toGrid(u.x, u.y)}に障害 ─ ${o.label}だ。` +
          `敵が敷いている。まともに進めない、迂回するか処理する必要がある。`,
        priority: PRI.FLASH,
        meta: {
          unitId: u.id,
          grid: toGrid(u.x, u.y),
          reportedX: o.x,
          reportedY: o.y,
          classified: 'obstacle',
          quality: 0.85,
          observedAt: world.now,
        },
        composedAt: world.now,
        duration: 5,
      });
    }

    if (o.kind !== 'mines' || !u.path.length) continue;

    // 数分踏み進めば、どこかで1発を踏む勘定。
    // 地雷原は壁ではない ─ 壁にしてしまうと、そこで戦闘が終わってしまう。
    if (!world.rng.chance(0.005 * dt)) continue;
    const lost = applyDamage(u, u.maxStrength * (u.tpl.armor > 0.3 ? 0.3 : 0.09), world.now, {});
    applySuppression(u, 45);
    u.path = [];
    u.dest = null;
    u._shelledAt = world.now;
    if (u.tpl.armor > 0.3 && world.rng.chance(0.25)) u._immobile = true;

    if (u.side === 'friend' && u.commsOk && u.tpl.radio > 0 && lost > 0) {
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'contact',
        text:
          `こちら${u.callsign}、地雷だ！${toGrid(u.x, u.y)}、地雷原に入った。` +
          `これ以上は進めない、負傷者が出ている！`,
        priority: PRI.FLASH,
        meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: world.now },
        composedAt: world.now,
        duration: 5,
      });
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
    // 弾着を見て修正を返せる部隊。
    // 観測班が付いていれば、その分隊が優先される ─ 砲兵の目とはそういう役である。
    const eyes = world.units.filter(
      (w) =>
        w.alive &&
        w.side === 'friend' &&
        w.commsOk &&
        w.tpl.radio > 0 &&
        dist(w.x, w.y, fm.x, fm.y) < w.tpl.spot * (w.mods?.spot ?? 1) * 1.3
    );
    const observer = eyes.find(isObserver) ?? eyes[0];
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
