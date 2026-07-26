// ゲーム状態。ここが「真実」と「指揮官の認識」を分ける境界線。
//
// world  … 真実。全ユニットの実位置・実兵力。UI層は決して読まない。
// belief … 指揮官が知っていること。無線で届いた断片だけから組み立てる。
//
// UI モジュールは belief と terrain しか受け取らない。地図は指揮官の手元にある
// ものなので地形は見てよいが、その上に誰がいるかは一切見えない。

import { createWorld, tick } from './sim/world.js';
import { issueOrder as simIssueOrder } from './sim/orders.js';
import { congestion } from './sim/comms.js';
import { visibilityJa } from './sim/weather.js';
import { scoreMission } from './sim/scenario.js';
import { toGrid, fromGrid, formatClock } from './util.js';

let markerSeq = 1;

// 地図に書き込める記号。枠の形と中の絵は APP-6 の作法に従う。
const HOSTILE = '#b4302a';
const FRIEND = '#1a4f9c';

export const MARKER_TYPES = Object.freeze({
  enemy_inf: { label: '敵歩兵', short: '歩', color: HOSTILE, affiliation: 'hostile', icon: 'infantry' },
  enemy_mech: { label: '敵装甲車', short: '装車', color: HOSTILE, affiliation: 'hostile', icon: 'mech' },
  enemy_armor: { label: '敵戦車', short: '戦車', color: HOSTILE, affiliation: 'hostile', icon: 'armor' },
  enemy_at: { label: '敵対戦車', short: '対戦', color: HOSTILE, affiliation: 'hostile', icon: 'antitank' },
  enemy_arty: { label: '敵砲迫', short: '砲', color: HOSTILE, affiliation: 'hostile', icon: 'artillery' },
  unknown: { label: '正体不明', short: '不明', color: '#8a6a10', affiliation: 'unknown', icon: null },
  friendly: { label: '自軍', short: '自', color: FRIEND, affiliation: 'friend', icon: 'infantry' },
  obstacle: { label: '障害', short: '障', color: '#2f2a22', graphic: 'obstacle' },
  objective: { label: '目標', short: '目', color: '#1d7a45', graphic: 'objective' },
  note: { label: 'メモ', short: 'メモ', color: '#2f2a22', graphic: 'note' },
});

export const CONFIDENCE = Object.freeze({
  confirmed: { label: '確認', short: '', dash: null },
  estimated: { label: '推定', short: '推定', dash: [6, 4] },
  unconfirmed: { label: '未確認', short: '未確認', dash: [2, 3.5] },
});

// 記号だけでは書けないもの ― 敵の進出方向、部隊の境界、火力を集中させる範囲。
// 指揮官は点ではなく線と面でも考えるので、その道具を用意する。
export const SKETCH_TOOLS = Object.freeze({
  arrow_enemy: { label: '敵の進路', kind: 'arrow', color: HOSTILE },
  arrow_friend: { label: '味方の機動', kind: 'arrow', color: FRIEND },
  line_control: { label: '統制線', kind: 'line', color: '#2f2a22', dash: [9, 6] },
  area_enemy: { label: '要注意区域', kind: 'area', color: HOSTILE },
  free: { label: '自由線', kind: 'free', color: '#2f2a22' },
});

export function createGame(opts = {}) {
  // 「敵の企図を変える」を選んだときだけ、盤ごとに違う目を配る。
  // 地形と自軍の配置は変えない ― 変わるのは敵が何を考えているかだけ。
  const world = createWorld({
    variable: !!opts.variable,
    planSeed: opts.variable ? Math.floor(Math.random() * 0x7fffffff) + 1 : 0,
  });

  return {
    world,

    // 指揮官の認識
    belief: {
      markers: [],
      sketches: [],
      roster: new Map(), // unitId -> 最後に「聞いた」内容
      log: [],
      unread: 0,
    },

    // アセテートの取り消し履歴（書き込みは小さいので丸ごと控える）
    history: [],

    // 進行制御
    running: false,
    speed: 1,
    simSecondsPerRealSecond: 6, // x1 で 2時間の戦闘が約20分になる
    finished: false,
    score: null,
  };
}

/* ------------------------------------------------------------------ */
/* 進行                                                                */
/* ------------------------------------------------------------------ */

/**
 * dt 実秒ぶんシミュレーションを進める。
 * @returns {Array} 新たに届いた無線ログ
 */
export function advance(game, realDt) {
  if (!game.running || game.finished) return [];

  const simSeconds = realDt * game.simSecondsPerRealSecond * game.speed;
  game._carry = (game._carry ?? 0) + simSeconds;

  const fresh = [];
  let steps = Math.floor(game._carry);
  game._carry -= steps;
  // 1フレームで進めすぎない（タブ復帰直後の巨大な dt 対策）
  steps = Math.min(steps, 400);

  for (let i = 0; i < steps; i++) {
    const delivered = tick(game.world, 1);
    for (const entry of delivered) fresh.push(entry);
    if (game.world.outcome) break;
  }

  for (const entry of fresh) absorb(game, entry);

  if (game.world.outcome && !game.finished) {
    game.finished = true;
    game.running = false;
    game.score = scoreMission(game.world, game.world.outcome);
  }

  return fresh;
}

