// ゲーム状態。ここが「真実」と「指揮官の認識」を分ける境界線。
//
// world  … 真実。全ユニットの実位置・実兵力。UI層は決して読まない。
// belief … 指揮官が知っていること。無線で届いた断片だけから組み立てる。
//
// UI モジュールは belief と terrain しか受け取らない。地図は指揮官の手元にある
// ものなので地形は見てよいが、その上に誰がいるかは一切見えない。

import { createWorld, tick, spawnReinforcement } from './sim/world.js';
import { replenish, REINFORCEMENTS } from './sim/creative.js';
import { issueOrder as simIssueOrder, VERBS } from './sim/orders.js';
import { congestion } from './sim/comms.js';
import { enemyIntentLog } from './sim/enemyCommand.js';
import { visibilityJa } from './sim/weather.js';
import { supportGun, layingLeft } from './sim/fires.js';
import { scoreMission, missionList } from './sim/scenario.js';
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
    missionId: opts.missionId,
    variable: !!opts.variable,
    planSeed: opts.variable ? Math.floor(Math.random() * 0x7fffffff) + 1 : 0,
    creative: { enabled: !!opts.creative },
  });
  const long = world.mission.duration === 'long';

  return {
    world,

    // 指揮官の認識
    belief: {
      markers: [],
      sketches: [],
      roster: new Map(), // unitId -> 最後に「聞いた」内容
      roe: new Map(), // unitId -> 与えた交戦規定
      held: new Map(), // unitId -> 渡してある予令
      log: [],
      unread: 0,
    },

    // アセテートの取り消し履歴（書き込みは小さいので丸ごと控える）
    history: [],

    // 進行制御
    running: false,
    speed: 1,
    // x1 で 2時間の戦闘が約20分になる。半日の戦闘は同じ比では長すぎるので、
    // 基準を上げたうえで x8 まで出せるようにする（静穏を飛ばすため）。
    simSecondsPerRealSecond: long ? 14 : 6,
    maxSpeed: long ? 8 : 4,
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

  // 予令が発動したことは、部下からそう聞かされて初めて分かる
  if (entry.kind === 'initiative' && entry.meta?.orderId && !entry.lost) {
    const held = game.belief.held.get(entry.fromId);
    if (held?.orderId === entry.meta.orderId) game.belief.held.delete(entry.fromId);
  }

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
    fatigue: self.fatigue ?? null,
    resting: !!self.resting,
    wounded: !!self.wounded,
    lastKind: entry.kind,
  });
}

/* ------------------------------------------------------------------ */
/* 指揮官の操作                                                         */
/* ------------------------------------------------------------------ */

/** 命令を発令する。UI からはここだけを呼ぶ。 */
export function issueOrder(game, { unitId, verb, x, y, modifier, legs, trigger, triggerAt, lineId }) {
  // 統制線を条件にする場合、線そのものを命令に添えて渡す。
  // 部下は地図を見ているわけではないので、線は言葉として伝わる必要がある。
  const line = lineId ? getControlLines(game).find((l) => l.id === lineId) : null;
  const order = simIssueOrder(game.world, {
    unitId, verb, x, y, modifier, legs, trigger, triggerAt,
    line: line ? line.points : null,
    lineName: line ? line.name : null,
  });
  if (order) {
    const r = game.belief.roster.get(unitId);
    if (r) r.pendingOrder = { verb, grid: order.grid, at: order.issuedAt };
    // 交戦規定は指揮官自身が出した枠なので、届く前から手元の控えに残る
    const roe = VERBS[verb]?.roe;
    if (roe) game.belief.roe.set(unitId, roe);
    // 予令も同じ。渡した控えは指揮所に残る（発動したかは無線で知る）
    if (order.trigger && order.trigger !== 'now') {
      game.belief.held.set(unitId, {
        orderId: order.id,
        verb,
        grid: order.grid,
        trigger: order.trigger,
        triggerAt: order.triggerAt,
        at: order.issuedAt,
      });
    }
  }
  return order;
}

/* ------------------------------------------------------------------ */
/* 演習モード                                                           */
/* ------------------------------------------------------------------ */

export function isCreative(game) {
  return !!game?.world.creative;
}

/** 演習の設定（真実表示の入切など） */
export function getCreative(game) {
  const c = game?.world.creative;
  if (!c) return null;
  return {
    reveal: c.reveal,
    called: c.called,
    enemiesPlaced: c.enemiesPlaced,
    invulnerable: c.invulnerable,
  };
}

/**
 * 演習統裁の操作。
 * これは無線ではない ─ 盤の外から手を入れる行為なので、遅れも届かないもない。
 * @returns {{ok:boolean, text:string}}
 */
