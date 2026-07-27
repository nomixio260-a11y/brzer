// 戦役 ─ 継戦。
//
// 一日の戦闘が終わっても、戦争は終わらない。
// 昨日死んだ者は今日いない。昨日撃った弾は今日は無い。
// 昨日よく戦った分隊は、今日はもっとよく戦う。
//
// このファイルが持つのは「戦闘と戦闘のあいだ」だけである。
// 戦闘そのものは今までどおり world.js が回す。ここはその前後を繋ぐ。
//
// DOM に触れない。localStorage にも触れない（保存は state.js の仕事）。

import { clamp } from '../util.js';
import {
  rollOfficers, debriefOfficer, replaceOfficer,
  serializeOfficer, deserializeOfficer, officerFactors,
} from './officers.js';
import { ATTACHMENTS, SLOTS_PER_UNIT, fits } from './attachments.js';
import {
  createNation, applyDecrees, absorbBattle, warFactors, checkCollapse,
  serializeNation, deserializeNation, purge, decorate, purgeCost,
} from './nation.js';
import { driftLoyalty, isWavering } from './officers.js';

/* ------------------------------------------------------------------ */
/* 戦役の定義                                                           */
/* ------------------------------------------------------------------ */

export const CAMPAIGNS = Object.freeze([
  Object.freeze({
    id: 'volne_three_days',
    title: 'ヴォルネ三日間',
    subtitle: '第3中隊戦闘団 ─ 連続作戦',
    blurb:
      '三日にわたる連続した戦闘。峠で時間を稼ぎ、橋で敵を止め、奪われた町を取り返す。' +
      '部隊は一つしかない ─ 昨日失った者は、今日は誰も埋めてくれない。',
    // 戦線の目盛り。0 まで押し込まれたら、その時点で戦役は終わる。
    front: { start: 50, min: 0, max: 100, label: '戦線' },
    stages: Object.freeze([
      Object.freeze({
        id: 'day1',
        missionId: 'kolp_delay',
        day: '第一日',
        title: 'コルプ峠の遅滞',
        prologue:
          '敵一個大隊が峠を南下しつつある。本隊の陣地は未完成であり、' +
          'この日に稼いだ時間が、そのまま明日の陣地の深さになる。',
        epilogue: {
          victory: '峠で一日を稼いだ。本隊は川岸に陣地を掘り終えた。',
          narrow: '南口は抜かれかけたが、日没まで持った。陣地は半分しか掘れていない。',
          defeat: '峠を早々に抜かれた。本隊は掘りかけの穴で敵を迎えることになる。',
        },
      }),
      Object.freeze({
        id: 'day2',
        missionId: 'bridge_hold',
        day: '第二日',
        title: 'ヴォルネ川の橋梁死守',
        prologue:
          '峠を抜けた敵は、そのまま川へ出てきた。橋は落とせない ─ ' +
          '味方の反撃部隊が、その橋を使って渡ることになっている。',
        epilogue: {
          victory: '橋は落ちなかった。反撃部隊が渡れる。',
          narrow: '橋は保ったが、中隊は半分になった。',
          defeat: '橋を奪われた。対岸の敵は、もう止まらない。',
        },
      }),
      Object.freeze({
        id: 'day3',
        missionId: 'zaren_counter',
        day: '第三日',
        title: 'ザーレン奪回',
        prologue:
          '昨夜のうちに敵の一隊がザーレンに入った。町を握られたままでは、' +
          '橋を守り切った意味がない。取り返す。',
        epilogue: {
          victory: '町は戻った。三日間の戦闘は、こちらの勝ちで終わった。',
          narrow: '町は取り返したが、取り返した部隊はもう戦えない。',
          defeat: '町は敵の手に残った。三日間は無駄だった。',
        },
      }),
    ]),
  }),
]);

export function campaignList() {
  return CAMPAIGNS;
}

export function getCampaign(id) {
  return CAMPAIGNS.find((c) => c.id === id) ?? CAMPAIGNS[0];
}

