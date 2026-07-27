// 国政。
//
// 戦争は前線だけで行われるものではない。
// 弾を作るのは工場であり、兵を出すのは町であり、その町を保たせるのは統治である。
//
// 指導者にできることは多い。徴発も、戒厳も、粛清も、恩赦もできる。
// できないのは「代償を払わずに済ませること」だけである。
//
// ここが持つのは国の状態と、指導者が出した政令の帳簿だけ。
// それが戦場で何を起こすかは、campaign.js と world.js の側にある。
//
// 扱うのは架空国家の統治である。実在の国も民族も史実も、ここには無い。

import { clamp } from '../util.js';

/* ------------------------------------------------------------------ */
/* 国の状態                                                            */
/* ------------------------------------------------------------------ */
//
// 指標は四つに絞ってある。多すぎる目盛りは、指導者を会計係にする。
//
//   民心  国民が政府を支えているか。兵の質と、内乱までの余裕。
//   統制  国家が国民を押さえられているか。脱走と動揺を抑えるが、恐怖を生む。
//   忠誠  士官団が指導者に付いているか。尽きれば造反する。
//   国庫  払えるもの。政令はすべてここから出る。

export const METERS = Object.freeze({
  morale: { id: 'morale', label: '民心', note: '国民が政府を支えているか。兵の質と、内乱までの余裕。' },
  control: { id: 'control', label: '統制', note: '国家が国民を押さえられているか。動揺は抑えるが、恐怖を生む。' },
  loyalty: { id: 'loyalty', label: '忠誠', note: '士官団が指導者に付いているか。尽きれば造反する。' },
});

/**
 * 目盛りを言葉にする。
 *
 * 造反や内乱の一歩手前に名前があること ─ 「離心」「騒擾」 ─ が、
 * 帰結を「突然」でなくする。数字を読まなくても、国の様子が分かる必要がある。
 */
export const STAGES = Object.freeze({
  morale: [
    { at: 0, label: '内乱' }, { at: 20, label: '騒擾' },
    { at: 40, label: '不穏' }, { at: 62, label: '平穏' },
  ],
  control: [
    { at: 0, label: '寛' }, { at: 34, label: '常' },
    { at: 62, label: '厳' }, { at: 82, label: '苛' },
  ],
  loyalty: [
    { at: 0, label: '造反' }, { at: 28, label: '離心' },
    { at: 48, label: '動揺' }, { at: 70, label: '帰服' },
  ],
});

export function stageOf(id, value) {
  const steps = STAGES[id];
  if (!steps) return '';
  let out = steps[0].label;
  for (const st of steps) if (value >= st.at) out = st.label;
  return out;
}

export const START = Object.freeze({
  morale: 62,
  control: 55,
  loyalty: 70,
  treasury: 40,
});

/** 架空国家。実在の国ではない。 */
export const NATION = Object.freeze({
  name: 'ヴォルネ共和国',
  eyebrow: '国家評議会 議長府',
  blurb:
    '人口四百万。北の隣国と国境を接し、その国境の川で戦争になっている。' +
    '議長は貴官である ─ 前線の指揮も、国の運営も、同じ一人が背負う。',
});

export function createNation() {
  return {
    ...START,
    // 恐怖。統制そのものではなく、統制を「どう使ったか」で溜まる。
    // これが高いほど、前線から上がってくる報告が甘くなる。
    fear: 0,
    // この手番に出した政令（id の配列）。夜が明ければ白紙に戻る。
    decrees: [],
    // 継続している施策（戒厳令・情報統制など、切るまで効き続けるもの）
    standing: [],
    // 粛清した将校の記録。数えられていることが大事である。
    purged: [],
    // 叙勲した将校
    decorated: [],
    // 出した政令の履歴（講評で「どう統治したか」を突きつけるために残す）
    ledger: [],
    // 継続の令が「実際に動かした分」。解くときはこれを返す。
    applied: {},
    // 帳簿の上の生産。前の手番の政令で決まる。
    output: { replacements: 6, rounds: 4 },
  };
}

/* ------------------------------------------------------------------ */
/* 政令                                                                */
/* ------------------------------------------------------------------ */
//
// 一晩に出せる政令は二つまで。
// 全部やれるなら、それは統治ではなく願望である。
//
// cost   国庫から引かれる
// effect 指標への加算（負なら減る）
// yields 次の戦闘へ回るもの
// keep   true なら継続施策（切るまで毎晩効く）

