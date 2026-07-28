// 評議会。
//
// 国政の層に指標と政令だけを置いたとき、そこには反対する者がいなかった。
// 議長が机の上で数字を動かせば、そのとおりに国が動く ─
// それは統治ではなく、家計簿である。
//
// ここに置くのは、貴官の背後に立っている四つの塊と、その席に座っている人間。
// 彼らは望むものが違い、望みは互いに噛み合わない。
// だからどの政令にも必ず怒る者がいて、誰の顔も立てない晩というものが無い。
//
// 反対する者を黙らせる方法は用意してある ─ 恐怖と、粛清。
// どちらも効く。効いたぶんだけ、別のものが壊れる。
//
// 扱うのは架空国家の統治である。実在の国も政党も官庁も、ここには無い。

import { clamp } from '../util.js';

/* ------------------------------------------------------------------ */
/* 四つの塊                                                            */
/* ------------------------------------------------------------------ */
//
// 四つに絞ってあるのは、四つなら「誰を取り、誰を捨てたか」を
// 遊び手が覚えていられるからである。八つあれば、それは表になる。

export const BLOCS = Object.freeze({
  army: {
    id: 'army', label: '軍部', post: '参謀総長',
    wants: '兵と弾。そして、仲間を除かれないこと。',
    gives: '段列が動く。補充と砲弾が前線まで届く。',
    fails: '参謀本部が指揮権を引き取った。貴官の署名は、もう要らない。',
  },
  civil: {
    id: 'civil', label: '民政', post: '内務相',
    wants: '法で治めること。恐怖で治めないこと。',
    gives: '役所が動く。救済も配給も、配る者がいて初めて届く。',
    fails: '紙が回らなくなった。徴税も配給も、命令も、どこかの机で止まっている。',
  },
  security: {
    id: 'security', label: '保安', post: '保安相',
    wants: '統制と恐怖。緩めれば、緩めた者を見ている。',
    gives: '放っておいても秩序が保つ。締め直す手間が要らない。',
    fails: '密告の網が向きを変えた。次に名前を書かれるのは貴官である。',
  },
  industry: {
    id: 'industry', label: '産業', post: '蔵相',
    wants: '税は軽く、徴発は控えめに。',
    gives: '国庫に金が入る。工場が回る。',
    fails: '工場が止まり、倉が開かない。金で買えるものが、何も無くなった。',
  },
});

export const BLOC_IDS = Object.freeze(Object.keys(BLOCS));

/** 支持の言葉。数字より段階のほうが早く読める。 */
export const SUPPORT_STAGES = Object.freeze([
  { at: 0, label: '敵対' }, { at: 17, label: '離反' },
  { at: 32, label: '不満' }, { at: 50, label: '容認' },
  { at: 68, label: '支持' }, { at: 84, label: '腹心' },
]);

export function supportStage(v) {
  let out = SUPPORT_STAGES[0].label;
  for (const s of SUPPORT_STAGES) if (v >= s.at) out = s.label;
  return out;
}

/** 開幕の席。実在の人物ではない。 */
const SEATS = Object.freeze({
  army: { name: 'ハルダー', rank: '中将' },
  civil: { name: 'ケレシュ', rank: '博士' },
  security: { name: 'ドルニ', rank: '' },
  industry: { name: 'ヴァイス', rank: '' },
});

/** 除いた席に座る者。名前しか知らない者が来る。 */
const SUCCESSORS = Object.freeze(['ラント', 'ベルク', 'メスナー', 'オルシュ', 'タウベ', 'ヴィルク']);

const START_SUPPORT = Object.freeze({ army: 58, civil: 54, security: 48, industry: 56 });

export function createCouncil() {
  const blocs = {};
  for (const id of BLOC_IDS) {
    blocs[id] = {
      id,
      support: START_SUPPORT[id],
      // 傀儡。前の長官を除いたあとの省庁は、逆らわないかわりに働かない。
      puppet: false,
      minister: { ...SEATS[id] },
    };
  }
  return { blocs, petition: null, lastBloc: null, lastDay: -1, purgedMinisters: [], warned: {}, ledger: [] };
}

/* ------------------------------------------------------------------ */
/* 省庁がどれだけ働いているか                                            */
/* ------------------------------------------------------------------ */

/**
 * 0〜1。支持そのものではなく「その省庁が実際に仕事をしている度合い」。
 *
 * 傀儡の省庁は 0.35〜0.65 で頭打ちになる ─
 * 逆らわないが、有能でもない。粛清で買えるのはそこまでである。
 */
