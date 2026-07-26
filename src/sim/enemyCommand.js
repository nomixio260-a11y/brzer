// 敵の指揮官。
//
// これまでの敵は台本どおりに動くだけだった。実際の敵には意図があり、
// 予備があり、こちらの守り方を見て使いどころを変えてくる。
// この層が「今どちらの軸が通っているか」を評価し、予備を投じ、
// 火力を要請する。プレイヤーの配置が、そのまま敵の判断材料になる。

import { clamp, dist, toGrid } from '../util.js';

import { createFireMission } from './combat.js';
import { setDestination } from './units.js';
import { enemyGoal } from './ai.js';

const ASSESS_INTERVAL = 100; // 秒。指揮官はそう頻繁には決心を変えない。

export function createEnemyCommand(world) {
  return {
    nextAssessAt: world.mission.startTime + 300,
    reserveCommitted: false,
    committedAxis: null,
    // 敵の最終目標。橋の南詰 ― ここを取れば敵の勝ちである。
    objective: { x: world.terrain.bridge.x, y: world.terrain.bridge.y + 380 },
    // 各軸の評価。progress は南へどれだけ食い込んだか。
    axes: {
      bridge: { label: '橋正面', x: 2200, base: null, progress: 0, losses: 0, stalledFor: 0 },
      ford: { label: '東の浅瀬', x: 4180, base: null, progress: 0, losses: 0, stalledFor: 0 },
    },
    smokeUsed: 0,
    // 波状攻撃の管理（長期戦のみ）。攻撃は永久には続かない ─
    // 一定の損害を出すか、進まなくなれば、敵は退がって編成を立て直す。
    waves: new Map(),
    currentWave: 0,
    log: [],
  };
}

/** どちらの軸に属する部隊か（主通過点と副通過点の中間で分ける） */
function axisOf(world, u) {
  if (u.ai?.task === 'flank') return 'ford';
  const a = world.terrain.bridge.x;
  const b = world.terrain.ford.x;
  const mid = (a + b) / 2;
  return b > a ? (u.x > mid ? 'ford' : 'bridge') : (u.x < mid ? 'ford' : 'bridge');
}

/** 軸に対応する通過点 */
function crossingPoint(world, axis) {
  const c = axis === 'ford' ? world.terrain.ford : world.terrain.bridge;
  return { x: c.x, y: c.y };
}

/** 主攻の最終目標 */
function mainObjective(world) {
  return enemyGoal(world, null);
}

/** 迂回部隊の最終目標（主目標の側方から入る） */
function flankObjective(world) {
  const g = enemyGoal(world, null);
  return { x: g.x + 380, y: g.y - 120 };
}

export function stepEnemyCommand(world, dt) {
  const ec = world.enemyCommand;
  if (!ec) return;

  requestEnemySmoke(world, ec);

  if (world.now < ec.nextAssessAt) return;
  ec.nextAssessAt = world.now + ASSESS_INTERVAL;

  stepWaves(world, ec);

  assessAxes(world, ec);
  commitReserve(world, ec);
  redirectStragglers(world, ec);
}

/* ------------------------------------------------------------------ */
/* 波状攻撃                                                             */
/* ------------------------------------------------------------------ */

/** その波の部隊 */
function waveUnits(world, n) {
  return world.units.filter((u) => u.side === 'enemy' && u.alive && u.ai?.wave === n);
}

/**
 * 波の管理。
 *
 * 攻撃は永久には続かない。損害が嵩むか、進まなくなれば、敵は退がる ──
 * 川の北へ下がり、負傷者を後送し、弾を補い、また来る。
 *
 * この「退がる」があって初めて、守る側に静穏が生まれる。
 * 静穏は褒美ではなく、次を凌ぐための持ち時間である。
 */
function stepWaves(world, ec) {
  if (world.mission.duration !== 'long') return;

  // 新しい波が現れたか
  for (const u of world.units) {
    const n = u.ai?.wave;
    if (!n || ec.waves.has(n)) continue;
    ec.waves.set(n, { state: 'attacking', committedAt: world.now, bestProgress: -Infinity, stalledFor: 0 });
    ec.currentWave = Math.max(ec.currentWave, n);
    // 前の波の生き残りを、新しい攻撃に合流させる
    rejoin(world, ec, n);
  }

  for (const [n, wave] of ec.waves) {
    if (wave.state !== 'attacking') continue;
    const units = waveUnits(world, n);
    if (!units.length) {
      wave.state = 'destroyed';
      ec.log.push({ at: world.now, text: `第${n}波は撃退された` });
      continue;
    }

    const strength = units.reduce((s, u) => s + u.strength / u.maxStrength, 0) / units.length;
    let best = -Infinity;
    for (const u of units) best = Math.max(best, u.y - world.terrain.front(u.x));
    wave.stalledFor = best - wave.bestProgress < 60 ? wave.stalledFor + ASSESS_INTERVAL : 0;
    wave.bestProgress = Math.max(wave.bestProgress, best);

    // 攻撃が終わる理由は三つある。
    // 損害に耐えかねたか、進まなくなったか、あるいは単に息が続かなくなったか。
    // 最後のひとつ ── 攻勢終末点 ── がいちばん多い。
    // どんな攻撃も、弾と体力と勢いが尽きればそこで止まる。
    const bled = strength < 0.62;
    const stuck = wave.stalledFor >= 1200 && world.now - wave.committedAt > 1800;
    const culminated = world.now - wave.committedAt > 4800;
    if (!bled && !stuck && !culminated) continue;

    wave.state = 'spent';
    wave.spentAt = world.now;
    for (const u of units) retire(world, u);
    ec.log.push({
      at: world.now,
      text:
        `第${n}波が${bled ? '損害に耐えかね' : stuck ? '進展なく' : '攻勢終末点に達し'}` +
        '攻撃を中止、北岸へ後退',
    });
  }
}