export const DECREE_LIMIT = 2;

export const DECREES = Object.freeze({
  /* --- 動員 ------------------------------------------------------ */
  volunteer: {
    id: 'volunteer', group: 'mobilize', label: '志願兵の募集',
    note: '町に募兵所を置く。集まる数は多くないが、来る者は自分の意思で来る。',
    cost: 6, effect: { morale: +1 }, yields: { replacements: 4 }, quality: +0.02,
  },
  conscript: {
    id: 'conscript', group: 'mobilize', label: '徴兵の実施',
    note: '名簿から引く。数は揃うが、揃うだけである。',
    cost: 4, effect: { morale: -6 }, yields: { replacements: 8 }, quality: -0.02,
  },
  total_war: {
    id: 'total_war', group: 'mobilize', label: '総動員令',
    note: '年齢の上下を広げ、工場から人を抜く。国が一度に痩せる。',
    cost: 8, effect: { morale: -14, control: +4 }, yields: { replacements: 14 }, quality: -0.05,
    keep: false,
  },

  /* --- 経済 ------------------------------------------------------ */
  tax: {
    id: 'tax', group: 'economy', label: '戦時増税',
    note: '取れるところから取る。取られた側は覚えている。',
    cost: -18, effect: { morale: -7 },
  },
  requisition: {
    id: 'requisition', group: 'economy', label: '物資の徴発',
    note: '倉から出させる。弾は前線に届き、麦は町から消える。',
    cost: 2, effect: { morale: -9 }, yields: { rounds: 7 },
  },
  factory: {
    id: 'factory', group: 'economy', label: '増産計画',
    note: '工場を二交代にする。今夜は何も増えないが、明日から効く。',
    cost: 14, effect: { morale: -2 }, yields: { rounds: 4 }, keep: true,
  },

  /* --- 秩序 ------------------------------------------------------ */
  martial_law: {
    id: 'martial_law', group: 'order', label: '戒厳令',
    note: '夜間の外出を禁じ、憲兵に権限を与える。脱走は減る。町は静かになる。',
    cost: 5, effect: { control: +12, morale: -8 }, fear: +0.12, keep: true,
  },
  censorship: {
    id: 'censorship', group: 'order', label: '情報統制',
    note:
      '新聞と無線を検める。悪い報せは国民に届かない ─ ' +
      'そして、しばらくすると貴官にも届かなくなる。',
    cost: 4, effect: { control: +8, morale: +4 }, fear: +0.18, keep: true,
  },
  secret_police: {
    id: 'secret_police', group: 'order', label: '保安部の拡張',
    note: '密告を制度にする。造反の芽は摘める。摘んでいる側も、次は自分だと思っている。',
    cost: 10, effect: { control: +14, loyalty: -6, morale: -6 }, fear: +0.26, keep: true,
  },

  /* --- 恩恤 ------------------------------------------------------ */
  relief: {
    id: 'relief', group: 'mercy', label: '罹災民の救済',
    note: '焼けた町に配給を回す。前線には何も増えない。',
    cost: 16, effect: { morale: +13 }, fear: -0.06,
  },
  amnesty: {
    id: 'amnesty', group: 'mercy', label: '恩赦',
    note: '収容している者を帰す。何人かは戻ってこないが、大半は家に帰る。',
    cost: 6, effect: { morale: +9, control: -8, loyalty: +3 }, fear: -0.12,
  },
  honors: {
    id: 'honors', group: 'mercy', label: '叙勲と恩給',
    note: '戦った者に報いる。士官団は見ている ─ 報いるかどうかを、ずっと見ている。',
    cost: 12, effect: { loyalty: +11, morale: +3 },
  },
  free_press: {
    id: 'free_press', group: 'mercy', label: '報道の解禁',
    note:
      '検閲を解く。損害が国民に知れる ─ ' +
      'そのかわり、前線からの報告も正直になる。',
    cost: 3, effect: { morale: -5, control: -6 }, fear: -0.3, clears: ['censorship'],
  },
});

export const DECREE_IDS = Object.freeze(Object.keys(DECREES));

export const DECREE_GROUPS = Object.freeze({
  mobilize: { id: 'mobilize', label: '動員' },
  economy: { id: 'economy', label: '経済' },
  order: { id: 'order', label: '秩序' },
  mercy: { id: 'mercy', label: '恩恤' },
});

/* ------------------------------------------------------------------ */
/* 政令を出す                                                          */
/* ------------------------------------------------------------------ */

