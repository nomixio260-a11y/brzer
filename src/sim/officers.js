// 将校。
//
// 部下は駒ではない。同じ「歩兵分隊」でも、指揮する者が違えば別の部隊になる。
// 押せば動く者、押しても動かない者、押さなくても動く者がいる。
// 指揮官の仕事の半分は、地図を読むことではなく、部下を読むことである。
//
// ここが持つのは「その人がどういう人か」だけ。
// それが実際に何を変えるかは orders.js / ai.js / reports.js の側にある。

import { clamp } from '../util.js';

/* ------------------------------------------------------------------ */
/* 気質                                                                */
/* ------------------------------------------------------------------ */
//
// 六つの軸で人を測る。数字はすべて 1.0 を「並」とする倍率か、
// 0 を「並」とする加算値である。
//
//   obey       命令の呑み込みの早さ。高いほど受領から実行までが短く、拒まない。
//   initiative 独断。高いほど、命令が無くても・命令を越えても自分で動く。
//   nerve      腰の据わり。高いほど、圧されても位置を動かさない。
//   chatter    無線の多さ。高いほどよく喋る（＝網を埋める）。
//   aim        射撃の統制。高いほど同じ火器でよく当てる。
//   care       部下の扱い。高いほど負傷者が戻ってくる。

export const TEMPERAMENTS = Object.freeze({
  steady: {
    id: 'steady', label: '沈着', short: '沈',
    note: '慌てない。良くも悪くも、言われたことを言われたとおりにやる。',
    obey: 1.12, initiative: 0.92, nerve: 1.1, chatter: 1.0, aim: 1.04, care: 1.0,
  },
  aggressive: {
    id: 'aggressive', label: '果敢', short: '果',
    note: '前へ出たがる。攻めさせれば速いが、退けと言っても遅い。',
    obey: 0.9, initiative: 1.35, nerve: 1.05, chatter: 0.85, aim: 0.98, care: 0.9,
  },
  cautious: {
    id: 'cautious', label: '慎重', short: '慎',
    note: '無理をしない。損害は少ないが、頼んだ時刻には着いていない。',
    obey: 1.05, initiative: 0.85, nerve: 0.88, chatter: 1.15, aim: 1.06, care: 1.15,
  },
  meticulous: {
    id: 'meticulous', label: '几帳面', short: '几',
    note: '様式どおりに報告し、様式どおりに撃つ。無線はよく埋まる。',
    obey: 1.18, initiative: 0.8, nerve: 1.0, chatter: 1.35, aim: 1.12, care: 1.05,
  },
  headstrong: {
    id: 'headstrong', label: '一徹', short: '徹',
    note: '自分の目を信じる。当たっているうちは頼もしく、外れると手に負えない。',
    obey: 0.78, initiative: 1.25, nerve: 1.22, chatter: 0.8, aim: 1.0, care: 0.95,
  },
});

export const TEMPERAMENT_IDS = Object.freeze(Object.keys(TEMPERAMENTS));

/* ------------------------------------------------------------------ */
/* 特性                                                                */
/* ------------------------------------------------------------------ */
//
// 特性は与えるものではなく、生えるものである。
// 何をしたかの記録から、戦闘のあとで付く。だから最初の戦闘では誰も持っていない。

export const TRAITS = Object.freeze({
  ironhearted: {
    id: 'ironhearted', label: '不動',
    note: '砲撃を浴びても線を動かなかった。',
    nerve: 0.16, care: 0,
  },
  hunter: {
    id: 'hunter', label: '猟兵',
    note: '与えた損害が飛び抜けている。',
    aim: 0.1,
  },
  prudent: {
    id: 'prudent', label: '深慮',
    note: '潰れる前に下がる判断ができる。',
    nerve: -0.05, initiative: 0.14,
  },
  quickhand: {
    id: 'quickhand', label: '早耳',
    note: '命令の呑み込みが早い。復唱が返るのが速い。',
    obey: 0.12,
  },
  taciturn: {
    id: 'taciturn', label: '寡黙',
    note: '要らないことを言わない。網が空く。',
    chatter: -0.25,
  },
  shepherd: {
    id: 'shepherd', label: '面倒見',
    note: '負傷者を必ず引きずって帰ってくる。',
    care: 0.22,
  },
  scarred: {
    id: 'scarred', label: '手負い',
    note: '一度ひどい目に遭っている。無理をしなくなった。',
    nerve: -0.1, initiative: -0.1, care: 0.12,
  },
  stubborn: {
    id: 'stubborn', label: '頑固',
    note: '納得しない命令は、返事だけして動かないことがある。',
    obey: -0.14, nerve: 0.12,
  },
});