export function creativeAction(game, { action, unitType, x, y }) {
  const world = game.world;
  const cre = world.creative;
  if (!cre) return { ok: false, text: '演習モードではない。' };

  switch (action) {
    case 'call_friend': {
      const u = spawnReinforcement(world, { type: unitType, x, y, side: 'friend' });
      if (!u) return { ok: false, text: 'その兵種は呼べない。' };
      return { ok: true, text: `${u.callsign}（${u.tpl.label}）が到着した。` };
    }
    case 'place_enemy': {
      const u = spawnReinforcement(world, { type: unitType, x, y, side: 'enemy' });
      if (!u) return { ok: false, text: 'その兵種は置けない。' };
      return { ok: true, text: `敵の${u.tpl.label}を ${toGrid(x, y)} に置いた。` };
    }
    case 'replenish': {
      let n = 0;
      for (const u of world.units) {
        if (u.side !== 'friend') continue;
        if (replenish(u)) n++;
      }
      return { ok: true, text: `${n}個部隊を充足させた。` };
    }
    case 'clear_enemy': {
      let n = 0;
      for (const u of world.units) {
        if (u.side !== 'enemy' || !u.alive) continue;
        u.alive = false;
        u.strength = 0;
        u.state = 'destroyed';
        u.deathAt = world.now;
        u.path = [];
        u.dest = null;
        n++;
      }
      return { ok: true, text: `敵${n}個部隊を盤から除いた。` };
    }
    case 'reveal': {
      cre.reveal = !cre.reveal;
      return { ok: true, text: cre.reveal ? '真実の地図を開いた。' : '真実の地図を伏せた。' };
    }
    default:
      return { ok: false, text: '知らない操作である。' };
  }
}

/**
 * 真実の開示（演習モードのみ）。
 *
 * 本編でこれを返すことは絶対にない。ここが「見えない」ことでゲームが
 * 成り立っているので、開けるのは演習の盤に限る。
 */
export function getRevealed(game) {
  const cre = game?.world.creative;
  if (!cre?.reveal) return null;
  return game.world.units
    .filter((u) => u.alive)
    .map((u) => ({
      id: u.id,
      side: u.side,
      callsign: u.callsign,
      type: u.type,
      typeLabel: u.tpl.label,
      x: u.x,
      y: u.y,
      heading: u.heading,
      strength: u.strength,
      maxStrength: u.maxStrength,
      state: u.state,
      immobile: !!u._immobile,
    }));
}

/** その部隊に渡してある予令（指揮所の控え） */
export function getHeldOrder(game, unitId) {
  return game.belief.held.get(unitId) ?? null;
}

/** 各部隊に与えた交戦規定（指揮官自身の控え） */
export function getRoeOf(game, unitId) {
  return game.belief.roe.get(unitId) ?? 'standard';
}

/**
 * 概定射点。自分が「ここを標定しておけ」と言った点なので指揮官は当然知っている。
 */
