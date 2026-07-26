// 命令の発令・伝達・受領・実行。
// 命令は無線を占有し、遅れて届き、時に拒否される。

import { clamp, toGrid, dist, formatClock } from '../util.js';
import { enqueue, PRI } from './comms.js';
import { setDestination, clearDestination, POSTURES } from './units.js';
import { createFireMission } from './combat.js';
import { composeSitrep, composeAmmoReport } from './reports.js';
import { setRoe, ROE } from './friendlyAI.js';
import { orderResupply } from './logistics.js';

/**
 * 命令。
 * group は命令パネルの分類（機動／火力／交戦規定／情報）。
 * multi:true の命令は経路点を続けて指定できる ― 「どの道を通るか」まで指定できる。
 */
export const VERBS = Object.freeze({
  move: { label: '移動', group: 'maneuver', needsTarget: true, multi: true, phrase: (g) => `${g}へ移動せよ` },
  advance: { label: '前進', group: 'maneuver', needsTarget: true, multi: true, phrase: (g) => `${g}へ前進し、接敵したら交戦せよ` },
  attack: { label: '攻撃', group: 'maneuver', needsTarget: true, multi: true, phrase: (g) => `${g}の敵を攻撃せよ` },
  defend: { label: '防御', group: 'maneuver', needsTarget: true, phrase: (g) => `${g}を確保し、陣地を築いて防御せよ` },
  hold: { label: '待機', group: 'maneuver', needsTarget: false, phrase: () => `現在地を保持し、待機せよ` },
  recon: { label: '偵察', group: 'maneuver', needsTarget: true, multi: true, phrase: (g) => `${g}方向を隠密に偵察せよ` },
  withdraw: { label: '後退', group: 'maneuver', needsTarget: true, multi: true, phrase: (g) => `${g}まで後退せよ` },
  rally: { label: '集結', group: 'maneuver', needsTarget: true, phrase: (g) => `${g}へ集結し、部隊を立て直せ` },

  observe: { label: '監視', group: 'fires', needsTarget: true, phrase: (g) => `${g}方向を監視せよ。姿を晒すな` },
  hold_fire: { label: '射撃統制', group: 'fires', needsTarget: false, phrase: () => `射撃を統制せよ。撃たれるまで撃つな` },
  free_fire: { label: '射撃自由', group: 'fires', needsTarget: false, phrase: () => `射撃自由。目標を発見しだい交戦せよ` },
  fire_mission: { label: '砲撃要請', group: 'fires', needsTarget: true, phrase: (g) => `${g}に対し効力射。射撃用意` },
  smoke: { label: '煙幕要請', group: 'fires', needsTarget: true, phrase: (g) => `${g}に発煙弾。視界を遮れ` },
  register: {
    label: '概定射点',
    group: 'fires',
    needsTarget: true,
    phrase: (g) => `${g}を概定射点として標定せよ。以後この点への射撃を優先する`,
  },

  roe_hold_fast: { label: '死守', group: 'roe', needsTarget: false, roe: 'hold_fast', phrase: () => `死守せよ。一歩も退くな` },
  roe_standard: { label: '陣地防御', group: 'roe', needsTarget: false, roe: 'standard', phrase: () => `陣地を保持せよ。保たぬと判断すれば独断で下がってよい` },
  roe_elastic: { label: '弾力防御', group: 'roe', needsTarget: false, roe: 'elastic', phrase: () => `弾力防御。土地より部隊を惜しめ。圧されたら早めに下がれ` },

  sitrep: { label: '状況報告要求', group: 'intel', needsTarget: false, phrase: () => `状況を報告せよ` },
  ammo_check: { label: '弾薬照会', group: 'intel', needsTarget: false, phrase: () => `弾薬の残量を報告せよ` },

  // 長期戦でだけ意味を持つ。半日守るなら、撃つことより続けることが難しい。
  resupply: {
    label: '補給要請',
    group: 'sustain',
    needsTarget: false,
    longOnly: true,
    phrase: () => `補給を送る。ラーダーがそちらへ向かう。受領準備をせよ`,
  },
  rest: {
    label: '休止',
    group: 'sustain',
    needsTarget: false,
    longOnly: true,
    phrase: () => `交代で休養せよ。次の攻撃までに立て直しておけ`,
  },
  stand_to: {
    label: '警戒配置',
    group: 'sustain',
    needsTarget: false,
    longOnly: true,
    phrase: () => `休養を打ち切り、警戒配置につけ`,
  },
});