/** 川の北へ退がって編成を立て直す */
function retire(world, u) {
  const rallyY = Math.max(80, world.terrain.front(u.x) - 900);
  u.ai = { ...u.ai, task: 'retire', rally: { x: clamp(u.x + world.rng.range(-200, 200), 200, 4600), y: rallyY } };
  u._goalKey = null;
  u.state = 'withdrawing';
  u.posture = 'rapid';
  setDestination(u, world.terrain, u.ai.rally.x, u.ai.rally.y);
}

/** 下がっていた部隊を、新しい波に合流させる */
function rejoin(world, ec, newWave) {
  for (const u of world.units) {
    if (u.side !== 'enemy' || !u.alive) continue;
    if (u.ai?.task !== 'retire') continue;
    // 立て直せていない部隊は出てこない。
    // 半分を失った小隊が同じ日にもう一度攻めることはない ―
    // 守る側が「削った」ことの意味は、そこに出る。
    if (u.strength < u.maxStrength * 0.65) continue;
    if (u.morale < 55) continue;

    const east = u.x > 3400;
    u.ai = {
      wave: newWave,
      task: east ? 'flank' : 'assault',
      crossing: east ? crossingPoint(world, 'ford') : crossingPoint(world, 'bridge'),
      objective: east ? flankObjective(world) : mainObjective(world),
    };
    u._goalKey = null;
    u.state = 'moving';
  }
}

/** 北岸で立て直している間の回復（弾薬と士気は後方から届く） */
export function stepEnemyRecovery(world, dt) {
  if (world.mission.duration !== 'long') return;
  for (const u of world.units) {
    if (u.side !== 'enemy' || !u.alive || u.ai?.task !== 'retire') continue;
    if (u.path.length) continue;
    if (world.now - u.lastHitAt < 120) continue;
    u.ammo = Math.min(u.tpl.maxAmmo, u.ammo + dt * 0.09);
    u.morale = Math.min(88, u.morale + dt * 0.02);
    u.suppression = Math.max(0, u.suppression - dt * 3);
  }
}

/* ------------------------------------------------------------------ */
/* 評価                                                                */
/* ------------------------------------------------------------------ */

function assessAxes(world, ec) {
  for (const key of Object.keys(ec.axes)) {
    const axis = ec.axes[key];
    const units = world.units.filter(
      (u) =>
        u.side === 'enemy' &&
        u.alive &&
        !u.tpl.indirect &&
        u.ai?.task !== 'reserve' && // 待機中の予備は評価に混ぜない
        axisOf(world, u) === key
    );

    // 「どちらが通っているか」は、目標にどれだけ近づけたかで測る。
    // 距離を稼いだかではない ― 遠回りに走っている軸は成功していない。
    const obj = ec.objective;
    let best = -Infinity;
    let nearest = Infinity;
    let losses = 0;
    for (const u of units) {
      best = Math.max(best, u.y - world.terrain.front(u.x));
      nearest = Math.min(nearest, dist(u.x, u.y, obj.x, obj.y));
      losses += u.losses;
    }
    if (best === -Infinity) best = axis.progress; // その軸に部隊がいない
    if (nearest === Infinity) nearest = axis.threat ?? Infinity;

    const gained = best - axis.progress;
    axis.progress = best;
    axis.base ??= best; // 攻撃開始線
    axis.gain = best - axis.base;
    axis.threat = nearest; // 目標までの距離。小さいほど通っている。
    axis.losses = losses;
    axis.strength = units.length;
    // 100秒で50m も進んでいなければ、その軸は止まっている
    axis.stalledFor = gained < 50 ? axis.stalledFor + ASSESS_INTERVAL : 0;
  }
}

/**
 * 予備の投入。
 * 通っている方に足す ― これが recon-pull の考え方である。
 * どちらも止まっていれば、損害の少ない方に賭ける。
 */
