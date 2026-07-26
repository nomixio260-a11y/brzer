// 敵の指揮官。
//
// これまでの敵は台本どおりに動くだけだった。実際の敵には意図があり、
// 予備があり、こちらの守り方を見て使いどころを変えてくる。
// この層が「今どちらの軸が通っているか」を評価し、予備を投じ、
// 火力を要請する。プレイヤーの配置が、そのまま敵の判断材料になる。

import { clamp, dist, toGrid } from '../util.js';
import { riverCenterY } from './terrain.js';
import { createFireMission } from './combat.js';
import { setDestination } from './units.js';

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
    log: [],
  };
}

/** どちらの軸に属する部隊か（担当を x 座標で分ける） */
function axisOf(u) {
  return u.x > 3400 || u.ai?.task === 'flank' ? 'ford' : 'bridge';
}

export function stepEnemyCommand(world, dt) {
  const ec = world.enemyCommand;
  if (!ec) return;

  requestEnemySmoke(world, ec);

  if (world.now < ec.nextAssessAt) return;
  ec.nextAssessAt = world.now + ASSESS_INTERVAL;

  assessAxes(world, ec);
  commitReserve(world, ec);
  redirectStragglers(world, ec);
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
        axisOf(u) === key
    );

    // 「どちらが通っているか」は、目標にどれだけ近づけたかで測る。
    // 距離を稼いだかではない ― 遠回りに走っている軸は成功していない。
    const obj = ec.objective;
    let best = -Infinity;
    let nearest = Infinity;
    let losses = 0;
    for (const u of units) {
      best = Math.max(best, u.y - riverCenterY(u.x));
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
  const developing = bridge.gain > 150 || ford.gain > 150 || bridge.progress > -120 || ford.progress > -120;
  const lastCall = world.now >= world.mission.startTime + 4800;
  if (world.now < world.mission.startTime + 3300) return;
  if (!developing && !lastCall) return;

  // 通っている方に足す。損害の大きい軸は、進んでいても割り引いて見る。
  const weigh = (a) => (a.threat ?? Infinity) + a.losses * 90;
  let target;
  if (bridge.stalledFor >= 200 && ford.stalledFor < 200) target = 'ford';
  else if (ford.stalledFor >= 200 && bridge.stalledFor < 200) target = 'bridge';
  else target = weigh(bridge) <= weigh(ford) ? 'bridge' : 'ford';

  ec.reserveCommitted = true;
  ec.committedAxis = target;

  const crossing =
    target === 'ford'
      ? { x: 4180, y: riverCenterY(4180) }
      : { x: 2200, y: riverCenterY(2200) };
  const objective =
    target === 'ford' ? { x: 2600, y: 2250 } : { x: 2200, y: 2120 };

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
      axisOf(u) === stalled &&
      u.ai?.task !== 'pressure' && // 陽動はその場に留めておく
      !u._redirected
  );
  if (movable.length < 2) return;

  // 半分だけ回す
  const shift = movable.slice(0, Math.max(1, Math.floor(movable.length / 2)));
  const crossing =
    other === 'ford' ? { x: 4180, y: riverCenterY(4180) } : { x: 2200, y: riverCenterY(2200) };

  for (const u of shift) {
    u._redirected = true;
    u.ai = {
      task: other === 'ford' ? 'flank' : 'assault',
      crossing,
      objective: other === 'ford' ? { x: 2600, y: 2250 } : { x: 2200, y: 2120 },
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
      Math.abs(u.y - riverCenterY(u.x)) < 260
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