/* ------------------------------------------------------------------ */
/* 戦線の動き                                                           */
/* ------------------------------------------------------------------ */

const FRONT_SHIFT = Object.freeze({ victory: 14, narrow: 4, defeat: -18 });

/** 一戦の稼ぎ。勝てば人と弾が回ってくる ─ 負ければ回ってこない。 */
const YIELD = Object.freeze({
  victory: { replacements: 9, rounds: 6, smoke: 3, illum: 2 },
  narrow: { replacements: 6, rounds: 4, smoke: 2, illum: 1 },
  defeat: { replacements: 4, rounds: 2, smoke: 1, illum: 1 },
});

/* ------------------------------------------------------------------ */
/* 夜の使い方                                                           */
/* ------------------------------------------------------------------ */
//
// 一晩に一つしか選べない。休むか、掘るか、見に行くか。
// 三つとも欲しいのが常であり、三つとも取れないのが戦争である。

export const NIGHT_PLANS = Object.freeze({
  rest: {
    id: 'rest', label: '休養',
    note: '一晩眠らせる。疲れはほぼ抜け、士気も戻る。だが陣地は掘れていない。',
    // 疲労は割合で抜く。前日の数字をそのまま引きずらせると、
    // 二日目の中隊は最初から動けない部隊になってしまう。
    fatigueKeep: 0.12, morale: +10, fortify: false, recon: false,
  },
  fortify: {
    id: 'fortify', label: '陣地構築',
    note: '夜通し掘る。防御につく部隊は構築陣地から始まる。そのぶん眠れていない。',
    fatigueKeep: 0.45, morale: +3, fortify: true, recon: false,
  },
  recon: {
    id: 'recon', label: '夜間偵察',
    note: '斥候を出す。夜明けに敵の集結が分かる。半分の者は寝ていない。',
    fatigueKeep: 0.34, morale: 0, fortify: false, recon: true,
  },
});

export const NIGHT_PLAN_IDS = Object.freeze(Object.keys(NIGHT_PLANS));

/* ------------------------------------------------------------------ */
/* 戦役の状態                                                           */
/* ------------------------------------------------------------------ */

/**
 * 新しい戦役を起こす。
 * @param {object} campaign CAMPAIGNS の一つ
 * @param {object} rng      util.js の Rng（名簿を配るのに使う）
 * @param {Array}  roster   [{id, callsign, unitType, virtual}] 第一戦の編成表
 */
export function createCampaign(campaign, rng, roster) {
  return {
    campaignId: campaign.id,
    stage: 0,
    front: campaign.front.start,
    finished: false,
    result: null,
    resultReason: null,

    // 次の戦闘へ持ち込む手持ち
    pool: { replacements: 6, rounds: 4, smoke: 2, illum: 2 },
    // 大隊から借りている分派。数は限られている ─ どこに付けるかが企図になる。
    assets: { mg: 1, at: 0, eng: 1, fo: 1, medic: 0, relay: 0 },
    // unitId -> 付けた分派
    attach: {},
    // 補充の割り当て（unitId -> 人数）。戦闘に入る時に消費する。
    assign: {},
    // 弾薬の割り当て
    allot: { rounds: 0, smoke: 0, illum: 0 },
    night: 'rest',

    // unitId -> 前の戦闘の終わり方
    carry: {},
    officers: rollOfficers(rng, roster),

    // どの手番まで夜が明けたか。二度決算しないための札。
    settledStage: -1,

    // 一戦ごとの記録
    history: [],

    // 国。戦役の上に載る層 ─ 弾も兵も、ここから出てくる。
    nation: createNation(),
  };
}

export function currentStage(state, campaign = getCampaign(state.campaignId)) {
  return campaign.stages[state.stage] ?? null;
}

export function stagesLeft(state, campaign = getCampaign(state.campaignId)) {
  return Math.max(0, campaign.stages.length - state.stage);
}

/* ------------------------------------------------------------------ */
/* 戦闘へ持ち込む                                                       */
/* ------------------------------------------------------------------ */