/** 届いた1通を指揮官の認識に取り込む */
function absorb(game, entry) {
  game.belief.log.push(entry);
  game.belief.unread++;

  const self = entry.meta?.self;
  if (!entry.fromId || !self || entry.lost) return;

  const prev = game.belief.roster.get(entry.fromId) ?? {};
  game.belief.roster.set(entry.fromId, {
    ...prev,
    unitId: entry.fromId,
    callsign: entry.from,
    heardAt: entry.at,
    observedAt: entry.observedAt ?? entry.at,
    grid: self.grid,
    strength: self.strength,
    strengthRatio: self.strengthRatio,
    morale: self.morale,
    state: self.state,
    posture: self.posture,
    ammoRatio: self.ammoRatio,
    lastKind: entry.kind,
  });
}

/* ------------------------------------------------------------------ */
/* 指揮官の操作                                                         */
/* ------------------------------------------------------------------ */

/** 命令を発令する。UI からはここだけを呼ぶ。 */
export function issueOrder(game, { unitId, verb, x, y, modifier }) {
  const order = simIssueOrder(game.world, { unitId, verb, x, y, modifier });
  if (order) {
    const r = game.belief.roster.get(unitId);
    if (r) r.pendingOrder = { verb, grid: order.grid, at: order.issuedAt };
  }
  return order;
}

/* ------------------------------------------------------------------ */
/* マーカー                                                            */
/* ------------------------------------------------------------------ */

/* --- 取り消し ------------------------------------------------------ */

const HISTORY_LIMIT = 60;

/** 書き込みを変える前に、今の状態を控えておく */
export function snapshot(game) {
  game.history.push({
    markers: game.belief.markers.map((m) => ({ ...m })),
    sketches: game.belief.sketches.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
  });
  if (game.history.length > HISTORY_LIMIT) game.history.shift();
}

/** 直前の書き込みを取り消す */
export function undo(game) {
  const prev = game.history.pop();
  if (!prev) return false;
  game.belief.markers = prev.markers;
  game.belief.sketches = prev.sketches;
  return true;
}

export function canUndo(game) {
  return game.history.length > 0;
}

/* --- 記号 ---------------------------------------------------------- */

export function addMarker(game, { x, y, type = 'enemy_inf', confidence = 'estimated', label = '' }) {
  snapshot(game);
  const marker = {
    id: `M${markerSeq++}`,
    x,
    y,
    type,
    confidence,
    label,
    createdAt: game.world.now,
    updatedAt: game.world.now,
  };
  game.belief.markers.push(marker);
  return marker;
}

export function moveMarker(game, id, x, y, { record = false } = {}) {
  const m = game.belief.markers.find((m) => m.id === id);
  if (!m) return;
  if (record) snapshot(game);
  m.x = x;
  m.y = y;
  m.updatedAt = game.world.now;
}

export function updateMarker(game, id, patch) {
  const m = game.belief.markers.find((m) => m.id === id);
  if (!m) return;
  Object.assign(m, patch);
  m.updatedAt = game.world.now;
}

export function removeMarker(game, id) {
  if (!game.belief.markers.some((m) => m.id === id)) return;
  snapshot(game);
  game.belief.markers = game.belief.markers.filter((m) => m.id !== id);
}

/** 全部消す */
export function clearMarkings(game) {
  if (!game.belief.markers.length && !game.belief.sketches.length) return;
  snapshot(game);
  game.belief.markers = [];
  game.belief.sketches = [];
}

/* --- 作図 ---------------------------------------------------------- */

let sketchSeq = 1;

export function addSketch(game, { tool, points }) {
  const spec = SKETCH_TOOLS[tool];
  if (!spec || points.length < 2) return null;
  snapshot(game);
  const sketch = {
    id: `S${sketchSeq++}`,
    tool,
    kind: spec.kind,
    color: spec.color,
    dash: spec.dash ?? null,
    points: points.map((p) => ({ x: p.x, y: p.y })),
    createdAt: game.world.now,
    updatedAt: game.world.now,
  };
  game.belief.sketches.push(sketch);
  return sketch;
}

export function removeSketch(game, id) {
  if (!game.belief.sketches.some((s) => s.id === id)) return;
  snapshot(game);
  game.belief.sketches = game.belief.sketches.filter((s) => s.id !== id);
}

export function getSketches(game) {
  return game.belief.sketches;
}

/** 作図の鮮度。記号ほど急には古びない（企図の見立ては長く効く）。 */
export function sketchFreshness(game, sketch) {
  const age = game.world.now - sketch.updatedAt;
  return Math.max(0.45, 1 - age / 2400);
}

/** マーカーの鮮度 0..1（1 = たった今、0 = 完全に古い） */
export function markerFreshness(game, marker) {
  const age = game.world.now - marker.updatedAt;
  const LIFE = 900; // 15分で色褪せきる
  return Math.max(0, 1 - age / LIFE);
}

