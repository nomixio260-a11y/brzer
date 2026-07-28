// 命令の発令・伝達・受領・実行。
// 命令は無線を占有し、遅れて届き、時に拒否される。

import { toGrid, dist, formatClock, clamp } from '../util.js';
import { enqueue, PRI } from './comms.js';
import { setDestination, clearDestination } from './units.js';
import { createFireMission, checkFire } from './combat.js';
import { composeSitrep, composeAmmoReport, composeAreaReport } from './reports.js';
import { setRoe } from './friendlyAI.js';
import { orderResupply } from './logistics.js';
import { FIRE_MODES, fireMode, fireCheck, dangerClose } from './fires.js';
import { officerFactors } from './officers.js';
import { canBreach } from './attachments.js';
import { obstacleNear } from './terrain.js';

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
  // 前令取消。まだ網に乗っていない命令なら、送信そのものを取りやめられる ─
  // 指揮所で紙を破るだけの話である。喋り出してしまったものは戻らない。
  countermand: {
    label: '前令取消', group: 'maneuver', needsTarget: false,
    phrase: () => `前令取消。繰り返す、前令取消。現在地で待て`,
  },
  // 障害処理。工兵班を付けた分隊だけができる。
  breach: {
    label: '障害処理', group: 'maneuver', needsTarget: true,
    phrase: (g) => `${g}の障害を処理し、通路を開け`,
  },
  recon: { label: '偵察', group: 'maneuver', needsTarget: true, multi: true, phrase: (g) => `${g}方向を隠密に偵察せよ` },
  withdraw: { label: '後退', group: 'maneuver', needsTarget: true, multi: true, phrase: (g) => `${g}まで後退せよ` },
  rally: { label: '集結', group: 'maneuver', needsTarget: true, phrase: (g) => `${g}へ集結し、部隊を立て直せ` },

  observe: { label: '監視', group: 'fires', needsTarget: true, phrase: (g) => `${g}方向を監視せよ。姿を晒すな` },
  hold_fire: { label: '射撃統制', group: 'fires', needsTarget: false, phrase: () => `射撃を統制せよ。撃たれるまで撃つな` },
  free_fire: { label: '射撃自由', group: 'fires', needsTarget: false, phrase: () => `射撃自由。目標を発見しだい交戦せよ` },
  fire_mission: {
    label: '砲撃要請', group: 'fires', needsTarget: true, indirect: true,
    phrase: (g) => `${g}に対し効力射。射撃用意`,
  },
  smoke: {
    label: '煙幕要請', group: 'fires', needsTarget: true, indirect: true,
    phrase: (g) => `${g}に発煙弾。視界を遮れ`,
  },
  // 夜間の谷は、弾よりも「見えること」が要る。
  illum: {
    label: '照明弾', group: 'fires', needsTarget: true, indirect: true,
    phrase: (g) => `${g}上空に照明。落ちるまでに見極めろ`,
  },
  register: {
    label: '概定射点',
    group: 'fires',
    needsTarget: true,
    indirect: true,
    phrase: (g) => `${g}を概定射点として標定せよ。以後この点への射撃を優先する`,
  },
  // 危近弾を聞いて止めたいのは、その一発である ─
  // 掩護の煙まで一緒に落とされては、止めた側が損をする。
  cancel_fire: {
    label: '射撃中止（一つ）',
    group: 'fires',
    needsTarget: true,
    phrase: (g) => `${g}への射撃を中止せよ。他はそのまま続行`,
  },
  // 撃ってしまったものは戻らないが、まだ撃っていない弾なら止められる。
  check_fire: {
    label: '射撃中止',
    group: 'fires',
    needsTarget: false,
    phrase: () => `射撃中止。繰り返す、射撃中止`,
  },

  roe_hold_fast: { label: '死守', group: 'roe', needsTarget: false, roe: 'hold_fast', phrase: () => `死守せよ。一歩も退くな` },
  roe_standard: { label: '陣地防御', group: 'roe', needsTarget: false, roe: 'standard', phrase: () => `陣地を保持せよ。保たぬと判断すれば独断で下がってよい` },
  roe_elastic: { label: '弾力防御', group: 'roe', needsTarget: false, roe: 'elastic', phrase: () => `弾力防御。土地より部隊を惜しめ。圧されたら早めに下がれ` },

  sitrep: { label: '状況報告要求', group: 'intel', needsTarget: false, phrase: () => `状況を報告せよ` },
  ammo_check: { label: '弾薬照会', group: 'intel', needsTarget: false, phrase: () => `弾薬の残量を報告せよ` },
  // 部隊に自分のことを訊けても、外のことを訊けなかった。
  // 統制線を引いても、そこに目が届いているかを確かめる術が無い ─
  // それでは線に予令を付ける意味がない。
  report_on: {
    label: '地点の観測要求', group: 'intel', needsTarget: true,
    phrase: (g) => `${g}に何が見えるか。見えるものだけを報告せよ`,
  },

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
  on_line: {
    key: 'on_line',
    label: '統制線',
    needsLine: true,
    hint: '引いてある統制線を敵が越えた時点で発動する',
    phrase: (o) => `統制線${o.lineName ?? ''}を敵が越えたら、`,
    // 越えたことを知るのは、それを見た部下である。指揮所ではない。
    ready: (world, u, order) => {
      if (!order.line?.length) return false;
      for (const c of u.contacts.values()) {
        if (world.now - c.lastSeenAt > 25) continue;
        if (crossedLine(order.line, c.x, c.y)) return true;
      }
      return false;
    },
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

/**
 * 統制線を越えたか。
 *
 * 線の x の範囲でその点の高さを求め、南（y が大きい側）に居れば「越えた」。
 * 統制線は東西に引くものなので、これで足りる。
 */
export function crossedLine(points, x, y) {
  let lineY = null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    if (x < lo || x > hi || hi - lo < 1) continue;
    const t = (x - a.x) / (b.x - a.x);
    lineY = a.y + (b.y - a.y) * t;
    break;
  }
  // 線の外側なら、いちばん近い端の高さで見る
  if (lineY == null) {
    const first = points[0];
    const last = points[points.length - 1];
    lineY = Math.abs(x - first.x) < Math.abs(x - last.x) ? first.y : last.y;
  }
  return y > lineY;
}

