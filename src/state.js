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
import { scoreMission } from './sim/scenario.js';
import { toGrid, fromGrid, formatClock } from './util.js';

let markerSeq = 1;

export const MARKER_TYPES = Object.freeze({
  enemy_inf: { label: '敵歩兵', color: '#e2504a', glyph: '▲' },
  enemy_armor: { label: '敵装甲', color: '#e2504a', glyph: '◆' },
  enemy_arty: { label: '敵砲兵', color: '#e2504a', glyph: '✦' },
  friendly: { label: '自軍', color: '#4d9de0', glyph: '●' },
  obstacle: { label: '障害物', color: '#e0b04d', glyph: '✕' },
  objective: { label: '目標', color: '#5fd08a', glyph: '★' },
  note: { label: 'メモ', color: '#b9b2a5', glyph: '■' },
});

export const CONFIDENCE = Object.freeze({
  confirmed: { label: '確認', dash: null },
  estimated: { label: '推定', dash: [7, 4] },
  unconfirmed: { label: '未確認', dash: [2, 4] },
});

export function createGame() {
  const world = createWorld();

  return {
    world,

    // 指揮官の認識
    belief: {
      markers: [],
      roster: new Map(), // unitId -> 最後に「聞いた」内容
      log: [],
      unread: 0,
    },

    // 進行制御
    running: false,
    speed: 1,
    simSecondsPerRealSecond: 6, // x1 で 2時間の戦闘が約20分になる
    finished: false,
    score: null,

    // 命令の組み立て中の状態（UI が触る）
    draft: { unitId: null, verb: null, modifier: 'normal', x: null, y: null },
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

export function addMarker(game, { x, y, type = 'enemy_inf', confidence = 'estimated', label = '' }) {
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

export function moveMarker(game, id, x, y) {
  const m = game.belief.markers.find((m) => m.id === id);
  if (!m) return;
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
  game.belief.markers = game.belief.markers.filter((m) => m.id !== id);
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
  { id: 'H1', callsign: 'ハンマー1', typeLabel: '歩兵分隊', role: '橋梁南詰の主陣地' },
  { id: 'H2', callsign: 'ハンマー2', typeLabel: '歩兵分隊', role: '集落の予備陣地' },
  { id: 'H3', callsign: 'ハンマー3', typeLabel: '歩兵分隊', role: '北岸の前進哨所' },
  { id: 'SW', callsign: 'ソード', typeLabel: '対戦車班', role: '対戦車予備' },
  { id: 'EG', callsign: 'イーグル', typeLabel: '偵察ドローン', role: '偵察' },
  { id: 'TH', callsign: 'ソーン', typeLabel: '支援砲兵', role: '火力支援' },
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