/**
 * 次の戦闘の初期値を作る。createWorld に渡す。
 *
 * ここで返すのは「その部隊が今どうなっているか」だけであり、
 * どこに配置するかは相変わらずミッション側が決める ─
 * 昨日の位置に今日も居るとは限らない。
 */
export function battleSetup(state) {
  const night = NIGHT_PLANS[state.night] ?? NIGHT_PLANS.rest;
  const units = {};

  for (const [unitId, c] of Object.entries(state.carry)) {
    const officer = state.officers.get(unitId);
    const f = officerFactors(officer);

    // 夜のあいだに戻ってくる者。面倒見のよい下士官ほど多く連れて帰る。
    const returned = Math.min(c.walkingWounded ?? 0, (c.walkingWounded ?? 0) * 0.55 * f.care);
    const filled = state.assign[unitId] ?? 0;
    const max = c.maxStrength ?? 9;

    units[unitId] = {
      strength: Math.min(max, c.strength + returned + filled),
      // 一晩あれば弾は届く。ただし全部は届かない ─ 段列にも限りがある。
      ammoRatio: clamp((c.ammoRatio ?? 1) + 0.45, 0, 1),
      morale: clamp((c.morale ?? 80) + night.morale + (filled > 0 ? 4 : 0), 25, 96),
      fatigue: Math.max(0, (c.fatigue ?? 0) * night.fatigueKeep),
      // 補充で薄まる。新兵は昨日の戦訓を持っていない。
      // どこから来た新兵かも効く（志願か、名簿か、総動員か）。
      // 除かれた将校の穴も、ここに出る ─ 経歴は腕である。
      skillBias:
        (filled > 0 ? -0.02 * Math.min(3, filled) + (state.recruitQuality ?? 0) : 0) +
        (state.purgedUnits?.[unitId] ? -0.06 : 0),
      dead: !!c.dead,
      attach: [...(state.attach[unitId] ?? [])],
    };
  }

  return {
    units,
    fortify: night.fortify,
    recon: night.recon,
    support: { ...state.allot },
    officers: state.officers,
    attach: { ...state.attach },
    // 国の状態を戦場の係数に翻訳したもの。単発の戦闘には付かない。
    war: state.nation ? warFactors(state.nation) : null,
  };
}

/* ------------------------------------------------------------------ */
/* 戦闘のあと                                                           */
/* ------------------------------------------------------------------ */

/**
 * 一戦の結果を戦役に取り込む。
 *
 * @param {object} state
 * @param {object} report {outcome, units: [{id, alive, strength, maxStrength,
 *   ammoRatio, morale, fatigue, walkingWounded, inflicted, losses,
 *   selfWithdrew, heldUnderFire, refusedOrders, transmissions, avgResponse}], score}
 * @param {object} rng
 */
