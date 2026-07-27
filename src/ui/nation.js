// 国政の画面 ─ 議長府の机の上。
//
// 前線は見えない。だが自分の国のことは分かる ─
// 国庫に幾ら残っているかも、どの町が焼けたかも、この机の上にある。
// 見えないのは、その決定が前線で何を起こすかだけである。
//
// この画面は state.js の getNationView / getOfficerCorps しか読まない。

const METER_COLOR = {
  morale: 'is-morale',
  control: 'is-control',
  loyalty: 'is-loyalty',
};

/**
 * @param {object} dom {meters, treasury, fear, output, decrees, standing, corps,
 *                      left, rule}
 * @param {object} view getNationView の結果
 * @param {Array}  corps getOfficerCorps の結果
 * @param {object} api  {onPick, onUnpick, onLift, onPurge, onDecorate}
 */
export function renderNation(dom, view, corps, api) {
  renderMeters(dom.meters, view);
  dom.treasury.textContent = String(view.treasury);
  dom.fear.textContent = view.fearJa;
  dom.fear.className = `fearline is-f${Math.min(4, Math.floor(view.fear * 5))}`;
  dom.output.textContent =
    `見込み ─ 補充 ${view.output.replacements}名 ／ 砲弾 ${view.output.rounds}発`;
  dom.left.textContent = `今夜あと ${view.left} 件`;

  renderDecrees(dom.decrees, view, api);
  renderStanding(dom.standing, view, api);
  renderCorps(dom.corps, corps, api);
  renderRule(dom.rule, view);
}

/* ------------------------------------------------------------------ */
/* 指標                                                                */
/* ------------------------------------------------------------------ */