/** 一つの部隊が懐に入れておける予令の数。 */
export const HELD_LIMIT = 3;

let orderSeq = 1;

/**
 * 指揮官が命令を出す。まず無線に乗り、届いてから初めて実行される。
 * @returns {object|null} 発令された命令
 */
export function issueOrder(
  world,
  {
    unitId, verb, x, y, modifier = 'normal', legs = null,
    trigger = 'now', triggerAt = null, line = null, lineName = null,
  }
) {
  const u = world.unitsById.get(unitId);
  const spec = VERBS[verb];
  if (!u || !spec) return null;
  // 命令に添える余分（どの射撃を止めるか、など）
  let order0 = null;

  const trig = TRIGGERS[trigger] ?? TRIGGERS.now;
  // 過ぎた時刻を条件にしても意味がない
  if (trig.needsTime && !(triggerAt > world.now)) trigger = 'now';
  // 線が渡されていなければ統制線条件は成立しない
  if (trig.needsLine && !(line?.length >= 2)) trigger = 'now';

  // 砲撃・煙幕・照明は砲兵に対する要請である。
  // 弾があるか、そもそも届くか ─ 指揮所の火力係はそれを知っている。
  if (VERBS[verb].indirect) {
    if (verb !== 'register' && !world.creative?.unlimitedFires) {
      const pool = poolFor(world, verb);
      if (!pool || pool.rounds <= 0) {
        pushSystemMessage(world, `${u.callsign}: ${poolNameJa(verb)}が残っていない。要請には応じられない。`);
        return null;
      }
    }
    const chk = fireCheck(world, x, y, { ignoreLaying: verb === 'register' });
    if (!chk.ok) {
      pushSystemMessage(world, chk.text);
      return null;
    }
  }
  if (verb === 'check_fire' && !world.fireMissions.some((fm) => !fm.done && fm.side === 'friend')) {
    pushSystemMessage(world, '止めるべき射撃がない。');
    return null;
  }
  if (verb === 'cancel_fire') {
    const fm = nearestOwnMission(world, x, y);
    if (!fm) {
      pushSystemMessage(world, 'その辺りに、止められる射撃がない。');
      return null;
    }
    order0 = { cancelId: fm.id };
  }

  // --- 前令取消 ---------------------------------------------------
  //
  // 誤って叩いた方眼へ「攻撃」を送ってしまった瞬間 ─
  // それを止めたいのは、まさに送信がまだ列に並んでいる間である。
  // 本物の指揮所はそこで割り込む。ここには割り込む手が無かった。
  if (verb === 'countermand') {
    const pulled = pullBackTransmission(world, u);
    if (pulled) {
      world.stats.countermands = (world.stats.countermands ?? 0) + 1;
      pushSystemMessage(
        world,
        `前令取消 ─ ${u.callsign}への「${VERBS[pulled.verb]?.label ?? pulled.verb}` +
        `${pulled.grid ? ` ${pulled.grid}` : ''}」は、まだ送信していない。取りやめた。`
      );
      // 網に乗せていないのだから、無線も食わないし遅れもしない。
      // 返すのは「済んだ命令」であって、部下は何も知らない。
      const done = {
        id: `O${orderSeq++}`, unitId, verb, x: u.x, y: u.y, legs: null,
        grid: toGrid(u.x, u.y), modifier, trigger: 'now', triggerAt: null,
        line: null, lineName: null, issuedAt: world.now,
        state: 'completed', receivedAt: world.now, ackAt: world.now,
        completedAt: world.now, pulled: true,
      };
      world.orders.push(done);
      return done;
    }
    if (!u.pendingOrder && !u.order) {
      pushSystemMessage(world, `${u.callsign}に取り消せる前令がない。`);
      return null;
    }
    // もう喋ってしまった、あるいは届いてしまった ─
    // 止められるのは「これ以上やるな」までである。
  }
  if (verb === 'breach') {
    // 道具の無い分隊に「鉄条網を切れ」と言っても、切るものを持っていない。
    if (!canBreach(u)) {
      pushSystemMessage(world, `${u.callsign}: 工兵班が付いていない。障害は処理できない。`);
      return null;
    }
    const obs = obstacleNear(world.terrain, x, y);
    if (!obs) {
      pushSystemMessage(world, `${u.callsign}: その辺りに処理すべき障害は無い。`);
      return null;
    }
    order0 = { obstacleId: obs.id ?? `${obs.x},${obs.y}`, x: obs.x, y: obs.y };
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
    line,
    lineName,
    issuedAt: world.now,
    state: 'transmitting',
    receivedAt: null,
    ackAt: null,
    completedAt: null,
    ...(order0 ?? {}),
  };

  world.orders.push(order);
  u.pendingOrder = order;

  const modPhrase = modifier === 'normal' ? '' : `${MODIFIERS[modifier]}に。`;
  // --- H時前 ------------------------------------------------------
  //
  // 作戦命令は無線で読み上げるものではない。H時前に部下を集め、
  // 地図を広げ、顔を見て渡す。だからこの間の命令は遅れず、歪まず、
  // 網も埋めない ─ そして復唱もその場で返る。
  //
  // 「開戦前に全部言っておけばよい」ようだが、そうはならない。
  // H時前に分かっているのは自分の企図だけであって、敵の企図ではない。
  // 計画で渡せるのは「そのつもりでいろ」までである。
  if (world.planning) {
    order.viaOrders = true;
    order.state = 'received';
    order.receivedAt = world.now;
    order.ackDueAt = world.now;
    u.pendingOrder = null;
    world.stats.ordersIssued++;
    world.stats.planningOrders = (world.stats.planningOrders ?? 0) + 1;
    pushSystemMessage(
      world,
      `作戦命令 ─ ${u.callsign}（${officerTag(u)}）に下達。${cond0(order)}${spec.phrase(grid)}。${modPhrase}`
    );
    return order;
  }

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

/**
 * まだ網に乗っていない命令を、送信の列から引き抜く。
 *
 * 引き抜けるのは「並んでいる間」だけである。
 * 通信士が読み上げはじめてしまえば、指揮所にできることは何もない ─
 * そこから先は、届いた命令を新しい命令で上書きするしかない。
 */
function pullBackTransmission(world, u) {
  const q = world.radio?.queue;
  if (!q?.length) return null;
  const i = q.findIndex((tx) => tx.outbound && tx.meta?.toId === u.id && tx.meta?.orderId);
  if (i < 0) return null;
  const [tx] = q.splice(i, 1);
  const order = world.orders.find((o) => o.id === tx.meta.orderId);
  if (order) {
    order.state = 'void';
    order.voidedAt = world.now;
  }
  if (u.pendingOrder && u.pendingOrder.id === tx.meta.orderId) u.pendingOrder = null;
  return order ?? null;
}

/** その地点にいちばん近い、まだ落ち切っていない味方の射撃 */
function nearestOwnMission(world, x, y) {
  let best = null;
  let bestD = 700 * 700;
  for (const fm of world.fireMissions) {
    if (fm.done || fm.side !== 'friend') continue;
    const d = (fm.x - x) ** 2 + (fm.y - y) ** 2;
    if (d < bestD) { bestD = d; best = fm; }
  }
  return best;
}

/**
 * 命令の通り方。
 *
 * その人の性分と忠誠（officerFactors）に、国の側の掛かりを重ねる。
 * 掛け算にしたうえで床と天井を置く ─ どちらか一方で決まってしまっては、
 * 士官を選ぶ意味も、統治を選ぶ意味も無くなる。
 */
function obeyOf(world, u) {
  const own = officerFactors(u.officer).obey;
  const nation = world.setup?.war?.obey ?? 1;
  return clamp(own * nation, 0.55, 1.6);
}

/** 命令書に書く条件句（予令なら「敵を認めしだい」等） */
function cond0(order) {
  const t = TRIGGERS[order.trigger] ?? TRIGGERS.now;
  return order.trigger === 'now' ? '' : `予令 ─ ${t.phrase(order)}`;
}

/** 命令を受け取った者。戦役では名前で呼ぶ。 */
function officerTag(u) {
  return u.officer ? `${u.officer.name} ${u.officer.rank}` : (u.role ?? u.tpl.label);
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
    // 受領して応答するまでの間（部隊が状況を見て判断する時間）。
    // 演習では待たせない ─ 手順を試すための盤だからである。
    // 呑み込みの早い者は復唱が速い。一徹な者は、まず自分の目で状況を見てから返す。
    // 国の側でも命令の通り方は変わる ─ 心服させるか、黙らせるか。
    const obey = obeyOf(world, u);
    order.ackDueAt = world.creative?.instantRadio
      ? world.now + 1
      : world.now + 3 + ((1 - u.skill) * 14 + world.rng.range(0, 8)) / obey;
  }
}