export const VERB_GROUPS = Object.freeze({
  maneuver: '機動',
  fires: '火力',
  roe: '交戦規定',
  sustain: '兵站',
  intel: '情報',
});

export const MODIFIERS = Object.freeze({
  normal: '通常',
  rapid: '急速',
  cautious: '慎重',
  stealth: '隠密',
});

/**
 * 発動条件 ── 予令（be-prepared / on-order）。
 *
 * 実際の指揮官は、起きてから命令を出すのでは間に合わないことを知っている。
 * だから「こうなったら、こうせよ」と先に渡しておく。
 * 無線が届かなくなっても、部下は渡された条件で動ける ―
 * それが指揮官の意図を先に配っておくということである。
 */
export const TRIGGERS = Object.freeze({
  now: {
    key: 'now',
    label: '直ちに',
    phrase: () => '',
  },
  on_contact: {
    key: 'on_contact',
    label: '接敵時',
    hint: '敵を視認した時点で発動する',
    phrase: () => '敵を認めしだい、',
    ready: (world, u) => [...u.contacts.values()].some((c) => world.now - c.lastSeenAt < 12),
  },
  on_pressure: {
    key: 'on_pressure',
    label: '被圧時',
    hint: '持ちこたえられなくなった時点で発動する（軽い接触では動かない）',
    phrase: () => '圧されたら、',
    // 「撃たれた」ではなく「保たない」。初弾で動き出しては前進哨所の意味がない。
    ready: (world, u) =>
      (world.now - u.lastHitAt < 20 && u.suppression > 72) ||
      u.strength < u.maxStrength * 0.6 ||
      u.morale < 45,
  },
  at_time: {
    key: 'at_time',
    label: '時刻',
    needsTime: true,
    hint: '指定した時刻に発動する',
    phrase: (o) => `${formatClock(o.triggerAt)}をもって、`,
    ready: (world, u, order) => world.now >= order.triggerAt,
  },
});

let orderSeq = 1;

/**
 * 指揮官が命令を出す。まず無線に乗り、届いてから初めて実行される。
 * @returns {object|null} 発令された命令
 */