function renderMeters(el, view) {
  el.innerHTML = '';
  for (const m of view.meters) {
    const row = document.createElement('div');
    row.className = 'natmeter';
    row.dataset.meter = m.id;
    row.title = m.note;

    const label = document.createElement('span');
    label.className = 'natmeter__label';
    label.textContent = m.label;

    const track = document.createElement('span');
    track.className = 'natmeter__track';
    const fill = document.createElement('i');
    fill.className = `natmeter__fill ${METER_COLOR[m.id] ?? ''}`;
    fill.style.width = `${Math.max(0, Math.min(100, m.value))}%`;
    if (m.value <= 22) fill.classList.add('is-low');
    track.appendChild(fill);

    const val = document.createElement('b');
    val.className = 'natmeter__value';
    val.textContent = String(m.value);
    if (m.value <= 22) val.classList.add('is-low');

    // 段階の語。造反や内乱の一歩手前に名前があると、帰結が突然でなくなる。
    const stage = document.createElement('span');
    stage.className = 'natmeter__stage';
    stage.textContent = m.stage ?? '';
    if (m.value <= 28) stage.classList.add('is-low');

    row.append(label, track, val, stage);
    el.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* 政令                                                                */
/* ------------------------------------------------------------------ */

const EFFECT_JA = { morale: '民心', control: '統制', loyalty: '忠誠' };

function renderDecrees(el, view, api) {
  el.innerHTML = '';
  for (const g of view.groups) {
    const block = document.createElement('div');
    block.className = 'decreegroup';

    const h = document.createElement('div');
    h.className = 'decreegroup__head';
    h.textContent = g.label;
    block.appendChild(h);

    for (const d of g.items) {
      block.appendChild(decreeCard(d, view, api));
    }
    el.appendChild(block);
  }
}

function decreeCard(d, view, api) {
  const b = document.createElement('button');
  b.className = 'decree';
  b.dataset.decree = d.id;
  b.classList.toggle('is-on', d.picked);
  b.classList.toggle('is-active', d.active);
  b.disabled = !d.picked && !d.can;

  const head = document.createElement('div');
  head.className = 'decree__head';
  const t = document.createElement('b');
  t.textContent = d.label;
  head.appendChild(t);
  if (d.keep) {
    const k = document.createElement('span');
    k.className = 'decree__keep';
    k.textContent = '継続';
    k.title = '一度敷けば、解くまで効き続ける';
    head.appendChild(k);
  }
  const cost = document.createElement('span');
  cost.className = 'decree__cost';
  cost.textContent = d.cost >= 0 ? `国庫 −${d.cost}` : `国庫 ＋${-d.cost}`;
  if (d.cost < 0) cost.classList.add('is-gain');
  head.appendChild(cost);
  b.appendChild(head);

  const note = document.createElement('em');
  note.textContent = d.active ? `施行中。${d.note}` : d.can || d.picked ? d.note : `${d.note}（${d.why}）`;
  b.appendChild(note);

  const tags = document.createElement('div');
  tags.className = 'decree__tags';
  for (const [k, v] of Object.entries(d.effect)) {
    const s = document.createElement('span');
    s.className = `dtag ${v >= 0 ? 'is-up' : 'is-down'}`;
    s.textContent = `${EFFECT_JA[k] ?? k} ${v >= 0 ? '+' : ''}${v}`;
    tags.appendChild(s);
  }
  if (d.yields.replacements) {
    const s = document.createElement('span');
    s.className = 'dtag is-yield';
    s.textContent = `補充 +${d.yields.replacements}`;
    tags.appendChild(s);
  }
  if (d.yields.rounds) {
    const s = document.createElement('span');
    s.className = 'dtag is-yield';
    s.textContent = `砲弾 +${d.yields.rounds}`;
    tags.appendChild(s);
  }
  if (d.fear) {
    const s = document.createElement('span');
    s.className = `dtag ${d.fear > 0 ? 'is-fear' : 'is-up'}`;
    s.textContent = d.fear > 0 ? '恐怖 増' : '恐怖 減';
    s.title = '恐怖が高いほど、前線から上がってくる報告が甘くなる';
    tags.appendChild(s);
  }
  b.appendChild(tags);

  b.addEventListener('click', () => (d.picked ? api.onUnpick(d.id) : api.onPick(d.id)));
  return b;
}

function renderStanding(el, view, api) {
  el.innerHTML = '';
  if (!view.standing.length) {
    const p = document.createElement('span');
    p.className = 'allot__note';
    p.textContent = '施行中の令は無い。';
    el.appendChild(p);
    return;
  }
  for (const d of view.standing) {
    const chip = document.createElement('button');
    chip.className = 'standing';
    chip.dataset.lift = d.id;
    chip.innerHTML = `<b>${d.label}</b><span>解く</span>`;
    chip.title = `${d.note}\n押せば解ける（得たものは返す）`;
    chip.addEventListener('click', () => api.onLift(d.id));
    el.appendChild(chip);
  }
}

/* ------------------------------------------------------------------ */
/* 士官団                                                              */
/* ------------------------------------------------------------------ */

function renderCorps(el, corps, api) {
  el.innerHTML = '';
  for (const o of corps) {
    const row = document.createElement('div');
    row.className = 'corps';
    row.dataset.officer = o.unitId;
    if (o.wavering) row.classList.add('is-wavering');

    const who = document.createElement('div');
    who.className = 'corps__who';
    const name = document.createElement('b');
    name.textContent = `${o.name} ${o.rank}`;
    const cs = document.createElement('span');
    cs.className = 'corps__cs';
    cs.textContent = o.callsign;
    who.append(name, cs);

    const temp = document.createElement('span');
    temp.className = 'tempchip';
    temp.textContent = o.temperamentLabel;
    who.appendChild(temp);
    for (const t of o.traits) {
      const c = document.createElement('span');
      c.className = 'traitchip';
      c.textContent = t;
      who.appendChild(c);
    }
    row.appendChild(who);

    const loyal = document.createElement('div');
    loyal.className = 'corps__loyal';
    const track = document.createElement('span');
    track.className = 'natmeter__track';
    const fill = document.createElement('i');
    fill.className = 'natmeter__fill is-loyalty';
    fill.style.width = `${o.loyalty}%`;
    if (o.loyalty <= 28) fill.classList.add('is-low');
    track.appendChild(fill);
    const word = document.createElement('span');
    word.className = 'corps__word';
    word.textContent = o.loyaltyJa;
    if (o.wavering) word.classList.add('is-low');
    loyal.append(track, word);
    row.appendChild(loyal);

    const acts = document.createElement('div');
    acts.className = 'corps__acts';

    const dec = document.createElement('button');
    dec.className = 'tool';
    dec.dataset.decorate = o.unitId;
    dec.textContent = '叙勲';
    dec.title = '忠誠を買う。国庫 −4';
    dec.addEventListener('click', () => api.onDecorate(o.unitId));

    const pur = document.createElement('button');
    pur.className = 'tool tool--purge';
    pur.dataset.purge = o.unitId;
    pur.textContent = '粛清';
    pur.title = o.cost
      ? `除く。統制 +${o.cost.control} ／ 忠誠 ${o.cost.loyalty} ／ 民心 ${o.cost.morale}\n` +
        '経歴も特性も戻らない。代わりに来るのは、忠誠だけは高い者である。'
      : '除く';
    pur.addEventListener('click', () => api.onPurge(o.unitId, o));

    acts.append(dec, pur);
    row.appendChild(acts);
    el.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* 統治の記録                                                          */
/* ------------------------------------------------------------------ */

function renderRule(el, view) {
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'rule__head';
  head.innerHTML = `<b>${view.rule.label}</b><span>${view.rule.note}</span>`;
  el.appendChild(head);

  const nums = document.createElement('div');
  nums.className = 'rule__nums';
  const bits = [
    `政令 ${view.rule.decrees} 件`,
    `粛清 ${view.rule.purged} 名`,
    `叙勲 ${view.rule.decorated} 名`,
  ];
  nums.textContent = bits.join(' ／ ');
  el.appendChild(nums);

  if (view.purged.length) {
    const list = document.createElement('ul');
    list.className = 'purgelist';
    for (const p of view.purged) {
      const li = document.createElement('li');
      // 何日目に、どういう者を除いたか。名前で数える。
      li.textContent =
        `${p.name} ${p.rank}` +
        `（${p.callsign ?? ''}・${p.battles ?? 0}戦` +
        `${p.traits?.length ? `・${p.traits.join('・')}` : ''}）` +
        `${p.day ? ` ${p.day}日目` : ''}`;
      list.appendChild(li);
    }
    const cap = document.createElement('div');
    cap.className = 'rule__nums';
    cap.textContent = '除かれた者';
    el.append(cap, list);
  }
}
