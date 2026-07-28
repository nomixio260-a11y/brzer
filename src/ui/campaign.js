// 戦役の管理画面 ─ 夜のうちにやること。
//
// 補充を誰に入れ、弾を何に回し、分派をどの分隊に付け、一晩をどう使うか。
// 前線の様子は見えないままだが、自分の中隊の帳簿は見える ─
// 点呼を取れば分かることまで隠すのは、霧ではなく嫌がらせである。
//
// この画面は state.js の getCampaignView / getCompany しか読まない。

import { symbolChip } from './symbolchip.js';

const ATTACH_ORDER = ['mg', 'at', 'eng', 'fo', 'medic', 'relay'];

/**
 * @param {object} dom  {title, sub, day, prologue, frontFill, frontValue,
 *                       company, allot, night, history, historyBlock, result, sortie}
 * @param {object} view getCampaignView の結果
 * @param {Array}  rows getCompany の結果
 * @param {object} api  {assets, attachments, onAssign, onAllot, onNight, onAttach, onDetach}
 */
export function renderCampaign(dom, view, rows, api) {
  dom.title.textContent = view.title;
  dom.sub.textContent = `${view.subtitle} ／ ${view.stageIndex + 1} / ${view.stageCount} 日目`;

  const pct = Math.round((view.front / view.frontMax) * 100);
  dom.frontFill.style.width = `${pct}%`;
  dom.frontFill.classList.toggle('is-low', view.front <= 22);
  dom.frontValue.textContent = String(Math.round(view.front));

  if (view.finished) {
    dom.day.textContent = '戦役 終わり';
    dom.prologue.textContent = view.resultReason ?? '';
  } else if (view.stage) {
    dom.day.textContent = `${view.stage.day} ─ ${view.stage.title}`;
    dom.prologue.textContent = view.stage.prologue;
  }

  // 国の要点。前線の画面にも出す ─ 前線と国は別の話ではない。
  if (dom.nation && view.nation) {
    const n = view.nation;
    dom.nation.hidden = false;
    dom.nation.innerHTML =
      `<span>民心 <b>${n.morale}</b></span>` +
      `<span>統制 <b>${n.control}</b></span>` +
      `<span>忠誠 <b class="${n.loyalty <= 28 ? 'is-bad' : ''}">${n.loyalty}</b></span>` +
      `<span>国庫 <b>${n.treasury}</b></span>` +
      `<span class="natstrip__decree">今夜の政令 ${n.decrees}/${n.limit}</span>` +
      // 評議会で誰が怒っているかは、国政の画面を開く理由になる。
      (n.angry ? `<span class="natstrip__angry">${n.angry.label} ${n.angry.stage}</span>` : '') +
      (n.petition ? `<span class="natstrip__pet">${n.petition}の上奏 未決</span>` : '') +
      (n.alarms ? `<span class="natstrip__alarm">通告 ${n.alarms}</span>` : '');
  } else if (dom.nation) {
    dom.nation.hidden = true;
  }

  renderCompany(dom.company, rows, view, api);
  renderAllot(dom.allot, view, api);
  renderNight(dom.night, view, api);
  renderHistory(dom.history, view);
  dom.historyBlock.hidden = view.history.length === 0;
}

/* ------------------------------------------------------------------ */
/* 中隊                                                                */
/* ------------------------------------------------------------------ */

function renderCompany(el, rows, view, api) {
  el.innerHTML = '';
  for (const r of rows) {
    el.appendChild(unitCard(r, view, api));
  }
}