export function canDecree(nation, id) {
  const d = DECREES[id];
  if (!d) return { ok: false, why: 'そのような政令はない' };
  if (nation.decrees.includes(id)) return { ok: false, why: '今夜すでに出している' };
  if (nation.decrees.length >= DECREE_LIMIT) return { ok: false, why: '一晩に出せるのは二つまで' };
  if (d.keep && nation.standing.includes(id)) return { ok: false, why: 'すでに施行中' };
  if (d.clears && !d.clears.some((c) => nation.standing.includes(c))) {
    return { ok: false, why: '解くべきものが無い' };
  }
  if (nation.treasury < d.cost) return { ok: false, why: '国庫が足りない' };
  return { ok: true, why: '' };
}

export function decree(nation, id) {
  const check = canDecree(nation, id);
  if (!check.ok) return check;
  nation.decrees.push(id);
  return { ok: true, why: '' };
}

export function revokeDecree(nation, id) {
  const i = nation.decrees.indexOf(id);
  if (i < 0) return false;
  nation.decrees.splice(i, 1);
  return true;
}

/** 継続施策を切る（戒厳令をやめる、など） */
export function liftStanding(nation, id) {
  const i = nation.standing.indexOf(id);
  if (i < 0) return false;
  nation.standing.splice(i, 1);

  // 返すのは「表に書いてある値」ではなく「実際に動いた分」である。
  //
  // 表の値をそのまま引くと、目盛りが底や天井で詰まっていたときに
  // 取られた以上が返ってきた ─ 民心2の国が戒厳令を敷いて解くだけで
  // 民心が8ずつ増え、内乱がまるごと無効化されていた。
  const applied = nation.applied?.[id];
  if (applied) {
    for (const [k, v] of Object.entries(applied)) {
      if (k === 'fear') nation.fear = clamp(nation.fear - v * 0.5, 0, 1);
      else nation[k] = clamp(nation[k] - v, 0, 100);
    }
    delete nation.applied[id];
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 一晩を締める                                                        */
/* ------------------------------------------------------------------ */

/**
 * 出した政令を実施し、指標を動かし、翌日へ回る生産を決める。
 * 戦闘に入る直前に一度だけ呼ぶ。
 *
 * @returns {object} {output, notes} 何が起きたか（画面と講評に出す）
 */
export function applyDecrees(nation, day = 1) {
  const notes = [];
  const output = { replacements: 0, rounds: 0 };
  let quality = 0;

  for (const id of nation.decrees) {
    const d = DECREES[id];
    if (!d) continue;
    const before = { morale: nation.morale, control: nation.control, loyalty: nation.loyalty, fear: nation.fear };
    nation.treasury = Math.max(0, nation.treasury - d.cost);
    for (const [k, v] of Object.entries(d.effect ?? {})) nation[k] = clamp(nation[k] + v, 0, 100);
    if (d.fear) nation.fear = clamp(nation.fear + d.fear, 0, 1);
    // 継続の令は、実際に動いた分を控えておく（解くときにそれを返す）
    if (d.keep) {
      const moved = {};
      for (const k of Object.keys(d.effect ?? {})) moved[k] = nation[k] - (before[k] ?? nation[k]);
      if (d.fear) moved.fear = nation.fear - (before.fear ?? nation.fear);
      (nation.applied ??= {})[id] = moved;
    }
    output.replacements += d.yields?.replacements ?? 0;
    output.rounds += d.yields?.rounds ?? 0;
    quality += d.quality ?? 0;
    if (d.keep) nation.standing.push(id);
    for (const c of d.clears ?? []) {
      const i = nation.standing.indexOf(c);
      if (i >= 0) nation.standing.splice(i, 1);
    }
    notes.push({ day, id, label: d.label });
  }

  // 継続施策は毎晩効き続ける。敷いた翌日からが本番である。
  for (const id of nation.standing) {
    const d = DECREES[id];
    if (!d) continue;
    output.rounds += Math.round((d.yields?.rounds ?? 0) * 0.5);
  }

  // 国の地力。民心が高ければ工場も畑も回る。統制だけでは何も生まれない。
  const base = 3 + Math.round(nation.morale / 22);
  output.replacements += base;
  output.rounds += 2 + Math.round(nation.morale / 34);

  // 税収。取り立てなくても、国が回っていれば入るものは入る。
  nation.treasury = Math.min(120, nation.treasury + 6 + Math.round(nation.morale / 12));

  // 恐怖は放っておけば薄れる。統制が高いままなら、薄れない。
  nation.fear = clamp(nation.fear - 0.04 + (nation.control > 75 ? 0.03 : 0), 0, 1);

  nation.ledger.push(...notes);
  nation.decrees = [];
  nation.output = { ...output };

  return { output, quality, notes };
}

/* ------------------------------------------------------------------ */
/* 戦争が国に返すもの                                                   */
/* ------------------------------------------------------------------ */

/**
 * 一戦の結果を国に反映する。
 * 勝てば士官団は付いてくるし、負ければ町は政府を疑う。
 */
export function absorbBattle(nation, outcome, score) {
  const shift = {
    victory: { morale: +7, loyalty: +6, control: +2 },
    narrow: { morale: +1, loyalty: +1, control: 0 },
    defeat: { morale: -9, loyalty: -7, control: -3 },
  }[outcome] ?? {};
  for (const [k, v] of Object.entries(shift)) nation[k] = clamp(nation[k] + v, 0, 100);

  // 損害は町に伝わる。情報統制を敷いていれば、伝わり方は鈍い ―
  // 鈍いだけで、いずれ伝わる。帰ってこない者は数えられている。
  const hidden = nation.standing.includes('censorship') ? 0.45 : 1;
  const losses = score?.losses ?? 0;
  nation.morale = clamp(nation.morale - losses * 0.22 * hidden, 0, 100);

  // 民間人を巻き込めば、その日のうちに知れ渡る。検閲も効かない。
  const civ = score?.civilianLosses ?? 0;
  if (civ > 0) nation.morale = clamp(nation.morale - civ * 2.4, 0, 100);
  // 同士討ちは士官団に伝わる。誰が撃たれたかを、彼らは知っている。
  const ff = score?.friendlyFireUnits ?? 0;
  if (ff > 0) nation.loyalty = clamp(nation.loyalty - ff * 6, 0, 100);
}

/* ------------------------------------------------------------------ */
/* 粛清と叙勲                                                          */
/* ------------------------------------------------------------------ */

/**
 * 粛清の値打ちは、相手による。
 *
 * 本当に離れかけている者を除けば、士官団は納得する ─ 少なくとも表向きは。
 * よく戦っている者を除けば、その日から誰も貴官を信じない。
 */
export function purgeCost(nation, officer) {
  const disloyal = clamp((60 - (officer?.loyalty ?? 60)) / 60, 0, 1);
  const veteran = clamp((officer?.xp ?? 0) / 6, 0, 1);
  return {
    control: +6 + Math.round(disloyal * 4),
    // 離れかけていた者ほど、除いても士官団は揺れない。
    loyalty: -Math.round(6 + (1 - disloyal) * 12 + veteran * 6),
    morale: -Math.round(2 + (1 - disloyal) * 4),
    fear: 0.14 + (1 - disloyal) * 0.1,
  };
}

export function purge(nation, officer, day = 0) {
  const c = purgeCost(nation, officer);
  nation.control = clamp(nation.control + c.control, 0, 100);
  nation.loyalty = clamp(nation.loyalty + c.loyalty, 0, 100);
  nation.morale = clamp(nation.morale + c.morale, 0, 100);
  nation.fear = clamp(nation.fear + c.fear, 0, 1);
  // 何日目に、どういう者を除いたか。
  // 粛清を真面目に扱うとは、それが名前入りの一覧で戻ってくることである。
  nation.purged.push({
    unitId: officer.unitId,
    callsign: officer.callsign ?? officer.unitId,
    name: officer.name,
    rank: officer.rank,
    xp: officer.xp,
    battles: officer.battles ?? 0,
    traits: [...(officer.traits ?? [])],
    loyalty: Math.round(officer.loyalty ?? 60),
    day,
  });
  return c;
}

export function decorate(nation, officer) {
  nation.treasury = Math.max(0, nation.treasury - 4);
  nation.loyalty = clamp(nation.loyalty + 3, 0, 100);
  nation.decorated.push({ unitId: officer.unitId, name: officer.name, rank: officer.rank });
  return { loyalty: +3, treasury: -4 };
}

/* ------------------------------------------------------------------ */
/* 戦場に効くもの                                                       */
/* ------------------------------------------------------------------ */

/**
 * 国の状態を、戦闘に渡す係数に翻訳する。
 *
 * ここがこの層の全部である。指標そのものは飾りで、
 * 実際に効くのはこの6つの数字だけ。
 */
export function warFactors(nation) {
  const morale = nation.morale / 100;
  const control = nation.control / 100;
  const loyalty = nation.loyalty / 100;

  return {
    // 補充兵の質。志願で来た国の兵と、名簿で引かれた国の兵は違う。
    recruit: 0.9 + morale * 0.2,
    // 部隊が持ち込む士気の下駄
    startMorale: Math.round(-8 + morale * 18),
    // 統制。崩れにくくなるが、崩れ方は同じである。
    hold: 0.88 + control * 0.24,
    // 士官団の忠誠。低ければ命令が通らない。
    obey: 0.72 + loyalty * 0.42,
    // 恐怖。前線から上がる報告が、どれだけ甘くなるか。
    fear: nation.fear,
    // 正直さ。1 なら見たとおりを言う。
    honesty: clamp(1 - nation.fear * 0.85, 0.15, 1),
  };
}

/* ------------------------------------------------------------------ */
/* 国が保たなくなるとき                                                 */
/* ------------------------------------------------------------------ */

export const COLLAPSE = Object.freeze({
  coup: {
    id: 'coup', label: '造反',
    reason: '士官団が離れた。前線の部隊は、もう貴官の命令を受けない。',
  },
  uprising: {
    id: 'uprising', label: '内乱',
    reason: '町が政府に背いた。後方が敵になった以上、前線は保てない。',
  },
});

/**
 * 国が保っているか。保っていなければ、その理由を返す。
 *
 * 目盛りが 0 になった瞬間に終わるのではない ─
 * 低いまま日が過ぎると、ある朝それが起きる。国とはそういうものである。
 */
export function checkCollapse(nation, rng) {
  if (nation.loyalty <= 0) return COLLAPSE.coup;
  if (nation.morale <= 0) return COLLAPSE.uprising;

  // 崖の手前でも足は滑る。低いほど滑りやすい ─
  // 目盛りが一桁まで落ちた国は、たいてい翌朝まで保たない。
  if (nation.loyalty < 22 && rng.chance((22 - nation.loyalty) / 28)) return COLLAPSE.coup;
  if (nation.morale < 20 && rng.chance((20 - nation.morale) / 26)) return COLLAPSE.uprising;
  return null;
}

/* ------------------------------------------------------------------ */
/* 統治の評価                                                          */
/* ------------------------------------------------------------------ */

/**
 * どう統治したか。説教はしない ─ 何をしたかを数え、何が起きたかを並べるだけである。
 */
export function ruleSummary(nation) {
  const counts = new Map();
  for (const n of nation.ledger) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);

  const harsh =
    (counts.get('martial_law') ?? 0) + (counts.get('censorship') ?? 0) +
    (counts.get('secret_police') ?? 0) + (counts.get('conscript') ?? 0) +
    (counts.get('requisition') ?? 0) + (counts.get('total_war') ?? 0) +
    nation.purged.length * 2;
  const mild =
    (counts.get('relief') ?? 0) + (counts.get('amnesty') ?? 0) +
    (counts.get('honors') ?? 0) + (counts.get('free_press') ?? 0) +
    (counts.get('volunteer') ?? 0);

  let label = '中庸';
  let note = '取り立てて厳しくもなく、取り立てて寛くもない統治だった。';
  if (harsh >= mild * 2 && harsh >= 4) {
    label = '苛政';
    note = '恐怖で回した国だった。回っている間は、確かに回っていた。';
  } else if (mild >= harsh * 2 && mild >= 4) {
    label = '寛政';
    note = '締めるべき時に締めなかった、とも言える。町は貴官を悪くは言わない。';
  } else if (harsh >= 4 && mild >= 4) {
    label = '硬軟';
    note = '締めては緩め、緩めては締めた。国民は次に何が来るか分からなかった。';
  }

  return {
    label,
    note,
    harsh,
    mild,
    purged: nation.purged.length,
    decorated: nation.decorated.length,
    decrees: nation.ledger.length,
    standing: [...nation.standing],
  };
}

/* ------------------------------------------------------------------ */
/* 保存                                                                */
/* ------------------------------------------------------------------ */

export function serializeNation(n) {
  return JSON.parse(JSON.stringify(n));
}

export function deserializeNation(raw) {
  if (!raw) return createNation();
  return { ...createNation(), ...raw };
}