export function issueOrder(
  world,
  { unitId, verb, x, y, modifier = 'normal', legs = null, trigger = 'now', triggerAt = null }
) {
  const u = world.unitsById.get(unitId);
  const spec = VERBS[verb];
  if (!u || !spec) return null;

  const trig = TRIGGERS[trigger] ?? TRIGGERS.now;
  // 過ぎた時刻を条件にしても意味がない
  if (trig.needsTime && !(triggerAt > world.now)) trigger = 'now';

  // 砲撃・煙幕は砲兵に対する要請なので、弾数を先に確認する
  if (verb === 'fire_mission' || verb === 'smoke') {
    const pool = verb === 'smoke' ? world.support.smoke : world.support.artillery;
    if (pool.rounds <= 0) {
      pushSystemMessage(world, `${u.callsign}: 弾がない。射撃要請には応じられない。`);
      return null;
    }
  }
  if (verb === 'register' && world.registrations.length >= 3) {
    pushSystemMessage(world, `${u.callsign}: 概定射点はこれ以上抱えられない。どれかを撤する必要がある。`);
    return null;
  }
  if (spec.longOnly && !world.trains) {
    pushSystemMessage(world, 'この戦闘に段列は付いていない。');
    return null;
  }
  if (verb === 'resupply') {
    // 運べる弾がなければ、要請そのものが通らない
    if (world.trains.loadsLeft <= 0) {
      pushSystemMessage(world, 'ラーダー: 集積所は空だ。もう運べるものがない。');
      return null;
    }
    if (world.trains.task) {
      const busy = world.unitsById.get(world.trains.task.targetId);
      pushSystemMessage(world, `ラーダー: 今は${busy?.callsign ?? '別の部隊'}へ向かっている。順番を待て。`);
      return null;
    }
  }

  // 経路点。最後の点が最終目標になる。
  const path = spec.multi && legs?.length ? legs.slice(0, 5) : null;
  if (path) {
    x = path[path.length - 1].x;
    y = path[path.length - 1].y;
  }

  const grid = spec.needsTarget ? toGrid(x, y) : toGrid(u.x, u.y);

  const order = {
    id: `O${orderSeq++}`,
    unitId,
    verb,
    x: spec.needsTarget ? x : u.x,
    y: spec.needsTarget ? y : u.y,
    legs: path,
    grid,
    modifier,
    trigger,
    triggerAt,
    issuedAt: world.now,
    state: 'transmitting',
    receivedAt: null,
    ackAt: null,
    completedAt: null,
  };

  world.orders.push(order);
  u.pendingOrder = order;

  const modPhrase = modifier === 'normal' ? '' : `${MODIFIERS[modifier]}に。`;
  const via =
    path && path.length > 1
      ? `経路は${path.slice(0, -1).map((p) => toGrid(p.x, p.y)).join('、')}を経由。`
      : '';
  const cond = (TRIGGERS[trigger] ?? TRIGGERS.now).phrase(order);
  const head = trigger === 'now' ? '' : '予令。';
  const text = `${u.callsign}、こちら指揮所。${head}${cond}${spec.phrase(grid)}。${via}${modPhrase}どうぞ`;

  enqueue(world, {
    from: '指揮所',
    fromId: null,
    kind: 'order',
    text,
    priority: PRI.FLASH, // 指揮官の命令は割り込む
    outbound: true,
    meta: { orderId: order.id, toId: unitId, grid },
    composedAt: world.now,
    duration: 4 + text.length * 0.12,
  });

  world.stats.ordersIssued++;
  return order;
}

/** 無線で届いた命令を受領処理する（stepComms が配信したものを渡す） */
export function deliverOrders(world, delivered) {
  for (const entry of delivered) {
    if (entry.kind !== 'order' || !entry.meta?.orderId) continue;
    const order = world.orders.find((o) => o.id === entry.meta.orderId);
    if (!order) continue;
    const u = world.unitsById.get(order.unitId);
    if (!u) continue;

    if (entry.lost || !u.alive) {
      // 届かなかった。指揮官には応答が返らないことだけが分かる。
      order.state = 'undelivered';
      u.pendingOrder = null;
      continue;
    }

    order.receivedAt = world.now;
    order.state = 'received';
    // 受領して応答するまでの間（部隊が状況を見て判断する時間）
    order.ackDueAt = world.now + 3 + (1 - u.skill) * 14 + world.rng.range(0, 8);
  }
}

