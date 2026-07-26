// 追加のミッション。
//
// 防御ばかりが戦闘ではない。退がりながら時間を稼ぐ戦いもあれば、
// 取られたものを取り返しに行く戦いもある。指揮官のやることは
// そのたびに変わる ── 何を守るかではなく、何と引き換えに何を得るか。
//
// 図幅（maps.js）と勝敗の型（scenario.js の evaluate）を組み合わせて作る。

import { parseClock, toGrid } from '../util.js';
import { getMap } from './maps.js';

const KOLP = getMap('kolp_pass');
const ZAREN = getMap('zaren_town');

const kolpFront = KOLP.frontLine;
const zarenFront = ZAREN.frontLine;

const DEFILE_X = 2420;
const TRACK_X = 3720;
export const DEFILE_GRID = toGrid(DEFILE_X, kolpFront(DEFILE_X));
export const TRACK_GRID = toGrid(TRACK_X, kolpFront(TRACK_X));

/* ================================================================== */
/* コルプ峠の遅滞 ─ 空間を売って時間を買う                                */
/* ================================================================== */

const PASS_T0 = parseClock('0530');
const PASS_TEND = parseClock('0752');
/** ここを敵に越えられたら遅滞は失敗 */
const PASS_EXIT_Y = 3150;

export const MISSION_PASS = Object.freeze({
  id: 'kolp_delay',
  mapId: 'kolp_pass',
  title: 'コルプ峠の遅滞',
  phases: [
    { at: '0530', label: '薄明・警戒' }, { at: '0545', label: '前衛と接触' },
    { at: '0605', label: '第一梯団' }, { at: '0700', label: '第二梯団・装甲' },
    { at: '0725', label: '最終局面' },
  ],
  blurb: '陣地は捨ててよい。買うのは時間である。退がりながら敵を展開させ続けろ。',
  subtitle: 'コルプ峠 / 第3中隊戦闘団 ─ 遅滞行動',
  duration: 'short',
  seed: 71104,
  startTime: PASS_T0,
  endTime: PASS_TEND,

  weather: { mistStart: PASS_T0, mistClear: parseClock('0705') },

  commandPost: { x: 2150, y: 3320 },

  victory: {
    kind: 'delay_line',
    lineY: PASS_EXIT_Y,
    label: '峠の南口',
  },

  // 敵が最終的に取りにくる場所。隘路の図幅では「橋の南」ではなく峠の出口である。
  enemyGoal: { x: 2380, y: 3350 },

  briefing: {
    situation:
      '敵一個大隊がコルプ峠を南下しつつある。東西は岩稜に塞がれ、車輌が通れるのは谷筋の一本道だけ。' +
      '本隊は南方40kmで陣地を構築中であり、その完成まで時間が要る。',
    mission:
      `0752まで、敵を峠の南口（${toGrid(2400, PASS_EXIT_Y)}の線）より南へ出すな。` +
      '陣地を保持する必要はない ─ 必要なのは時間である。',
    execution:
      '遅滞行動である。損害を避けながら段階的に下がり、そのたびに敵を展開させ、時間を使わせよ。' +
      '死守を命じれば部隊は消える。だが下がりすぎれば、その日のうちに南口を抜かれる。',
    notes: [
      '峠の東西は急斜面である。車輌はもちろん、徒歩でも越えられない。',
      `東の間道（${TRACK_GRID}付近）だけは徒歩で越えられる。敵の歩兵はそこから回ってくる。`,
      '遅滞では「弾力防御」が基本になる。圧されたら早めに下がり、次の稜線でまた止める。',
      '砲兵「ソーン」は16発。隘路に詰まった縦隊は、砲兵にとって最良の目標である。',
      '部隊を失えば、次の線で止める者がいなくなる。土地より部隊を惜しめ。',
    ],
  },

  objectives: [
    { id: 'delay', text: `0752まで敵を峠の南口より南へ出さない`, primary: true },
    { id: 'keep_force', text: '2個分隊以上を戦闘可能な状態で維持する', primary: true },
    { id: 'bleed', text: '敵に損害を強要する', primary: false },
  ],

  support: {
    artillery: { name: 'ソーン', rounds: 16 },
    smoke: { name: 'ソーン', rounds: 8 },
  },

  rosterOrder: [
    { id: 'H1', callsign: 'ハンマー1', typeLabel: '歩兵分隊', role: '関門の丘 ─ 第一線', icon: 'infantry', echelon: 1 },
    { id: 'H2', callsign: 'ハンマー2', typeLabel: '歩兵分隊', role: 'コルプ村 ─ 第二線', icon: 'infantry', echelon: 1 },
    { id: 'H3', callsign: 'ハンマー3', typeLabel: '歩兵分隊', role: '東の間道の監視', icon: 'infantry', echelon: 1 },
    { id: 'SW', callsign: 'ソード', typeLabel: '対戦車班', role: '隘路口の対戦車', icon: 'antitank', echelon: 'Ø' },
    { id: 'EG', callsign: 'イーグル', typeLabel: '偵察ドローン', role: '偵察', icon: 'uav', echelon: null },
    { id: 'TH', callsign: 'ソーン', typeLabel: '支援砲兵', role: '火力支援', icon: 'artillery', echelon: 1 },
  ],

  orbat: () => [
    { id: 'H1', side: 'friend', callsign: 'ハンマー1', type: 'infantry',
      x: 2450, y: 2050, posture: 'dug_in', state: 'defending', morale: 84,
      role: '関門の丘 ─ 第一線' },
    { id: 'H2', side: 'friend', callsign: 'ハンマー2', type: 'infantry',
      x: 2400, y: 2620, posture: 'dug_in', state: 'defending', morale: 84,
      role: 'コルプ村 ─ 第二線' },
    { id: 'H3', side: 'friend', callsign: 'ハンマー3', type: 'infantry',
      x: 3560, y: 2100, posture: 'cautious', state: 'holding', morale: 80,
      role: '東の間道の監視' },
    { id: 'SW', side: 'friend', callsign: 'ソード', type: 'at_team',
      x: 2620, y: 2320, posture: 'dug_in', state: 'defending', morale: 86,
      role: '隘路口の対戦車' },
    { id: 'EG', side: 'friend', callsign: 'イーグル', type: 'drone',
      x: 2150, y: 3320, posture: 'normal', state: 'holding', morale: 100,
      role: '偵察ドローン' },
    { id: 'TH', side: 'friend', callsign: 'ソーン', type: 'mortar',
      x: 2050, y: 3300, posture: 'dug_in', state: 'defending', morale: 90,
      role: '支援砲兵（後方）' },
  ],

  timeline: (rng, opts) => {
    const jit = (base, spread) =>
      opts?.variable && rng ? base + Math.round(rng.range(-spread, spread) / 60) * 60 : base;
    const defile = { x: DEFILE_X, y: kolpFront(DEFILE_X) };
    const track = { x: TRACK_X, y: kolpFront(TRACK_X) };

    return [
      { at: parseClock('0534'), kind: 'message',
        text: '大隊本部より: 敵前衛が北口の集落に入った。接触は間もない。' },
      { at: jit(parseClock('0545'), 240), kind: 'spawn', label: '敵前衛',
        units: [
          { id: 'E-R1', side: 'enemy', callsign: '敵斥候1', type: 'recon', x: 2500, y: 300,
            ai: { task: 'probe', objective: { x: 2460, y: 1150 } } },
          { id: 'E-R2', side: 'enemy', callsign: '敵斥候2', type: 'recon', x: 3700, y: 420,
            ai: { task: 'probe', objective: { x: 3700, y: 1200 } } },
        ] },
      { at: jit(parseClock('0605'), 300), kind: 'spawn', label: '第一梯団 ─ 隘路への突入',
        units: [
          { id: 'E-A1', side: 'enemy', callsign: '敵歩兵1', type: 'infantry', x: 2380, y: 200,
            ai: { task: 'assault', crossing: defile, objective: { x: 2350, y: 3200 }, wave: 1 } },
          { id: 'E-A2', side: 'enemy', callsign: '敵歩兵2', type: 'infantry', x: 2600, y: 260,
            ai: { task: 'assault', crossing: defile, objective: { x: 2450, y: 3100 }, wave: 1 } },
          { id: 'E-M1', side: 'enemy', callsign: '敵機械化1', type: 'mech', x: 2500, y: 120,
            ai: { task: 'assault', crossing: defile, objective: { x: 2400, y: 3150 }, wave: 1 } },
          { id: 'E-MT', side: 'enemy', callsign: '敵迫撃砲', type: 'mortar', x: 2520, y: 620,
            ai: { task: 'support' } },
        ] },
      { at: jit(parseClock('0628'), 300), kind: 'spawn', label: '東の間道への迂回',
        units: [
          { id: 'E-F1', side: 'enemy', callsign: '敵歩兵3', type: 'infantry', x: 3760, y: 560,
            ai: { task: 'flank', crossing: track, objective: { x: 3200, y: 2800 }, wave: 1 } },
        ] },
      { at: jit(parseClock('0652'), 240), kind: 'jamming', value: 0.3, label: '電子妨害' },
      { at: jit(parseClock('0708'), 300), kind: 'spawn', label: '第二梯団 ─ 装甲を伴う突進',
        units: [
          { id: 'E-T1', side: 'enemy', callsign: '敵戦車1', type: 'tank', x: 2480, y: 100,
            ai: { task: 'assault', crossing: defile, objective: { x: 2380, y: 3200 }, wave: 2 } },
          { id: 'E-A3', side: 'enemy', callsign: '敵歩兵4', type: 'infantry', x: 2320, y: 160,
            ai: { task: 'assault', crossing: defile, objective: { x: 2300, y: 3100 }, wave: 2 } },
          { id: 'E-M2', side: 'enemy', callsign: '敵機械化2', type: 'mech', x: 2660, y: 180,
            ai: { task: 'assault', crossing: defile, objective: { x: 2500, y: 3050 }, wave: 2 } },
        ] },
      { at: jit(parseClock('0722'), 240), kind: 'spawn', label: '第三梯団',
        units: [
          { id: 'E-F2', side: 'enemy', callsign: '敵歩兵5', type: 'infantry', x: 3780, y: 640,
            ai: { task: 'flank', crossing: track, objective: { x: 3000, y: 3000 }, wave: 3 } },
        ] },
      { at: parseClock('0730'), kind: 'message',
        text: '大隊本部より: 陣地の構築はあと15分で終わる。それまで南口を渡すな。' },
    ];
  },
});

