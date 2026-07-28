// 敵の指揮官。
//
// これまでの敵は台本どおりに動くだけだった。実際の敵には意図があり、
// 予備があり、こちらの守り方を見て使いどころを変えてくる。
// この層が「今どの軸が通っているか」を評価し、予備を投じ、
// 火力を要請する。プレイヤーの配置が、そのまま敵の判断材料になる。
//
// 攻めているときだけが指揮ではない。守勢に回った敵も、
// 圧されている地点へ予備を出し、取られた地点は取り返そうとする（下の「守勢」）。
//
// 一線がある。この層が読んでよいのは、自分の部隊の状態と、
// 自分の部隊が見た敵（world.enemyIntel）だけである。盤の真実を覗けば、
// そこにいるのは指揮官ではなく神であり、遊び手には勝ち目が無くなる。

import { clamp, dist, toGrid } from '../util.js';

import { createFireMission } from './combat.js';
import { setDestination } from './units.js';
import { enemyGoal } from './ai.js';

const ASSESS_INTERVAL = 100; // 秒。指揮官はそう頻繁には決心を変えない。

export function createEnemyCommand(world) {
  // 軸は図幅の通過点から、あるだけ採る。
  //
  // 二本しか見ていなかった。ザーレン市街には橋が三本あるのに、
  // 三本目 ── 鉄道橋 ── は敵の判断に一度も入らなかった。
  // 指揮官が見ていない線から入られれば、その指揮官はそこに何もできない。
  // 「敵にも指揮官がいる」と言えるかどうかは、ここで決まる。
  const axes = {};
  for (const cr of world.terrain.crossings) {
    axes[cr.id] = {
      id: cr.id,
      label: cr.label ?? cr.id,
      x: cr.x,
      y: cr.y,
      base: null, progress: 0, losses: 0, stalledFor: 0,
    };
  }

  return {
    nextAssessAt: world.mission.startTime + 300,
    reserveCommitted: false,
    committedAxis: null,
    // 敵の最終目標。橋の南詰 ― ここを取れば敵の勝ちである。
    objective: { x: world.terrain.bridge.x, y: world.terrain.bridge.y + 380 },
    // 各軸の評価。progress は南へどれだけ食い込んだか。
    axes,
    // 守勢に回ったときの手札。攻めるときとは使うものが違う。
    defense: {
      active: false,
      reserveId: null,
      committedTo: null,
      counterattacks: 0,
      anchors: [],
    },
    smokeUsed: 0,
    // 波状攻撃の管理（長期戦のみ）。攻撃は永久には続かない ─
    // 一定の損害を出すか、進まなくなれば、敵は退がって編成を立て直す。
    waves: new Map(),
    currentWave: 0,
    log: [],
  };
}

/** 評価している軸を並び順のまま取り出す */
function axisList(ec) {
  return Object.values(ec.axes);
}

/**
 * その部隊がどの軸に属するか ── いちばん近い通過点で決める。
 *
 * 二本の中点で東西に切っていたので、通過点が三本ある図幅では
 * 真ん中の一本が必ずどちらかに吸収され、そこへの圧力が数えられなかった。
 * 「迂回する部隊は副通過点」という決め打ちも同じ理由で捨てる ―
 * 割り当てた通過点が分かっているなら、それがその部隊の軸である。
 */
function axisOf(world, u) {
  const x = u.ai?.crossing?.x ?? u.x;
  let bestId = null;
  let bestD = Infinity;
  for (const cr of world.terrain.crossings) {
    const d = Math.abs(x - cr.x);
    if (d < bestD) {
      bestD = d;
      bestId = cr.id;
    }
  }
  return bestId;
}

/** 主軸（図幅がいちばん先に挙げた通過点）の名 */
function primaryAxis(world) {
  return world.terrain.crossings[0]?.id ?? null;
}

/** 軸に対応する通過点 */
function crossingPoint(world, axis) {
  const cr = world.terrain.crossings.find((c) => c.id === axis) ?? world.terrain.crossings[0];
  return { x: cr.x, y: cr.y };
}

/** 主攻の最終目標 */
function mainObjective(world) {
  return enemyGoal(world, null);
}