/* ------------------------------------------------------------------ */
/* 練度の段階                                                           */
/* ------------------------------------------------------------------ */
//
// 経験は数字ではなく段階で見せる。指揮官は部下の熟練度を小数では知らない。

export const GRADES = Object.freeze([
  { at: 0, label: '新編', skill: 0.0 },
  { at: 1, label: '実戦経験あり', skill: 0.03 },
  { at: 3, label: '古参', skill: 0.06 },
  { at: 6, label: '歴戦', skill: 0.09 },
  { at: 10, label: '精鋭', skill: 0.12 },
]);

export function gradeOf(officer) {
  let g = GRADES[0];
  for (const step of GRADES) if ((officer?.xp ?? 0) >= step.at) g = step;
  return g;
}

/* ------------------------------------------------------------------ */
/* 名簿                                                                */
/* ------------------------------------------------------------------ */

const SURNAMES = [
  '沢渡', '真鍋', '結城', '八重樫', '土肥', '梶井', '広瀬', '瀬能', '安曇', '牧',
  '御堂', '相良', '深水', '菅野', '不破', '志水', '朝比奈', '香月', '樋渡', '五十嵐',
  '篠塚', '大貫', '鵜飼', '春日', '溝口', '高梨', '柏木', '海老原',
];

// 分隊を率いるのは下士官、支援や偵察を率いるのは准士官・尉官という辺りに落とす。
const RANKS = {
  infantry: ['軍曹', '曹長'],
  at_team: ['軍曹', '曹長'],
  recon: ['軍曹', '曹長'],
  mech: ['曹長', '准尉'],
  tank: ['曹長', '准尉'],
  mortar: ['准尉', '少尉'],
  drone: ['三曹', '軍曹'],
  supply: ['曹長', '准尉'],
};

/**
 * 戦役の名簿を配る。
 * 同じ種を渡せば同じ顔ぶれが出る ─ 戦役の途中で人が入れ替わっては困る。
 */
export function rollOfficers(rng, roster) {
  const used = new Set();
  const out = new Map();

  for (const r of roster) {
    if (r.virtual) continue;
    let name = null;
    for (let i = 0; i < 40 && !name; i++) {
      const cand = SURNAMES[Math.floor(rng.range(0, SURNAMES.length)) % SURNAMES.length];
      if (!used.has(cand)) name = cand;
    }
    name ??= SURNAMES[used.size % SURNAMES.length];
    used.add(name);

    const ranks = RANKS[r.unitType] ?? RANKS.infantry;
    const rank = ranks[Math.floor(rng.range(0, ranks.length)) % ranks.length];
    const temperament =
      TEMPERAMENT_IDS[Math.floor(rng.range(0, TEMPERAMENT_IDS.length)) % TEMPERAMENT_IDS.length];

    out.set(r.id, createOfficer({
      unitId: r.id,
      callsign: r.callsign,
      name,
      rank,
      temperament,
    }));
  }
  return out;
}

export function createOfficer({
  unitId, callsign, name, rank, temperament = 'steady',
  traits = [], xp = 0, battles = 0, kills = 0, losses = 0, wounded = false,
  loyalty = 68,
}) {
  return {
    unitId,
    callsign,
    name,
    rank,
    temperament,
    traits: [...traits],
    xp,
    battles,
    kills,
    losses,
    // この一人が指導者に付いているか。士官団全体の忠誠とは別に、一人ずつ違う ─
    // 誰を粛清し、誰に叙勲するかは、これで決める。
    loyalty,
    // 一度でも部隊を半分にされた者は、それを覚えている。
    wounded,
    // 戦死・後送。空席になった部隊には代わりが来る。
    fallen: false,
  };
}

