// ゲーム状態。ここが「真実」と「指揮官の認識」を分ける境界線。
//
// world  … 真実。全ユニットの実位置・実兵力。UI層は決して読まない。
// belief … 指揮官が知っていること。無線で届いた断片だけから組み立てる。
//
// UI モジュールは belief と terrain しか受け取らない。地図は指揮官の手元にある
// ものなので地形は見てよいが、その上に誰がいるかは一切見えない。

import { createWorld, tick, spawnReinforcement, endPlanning, planningTick } from './sim/world.js';
import { replenish, REINFORCEMENTS } from './sim/creative.js';
import { issueOrder as simIssueOrder, VERBS } from './sim/orders.js';
import { congestion } from './sim/comms.js';
import { enemyIntentLog } from './sim/enemyCommand.js';
import { visibilityJa } from './sim/weather.js';
import { supportGun, layingLeft } from './sim/fires.js';
import {
  scoreMission, missionList, battleReport, friendlyOrderOfBattle,
  getMission as simGetMission,
} from './sim/scenario.js';
import { UNIT_TYPES } from './sim/units.js';
import {
  CAMPAIGNS, getCampaign, createCampaign, currentStage, battleSetup, recordBattle,
  replacementRoom, assignedTotal, allottedTotal, poolLeft,
  NIGHT_PLANS, NIGHT_PLAN_IDS, serializeCampaign, deserializeCampaign,
  attachAsset, detachAsset, assetsLeft, canAttach, campaignList,
  settleNight, purgeOfficer, decorateOfficer, waveringUnits, purgeCost,
} from './sim/campaign.js';
import {
  NATION, METERS, DECREES, DECREE_GROUPS, DECREE_IDS, DECREE_LIMIT,
  canDecree, decree, revokeDecree, liftStanding, ruleSummary,
} from './sim/nation.js';
import { ATTACHMENTS, attachmentShort, attachmentLabels } from './sim/attachments.js';
import { TEMPERAMENTS, TRAITS, gradeOf, officerLine } from './sim/officers.js';
import { Rng, toGrid, fromGrid, formatClock } from './util.js';

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

// 報告された兵種を、地図に置く記号に対応させる。
// 対応するのは「報告された正体」であって、実際の正体ではない。
export const CLASSIFIED_TO_MARKER = Object.freeze({
  infantry: 'enemy_inf',
  recon: 'enemy_inf',
  at_team: 'enemy_at',
  mech: 'enemy_mech',
  tank: 'enemy_armor',
  mortar: 'enemy_arty',
  obstacle: 'obstacle',
  convoy: 'unknown',
  drone: 'unknown',
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
    // 戦役の持ち越し。単発の戦闘では渡されない。
    setup: opts.setup ?? null,
    // H時前の計画。既定で入る ─ 命令も出さずに戦闘が始まる方がおかしい。
    planning: opts.planning !== false,
  });
  const long = world.mission.duration === 'long';

  const game = {
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
      // 指揮官が自分の手で盤から下ろした駒の出所。
      // 一度下ろしたものを無線が勝手に載せ直しては、消した意味がない。
      dropped: new Set(),
    },

    // 無線を聞いたら書記が地図に写す（＝自動記入）。
    // 切れば全て手書きに戻る ─ 何を写すかを自分で選ぶのも指揮である。
    autoPlot: opts.autoPlot !== false,

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

    // 戦役で回している時だけ入る。単発の戦闘では null。
    campaign: null,
    stage: null,
  };

  // 盤を起こした時点で記録簿にあるもの（夜間偵察の報告）も、指揮官は聞いている。
  game._logSeen = 0;
  drainLog(game);
  return game;
}

/* ------------------------------------------------------------------ */
/* 進行                                                                */
/* ------------------------------------------------------------------ */

/**
 * dt 実秒ぶんシミュレーションを進める。
 * @returns {Array} 新たに届いた無線ログ
 */
/**
 * 通信記録簿のうち、まだ指揮官が取り込んでいないぶんを取り込む。
 *
 * 無線で届いたものも、指揮所が自分で書いた覚書も、記録簿には同じ順で載る。
 * 取り込みをここ一本にしておかないと、「弾が無い」のような一行が
 * どこにも出ないまま消える ─ 実際、長いあいだ消えていた。
 */