export function blocEffect(b) {
  if (!b) return 0.5;
  const s = clamp((b.support ?? 50) / 100, 0, 1);
  return b.puppet ? 0.35 + s * 0.30 : s;
}

/**
 * 評議会の状態を、国の運営に効く係数へ翻訳する。
 * 指標と同じで、目盛りそのものは飾りである ─ 効くのはこの5つだけ。
 */
export function councilFactors(nation) {
  const c = nation?.council;
  const e = (id) => blocEffect(c?.blocs?.[id]);
  return {
    // 段列。政令で出した弾と人が、実際に前線まで行くか。
    supply: 0.72 + e('army') * 0.56,
    // 税収。取り立て方ではなく、取り立てる役所の側の話。
    revenue: 0.68 + e('industry') * 0.64,
    // 行政。救済も配給も、配る者がいて初めて民心になる。
    admin: 0.66 + e('civil') * 0.68,
    // 握り。統制は放っておけば緩む ─ 緩ませないのが保安部の仕事である。
    grip: e('security'),
    // 士官団への口利き。参謀本部が付いていれば、命令は下まで通る。
    obey: e('army'),
  };
}

/* ------------------------------------------------------------------ */
/* 支持を動かす                                                        */
/* ------------------------------------------------------------------ */

/**
 * 恐怖の高い国では、誰も反対を口に出さない。
 *
 * これが恐怖のもう一つの見返りである ─ 政治的な代償が半分になる。
 * 半分になるのは「下がるぶん」だけで、上がるぶんは上がらない。
 * 恐怖で買えるのは沈黙であって、支持ではない。
 */
export function hushOf(nation) {
  const f = nation?.fear ?? 0;
  if (f >= 0.55) return 0.5;
  if (f >= 0.3) return 0.75;
  return 1;
}

export function shiftSupport(nation, deltas, scale = 1) {
  const c = nation?.council;
  if (!c || !deltas) return;
  const hush = hushOf(nation);
  for (const [id, raw] of Object.entries(deltas)) {
    const b = c.blocs?.[id];
    if (!b) continue;
    // 傀儡の省庁は、褒めても怒っても半分しか動かない。
    const k = b.puppet ? 0.4 : 1;
    const v = raw < 0 ? raw * hush : raw;
    b.support = clamp(b.support + v * scale * k, 0, 100);
  }
}

/* ------------------------------------------------------------------ */
/* 上奏                                                                */
/* ------------------------------------------------------------------ */
//
// 一番不満を溜めている省庁が、夜のうちに一件だけ持ってくる。
// 容れれば彼らは付き、他が離れる。退ければその逆。
// 黙って机に置いたままにすれば、退けたのと同じに受け取られる ─
// 決めないことも決定である。

export const PETITION_LINE = 52;

/** 握り潰したときの目減り。面と向かって断る半分。 */
const IGNORE_SCALE = 0.5;

/** 毎晩、支持が真ん中へ引き戻される強さ。 */
const MEAN_PULL = 0.06;

