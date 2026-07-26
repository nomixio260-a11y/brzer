// ミッション定義「橋梁死守」。地理・戦闘序列・展開・勝敗条件をデータとして持つ。

import { parseClock, toGrid, dist, formatClock } from '../util.js';
import { riverCenterY } from './terrain.js';
import { MISSION_PASS, MISSION_TOWN } from './missions.js';

const T0 = parseClock('0700');
const TEND = parseClock('0900');

// 地名は地形から引く。手で書くと地形をいじった瞬間に嘘になる。
const BRIDGE_X = 2200;
const FORD_X = 4180;
export const BRIDGE_GRID = toGrid(BRIDGE_X, riverCenterY(BRIDGE_X));
export const FORD_GRID = toGrid(FORD_X, riverCenterY(FORD_X));

export const MISSION = Object.freeze({
  id: 'bridge_hold',
  mapId: 'volne_river',
  victory: { kind: 'hold_point', label: 'ヴォルネ橋' },
  phases: [
    { at: '0700', label: '静穏' }, { at: '0712', label: '警戒' },
    { at: '0738', label: '接敵' }, { at: '0800', label: '交戦中' },
    { at: '0845', label: '最終局面' },
  ],
  title: '橋梁死守',
  blurb: '一度の攻撃を凌ぎ切れるか。まずはここから。',
  subtitle: 'ヴォルネ川 / 第3中隊戦闘団',
  duration: 'short',
  seed: 20260726,
  startTime: T0,
  endTime: TEND,

  // 天候。霧が晴れる時刻はミッションごとに違う。
  weather: { mistStart: T0, mistClear: parseClock('0835') },

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
      '橋の北詰に鉄条網が敷いてある。渡ってくる敵は、そこで足が鈍る。',
      '装甲の正面は抜けない。対戦車班「ソード」を、横腹を取れる位置に置くこと。',
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
/* 長期戦「持久」 ─ 0430から1300まで                                     */
/* ------------------------------------------------------------------ */

const L0 = parseClock('0430');
const LEND = parseClock('1045');

/**
 * 半日守る戦い ─ 夜明け前から昼前まで。
 *
 * 短期戦が「一度の攻撃を凌げるか」なら、こちらは「凌ぎ続けられるか」である。
 * 敵は三度攻めてきて、そのたびに退がって再編する。攻撃の合間には
 * 一時間近い静穏がある ── その時間をどう使うかが、この戦闘の本体になる。
 *
 *   撃てば弾が減る。減れば運ばねばならず、運ぶ者は前線で無防備になる。
 *   夜通し起きていれば鈍る。休ませれば見張りが薄くなる。
 *   倒れた者の一部は、手当てが届けば戻ってくる。
 *
 * 位置ではなく「あと何時間戦えるか」を管理する ── それが長期戦の指揮である。
 */
export const MISSION_LONG = Object.freeze({
  id: 'bridge_hold_long',
  mapId: 'volne_river',
  victory: { kind: 'hold_point', label: 'ヴォルネ橋' },
  phases: [
    { at: '0430', label: '夜間・警戒' }, { at: '0505', label: '斥候接触' },
    { at: '0540', label: '第一波' }, { at: '0645', label: '静穏 ─ 再編' },
    { at: '0800', label: '第二波' }, { at: '0905', label: '静穏 ─ 再編' },
    { at: '0950', label: '第三波' }, { at: '1020', label: '最終局面' },
  ],
  title: '橋梁持久',
  blurb: '三度の攻撃を、弾と体力を切らさずに凌ぐ。補給と休養の管理が要る。',
  subtitle: 'ヴォルネ川 / 第3中隊戦闘団 ─ 半日の防御',
  duration: 'long',
  seed: 20260726,
  startTime: L0,
  endTime: LEND,

  // 夜明け前から始まり、日が高くなり、午後にまた谷が翳る
  weather: {
    mistStart: L0,
    mistClear: parseClock('0820'),
    eveningMistFrom: null,
  },

  commandPost: { x: 1150, y: 2560 },

  // 弾薬集積所と補給班。長期戦にだけ存在する。
  trains: {
    unitId: 'LD',
    loads: 10,
    dump: { x: 1180, y: 3020 },
  },

  briefing: {
    situation:
      'ヴォルネ川に架かる唯一の橋梁が敵の主攻正面にある。橋を渡られれば、後方の第2大隊の側面が開く。' +
      '敵は一個大隊規模で、夜明け前から日中いっぱいをかけて攻めてくると見られる。' +
      '一度の攻撃で決着はつかない ─ 敵は退がり、再編し、また来る。',
    mission:
      `1045に到着する増援部隊が展開を終えるまで、橋梁 ${BRIDGE_GRID} を確保せよ。` +
      '6時間余である。撃ち尽くさず、消耗し尽くさずに持ちこたえよ。',
    execution:
      '貴官は指揮所から出られない。前線は見えない。地図と無線だけが判断材料である。' +
      '攻撃の合間の静穏をどう使うか ─ 補給か、休養か、陣地の構築か ─ それが半日を分ける。',
    notes: [
      '弾薬は有限である。撃ち続ければ尽きる。「ラーダー」が10基数を運べるが、往復には時間がかかる。',
      '補給班は前線へ出ていく間じゅう無防備である。攻撃の最中に呼べば、弾ではなく死体が届く。',
      '部隊は疲れる。静穏な時間に休止を命じておかねば、午後には当たらなくなる。',
      '倒れた者の一部は軽傷である。手当てが行き届けば戦列に戻る ─ ただし静かにしていられればの話だ。',
      '夜明け前は何も見えない。敵が薄明を選ぶのはそのためである。',
      `東（${FORD_GRID}付近）に浅瀬がある。渡れるのは橋だけではない。`,
      '砲兵「ソーン」は24発持つ。半日ぶんである。最初の攻撃で撃ち尽くすな。',
      '照明弾が8発ある。夜明け前の攻撃は、これが無ければ見えないまま受けることになる。',
    ],
  },

  objectives: [
    { id: 'hold_bridge', text: `1045まで橋梁 ${BRIDGE_GRID} を確保する`, primary: true },
    { id: 'keep_force', text: '2個分隊以上を戦闘可能な状態で維持する', primary: true },
    { id: 'sustain', text: '弾薬と体力を切らさずに三度の攻撃を凌ぐ', primary: false },
    { id: 'civilians', text: '民間車列を安全に通過させる', primary: false },
  ],

  support: {
    artillery: { name: 'ソーン', rounds: 24 },
    smoke: { name: 'ソーン', rounds: 10 },
  },

  rosterOrder: [
    { id: 'H1', callsign: 'ハンマー1', typeLabel: '歩兵分隊', role: '橋梁南詰の主陣地', icon: 'infantry', echelon: 1 },
    { id: 'H2', callsign: 'ハンマー2', typeLabel: '歩兵分隊', role: '集落の予備陣地', icon: 'infantry', echelon: 1 },
    { id: 'H3', callsign: 'ハンマー3', typeLabel: '歩兵分隊', role: '北岸の前進哨所', icon: 'infantry', echelon: 1 },
    { id: 'H4', callsign: 'ハンマー4', typeLabel: '歩兵分隊', role: '東翼・浅瀬の監視', icon: 'infantry', echelon: 1 },
    { id: 'SW', callsign: 'ソード', typeLabel: '対戦車班', role: '対戦車予備', icon: 'antitank', echelon: 'Ø' },
    { id: 'EG', callsign: 'イーグル', typeLabel: '偵察ドローン', role: '偵察', icon: 'uav', echelon: null },
    { id: 'TH', callsign: 'ソーン', typeLabel: '支援砲兵', role: '火力支援', icon: 'artillery', echelon: 1 },
    { id: 'LD', callsign: 'ラーダー', typeLabel: '補給班', role: '弾薬・後送', icon: 'supply', echelon: 'Ø' },
    { id: 'H5', callsign: 'ハンマー5', typeLabel: '歩兵分隊', role: '増加配属（0905到着予定）', icon: 'infantry', echelon: 1 },
  ],
});

export const MISSIONS = Object.freeze({
  [MISSION.id]: MISSION,
  [MISSION_LONG.id]: MISSION_LONG,
  [MISSION_PASS.id]: MISSION_PASS,
  [MISSION_TOWN.id]: MISSION_TOWN,
});

/** 選択画面に出す順 */
export function missionList() {
  return [MISSION, MISSION_LONG, MISSION_PASS, MISSION_TOWN];
}

export function getMission(id) {
  return MISSIONS[id] ?? MISSION;
}

/* ------------------------------------------------------------------ */
/* 戦闘序列                                                             */
/* ------------------------------------------------------------------ */

export function friendlyOrderOfBattle(mission = MISSION) {
  // ミッションが自前の編成を持っていればそれを使う
  if (mission.orbat) return mission.orbat(mission);

  const long = mission.duration === 'long';
  // 半日守れという命令には、それに見合う編成が付く。
  // 一個中隊 ─ 小銃4個分隊に対戦車班、迫撃砲、無人機、そして段列。
  const extra = long
    ? [
        {
          id: 'H4', side: 'friend', callsign: 'ハンマー4', type: 'infantry',
          x: 3560, y: 2360, posture: 'dug_in', state: 'defending', morale: 82,
          role: '東翼 ― 浅瀬の監視',
        },
        {
          id: 'LD', side: 'friend', callsign: 'ラーダー', type: 'supply',
          x: mission.trains.dump.x, y: mission.trains.dump.y,
          posture: 'dug_in', state: 'holding', morale: 80,
          role: '弾薬集積所・補給班',
        },
      ]
    : [];

  // 夜明け前から起きている部隊は、最初から少し疲れている
  const fatigue = long ? 60 : 0;

  return [
    {
      // 南詰の主陣地。川は y≈2011 を流れているので、南岸とは y がそれより
      // 大きい側である ─ ここを取り違えると、補給が橋を渡る羽目になる。
      id: 'H1', side: 'friend', callsign: 'ハンマー1', type: 'infantry',
      x: 2200, y: 2150, posture: 'dug_in', state: 'defending', morale: 84,
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
    ...extra,
  ].map((d) => {
    if (d.type === 'supply') return d;
    // 半日の防御を命じられた部隊は、夜のうちに陣地を構築している。
    // 一度そこを出れば、掘り直しても同じものにはならない。
    const posture = long && d.posture === 'dug_in' ? 'fortified' : d.posture;
    return { ...d, posture, fatigue };
  });
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
  const mission = opts.mission ?? MISSION;
  if (mission.timeline) return mission.timeline(rng, opts);
  if (mission.duration === 'long') return longTimeline(rng, opts);
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
/* 長期戦の展開 ─ 三波の攻撃と、その間の静穏                              */
/* ------------------------------------------------------------------ */

/**
 * 波状攻撃。
 *
 * 一度の突撃で橋が落ちないことは、敵にも分かっている。だから三度に分ける。
 * 各波のあいだには40分から1時間の静穏があり、そこで敵は再編し、
 * こちらは補給と休養と陣地の構築をする。
 *
 * 静穏は「何も起きない時間」ではない。**次の攻撃を凌ぐ準備をする時間**であり、
 * 使い方を誤ればそのまま負ける。長期戦の勝負はここでつく。
 */
function longTimeline(rng, opts = {}) {
  const riverAtFord = riverCenterY(4180);
  const bridgeCross = { x: 2200, y: riverCenterY(2200) };
  const fordCross = { x: 4180, y: riverAtFord };

  const jitter = (base, spread) =>
    opts.variable && rng ? base + Math.round(rng.range(-spread, spread) / 60) * 60 : base;

  // 主攻がどちらに来るかは波ごとに変わりうる。二波目で切り替えるのが敵の常套。
  const secondWaveEast = opts.variable && rng ? rng.chance(0.6) : true;

  const events = [];

  /* --- 夜明け前：斥候の潜入 ------------------------------------- */
  events.push({
    at: parseClock('0448'),
    kind: 'message',
    text: '大隊本部より: 各哨所、警戒を厳とせよ。薄明前後の攻撃が予期される。',
  });
  events.push({
    at: jitter(parseClock('0505'), 300),
    kind: 'spawn',
    label: '敵斥候（暗夜の潜入）',
    units: [
      { id: 'E-R1', side: 'enemy', callsign: '敵斥候1', type: 'recon', x: 2650, y: 180,
        ai: { task: 'probe', objective: { x: 2400, y: 1050 } } },
      { id: 'E-R2', side: 'enemy', callsign: '敵斥候2', type: 'recon', x: 1750, y: 240,
        ai: { task: 'probe', objective: { x: 1900, y: 1250 } } },
    ],
  });

  /* --- 第一波 0540：薄明の攻撃 ---------------------------------- */
  events.push({
    at: parseClock('0536'),
    kind: 'message',
    text: '大隊本部より: 第一波接近中。薄明を突いてくる。',
  });
  events.push({
    at: jitter(parseClock('0545'), 360),
    kind: 'spawn',
    label: '第一波 ─ 橋正面への攻撃',
    units: [
      { id: 'E-W1A', side: 'enemy', callsign: '敵歩兵1', type: 'infantry', x: 2100, y: 140,
        ai: { task: 'assault', objective: { x: 2180, y: 2100 }, crossing: bridgeCross, wave: 1 } },
      { id: 'E-W1B', side: 'enemy', callsign: '敵歩兵2', type: 'infantry', x: 2420, y: 110,
        ai: { task: 'assault', objective: { x: 2260, y: 2060 }, crossing: bridgeCross, wave: 1 } },
      { id: 'E-W1C', side: 'enemy', callsign: '敵機械化1', type: 'mech', x: 2320, y: 60,
        ai: { task: 'pressure', objective: { x: 2330, y: 1300 }, wave: 1 } },
      { id: 'E-MT', side: 'enemy', callsign: '敵迫撃砲', type: 'mortar', x: 2620, y: 320,
        ai: { task: 'support' } },
    ],
  });
  events.push({ at: jitter(parseClock('0612'), 240), kind: 'jamming', value: 0.3, label: '電子妨害' });

  /* --- 静穏 0640-0740：敵は退がって再編する --------------------- */
  events.push({
    at: parseClock('0648'),
    kind: 'message',
    text: '大隊本部より: 敵は一旦退がった模様。次までに態勢を立て直せ。補給と休養を急げ。',
  });

  /* --- 第二波 0800：主攻を東へ振る ------------------------------ */
  events.push({
    at: parseClock('0752'),
    kind: 'message',
    text: '大隊本部より: 敵に再編の兆候。第二波は規模が大きい。',
  });
  events.push({
    at: jitter(parseClock('0808'), 420),
    kind: 'spawn',
    label: secondWaveEast ? '第二波 ─ 東の浅瀬へ迂回（主攻）' : '第二波 ─ 橋正面（主攻）',
    units: secondWaveEast
      ? [
          { id: 'E-W2A', side: 'enemy', callsign: '敵歩兵3', type: 'infantry', x: 4430, y: 760,
            ai: { task: 'flank', crossing: fordCross, objective: { x: 2500, y: 2280 }, wave: 2 } },
          { id: 'E-W2B', side: 'enemy', callsign: '敵歩兵4', type: 'infantry', x: 4560, y: 880,
            ai: { task: 'flank', crossing: fordCross, objective: { x: 2600, y: 2180 }, wave: 2 } },
          { id: 'E-W2C', side: 'enemy', callsign: '敵対戦車班', type: 'at_team', x: 4520, y: 1040,
            ai: { task: 'flank', crossing: fordCross, objective: { x: 3000, y: 2200 }, wave: 2 } },
          { id: 'E-W2D', side: 'enemy', callsign: '敵機械化2', type: 'mech', x: 2700, y: 120,
            ai: { task: 'pressure', objective: { x: 2560, y: 1250 }, wave: 2 } },
        ]
      : [
          { id: 'E-W2A', side: 'enemy', callsign: '敵歩兵3', type: 'infantry', x: 2160, y: 120,
            ai: { task: 'assault', objective: { x: 2180, y: 2120 }, crossing: bridgeCross, wave: 2 } },
          { id: 'E-W2B', side: 'enemy', callsign: '敵機械化2', type: 'mech', x: 2320, y: 60,
            ai: { task: 'assault', objective: { x: 2240, y: 2080 }, crossing: bridgeCross, wave: 2 } },
          { id: 'E-W2C', side: 'enemy', callsign: '敵歩兵4', type: 'infantry', x: 2520, y: 140,
            ai: { task: 'assault', objective: { x: 2320, y: 2040 }, crossing: bridgeCross, wave: 2 } },
          { id: 'E-W2D', side: 'enemy', callsign: '敵対戦車班', type: 'at_team', x: 4520, y: 1040,
            ai: { task: 'flank', crossing: fordCross, objective: { x: 3000, y: 2200 }, wave: 2 } },
        ],
  });

  /* --- 民間車列 0930：静穏の合間に抜けようとする ----------------- */
  events.push({
    at: parseClock('0845'),
    kind: 'spawn',
    label: '民間車列',
    units: [
      { id: 'CIV', side: 'civilian', callsign: '民間車列', type: 'convoy', x: 2150, y: 3480,
        ai: { task: 'transit', waypoints: [{ x: 2200, y: 2280 }, { x: 2200, y: 1750 }, { x: 2380, y: 900 }, { x: 2320, y: 40 }] } },
    ],
  });

  /* --- 友軍の増加配属 0905 ------------------------------------- */
  // 半日守れという以上、大隊も一個分隊は出す。ただし出せるのは一度きりで、
  // 着くのは第二波のあとである ─ それまでは今ある部隊で凌ぐしかない。
  events.push({
    at: parseClock('0902'),
    kind: 'message',
    text: '大隊本部より: 増加配属のハンマー5を差し向けた。まもなく指揮所後方に到着する。',
  });
  events.push({
    at: parseClock('0908'),
    kind: 'spawn',
    label: '増加配属 ハンマー5',
    units: [
      {
        id: 'H5', side: 'friend', callsign: 'ハンマー5', type: 'infantry',
        x: 1320, y: 2820, posture: 'normal', state: 'holding', morale: 88,
        role: '増加配属 ─ 予備',
      },
    ],
  });

  /* --- 敵の予備 1000：どちらの軸が通っているかを見てから投じる --- */
  events.push({
    at: jitter(parseClock('0915'), 240),
    kind: 'spawn',
    label: '敵の予備（集結地）',
    units: [
      { id: 'E-RS1', side: 'enemy', callsign: '敵予備1', type: 'mech', x: 3250, y: 240,
        ai: { task: 'reserve' } },
      { id: 'E-RS2', side: 'enemy', callsign: '敵予備2', type: 'infantry', x: 3380, y: 330,
        ai: { task: 'reserve' } },
    ],
  });

  /* --- 第三波 1045：装甲を伴う総攻撃 ---------------------------- */
  events.push({
    at: parseClock('0946'),
    kind: 'message',
    text: '大隊本部より: 敵装甲部隊の前進を確認。これが最後の攻撃と見られる。持ちこたえよ。',
  });
  events.push({
    at: jitter(parseClock('0955'), 300),
    kind: 'spawn',
    label: '第三波 ─ 装甲を伴う総攻撃',
    units: [
      { id: 'E-T1', side: 'enemy', callsign: '敵戦車1', type: 'tank', x: 2340, y: 40,
        ai: { task: 'assault', objective: { x: 2200, y: 2150 }, crossing: bridgeCross, wave: 3 } },
      { id: 'E-T2', side: 'enemy', callsign: '敵戦車2', type: 'tank', x: 2140, y: 40,
        ai: { task: 'assault', objective: { x: 2160, y: 2100 }, crossing: bridgeCross, wave: 3 } },
      { id: 'E-W3A', side: 'enemy', callsign: '敵機械化3', type: 'mech', x: 2500, y: 60,
        ai: { task: 'assault', objective: { x: 2300, y: 2050 }, crossing: bridgeCross, wave: 3 } },
      { id: 'E-W3B', side: 'enemy', callsign: '敵歩兵5', type: 'infantry', x: 2260, y: 100,
        ai: { task: 'assault', objective: { x: 2200, y: 2000 }, crossing: bridgeCross, wave: 3 } },
    ],
  });
  events.push({ at: jitter(parseClock('1006'), 240), kind: 'jamming', value: 0.38, label: '電子妨害（第三波）' });

  events.push({
    at: parseClock('1028'),
    kind: 'message',
    text: '大隊本部より: 増援は1045に到着予定。あと17分だ。',
  });

  return events;
}

/* ------------------------------------------------------------------ */
/* 勝敗判定                                                             */
/* ------------------------------------------------------------------ */

const BRIDGE_RADIUS = 300;
// 橋を敵に占拠され続けたら負け（秒）。
// 半日の戦闘では、一時的に橋際まで押し込まれることは何度も起きる ―
// それを押し返せるうちは「戦線が破れた」とは言わない。
const LOSS_GRACE = 200;
const LOSS_GRACE_LONG = 480;

/**
 * 現在の戦況を評価する。毎ティック呼ばれる。
 * @returns {{status:string, reason?:string}}
 */
export function evaluate(world) {
  const kind = world.mission.victory?.kind ?? 'hold_point';
  switch (kind) {
    case 'delay_line': return evaluateDelay(world);
    case 'seize_point': return evaluateSeize(world);
    default: return evaluateHold(world);
  }
}

/** 戦闘可能な自軍分隊 */
function effectiveSquads(world) {
  return world.units.filter(
    (u) =>
      u.side === 'friend' &&
      (u.type === 'infantry' || u.type === 'at_team') &&
      u.alive &&
      u.strength > u.maxStrength * 0.34 &&
      u.morale > 25
  );
}

/* ------------------------------------------------------------------ */
/* 型1: 一点を保持する（橋梁死守・橋梁持久）                              */
/* ------------------------------------------------------------------ */

function evaluateHold(world) {
  const bridge = world.terrain.bridge;
  const effective = effectiveSquads(world);

  const enemyAtBridge = world.units.filter(
    (u) => u.side === 'enemy' && u.alive && dist(u.x, u.y, bridge.x, bridge.y) < BRIDGE_RADIUS
  );
  // 橋を「押さえている」と言えるのは、そこを撃てる部隊がいるときだけである。
  // 弾の尽きた分隊も、統制を失った分隊も、橋の争奪には加われない ―
  // 半日の戦闘では、ここが弾薬管理の意味そのものになる。
  const friendlyAtBridge = world.units.filter(
    (u) =>
      u.side === 'friend' &&
      u.alive &&
      u.tpl.range > 0 &&
      u.ammo > 1 &&
      u.state !== 'broken' &&
      dist(u.x, u.y, bridge.x, bridge.y) < BRIDGE_RADIUS * 1.4
  );

  // 橋を敵だけが占めている状態が続くと陥落
  if (enemyAtBridge.length > 0 && friendlyAtBridge.length === 0) {
    world.bridgeLostSince ??= world.now;
  } else {
    world.bridgeLostSince = null;
  }
  const grace = world.mission.duration === 'long' ? LOSS_GRACE_LONG : LOSS_GRACE;
  if (world.bridgeLostSince != null && world.now - world.bridgeLostSince > grace) {
    return { status: 'defeat', reason: '橋梁を敵に奪取された。増援の展開前に戦線が破れた。' };
  }

  if (effective.length === 0) {
    return { status: 'defeat', reason: '戦闘可能な部隊が失われた。防御は成立しない。' };
  }

  if (world.now < world.mission.endTime) return { status: 'ongoing' };

  // --- 時限到達 ---
  // 頭数ではなく戦闘力で測る。斥候が2つ居残っても橋頭堡とは呼ばない。
  const bridgehead = world.units
    .filter(
      (u) =>
        u.side === 'enemy' &&
        u.alive &&
        u.type !== 'recon' &&
        u.strength > u.maxStrength * 0.4 &&
        u.y > world.terrain.front(u.x) + 80
    )
    .reduce((s, u) => s + u.strength / u.maxStrength, 0);

  const clock = formatClock(world.mission.endTime);
  if (enemyAtBridge.length > 0 && friendlyAtBridge.length === 0) {
    return { status: 'defeat', reason: `${clock}時点で橋梁は敵の手にある。増援は展開できない。` };
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

/* ------------------------------------------------------------------ */
/* 型2: 線を越えさせない（遅滞行動）                                      */
/* ------------------------------------------------------------------ */

/**
 * 遅滞。
 * 守るのは陣地ではなく時間である ── どこまで下がってもよいが、
 * 定めた線より南へ敵を出したら、そこで負けになる。
 */
function evaluateDelay(world) {
  const v = world.mission.victory;
  const effective = effectiveSquads(world);

  // 線を越えた敵。斥候一両では「突破」とは言わない。
  const past = world.units.filter(
    (u) =>
      u.side === 'enemy' &&
      u.alive &&
      u.type !== 'recon' &&
      u.strength > u.maxStrength * 0.4 &&
      u.y > v.lineY
  );

  if (past.length > 0) {
    world.lineLostSince ??= world.now;
  } else {
    world.lineLostSince = null;
  }
  if (world.lineLostSince != null && world.now - world.lineLostSince > 180) {
    return {
      status: 'defeat',
      reason: `敵が${v.label}を突破した。本隊の陣地構築は間に合わない。`,
    };
  }

  if (effective.length === 0) {
    return { status: 'defeat', reason: '遅滞部隊が失われた。もはや誰も敵を止められない。' };
  }

  if (world.now < world.mission.endTime) return { status: 'ongoing' };

  // --- 時限到達 ---
  const enemyLosses = world.units
    .filter((u) => u.side === 'enemy')
    .reduce((s, u) => s + u.losses, 0);
  const nearest = world.units
    .filter((u) => u.side === 'enemy' && u.alive && u.type !== 'recon')
    .reduce((m, u) => Math.max(m, u.y), 0);

  if (effective.length <= 1) {
    return { status: 'narrow', reason: '時間は稼いだ。だが遅滞部隊は事実上壊滅した。' };
  }
  if (nearest > v.lineY - 500) {
    return {
      status: 'narrow',
      reason: `${v.label}の直前で敵を止めたまま時限に達した。紙一重である。`,
    };
  }
  if (enemyLosses >= 6) {
    return {
      status: 'victory',
      reason: '所定の時間を稼ぎ、なお部隊を保ち、敵に痛撃を与えた。遅滞は成功である。',
    };
  }
  return { status: 'victory', reason: '所定の時間を稼ぎ、部隊を保ったまま離脱できる。遅滞は成功である。' };
}

/* ------------------------------------------------------------------ */
/* 型3: 一点を奪回する（逆襲）                                           */
/* ------------------------------------------------------------------ */

/**
 * 奪回。
 * 今度は貴官が攻める側である。目標を占め、一定時間保って初めて「確保した」と言える。
 */
function evaluateSeize(world) {
  const v = world.mission.victory;
  const p = v.point;
  const effective = effectiveSquads(world);

  const friendlyOn = world.units.filter(
    (u) =>
      u.side === 'friend' &&
      u.alive &&
      u.tpl.range > 0 &&
      u.state !== 'broken' &&
      u.strength > u.maxStrength * 0.3 &&
      dist(u.x, u.y, p.x, p.y) < p.radius
  );
  const enemyOn = world.units.filter(
    (u) =>
      u.side === 'enemy' &&
      u.alive &&
      u.strength > u.maxStrength * 0.25 &&
      dist(u.x, u.y, p.x, p.y) < p.radius
  );

  const holding = friendlyOn.length > 0 && enemyOn.length === 0;
  if (holding) {
    world.seizedSince ??= world.now;
  } else {
    world.seizedSince = null;
  }
  const held = world.seizedSince != null ? world.now - world.seizedSince : 0;
  world.seizeHeldFor = held;

  if (held >= (v.holdFor ?? 240)) {
    if (effective.length <= 1) {
      return { status: 'narrow', reason: `${v.label}は奪回した。だが中隊は事実上壊滅した。` };
    }
    return { status: 'victory', reason: `${v.label}を奪回し、確保した。逆襲は成功である。` };
  }

  if (effective.length === 0) {
    return { status: 'defeat', reason: '突撃部隊が失われた。逆襲は頓挫した。' };
  }

  if (world.now < world.mission.endTime) return { status: 'ongoing' };

  // --- 時限到達 ---
  if (friendlyOn.length > 0) {
    return {
      status: 'narrow',
      reason: `${v.label}に取り付いたが、確保しきる前に時限に達した。あと一歩だった。`,
    };
  }
  return { status: 'defeat', reason: `${v.label}を奪回できなかった。連絡路は断たれたままである。` };
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
