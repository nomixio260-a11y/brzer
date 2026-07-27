// 任務編成 ─ 分派の配属。
//
// 編成表の「歩兵分隊」は、紙の上の話である。
// 実際に線に出るのは、その分隊に何を付けたかで決まる ─
// 機関銃を付ければ動かない代わりに撃ち勝ち、工兵を付ければ穴が深くなる。
//
// 中隊が持っている分派の数は限られている。どの分隊に付けるかを決めるのは、
// 「どこで何をさせるつもりか」を先に決めるということである。
// つまりこれは編成の作業ではなく、企図を数字にする作業である。

/**
 * 分派。
 *
 * mods は掛け算の係数（1.0 が並）。加算ではなく倍率にしてあるのは、
 * 兵種ごとに素の値が二桁違うためである。
 */
export const ATTACHMENTS = Object.freeze({
  mg: {
    id: 'mg', label: '機関銃班', short: '機',
    note: '制圧力が上がる。据えれば強いが、担いで走る部隊ではなくなる。',
    fit: ['infantry', 'mech'],
    mods: { firepower: 1.34, speed: 0.86, ammoDrain: 1.25 },
  },
  at: {
    id: 'at', label: '対戦車小隊', short: '対',
    note: '装甲に対して撃てるようになる。歩兵分隊が戦車の前に立てる。',
    fit: ['infantry', 'mech'],
    mods: { ap: 2.6, speed: 0.92 },
  },
  eng: {
    id: 'eng', label: '工兵班', short: '工',
    note: '穴が深くなり、鉄条網と地雷原を処理できる。掘る時間は要る。',
    fit: ['infantry', 'mech', 'at_team'],
    mods: { cover: 1.18, obstacle: 1.7 },
    breach: true,
  },
  fo: {
    id: 'fo', label: '観測班', short: '観',
    note: '見える範囲が広がり、報告の位置が正確になる。砲兵の目になる。',
    fit: ['infantry', 'recon', 'at_team'],
    mods: { spot: 1.22, accuracy: 1.5 },
    observer: true,
  },
  medic: {
    id: 'medic', label: '衛生班', short: '衛',
    note: '倒れた者が戻ってくる。長い一日ほど効く。',
    fit: ['infantry', 'mech', 'at_team', 'mortar'],
    mods: { care: 1.45 },
  },
  relay: {
    id: 'relay', label: '無線中継班', short: '無',
    note: '谷底でも繋がる。黙って消える部隊が減る。',
    fit: ['infantry', 'recon', 'at_team', 'mortar'],
    mods: { radio: 1.45 },
  },
});

export const ATTACHMENT_IDS = Object.freeze(Object.keys(ATTACHMENTS));

/** 一個の部隊に付けられる分派の数。二つ付ければもう分隊ではない。 */
export const SLOTS_PER_UNIT = 2;

const NEUTRAL = Object.freeze({
  firepower: 1, ap: 1, speed: 1, spot: 1, cover: 1,
  care: 1, radio: 1, ammoDrain: 1, obstacle: 1, accuracy: 1,
});

/** その兵種に付けられる分派か */
export function fits(attachId, unitType) {
  const a = ATTACHMENTS[attachId];
  return !!a && a.fit.includes(unitType);
}

/**
 * 分派を合わせた最終の係数。
 * 部隊に載せたら変わらないので、一度だけ計算して抱えておく。
 */
export function attachmentMods(list) {
  if (!list?.length) return NEUTRAL;
  const m = { ...NEUTRAL };
  for (const id of list) {
    const a = ATTACHMENTS[id];
    if (!a) continue;
    for (const [k, v] of Object.entries(a.mods)) m[k] = (m[k] ?? 1) * v;
  }
  return Object.freeze(m);
}

/** 障害を処理できる部隊か（工兵が付いているか） */
export function canBreach(u) {
  return (u?.attach ?? []).some((id) => ATTACHMENTS[id]?.breach);
}

/** 砲兵の目になれる部隊か（観測班が付いているか） */
export function isObserver(u) {
  return (u?.attach ?? []).some((id) => ATTACHMENTS[id]?.observer);
}

/** 表示用。「機・工」 */
export function attachmentShort(list) {
  return (list ?? []).map((id) => ATTACHMENTS[id]?.short).filter(Boolean).join('・');
}

export function attachmentLabels(list) {
  return (list ?? []).map((id) => ATTACHMENTS[id]?.label).filter(Boolean);
}
