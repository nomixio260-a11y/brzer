// 無線ネット。指揮官が得られる情報は全てここを通る。
// 「一度に喋れるのは一人だけ」「遅れる」「途切れる」「聞こえない」を作るための層。

import { clamp, dist, toGrid } from '../util.js';
import { lineOfSight } from './terrain.js';
import { moraleJa, stateJa, strengthJa } from './units.js';
import { fatigueJa } from './logistics.js';

export const PRI = Object.freeze({
  ROUTINE: 0,
  PRIORITY: 1,
  FLASH: 2, // 接敵・被弾・指揮官からの命令
});

let txSeq = 1;

export function createRadio() {
  return {
    queue: [],
    busyUntil: -Infinity,
    speaking: null,
    jamming: 0, // 0..1
    log: [],
    airtimeUsed: 0,
    droppedCount: 0,
  };
}

/**
 * 送信を待ち行列に入れる。
 * @param {object} tx {from, kind, text, priority, meta, composedAt}
 */
export function enqueue(world, tx) {
  const radio = world.radio;

  // 送信時点での「その部隊自身の様子」を添える。
  // 指揮官の手元にある部隊一覧は、この断片だけを積み上げて作られる。
  // ＝ 黙っている部隊の情報は、黙った時点で止まったままになる。
  const sender = tx.fromId ? world.unitsById.get(tx.fromId) : null;
  const meta = { ...(tx.meta ?? {}) };
  if (sender && sender.side === 'friend') {
    meta.self = {
      grid: toGrid(sender.x, sender.y),
      strength: strengthJa(sender),
      strengthRatio: sender.strength / sender.maxStrength,
      morale: moraleJa(sender.morale),
      state: stateJa(sender),
      posture: sender.posture,
      ammoRatio: sender.ammo / (sender.tpl.maxAmmo || 100),
      // 長期戦で効いてくるもの。これも「最後に聞いた時点」の話でしかない。
      fatigue: fatigueJa(sender),
      resting: !!sender.resting,
      wounded: sender.walkingWounded > 0.4,
    };
  }

  const entry = {
    id: `TX${txSeq++}`,
    from: tx.from ?? '不明局',
    fromId: tx.fromId ?? null,
    kind: tx.kind ?? 'report',
    text: tx.text,
    priority: tx.priority ?? PRI.ROUTINE,
    meta,
    composedAt: tx.composedAt ?? world.now,
    outbound: !!tx.outbound, // 指揮官 → 部隊
    // 演習では網は空いている。命令の練習をしたいのに、
    // 順番待ちで届かないのでは意味がない。
    duration: world.creative?.instantRadio ? 0.4 : (tx.duration ?? 5 + tx.text.length * 0.16),
  };
  radio.queue.push(entry);
  return entry;
}

/** 無線ネットを1ティック進める。送信が完了したものをログに落とす。 */
export function stepComms(world, dt) {
  const radio = world.radio;
  const now = world.now;
  const delivered = [];

  if (now < radio.busyUntil) {
    radio.airtimeUsed += dt;
    return delivered;
  }

  // 送信中だったものを完了させる
  if (radio.speaking) {
    const tx = radio.speaking;
    radio.speaking = null;
    finishTransmission(world, tx, delivered);
  }

  if (!radio.queue.length) return delivered;

  // 優先度が高く、古いものから
  radio.queue.sort((a, b) => b.priority - a.priority || a.composedAt - b.composedAt);

  // 送信元が既に全滅していれば送信そのものが起きない。
  // 死んだ局が続いていても再帰せずに読み飛ばす。
  let tx = null;
  while (radio.queue.length) {
    const candidate = radio.queue.shift();
    const sender = candidate.fromId ? world.unitsById.get(candidate.fromId) : null;
    if (sender && !sender.alive && !candidate.outbound) {
      radio.droppedCount++;
      continue;
    }
    tx = candidate;
    break;
  }
  if (!tx) return delivered;

  radio.speaking = tx;
  tx.startedAt = now;
  radio.busyUntil = now + tx.duration;
  radio.airtimeUsed += dt;

  return delivered;
}

