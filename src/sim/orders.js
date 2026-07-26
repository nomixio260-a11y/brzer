// 命令の発令・伝達・受領・実行。
// 命令は無線を占有し、遅れて届き、時に拒否される。

import { clamp, toGrid, dist } from '../util.js';
import { enqueue, PRI } from './comms.js';
import { setDestination, clearDestination, POSTURES } from './units.js';
import { createFireMission } from './combat.js';
import { composeSitrep } from './reports.js';

export const VERBS = Object.freeze({
  move: { label: '移動', needsTarget: true, phrase: (g) => `${g}へ移動せよ` },
  advance: { label: '前進', needsTarget: true, phrase: (g) => `${g}へ前進し、接敵したら交戦せよ` },
  attack: { label: '攻撃', needsTarget: true, phrase: (g) => `${g}の敵を攻撃せよ` },
  defend: { label: '防御', needsTarget: true, phrase: (g) => `${g}を確保し、陣地を築いて防御せよ` },
  hold: { label: '待機', needsTarget: false, phrase: () => `現在地を保持し、待機せよ` },
  recon: { label: '偵察', needsTarget: true, phrase: (g) => `${g}方向を隠密に偵察せよ` },
  withdraw: { label: '後退', needsTarget: true, phrase: (g) => `${g}まで後退せよ` },
  sitrep: { label: '状況報告要求', needsTarget: false, phrase: () => `状況を報告せよ` },
  fire_mission: { label: '砲撃要請', needsTarget: true, phrase: (g) => `${g}に対し効力射。射撃用意` },
  smoke: { label: '煙幕要請', needsTarget: true, phrase: (g) => `${g}に発煙弾。視界を遮れ` },
});

export const MODIFIERS = Object.freeze({
  normal: '通常',
  rapid: '急速',
  cautious: '慎重',
  stealth: '隠密',
});

let orderSeq = 1;

/**
 * 指揮官が命令を出す。まず無線に乗り、届いてから初めて実行される。
 * @returns {object|null} 発令された命令
 */
export function issueOrder(world, { unitId, verb, x, y, modifier = 'normal' }) {
  const u = world.unitsById.get(unitId);
  const spec = VERBS[verb];
  if (!u || !spec) return null;

  // 砲撃・煙幕は砲兵に対する要請なので、弾数を先に確認する
  if (verb === 'fire_mission' || verb === 'smoke') {
    const pool = verb === 'smoke' ? world.support.smoke : world.support.artillery;
    if (pool.rounds <= 0) {
      pushSystemMessage(world, `${u.callsign}: 弾がない。射撃要請には応じられない。`);
      return null;
    }
  }

  const grid = spec.needsTarget ? toGrid(x, y) : toGrid(u.x, u.y);

  const order = {
    id: `O${orderSeq++}`,
    unitId,
    verb,
    x: spec.needsTarget ? x : u.x,
    y: spec.needsTarget ? y : u.y,
    grid,
    modifier,
    issuedAt: world.now,
    state: 'transmitting',
    receivedAt: null,
    ackAt: null,
    completedAt: null,
  };

  world.orders.push(order);
  u.pendingOrder = order;

  const modPhrase = modifier === 'normal' ? '' : `${MODIFIERS[modifier]}に。`;
  const text = `${u.callsign}、こちら指揮所。${spec.phrase(grid)}。${modPhrase}どうぞ`;

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

    order.state = 'executing';
    order.ackAt = now;
    u.pendingOrder = null;
    u.order = order;
    u.lastOrderAt = now;
    world.stats.responseTimes.push(now - order.issuedAt);

    beginExecution(world, u, order);

    // 状況報告要求は「応答そのもの」が実行内容
    if (order.verb === 'sitrep') {
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'sitrep',
        text: composeSitrep(u, world),
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

  // 実行中の命令の進行管理
  for (const u of world.units) {
    if (!u.alive || !u.order) continue;
    advanceExecution(world, u, u.order, dt);
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

function ackText(u, order, rng) {
  const spec = VERBS[order.verb];
  const short = {
    move: `${order.grid}へ移動する`,
    advance: `${order.grid}へ前進する`,
    attack: `${order.grid}を攻撃する`,
    defend: `${order.grid}で防御につく`,
    hold: '現在地を保持する',
    recon: `${order.grid}を偵察する`,
    withdraw: `${order.grid}へ下がる`,
    fire_mission: `${order.grid}、射撃用意`,
    smoke: `${order.grid}に発煙`,
  }[order.verb] ?? spec.label;

  return rng.pick([
    `${u.callsign}、了解。${short}。`,
    `こちら${u.callsign}、了解した。${short}。`,
    `${u.callsign}、命令を受領。これより${short}。`,
  ]);
}

function beginExecution(world, u, order) {
  const posture = order.modifier ?? 'normal';

  switch (order.verb) {
    case 'move':
      u.state = 'moving';
      u.posture = posture;
      setDestination(u, world.terrain, order.x, order.y);
      break;
    case 'advance':
      u.state = 'attacking';
      u.posture = posture === 'normal' ? 'cautious' : posture;
      setDestination(u, world.terrain, order.x, order.y);
      break;
    case 'attack':
      u.state = 'attacking';
      u.posture = posture;
      setDestination(u, world.terrain, order.x, order.y);
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
    case 'recon':
      u.state = 'recon';
      u.posture = posture === 'normal' ? 'stealth' : posture;
      setDestination(u, world.terrain, order.x, order.y);
      break;
    case 'withdraw':
      u.state = 'withdrawing';
      u.posture = posture === 'normal' ? 'rapid' : posture;
      setDestination(u, world.terrain, order.x, order.y);
      break;
    case 'fire_mission': {
      const pool = world.support.artillery;
      const rounds = Math.min(pool.rounds, 6);
      pool.rounds -= rounds;
      const fm = createFireMission('he', order.x, order.y, world.now, {
        side: 'friend',
        requestedBy: u.id,
        rounds,
        delay: 70 + world.rng.range(0, 25),
      });
      world.fireMissions.push(fm);
      world.stats.fireMissions++;
      break;
    }
    case 'smoke': {
      const pool = world.support.smoke;
      const rounds = Math.min(pool.rounds, 4);
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

function advanceExecution(world, u, order, dt) {
  if (order.state !== 'executing') return;

  switch (order.verb) {
    case 'move':
    case 'withdraw':
      if (!u.path.length) completeOrder(world, u, order);
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
      } else if (!u.path.length && dist(u.x, u.y, order.x, order.y) < 120) {
        completeOrder(world, u, order);
      }
      break;
    }

    case 'defend':
      if (!u.path.length) {
        // 到着したら掩体を掘る
        if (u.posture !== 'dug_in') {
          u.posture = 'dug_in';
          u.digInStartedAt = world.now;
        }
        if (order.completedAt == null) completeOrder(world, u, order, true);
      }
      break;

    case 'recon':
      if (!u.path.length) completeOrder(world, u, order);
      break;

    case 'fire_mission':
    case 'smoke':
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