export function getRegistrations(game) {
  return game.world.registrations.map((rp) => ({
    id: rp.id,
    x: rp.x,
    y: rp.y,
    grid: rp.grid,
    ready: game.world.now >= rp.readyAt,
    readyIn: Math.max(0, Math.round(rp.readyAt - game.world.now)),
  }));
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

export function addMarker(
  game,
  {
    x, y, type = 'enemy_inf', confidence = 'estimated', label = '',
    unitId = null, icon = null, echelon = null,
  }
) {
  snapshot(game);
  const marker = {
    id: `M${markerSeq++}`,
    x,
    y,
    type,
    confidence,
    label,
    // 自軍の記号は、どの部隊のものかを覚えておく。
    // 覚えていれば、次からは名前を打ち直さずに位置だけ付け替えられる。
    unitId,
    // 兵科の絵と部隊規模。指定が無ければ記号の種別に従う。
    icon,
    echelon,
    createdAt: game.world.now,
    updatedAt: game.world.now,
  };
  game.belief.markers.push(marker);
  return marker;
}

/**
 * その部隊の記号を「最後に聞いた位置」に置く。すでに置いてあれば動かす。
 *
 * 指揮官が自軍の位置を地図に写す作業は、本来こういうものである ―
 * 報告を聞くたび、その分隊の駒を動かす。名前を書き直したりはしない。
 * 確度は報告の古さから決める（古い報告で置いた駒は、そう見えるようにする）。
 *
 * @returns {object|null} 置いた／動かした記号。まだ交信が無ければ null。
 */
export function markUnit(game, unitId) {
  const heard = game.belief.roster.get(unitId);
  if (!heard?.grid) return null;
  const p = fromGrid(heard.grid);
  if (!p) return null;

  const age = game.world.now - (heard.observedAt ?? heard.heardAt);
  const confidence = age < 150 ? 'confirmed' : age < 480 ? 'estimated' : 'unconfirmed';

  // 編成表に載っている兵科で描く。呼出符号だけでなく、絵でも見分けられる。
  const def = getRosterOrder(game).find((r) => r.id === unitId);

  const existing = game.belief.markers.find((m) => m.unitId === unitId);
  if (existing) {
    snapshot(game);
    existing.x = p.x;
    existing.y = p.y;
    existing.confidence = confidence;
    existing.label = heard.callsign;
    existing.updatedAt = game.world.now;
    return existing;
  }

  return addMarker(game, {
    x: p.x,
    y: p.y,
    type: 'friendly',
    confidence,
    label: heard.callsign,
    unitId,
    icon: def?.icon ?? 'infantry',
    echelon: def?.echelon ?? null,
  });
}

/** 自軍の呼出符号（記号のラベルに一発で貼れるようにするため） */
export function getCallsigns(game) {
  return getRosterOrder(game)
    .filter((u) => !u.virtual)
    .map((u) => u.callsign);
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
  // 統制線には名前を付ける。名前がなければ無線で呼べず、
  // 呼べなければ「あの線を越えたら」という命令が出せない。
  if (tool === 'line_control') {
    const used = new Set(game.belief.sketches.filter((s) => s.name).map((s) => s.name));
    for (const ch of '甲乙丙丁戊己庚辛') {
      if (!used.has(ch)) {
        sketch.name = ch;
        break;
      }
    }
    sketch.name ??= String(game.belief.sketches.length + 1);
  }
  game.belief.sketches.push(sketch);
  return sketch;
}

/**
 * 引いてある統制線。
 * 指揮官が自分で引いた線なので、当然その位置を知っている。
 * これを予令の発動条件に使える ── 「統制線甲を敵が越えたら下がれ」。
 */
export function getControlLines(game) {
  return game.belief.sketches
    .filter((s) => s.tool === 'line_control' && s.points.length >= 2)
    .map((s) => ({ id: s.id, name: s.name ?? '?', points: s.points }));
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

/**
 * 地図に刷ってある障害。
 *
 * 自軍の工兵が敷いたものは、指揮所の障害計画に載っているので当然知っている。
 * 敵が敷いたものは載っていない ─ 誰かが引っかかって報告するまで、地図に無い。
 */
export function getKnownObstacles(game) {
  return (game.world.terrain.obstacles ?? []).filter((o) => o.known);
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
  for (const def of getRosterOrder(game)) {
    if (def.virtual) continue;
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

export function getRosterOrder(game) {
  const base = game?.world.mission.rosterOrder ?? DEFAULT_ROSTER_ORDER;
  const cre = game?.world.creative;
  if (!cre) return base;
  // 演習では「統裁」が命令パネルに並ぶ。部隊ではないので一覧には出さない。
  return [...base, ...cre.roster, CREATIVE_ENTRY];
}

const CREATIVE_ENTRY = Object.freeze({
  id: 'CRE',
  callsign: '演習統裁',
  typeLabel: '演習',
  role: '増援の呼び出し・敵の配置・部隊の補充',
  icon: null,
  echelon: null,
  virtual: true,
});

/**
 * 兵站の状況。指揮所の帳簿にあたる ─ ここは推測ではなく事実で分かる。
 * 集積所は指揮所の後ろにあり、何基数残っているかは数えれば分かるからである。
 */
export function getTrains(game) {
  const t = game.world.trains;
  if (!t) return null;
  const carrier = game.world.unitsById.get(t.unitId);
  const target = t.task ? game.world.unitsById.get(t.task.targetId) : null;
  return {
    callsign: carrier?.callsign ?? 'ラーダー',
    alive: !!carrier?.alive,
    loadsLeft: t.loadsLeft,
    loads: t.loads,
    busyWith: target?.callsign ?? null,
    phase: t.task?.phase ?? null,
  };
}

/** 遊べるミッションの一覧（ブリーフィングの選択肢） */
export function getMissionList() {
  return missionList().map((m) => ({
    id: m.id,
    title: m.title,
    subtitle: m.subtitle,
    mapId: m.mapId,
    duration: m.duration,
    startTime: m.startTime,
    endTime: m.endTime,
    kind: m.victory?.kind ?? 'hold_point',
    blurb: m.blurb ?? null,
  }));
}

/** その戦闘の図幅 */
export function getMapInfo(game) {
  const t = game.world.terrain;
  return { id: t.mapId, name: t.mapName, note: t.mapNote };
}

/** 長期戦かどうか（UI が段列や速度の上限を出し分けるのに使う） */
export function isLongBattle(game) {
  return game.world.mission.duration === 'long';
}

export function getLog(game) {
  return game.belief.log;
}

export function getMarkers(game) {
  return game.belief.markers;
}

export function getSupport(game) {
  const w = game.world;
  const gun = supportGun(w);
  return {
    artillery: w.support.artillery.rounds,
    smoke: w.support.smoke.rounds,
    illum: w.support.illum.rounds,
    unlimited: !!w.creative?.unlimitedFires,
    // 砲の状態は指揮所の帳簿で分かる ─ 自分がそこへ動かしたのだから。
    gunAlive: !!gun,
    layingIn: gun ? Math.round(layingLeft(w, gun)) : 0,
    gunRange: gun ? gun.tpl.indirect : 0,
    firing: w.fireMissions.some((fm) => !fm.done && fm.side === 'friend'),
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
    // 敵が何を考え、どこで決心を変えたか。ここが講評で一番効く。
    enemyIntent: enemyIntentLog(game.world).map((e) => ({ at: e.at, text: e.text })),
  };
}

export { toGrid, fromGrid, formatClock };
export { VERBS, MODIFIERS, VERB_GROUPS, TRIGGERS } from './sim/orders.js';
export { FIRE_MODES, FIRE_MODE_ORDER } from './sim/fires.js';
export { REINFORCEMENTS };
export { ROE } from './sim/friendlyAI.js';