export const PETITIONS = Object.freeze({
  army: [
    {
      id: 'army_depot', label: '後方の倉を軍の管理下に',
      text:
        '「弾が前線に届くまで四日かかっています。倉を握っているのは我々ではない。' +
        '管理を軍へ移されたい ─ 明日の朝までに」',
      accept: {
        effect: { morale: -3 }, yields: { rounds: 6 },
        support: { army: +15, industry: -12, civil: -6 },
      },
      refuse: { support: { army: -12, industry: +6 } },
    },
    {
      id: 'army_purge_stop', label: '軍への手入れを止められたい',
      text:
        '「前線の中隊長が、司令部からの車を見ると青くなります。' +
        '敵に向ける気力を、後ろを見るのに使わせないでいただきたい」',
      accept: { fear: -0.12, effect: { control: -6 }, support: { army: +17, security: -15 } },
      refuse: { support: { army: -13, security: +8 } },
    },
    {
      id: 'army_command', label: '作戦の細部は前線に任されたい',
      text: '「議長府から時刻まで指定されては、動ける部隊も動けません」',
      accept: { effect: { control: -5, loyalty: +6 }, support: { army: +13, security: -9 } },
      refuse: { effect: { control: +2 }, support: { army: -10 } },
    },
  ],
  civil: [
    {
      id: 'civil_warrant', label: '保安部の令状に、裁判所の署名を要すること',
      text:
        '「昨夜、令状なしで四十一名が連れて行かれました。' +
        '名簿は我々にも回ってきません。法の形だけでも残されたい」',
      accept: { fear: -0.14, effect: { control: -7, morale: +5 }, support: { civil: +16, security: -15 } },
      refuse: { effect: { morale: -3 }, support: { civil: -12, security: +7 } },
    },
    {
      id: 'civil_ration', label: '配給を町にも回されたい',
      text: '「前線に回して残ったぶんでは、冬を越せない郡が三つあります」',
      accept: { cost: 10, effect: { morale: +8 }, heal: 1, support: { civil: +14, army: -9 } },
      refuse: { effect: { morale: -4 }, support: { civil: -11, army: +5 } },
    },
    {
      id: 'civil_names', label: '戦死者の名を公表されたい',
      text:
        '「町の者は、誰が帰ってこないかを知りません。' +
        '知らないままでいさせるほうが、恨みは深くなります」',
      accept: { effect: { morale: -6, control: -4 }, fear: -0.16, support: { civil: +15, security: -12 } },
      refuse: { support: { civil: -11, security: +6 } },
    },
  ],
  security: [
    {
      id: 'sec_emergency', label: '北部三郡に非常措置を認められたい',
      text: '「不穏な集まりが続いています。三郡だけでよい ─ 手を空けていただきたい」',
      accept: {
        effect: { control: +11, morale: -8 }, fear: +0.13, scar: 1,
        support: { security: +16, civil: -13 },
      },
      refuse: { effect: { control: -3 }, support: { security: -12, civil: +7 } },
    },
    {
      id: 'sec_officers', label: '士官の身元をもう一度洗わせていただきたい',
      text: '「前の戦で下がった中隊が三つ。下がった理由を、我々は知りたい」',
      accept: { effect: { control: +7, loyalty: -9 }, fear: +0.16, support: { security: +15, army: -14 } },
      refuse: { support: { security: -12, army: +8 } },
    },
    {
      id: 'sec_press', label: '前線の写真を差し止められたい',
      text: '「橋の写真が新聞に出ました。あれを見て志願する者はいません」',
      accept: { effect: { control: +5, morale: +3 }, fear: +0.12, support: { security: +12, civil: -10 } },
      refuse: { effect: { morale: -3 }, support: { security: -10, civil: +6 } },
    },
  ],
  industry: [
    {
      id: 'ind_tax', label: '鉱山を増税の対象から外されたい',
      text: '「坑夫が逃げています。取り立てるほど、掘れる量が減ります」',
      accept: { cost: 12, effect: { morale: +2 }, support: { industry: +15, civil: -8 } },
      refuse: { support: { industry: -12, civil: +5 } },
    },
    {
      id: 'ind_labour', label: '工場から人を抜かれるのを止められたい',
      text: '「旋盤に立てる者が、もう工場に残っていません。銃は人が作ります」',
      accept: { effect: { morale: +4 }, yields: { rounds: 4 }, support: { industry: +16, army: -13 } },
      refuse: { support: { industry: -13, army: +8 } },
    },
    {
      id: 'ind_price', label: '公定価格を解かれたい',
      text: '「この値では作れば作るほど損をします。誰も作りません」',
      accept: { cost: 8, effect: { morale: -6 }, scar: 1, support: { industry: +14, civil: -11 } },
      refuse: { support: { industry: -11, civil: +6 } },
    },
  ],
});

export function findPetition(bloc, id) {
  return (PETITIONS[bloc] ?? []).find((p) => p.id === id) ?? null;
}

/**
 * その晩の上奏を決める。
 *
 * 賽は振らない ─ 一番不満を溜めている省庁が持ってくるだけである。
 * 誰が来るかは、貴官が前の晩に何をしたかで決まっている。
 */
export function ensurePetition(nation, day) {
  const c = nation?.council;
  if (!c) return null;
  if (c.petition && c.petition.day === day) return c.petition.bloc ? c.petition : null;

  let worst = null;
  for (const id of BLOC_IDS) {
    const b = c.blocs[id];
    // 傀儡の省庁は上奏しない。言うべきことのある者は、もういない。
    if (!b || b.puppet || b.support >= PETITION_LINE) continue;
    // 昨夜持ってきた省庁は、続けては来ない。
    //
    // 一番低い者が毎晩来る作りにしていたとき、握り潰し続けるだけで
    // 同じ一つが必ず 0 まで落ちた ─ 何もしないことが、選べない自滅になっていた。
    // 一度断られた側は、次の晩は黙って様子を見る。
    //
    // 「昨夜」であることが要る。日付を見ずに id だけを覚えていたときは、
    // 一度上奏した省庁が二度と来なくなった ─ 誰も上奏しない晩に札が
    // 外れないので、戦役を通して上奏が一件しか立たなかった。
    if (id === c.lastBloc && c.lastDay === day - 1) continue;
    if (!worst || b.support < c.blocs[worst].support) worst = id;
  }
  if (!worst) {
    c.petition = { day, bloc: null };
    return null;
  }
  const list = PETITIONS[worst] ?? [];
  if (!list.length) {
    c.petition = { day, bloc: null };
    return null;
  }
  const p = list[(day + c.purgedMinisters.length) % list.length];
  c.petition = { day, bloc: worst, id: p.id, answered: null };
  c.lastBloc = worst;
  c.lastDay = day;
  return c.petition;
}