function drainLog(game) {
  const log = game.world.radio.log;
  const from = game._logSeen ?? 0;
  if (log.length <= from) return [];
  game._logSeen = log.length;
  const fresh = log.slice(from);
  for (const entry of fresh) absorb(game, entry);
  return fresh;
}

export { drainLog };

export function advance(game, realDt) {
  // H時前。時計は止まっているが、口頭で渡した命令は動いている。
  if (game.world.planning) {
    planningTick(game.world);
    return drainLog(game);
  }
  if (!game.running || game.finished) return [];

  const simSeconds = realDt * game.simSecondsPerRealSecond * game.speed;
  game._carry = (game._carry ?? 0) + simSeconds;

  const fresh = [];
  let steps = Math.floor(game._carry);
  game._carry -= steps;
  // 1フレームで進めすぎない（タブ復帰直後の巨大な dt 対策）
  steps = Math.min(steps, 400);

  for (let i = 0; i < steps; i++) {
    tick(game.world, 1);
    if (game.world.outcome) break;
  }

  fresh.push(...drainLog(game));

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
  if (!entry.fromId || !self || entry.lost) {
    autoPlot(game, entry);
    return;
  }

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

  autoPlot(game, entry);
}

/* ------------------------------------------------------------------ */
/* 自動記入                                                            */
/* ------------------------------------------------------------------ */
//
// 本来これは指揮官の仕事ではなく、指揮所の書記の仕事である。
// 無線を聞き、聞こえたとおりに駒を置き、動いたと言われれば動かす。
// 指揮官はその盤を見て考える ― 駒を置くために地図を叩き続けたりはしない。
//
// 大事なのは、写されるのが「報告された位置」だという一点。
// 書記が几帳面でも、前線が見誤っていれば盤は間違ったままである。

/** 同じ敵を指していると見なす距離。これより離れていれば別の駒を立てる。 */
const SAME_TRACK = 620;
/** 誰も何も言わなくなった敵の駒を、盤から下ろすまでの時間 */
const TRACK_LIFE = 1500;

/** H時。計画を畳んで時計を回し始める。 */
export function startClock(game) {
  const ok = endPlanning(game.world);
  if (ok) {
    game.running = true;
    game.speed = 1;
  }
  return ok;
}

export function isPlanning(game) {
  return !!game?.world?.planning;
}

export function setAutoPlot(game, on) {
  game.autoPlot = !!on;
  return game.autoPlot;
}

export function isAutoPlot(game) {
  return !!game.autoPlot;
}

/** 自軍の駒に添える一言。今この部隊がどうなっているか。 */
function selfNote(entry, self) {
  if (entry.kind === 'broken') return '統制喪失';
  // 敵情ではなく自分のことを言ってきた「contact」＝ 撃たれているという報告
  if (entry.kind === 'contact' && !entry.meta?.classified) return '被射撃';
  if (entry.kind === 'logistics') return '補給';
  return self.state ?? null;
}

function autoPlot(game, entry) {
  if (!game.autoPlot) return;
  // 聞こえなかったものは書けない。届かなかった送信は盤に何も残さない。
  if (entry.lost || entry.outbound) return;

  const meta = entry.meta ?? {};

  if (meta.reportedX != null && meta.classified) plotContact(game, entry);
  if (entry.kind === 'kill' && meta.grid) strikeOff(game, meta.grid);

  if (meta.self?.grid && entry.fromId) {
    const m = markUnit(game, entry.fromId, { record: false, auto: true });
    if (m) m.note = selfNote(entry, meta.self);
  }

  cullTracks(game);
}

/**
 * 敵情報告を盤に写す。既にその敵の駒が立っていれば、動かす。
 *
 * 手で押した場合（manual）は指揮官の意思なので、一度下ろした駒でも立て直す。
 * @returns {object|null} 置いた／動かした記号
 */