export function recordBattle(state, report, rng, campaign = getCampaign(state.campaignId)) {
  const stage = currentStage(state, campaign);
  const outcome = report.outcome === 'victory' ? 'victory'
    : report.outcome === 'narrow' ? 'narrow' : 'defeat';

  const gained = [];
  const carry = {};

  for (const u of report.units) {
    const officer = state.officers.get(u.id);
    if (officer) {
      const got = debriefOfficer(officer, {
        survived: u.alive,
        strengthRatio: u.maxStrength ? u.strength / u.maxStrength : 0,
        lossRatio: u.maxStrength ? u.losses / u.maxStrength : 0,
        inflicted: u.inflicted,
        losses: u.losses,
        selfWithdrew: u.selfWithdrew,
        heldUnderFire: u.heldUnderFire,
        refusedOrders: u.refusedOrders,
        transmissions: u.transmissions,
        avgResponse: u.avgResponse,
        woundedRecovered: u.walkingWounded,
      });
      for (const t of got) gained.push({ unitId: u.id, officer, trait: t });

      // 部隊が消えれば、率いていた者も帰ってこない。
      if (!u.alive) {
        officer.fallen = true;
        const taken = new Set([...state.officers.values()].map((o) => o.name));
        state.officers.set(u.id, replaceOfficer(officer, rng, taken));
      }
    }

    // 半分になった分隊は、一晩眠っても半分のままである。
    // 士気は人数に付いてくる ─ 欠けた列を見れば、休んだかどうかは関係ない。
    const ratio = u.maxStrength ? u.strength / u.maxStrength : 0;
    carry[u.id] = {
      strength: u.alive ? u.strength : 0,
      maxStrength: u.maxStrength,
      ammoRatio: u.ammoRatio,
      morale: u.alive ? Math.min(u.morale, 52 + 46 * ratio) : 40,
      fatigue: u.fatigue,
      walkingWounded: u.alive ? u.walkingWounded : 0,
      dead: !u.alive,
    };
  }

  // 出番の無かった部隊も、休んで補充を受けている。
  for (const [id, prev] of Object.entries(state.carry)) {
    if (carry[id]) continue;
    carry[id] = { ...prev, fatigue: Math.max(0, (prev.fatigue ?? 0) - 60) };
  }

  state.carry = carry;
  state.front = clamp(state.front + FRONT_SHIFT[outcome], campaign.front.min, campaign.front.max);

  // --- 国が受け取るもの -------------------------------------------
  let collapse = null;
  if (state.nation) {
    absorbBattle(state.nation, outcome, report.score);
    // 士官団の一人ひとりが、国全体の空気に引かれて動く。
    for (const o of state.officers.values()) {
      driftLoyalty(o, state.nation.loyalty, { won: outcome === 'victory' });
    }
    collapse = checkCollapse(state.nation);
  }

  const y = YIELD[outcome];
  state.pool = {
    replacements: state.pool.replacements + y.replacements,
    rounds: state.pool.rounds + y.rounds,
    smoke: state.pool.smoke + y.smoke,
    illum: state.pool.illum + y.illum,
  };
  state.assign = {};
  state.allot = { rounds: 0, smoke: 0, illum: 0 };
  // 分派は大隊のものである。戦闘が終われば一度引き上げ、翌朝また配り直す。
  state.attach = {};
  // 勝った日には、大隊が一つ余計に回してくれる。
  if (outcome === 'victory') {
    const want = ASSET_REWARD[state.history.length % ASSET_REWARD.length];
    state.assets[want] = (state.assets[want] ?? 0) + 1;
  }

  state.history.push({
    stageId: stage?.id ?? `s${state.stage}`,
    title: stage?.title ?? '',
    day: stage?.day ?? '',
    outcome,
    front: state.front,
    losses: report.score?.losses ?? 0,
    enemyLosses: report.score?.enemyLosses ?? 0,
    epilogue: stage?.epilogue?.[outcome] ?? '',
    traits: gained.map((g) => ({
      unitId: g.unitId, name: g.officer.name, rank: g.officer.rank, label: g.trait.label,
      note: g.trait.note,
    })),
  });

  state.stage++;

  // --- 戦役の決着 -------------------------------------------------
  // 国が保たなくなれば、戦線がどうであろうと戦争はそこで終わる。
  if (collapse) {
    state.finished = true;
    state.result = 'collapse';
    state.collapse = collapse.id;
    state.resultReason = collapse.reason;
  } else if (state.front <= campaign.front.min) {
    state.finished = true;
    state.result = 'defeat';
    state.resultReason = '戦線を保てなかった。戦役はここで終わる。';
  } else if (state.stage >= campaign.stages.length) {
    state.finished = true;
    const wins = state.history.filter((h) => h.outcome === 'victory').length;
    const losses = state.history.filter((h) => h.outcome === 'defeat').length;
    state.result = losses === 0 && wins >= 2 ? 'victory' : losses >= 2 ? 'defeat' : 'narrow';
    state.resultReason =
      state.result === 'victory' ? '三日間を戦い抜き、戦線は前へ出た。'
        : state.result === 'narrow' ? '戦線は保った。だが中隊はもう中隊ではない。'
          : '戦線は下がった。稼いだ時間に、見合うものは無かった。';
  }

  return { outcome, gained };
}