function finishTransmission(world, tx, delivered) {
  const radio = world.radio;
  const now = world.now;

  // 通信状態の判定。
  // 部隊→指揮所は送信元の、指揮所→部隊は受信側の電波状態で決まる。
  let quality = 1;
  if (!world.creative?.instantRadio) {
    const counterpartId = tx.outbound ? tx.meta?.toId : tx.fromId;
    const counterpart = counterpartId ? world.unitsById.get(counterpartId) : null;
    if (counterpart) {
      quality = commsQuality(world, counterpart);
    }
    quality *= 1 - radio.jamming * 0.85;
  }

  if (quality < 0.18) {
    radio.droppedCount++;
    // 指揮官が発した命令は「言ったが返事がない」形で残る。
    // 部隊からの報告は「何か言おうとした気配」だけが残る。
    radio.log.push({
      id: tx.id,
      at: now,
      from: tx.from,
      fromId: tx.fromId,
      kind: tx.outbound ? 'order' : 'static',
      priority: tx.priority,
      text: tx.outbound ? tx.text : '……ザザッ……（受信不能）……',
      garbled: true,
      lost: true,
      meta: tx.meta,
      composedAt: tx.composedAt,
      outbound: tx.outbound,
      observedAt: tx.meta?.observedAt ?? tx.composedAt,
    });
    delivered.push(radio.log[radio.log.length - 1]);
    return;
  }

  let text = tx.text;
  let garbled = false;
  if (quality < 0.62 && !tx.outbound) {
    text = garble(text, world.rng, 1 - quality);
    garbled = true;
  }

  const entry = {
    id: tx.id,
    at: now,
    from: tx.from,
    fromId: tx.fromId,
    kind: tx.kind,
    priority: tx.priority,
    text,
    garbled,
    lost: false,
    meta: tx.meta,
    composedAt: tx.composedAt,
    outbound: tx.outbound,
    // 「いつ見た情報か」= 鮮度。指揮官が判断するのに要る。
    observedAt: tx.meta?.observedAt ?? tx.composedAt,
  };
  radio.log.push(entry);
  delivered.push(entry);
}

/** ノイズで文字を潰す */
function garble(text, rng, severity) {
  const chars = [...text];
  const noise = ['……', 'ザッ', '…ピー…', '……ガッ'];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    if (rng.chance(severity * 0.28)) {
      if (rng.chance(0.35)) out += rng.pick(noise);
      // 文字自体は落とす
    } else {
      out += chars[i];
    }
  }
  return out;
}

/**
 * 指揮所とユニットの間の通信品質 0..1。
 * 谷底・稜線の裏・遠距離で落ちる。
 */
export function commsQuality(world, u) {
  if (!u.alive) return 0;
  if (u.tpl.radio <= 0) return 0;
  const cp = world.commandPost;
  const d = dist(cp.x, cp.y, u.x, u.y);

  // アンテナ高を取って見通しを稼ぐ。植生は電波を止めないので無視する。
  const los = lineOfSight(world.terrain, cp.x, cp.y, u.x, u.y, 28, u.tpl.flying ? 80 : 2.2, {
    ignoreVegetation: true,
  });

  const rangeFactor = clamp(1 - Math.pow(d / 5200, 1.7), 0.1, 1);
  // 稜線に切られても完全には切れない（回折・中継）
  const losFactor = los.visible ? 0.55 + los.quality * 0.45 : 0.16;

  return clamp(rangeFactor * losFactor * u.tpl.radio, 0, 1);
}

/** 各ユニットの通信状態を更新し、途絶・復旧のイベントを返す */
export function stepCommsStatus(world, dt) {
  const events = [];
  for (const u of world.units) {
    if (!u.alive || u.side !== 'friend') continue;
    const q = world.creative?.instantRadio ? 1 : commsQuality(world, u);
    const ok = q >= 0.18;
    if (ok !== u.commsOk) {
      u.commsOk = ok;
      if (!ok) {
        u.commsLostSince = world.now;
        events.push({ type: 'comms_lost', unitId: u.id });
      } else {
        u.commsLostSince = null;
        events.push({ type: 'comms_restored', unitId: u.id });
      }
    }
    u.commsQuality = q;
  }
  return events;
}

/** 無線の混雑度 0..1（HUD 表示用） */
export function congestion(world) {
  const q = world.radio.queue.length;
  return clamp(q / 6, 0, 1);
}