function commitReserve(world, ec) {
  if (ec.reserveCommitted) return;
  const reserve = world.units.filter((u) => u.side === 'enemy' && u.alive && u.ai?.task === 'reserve');
  if (!reserve.length) return;

  const bridge = ec.axes.bridge;
  const ford = ec.axes.ford;

  // 決心には材料が要る。どちらかが渡河にかかるまでは待つ ―
  // ただし待ちすぎれば勝機を逃すので、0830 には賭ける。
  const long = world.mission.duration === 'long';
  const developing = bridge.gain > 150 || ford.gain > 150 || bridge.progress > -120 || ford.progress > -120;
  const lastCall = world.now >= world.mission.startTime + (long ? 21600 : 4800);
  // 長期戦の予備は最後の攻撃と一緒に出る。決勝の一撃に取っておくのが予備である。
  if (world.now < world.mission.startTime + (long ? 19800 : 3300)) return;
  if (!developing && !lastCall) return;

  // 通っている方に足す。損害の大きい軸は、進んでいても割り引いて見る。
  const weigh = (a) => (a.threat ?? Infinity) + a.losses * 90;
  let target;
  if (bridge.stalledFor >= 200 && ford.stalledFor < 200) target = 'ford';
  else if (ford.stalledFor >= 200 && bridge.stalledFor < 200) target = 'bridge';
  else target = weigh(bridge) <= weigh(ford) ? 'bridge' : 'ford';

  ec.reserveCommitted = true;
  ec.committedAxis = target;

  const crossing = crossingPoint(world, target);
  const objective = target === 'ford' ? flankObjective(world) : mainObjective(world);

  for (const u of reserve) {
    u.ai = { task: target === 'ford' ? 'flank' : 'assault', crossing, objective };
    u._goalKey = null;
    setDestination(u, world.terrain, crossing.x, crossing.y);
  }

  ec.log.push({
    at: world.now,
    text: `予備を${ec.axes[target].label}へ投入（${reserve.length}個部隊）`,
  });
}

/**
 * 止まった軸に張り付いたままの部隊を、通っている軸へ回す。
 * 全部は動かさない ― 正面から圧力が消えると、防者が楽になりすぎる。
 */
function redirectStragglers(world, ec) {
  const bridge = ec.axes.bridge;
  const ford = ec.axes.ford;
  if (bridge.stalledFor < 400 && ford.stalledFor < 400) return;

  const stalled = bridge.stalledFor >= ford.stalledFor ? 'bridge' : 'ford';
  const other = stalled === 'bridge' ? 'ford' : 'bridge';
  if (ec.axes[other].stalledFor >= 400) return; // どちらも止まっているなら動かさない

  const movable = world.units.filter(
    (u) =>
      u.side === 'enemy' &&
      u.alive &&
      !u.tpl.indirect &&
      axisOf(world, u) === stalled &&
      u.ai?.task !== 'pressure' && // 陽動はその場に留めておく
      // 予備は「手が足りないから」で使うものではない。
      // 転用の対象に混ぜていたせいで、決心して投入する前に消えていた。
      u.ai?.task !== 'reserve' &&
      !u._redirected
  );
  if (movable.length < 2) return;

  // 半分だけ回す
  const shift = movable.slice(0, Math.max(1, Math.floor(movable.length / 2)));
  const crossing = crossingPoint(world, other);

  for (const u of shift) {
    u._redirected = true;
    u.ai = {
      task: other === 'ford' ? 'flank' : 'assault',
      crossing,
      objective: other === 'ford' ? flankObjective(world) : mainObjective(world),
    };
    u._goalKey = null;
  }

  ec.log.push({
    at: world.now,
    text: `${ec.axes[stalled].label}が停滞。${shift.length}個部隊を${ec.axes[other].label}へ転用`,
  });
}

/* ------------------------------------------------------------------ */
/* 火力                                                                */
/* ------------------------------------------------------------------ */

/**
 * 渡河点が撃たれているとき、敵は煙を焚いて視界を切る。
 * こちらの砲撃が「効きすぎる」のを敵が黙って見ているわけがない。
 */
function requestEnemySmoke(world, ec) {
  if (ec.smokeUsed >= 2) return;
  if (world.now < (ec.nextSmokeAt ?? 0)) return;

  // 渡河中の部隊が制圧されているか
  const crossing = world.units.find(
    (u) =>
      u.side === 'enemy' &&
      u.alive &&
      u.suppression > 55 &&
      Math.abs(u.y - world.terrain.front(u.x)) < 260
  );
  if (!crossing) {
    ec.nextSmokeAt = world.now + 60;
    return;
  }

  ec.smokeUsed++;
  ec.nextSmokeAt = world.now + 420;

  // 自分と観測者の間に幕を張る（渡河点のやや南）
  world.fireMissions.push(
    createFireMission('smoke', crossing.x, crossing.y + 180, world.now, {
      side: 'enemy',
      rounds: 4,
      delay: 40,
      radius: 210,
    })
  );
  ec.log.push({ at: world.now, text: `${toGrid(crossing.x, crossing.y)}に発煙、渡河を掩護` });
}

/** 講評で「敵は何を考えていたか」を見せるための記録 */
export function enemyIntentLog(world) {
  return world.enemyCommand?.log ?? [];
}
