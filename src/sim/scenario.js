// ミッション定義「橋梁死守」。地理・戦闘序列・展開・勝敗条件をデータとして持つ。

import { parseClock, toGrid, dist } from '../util.js';
import { riverCenterY } from './terrain.js';

const T0 = parseClock('0700');
const TEND = parseClock('0900');

// 地名は地形から引く。手で書くと地形をいじった瞬間に嘘になる。
const BRIDGE_X = 2200;
const FORD_X = 4180;
export const BRIDGE_GRID = toGrid(BRIDGE_X, riverCenterY(BRIDGE_X));
export const FORD_GRID = toGrid(FORD_X, riverCenterY(FORD_X));

export const MISSION = Object.freeze({
  id: 'bridge_hold',
  title: '橋梁死守',
  subtitle: 'ヴォルネ川 / 第3中隊戦闘団',
  seed: 20260726,
  startTime: T0,
  endTime: TEND,

  commandPost: { x: 1150, y: 2560 }, // 西の高地。見通しが利く＝無線が届く。

  briefing: {
    situation:
      'ヴォルネ川に架かる唯一の橋梁が敵の主攻正面にある。橋を渡られれば、後方の第2大隊の側面が開く。' +
      '敵は昨夜のうちに北岸に前進しており、払暁からの攻撃が予期される。' +
      '河谷には川霧が立ち込めている。0830頃までは晴れない。',
    mission:
      `0900に到着する増援部隊が展開を終えるまで、橋梁 ${BRIDGE_GRID} を確保せよ。` +
      '橋の南岸を敵に渡らせてはならない。',
    execution:
      '貴官は指揮所から出られない。前線は見えない。地図と無線だけが判断材料である。' +
      '部下の報告は遅れ、ずれ、時に間違う。それでも決断せよ。',
    notes: [
      '砲兵「ソーン」は12発しか持たない。撃つ場所は貴官が決める。',
      '砲弾は敵味方を区別しない。マーカーが間違っていれば、味方の上に落ちる。',
      `東（${FORD_GRID}付近）に浅瀬がある。渡れるのは橋だけではない。`,
      '無線は同時に一人しか使えない。聞きすぎれば、肝心の報告が遅れる。',
      '川霧が晴れるまで、谷底の部隊はほとんど見えない。上空のドローンだけが霧を見下ろせる。',
      '射撃統制を命じておけば、撃たないぶん位置が割れにくい。監視に徹した部隊は遠くまで見える。',
    ],
  },

  objectives: [
    { id: 'hold_bridge', text: `0900まで橋梁 ${BRIDGE_GRID} を確保する`, primary: true },
    { id: 'keep_force', text: '2個分隊以上を戦闘可能な状態で維持する', primary: true },
    { id: 'civilians', text: '民間車列を安全に通過させる', primary: false },
  ],

  support: {
    artillery: { name: 'ソーン', rounds: 12 },
    smoke: { name: 'ソーン', rounds: 6 },
  },
});

/* ------------------------------------------------------------------ */
/* 戦闘序列                                                             */
/* ------------------------------------------------------------------ */

export function friendlyOrderOfBattle() {
  return [
    {
      id: 'H1', side: 'friend', callsign: 'ハンマー1', type: 'infantry',
      x: 2200, y: 1900, posture: 'dug_in', state: 'defending', morale: 84,
      role: '橋梁南詰の主陣地',
    },
    {
      id: 'H2', side: 'friend', callsign: 'ハンマー2', type: 'infantry',
      x: 2160, y: 2300, posture: 'dug_in', state: 'defending', morale: 84,
      role: '集落（F6）の予備陣地',
    },
    {
      id: 'H3', side: 'friend', callsign: 'ハンマー3', type: 'infantry',
      x: 2380, y: 1180, posture: 'cautious', state: 'holding', morale: 78,
      role: '北岸の前進哨所 ― 早期警戒',
    },
    {
      id: 'SW', side: 'friend', callsign: 'ソード', type: 'at_team',
      x: 1760, y: 2420, posture: 'normal', state: 'holding', morale: 86,
      role: '対戦車予備',
    },
    {
      id: 'EG', side: 'friend', callsign: 'イーグル', type: 'drone',
      x: 1150, y: 2560, posture: 'normal', state: 'holding', morale: 100,
      role: '偵察ドローン',
    },
    {
      id: 'TH', side: 'friend', callsign: 'ソーン', type: 'mortar',
      x: 1240, y: 3400, posture: 'dug_in', state: 'defending', morale: 90,
      role: '支援砲兵（後方）',
    },
  ];
}