export function plotContact(game, entry, { manual = false } = {}) {
  const meta = entry?.meta ?? {};
  if (meta.reportedX == null || entry.lost) return null;

  // 誰が何を報せてきたかで一本の航跡にする。
  // 砲声の交会のように方眼が毎回ずれるものを、方眼で束ねてはいけない ―
  // 束ねられずに駒だけが増えていく。近ければ同じもの、遠ければ別もの、で足りる。
  const src = meta.contactId
    ? `c:${meta.contactId}`
    : `x:${meta.classified}:${entry.fromId ?? '?'}`;
  if (manual) game.belief.dropped.delete(src);
  else if (game.belief.dropped.has(src)) return null;

  const type = CLASSIFIED_TO_MARKER[meta.classified] ?? 'unknown';
  // 雑音で潰れた送信は、そのぶん確かさが落ちる。
  // 「聞き取れなかったのに盤の上だけは正確」ということがあってはならない。
  const q = (meta.quality ?? 0.4) * (entry.garbled ? 0.6 : 1);
  const confidence = q > 0.75 ? 'confirmed' : q > 0.45 ? 'estimated' : 'unconfirmed';

  // 同じ出所の駒のうち、報告位置にいちばん近いものを動かす。
  // 遠く離れていれば別物 ― 指揮官にはそれが同じ敵かどうか分からない。
  let best = null;
  let bestD = SAME_TRACK;
  for (const m of game.belief.markers) {
    if (m.src !== src) continue;
    const d = Math.hypot(m.x - meta.reportedX, m.y - meta.reportedY);
    if (d < bestD) { best = m; bestD = d; }
  }

  if (best) {
    if (manual) snapshot(game);
    best.x = meta.reportedX;
    best.y = meta.reportedY;
    best.type = type;
    best.confidence = confidence;
    if (!best.labelLocked) best.note = entry.from;
    best.updatedAt = game.world.now;
    return best;
  }

  return addMarker(game, {
    x: meta.reportedX,
    y: meta.reportedY,
    type,
    confidence,
    note: entry.from,
    src,
    auto: !manual,
    record: manual,
  });
}

/**
 * 敵の航跡かどうか。
 * 自軍の駒（unitId 持ち）と障害は動かないし、消えもしない ─ 下ろす対象ではない。
 */
function isTrack(m) {
  return !!m.auto && !m.unitId && m.type !== 'obstacle';
}

/** 撃破の報告。そこに立っていた敵の駒を下ろす。 */
function strikeOff(game, grid) {
  const p = fromGrid(grid);
  if (!p) return;
  game.belief.markers = game.belief.markers.filter(
    (m) => !(isTrack(m) && Math.hypot(m.x - p.x, m.y - p.y) < 260)
  );
}