function unitCard(r, view, api) {
  const card = document.createElement('div');
  card.className = 'unitcard';
  card.dataset.unit = r.id;
  if (r.dead) card.classList.add('is-dead');
  if (!r.present) card.classList.add('is-absent');

  // --- 見出し ------------------------------------------------------
  const head = document.createElement('div');
  head.className = 'unitcard__head';
  if (r.icon) {
    head.appendChild(symbolChip({ icon: r.icon, echelon: r.echelon, affiliation: 'friend', _size: 28 }));
  }

  const name = document.createElement('div');
  name.className = 'unitcard__name';
  const cs = document.createElement('b');
  cs.textContent = r.callsign;
  const role = document.createElement('span');
  role.textContent = r.present ? (r.role ?? '') : '本日は編成外';
  name.append(cs, role);
  head.appendChild(name);

  const str = document.createElement('div');
  str.className = 'unitcard__str';
  str.innerHTML = r.dead
    ? '<b class="is-bad">壊滅</b><span>再編が要る</span>'
    : `<b>${r.strength}<i>/${r.maxStrength}</i></b><span>${r.wounded > 0 ? `負傷 ${r.wounded}` : '欠員なし'}</span>`;
  head.appendChild(str);
  card.appendChild(head);

  // --- 将校 --------------------------------------------------------
  if (r.officer) {
    const off = document.createElement('div');
    off.className = 'unitcard__officer';
    const who = document.createElement('b');
    who.textContent = `${r.officer.name} ${r.officer.rank}`;
    const temp = document.createElement('span');
    temp.className = 'tempchip';
    temp.textContent = r.officer.temperamentLabel;
    temp.title = r.officer.temperamentNote;
    off.append(who, temp);
    for (const t of r.officer.traits) {
      const chip = document.createElement('span');
      chip.className = 'traitchip';
      chip.textContent = t.label;
      chip.title = t.note;
      off.appendChild(chip);
    }
    if (r.officer.grade && r.officer.battles > 0) {
      const g = document.createElement('span');
      g.className = 'gradechip';
      g.textContent = r.officer.grade;
      g.title = `${r.officer.battles}戦 ／ 与えた損害 ${r.officer.kills}`;
      off.appendChild(g);
    }
    card.appendChild(off);
  }

  // --- 数字 --------------------------------------------------------
  const bars = document.createElement('div');
  bars.className = 'unitcard__bars';
  bars.appendChild(meter('士気', r.morale / 100, moraleJa(r.morale)));
  bars.appendChild(meter('弾薬', r.ammoRatio, `${Math.round(r.ammoRatio * 100)}%`));
  bars.appendChild(meter('疲労', 1 - Math.min(1, r.fatigue / 400), fatigueJa(r.fatigue), true));
  card.appendChild(bars);

  // --- 補充 --------------------------------------------------------
  const fill = document.createElement('div');
  fill.className = 'unitcard__fill';
  const label = document.createElement('span');
  label.className = 'unitcard__filllabel';
  label.textContent = '補充';
  const minus = stepBtn('−', () => api.onAssign(r.id, r.assigned - 1));
  const val = document.createElement('b');
  val.className = 'unitcard__fillval';
  val.textContent = String(r.assigned);
  const plus = stepBtn('＋', () => api.onAssign(r.id, r.assigned + 1));
  minus.disabled = r.assigned <= 0;
  plus.disabled = r.assigned >= r.room || view.left.replacements <= 0;
  minus.dataset.assign = `${r.id}:-`;
  plus.dataset.assign = `${r.id}:+`;
  const room = document.createElement('span');
  room.className = 'unitcard__room';
  room.textContent = r.room > 0 ? `あと${r.room}名まで` : '定員';
  fill.append(label, minus, val, plus, room);
  card.appendChild(fill);

  // --- 分派 --------------------------------------------------------
  // 付けられるものが一つも無い兵科（無人機など）では、行そのものを出さない。
  const fitting = ATTACH_ORDER.filter((id) => api.attachments[id]?.fit.includes(r.unitType));
  if (r.present && !r.dead && fitting.length) {
    const att = document.createElement('div');
    att.className = 'unitcard__attach';
    const t = document.createElement('span');
    t.className = 'unitcard__filllabel';
    t.textContent = '分派';
    att.appendChild(t);

    for (const id of fitting) {
      const spec = api.attachments[id];
      if (!spec) continue;
      const on = (api.attachOf(r.id) ?? []).includes(id);
      const left = api.assetsLeft[id] ?? 0;
      const can = api.canAttach(r.id, id, r.unitType);

      const b = document.createElement('button');
      b.className = 'attachchip';
      b.dataset.attach = `${r.id}:${id}`;
      b.classList.toggle('is-on', on);
      b.textContent = spec.short;
      b.title = on
        ? `${spec.label} ─ 外す\n${spec.note}`
        : `${spec.label}（残${left}）\n${spec.note}${can.ok ? '' : `\n付けられない: ${can.why}`}`;
      b.disabled = !on && !can.ok;
      b.addEventListener('click', () => (on ? api.onDetach(r.id, id) : api.onAttach(r.id, id, r.unitType)));
      att.appendChild(b);
    }
    card.appendChild(att);
  }

  return card;
}

function stepBtn(text, fn) {
  const b = document.createElement('button');
  b.className = 'stepbtn';
  b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}

function meter(label, ratio, text, invert = false) {
  const d = document.createElement('div');
  d.className = 'meter';
  const l = document.createElement('span');
  l.className = 'meter__label';
  l.textContent = label;
  const track = document.createElement('span');
  track.className = 'meter__track';
  const fill = document.createElement('i');
  fill.className = 'meter__fill';
  const r = Math.max(0, Math.min(1, ratio));
  fill.style.width = `${Math.round(r * 100)}%`;
  if (r < 0.4) fill.classList.add(invert ? 'is-bad' : 'is-bad');
  track.appendChild(fill);
  const v = document.createElement('span');
  v.className = 'meter__value';
  v.textContent = text;
  d.append(l, track, v);
  return d;
}

function moraleJa(m) {
  if (m >= 75) return '良好';
  if (m >= 55) return 'やや低下';
  if (m >= 35) return '動揺';
  return '危険';
}

function fatigueJa(f) {
  if (f < 60) return '良好';
  if (f < 160) return 'やや疲労';
  if (f < 280) return '疲労';
  return '消耗';
}

/* ------------------------------------------------------------------ */
/* 手持ち                                                              */
/* ------------------------------------------------------------------ */