/**
 * 展開イベント。時刻順に発火する。
 * kind: 'spawn' | 'jamming' | 'message'
 *
 * opts.variable が真なら、敵の企図そのものを振る ―
 * どちらの軸が主攻か、時刻はいつか。二度目以降は地図を覚えていても
 * 「今日はどっちだ」を無線から読み直さねばならない。
 */
export function timeline(rng, opts = {}) {
  const riverAtFord = riverCenterY(4180);

  // 主攻は東の浅瀬か、橋の正面か。
  const eastIsMain = opts.variable && rng ? rng.chance(0.5) : true;
  const jitter = (base, spread) =>
    opts.variable && rng ? base + Math.round(rng.range(-spread, spread) / 60) * 60 : base;

  // 主攻側に1個分隊多く、助攻側は1個減らす
  const eastSquads = eastIsMain ? 2 : 1;
  const bridgeExtra = eastIsMain ? 0 : 1;

  const eastUnits = [
    { id: 'E-F1', side: 'enemy', callsign: '敵歩兵2', type: 'infantry', x: 4430, y: 760,
      ai: { task: 'flank', crossing: { x: 4180, y: riverAtFord }, objective: { x: 2500, y: 2280 } } },
    { id: 'E-F2', side: 'enemy', callsign: '敵歩兵3', type: 'infantry', x: 4560, y: 880,
      ai: { task: 'flank', crossing: { x: 4180, y: riverAtFord }, objective: { x: 2600, y: 2180 } } },
  ].slice(0, eastSquads).concat([
    { id: 'E-F4', side: 'enemy', callsign: '敵対戦車班', type: 'at_team', x: 4520, y: 1040,
      ai: { task: 'flank', crossing: { x: 4180, y: riverAtFord }, objective: { x: 3000, y: 2200 } } },
  ]);

  const bridgeExtraUnits = bridgeExtra
    ? [{ id: 'E-I2', side: 'enemy', callsign: '敵歩兵5', type: 'infantry', x: 2460, y: 100,
         ai: { task: 'assault', objective: { x: 2200, y: 2100 }, crossing: { x: 2200, y: riverCenterY(2200) } } }]
    : [];

  return [
    {
      at: parseClock('0712'),
      kind: 'spawn',
      label: '敵斥候',
      units: [
        { id: 'E-R1', side: 'enemy', callsign: '敵斥候1', type: 'recon', x: 2650, y: 180,
          ai: { task: 'probe', objective: { x: 2400, y: 1050 } } },
        { id: 'E-R2', side: 'enemy', callsign: '敵斥候2', type: 'recon', x: 1750, y: 240,
          ai: { task: 'probe', objective: { x: 1900, y: 1250 } } },
      ],
    },
    {
      at: jitter(parseClock('0738'), 300),
      kind: 'spawn',
      label: '北岸への圧力（陽動）',
      units: [
        { id: 'E-M1', side: 'enemy', callsign: '敵機械化1', type: 'mech', x: 2320, y: 60,
          ai: { task: 'pressure', objective: { x: 2330, y: 1300 } } },
        { id: 'E-M2', side: 'enemy', callsign: '敵機械化2', type: 'mech', x: 2700, y: 120,
          ai: { task: 'pressure', objective: { x: 2560, y: 1250 } } },
        { id: 'E-I1', side: 'enemy', callsign: '敵歩兵1', type: 'infantry', x: 2100, y: 140,
          ai: { task: 'pressure', objective: { x: 2150, y: 1300 } } },
        { id: 'E-MT', side: 'enemy', callsign: '敵迫撃砲', type: 'mortar', x: 2620, y: 320,
          ai: { task: 'support' } },
      ],
    },
    {
      at: jitter(parseClock('0757'), 300),
      kind: 'jamming',
      value: 0.32,
      label: '電子妨害開始',
    },
    {
      at: jitter(parseClock('0754'), 420),
      kind: 'spawn',
      label: eastIsMain ? '東の浅瀬への迂回（主攻）' : '東の浅瀬への迂回（助攻）',
      units: eastUnits,
    },
    {
      // 予備。集結地で待ち、どちらの軸が通っているかを見てから投じられる。
      at: jitter(parseClock('0748'), 300),
      kind: 'spawn',
      label: '敵の予備（集結地）',
      units: [
        { id: 'E-RS1', side: 'enemy', callsign: '敵予備1', type: 'mech', x: 3250, y: 240,
          ai: { task: 'reserve' } },
        { id: 'E-RS2', side: 'enemy', callsign: '敵予備2', type: 'infantry', x: 3380, y: 330,
          ai: { task: 'reserve' } },
      ],
    },
    {
      at: parseClock('0814'),
      kind: 'spawn',
      label: '民間車列',
      units: [
        { id: 'CIV', side: 'civilian', callsign: '民間車列', type: 'convoy', x: 2150, y: 3480,
          ai: { task: 'transit', waypoints: [{ x: 2200, y: 2280 }, { x: 2200, y: 1750 }, { x: 2380, y: 900 }, { x: 2320, y: 40 }] } },
      ],
    },
    {
      at: jitter(parseClock('0826'), 420),
      kind: 'spawn',
      label: '装甲部隊の突進',
      units: [
        { id: 'E-T1', side: 'enemy', callsign: '敵戦車1', type: 'tank', x: 2340, y: 40,
          ai: { task: 'assault', objective: { x: 2200, y: 2150 }, crossing: { x: 2200, y: riverCenterY(2200) } } },
        { id: 'E-M3', side: 'enemy', callsign: '敵機械化3', type: 'mech', x: 2180, y: 40,
          ai: { task: 'assault', objective: { x: 2150, y: 2050 }, crossing: { x: 2200, y: riverCenterY(2200) } } },
        ...bridgeExtraUnits,
      ],
    },
    {
      at: parseClock('0850'),
      kind: 'message',
      text: '大隊本部より: 増援は0900に到着予定。それまで持ちこたえよ。',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 勝敗判定                                                             */
/* ------------------------------------------------------------------ */

const BRIDGE_RADIUS = 300;
const LOSS_GRACE = 200; // 橋を敵に占拠され続けたら負け（秒）

/**
 * 現在の戦況を評価する。毎ティック呼ばれる。
 * @returns {{status:string, reason?:string}}
 */
export function evaluate(world) {
  const bridge = world.terrain.bridge;

  const friendlySquads = world.units.filter(
    (u) => u.side === 'friend' && (u.type === 'infantry' || u.type === 'at_team')
  );
  const effective = friendlySquads.filter((u) => u.alive && u.strength > u.maxStrength * 0.34 && u.morale > 25);

  const enemyAtBridge = world.units.filter(
    (u) => u.side === 'enemy' && u.alive && dist(u.x, u.y, bridge.x, bridge.y) < BRIDGE_RADIUS
  );
  const friendlyAtBridge = world.units.filter(
    (u) => u.side === 'friend' && u.alive && u.tpl.range > 0 &&
      dist(u.x, u.y, bridge.x, bridge.y) < BRIDGE_RADIUS * 1.4
  );

  // 橋を敵だけが占めている状態が続くと陥落
  if (enemyAtBridge.length > 0 && friendlyAtBridge.length === 0) {
    world.bridgeLostSince ??= world.now;
  } else {
    world.bridgeLostSince = null;
  }
  if (world.bridgeLostSince != null && world.now - world.bridgeLostSince > LOSS_GRACE) {
    return { status: 'defeat', reason: '橋梁を敵に奪取された。増援の展開前に戦線が破れた。' };
  }

  if (effective.length === 0) {
    return { status: 'defeat', reason: '戦闘可能な部隊が失われた。防御は成立しない。' };
  }

  if (world.now < world.mission.endTime) return { status: 'ongoing' };

  // --- 0900 到達 ---
  // 南岸に「橋頭堡」が残ったかどうか。半壊した部隊は橋頭堡とは呼べない。
  // 頭数ではなく戦闘力で測る。斥候が2つ居残っても橋頭堡とは呼ばない。
  const bridgehead = world.units
    .filter(
      (u) =>
        u.side === 'enemy' &&
        u.alive &&
        u.type !== 'recon' &&
        u.strength > u.maxStrength * 0.4 &&
        u.y > riverCenterY(u.x) + 80
    )
    .reduce((s, u) => s + u.strength / u.maxStrength, 0);

  // 橋の上に敵がいても、こちらがまだ橋を押さえているなら「奪われた」ではない。
  if (enemyAtBridge.length > 0 && friendlyAtBridge.length === 0) {
    return { status: 'defeat', reason: '0900時点で橋梁は敵の手にある。増援は展開できない。' };
  }
  if (enemyAtBridge.length > 0) {
    return {
      status: 'narrow',
      reason: '橋の上でまだ撃ち合っている。渡らせてはいないが、確保したとは言えない状態で増援を迎えた。',
    };
  }
  if (bridgehead >= 3.5) {
    return {
      status: 'narrow',
      reason: '橋は保持したが、南岸に敵の橋頭堡が残った。増援は掃討から始めることになる。',
    };
  }
  if (effective.length <= 1) {
    return { status: 'narrow', reason: '橋は守り抜いた。だが中隊は事実上壊滅した。' };
  }
  return { status: 'victory', reason: '橋梁を確保したまま増援を迎えた。防御は成功である。' };
}

/** デブリーフ用の採点 */
export function scoreMission(world, outcome) {
  const friendly = world.units.filter((u) => u.side === 'friend' && u.tpl.range >= 0 && !u.tpl.civilian);
  const losses = friendly.reduce((s, u) => s + u.losses, 0);
  const civ = world.units.filter((u) => u.side === 'civilian');
  const civLosses = civ.reduce((s, u) => s + u.losses, 0);
  const friendlyFire = world.units.filter((u) => u.side === 'friend' && u.killedByFriendly).length;
  const enemyLosses = world.units
    .filter((u) => u.side === 'enemy')
    .reduce((s, u) => s + u.losses, 0);

  const responses = world.stats.responseTimes;
  const avgResponse = responses.length
    ? responses.reduce((a, b) => a + b, 0) / responses.length
    : 0;

  return {
    outcome,
    losses: Math.round(losses),
    enemyLosses: Math.round(enemyLosses),
    civilianLosses: Math.round(civLosses),
    friendlyFireUnits: friendlyFire,
    ordersIssued: world.stats.ordersIssued,
    ordersRefused: world.stats.ordersRefused,
    heldOrders: world.stats.heldOrders ?? 0,
    heldOrdersFired: world.orders.filter((o) => o.firedAt != null).length,
    selfWithdrawals: world.units.filter((u) => u.side === 'friend' && u._lastSelfWithdrawAt != null).length,
    fireMissions: world.stats.fireMissions,
    registeredMissions: world.stats.registeredMissions ?? 0,
    artilleryLeft: world.support.artillery.rounds,
    avgResponse,
    airtimeRatio: world.radio.airtimeUsed / Math.max(1, world.now - world.mission.startTime),
    droppedTransmissions: world.radio.droppedCount,
  };
}

export { BRIDGE_RADIUS };
