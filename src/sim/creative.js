// 演習モード ── 制約を外した盤。
//
// 本編は「足りない」ことでできている。弾は12発しかなく、部隊は6個しかなく、
// 一度死んだ分隊は戻らない。そこに指揮の重みがある。
//
// だが、指揮そのものを覚えるには、まず自由に触れたほうがよい。
// ここでは弾が減らず、部隊は好きなだけ呼べ、味方はほとんど倒れない。
// 敵を自分で置いて、戦い方を試すこともできる ―
// 演習場である。記録は残らない。

import { UNIT_TYPES } from './units.js';

export function createCreative(opts = {}) {
  if (!opts.enabled) return null;
  return {
    enabled: true,
    // 味方はほとんど倒れない
    invulnerable: opts.invulnerable ?? true,
    // 弾薬・砲弾は減らない
    unlimitedFires: opts.unlimitedFires ?? true,
    // 無線は遅れず、途切れず、化けない
    instantRadio: opts.instantRadio ?? true,
    // 真実の地図。既定では伏せてある（見た瞬間にゲームでなくなるので）。
    reveal: opts.reveal ?? false,
    // 呼んだ増援。部隊一覧と命令パネルに足される。
    roster: [],
    called: 0,
    enemiesPlaced: 0,
  };
}

/** 呼べる部隊。0コスト・即時。 */
export const REINFORCEMENTS = Object.freeze([
  { key: 'infantry', label: '歩兵分隊', icon: 'infantry', echelon: 1 },
  { key: 'at_team', label: '対戦車班', icon: 'antitank', echelon: 'Ø' },
  { key: 'recon', label: '偵察班', icon: 'infantry', echelon: 'Ø' },
  { key: 'mech', label: '機械化歩兵', icon: 'mech', echelon: 1 },
  { key: 'tank', label: '戦車', icon: 'armor', echelon: 1 },
  { key: 'mortar', label: '迫撃砲班', icon: 'artillery', echelon: 1 },
  { key: 'drone', label: '偵察ドローン', icon: 'uav', echelon: null },
  { key: 'supply', label: '補給班', icon: 'supply', echelon: 'Ø' },
]);

// 増援の呼出符号。既存の部隊とぶつからない名を使う。
const FRIEND_CALLSIGNS = [
  'ランス', 'セイバー', 'ハルバード', 'パイク', 'メイス', 'ダガー',
  'ジャベリン', 'ランパート', 'カトラス', 'グレイヴ', 'アンヴィル', 'キール',
];

const ENEMY_CALLSIGNS = [
  '敵甲', '敵乙', '敵丙', '敵丁', '敵戊', '敵己', '敵庚', '敵辛', '敵壬', '敵癸',
];

/**
 * 増援を呼ぶ。
 * @returns {object|null} 追加された部隊の編成定義（world 側で生成する）
 */
export function reinforcementDef(world, { type, x, y, side = 'friend' }) {
  const cre = world.creative;
  if (!cre) return null;
  if (!UNIT_TYPES[type]) return null;

  const spec = REINFORCEMENTS.find((r) => r.key === type);
  const label = spec?.label ?? UNIT_TYPES[type].label;

  if (side === 'enemy') {
    const n = cre.enemiesPlaced++;
    return {
      id: `CX${n + 1}`,
      side: 'enemy',
      callsign: ENEMY_CALLSIGNS[n % ENEMY_CALLSIGNS.length] + (n >= ENEMY_CALLSIGNS.length ? `-${Math.floor(n / ENEMY_CALLSIGNS.length) + 1}` : ''),
      type,
      x, y,
      posture: 'normal',
      state: 'holding',
      role: `演習で置いた${label}`,
      ai: { task: 'assault' },
    };
  }

  const n = cre.called++;
  const callsign =
    FRIEND_CALLSIGNS[n % FRIEND_CALLSIGNS.length] +
    (n >= FRIEND_CALLSIGNS.length ? `-${Math.floor(n / FRIEND_CALLSIGNS.length) + 1}` : '');
  const id = `CR${n + 1}`;

  cre.roster.push({
    id,
    callsign,
    typeLabel: label,
    role: '増援（演習）',
    icon: spec?.icon ?? 'infantry',
    echelon: spec?.echelon ?? 1,
  });

  return {
    id,
    side: 'friend',
    callsign,
    type,
    x, y,
    posture: 'normal',
    state: 'holding',
    morale: 92,
    role: '増援（演習）',
    extra: { invulnerable: !!cre.invulnerable },
  };
}

/** 演習では味方はほとんど倒れない。倒れないだけで、撃たれはする。 */
export const INVULNERABLE_DAMAGE = 0.05;

/** 演習で部隊を立て直す（兵力・弾薬・士気・疲労を戻す） */
export function replenish(u) {
  if (!u.alive) return false;
  u.strength = u.maxStrength;
  u.ammo = u.tpl.maxAmmo;
  u.morale = 92;
  u.suppression = 0;
  u.fatigue = 0;
  u.walkingWounded = 0;
  u._immobile = false;
  if (u.state === 'broken') u.state = 'holding';
  return true;
}