/**
 * その軸から入る部隊の最終目標。
 * 主軸ならそのまま、脇の軸なら主目標の同じ側から寄せる ―
 * 全部を一点に集めると縦隊が潰れ、迂回した意味が消える。
 */
function axisObjective(world, axis) {
  const g = enemyGoal(world, null);
  if (axis === primaryAxis(world)) return g;
  const cr = crossingPoint(world, axis);
  const side = Math.sign(cr.x - (world.terrain.crossings[0]?.x ?? cr.x)) || 1;
  return { x: g.x + 380 * side, y: g.y - 120 };
}

/** その軸へ向かう部隊の任務。主軸は正面、脇の軸は迂回である */
function axisTask(world, axis) {
  return axis === primaryAxis(world) ? 'assault' : 'flank';
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
  stepDefense(world, ec);
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

    // 立て直した部隊は、もといた軸へ戻す。
    // 「東にいれば迂回」と座標で決めていたので、通過点が三本ある図幅では
    // 真ん中の軸から下がった部隊が、勝手に端の軸へ移っていた。
    const axis = axisOf(world, u);
    u.ai = {
      wave: newWave,
      task: axisTask(world, axis),
      crossing: crossingPoint(world, axis),
      objective: axisObjective(world, axis),
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
        u.ai?.task !== 'hold_ground' && // 陣地を守る部隊は「通っているか」を測る材料にならない
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
  // 守勢の予備は、渡河点ではなく圧された地点へ出す。使い方が違うので下で扱う。
  if (ec.defense.active) return;
  const reserve = world.units.filter((u) => u.side === 'enemy' && u.alive && u.ai?.task === 'reserve');
  if (!reserve.length) return;

  const list = axisList(ec);
  if (!list.length) return;

  // 決心には材料が要る。どれかが渡河にかかるまでは待つ ―
  // ただし待ちすぎれば勝機を逃すので、0830 には賭ける。
  const long = world.mission.duration === 'long';
  const developing = list.some((a) => a.gain > 150 || a.progress > -120);
  const lastCall = world.now >= world.mission.startTime + (long ? 21600 : 4800);
  // 長期戦の予備は最後の攻撃と一緒に出る。決勝の一撃に取っておくのが予備である。
  if (world.now < world.mission.startTime + (long ? 19800 : 3300)) return;
  if (!developing && !lastCall) return;

  // 通っている方に足す。損害の大きい軸は、進んでいても割り引いて見る。
  const weigh = (a) => (a.threat ?? Infinity) + a.losses * 90;
  // 止まっていない軸があるなら、そちらから選ぶ ─ 予備を停滞に注ぎ込むのは
  // いちばん高くつく増援の使い方である。全部止まっていれば、賭けるしかない。
  const moving = list.filter((a) => a.stalledFor < 200);
  const pool = moving.length ? moving : list;
  const target = pool.reduce((best, a) => (weigh(a) < weigh(best) ? a : best)).id;

  ec.reserveCommitted = true;
  ec.committedAxis = target;

  const crossing = crossingPoint(world, target);
  const objective = axisObjective(world, target);
  const task = axisTask(world, target);

  for (const u of reserve) {
    u.ai = { task, crossing, objective };
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
  const list = axisList(ec);
  if (list.length < 2) return;

  // いちばん止まっている軸から、いちばん動いている軸へ。
  const stalled = list.reduce((best, a) => (a.stalledFor > best.stalledFor ? a : best));
  if (stalled.stalledFor < 400) return;
  const other = list
    .filter((a) => a !== stalled)
    .reduce((best, a) => (a.stalledFor < best.stalledFor ? a : best));
  if (other.stalledFor >= 400) return; // どこも止まっているなら動かさない

  const movable = world.units.filter(
    (u) =>
      u.side === 'enemy' &&
      u.alive &&
      !u.tpl.indirect &&
      axisOf(world, u) === stalled.id &&
      u.ai?.task !== 'pressure' && // 陽動はその場に留めておく
      // 陣地を守っている部隊を軸の都合で引き抜けば、守るべき場所が空く。
      // 転用は攻めている部隊の話であって、守っている部隊の話ではない。
      u.ai?.task !== 'hold_ground' &&
      // 予備は「手が足りないから」で使うものではない。
      // 転用の対象に混ぜていたせいで、決心して投入する前に消えていた。
      u.ai?.task !== 'reserve' &&
      !u._redirected
  );
  if (movable.length < 2) return;

  // 半分だけ回す
  const shift = movable.slice(0, Math.max(1, Math.floor(movable.length / 2)));
  const crossing = crossingPoint(world, other.id);
  const task = axisTask(world, other.id);
  const objective = axisObjective(world, other.id);

  for (const u of shift) {
    u._redirected = true;
    u.ai = { task, crossing, objective };
    u._goalKey = null;
  }

  ec.log.push({
    at: world.now,
    text: `${stalled.label}が停滞。${shift.length}個部隊を${other.label}へ転用`,
  });
}

/* ------------------------------------------------------------------ */
/* 守勢 ─ 攻められている側の指揮官                                        */
/* ------------------------------------------------------------------ */

/**
 * 逆襲の図幅では、敵は全部隊が陣地に籠るだけだった。
 * 予備も無く、指揮官の出番が一度も来ない ―― つまり攻める側から見れば、
 * それは「指揮官のいない敵」である。押していけば、押した分だけ進む。
 *
 * 守勢の指揮官がやることは三つしかない。
 * 予備を手元に残すこと、いちばん圧されている地点へそれを出すこと、
 * 取られた地点を取り返すこと。三つとも代償を伴う ―
 * 予備に回した一個は線に立っておらず、逆襲に出した一個は掩体の外にいる。
 *
 * 材料は自分の部隊の状態と、自分の部隊が見た敵（world.enemyIntel）だけである。
 * だから煙で視界を切られていれば、敵の指揮官も「どこが圧されているか」を
 * 取り違える ─ 攻める側が煙を焚く理由が、ここにもう一つ増える。
 */
function stepDefense(world, ec) {
  const d = ec.defense;
  const holders = world.units.filter(
    (u) => u.side === 'enemy' && u.alive && !u.tpl.indirect && u.ai?.task === 'hold_ground'
  );
  if (holders.length) d.active = true;
  if (!d.active) return;

  registerAnchors(world, ec, holders);
  readAxisPressure(world, ec);
  designateReserve(world, ec, holders);
  commitLocalReserve(world, ec);
  counterattack(world, ec);
}

/**
 * 守る地点の登録。
 *
 * 実際に誰かが就いた地点だけを数える ─ 増援に割り当てただけで
 * まだ誰も着いていない地点を「失った」と勘違いすると、
 * 出てくるはずの部隊が着く前に逆襲を命じることになる。
 */
function registerAnchors(world, ec, holders) {
  const d = ec.defense;
  // 誰がどこを持っているか。持ち主が入れ替わることもある（逆襲で取り返した後など）。
  for (const s of d.anchors) s.holderId = null;
  for (const u of holders) {
    const a = u.ai.anchor;
    if (!a) continue;
    const known = d.anchors.find((s) => Math.abs(s.x - a.x) < 60 && Math.abs(s.y - a.y) < 60);
    if (known) {
      known.holderId = u.id;
      continue;
    }
    if (dist(u.x, u.y, a.x, a.y) > 220) continue;
    d.anchors.push({
      x: a.x, y: a.y, grid: toGrid(a.x, a.y),
      holderId: u.id, lostSince: null, retakenAt: null,
    });
  }
}

/**
 * その地点をまだ保っているか。
 *
 * 「持ち場を割り当てられた部隊が生きているか」で見る ─ 砲撃で散った部隊は
 * 戻ってくるので、散っている数十秒を「失った」と読んではいけない。
 * 持ち主が消えていても、隣の部隊が寄っていれば穴は塞がっている。
 */
function anchorHeld(world, a) {
  const h = world.unitsById.get(a.holderId);
  // 押し出されて400mも離れた部隊は、もうそこを保ってはいない。
  if (h && h.alive && h.state !== 'broken' && dist(h.x, h.y, a.x, a.y) < 420) return true;
  return world.units.some(
    (u) =>
      u.side === 'enemy' && u.alive && !u.tpl.indirect && u.state !== 'broken' &&
      dist(u.x, u.y, a.x, a.y) < 190
  );
}

/**
 * その地点がどれだけ圧されているか。
 *
 * 数えるのは二つだけ ── 部下が「見た」と言ってきた敵と、
 * 自分の部隊が受けている損害である。どちらも指揮官の手元に届く数字であり、
 * 盤の上の真実ではない。見えていない敵は、この計算に入らない。
 */
function pressureAt(world, p, radius = 900) {
  let s = 0;
  for (const v of world.enemyIntel.values()) {
    const age = world.now - v.at;
    if (age > 240) continue;
    const dd = dist(p.x, p.y, v.x, v.y);
    if (dd > radius) continue;
    // 近いほど、新しいほど重い。古い接触は「まだそこにいる」保証がない。
    s += (1 - dd / radius) * (1 - age / 240);
  }
  for (const u of world.units) {
    if (u.side !== 'enemy' || !u.alive || u.tpl.indirect) continue;
    if (dist(u.x, u.y, p.x, p.y) > 320) continue;
    s += (1 - u.strength / u.maxStrength) * 1.6 + (u.suppression / 100) * 0.7;
    if (world.now - u.lastHitAt < 120) s += 0.5;
  }
  return s;
}

/**
 * どの通過点から入られているか。
 *
 * 守る側にとっての軸は「どこから来るか」である。三本目の橋を数えていなければ、
 * そこから入られても敵は最後まで気づかない。気づいたことは講評に出す ―
 * 貴官がどの橋を選んだかは、敵にも見えていたということである。
 */
function readAxisPressure(world, ec) {
  const list = axisList(ec);
  if (!list.length) return;
  for (const a of list) a.pressure = pressureAt(world, { x: a.x, y: a.y }, 1100);

  const top = list.reduce((best, a) => (a.pressure > best.pressure ? a : best));
  if (top.pressure < 0.6) return;
  if (ec.defense.readAxis === top.id) return;
  ec.defense.readAxis = top.id;
  ec.log.push({ at: world.now, text: `敵の主力は${top.label}から入ってくると読んだ` });
}

/**
 * 予備の指定。
 *
 * 全部を線に並べれば、その線は厚くなる。厚くなるが、崩れた時に打つ手が無い。
 * いちばん後ろの一個を手元に残すのは、そこを薄くすることと引き換えである ―
 * 予備を持たない防御は、一点抜かれた時点で終わる。
 */
function designateReserve(world, ec, holders) {
  const d = ec.defense;
  if (d.reserveId) return;
  // 一個しか線に立っていない防御に、抜いてよい部隊は無い。
  if (holders.length < 3) return;

  // 敵は南から来る。いちばん北（後方）に就いている部隊を手元に残す。
  const pick = holders.reduce((best, u) => (u.y < best.y ? u : best));
  d.reserveId = pick.id;
  pick.ai = { ...pick.ai, held: true };
  ec.log.push({ at: world.now, text: `${toGrid(pick.x, pick.y)}の一個部隊を予備として手元に残す` });
}

/**
 * 予備の投入。
 * いちばん圧されている地点へ寄せる。攻める側と理屈は同じで、向きが逆なだけである。
 */
function commitLocalReserve(world, ec) {
  const d = ec.defense;
  if (d.committedTo) return;
  const u = world.unitsById.get(d.reserveId);
  if (!u || !u.alive || u.state === 'broken') return;
  if (!d.anchors.length) return;

  // 「敵が見えた」だけでは出さない。撃ち合いが始まってからである ―
  // 見えた時点で出せば、それは陽動に釣られたということでしかない。
  const engaged = world.units.some(
    (u) =>
      u.side === 'enemy' && u.alive && !u.tpl.indirect &&
      (world.now - u.lastHitAt < 240 || u.suppression > 30 || u.strength < u.maxStrength)
  );
  if (!engaged) return;

  const ranked = d.anchors
    .map((a) => ({ a, value: pressureAt(world, a) }))
    .sort((p, q) => q.value - p.value);
  const top = ranked[0];
  // 材料が薄いうちは動かさない。予備は一度出せば戻らないので、
  // 「なんとなく」で出したぶんだけ、本当に要る場面で手札が無くなる。
  if (top.value < 1.6) return;
  if (dist(u.x, u.y, top.a.x, top.a.y) < 300) return; // すでにそこにいる

  d.committedTo = top.a.grid;
  // 同じ穴に重ねては置かない。圧されている地点の、自分の側に就く。
  const dx = u.x - top.a.x;
  const dy = u.y - top.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const anchor = { x: top.a.x + (dx / len) * 140, y: top.a.y + (dy / len) * 140 };

  u.ai = { ...u.ai, task: 'hold_ground', anchor, held: false, committed: true };
  u._goalKey = null;
  setDestination(u, world.terrain, anchor.x, anchor.y);
  ec.log.push({ at: world.now, text: `${top.a.grid}が圧されている。予備をそこへ寄せる` });
}

/**
 * 逆襲。
 *
 * 取られた地点をそのままにしておく守将はいない。掘ってある陣地を出て、
 * 開豁地を横切って戻ることになるので、これは高くつく手である ―
 * だから二回までしかやらない。三度目を出せば、線には誰もいなくなる。
 */
function counterattack(world, ec) {
  const d = ec.defense;
  if (d.counterattacks >= 2) return;
  // 立て続けには出せない。出せば持ち場の玉突きが始まり、
  // 取り返しに行った先が空くだけで終わる。
  if (world.now - (d.lastCounterAt ?? -Infinity) < 400) return;

  for (const a of d.anchors) {
    if (anchorHeld(world, a)) {
      a.lostSince = null;
      continue;
    }
    a.lostSince ??= world.now;
    // 取られた直後に飛び込んでも、勢いの付いた敵に食われるだけである。
    // 一度は落ち着かせ、相手の足が止まってから出す。
    if (world.now - a.lostSince < 200) continue;
    if (a.retakenAt) continue;

    const u = pickCounterattacker(world, ec, a);
    if (!u) continue;

    d.counterattacks++;
    d.lastCounterAt = world.now;
    a.retakenAt = world.now;
    a.lostSince = null;
    a.holderId = u.id;
    const fromRes = u.id === d.reserveId && !d.committedTo;
    if (fromRes) d.committedTo = a.grid;

    u.ai = { ...u.ai, task: 'hold_ground', anchor: { x: a.x, y: a.y }, held: false, counterattack: true };
    u._goalKey = null;
    setDestination(u, world.terrain, a.x, a.y);
    ec.log.push({
      at: world.now,
      text:
        `${a.grid}を失った。` +
        (fromRes ? '予備を出して取り返す' : '線から一個部隊を抜いて取り返す ─ 抜いたぶん、そこは空く'),
    });
    return; // 一度に一箇所だけ。二箇所を同時に取り返せる守備隊はいない。
  }
}

/** 逆襲に出せる部隊。まず予備、無ければ線から一個 ─ 抜けばそこが空く */
function pickCounterattacker(world, ec, a) {
  const d = ec.defense;
  const fit = (u) =>
    u &&
    u.alive &&
    u.state !== 'broken' &&
    u.strength > u.maxStrength * 0.5 &&
    u.morale > 45 &&
    u.suppression < 60;

  if (!d.committedTo) {
    const res = world.unitsById.get(d.reserveId);
    if (fit(res)) return res;
  }

  const line = world.units.filter(
    (u) => u.side === 'enemy' && u.alive && !u.tpl.indirect && u.ai?.task === 'hold_ground'
  );
  // 残り二個から一個を抜けば、防御そのものが成り立たなくなる。
  if (line.length < 3) return null;

  let best = null;
  let bestD = Infinity;
  for (const u of line) {
    if (!fit(u) || u.ai?.counterattack) continue;
    const dd = dist(u.x, u.y, a.x, a.y);
    if (dd < bestD) {
      bestD = dd;
      best = u;
    }
  }
  return best;
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