/** 表示名。「沢渡 曹長」 */
export function officerName(officer) {
  if (!officer) return '';
  return `${officer.name} ${officer.rank}`;
}

/** 一行の紹介。「沢渡 曹長 ─ 沈着 ／ 不動・猟兵」 */
export function officerLine(officer) {
  if (!officer) return '';
  const t = TEMPERAMENTS[officer.temperament];
  const traits = officer.traits.map((id) => TRAITS[id]?.label).filter(Boolean);
  const grade = gradeOf(officer);
  const bits = [t?.label ?? ''];
  if (traits.length) bits.push(traits.join('・'));
  if (grade.at > 0) bits.push(grade.label);
  return `${officerName(officer)} ─ ${bits.filter(Boolean).join(' ／ ')}`;
}

/* ------------------------------------------------------------------ */
/* 実際に効く数値                                                       */
/* ------------------------------------------------------------------ */

const NEUTRAL = Object.freeze({
  obey: 1, initiative: 1, nerve: 1, chatter: 1, aim: 1, care: 1,
});

/**
 * 気質と特性を合わせた最終の係数。
 * 極端に振れないよう、どの軸も 0.6〜1.6 に収める ─
 * 人の差で戦闘が決まってしまっては、指揮官の判断が意味を失う。
 */
export function officerFactors(officer) {
  if (!officer) return NEUTRAL;
  if (officer._factors) return officer._factors;

  const t = TEMPERAMENTS[officer.temperament] ?? TEMPERAMENTS.steady;
  const f = {
    obey: t.obey, initiative: t.initiative, nerve: t.nerve,
    chatter: t.chatter, aim: t.aim, care: t.care,
  };
  for (const id of officer.traits) {
    const tr = TRAITS[id];
    if (!tr) continue;
    for (const k of Object.keys(f)) if (tr[k]) f[k] += tr[k];
  }
  // 熟練は腕（aim）と腰（nerve）に出る。
  const g = gradeOf(officer);
  f.aim += g.skill * 0.5;
  f.nerve += g.skill;

  // 忠誠は呑み込みに出る。付いていない者は返事も遅いし、渋る。
  // 気質とは別の話である ─ 一徹な者でも、心服していれば早く動く。
  f.obey *= loyaltyFactor(officer);

  for (const k of Object.keys(f)) f[k] = clamp(f[k], 0.6, 1.6);
  officer._factors = Object.freeze(f);
  return officer._factors;
}

/** 特性が変われば係数も引き直す */
function invalidate(officer) {
  officer._factors = null;
}

/* ------------------------------------------------------------------ */
/* 戦闘のあと                                                           */
/* ------------------------------------------------------------------ */

/**
 * 一戦ぶんの記録から、特性を生やし、経験を積ませる。
 *
 * @param {object} officer
 * @param {object} record 一戦の振る舞い
 *   {survived, strengthRatio, lossRatio, inflicted, selfWithdrew,
 *    heldUnderFire, refusedOrders, transmissions, woundedRecovered, minutes}
 * @returns {Array<object>} 新しく生えた特性
 */
export function debriefOfficer(officer, record) {
  if (!officer) return [];
  const gained = [];
  const add = (id) => {
    if (officer.traits.includes(id)) return;
    if (officer.traits.length >= 3) return; // 人は三つも札を提げていない
    officer.traits.push(id);
    gained.push(TRAITS[id]);
  };

  officer.battles++;
  officer.kills += Math.round(record.inflicted ?? 0);
  officer.losses += Math.round(record.losses ?? 0);

  // 生き延びた戦闘だけが経験になる。全滅した部隊は経験を残さない。
  if (record.survived) officer.xp++;

  // --- 特性が生える条件 --------------------------------------------
  // 「砲撃を浴びながら線を動かさなかった」
  if (record.heldUnderFire && !record.selfWithdrew && (record.lossRatio ?? 0) > 0.2) {
    add('ironhearted');
  }
  // 「与えた損害が飛び抜けている」
  if ((record.inflicted ?? 0) >= 7) add('hunter');
  // 「潰れる前に下がった」
  if (record.selfWithdrew && record.survived && (record.strengthRatio ?? 1) > 0.55) {
    add('prudent');
  }
  // 「復唱が速い」
  if ((record.avgResponse ?? 999) < 26 && (record.refusedOrders ?? 0) === 0) add('quickhand');
  // 「要らないことを言わない」
  if ((record.transmissions ?? 99) <= 4 && record.survived) add('taciturn');
  // 「負傷者を引きずって帰る」
  if ((record.woundedRecovered ?? 0) >= 2) add('shepherd');
  // 「一度ひどい目に遭った」
  if ((record.strengthRatio ?? 1) < 0.42 && record.survived) {
    officer.wounded = true;
    add('scarred');
  }
  // 「返事だけして動かない」
  if ((record.refusedOrders ?? 0) >= 2) add('stubborn');

  // 特性が生えなくても、経験を積めば等級が上がる。係数は無条件に引き直す。
  // ここを特性任せにしていたので、古参になっても腕が上がらないままだった。
  invalidate(officer);
  return gained;
}