/* ================================================================== */
/* ザーレン市街の逆襲 ─ 取り返しに行く                                    */
/* ================================================================== */

const TOWN_T0 = parseClock('1400');
const TOWN_TEND = parseClock('1620');
/** 奪回すべき目標 ─ 旧市街の交差点 */
const OBJ = { x: 2300, y: 2350, radius: 340 };
export const OBJ_GRID = toGrid(OBJ.x, OBJ.y);

export const MISSION_TOWN = Object.freeze({
  id: 'zaren_counter',
  mapId: 'zaren_town',
  title: 'ザーレン奪回',
  phases: [
    { at: '1400', label: '攻撃準備' }, { at: '1420', label: '突入' },
    { at: '1440', label: '市街戦' }, { at: '1520', label: '敵増援' },
    { at: '1600', label: '最終局面' },
  ],
  blurb: '今度は貴官が攻める側。市街に籠る敵を、日没までに押し出す。',
  subtitle: 'ザーレン市街 / 第3中隊戦闘団 ─ 逆襲',
  duration: 'short',
  seed: 990117,
  startTime: TOWN_T0,
  endTime: TOWN_TEND,

  weather: { mistStart: TOWN_T0, mistClear: TOWN_T0 + 1 }, // 午後、霧はない

  commandPost: { x: 1000, y: 3260 },

  enemyGoal: { x: OBJ.x, y: OBJ.y },

  victory: {
    kind: 'seize_point',
    point: OBJ,
    holdFor: 180, // 3分押さえ続けて「確保した」と言える
    label: '旧市街の交差点',
  },

  briefing: {
    situation:
      '今朝、敵はザーレン運河を渡り、旧市街の交差点を奪った。ここを敵に押さえられている限り、' +
      '南北の連絡路は断たれたままである。敵はまだ陣地を固めきっていないが、時間が経てば固まる。',
    mission:
      `1620までに、旧市街の交差点 ${OBJ_GRID} を奪回し、3分間確保せよ。`,
    execution:
      '今度は貴官が攻める側である。市街では見通しが利かない ─ 建物の陰から30mで撃ち合うことになる。' +
      '正面から押せば損害が出る。煙幕で視界を切り、複数の道から同時に入れ。',
    notes: [
      '市街地は遮蔽が厚い。籠っている敵を正面から撃っても、なかなか減らない。',
      '見通しが利かないぶん、報告は近距離まで来ないと上がってこない。ドローンが要る。',
      '煙幕は10発ある。攻撃前進のときこそ使うものである。',
      '運河を渡れるのは3本の橋だけ。西橋・中央橋・鉄道橋 ─ どこから入るかを選べ。',
      '敵は増援を送ってくる。時間をかけるほど固くなる。',
    ],
  },

  objectives: [
    { id: 'seize', text: `1620までに ${OBJ_GRID} を奪回し3分確保する`, primary: true },
    { id: 'keep_force', text: '2個分隊以上を戦闘可能な状態で維持する', primary: true },
    { id: 'speed', text: '敵の増援が固まる前に決着をつける', primary: false },
  ],

  support: {
    artillery: { name: 'ソーン', rounds: 14 },
    smoke: { name: 'ソーン', rounds: 10 },
  },

  rosterOrder: [
    { id: 'H1', callsign: 'ハンマー1', typeLabel: '歩兵分隊', role: '主攻 ─ 中央橋', icon: 'infantry', echelon: 1 },
    { id: 'H2', callsign: 'ハンマー2', typeLabel: '歩兵分隊', role: '主攻 ─ 中央橋', icon: 'infantry', echelon: 1 },
    { id: 'H3', callsign: 'ハンマー3', typeLabel: '歩兵分隊', role: '助攻 ─ 西橋', icon: 'infantry', echelon: 1 },
    { id: 'SW', callsign: 'ソード', typeLabel: '対戦車班', role: '対装甲・掩護', icon: 'antitank', echelon: 'Ø' },
    { id: 'EG', callsign: 'イーグル', typeLabel: '偵察ドローン', role: '偵察', icon: 'uav', echelon: null },
    { id: 'TH', callsign: 'ソーン', typeLabel: '支援砲兵', role: '火力支援', icon: 'artillery', echelon: 1 },
  ],

  // 攻者なので、味方は南岸に集結している
  orbat: () => [
    { id: 'H1', side: 'friend', callsign: 'ハンマー1', type: 'infantry',
      x: 2280, y: 3020, posture: 'normal', state: 'holding', morale: 86,
      role: '主攻 ─ 中央橋' },
    { id: 'H2', side: 'friend', callsign: 'ハンマー2', type: 'infantry',
      x: 2480, y: 3060, posture: 'normal', state: 'holding', morale: 86,
      role: '主攻 ─ 中央橋' },
    { id: 'H3', side: 'friend', callsign: 'ハンマー3', type: 'infantry',
      x: 1420, y: 2900, posture: 'normal', state: 'holding', morale: 84,
      role: '助攻 ─ 西橋' },
    { id: 'SW', side: 'friend', callsign: 'ソード', type: 'at_team',
      x: 2100, y: 3120, posture: 'normal', state: 'holding', morale: 88,
      role: '対装甲・掩護' },
    { id: 'EG', side: 'friend', callsign: 'イーグル', type: 'drone',
      x: 1000, y: 3260, posture: 'normal', state: 'holding', morale: 100,
      role: '偵察ドローン' },
    { id: 'TH', side: 'friend', callsign: 'ソーン', type: 'mortar',
      x: 900, y: 3400, posture: 'dug_in', state: 'defending', morale: 90,
      role: '支援砲兵（後方）' },
  ],

  timeline: (rng, opts) => {
    const jit = (base, spread) =>
      opts?.variable && rng ? base + Math.round(rng.range(-spread, spread) / 60) * 60 : base;

    // 守勢の敵。既に旧市街に籠っている。
    const holders = [
      { id: 'E-H1', side: 'enemy', callsign: '敵歩兵1', type: 'infantry', x: 2300, y: 2300,
        posture: 'dug_in', state: 'defending',
        ai: { task: 'hold_ground', anchor: { x: 2300, y: 2300 } } },
      { id: 'E-H2', side: 'enemy', callsign: '敵歩兵2', type: 'infantry', x: 2160, y: 2500,
        posture: 'dug_in', state: 'defending',
        ai: { task: 'hold_ground', anchor: { x: 2160, y: 2500 } } },
      { id: 'E-H3', side: 'enemy', callsign: '敵歩兵3', type: 'infantry', x: 2480, y: 2200,
        posture: 'dug_in', state: 'defending',
        ai: { task: 'hold_ground', anchor: { x: 2480, y: 2200 } } },
      { id: 'E-AT', side: 'enemy', callsign: '敵対戦車班', type: 'at_team', x: 2340, y: 2560,
        posture: 'dug_in', state: 'defending',
        ai: { task: 'hold_ground', anchor: { x: 2340, y: 2560 } } },
      { id: 'E-MT', side: 'enemy', callsign: '敵迫撃砲', type: 'mortar', x: 2500, y: 1500,
        posture: 'dug_in', state: 'defending', ai: { task: 'support' } },
    ];

    return [
      { at: TOWN_T0 + 1, kind: 'spawn', label: '旧市街に籠る敵', units: holders },
      { at: parseClock('1404'), kind: 'message',
        text: '大隊本部より: 交差点の敵は一個小隊規模と見られる。増援が入る前に押せ。' },
      { at: jit(parseClock('1438'), 300), kind: 'spawn', label: '敵の増援（第一次）',
        units: [
          { id: 'E-R1', side: 'enemy', callsign: '敵増援1', type: 'infantry', x: 2450, y: 1300,
            ai: { task: 'hold_ground', anchor: { x: 2380, y: 2260 } } },
        ] },
      { at: jit(parseClock('1452'), 240), kind: 'jamming', value: 0.28, label: '電子妨害' },
      { at: jit(parseClock('1516'), 300), kind: 'spawn', label: '敵の増援（第二次・装甲）',
        units: [
          { id: 'E-T1', side: 'enemy', callsign: '敵装甲車1', type: 'mech', x: 2450, y: 1200,
            ai: { task: 'hold_ground', anchor: { x: 2320, y: 2180 } } },
          { id: 'E-R2', side: 'enemy', callsign: '敵増援2', type: 'infantry', x: 3300, y: 1300,
            ai: { task: 'hold_ground', anchor: { x: 2560, y: 2420 } } },
        ] },
      { at: parseClock('1600'), kind: 'message',
        text: '大隊本部より: 残り20分。日没までに交差点を押さえられねば、この作戦は無意味になる。' },
    ];
  },
});
