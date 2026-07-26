// 部下の独断。
//
// 実際の分隊長は、命令が来るまで棒立ちで死んだりしない。
// 手が空いていれば掩体を掘るし、圧されれば下がる判断もする ―
// ただしそれは「指揮官がどこまで許したか」の範囲内でのことである。
//
// 指揮官は交戦規定（ROE）で枠を決める。中身は部下が決める。
// これが任務指揮であり、このゲームで指揮官が本当にやることでもある。

import { clamp, dist, toGrid } from '../util.js';
import { coverAt, mobilityAt } from './terrain.js';
import { setDestination } from './units.js';
import { enqueue, PRI } from './comms.js';

/** 交戦規定。部下がどこまで独断でやってよいか。 */
export const ROE = Object.freeze({
  hold_fast: {
    key: 'hold_fast',
    label: '死守',
    note: '一歩も退くな。士気は保つが、崩れれば全滅する。',
    allowWithdraw: false,
    moraleFloor: 12, // 崩れにくくなる
  },
  standard: {
    key: 'standard',
    label: '陣地防御',
    note: '陣地を保持する。持ちこたえられなければ独断で下がってよい。',
    allowWithdraw: true,
    moraleFloor: 0,
  },
  elastic: {
    key: 'elastic',
    label: '弾力防御',
    note: '圧されたら早めに下がり、態勢を立て直せ。土地より部隊を惜しむ。',
    allowWithdraw: true,
    eager: true,
    moraleFloor: 0,
  },
});

const ASSESS_INTERVAL = 12;

export function stepFriendlyInitiative(world, dt) {
  for (const u of world.units) {
    if (u.side !== 'friend' || !u.alive) continue;
    if (u.tpl.civilian) continue;
    if (world.now < (u._initNextAt ?? -Infinity)) continue;
    u._initNextAt = world.now + ASSESS_INTERVAL + world.rng.range(0, 6);

    applyRoeMorale(u);

    // 命令を実行している最中は口を出さない（後退の判断だけは別）
    const busy = !!u.order && u.order.state === 'executing';

    if (considerWithdrawal(world, u)) continue;
    if (busy) continue;

    digInWhenIdle(world, u);
  }
}

/** 死守を命じられた部隊は、そう簡単には崩れない */
function applyRoeMorale(u) {
  const roe = ROE[u.roe ?? 'standard'] ?? ROE.standard;
  if (roe.moraleFloor > 0 && u.morale < roe.moraleFloor) u.morale = roe.moraleFloor;
}

/**
 * 独断後退。
 * 「もう保たない」と判断したら、許されている範囲で下がる。
 * 下がったことは必ず報告する ― 黙って消えられるのが一番困る。
 */
function considerWithdrawal(world, u) {
  const roe = ROE[u.roe ?? 'standard'] ?? ROE.standard;
  if (!roe.allowWithdraw) return false;
  if (u.state === 'broken') return false; // 崩れているときは別処理
  if (u._selfWithdrawing) {
    // 下がりきったら掩体を掘って落ち着く
    if (!u.path.length) {
      u._selfWithdrawing = false;
      u.posture = 'dug_in';
      u.state = 'defending';
    }
    return true;
  }

  const hurt = u.strength / u.maxStrength;
  const pressed = u.suppression > 70 && world.now - u.lastHitAt < 20;
  const bleeding = hurt < (roe.eager ? 0.72 : 0.45);
  const shaken = u.morale < (roe.eager ? 48 : 32);

  if (!((bleeding && pressed) || shaken)) return false;
  // 一度下がったらしばらくは下がらない
  if (world.now - (u._lastSelfWithdrawAt ?? -Infinity) < 420) return false;

  const spot = findFallbackPosition(world, u);
  if (!spot) return false;

  u._lastSelfWithdrawAt = world.now;
  u._selfWithdrawing = true;
  u.state = 'withdrawing';
  u.posture = 'rapid';
  setDestination(u, world.terrain, spot.x, spot.y);

  if (u.commsOk) {
    enqueue(world, {
      from: u.callsign,
      fromId: u.id,
      kind: 'initiative',
      text:
        `こちら${u.callsign}、独断で下がる。ここは保たない。` +
        `${toGrid(spot.x, spot.y)}へ後退し、態勢を立て直す。事後承認を乞う。`,
      priority: PRI.FLASH,
      meta: { unitId: u.id, grid: toGrid(spot.x, spot.y), observedAt: world.now },
      composedAt: world.now,
    });
  }
  return true;
}

/** 後方で、遮蔽があり、敵から離れた地点を探す */
function findFallbackPosition(world, u) {
  const cp = world.commandPost;
  const away = Math.atan2(cp.y - u.y, cp.x - u.x);

  let best = null;
  for (let i = 0; i < 12; i++) {
    const a = away + (i - 6) * 0.26;
    const d = 320 + (i % 3) * 140;
    const x = clamp(u.x + Math.cos(a) * d, 60, 4740);
    const y = clamp(u.y + Math.sin(a) * d, 60, 3540);
    if (mobilityAt(world.terrain, x, y) <= 0) continue;

    // 敵から遠く、遮蔽のある所を好む
    let threat = 0;
    for (const c of u.contacts.values()) {
      if (world.now - c.lastSeenAt > 120) continue;
      threat += 1 / Math.max(120, dist(x, y, c.x, c.y));
    }
    const score = coverAt(world.terrain, x, y) * 2 - threat * 260;
    if (!best || score > best.score) best = { x, y, score };
  }
  return best;
}

/**
 * 手が空いていれば陣地を掘る。
 * 指揮官がいちいち「掘れ」と言わなくても、分隊長はそれくらいする。
 */
function digInWhenIdle(world, u) {
  if (u.tpl.flying || u.tpl.indirect) return;
  if (u.path.length) return;
  if (u.posture === 'dug_in' || u.posture === 'hasty') return;
  if (u.state === 'recon' || u.state === 'moving') return;
  if (u.weaponsHold && u.state === 'holding') return; // 監視中は姿勢を変えない
  // 静穏なら掘り始める
  if (world.now - u.lastHitAt < 90) return;
  if (world.now - (u._idleSince ?? world.now) < 120) {
    u._idleSince ??= world.now;
    return;
  }
  // 独断で掘れるのは応急の掩体まで。腰を据えた陣地は命令がなければ作らない。
  u.posture = 'hasty';
  u._idleSince = null;
}

/** 交戦規定を設定する（命令から呼ばれる） */
export function setRoe(u, key) {
  if (!ROE[key]) return false;
  u.roe = key;
  return true;
}