/**
 * 一晩ぶんの忠誠の推移。
 *
 * 士官団の空気（国全体の忠誠）に引かれつつ、その人の性分で寄り方が変わる。
 * 一徹・果敢な者は自分の目で見るので流されにくく、
 * 沈着・几帳面な者は組織を見るので流されやすい。
 */
export function driftLoyalty(officer, national, { won = false, decorated = false } = {}) {
  if (!officer) return;
  const t = TEMPERAMENTS[officer.temperament] ?? TEMPERAMENTS.steady;
  const pull = t.initiative > 1.1 ? 0.18 : 0.34;
  let next = officer.loyalty + (national - officer.loyalty) * pull;
  // 勝った戦は忠誠を戻す。勝てば士官は付いてくる。
  if (won) next += 4;
  // 叙勲された者は、しばらく誰よりも付いている。
  if (decorated) next += 12;
  // 歴戦の者ほど、指導者より自分の部隊を見るようになる。
  next -= Math.min(4, (officer.xp ?? 0) * 0.6);
  officer.loyalty = clamp(next, 0, 100);
  invalidate(officer);
}

/** 忠誠は係数にも出る。付いていない者は、命令の呑み込みが悪い。 */
function loyaltyFactor(officer) {
  const l = officer?.loyalty ?? 68;
  return clamp(0.72 + (l / 100) * 0.42, 0.6, 1.16);
}

/** 造反の危険。この部隊は、いつ命令を聞かなくなってもおかしくない。 */
export function isWavering(officer) {
  return (officer?.loyalty ?? 68) < 28;
}

/**
 * 戦死・後送。空席には代わりが来るが、経歴は引き継がれない。
 * @param {Set<string>} taken 今この中隊に居る者の姓（同姓が並ぶと点呼で困る）
 */
export function replaceOfficer(officer, rng, taken = new Set()) {
  let surname = null;
  for (let i = 0; i < 40 && !surname; i++) {
    const cand = SURNAMES[Math.floor(rng.range(0, SURNAMES.length)) % SURNAMES.length];
    if (!taken.has(cand)) surname = cand;
  }
  surname ??= SURNAMES[Math.floor(rng.range(0, SURNAMES.length)) % SURNAMES.length];
  const temperament =
    TEMPERAMENT_IDS[Math.floor(rng.range(0, TEMPERAMENT_IDS.length)) % TEMPERAMENT_IDS.length];
  return createOfficer({
    unitId: officer.unitId,
    callsign: officer.callsign,
    name: surname,
    rank: officer.rank,
    temperament,
  });
}

/** 保存用の素の形（関数も参照も持たない） */
export function serializeOfficer(o) {
  return {
    unitId: o.unitId, callsign: o.callsign, name: o.name, rank: o.rank,
    temperament: o.temperament, traits: [...o.traits],
    xp: o.xp, battles: o.battles, kills: o.kills, losses: o.losses,
    wounded: !!o.wounded, fallen: !!o.fallen, loyalty: o.loyalty ?? 68,
  };
}

export function deserializeOfficer(raw) {
  const o = createOfficer(raw);
  o.fallen = !!raw.fallen;
  return o;
}
