// ユニットのモデル・生成・移動・被害適用。DOM非依存。

import { clamp, dist } from '../util.js';
import { mobilityAt, coverAt } from './terrain.js';
import { findPath } from './pathfind.js';

/**
 * 兵種テンプレート。
 * speed: m/s（平地）  spot: 索敵距離 m  range: 有効射程 m
 * firepower: 対人火力  ap: 対装甲火力  armor: 被小火器耐性 0..1
 */
export const UNIT_TYPES = Object.freeze({
  infantry: {
    label: '歩兵分隊', unitJa: '名', maxStrength: 9,
    speed: 1.25, spot: 720, range: 480, firepower: 1.0, ap: 0.5, armor: 0.0,
    ammoDrain: 1.0, maxAmmo: 100, radio: 1.0, skill: 0.72,
  },
  at_team: {
    label: '対戦車班', unitJa: '名', maxStrength: 5,
    speed: 1.15, spot: 820, range: 1600, firepower: 0.35, ap: 4.2, armor: 0.0,
    ammoDrain: 2.6, maxAmmo: 100, radio: 1.0, skill: 0.78,
  },
  recon: {
    label: '偵察班', unitJa: '名', maxStrength: 4,
    speed: 1.55, spot: 980, range: 300, firepower: 0.45, ap: 0.15, armor: 0.0,
    ammoDrain: 1.0, maxAmmo: 100, radio: 1.0, skill: 0.88,
  },
  mech: {
    label: '機械化歩兵', unitJa: '両', maxStrength: 3,
    speed: 3.4, spot: 760, range: 520, firepower: 1.35, ap: 0.9, armor: 0.35,
    ammoDrain: 1.2, maxAmmo: 100, radio: 1.0, skill: 0.68,
  },
  tank: {
    label: '戦車', unitJa: '両', maxStrength: 2,
    speed: 4.2, spot: 800, range: 1500, firepower: 2.0, ap: 2.6, armor: 0.88,
    ammoDrain: 1.4, maxAmmo: 100, radio: 1.0, skill: 0.7,
  },
  mortar: {
    label: '迫撃砲班', unitJa: '名', maxStrength: 6,
    speed: 0.95, spot: 380, range: 0, firepower: 0.2, ap: 0.05, armor: 0.0,
    ammoDrain: 1.0, maxAmmo: 100, radio: 1.0, skill: 0.7, indirect: 2800,
  },
  drone: {
    label: '偵察ドローン', unitJa: '機', maxStrength: 1,
    speed: 11, spot: 1100, range: 0, firepower: 0, ap: 0, armor: 0.0,
    ammoDrain: 0, maxAmmo: 100, radio: 1.0, skill: 0.96, flying: true,
  },
  convoy: {
    label: '車列', unitJa: '両', maxStrength: 5,
    speed: 3.0, spot: 260, range: 0, firepower: 0, ap: 0, armor: 0.08,
    ammoDrain: 0, maxAmmo: 0, radio: 0, skill: 0.3, civilian: true,
  },
  // 補給班。撃つためではなく、撃ち続けさせるためにいる。
  supply: {
    label: '補給班', unitJa: '名', maxStrength: 4,
    speed: 2.2, spot: 340, range: 200, firepower: 0.2, ap: 0.05, armor: 0.05,
    ammoDrain: 0.4, maxAmmo: 100, radio: 1.0, skill: 0.55, logistics: true,
  },
});

export const POSTURES = Object.freeze({
  normal: { label: '通常', speed: 1.0, exposure: 1.0, coverBonus: 0.0, spot: 1.0 },
  rapid: { label: '急速', speed: 1.55, exposure: 1.45, coverBonus: -0.12, spot: 0.75 },
  cautious: { label: '慎重', speed: 0.62, exposure: 0.62, coverBonus: 0.12, spot: 1.15 },
  stealth: { label: '隠密', speed: 0.45, exposure: 0.34, coverBonus: 0.18, spot: 1.3 },
  // 命令なしに分隊が自分で掻いた穴。無いよりはるかにましだが、
  // 工兵の手が入った陣地には及ばない。ここに差があるから命令に意味が出る。
  hasty: { label: '掩体（応急）', speed: 0.0, exposure: 0.62, coverBonus: 0.17, spot: 1.05 },
  dug_in: { label: '掩体', speed: 0.0, exposure: 0.42, coverBonus: 0.38, spot: 1.05 },
  // 一晩かけて構築した陣地。交通壕も掩蓋もある。
  // 半日の防御を命じられた部隊が夜通し掘っていた、その成果である。
  // 一度出れば二度と戻らない ── 陣地は持ち運べない。
  fortified: { label: '構築陣地', speed: 0.0, exposure: 0.3, coverBonus: 0.52, spot: 1.1 },
});