/** 誰も言わなくなって久しい敵の駒は、盤から下ろす（古い駒で判断させない）。 */
function cullTracks(game) {
  const now = game.world.now;
  game.belief.markers = game.belief.markers.filter(
    (m) => !(isTrack(m) && now - m.updatedAt > TRACK_LIFE)
  );
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
  // 発令そのものが記録簿に一行を残すことがある（弾が無い・射程外・作戦命令の下達）。
  drainLog(game);
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
  // 消したのを取り消したのなら、その駒はまた書記の担当に戻る。
  for (const m of prev.markers) if (m.src) game.belief.dropped.delete(m.src);
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
    note = null, src = null, auto = false, record = true,
  }
) {
  // 書記が写した駒で取り消し履歴を埋めない。
  // 「取消」は指揮官が自分で書いたものを消すための釦である。
  if (record) snapshot(game);
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
    // 添え書き（誰の報告か、今どうしているか）と、その駒の出所。
    note,
    src,
    auto,
    labelLocked: false,
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
export function markUnit(game, unitId, { record = true, auto = false } = {}) {
  const src = `u:${unitId}`;
  // 指揮官が自分の指で置き直したなら、それは「もう一度載せろ」という意思表示。
  if (record) game.belief.dropped.delete(src);
  else if (game.belief.dropped.has(src)) return null;

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
    if (record) snapshot(game);
    existing.x = p.x;
    existing.y = p.y;
    existing.confidence = confidence;
    // 指揮官が付け直した名前は、書記が上書きしてよいものではない。
    if (!existing.labelLocked) existing.label = heard.callsign;
    existing.src ??= src;
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
    src,
    auto,
    record,
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
  // 名前を書き入れたら、その駒はもう指揮官のものである。以後は上書きしない。
  if (patch.label !== undefined) m.labelLocked = true;
  m.updatedAt = game.world.now;
}

export function removeMarker(game, id) {
  const m = game.belief.markers.find((x) => x.id === id);
  if (!m) return;
  snapshot(game);
  // 指揮官が下ろした駒は、次の報告でまた立ち上がってきてはいけない。
  if (m.src) game.belief.dropped.add(m.src);
  game.belief.markers = game.belief.markers.filter((x) => x.id !== id);
}

/** 全部消す */
export function clearMarkings(game) {
  if (!game.belief.markers.length && !game.belief.sketches.length) return;
  snapshot(game);
  // 盤を拭ったのだから、書記も最初からやり直す。
  game.belief.dropped.clear();
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
    // 誰が率いていて、何を付けたか。これは前線の話ではなく編成の話なので、
    // 指揮官は最初から知っている ─ 自分で決めたことである。
    const u = game.world.unitsById.get(def.id);
    out.push({
      unitId: def.id,
      callsign: def.callsign,
      typeLabel: def.typeLabel,
      role: def.role,
      officer: u?.officer ? `${u.officer.name} ${u.officer.rank}` : null,
      temperament: u?.officer ? TEMPERAMENTS[u.officer.temperament]?.label ?? '' : null,
      attach: attachmentShort(u?.attach),
      attachLabels: attachmentLabels(u?.attach).join('・'),
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
      // 誰が率いていたか。戦役では、これが翌日の編成の話になる。
      officer: u.officer ? `${u.officer.name} ${u.officer.rank}` : null,
      attach: attachmentLabels(u.attach).join('・') || null,
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

/* ================================================================== */
/* 戦役                                                               */
/* ================================================================== */
//
// 戦闘そのものは今までどおり createGame が回す。
// ここは「戦闘と戦闘のあいだ」を持ち、次の戦闘へ持ち越しを渡す係である。
//
// 戦役の帳簿は指揮所の帳簿なので、指揮官は全部見てよい ―
// 誰が何人残っているかは、点呼を取れば分かることである。
// 見えないのは今この瞬間の前線の様子だけであり、そこは今までどおり belief を通す。

const CAMPAIGN_KEY = 'brzer.campaign';

export function newCampaign(campaignId = CAMPAIGNS[0].id, seed = null) {
  const campaign = getCampaign(campaignId);
  const used = (seed ?? Math.floor(Math.random() * 0x7fffffff)) | 1;
  const rng = new Rng(used);
  const first = getMissionRoster(campaign.stages[0].missionId);
  // 途中の日から出てくる部隊にも、最初から名前を配っておく。
  // 三日目に初めて現れる分隊が「H4」と呼ばれていては、中隊の話にならない。
  const everyone = new Map();
  for (const stage of campaign.stages) {
    for (const r of getMissionRoster(stage.missionId)) if (!everyone.has(r.id)) everyone.set(r.id, r);
  }
  const state = createCampaign(campaign, rng, [...everyone.values()]);

  // 初日の編成を「昨日の終わり」として置いておく。
  // これが無いと、補充を割り当てる先が一つも無い状態で第一日が始まる。
  for (const r of first) {
    state.carry[r.id] = {
      strength: r.maxStrength, maxStrength: r.maxStrength,
      ammoRatio: 1, morale: 82, fatigue: 0, walkingWounded: 0, dead: false,
    };
  }
  state.seed = used;
  return state;
}

/** そのミッションの編成表を、将校を配るのに使える形で返す */
function getMissionRoster(missionId) {
  const mission = simGetMission(missionId);
  const orbat = friendlyOrderOfBattle(mission);
  const byId = new Map(orbat.map((d) => [d.id, d]));
  return (mission.rosterOrder ?? []).map((r) => {
    const def = byId.get(r.id);
    const tpl = def ? UNIT_TYPES[def.type] : null;
    return {
      id: r.id,
      callsign: r.callsign,
      role: r.role,
      icon: r.icon,
      echelon: r.echelon,
      unitType: def?.type ?? 'infantry',
      typeLabel: r.typeLabel,
      maxStrength: tpl?.maxStrength ?? 9,
      virtual: !!r.virtual,
    };
  });
}

export { getMissionRoster, campaignList };

/** 戦役の次の一戦を起こす。createGame の戦役版。 */
export function startCampaignBattle(campaignState, opts = {}) {
  const campaign = getCampaign(campaignState.campaignId);
  const stage = currentStage(campaignState, campaign);
  if (!stage) return null;

  // 出撃の直前に、その晩の政令を実施する。
  // 出したものは翌日ではなく、今日の戦闘から効く。
  settleNight(campaignState);
  const setup = battleSetup(campaignState);
  const game = createGame({
    missionId: stage.missionId,
    variable: true, // 戦役の敵は毎回同じ手は使わない
    autoPlot: opts.autoPlot,
    setup,
  });
  game.campaign = campaignState;
  game.stage = stage;
  return game;
}

/** 戦闘の結果を戦役に取り込む。講評を出したあとに呼ぶ。 */
export function finishCampaignBattle(game) {
  if (!game?.campaign || !game.world.outcome) return null;
  if (game._campaignRecorded) return game._campaignRecorded;
  const rng = new Rng((game.world.tickCount + 977) | 1);
  const report = battleReport(game.world);
  const res = recordBattle(game.campaign, report, rng);
  game._campaignRecorded = res;
  saveCampaign(game.campaign);
  return res;
}

/* --- 保存 ---------------------------------------------------------- */

export function saveCampaign(state) {
  try {
    window.localStorage.setItem(CAMPAIGN_KEY, JSON.stringify(serializeCampaign(state)));
    return true;
  } catch {
    return false; // 保存できなくても戦役そのものは続けられる
  }
}

export function loadCampaign() {
  try {
    const raw = window.localStorage.getItem(CAMPAIGN_KEY);
    if (!raw) return null;
    return deserializeCampaign(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearCampaign() {
  try {
    window.localStorage.removeItem(CAMPAIGN_KEY);
  } catch {
    /* 消せなくても実害は無い */
  }
}

/* --- UI 向けの読み出し --------------------------------------------- */

/** 戦役の全体像。戦線・段階・これまでの経過。 */
export function getCampaignView(state) {
  if (!state) return null;
  const campaign = getCampaign(state.campaignId);
  const stage = currentStage(state, campaign);
  return {
    id: campaign.id,
    title: campaign.title,
    subtitle: campaign.subtitle,
    blurb: campaign.blurb,
    front: state.front,
    frontMax: campaign.front.max,
    frontLabel: campaign.front.label,
    stageIndex: state.stage,
    stageCount: campaign.stages.length,
    stage: stage && {
      id: stage.id, day: stage.day, title: stage.title,
      prologue: stage.prologue, missionId: stage.missionId,
    },
    finished: !!state.finished,
    result: state.result,
    resultReason: state.resultReason,
    collapse: state.collapse ?? null,
    // 国政の要点。戦役の画面にも出す ─ 前線と国は別の話ではない。
    nation: state.nation && {
      morale: Math.round(state.nation.morale),
      control: Math.round(state.nation.control),
      loyalty: Math.round(state.nation.loyalty),
      treasury: Math.round(state.nation.treasury),
      fear: state.nation.fear,
      decrees: state.nation.decrees.length,
      limit: DECREE_LIMIT,
    },
    history: state.history.map((h) => ({ ...h })),
    pool: { ...state.pool },
    left: poolLeft(state),
    allot: { ...state.allot },
    night: state.night,
    nights: NIGHT_PLAN_IDS.map((id) => ({ ...NIGHT_PLANS[id] })),
  };
}

/** 中隊の顔ぶれ。名前・気質・特性・残兵。 */
export function getCompany(state) {
  if (!state) return [];
  const campaign = getCampaign(state.campaignId);
  const stage = currentStage(state, campaign);
  const roster = getMissionRoster(stage?.missionId ?? campaign.stages[0].missionId);
  const rosterIds = new Set(roster.map((r) => r.id));

  const rows = [];
  for (const r of roster) {
    const c = state.carry[r.id];
    const officer = state.officers.get(r.id);
    rows.push({
      id: r.id,
      callsign: r.callsign,
      typeLabel: r.typeLabel,
      unitType: r.unitType,
      icon: r.icon,
      echelon: r.echelon,
      role: r.role,
      present: true,
      strength: c ? Math.round(c.strength) : r.maxStrength,
      maxStrength: c?.maxStrength ?? r.maxStrength,
      wounded: Math.round(c?.walkingWounded ?? 0),
      ammoRatio: c?.ammoRatio ?? 1,
      morale: c?.morale ?? 82,
      fatigue: c?.fatigue ?? 0,
      dead: !!c?.dead,
      room: replacementRoom(state, r.id),
      assigned: state.assign[r.id] ?? 0,
      officer: officer && {
        name: officer.name, rank: officer.rank,
        temperament: officer.temperament,
        temperamentLabel: TEMPERAMENTS[officer.temperament]?.label ?? '',
        temperamentNote: TEMPERAMENTS[officer.temperament]?.note ?? '',
        traits: officer.traits.map((id) => ({ ...TRAITS[id] })).filter((t) => t.label),
        grade: gradeOf(officer).label,
        battles: officer.battles, kills: officer.kills,
        line: officerLine(officer),
      },
    });
  }

  // 今日は出番の無い部隊も、中隊の一部である。
  for (const [id, c] of Object.entries(state.carry)) {
    if (rosterIds.has(id)) continue;
    const officer = state.officers.get(id);
    rows.push({
      id,
      callsign: officer?.callsign ?? id,
      typeLabel: '', unitType: 'infantry', icon: null, echelon: null, role: '本日は編成外',
      present: false,
      strength: Math.round(c.strength), maxStrength: c.maxStrength ?? 9,
      wounded: Math.round(c.walkingWounded ?? 0),
      ammoRatio: c.ammoRatio ?? 1, morale: c.morale ?? 82, fatigue: c.fatigue ?? 0,
      dead: !!c.dead, room: replacementRoom(state, id), assigned: state.assign[id] ?? 0,
      officer: officer && {
        name: officer.name, rank: officer.rank,
        temperament: officer.temperament,
        temperamentLabel: TEMPERAMENTS[officer.temperament]?.label ?? '',
        temperamentNote: TEMPERAMENTS[officer.temperament]?.note ?? '',
        traits: officer.traits.map((tid) => ({ ...TRAITS[tid] })).filter((t) => t.label),
        grade: gradeOf(officer).label,
        battles: officer.battles, kills: officer.kills,
        line: officerLine(officer),
      },
    });
  }
  return rows;
}

/* --- 戦闘前の割り当て ---------------------------------------------- */

export function assignReplacement(state, unitId, n) {
  const room = replacementRoom(state, unitId);
  const others = assignedTotal(state) - (state.assign[unitId] ?? 0);
  const max = Math.min(room, state.pool.replacements - others);
  state.assign[unitId] = Math.max(0, Math.min(max, Math.round(n)));
  return state.assign[unitId];
}

export function allotRounds(state, kind, n) {
  if (!['rounds', 'smoke', 'illum'].includes(kind)) return 0;
  const others = allottedTotal(state) - state.allot[kind];
  const max = Math.max(0, state.pool.rounds - others);
  state.allot[kind] = Math.max(0, Math.min(max, Math.round(n)));
  return state.allot[kind];
}

export function attachTo(state, unitId, attachId, unitType) {
  return attachAsset(state, unitId, attachId, unitType);
}

export function detachFrom(state, unitId, attachId) {
  return detachAsset(state, unitId, attachId);
}

export function getAttachState(state) {
  return {
    attachments: ATTACHMENTS,
    assets: { ...state.assets },
    assetsLeft: assetsLeft(state),
    attachOf: (unitId) => state.attach[unitId] ?? [],
    canAttach: (unitId, attachId, unitType) => canAttach(state, unitId, attachId, unitType),
  };
}

export function setNightPlan(state, id) {
  if (NIGHT_PLANS[id]) state.night = id;
  return state.night;
}

/** 戦役中の将校（戦闘中の画面から名前を出すのに使う） */
export function getOfficerOf(game, unitId) {
  const o = game?.world?.unitsById?.get(unitId)?.officer;
  if (!o) return null;
  return {
    name: o.name, rank: o.rank, line: officerLine(o),
    temperamentLabel: TEMPERAMENTS[o.temperament]?.label ?? '',
    traits: o.traits.map((id) => TRAITS[id]?.label).filter(Boolean),
  };
}

/* ================================================================== */
/* 国政                                                               */
/* ================================================================== */
//
// 前線は見えない。だが自分の国のことは分かる ─
// 国庫に幾ら残っているかも、どの町が焼けたかも、指揮所の机の上にある。
// 見えないのは、その決定が前線で何を起こすかだけである。

export function getNationView(state) {
  const n = state?.nation;
  if (!n) return null;
  const left = DECREE_LIMIT - n.decrees.length;

  return {
    name: NATION.name,
    eyebrow: NATION.eyebrow,
    blurb: NATION.blurb,
    meters: Object.values(METERS).map((m) => ({
      id: m.id, label: m.label, note: m.note, value: Math.round(n[m.id]),
    })),
    treasury: Math.round(n.treasury),
    fear: n.fear,
    fearJa: fearJa(n.fear),
    output: { ...n.output },
    decrees: n.decrees.map((id) => ({ id, ...DECREES[id] })),
    standing: n.standing.map((id) => ({ id, ...DECREES[id] })),
    left,
    limit: DECREE_LIMIT,
    groups: Object.values(DECREE_GROUPS).map((g) => ({
      ...g,
      items: DECREE_IDS.filter((id) => DECREES[id].group === g.id).map((id) => {
        const d = DECREES[id];
        const chk = canDecree(n, id);
        return {
          id: d.id, label: d.label, note: d.note, cost: d.cost,
          effect: { ...(d.effect ?? {}) },
          yields: { ...(d.yields ?? {}) },
          fear: d.fear ?? 0,
          keep: !!d.keep,
          picked: n.decrees.includes(id),
          active: n.standing.includes(id),
          can: chk.ok,
          why: chk.why,
        };
      }),
    })),
    purged: n.purged.map((p) => ({ ...p })),
    decorated: n.decorated.map((p) => ({ ...p })),
    rule: ruleSummary(n),
  };
}

/** 恐怖の言語化。数値は出さない ─ 指導者は自分の国の恐怖を数字で知らない。 */
function fearJa(f) {
  if (f < 0.12) return '町は普通に喋っている';
  if (f < 0.3) return '人前では政府の話をしない';
  if (f < 0.5) return '隣人を疑う者が出てきた';
  if (f < 0.72) return '誰も本当のことを言わない';
  return '誰も口を開かない';
}

/** 士官団。粛清と叙勲の対象を選ぶための一覧。 */
export function getOfficerCorps(state) {
  if (!state) return [];
  const wavering = new Set(waveringUnits(state));
  const rows = [];
  for (const [unitId, o] of state.officers) {
    rows.push({
      unitId,
      callsign: o.callsign ?? unitId,
      name: o.name,
      rank: o.rank,
      temperament: o.temperament,
      temperamentLabel: TEMPERAMENTS[o.temperament]?.label ?? '',
      traits: o.traits.map((id) => TRAITS[id]?.label).filter(Boolean),
      grade: gradeOf(o).label,
      battles: o.battles,
      kills: o.kills,
      loyalty: Math.round(o.loyalty ?? 68),
      loyaltyJa: loyaltyJa(o.loyalty ?? 68),
      wavering: wavering.has(unitId),
      cost: state.nation ? purgeCost(state.nation, o) : null,
    });
  }
  return rows;
}

function loyaltyJa(l) {
  if (l >= 80) return '心服';
  if (l >= 62) return '従順';
  if (l >= 44) return '面従';
  if (l >= 28) return '不満';
  return '離反寸前';
}

export function pickDecree(state, id) {
  return decree(state.nation, id);
}

export function unpickDecree(state, id) {
  return revokeDecree(state.nation, id);
}

export function stopStanding(state, id) {
  return liftStanding(state.nation, id);
}

/**
 * 粛清。取り返しはつかない ─ 呼ぶ前に、UI で一度確かめること。
 */
export function purgeIn(state, unitId) {
  const rng = new Rng(((state.nation.purged.length + 1) * 7919 + (state.stage + 1) * 104729) | 1);
  const res = purgeOfficer(state, unitId, rng);
  return res;
}

export function decorateIn(state, unitId) {
  return decorateOfficer(state, unitId);
}