/**
 * 上奏に答える。
 * @param {boolean} accept 容れるなら true、退けるなら false
 */
export function answerPetition(nation, accept) {
  const c = nation?.council;
  const cur = c?.petition;
  if (!cur?.bloc || cur.answered) return null;
  const p = findPetition(cur.bloc, cur.id);
  if (!p) return null;
  const side = accept ? p.accept : p.refuse;

  if (side.cost) {
    if (nation.treasury < side.cost) return { ok: false, why: '国庫が足りない' };
    nation.treasury = Math.max(0, nation.treasury - side.cost);
  }
  for (const [k, v] of Object.entries(side.effect ?? {})) nation[k] = clamp(nation[k] + v, 0, 100);
  if (side.fear) nation.fear = clamp(nation.fear + side.fear, 0, 1);
  if (side.scar) nation.scars = (nation.scars ?? 0) + side.scar;
  if (side.heal) nation.scars = Math.max(0, (nation.scars ?? 0) - side.heal * 0.5);
  if (side.yields) {
    // 容れたものは今夜の戦闘に間に合う。上奏は貴官の思いつきではなく、
    // 向こうが段取りを済ませて持ってきた話だからである。
    nation.pending ??= { replacements: 0, rounds: 0, quality: 0 };
    nation.pending.replacements += side.yields.replacements ?? 0;
    nation.pending.rounds += side.yields.rounds ?? 0;
  }
  shiftSupport(nation, side.support);

  cur.answered = accept ? 'accept' : 'refuse';
  c.ledger.push({ day: cur.day, bloc: cur.bloc, id: cur.id, label: p.label, answered: cur.answered });
  return { ok: true, accepted: accept, petition: p };
}

/* ------------------------------------------------------------------ */
/* 長官を除く                                                          */
/* ------------------------------------------------------------------ */

export function ministerPurgeCost(nation, blocId) {
  const b = nation?.council?.blocs?.[blocId];
  if (!b || b.puppet) return null;
  return {
    control: +7,
    loyalty: -9,
    morale: -4,
    fear: +0.22,
    others: -6,
    scar: 2,
  };
}

/**
 * 省庁の長官を除き、逆らわない者を座らせる。
 *
 * これで通告は止まる ─ 傀儡の省庁は牙を持たない。
 * かわりにその省庁は二度と有能にならないし、他の三つは
 * 「次は自分だ」と考えはじめる。
 */
export function purgeMinister(nation, blocId, day = 0) {
  const c = nation?.council;
  const b = c?.blocs?.[blocId];
  if (!b || b.puppet) return null;
  const cost = ministerPurgeCost(nation, blocId);
  const before = { ...b.minister };

  b.puppet = true;
  b.support = clamp(Math.max(b.support, 42), 0, 100);
  c.warned[blocId] = false;
  b.minister = { name: SUCCESSORS[c.purgedMinisters.length % SUCCESSORS.length], rank: '' };

  c.purgedMinisters.push({
    bloc: blocId, blocLabel: BLOCS[blocId].label, post: BLOCS[blocId].post,
    name: before.name, rank: before.rank, day,
  });

  nation.control = clamp(nation.control + cost.control, 0, 100);
  nation.loyalty = clamp(nation.loyalty + cost.loyalty, 0, 100);
  nation.morale = clamp(nation.morale + cost.morale, 0, 100);
  nation.fear = clamp(nation.fear + cost.fear, 0, 1);
  nation.scars = (nation.scars ?? 0) + cost.scar;

  // 残る三つは、次に誰の名が書かれるかを考えはじめる。
  // ここは恐怖で薄めない ─ 恐怖の出どころが、まさにこれだからである。
  for (const id of BLOC_IDS) {
    if (id === blocId) continue;
    const o = c.blocs[id];
    if (!o || o.puppet) continue;
    o.support = clamp(o.support + cost.others, 0, 100);
  }

  return { cost, removed: before, replacement: { ...b.minister } };
}

