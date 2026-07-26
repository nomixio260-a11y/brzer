// 無線ログ。届いた順に積み上げるだけ。ここが指揮官の唯一の情報源。

import { formatClock } from '../util.js';

const KIND_CLASS = {
  order: 'is-out',
  hq: 'is-hq',
  system: 'is-system',
};

export function createRadioLog(el) {
  return { el, rendered: 0, pinned: true };
}

/** 新しく届いた分だけ追記する */
export function appendEntries(view, entries) {
  if (!entries.length) return;

  const nearBottom = view.el.scrollHeight - view.el.scrollTop - view.el.clientHeight < 60;

  for (const entry of entries) {
    view.el.appendChild(renderEntry(entry));
  }

  // 古すぎるものは捨てる（長時間プレイでも DOM が膨らまないように）
  while (view.el.childElementCount > 260) view.el.removeChild(view.el.firstChild);

  if (nearBottom || view.pinned) {
    view.el.scrollTop = view.el.scrollHeight;
  }
}

function renderEntry(entry) {
  const li = document.createElement('li');

  const cls = KIND_CLASS[entry.kind];
  if (cls) li.classList.add(cls);
  if (entry.outbound) li.classList.add('is-out');
  if (entry.priority >= 2 && !entry.outbound) li.classList.add('is-flash');
  if (entry.garbled) li.classList.add('is-garbled');
  if (entry.lost) li.classList.add('is-lost');

  const head = document.createElement('div');
  head.className = 'radiolog__head';

  const time = document.createElement('span');
  time.className = 'radiolog__time';
  time.textContent = formatClock(entry.at);

  const from = document.createElement('span');
  from.className = 'radiolog__from';
  from.textContent = entry.outbound ? `指揮所 →` : entry.from;

  head.append(time, from);

  // 「いつ見た情報か」。古い報告に振り回されないための唯一の手がかり。
  // ただし毎行に出すと読めなくなるので、実際に古いものだけに付ける。
  const lag = entry.at - (entry.observedAt ?? entry.at);
  if (lag >= 75 && !entry.outbound) {
    const l = document.createElement('span');
    l.className = 'radiolog__lag';
    l.textContent = `${Math.round(lag / 60)}分前の情報`;
    head.appendChild(l);
  }

  const text = document.createElement('div');
  text.className = 'radiolog__text';
  text.textContent = entry.text;

  li.append(head, text);
  return li;
}

export function clearLog(view) {
  view.el.innerHTML = '';
  view.rendered = 0;
}