function renderAllot(el, view, api) {
  el.innerHTML = '';

  const men = document.createElement('div');
  men.className = 'allot__row';
  men.innerHTML =
    `<span class="allot__label">補充兵</span>` +
    `<b class="allot__val">${view.left.replacements}<i> / ${view.pool.replacements}</i></b>` +
    `<span class="allot__note">各分隊の「補充」で配る。配らなかったぶんは明日へ残る。</span>`;
  el.appendChild(men);

  const kinds = [
    { key: 'rounds', label: '砲弾', note: '効力射・制圧射に使う' },
    { key: 'smoke', label: '発煙弾', note: '渡らせない・退がらせる' },
    { key: 'illum', label: '照明弾', note: '夜明け前の戦闘では弾より効く' },
  ];
  for (const k of kinds) {
    const row = document.createElement('div');
    row.className = 'allot__row';
    const l = document.createElement('span');
    l.className = 'allot__label';
    l.textContent = k.label;
    const minus = stepBtn('−', () => api.onAllot(k.key, view.allot[k.key] - 1));
    const v = document.createElement('b');
    v.className = 'allot__val';
    v.textContent = `+${view.allot[k.key]}`;
    const plus = stepBtn('＋', () => api.onAllot(k.key, view.allot[k.key] + 1));
    minus.dataset.allot = `${k.key}:-`;
    plus.dataset.allot = `${k.key}:+`;
    minus.disabled = view.allot[k.key] <= 0;
    plus.disabled = view.left.rounds <= 0;
    const note = document.createElement('span');
    note.className = 'allot__note';
    note.textContent = k.note;
    row.append(l, minus, v, plus, note);
    el.appendChild(row);
  }

  const left = document.createElement('div');
  left.className = 'allot__row allot__row--total';
  left.innerHTML =
    `<span class="allot__label">段列の残り</span>` +
    `<b class="allot__val">${view.left.rounds}<i> / ${view.pool.rounds}</i></b>` +
    `<span class="allot__note">明日の戦闘に上乗せされる。持ち越せるので、無理に使い切らなくてよい。</span>`;
  el.appendChild(left);

  // 分派の手持ち
  const assets = document.createElement('div');
  assets.className = 'assets';
  const head = document.createElement('span');
  head.className = 'allot__label';
  head.textContent = '分派';
  assets.appendChild(head);
  for (const id of ATTACH_ORDER) {
    const spec = api.attachments[id];
    const have = api.assets[id] ?? 0;
    if (!have) continue;
    const chip = document.createElement('span');
    chip.className = 'assetchip';
    chip.classList.toggle('is-out', (api.assetsLeft[id] ?? 0) <= 0);
    chip.textContent = `${spec.label} ${api.assetsLeft[id] ?? 0}/${have}`;
    chip.title = spec.note;
    assets.appendChild(chip);
  }
  if (assets.childElementCount <= 1) {
    const none = document.createElement('span');
    none.className = 'allot__note';
    none.textContent = '大隊から借りているものは無い。';
    assets.appendChild(none);
  }
  el.appendChild(assets);
}

/* ------------------------------------------------------------------ */
/* 今夜                                                                */
/* ------------------------------------------------------------------ */

function renderNight(el, view, api) {
  el.innerHTML = '';
  for (const n of view.nights) {
    const b = document.createElement('button');
    b.className = 'nightopt';
    b.dataset.night = n.id;
    b.classList.toggle('is-on', view.night === n.id);
    const t = document.createElement('b');
    t.textContent = n.label;
    const note = document.createElement('em');
    note.textContent = n.note;
    b.append(t, note);
    b.addEventListener('click', () => api.onNight(n.id));
    el.appendChild(b);
  }
}

/* ------------------------------------------------------------------ */
/* これまで                                                            */
/* ------------------------------------------------------------------ */

const OUTCOME_JA = { victory: '任務達成', narrow: '辛勝', defeat: '任務失敗' };

function renderHistory(el, view) {
  el.innerHTML = '';
  for (const h of view.history) {
    const li = document.createElement('li');
    li.className = `camphistory__item is-${h.outcome}`;
    const head = document.createElement('div');
    head.className = 'camphistory__head';
    head.innerHTML =
      `<b>${h.day} ${h.title}</b>` +
      `<span class="camphistory__verdict">${OUTCOME_JA[h.outcome] ?? h.outcome}</span>` +
      `<span class="camphistory__num">損害 ${h.losses} ／ 敵 ${h.enemyLosses} ／ 戦線 ${h.front}</span>`;
    li.appendChild(head);

    if (h.epilogue) {
      const p = document.createElement('p');
      p.className = 'camphistory__note';
      p.textContent = h.epilogue;
      li.appendChild(p);
    }
    for (const t of h.traits ?? []) {
      const p = document.createElement('p');
      p.className = 'camphistory__trait';
      p.textContent = `${t.name} ${t.rank} ─ 「${t.label}」 ${t.note}`;
      li.appendChild(p);
    }
    el.appendChild(li);
  }
}
