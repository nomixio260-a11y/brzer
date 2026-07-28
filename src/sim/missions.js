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

const ZAREN_MAIN_X = 2350;
const ZAREN_RAIL_X = 3450;
const ZAREN_WEST_X = 1250;

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
      `東の間道（${TRACK_GRID}付近）だけは徒歩で越えられる。敵の歩兵はそこから回ってくる ─ ` +
        '車輌は通れないので、戦車と装甲車は必ず谷筋の隘路を通る。',
      '遅滞では「弾力防御」が基本になる。圧されたら早めに下がり、次の稜線でまた止める。',
      '砲兵「ソーン」は16発。隘路に詰まった縦隊は、砲兵にとって最良の目標である。',
      '開始時刻は薄明前である。照明弾が6発ある ─ 夜の谷では、弾より「見えること」が要る。',
      '東の間道には鉄条網が敷いてある。止めはしないが、越えるのに手間取る。',
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
          { id: 'E-F1', side: 'enemy', callsign: '敵歩兵3', type: 'infantry', x: 3480, y: 520,
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
          { id: 'E-F2', side: 'enemy', callsign: '敵歩兵5', type: 'infantry', x: 3520, y: 640,
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
// 交差点そのもの。半径は市街の見通し（およそ170m）より内側に取る ─
// 見えない敵まで排除しろという条件は、市街では誰にも満たせない。
const OBJ = { x: 2300, y: 2350, radius: 190 };
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
      '籠っている敵には曳火射撃が効く。着発では土を掘り返すだけである。',
      '敵は旧市街の南口に障害を敷いているとの情報がある。位置は不明。',
      '鉄道の築堤は、撃たれずに横へ動ける唯一の線である。',
      '「攻撃」は止まらない ─ 撃たれても目標まで寄せ続ける。' +
        '先に制圧し、煙を焚いてから出さなければ、その代償を全部払うことになる。',
      '機械化歩兵「シールド」は装甲を持つ。先導させれば小銃弾は弾くが、' +
        '敵の対戦車班に横腹を晒せば一撃で燃える。',
      '敵は増援を送ってくる。時間をかけるほど固くなる。',
    ],
  },

  objectives: [
    { id: 'seize', text: `1620までに ${OBJ_GRID} を奪回し3分確保する`, primary: true },
    { id: 'keep_force', text: '2個分隊以上を戦闘可能な状態で維持する', primary: true },
    { id: 'speed', text: '敵の増援が固まる前に決着をつける', primary: false },
  ],

  // 攻める側には重みが要る。守る一個小隊に対して同数で当たっても、
  // 厚い市街の遮蔽の前では一方的に削られるだけで終わる ─ 実際そうなっていた。
  support: {
    artillery: { name: 'ソーン', rounds: 20 },
    smoke: { name: 'ソーン', rounds: 12 },
  },

  rosterOrder: [
    { id: 'H1', callsign: 'ハンマー1', typeLabel: '歩兵分隊', role: '主攻 ─ 中央橋', icon: 'infantry', echelon: 1 },
    { id: 'H2', callsign: 'ハンマー2', typeLabel: '歩兵分隊', role: '主攻 ─ 中央橋', icon: 'infantry', echelon: 1 },
    { id: 'H3', callsign: 'ハンマー3', typeLabel: '歩兵分隊', role: '助攻 ─ 西橋', icon: 'infantry', echelon: 1 },
    { id: 'H4', callsign: 'ハンマー4', typeLabel: '歩兵分隊', role: '予備 ─ 突破口へ投入', icon: 'infantry', echelon: 1 },
    { id: 'SH', callsign: 'シールド', typeLabel: '機械化歩兵', role: '突撃の先導・掩護', icon: 'mech', echelon: 1 },
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
    { id: 'H4', side: 'friend', callsign: 'ハンマー4', type: 'infantry',
      x: 2620, y: 3000, posture: 'normal', state: 'holding', morale: 86,
      role: '予備 ─ 突破口へ投入' },
    { id: 'SH', side: 'friend', callsign: 'シールド', type: 'mech',
      x: 2360, y: 3160, posture: 'normal', state: 'holding', morale: 88,
      role: '突撃の先導・掩護' },
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
            ai: { task: 'hold_ground', anchor: { x: 2330, y: 1880 } } },
          { id: 'E-R2', side: 'enemy', callsign: '敵増援2', type: 'infantry', x: 3300, y: 1300,
            ai: { task: 'hold_ground', anchor: { x: 2810, y: 2640 } } },
        ] },
      { at: parseClock('1600'), kind: 'message',
        text: '大隊本部より: 残り20分。日没までに交差点を押さえられねば、この作戦は無意味になる。' },
    ];
  },
});