/** 受領応答と実行開始 */
export function stepOrders(world, dt) {
  const { now, rng } = world;

  for (const order of world.orders) {
    if (order.state !== 'received') continue;
    if (now < order.ackDueAt) continue;

    // 口頭で渡した命令の復唱は、その場で返る。網には乗らない。
    const spoken = !!order.viaOrders;

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
      u.refusedCount = (u.refusedCount ?? 0) + 1;
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
    u.responseSum = (u.responseSum ?? 0) + (now - order.issuedAt);
    u.responseCount = (u.responseCount ?? 0) + 1;

    // --- 予令は懐に入れて待つ -------------------------------------
    if (order.trigger && order.trigger !== 'now') {
      // 予令は三つまで抱えられる。
      //
      // 一つしか持てなかったので、「接敵したら報告」を渡した部隊に
      // 「圧されたら下がれ」を渡すと、前の一つが黙って消えていた。
      // 意図を先に配っておくのがこの摩擦への備えだと書いておきながら、
      // 配れる意図が一つでは計画にならない。
      //
      // ただし同じ条件の予令は差し替える ─ 「接敵したら」が二つあれば、
      // どちらに従うかを部下に選ばせることになる。
      const held = (u.heldOrders ?? []).filter((h) => h.state === 'standby' && h !== order);
      for (const h of held) if (h.trigger === order.trigger) h.state = 'superseded';
      const kept = held.filter((h) => h.state === 'standby');
      // 溢れたら古いものから落ちる。多すぎる予令は計画ではなく願望である。
      while (kept.length >= HELD_LIMIT) kept.shift().state = 'superseded';
      order.state = 'standby';
      kept.push(order);
      u.heldOrders = kept;
      world.stats.heldOrders = (world.stats.heldOrders ?? 0) + 1;
      if (spoken) {
        pushSystemMessage(world, `${u.callsign}: ${standbyAckText(u, order, rng)}`);
        continue;
      }
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
    if (spoken) {
      pushSystemMessage(world, `${u.callsign}: ${ackText(u, order, rng)}`);
      continue;
    }
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
    if (!u.heldOrders?.length) continue;
    if (!u.alive) {
      for (const o of u.heldOrders) if (o.state === 'standby') o.state = 'void';
      u.heldOrders = [];
      continue;
    }
    // 差し替えられたものは、ここで懐から落ちる。
    const list = u.heldOrders.filter((o) => o.state === 'standby');
    u.heldOrders = list;

    // 条件が揃ったものを一つだけ発動する。
    // 同じ瞬間に二つ揃うことはあるが、部隊は一つのことしかできない ─
    // 渡した順が古いものから拾う（先に配った意図が優先される）。
    const order = list.find((o) => TRIGGERS[o.trigger]?.ready?.(world, u, o));
    if (!order) continue;

    // 予令が発動すれば、いま抱えている任務はそこで打ち切られる
    if (u.order && u.order !== order) u.order.state = 'superseded';

    order.state = 'executing';
    order.firedAt = now;
    // 残りの予令は懐に残る。一つ発動したからといって、
    // 「圧されたら下がれ」まで反故になるわけではない。
    u.heldOrders = list.filter((o) => o !== order);
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
    case 'on_line': return '敵が統制線を越えた';
    case 'at_time': return '時刻になった';
    default: return '条件が満ちた';
  }
}

function refusalReason(u, order, world) {
  const rng = world.rng;
  const movement = ['move', 'advance', 'attack', 'recon', 'withdraw'].includes(order.verb);
  // 従順な者ほど渋らない。一徹な者は、納得しない命令を返事だけで済ませる。
  const obey = obeyOf(world, u);

  if (u.state === 'broken') {
    return {
      reason: 'broken',
      text: `こちら${u.callsign}……無理だ、部隊がまとまらない！命令を実行できない！`,
    };
  }
  // 激しく制圧されている最中に「動け」は通らない
  if (movement && u.suppression > 78 && order.verb !== 'withdraw' && rng.chance(0.75 / obey)) {
    return {
      reason: 'pinned',
      text: `こちら${u.callsign}、今は動けない！釘付けだ、頭が上げられない！`,
    };
  }
  // 士気が落ちていると攻勢命令を渋る
  if ((order.verb === 'attack' || order.verb === 'advance') && u.morale < 42 && rng.chance(0.5 / obey)) {
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
    on_line: `統制線${order.lineName ?? ''}を敵が越えたら`,
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
      fire_mission: `${order.grid}、${FIRE_MODES[order.modifier]?.label ?? '着発'}で射撃用意`,
      smoke: `${order.grid}に発煙`,
      illum: `${order.grid}上空に照明`,
      check_fire: '射撃を止める',
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

  // 新しい任務が来た時点で、独断の後退も集結も終わりである。
  //
  // ここを畳んでいなかったので、一度でも独断で下がった部隊は、
  // 次に何を命じられても着いた先で勝手に掩体を掘って「防御」に戻っていた。
  // 集結の旗も立ちっぱなしになり、士気の戻りが速いままだった。
  u._selfWithdrawing = false;
  if (order.verb !== 'rally') u.rallying = false;

  // 交戦規定は「命令」ではなく「枠」。中身は部下が決める。
  if (VERBS[order.verb].roe) {
    setRoe(u, VERBS[order.verb].roe);
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

    // 前令取消。届いてしまったものは戻らないが、
    // 「これ以上やるな」までは伝えられる。
    case 'countermand':
      u.state = 'holding';
      u.posture = 'normal';
      u._selfWithdrawing = false;
      u.rallying = false;
      clearDestination(u);
      u.path = [];
      u._resumePath = null;
      u._legs = null;
      completeOrder(world, u, order, true);
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'ack',
        text: `こちら${u.callsign}、前令取消を了解。その場で止まる。`,
        priority: PRI.FLASH,
        meta: { unitId: u.id, orderId: order.id, observedAt: world.now },
        composedAt: world.now,
        duration: 3,
      });
      break;

    // 障害処理。掛かる時間は、道具と人数と、撃たれているかどうかで決まる。
    case 'breach':
      u.state = 'moving';
      u.posture = posture === 'normal' ? 'cautious' : posture;
      setDestination(u, world.terrain, order.x, order.y);
      order.breachLeft = null;
      break;

    // 指定地点の観測要求。答えは「見えるものだけ」である ─
    // 見えていなければ「見えない」と答える。それも情報である。
    case 'report_on':
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'sitrep',
        text: composeAreaReport(u, world, order.x, order.y, order.grid),
        priority: PRI.PRIORITY,
        meta: { unitId: u.id, orderId: order.id, observedAt: world.now },
        composedAt: world.now,
        duration: 5,
      });
      completeOrder(world, u, order, true);
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
        // 諸元が出るまで3分。ただし H時前に立てた点は、
        // 前夜のうちに砲側で計算が済んでいる ─ 火力計画とはそういうものである。
        readyAt: order.viaOrders ? world.now : world.now + 180,
      });
      break;
    }

    case 'fire_mission':
    case 'smoke':
    case 'illum': {
      const kind = order.verb === 'fire_mission' ? 'he' : order.verb === 'smoke' ? 'smoke' : 'illum';
      const pool = poolFor(world, order.verb);
      const mode = fireMode(order.verb === 'fire_mission' ? order.modifier : null);
      const want = kind === 'he' ? mode.rounds : kind === 'smoke' ? 4 : 2;
      const unlimited = !!world.creative?.unlimitedFires;
      const rounds = unlimited ? want : Math.min(pool.rounds, want);

      // 予令として抱えているうちに、弾を撃ち尽くしていることがある。
      // 砲が陣地変換していることも、射程から外れていることもある。
      if (rounds <= 0) {
        refuseFire(world, u, order, `${poolNameJa(order.verb)}が残っていない`);
        break;
      }
      const chk = fireCheck(world, order.x, order.y);
      if (!chk.ok) {
        enqueue(world, {
          from: u.callsign,
          fromId: u.id,
          kind: 'refuse',
          text: chk.text,
          priority: PRI.PRIORITY,
          meta: { unitId: u.id, orderId: order.id, observedAt: world.now },
          composedAt: world.now,
          duration: 4,
        });
        break;
      }

      if (!unlimited) pool.rounds -= rounds;
      // 概定射点の近くなら諸元が出ている。早く、正確に落ちる。
      const rp = nearestRegistration(world, order.x, order.y);
      const baseDelay =
        kind === 'he'
          ? rp
            ? 32 + world.rng.range(0, 12)
            : 70 + world.rng.range(0, 25)
          : kind === 'smoke'
            ? 50 + world.rng.range(0, 20)
            : 34 + world.rng.range(0, 14);

      const fm = createFireMission(kind, order.x, order.y, world.now, {
        side: 'friend',
        requestedBy: u.id,
        rounds,
        mode: kind === 'he' ? mode.key : null,
        delay: baseDelay * (kind === 'he' ? mode.delayMul : 1),
        spread: rp ? 0.45 : 1,
        registered: !!rp,
      });
      world.fireMissions.push(fm);

      if (kind === 'he') {
        world.stats.fireMissions++;
        if (rp) world.stats.registeredMissions = (world.stats.registeredMissions ?? 0) + 1;
        // 危近弾。砲側は自軍の配置を知っているので、必ず言ってくる ―
        // 言ったうえで撃つ。撃たないと決めるのは指揮官の仕事である。
        const near = dangerClose(world, order.x, order.y);
        if (near) {
          world.stats.dangerClose = (world.stats.dangerClose ?? 0) + 1;
          enqueue(world, {
            from: chk.gun.callsign,
            fromId: chk.gun.id,
            kind: 'firecontrol',
            text:
              `こちら${chk.gun.callsign}、危近弾！${order.grid}の至近に${near.u.callsign}がいる。` +
              `およそ${Math.round(near.d / 10) * 10}m。……承知の上と判断し、射撃する。`,
            priority: PRI.FLASH,
            meta: { grid: order.grid, observedAt: world.now },
            composedAt: world.now,
            duration: 5,
          });
        }
      }
      break;
    }

    case 'cancel_fire':
    case 'check_fire': {
      const one = order.verb === 'cancel_fire';
      const res = checkFire(world, 'friend', one ? order.cancelId : null);
      if (!world.creative?.unlimitedFires) {
        world.support.artillery.rounds += res.returned.he ?? 0;
        world.support.smoke.rounds += res.returned.smoke ?? 0;
        world.support.illum.rounds += res.returned.illum ?? 0;
      }
      world.stats.checkFires = (world.stats.checkFires ?? 0) + 1;
      const back = (res.returned.he ?? 0) + (res.returned.smoke ?? 0) + (res.returned.illum ?? 0);
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'firecontrol',
        text:
          res.cancelled > 0
            ? `こちら${u.callsign}、${one ? `${order.grid}への射撃を中止` : '射撃中止'}。` +
              `手を止めた。${back}発、砲側に残る。`
            : `こちら${u.callsign}、射撃中止 ─ だが、もう全弾出たあとだ。`,
        priority: PRI.FLASH,
        meta: { unitId: u.id, observedAt: world.now },
        composedAt: world.now,
        duration: 4,
      });
      break;
    }
    default:
      break;
  }
}