/* ------------------------------------------------------------------ */
/* 補充の割り当て                                                       */
/* ------------------------------------------------------------------ */

/** 一晩に一個の部隊へ入れられる補充の上限。分隊は一晩では生えてこない。 */
export const REPLACEMENT_CAP = 4;

/** その部隊に補充を何人まで入れられるか（定員まで、かつ一晩ぶんまで） */
export function replacementRoom(state, unitId) {
  const c = state.carry[unitId];
  if (!c) return 0;
  const max = c.maxStrength ?? 9;
  const now = c.strength + (c.walkingWounded ?? 0) * 0.5;
  return Math.max(0, Math.min(REPLACEMENT_CAP, Math.round(max - now)));
}

/** 勝った日に大隊が回してくれる分派の順。均等に増えるようにしてある。 */
const ASSET_REWARD = ['at', 'medic', 'relay', 'mg', 'fo', 'eng'];

/** その部隊にその分派を付けられるか。理由つきで返す。 */
export function canAttach(state, unitId, attachId, unitType) {
  const list = state.attach[unitId] ?? [];
  if (list.includes(attachId)) return { ok: false, why: 'すでに付いている' };
  if (list.length >= SLOTS_PER_UNIT) return { ok: false, why: 'これ以上は付けられない' };
  if (!fits(attachId, unitType)) return { ok: false, why: 'この兵種には付かない' };
  if (assetsLeft(state)[attachId] <= 0) return { ok: false, why: '手持ちが無い' };
  return { ok: true, why: '' };
}

export function attachAsset(state, unitId, attachId, unitType) {
  const check = canAttach(state, unitId, attachId, unitType);
  if (!check.ok) return check;
  (state.attach[unitId] ??= []).push(attachId);
  return { ok: true, why: '' };
}

export function detachAsset(state, unitId, attachId) {
  const list = state.attach[unitId];
  if (!list) return false;
  const i = list.indexOf(attachId);
  if (i < 0) return false;
  list.splice(i, 1);
  if (!list.length) delete state.attach[unitId];
  return true;
}

/** 配ったあとに残っている分派 */
export function assetsLeft(state) {
  const left = { ...state.assets };
  for (const list of Object.values(state.attach)) {
    for (const id of list) left[id] = (left[id] ?? 0) - 1;
  }
  return left;
}

export function assignedTotal(state) {
  return Object.values(state.assign).reduce((a, b) => a + b, 0);
}

export function allottedTotal(state) {
  return state.allot.rounds + state.allot.smoke + state.allot.illum;
}

export function poolLeft(state) {
  return {
    replacements: state.pool.replacements - assignedTotal(state),
    rounds: state.pool.rounds - allottedTotal(state),
  };
}

/* ------------------------------------------------------------------ */
/* 国政                                                                */
/* ------------------------------------------------------------------ */

/**
 * 出撃の直前に、その晩の政令を実施する。
 * 出したものが効くのは翌日からではなく、今日の戦闘からである。
 */
export function settleNight(state) {
  if (!state.nation) return null;
  // 一晩は一度しか明けない。
  // 戦闘中に読み込み直して出撃し直すと、その晩の決算が何度でも走っていた ─
  // 押すだけで国庫も補充も無限に湧く穴になっていた。
  if (state.settledStage === state.stage) return null;
  const res = applyDecrees(state.nation, state.stage + 1);
  // 補充兵の質。志願で来た者と、名簿で引かれた者は違う。
  // 計算しておきながら捨てていたので、この差はゲームの中に存在していなかった。
  state.recruitQuality = res.quality ?? 0;
  // 政令で出てきた人と弾は、そのまま手持ちに積まれる。
  state.pool.replacements += res.output.replacements;
  state.pool.rounds += res.output.rounds;
  state.settledStage = state.stage;
  return res;
}