/* ================================================================== */
/* 関門の丘の奪回 ─ 見下ろされている限り、道は道ではない                    */
/* ================================================================== */
//
// 隘路の図幅で「攻める」を成立させるには、取りに行く先が要る。
// 峠の関門そのものは攻めても意味がない ── 抜けたところで、その先も隘路である。
// 意味があるのは高いところで、丘を持っている側が谷筋の道を持っている。
//
// 単発では出さない。前日に峠まで押し込まれていて初めて、
// 「昨日まで自分が使っていた観測点」を取り返す話になる。

const HILL_T0 = parseClock('1010');
const HILL_TEND = parseClock('1225');
/** 関門の丘の頂。半径は谷底の見通しより内側に取る。 */
const HILL = { x: 2450, y: 2150, radius: 210 };
export const HILL_GRID = toGrid(HILL.x, HILL.y);

export const MISSION_HILL = Object.freeze({
  id: 'kolp_seize',
  mapId: 'kolp_pass',
  title: '関門の丘の奪回',
  phases: [
    { at: '1010', label: '攻撃準備' }, { at: '1032', label: '制圧射' },
    { at: '1056', label: '突撃' }, { at: '1130', label: '敵の逆襲' },
    { at: '1200', label: '最終局面' },
  ],
  blurb: '谷を見下ろす丘の観測所を潰す。三分押さえて、初めて奪回と言える。',
  subtitle: 'コルプ峠 / 第3中隊戦闘団 ─ 高地の奪回',
  duration: 'short',
  seed: 71104,
  startTime: HILL_T0,
  endTime: HILL_TEND,

  weather: { mistStart: HILL_T0, mistClear: HILL_T0 + 1 }, // 昼前。谷霧はもう無い

  commandPost: { x: 2000, y: 3300 },

  enemyGoal: { x: HILL.x, y: HILL.y },

  victory: {
    kind: 'seize_point',
    point: HILL,
    holdFor: 180,
    label: '関門の丘',
  },

  briefing: {
    situation:
      '敵は昨夜のうちに関門の丘へ観測所を上げた。丘の上からは谷筋の道が端から端まで見えており、' +
      '日中に車輌を通せば必ず砲撃を受ける。守兵は二個分隊と対戦車班で、掩体は掘り終えている。',
    mission:
      `1225までに関門の丘 ${HILL_GRID} を奪回し、3分間確保せよ。`,
    execution:
      '丘の裾までは南の森が使える。そこから上は開豁地であり、隠れる場所は無い。' +
      '制圧射を絶やさず、煙で斜面を切り、そのうえで突撃距離まで詰めること。',
    notes: [
      '丘の上に遮蔽は無い。だが掩体はある ─ 着発では土を掘り返すだけで、曳火が要る。',
      '南の森は丘の裾まで続いている。そこまでは見つからずに寄れる。',
      '煙幕は14発ある。斜面を切るために持たせてある。',
      '敵の迫は北口の集落の裏にある。撃てば砲声が聞こえる ─ 二個部隊で交会を取れ。',
      '「攻撃」は止まらない。止まって撃たせたいなら「前進」である。',
      '奪ったあとの三分が、いちばん撃たれる三分である。敵は取り返しに来る。',
      '対戦車班「ソード」は谷筋を見張らせておくこと。敵の装甲は必ず道から来る。',
    ],
  },

  objectives: [
    { id: 'seize', text: `1225までに ${HILL_GRID} を奪回し3分確保する`, primary: true },
    { id: 'keep_force', text: '2個分隊以上を戦闘可能な状態で維持する', primary: true },
    { id: 'speed', text: '敵の逆襲が固まる前に決着をつける', primary: false },
  ],

  support: {
    artillery: { name: 'ソーン', rounds: 22 },
    smoke: { name: 'ソーン', rounds: 14 },
  },

  rosterOrder: [
    { id: 'H1', callsign: 'ハンマー1', typeLabel: '歩兵分隊', role: '主攻 ─ 南斜面', icon: 'infantry', echelon: 1 },
    { id: 'H2', callsign: 'ハンマー2', typeLabel: '歩兵分隊', role: '主攻 ─ 南斜面', icon: 'infantry', echelon: 1 },
    { id: 'H3', callsign: 'ハンマー3', typeLabel: '歩兵分隊', role: '助攻 ─ 西の鞍部', icon: 'infantry', echelon: 1 },
    { id: 'H4', callsign: 'ハンマー4', typeLabel: '歩兵分隊', role: '予備 ─ 突破口へ投入', icon: 'infantry', echelon: 1 },
    { id: 'SH', callsign: 'シールド', typeLabel: '機械化歩兵', role: '突撃の先導・掩護', icon: 'mech', echelon: 1 },
    { id: 'SW', callsign: 'ソード', typeLabel: '対戦車班', role: '谷筋の対戦車', icon: 'antitank', echelon: 'Ø' },
    { id: 'EG', callsign: 'イーグル', typeLabel: '偵察ドローン', role: '偵察', icon: 'uav', echelon: null },
    { id: 'TH', callsign: 'ソーン', typeLabel: '支援砲兵', role: '火力支援', icon: 'artillery', echelon: 1 },
  ],

  // 攻者なので、味方は丘の南 ─ 森の中に集結している
  orbat: () => [
    { id: 'H1', side: 'friend', callsign: 'ハンマー1', type: 'infantry',
      x: 2320, y: 2680, posture: 'normal', state: 'holding', morale: 84,
      role: '主攻 ─ 南斜面' },
    { id: 'H2', side: 'friend', callsign: 'ハンマー2', type: 'infantry',
      x: 2560, y: 2700, posture: 'normal', state: 'holding', morale: 84,
      role: '主攻 ─ 南斜面' },
    { id: 'H3', side: 'friend', callsign: 'ハンマー3', type: 'infantry',
      x: 2020, y: 2700, posture: 'normal', state: 'holding', morale: 82,
      role: '助攻 ─ 西の鞍部' },
    { id: 'H4', side: 'friend', callsign: 'ハンマー4', type: 'infantry',
      x: 2740, y: 2820, posture: 'normal', state: 'holding', morale: 84,
      role: '予備 ─ 突破口へ投入' },
    { id: 'SH', side: 'friend', callsign: 'シールド', type: 'mech',
      x: 2440, y: 2860, posture: 'normal', state: 'holding', morale: 86,
      role: '突撃の先導・掩護' },
    { id: 'SW', side: 'friend', callsign: 'ソード', type: 'at_team',
      x: 2220, y: 2800, posture: 'normal', state: 'holding', morale: 86,
      role: '谷筋の対戦車' },
    { id: 'EG', side: 'friend', callsign: 'イーグル', type: 'drone',
      x: 2000, y: 3300, posture: 'normal', state: 'holding', morale: 100,
      role: '偵察ドローン' },
    { id: 'TH', side: 'friend', callsign: 'ソーン', type: 'mortar',
      x: 2050, y: 3320, posture: 'dug_in', state: 'defending', morale: 88,
      role: '支援砲兵（後方）' },
  ],

  timeline: (rng, opts) => {
    const jit = (base, spread) =>
      opts?.variable && rng ? base + Math.round(rng.range(-spread, spread) / 60) * 60 : base;

    // 丘に籠る守兵。掩体は夜のうちに掘り終えている。
    const holders = [
      { id: 'E-H1', side: 'enemy', callsign: '敵歩兵1', type: 'infantry', x: 2450, y: 2120,
        posture: 'dug_in', state: 'defending',
        ai: { task: 'hold_ground', anchor: { x: 2450, y: 2120 } } },
      { id: 'E-H2', side: 'enemy', callsign: '敵歩兵2', type: 'infantry', x: 2320, y: 2230,
        posture: 'dug_in', state: 'defending',
        ai: { task: 'hold_ground', anchor: { x: 2320, y: 2230 } } },
      { id: 'E-AT', side: 'enemy', callsign: '敵対戦車班', type: 'at_team', x: 2480, y: 2040,
        posture: 'dug_in', state: 'defending',
        ai: { task: 'hold_ground', anchor: { x: 2480, y: 2040 } } },
      { id: 'E-MT', side: 'enemy', callsign: '敵迫撃砲', type: 'mortar', x: 2500, y: 1400,
        posture: 'dug_in', state: 'defending', ai: { task: 'support' } },
    ];

    return [
      { at: HILL_T0 + 1, kind: 'spawn', label: '丘に籠る敵', units: holders },
      { at: parseClock('1014'), kind: 'message',
        text: '大隊本部より: 丘の守兵は一個小隊規模。掩体に入っている ─ 曳火でなければ減らない。' },
      { at: jit(parseClock('1054'), 300), kind: 'spawn', label: '敵の増援（谷筋から）',
        units: [
          { id: 'E-R1', side: 'enemy', callsign: '敵増援1', type: 'infantry', x: 2500, y: 900,
            ai: { task: 'hold_ground', anchor: { x: 2400, y: 2000 } } },
        ] },
      { at: jit(parseClock('1112'), 240), kind: 'jamming', value: 0.3, label: '電子妨害' },
      { at: jit(parseClock('1128'), 300), kind: 'spawn', label: '敵の逆襲（装甲を伴う）',
        units: [
          { id: 'E-T1', side: 'enemy', callsign: '敵戦車1', type: 'tank', x: 2480, y: 700,
            ai: { task: 'assault', crossing: { x: DEFILE_X, y: kolpFront(DEFILE_X) },
              objective: { x: 2450, y: 2180 } } },
          { id: 'E-R2', side: 'enemy', callsign: '敵増援2', type: 'infantry', x: 2600, y: 1000,
            ai: { task: 'hold_ground', anchor: { x: 2600, y: 2120 } } },
        ] },
      { at: parseClock('1200'), kind: 'message',
        text: '大隊本部より: 残り25分。丘を押さえられねば、今夜も車輌は通せない。' },
    ];
  },
});