/** 受領応答と実行開始 */
export function stepOrders(world, dt) {
  const { now, rng } = world;

  for (const order of world.orders) {
    if (order.state !== 'received') continue;
    if (now < order.ackDueAt) continue;

    const u = world.unitsById.get(order.unitId);
    if (!u || !u.alive) {
      order.state = 'void';
      continue;
    }

    // --- 服従判定 -------------------------------------------------
    const refusal = refusalReason(u, order, world);
    if (refusal) {
      order.state = 'refused';
      order.refusedReason = refusal.reason;
      u.pendingOrder = null;
      world.stats.ordersRefused++;
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'refuse',
        text: refusal.text,
        priority: PRI.PRIORITY,
        meta: { unitId: u.id, orderId: order.id, observedAt: now },
        composedAt: now,
        duration: 4,
      });
      continue;
    }

    order.ackAt = now;
    u.pendingOrder = null;
    u.lastOrderAt = now;
    world.stats.responseTimes.push(now - order.issuedAt);

    // --- 予令は懐に入れて待つ -------------------------------------
    if (order.trigger && order.trigger !== 'now') {
      // 同じ部隊に予令は1つ。新しいものが古いものを差し替える。
      if (u.heldOrder && u.heldOrder !== order) u.heldOrder.state = 'superseded';
      order.state = 'standby';
      u.heldOrder = order;
      world.stats.heldOrders = (world.stats.heldOrders ?? 0) + 1;
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'ack',
        text: standbyAckText(u, order, rng),
        priority: PRI.PRIORITY,
        meta: { unitId: u.id, orderId: order.id, observedAt: now },
        composedAt: now,
        duration: 3.5,
      });
      continue;
    }

    order.state = 'executing';
    u.order = order;

    beginExecution(world, u, order);

    // 状況報告要求・弾薬照会は「応答そのもの」が実行内容
    if (order.verb === 'sitrep' || order.verb === 'ammo_check') {
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'sitrep',
        text: order.verb === 'ammo_check' ? composeAmmoReport(u, world) : composeSitrep(u, world),
        priority: PRI.PRIORITY,
        meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: now },
        composedAt: now,
      });
      order.state = 'complete';
      order.completedAt = now;
      u.order = null;
      u.lastReportAt = now;
      continue;
    }

    // 通常の受領応答
    enqueue(world, {
      from: u.callsign,
      fromId: u.id,
      kind: 'ack',
      text: ackText(u, order, rng),
      priority: PRI.PRIORITY,
      meta: { unitId: u.id, orderId: order.id, observedAt: now },
      composedAt: now,
      duration: 3.5,
    });
  }

  stepHeldOrders(world);

  // 実行中の命令の進行管理
  for (const u of world.units) {
    if (!u.alive || !u.order) continue;
    advanceExecution(world, u, u.order, dt);
  }
}

/**
 * 予令の発動。
 *
 * 条件が満たされた瞬間、部下は指揮官を待たずに動き出す。
 * 動き出したことは必ず報告する ─ 指揮所が知らない機動があってはならない。
 */
function stepHeldOrders(world) {
  const { now, rng } = world;
  for (const u of world.units) {
    const order = u.heldOrder;
    if (!order) continue;
    if (!u.alive) {
      order.state = 'void';
      u.heldOrder = null;
      continue;
    }
    if (order.state !== 'standby') {
      u.heldOrder = null;
      continue;
    }

    const trig = TRIGGERS[order.trigger];
    if (!trig?.ready?.(world, u, order)) continue;

    // 予令が発動すれば、いま抱えている任務はそこで打ち切られる
    if (u.order && u.order !== order) u.order.state = 'superseded';

    order.state = 'executing';
    order.firedAt = now;
    u.heldOrder = null;
    u.order = order;
    beginExecution(world, u, order);

    if (u.commsOk) {
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'initiative',
        text:
          `こちら${u.callsign}、${triggerReasonJa(order.trigger)}。` +
          `予令にもとづき、${shortOrderJa(order)}。`,
        priority: PRI.PRIORITY,
        meta: { unitId: u.id, orderId: order.id, grid: order.grid, observedAt: now },
        composedAt: now,
        duration: 4,
      });
    }
  }
}

function triggerReasonJa(key) {
  switch (key) {
    case 'on_contact': return '敵を認めた';
    case 'on_pressure': return '圧されている';
    case 'at_time': return '時刻になった';
    default: return '条件が満ちた';
  }
}

function refusalReason(u, order, world) {
  const rng = world.rng;
  const movement = ['move', 'advance', 'attack', 'recon', 'withdraw'].includes(order.verb);

  if (u.state === 'broken') {
    return {
      reason: 'broken',
      text: `こちら${u.callsign}……無理だ、部隊がまとまらない！命令を実行できない！`,
    };
  }
  // 激しく制圧されている最中に「動け」は通らない
  if (movement && u.suppression > 78 && order.verb !== 'withdraw' && rng.chance(0.75)) {
    return {
      reason: 'pinned',
      text: `こちら${u.callsign}、今は動けない！釘付けだ、頭が上げられない！`,
    };
  }
  // 士気が落ちていると攻勢命令を渋る
  if ((order.verb === 'attack' || order.verb === 'advance') && u.morale < 42 && rng.chance(0.5)) {
    return {
      reason: 'morale',
      text: `こちら${u.callsign}……前へは出られない。ここを維持するのが精一杯だ。`,
    };
  }
  return null;
}