let nextId = 1;

/** ユニットを生成する */
export function createUnit(def) {
  const tpl = UNIT_TYPES[def.type];
  if (!tpl) throw new Error(`未知の兵種: ${def.type}`);

  return {
    id: def.id ?? `U${nextId++}`,
    side: def.side, // 'friend' | 'enemy' | 'civilian'
    callsign: def.callsign ?? '不明',
    type: def.type,
    tpl,

    x: def.x,
    y: def.y,
    heading: def.heading ?? 0,

    strength: def.strength ?? tpl.maxStrength,
    maxStrength: tpl.maxStrength,
    ammo: def.ammo ?? tpl.maxAmmo,
    morale: def.morale ?? 82,
    suppression: 0,
    fatigue: def.fatigue ?? 0,
    skill: def.skill ?? tpl.skill,

    state: def.state ?? 'holding',
    posture: def.posture ?? 'normal',
    path: [],
    dest: null,

    order: null, // 実行中の命令
    pendingOrder: null, // 送信中／受領待ちの命令
    lastOrderAt: -Infinity,

    // 認識（このユニットが「見えている」敵）
    contacts: new Map(),

    // 報告関連
    lastReportAt: -Infinity,
    reportedContactIds: new Set(),
    commsOk: true,
    commsLostSince: null,
    silentSince: null,

    // 射撃統制。true の間は撃たれるまで撃たない。
    weaponsHold: false,
    rallying: false,

    // 長期戦の管理項目
    resting: false,
    // 損害のうち、手当てをすれば戻ってくる者。長い戦闘ではこれが効いてくる。
    walkingWounded: 0,

    // 統計
    inflicted: 0,
    losses: 0,
    lastFiredAt: -Infinity,
    lastHitAt: -Infinity,
    alive: true,
    deathAt: null,
    killedByFriendly: false,

    ...def.extra,
  };
}

export function isCombatEffective(u) {
  return u.alive && u.strength > u.maxStrength * 0.34 && u.morale > 25;
}

export function isDestroyed(u) {
  return !u.alive;
}

/** 移動速度（m/s）。地形・態勢・被制圧・士気を反映。 */
export function currentSpeed(u, terrain) {
  const posture = POSTURES[u.posture] ?? POSTURES.normal;
  const mob = u.tpl.flying ? 1 : mobilityAt(terrain, u.x, u.y);
  // 経路の脚と脚の間で、通行不能な角をかすめてしまうことがある。
  // そこで速度を 0 にすると二度と動けなくなるので、這い出すぶんだけは残す。
  // 実際、川縁に踏み込んだ分隊は止まりはしても、戻ってくる。
  if (mob <= 0) return u.tpl.speed * 0.18;
  const suppressionFactor = 1 - clamp(u.suppression / 130, 0, 0.85);
  const fatigueFactor = 1 - clamp(u.fatigue / 260, 0, 0.35);
  return u.tpl.speed * mob * posture.speed * suppressionFactor * fatigueFactor;
}

/** 目的地を設定して経路を引く */
export function setDestination(u, terrain, x, y) {
  u.dest = { x, y };
  if (u.tpl.flying) {
    u.path = [{ x, y }];
  } else {
    const path = findPath(terrain, u.x, u.y, x, y);
    u.path = path.length ? path : [];
    if (!u.path.length) {
      // 到達不能。その場に留まる。
      u.dest = null;
    }
  }
}

export function clearDestination(u) {
  u.dest = null;
  u.path = [];
}

/** 1ティック分の移動処理 */
export function stepMovement(u, terrain, dt) {
  if (!u.alive) return;
  // 疲労の増減は logistics.js が一手に見る。
  // ここでも引いていたせいで、止まっている部隊の疲れが毎秒消えていた。
  if (!u.path.length) return;

  const speed = currentSpeed(u, terrain);
  if (speed <= 0) return;

  const fromX = u.x;
  const fromY = u.y;

  let budget = speed * dt;
  let guard = 0;
  while (budget > 0 && u.path.length && guard++ < 64) {
    const wp = u.path[0];
    const d = dist(u.x, u.y, wp.x, wp.y);
    if (d <= budget) {
      u.x = wp.x;
      u.y = wp.y;
      u.path.shift();
      budget -= d;
    } else {
      const t = budget / d;
      u.heading = Math.atan2(wp.y - u.y, wp.x - u.x);
      u.x += (wp.x - u.x) * t;
      u.y += (wp.y - u.y) * t;
      budget = 0;
    }
  }

  // 最後の砦。経路がどう引かれていようと、部隊は水の上や岩の上には立たない。
  // 踏み込みかけたらその一歩を戻し、経路を捨てて引き直させる ―
  // ここを見ていなかったので、川に入り込んで動けなくなる部隊が出ていた。
  if (!u.tpl.flying && mobilityAt(terrain, u.x, u.y) <= 0) {
    u.x = fromX;
    u.y = fromY;
    u.path = [];
    u.dest = null;
    u._blockedAt = u._blockedAt ?? 0;
    u._blockedAt++;
  }

  // 徒歩の消耗。急げばこたえるが、30分の前進で使い物にならなくなるほどではない。
  u.fatigue = Math.min(400, u.fatigue + dt * (u.posture === 'rapid' ? 0.13 : 0.06));

  if (!u.path.length) {
    u.dest = null;
    if (u.state === 'moving' || u.state === 'withdrawing') u.state = 'holding';
  }
}