/** その要請が食う弾の在庫 */
function poolFor(world, verb) {
  if (verb === 'smoke') return world.support.smoke;
  if (verb === 'illum') return world.support.illum;
  return world.support.artillery;
}

function poolNameJa(verb) {
  return verb === 'smoke' ? '発煙弾' : verb === 'illum' ? '照明弾' : '砲弾';
}

function refuseFire(world, u, order, why) {
  enqueue(world, {
    from: u.callsign,
    fromId: u.id,
    kind: 'refuse',
    text: `こちら${u.callsign}、${order.grid}への要請、応じられない。${why}。`,
    priority: PRI.PRIORITY,
    meta: { unitId: u.id, orderId: order.id, observedAt: world.now },
    composedAt: world.now,
    duration: 4,
  });
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

    case 'advance': {
      // 前進は「接敵したら止まって撃つ」。どこに敵がいるかを確かめる機動である。
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

    // 障害処理。
    //
    // 「工兵班は鉄条網と地雷原を処理できる」と書いておきながら、
    // 実際に消えるものは何も無かった ─ 付けた分隊の足が速くなるだけで、
    // 後続の中隊には依然として同じ壁が立っていた。
    case 'breach': {
      const obs = (world.terrain.obstacles ?? []).find((o) => o.id === order.obstacleId);
      if (!obs || obs.cleared) { completeOrder(world, u, order, true); break; }
      if (dist(u.x, u.y, order.x, order.y) > obs.r * 0.9 + 60) break;

      if (order.breachLeft == null) {
        // 地雷原は鉄条網より長くかかる。一歩ずつ確かめる以外に道が無い。
        order.breachLeft = obs.kind === 'wire' ? 160 : 320;
        u.state = 'holding';
        clearDestination(u);
        enqueue(world, {
          from: u.callsign, fromId: u.id, kind: 'sitrep',
          text: `こちら${u.callsign}、${order.grid}の障害に取り付いた。処理にかかる。`,
          priority: PRI.ROUTINE,
          meta: { unitId: u.id, orderId: order.id, grid: order.grid, observedAt: world.now },
          composedAt: world.now, duration: 3.5,
        });
      }
      // 撃たれている間は手が止まる。障害処理は掩護の下でしかできない ─
      // 工兵を送り込むだけでは足りず、そこを制圧してやる必要がある。
      order.breachLeft -= dt * (u.suppression > 35 ? 0.2 : 1);
      if (order.breachLeft <= 0) {
        obs.cleared = true;
        obs.clearedAt = world.now;
        world.stats.breaches = (world.stats.breaches ?? 0) + 1;
        enqueue(world, {
          from: u.callsign, fromId: u.id, kind: 'sitrep',
          text:
            `こちら${u.callsign}、${order.grid}の` +
            `${obs.kind === 'wire' ? '鉄条網を切り開いた' : '地雷原に通路を啓開した'}。` +
            `後続はここを通れる。`,
          priority: PRI.PRIORITY,
          meta: { unitId: u.id, orderId: order.id, grid: order.grid, observedAt: world.now },
          composedAt: world.now, duration: 4,
        });
        completeOrder(world, u, order, true);
      }
      break;
    }

    case 'attack': {
      // 攻撃は止まらない。
      //
      // 前進と同じに扱っていたので、最初の一発を受けた地点で足が止まり、
      // 市街に籠る敵には永久に届かなかった ─ 突撃距離まで詰めなければ、
      // 厚い遮蔽の中の敵は減らない。撃たれながら寄せるのが攻撃であり、
      // その代償を払わせないために、指揮官は先に制圧し、煙を焚く。
      if (dist(u.x, u.y, order.x, order.y) < 130) {
        completeOrder(world, u, order);
        break;
      }
      if (!u.path.length && !advanceLeg(world, u)) {
        // 押し戻されたり、経路を捨てさせられたりしても、目標へ引き直す
        setDestination(u, world.terrain, order.x, order.y);
        if (!u.path.length) completeOrder(world, u, order);
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
    case 'illum':
    case 'cancel_fire':
    case 'check_fire':
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