/** 予令を受けたときの応答。「承知した、その時が来たら動く」 */
function standbyAckText(u, order, rng) {
  const cond = {
    on_contact: '敵を認めしだい',
    on_pressure: '圧されたら',
    at_time: `${formatClock(order.triggerAt)}をもって`,
  }[order.trigger] ?? '条件が満ちしだい';

  return rng.pick([
    `${u.callsign}、予令を受領。${cond}${shortOrderJa(order)}。待機する。`,
    `こちら${u.callsign}、了解。${cond}動く。それまでは現在の任務を続ける。`,
    `${u.callsign}、予令了解。${cond}${shortOrderJa(order)}。以上。`,
  ]);
}

/** 命令の中身を一言で（受領応答と予令の発動報告で使い回す） */
function shortOrderJa(order) {
  return (
    {
      move: `${order.grid}へ移動する`,
      advance: `${order.grid}へ前進する`,
      attack: `${order.grid}を攻撃する`,
      defend: `${order.grid}で防御につく`,
      hold: '現在地を保持する',
      observe: `${order.grid}方向を監視する`,
      rally: `${order.grid}へ集結する`,
      hold_fire: '射撃を統制する',
      free_fire: '射撃自由で交戦する',
      recon: `${order.grid}を偵察する`,
      withdraw: `${order.grid}へ下がる`,
      fire_mission: `${order.grid}、射撃用意`,
      smoke: `${order.grid}に発煙`,
      register: `${order.grid}を標定する`,
      ammo_check: '弾薬を確認する',
      roe_hold_fast: '死守する。ここは渡さん',
      roe_standard: '陣地を保持する',
      roe_elastic: '弾力防御に移る',
      resupply: '補給を受ける',
      rest: '交代で休養する',
      stand_to: '警戒配置につく',
    }[order.verb] ?? VERBS[order.verb].label
  );
}

function ackText(u, order, rng) {
  const short = shortOrderJa(order);
  return rng.pick([
    `${u.callsign}、了解。${short}。`,
    `こちら${u.callsign}、了解した。${short}。`,
    `${u.callsign}、命令を受領。これより${short}。`,
  ]);
}

/** 経路点つきの命令なら第1脚へ、そうでなければ最終目標へ向かわせる */
function routeTo(world, u, order) {
  if (order.legs?.length) {
    u._legs = order.legs.slice(1);
    setDestination(u, world.terrain, order.legs[0].x, order.legs[0].y);
  } else {
    u._legs = null;
    setDestination(u, world.terrain, order.x, order.y);
  }
}