/* ------------------------------------------------------------------ */
/* UI 向けの読み出し（ここを通らない情報は画面に出さない）                  */
/* ------------------------------------------------------------------ */

export function getTerrain(game) {
  return game.world.terrain;
}

export function getClock(game) {
  return formatClock(game.world.now);
}

export function getSimTime(game) {
  return game.world.now;
}

export function getMission(game) {
  return game.world.mission;
}

export function getCommandPost(game) {
  return game.world.commandPost;
}

/** 部隊一覧。指揮官が「最後に聞いた」内容だけを返す。 */
export function getRoster(game) {
  const out = [];
  for (const def of game.world.mission.rosterOrder ?? DEFAULT_ROSTER_ORDER) {
    const heard = game.belief.roster.get(def.id);
    out.push({
      unitId: def.id,
      callsign: def.callsign,
      typeLabel: def.typeLabel,
      role: def.role,
      heard: heard ?? null,
      silentFor: heard ? game.world.now - heard.heardAt : null,
    });
  }
  return out;
}

// 指揮下の部隊は最初から分かっている（編成表は指揮所にある）。
// 分からないのは「今どうなっているか」だけ。
const DEFAULT_ROSTER_ORDER = [
  { id: 'H1', callsign: 'ハンマー1', typeLabel: '歩兵分隊', role: '橋梁南詰の主陣地',
    icon: 'infantry', echelon: 1 },
  { id: 'H2', callsign: 'ハンマー2', typeLabel: '歩兵分隊', role: '集落の予備陣地',
    icon: 'infantry', echelon: 1 },
  { id: 'H3', callsign: 'ハンマー3', typeLabel: '歩兵分隊', role: '北岸の前進哨所',
    icon: 'infantry', echelon: 1 },
  { id: 'SW', callsign: 'ソード', typeLabel: '対戦車班', role: '対戦車予備',
    icon: 'antitank', echelon: 'Ø' },
  { id: 'EG', callsign: 'イーグル', typeLabel: '偵察ドローン', role: '偵察',
    icon: 'uav', echelon: null },
  { id: 'TH', callsign: 'ソーン', typeLabel: '支援砲兵', role: '火力支援',
    icon: 'artillery', echelon: 1 },
];

export function getRosterOrder() {
  return DEFAULT_ROSTER_ORDER;
}

export function getLog(game) {
  return game.belief.log;
}

export function getMarkers(game) {
  return game.belief.markers;
}

export function getSupport(game) {
  return {
    artillery: game.world.support.artillery.rounds,
    smoke: game.world.support.smoke.rounds,
  };
}

/**
 * 自分が要請した射撃任務。どこに撃てと言ったかは指揮官自身が知っている。
 * 敵の射撃任務は当然見えない。
 */
export function getOwnFireMissions(game) {
  return game.world.fireMissions
    .filter((fm) => fm.side === 'friend')
    .map((fm) => ({
      id: fm.id,
      kind: fm.kind,
      x: fm.x,
      y: fm.y,
      radius: fm.radius,
      done: fm.done,
      nextImpactAt: fm.nextImpactAt,
      completedAt: fm.completedAt,
      roundsLeft: fm.roundsLeft,
    }));
}

/** 視程。指揮所の窓からでも、霧が谷を埋めていることは分かる。 */
export function getVisibility(game) {
  return visibilityJa(game.world);
}

/** 無線の状態（混雑・妨害）。指揮官には「今誰かが喋っている」ことは分かる。 */
export function getRadioStatus(game) {
  const radio = game.world.radio;
  return {
    busy: game.world.now < radio.busyUntil,
    speaking: radio.speaking ? radio.speaking.from : null,
    queued: radio.queue.length,
    congestion: congestion(game.world),
    jamming: radio.jamming,
  };
}

export function getOutcome(game) {
  return game.world.outcome
    ? { status: game.world.outcome, reason: game.world.outcomeReason, score: game.score }
    : null;
}

/**
 * 真実の開示。戦闘が終わったあとの講評でのみ呼ばれる。
 * 戦闘中にこれを呼ぶとゲームが成立しないので、明示的に拒否する。
 */
export function revealTruth(game) {
  if (!game.finished) return null;
  return {
    units: game.world.units.map((u) => ({
      id: u.id,
      side: u.side,
      callsign: u.callsign,
      typeLabel: u.tpl.label,
      x: u.x,
      y: u.y,
      alive: u.alive,
      evacuated: !!u.evacuated,
      strength: u.strength,
      maxStrength: u.maxStrength,
      unitJa: u.tpl.unitJa,
      losses: u.losses,
      inflicted: u.inflicted,
      killedByFriendly: u.killedByFriendly,
      deathAt: u.deathAt,
      state: u.state,
      role: u.role ?? null,
    })),
  };
}

export { toGrid, fromGrid, formatClock };
export { VERBS, MODIFIERS } from './sim/orders.js';