/* ================================================================== */
/* ザーレンの確保 ─ 取った町を、砲兵なしで保つ                             */
/* ================================================================== */
//
// 攻めた翌日は、砲がまだ後ろにある。道が一本しかない回廊では、
// 弾薬より先に砲そのものが前へ出られない ── 4発というのは嫌がらせではなく、
// 昨日自分が前へ出たことの代価である。
//
// 撃てないなら、地形で守るしかない。市街の遮蔽はそのためにある。

const HOLD_T0 = parseClock('0620');
const HOLD_TEND = parseClock('0840');

export const MISSION_TOWN_HOLD = Object.freeze({
  id: 'zaren_hold',
  mapId: 'zaren_town',
  title: 'ザーレンの確保',
  phases: [
    { at: '0620', label: '払暁・警戒' }, { at: '0648', label: '斥候接触' },
    { at: '0710', label: '第一撃' }, { at: '0740', label: '西橋への圧力' },
    { at: '0810', label: '最終局面' },
  ],
  blurb: '昨日取った町を保つ。砲兵はまだ後ろにいる ─ 撃てる弾は4発しかない。',
  subtitle: 'ザーレン市街 / 第3中隊戦闘団 ─ 市街の防御',
  duration: 'short',
  seed: 990117,
  startTime: HOLD_T0,
  endTime: HOLD_TEND,

  weather: { mistStart: HOLD_T0, mistClear: parseClock('0745') },

  commandPost: { x: 950, y: 3180 },

  enemyGoal: { x: 2300, y: 2350 },

  victory: { kind: 'hold_point', label: '中央橋' },

  briefing: {
    situation:
      '旧市街は昨日のうちにこちらの手に戻った。敵は運河の北岸で再編しており、' +
      '夜が明けしだい取り返しに来る。渡れる橋は西橋・中央橋・鉄道橋の3本で、' +
      'どれも落とせない ─ 落とせば、今度はこちらが北へ出られなくなる。',
    mission:
      `0840に砲兵が前進を終えるまで、中央橋 ${toGrid(ZAREN_MAIN_X, zarenFront(ZAREN_MAIN_X))} を確保せよ。` +
      '旧市街を敵に渡してはならない。',
    execution:
      '砲は昨日の位置から動いていない。道が一本しかない以上、今日は間に合わない ─ ' +
      '撃てるのは4発だけである。市街の遮蔽と、建物の陰の30mを使って守れ。',
    notes: [
      '砲弾は4発しかない。半日ぶんではなく、一度きりの札である。どこで使うかを先に決めておくこと。',
      '橋は3本ある。全部を厚くはできない ─ どこを渡らせ、どこで止めるかを決めるのが今日の仕事である。',
      '市街の遮蔽は厚い。掩体を掘らせておけば、砲が無くても分隊は保つ。',
      '見通しが利かない。報告は近距離まで来ないと上がらない ─ ドローンを高く置くこと。',
      '払暁は運河筋に靄が残る。0745頃まで晴れない。',
      '敵が旧市街の南口に敷いた鉄条網は、そのまま残っている。今日はこちらの障害である。',
      '鉄道の築堤は、撃たれずに東西へ動ける唯一の線である。予備の移動に使える。',
    ],
  },

  objectives: [
    { id: 'hold_bridge', text: `0840まで中央橋 ${toGrid(ZAREN_MAIN_X, zarenFront(ZAREN_MAIN_X))} を確保する`, primary: true },
    { id: 'keep_force', text: '2個分隊以上を戦闘可能な状態で維持する', primary: true },
    { id: 'thrift', text: '砲弾を使い切らずに凌ぐ', primary: false },
  ],

  support: {
    artillery: { name: 'ソーン', rounds: 4 },
    smoke: { name: 'ソーン', rounds: 3 },
    illum: { name: 'ソーン', rounds: 3 },
  },

  rosterOrder: [
    { id: 'H1', callsign: 'ハンマー1', typeLabel: '歩兵分隊', role: '中央橋南詰の主陣地', icon: 'infantry', echelon: 1 },
    { id: 'H2', callsign: 'ハンマー2', typeLabel: '歩兵分隊', role: '旧市街の予備陣地', icon: 'infantry', echelon: 1 },
    { id: 'H3', callsign: 'ハンマー3', typeLabel: '歩兵分隊', role: '西橋の監視', icon: 'infantry', echelon: 1 },
    { id: 'H4', callsign: 'ハンマー4', typeLabel: '歩兵分隊', role: '鉄道橋の監視', icon: 'infantry', echelon: 1 },
    { id: 'SH', callsign: 'シールド', typeLabel: '機械化歩兵', role: '逆襲の予備', icon: 'mech', echelon: 1 },
    { id: 'SW', callsign: 'ソード', typeLabel: '対戦車班', role: '対戦車予備', icon: 'antitank', echelon: 'Ø' },
    { id: 'EG', callsign: 'イーグル', typeLabel: '偵察ドローン', role: '偵察', icon: 'uav', echelon: null },
    { id: 'TH', callsign: 'ソーン', typeLabel: '支援砲兵', role: '火力支援（4発）', icon: 'artillery', echelon: 1 },
  ],

  orbat: () => [
    { id: 'H1', side: 'friend', callsign: 'ハンマー1', type: 'infantry',
      x: 2350, y: 2050, posture: 'dug_in', state: 'defending', morale: 84,
      role: '中央橋南詰の主陣地' },
    { id: 'H2', side: 'friend', callsign: 'ハンマー2', type: 'infantry',
      x: 2180, y: 2180, posture: 'dug_in', state: 'defending', morale: 84,
      role: '旧市街の予備陣地' },
    { id: 'H3', side: 'friend', callsign: 'ハンマー3', type: 'infantry',
      x: 1350, y: 2150, posture: 'cautious', state: 'holding', morale: 80,
      role: '西橋の監視' },
    { id: 'H4', side: 'friend', callsign: 'ハンマー4', type: 'infantry',
      x: 3350, y: 2200, posture: 'cautious', state: 'holding', morale: 80,
      role: '鉄道橋の監視' },
    { id: 'SH', side: 'friend', callsign: 'シールド', type: 'mech',
      x: 2500, y: 2600, posture: 'normal', state: 'holding', morale: 86,
      role: '逆襲の予備' },
    { id: 'SW', side: 'friend', callsign: 'ソード', type: 'at_team',
      x: 2470, y: 2170, posture: 'dug_in', state: 'defending', morale: 86,
      role: '対戦車予備' },
    { id: 'EG', side: 'friend', callsign: 'イーグル', type: 'drone',
      x: 950, y: 3180, posture: 'normal', state: 'holding', morale: 100,
      role: '偵察ドローン' },
    { id: 'TH', side: 'friend', callsign: 'ソーン', type: 'mortar',
      x: 1200, y: 3300, posture: 'dug_in', state: 'defending', morale: 88,
      role: '支援砲兵（後方）' },
  ],

  timeline: (rng, opts) => {
    const jit = (base, spread) =>
      opts?.variable && rng ? base + Math.round(rng.range(-spread, spread) / 60) * 60 : base;

    const main = { x: ZAREN_MAIN_X, y: zarenFront(ZAREN_MAIN_X) };
    const rail = { x: ZAREN_RAIL_X, y: zarenFront(ZAREN_RAIL_X) };
    const west = { x: ZAREN_WEST_X, y: zarenFront(ZAREN_WEST_X) };

    // 主攻がどの橋に来るかは毎回変わる。3本あるので、地図を覚えても足りない。
    const westIsMain = opts?.variable && rng ? rng.chance(0.5) : false;

    return [
      { at: parseClock('0624'), kind: 'message',
        text: '大隊本部より: 敵は北岸で再編を終えつつある。砲兵の前進は0840、それまで手持ちで凌げ。' },
      { at: jit(parseClock('0648'), 240), kind: 'spawn', label: '敵斥候',
        units: [
          { id: 'E-R1', side: 'enemy', callsign: '敵斥候1', type: 'recon', x: 2400, y: 700,
            ai: { task: 'probe', objective: { x: 2420, y: 1500 } } },
          { id: 'E-R2', side: 'enemy', callsign: '敵斥候2', type: 'recon', x: 3300, y: 1150,
            ai: { task: 'probe', objective: { x: 3400, y: 1550 } } },
        ] },
      { at: jit(parseClock('0710'), 300), kind: 'spawn',
        label: westIsMain ? '中央橋への圧力（陽動）' : '中央橋への攻撃（主攻）',
        units: [
          { id: 'E-A1', side: 'enemy', callsign: '敵歩兵1', type: 'infantry', x: 2200, y: 600,
            ai: { task: 'assault', crossing: main, objective: { x: 2300, y: 2260 }, wave: 1 } },
          { id: 'E-A2', side: 'enemy', callsign: '敵歩兵2', type: 'infantry', x: 2480, y: 660,
            ai: westIsMain
              ? { task: 'pressure', objective: { x: 2440, y: 1560 }, wave: 1 }
              : { task: 'assault', crossing: main, objective: { x: 2380, y: 2200 }, wave: 1 } },
          { id: 'E-M1', side: 'enemy', callsign: '敵機械化1', type: 'mech', x: 2360, y: 520,
            ai: { task: 'assault', crossing: main, objective: { x: 2320, y: 2320 }, wave: 1 } },
          { id: 'E-MT', side: 'enemy', callsign: '敵迫撃砲', type: 'mortar', x: 2560, y: 480,
            ai: { task: 'support' } },
        ] },
      { at: jit(parseClock('0728'), 240), kind: 'jamming', value: 0.3, label: '電子妨害' },
      { at: jit(parseClock('0740'), 360), kind: 'spawn',
        label: westIsMain ? '西橋への迂回（主攻）' : '西橋への迂回（助攻）',
        units: [
          { id: 'E-F1', side: 'enemy', callsign: '敵歩兵3', type: 'infantry', x: 1250, y: 800,
            ai: { task: 'flank', crossing: west, objective: { x: 1600, y: 2420 }, wave: 2 } },
          ...(westIsMain
            ? [{ id: 'E-F2', side: 'enemy', callsign: '敵歩兵4', type: 'infantry', x: 1100, y: 900,
                ai: { task: 'flank', crossing: west, objective: { x: 1900, y: 2380 }, wave: 2 } }]
            : []),
        ] },
      { at: jit(parseClock('0748'), 240), kind: 'spawn', label: '敵の予備（北市街）',
        units: [
          { id: 'E-RS1', side: 'enemy', callsign: '敵予備1', type: 'mech', x: 2450, y: 1400,
            ai: { task: 'reserve' } },
          { id: 'E-RS2', side: 'enemy', callsign: '敵予備2', type: 'infantry', x: 2700, y: 1300,
            ai: { task: 'reserve' } },
        ] },
      { at: jit(parseClock('0806'), 300), kind: 'spawn', label: '鉄道橋への装甲',
        units: [
          { id: 'E-T1', side: 'enemy', callsign: '敵戦車1', type: 'tank', x: 3450, y: 700,
            ai: { task: 'assault', crossing: rail, objective: { x: 3150, y: 2500 }, wave: 3 } },
          { id: 'E-A3', side: 'enemy', callsign: '敵歩兵5', type: 'infantry', x: 3300, y: 820,
            ai: { task: 'assault', crossing: rail, objective: { x: 3000, y: 2460 }, wave: 3 } },
        ] },
      { at: parseClock('0818'), kind: 'message',
        text: '大隊本部より: 砲兵の前進は0840。あと20分、旧市街を渡すな。' },
    ];
  },
});