function beginExecution(world, u, order) {
  const posture = order.modifier ?? 'normal';

  // 新しい任務を与えられたら、前の射撃統制は解ける。
  // 「撃つな」と言われたまま突撃させられる部隊はいない。
  if (['advance', 'attack', 'defend'].includes(order.verb)) u.weaponsHold = false;

  // 交戦規定は「命令」ではなく「枠」。中身は部下が決める。
  if (VERBS[order.verb].roe) {
    setRoe(u, VERBS[order.verb].roe);
    u._selfWithdrawing = false;
    return;
  }

  switch (order.verb) {
    case 'move':
      u.state = 'moving';
      u.posture = posture;
      routeTo(world, u, order);
      break;
    case 'advance':
      u.state = 'attacking';
      u.posture = posture === 'normal' ? 'cautious' : posture;
      routeTo(world, u, order);
      break;
    case 'attack':
      u.state = 'attacking';
      u.posture = posture;
      routeTo(world, u, order);
      break;
    case 'defend':
      u.state = 'defending';
      u.posture = posture === 'normal' ? 'normal' : posture;
      setDestination(u, world.terrain, order.x, order.y);
      break;
    case 'hold':
      u.state = 'holding';
      u.posture = posture;
      clearDestination(u);
      break;

    case 'observe':
      // 監視は「見るために撃たない」。撃てば見つかるので、姿を消したまま張り付く。
      u.state = 'holding';
      u.posture = posture === 'normal' ? 'stealth' : posture;
      u.weaponsHold = true;
      u.watchX = order.x;
      u.watchY = order.y;
      clearDestination(u);
      break;

    case 'rally':
      u.state = 'withdrawing';
      u.posture = posture === 'normal' ? 'rapid' : posture;
      u.rallying = true;
      setDestination(u, world.terrain, order.x, order.y);
      break;

    case 'hold_fire':
      u.weaponsHold = true;
      break;

    case 'free_fire':
      u.weaponsHold = false;
      break;
    case 'recon':
      u.state = 'recon';
      u.posture = posture === 'normal' ? 'stealth' : posture;
      routeTo(world, u, order);
      break;
    case 'withdraw':
      u.state = 'withdrawing';
      u.posture = posture === 'normal' ? 'rapid' : posture;
      routeTo(world, u, order);
      break;

    case 'resupply': {
      const res = orderResupply(world, u.id);
      if (!res.ok) {
        enqueue(world, {
          from: 'ラーダー',
          fromId: world.trains?.unitId ?? null,
          kind: 'refuse',
          text: `こちらラーダー、${u.callsign}への補給は出せない。${res.reason}。`,
          priority: PRI.PRIORITY,
          meta: { observedAt: world.now },
          composedAt: world.now,
          duration: 4,
        });
      }
      break;
    }

    case 'rest':
      // 休養は掩体のなかで交代で取る。撃たれれば当然そこで終わる。
      u.resting = true;
      u.state = 'defending';
      if (u.posture !== 'dug_in' && u.posture !== 'fortified') u.posture = 'hasty';
      clearDestination(u);
      break;

    case 'stand_to':
      u.resting = false;
      u.state = 'defending';
      break;

    case 'register': {
      // 標定そのものは弾を使わない。事前に諸元を出しておくだけである。
      world.registrations.push({
        id: `RP${world.registrations.length + 1}`,
        x: order.x,
        y: order.y,
        grid: order.grid,
        readyAt: world.now + 180, // 諸元が出るまで3分
      });
      break;
    }

    case 'fire_mission': {
      const pool = world.support.artillery;
      const rounds = Math.min(pool.rounds, 6);
      // 予令として抱えているうちに撃ち尽くしていることがある
      if (rounds <= 0) {
        enqueue(world, {
          from: u.callsign,
          fromId: u.id,
          kind: 'refuse',
          text: `こちら${u.callsign}、${order.grid}への射撃要請、応じられない。弾が残っていない。`,
          priority: PRI.PRIORITY,
          meta: { unitId: u.id, orderId: order.id, observedAt: world.now },
          composedAt: world.now,
          duration: 4,
        });
        break;
      }
      pool.rounds -= rounds;
      // 概定射点の近くなら諸元が出ている。早く、正確に落ちる。
      const rp = nearestRegistration(world, order.x, order.y);
      const fm = createFireMission('he', order.x, order.y, world.now, {
        side: 'friend',
        requestedBy: u.id,
        rounds,
        delay: rp ? 32 + world.rng.range(0, 12) : 70 + world.rng.range(0, 25),
        spread: rp ? 0.45 : 1,
        registered: !!rp,
      });
      world.fireMissions.push(fm);
      world.stats.fireMissions++;
      if (rp) world.stats.registeredMissions = (world.stats.registeredMissions ?? 0) + 1;
      break;
    }
    case 'smoke': {
      const pool = world.support.smoke;
      const rounds = Math.min(pool.rounds, 4);
      if (rounds <= 0) break;
      pool.rounds -= rounds;
      const fm = createFireMission('smoke', order.x, order.y, world.now, {
        side: 'friend',
        requestedBy: u.id,
        rounds,
        delay: 50 + world.rng.range(0, 20),
      });
      world.fireMissions.push(fm);
      break;
    }
    default:
      break;
  }
}

