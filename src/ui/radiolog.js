// 通信記録簿。届いた順に積み上げるだけ。ここが指揮官の唯一の情報源。
//
// 体裁は雑談のログではなく、通信記録の様式に寄せてある。
//   時刻 ／ 緊急度 ／ 発信局 ／（いつ見た情報か）
//   本文

import { formatClock } from '../util.js';

const KIND_CLASS = {
  order: 'is-out',
  hq: 'is-hq',
  system: 'is-system',
};

// 電報の緊急度区分。通常便にいちいち印を押さないのは実務と同じ。
const PRECEDENCE = [null, { label: '優先', cls: 'is-priority' }, { label: '至急', cls: 'is-flash' }];

/**
 * @param {HTMLElement} el
 * @param {object} hooks {onCite(entry), onMark(entry)}
 */
export function createRadioLog(el, hooks = {}) {
  const view = { el, pinned: true, hooks, entries: new Map() };

  // 行を叩けば、その報告が指している方眼へ跳ぶ
  el.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-entry]');
    if (!li) return;
    const entry = view.entries.get(li.dataset.entry);
    if (!entry) return;

    if (e.target.closest('[data-act="mark"]')) {
      hooks.onMark?.(entry);
      return;
    }
    if (e.target.closest('[data-act="adjust"]')) {
      hooks.onAdjustFire?.(entry);
      return;
    }
    for (const other of el.querySelectorAll('li.is-cited')) other.classList.remove('is-cited');
    li.classList.add('is-cited');
    hooks.onCite?.(entry);
  });

  return view;
}

/** 新しく届いた分だけ追記する */
export function appendEntries(view, entries) {
  if (!entries.length) return;

  const nearBottom = view.el.scrollHeight - view.el.scrollTop - view.el.clientHeight < 70;
  for (const entry of entries) {
    view.entries.set(entry.id, entry);
    view.el.appendChild(renderEntry(entry));
  }

  // 長時間プレイでも DOM が膨らまないように古いものは捨てる
  while (view.el.childElementCount > 260) {
    const gone = view.el.firstChild;
    view.entries.delete(gone.dataset?.entry);
    view.el.removeChild(gone);
  }

  if (nearBottom || view.pinned) view.el.scrollTop = view.el.scrollHeight;
}

function renderEntry(entry) {
  const li = document.createElement('li');
  li.dataset.entry = entry.id;
  // 方眼を含む報告は、叩けば地図が応える
  if (entry.meta?.grid && !entry.lost) li.dataset.grid = entry.meta.grid;

  const cls = KIND_CLASS[entry.kind];
  if (cls) li.classList.add(cls);
  if (entry.outbound) li.classList.add('is-out');
  if (entry.priority >= 2 && !entry.outbound) li.classList.add('is-flash');
  if (entry.garbled) li.classList.add('is-garbled');
  if (entry.lost) li.classList.add('is-lost');

  const meta = document.createElement('div');
  meta.className = 'msg__meta';

  const time = document.createElement('span');
  time.className = 'msg__time';
  time.textContent = formatClock(entry.at);
  meta.appendChild(time);

  const pre = PRECEDENCE[entry.priority ?? 0];
  if (pre && !entry.outbound) {
    const p = document.createElement('span');
    p.className = `msg__pre ${pre.cls}`;
    p.textContent = pre.label;
    meta.appendChild(p);
  }

  const from = document.createElement('span');
  from.className = 'msg__from';
  from.textContent = entry.outbound ? '指揮所 発' : `${entry.from} 発`;
  meta.appendChild(from);

  // 「いつ見た情報か」。古い報告に振り回されないための唯一の手がかり。
  // 毎行に出すと読めなくなるので、実際に古いものだけに付ける。
  const lag = entry.at - (entry.observedAt ?? entry.at);
  if (lag >= 75 && !entry.outbound) {
    const l = document.createElement('span');
    l.className = 'msg__lag';
    l.textContent = `${Math.round(lag / 60)}分前の状況`;
    meta.appendChild(l);
  }

  const body = document.createElement('p');
  body.className = 'msg__body';
  body.textContent = entry.text;

  li.append(meta, body);

  const acts = document.createElement('div');
  acts.className = 'msg__acts';

  // 敵を報せてきた報告には「聞いたとおりに置く」を用意する。
  // 置かれるのは報告された位置であって、実際の位置ではない。
  if (entry.meta?.reportedX != null && !entry.lost) {
    const mark = document.createElement('button');
    mark.className = 'msg__act';
    mark.dataset.act = 'mark';
    mark.textContent = `▣ ${entry.meta.grid} に記号`;
    acts.appendChild(mark);
  }

  // 観測者が修正を返してきたら、一手で修正射を命じられる。
  // これを容れるかどうかは指揮官の判断（観測者も間違える）。
  if (entry.meta?.correctionGrid && !entry.lost) {
    const adj = document.createElement('button');
    adj.className = 'msg__act msg__act--fire';
    adj.dataset.act = 'adjust';
    adj.textContent = `◎ 修正 ${entry.meta.correctionGrid} へ効力射`;
    acts.appendChild(adj);
  }

  if (acts.childElementCount) li.appendChild(acts);
  return li;
}

export function clearLog(view) {
  view.el.innerHTML = '';
  view.entries.clear();
}