/* ------------------------------------------------------------------ */
/* 一晩を締める                                                        */
/* ------------------------------------------------------------------ */

/**
 * 夜が明けるまでに評議会の側で起きること。
 * applyDecrees から一度だけ呼ばれる。
 */
export function settleCouncil(nation) {
  const c = nation?.council;
  const notes = [];
  if (!c) return { notes };

  // 握り潰された上奏は、退けたものとして数えられる。
  const cur = c.petition;
  if (cur?.bloc && !cur.answered) {
    const p = findPetition(cur.bloc, cur.id);
    if (p) {
      // 握り潰しは、面と向かって断るより軽い。
      // 相手は「駄目だ」と言われたのではなく、返事が無かっただけである。
      shiftSupport(nation, p.refuse.support, IGNORE_SCALE);
      notes.push(`${BLOCS[cur.bloc].label}の上奏は、机の上に置かれたままになった。`);
    }
    cur.answered = 'ignored';
  }

  // 一晩の令で永久に縛れはしない。放っておけば真ん中へ引き戻される ─
  // 引く力は離れているほど強い。そうでないと、政令を出さない晩が
  // 続いただけで一番低い省庁が底まで落ちた。
  for (const id of BLOC_IDS) {
    const b = c.blocs[id];
    if (!b) continue;
    b.support = clamp(b.support + (50 - b.support) * MEAN_PULL, 0, 100);
  }

  // 統制は放っておけば緩む。緩ませないのが保安部の仕事である ─
  // その保安部が離れていれば、締めた統制は毎晩こぼれていく。
  const grip = blocEffect(c.blocs.security);
  nation.control = clamp(nation.control + (grip - 0.5) * 8, 0, 100);

  return { notes };
}

/* ------------------------------------------------------------------ */
/* 評議会を離れるとき                                                   */
/* ------------------------------------------------------------------ */
//
// 賽ではなく期限である。線を割った晩に告げ、次の朝までに戻せば助かる。
// 指標の造反・内乱と同じ作法にしてある ─
// 終わり方が四つ増えるが、どれも「何をしたからこうなった」を辿れる。

export const BLOC_LINE = 16;

export function checkCouncil(nation) {
  const c = nation?.council;
  if (!c) return { collapse: null, notices: [] };
  c.warned ??= {};
  const notices = [];

  for (const id of BLOC_IDS) {
    const b = c.blocs[id];
    // 傀儡は牙を持たない。粛清で買えるのは、この一行である。
    if (!b || b.puppet) { c.warned[id] = false; continue; }
    if (c.warned[id]) {
      if (b.support <= BLOC_LINE) {
        return {
          collapse: {
            id: `bloc_${id}`,
            label: `${BLOCS[id].label}の離反`,
            reason: BLOCS[id].fails,
          },
          notices,
        };
      }
      c.warned[id] = false;
      notices.push(`${BLOCS[id].label}は矛を収めた。支持は線の上に戻っている。`);
    }
  }

  for (const id of BLOC_IDS) {
    const b = c.blocs[id];
    if (!b || b.puppet || c.warned[id]) continue;
    if (b.support <= BLOC_LINE) {
      c.warned[id] = true;
      notices.push(
        `${BLOCS[id].label}が評議会を離れる構えを見せている。` +
        `次の戦闘の翌朝が期限である ─ ${BLOCS[id].fails}`
      );
    }
  }

  return { collapse: null, notices };
}

/** 今どの省庁に通告が出ているか（画面に赤く出すため） */
export function councilWarnings(nation) {
  const c = nation?.council;
  if (!c?.warned) return [];
  return BLOC_IDS.filter((id) => c.warned[id] && !c.blocs[id]?.puppet).map((id) => ({
    id: `bloc_${id}`,
    label: `${BLOCS[id].label}の離反通告`,
    note: BLOCS[id].fails,
  }));
}

/* ------------------------------------------------------------------ */
/* 保存                                                                */
/* ------------------------------------------------------------------ */

export function deserializeCouncil(raw) {
  const base = createCouncil();
  if (!raw) return base;
  const blocs = {};
  for (const id of BLOC_IDS) blocs[id] = { ...base.blocs[id], ...(raw.blocs?.[id] ?? {}) };
  return {
    blocs,
    petition: raw.petition ?? null,
    lastBloc: raw.lastBloc ?? null,
    lastDay: raw.lastDay ?? -1,
    purgedMinisters: raw.purgedMinisters ?? [],
    warned: raw.warned ?? {},
    ledger: raw.ledger ?? [],
  };
}