/** 指定した点に諸元の出ている概定射点があるか */
export function nearestRegistration(world, x, y, radius = 260) {
  let best = null;
  for (const rp of world.registrations) {
    if (world.now < rp.readyAt) continue;
    const d = dist(x, y, rp.x, rp.y);
    if (d > radius) continue;
    if (!best || d < best.d) best = { rp, d };
  }
  return best?.rp ?? null;
}

/** 次の経路点へ進む。まだ脚が残っていれば true。 */
function advanceLeg(world, u) {
  if (!u._legs?.length) return false;
  const next = u._legs.shift();
  setDestination(u, world.terrain, next.x, next.y);
  return !!u.path.length;
}

function advanceExecution(world, u, order, dt) {
  if (order.state !== 'executing') return;

  switch (order.verb) {
    case 'move':
    case 'withdraw':
      if (!u.path.length && !advanceLeg(world, u)) completeOrder(world, u, order);
      break;

    case 'advance':
    case 'attack': {
      // 敵が見えている間は前進を止めて撃ち合う
      const engaged = [...u.contacts.values()].some(
        (c) => world.now - c.lastSeenAt < 12 && dist(u.x, u.y, c.x, c.y) < u.tpl.range * 1.05
      );
      if (engaged) {
        if (u.path.length) u._resumePath = u.path.slice();
        u.path = [];
      } else if (!u.path.length && u._resumePath?.length) {
        u.path = u._resumePath;
        u._resumePath = null;
      } else if (!u.path.length && u._legs?.length) {
        advanceLeg(world, u);
      } else if (!u.path.length && dist(u.x, u.y, order.x, order.y) < 120) {
        completeOrder(world, u, order);
      }
      break;
    }

    case 'defend':
      if (!u.path.length) {
        // 到着したら掩体を掘る
        // 構築陣地に居るならそのまま。掘り直させても劣化するだけである。
        if (u.posture !== 'dug_in' && u.posture !== 'fortified') {
          u.posture = 'dug_in';
          u.digInStartedAt = world.now;
        }
        if (order.completedAt == null) completeOrder(world, u, order, true);
      }
      break;

    case 'recon':
      if (!u.path.length && !advanceLeg(world, u)) completeOrder(world, u, order);
      break;

    case 'rally':
      if (!u.path.length) {
        u.rallying = false;
        u.posture = 'dug_in';
        completeOrder(world, u, order);
      }
      break;

    case 'observe':
    case 'hold_fire':
    case 'free_fire':
    case 'fire_mission':
    case 'smoke':
    case 'register':
    case 'roe_hold_fast':
    case 'roe_standard':
    case 'roe_elastic':
    case 'resupply':
    case 'rest':
    case 'stand_to':
      completeOrder(world, u, order, true);
      break;

    default:
      break;
  }
}

function completeOrder(world, u, order, silent = false) {
  order.state = 'complete';
  order.completedAt = world.now;

  // 防御命令は「その場に留まる」ことが継続的な内容なので状態を維持する
  if (order.verb !== 'defend') {
    if (u.state === 'moving' || u.state === 'withdrawing' || u.state === 'recon') u.state = 'holding';
  }
  u.order = null;

  if (silent) return;

  // 到着報告（これも無線を使う）
  enqueue(world, {
    from: u.callsign,
    fromId: u.id,
    kind: 'arrival',
    text: world.rng.pick([
      `こちら${u.callsign}、${toGrid(u.x, u.y)}に到着。配置についた。`,
      `${u.callsign}より、指定地点到達。${toGrid(u.x, u.y)}。`,
    ]),
    priority: PRI.ROUTINE,
    meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: world.now },
    composedAt: world.now,
    duration: 4,
  });
  u.lastReportAt = world.now;
}

function pushSystemMessage(world, text) {
  world.radio.log.push({
    id: `SYS${world.radio.log.length}`,
    at: world.now,
    from: 'システム',
    kind: 'system',
    priority: PRI.ROUTINE,
    text,
    garbled: false,
    lost: false,
    meta: {},
    observedAt: world.now,
  });
}