/** 粛清。将校を除き、代わりを立てる。 */
export function purgeOfficer(state, unitId, rng) {
  const officer = state.officers.get(unitId);
  if (!officer || !state.nation) return null;
  const cost = purge(state.nation, officer, state.stage + 1);
  const taken = new Set([...state.officers.values()].map((o) => o.name));
  const next = replaceOfficer(officer, rng, taken);
  // 代わりに来るのは、忠誠だけは高い者である。腕は無い。
  next.loyalty = Math.min(92, state.nation.loyalty + 18);
  state.officers.set(unitId, next);
  // 除かれた部隊は、しばらく士気が戻らず、腕も落ちる ─
  // 経歴のある指揮官を失うとはそういうことである。
  (state.purgedUnits ??= {})[unitId] = true;
  if (state.carry[unitId]) {
    state.carry[unitId].morale = Math.max(28, (state.carry[unitId].morale ?? 70) - 16);
  }
  return { cost, removed: officer, replacement: next };
}

/** 叙勲。忠誠を買う ─ 買えるうちは安い。 */
export function decorateOfficer(state, unitId) {
  const officer = state.officers.get(unitId);
  if (!officer || !state.nation) return null;
  const res = decorate(state.nation, officer);
  driftLoyalty(officer, state.nation.loyalty, { decorated: true });
  return res;
}

/** 造反しかけている部隊（画面で赤く出す） */
export function waveringUnits(state) {
  return [...state.officers.values()].filter(isWavering).map((o) => o.unitId);
}

export { purgeCost };

/* ------------------------------------------------------------------ */
/* 保存                                                                */
/* ------------------------------------------------------------------ */

export function serializeCampaign(state) {
  return {
    v: 1,
    seed: state.seed ?? null,
    campaignId: state.campaignId,
    stage: state.stage,
    front: state.front,
    finished: state.finished,
    result: state.result,
    resultReason: state.resultReason,
    pool: { ...state.pool },
    assets: { ...state.assets },
    attach: JSON.parse(JSON.stringify(state.attach)),
    assign: { ...state.assign },
    allot: { ...state.allot },
    night: state.night,
    carry: JSON.parse(JSON.stringify(state.carry)),
    officers: [...state.officers.values()].map(serializeOfficer),
    history: JSON.parse(JSON.stringify(state.history)),
    nation: state.nation ? serializeNation(state.nation) : null,
    collapse: state.collapse ?? null,
    settledStage: state.settledStage ?? -1,
    recruitQuality: state.recruitQuality ?? 0,
    purgedUnits: { ...(state.purgedUnits ?? {}) },
  };
}

export function deserializeCampaign(raw) {
  if (!raw || raw.v !== 1) return null;
  const officers = new Map();
  for (const o of raw.officers ?? []) officers.set(o.unitId, deserializeOfficer(o));
  return {
    seed: raw.seed ?? null,
    campaignId: raw.campaignId,
    stage: raw.stage ?? 0,
    front: raw.front ?? 50,
    finished: !!raw.finished,
    result: raw.result ?? null,
    resultReason: raw.resultReason ?? null,
    pool: raw.pool ?? { replacements: 0, rounds: 0, smoke: 0, illum: 0 },
    assets: raw.assets ?? { mg: 1, at: 0, eng: 1, fo: 1, medic: 0, relay: 0 },
    attach: raw.attach ?? {},
    assign: raw.assign ?? {},
    allot: raw.allot ?? { rounds: 0, smoke: 0, illum: 0 },
    night: raw.night ?? 'rest',
    carry: raw.carry ?? {},
    officers,
    history: raw.history ?? [],
    // v2.0 で保存された戦役には国が無い。読めるようにしておく。
    nation: deserializeNation(raw.nation),
    collapse: raw.collapse ?? null,
    settledStage: raw.settledStage ?? -1,
    recruitQuality: raw.recruitQuality ?? 0,
    purgedUnits: raw.purgedUnits ?? {},
  };
}