/**
 * 被害を与える。
 * @param {number} amount 兵力（人／両）単位の損耗
 * @param {object} opts {friendly:boolean, suppression:number}
 */
export function applyDamage(u, amount, now, opts = {}) {
  if (!u.alive) return 0;
  const before = u.strength;
  u.strength = Math.max(0, u.strength - amount);
  const lost = before - u.strength;
  u.losses += lost;
  u.lastHitAt = now;
  if (opts.friendly && lost > 0) u.killedByFriendly = true;

  if (lost > 0) {
    // 損害は士気を削る。損耗の「割合」に比例させる。
    // 定数項を足すと毎ティック課金されて一瞬で崩壊するので入れない。
    const share = lost / u.maxStrength;
    u.morale = clamp(u.morale - share * 95, 0, 100);

    // 倒れた者が全員死ぬわけではない。手当てが届けば戻ってくる者がいる ―
    // 短い戦闘では誤差だが、半日守るならこれが最後の1個分隊を作る。
    // 装甲車輌は別（乗員は助かっても車輌は戻らない）。
    if (!u.tpl.armor || u.tpl.armor < 0.3) u.walkingWounded += lost * 0.3;
  }

  if (u.strength <= 0.05) {
    u.alive = false;
    u.strength = 0;
    u.state = 'destroyed';
    u.deathAt = now;
    u.path = [];
    u.dest = null;
  }
  return lost;
}

/** 制圧を加える */
export function applySuppression(u, amount) {
  if (!u.alive) return;
  u.suppression = clamp(u.suppression + amount, 0, 100);
}

/** 毎ティックの回復・士気判定 */
export function stepMorale(u, now, dt) {
  if (!u.alive) return;

  const underFire = now - u.lastHitAt < 12;
  if (!underFire) {
    u.suppression = Math.max(0, u.suppression - dt * 2.4);
  }

  // 制圧されていると士気が削れ、落ち着けば戻る
  if (u.suppression > 60) {
    u.morale = clamp(u.morale - dt * 0.055, 0, 100);
  } else if (!underFire && u.suppression < 20) {
    // 集結を命じられて後方へ下がっている間は立ち直りが早い
    u.morale = clamp(u.morale + dt * (u.rallying ? 0.34 : 0.13), 0, 100);
  }

  if (u.state !== 'broken' && u.morale < 22) {
    u.state = 'broken';
    u.posture = 'rapid';
  } else if (u.state === 'broken' && u.morale > 46) {
    u.state = 'holding';
    u.posture = 'normal';
    u.path = [];
    u.dest = null;
  }
}

/** 有効な遮蔽値（地形＋態勢） */
export function effectiveCover(u, terrain) {
  const posture = POSTURES[u.posture] ?? POSTURES.normal;
  // 死守を命じられた部隊は、退がる算段をしない分だけ深く掘る
  const resolve = u.roe === 'hold_fast' ? 0.06 : 0;
  return clamp(coverAt(terrain, u.x, u.y) + posture.coverBonus + resolve, 0, 0.92);
}

/** 日本語の状態表記 */
export function stateJa(u) {
  if (!u.alive) return '戦闘不能';
  switch (u.state) {
    case 'holding': return '現在地保持';
    case 'moving': return '移動中';
    case 'attacking': return '攻撃中';
    case 'defending': return '防御配置';
    case 'recon': return '偵察中';
    case 'withdrawing': return '後退中';
    case 'broken': return '統制喪失';
    default: return u.state;
  }
}

/** 士気の言語化（数値を出さない ― 指揮官は数値を見ない） */
export function moraleJa(m) {
  if (m >= 75) return '良好';
  if (m >= 55) return 'やや低下';
  if (m >= 35) return '動揺';
  if (m >= 22) return '危険';
  return '崩壊寸前';
}

export function strengthJa(u) {
  return `${Math.round(u.strength)}/${u.maxStrength}${u.tpl.unitJa}`;
}
