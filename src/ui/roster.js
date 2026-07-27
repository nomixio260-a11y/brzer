// 部隊一覧。
// ここに出るのは「最後に無線で聞いた内容」だけ。今どうなっているかは誰も知らない。

import { getRoster, getSimTime, getRoeOf, getHeldOrder, ROE, VERBS, TRIGGERS } from '../state.js';
import { formatAgo, formatClock } from '../util.js';

// 砲兵・ドローン・段列には交戦規定を与えない（陣地を守る部隊ではない）
const NO_ROE = new Set(['TH', 'EG', 'LD']);

export function createRoster(el, game, onSelect, onJumpToGrid, onMark) {
  const view = { el, game, onSelect, selectedId: null, _sig: '' };
  el.addEventListener('click', (e) => {
    // 記号の札を叩いたら、その部隊の駒を最後に聞いた位置へ置く／動かす
    const mark = e.target.closest('[data-mark-unit]');
    if (mark && onMark) {
      onMark(mark.dataset.markUnit);
      return;
    }
    // 方眼の札を叩いたら、選択ではなく地図へ跳ぶ
    const grid = e.target.closest('[data-grid]');
    if (grid && onJumpToGrid) {
      onJumpToGrid(grid.dataset.grid);
      return;
    }
    const li = e.target.closest('li[data-unit]');
    if (!li) return;
    view.selectedId = li.dataset.unit;
    onSelect(li.dataset.unit);
  });
  return view;
}

export function renderRoster(view) {
  const { game } = view;
  const now = getSimTime(game);
  const rows = getRoster(game);

  // 変化がなければ触らない（毎フレーム DOM を作り直さない）
  const sig = rows
    .map((r) =>
      `${r.unitId}:${r.heard?.heardAt ?? 0}:${r.heard?.pendingOrder?.at ?? 0}` +
      `:${getRoeOf(game, r.unitId)}:${getHeldOrder(game, r.unitId)?.orderId ?? '-'}`)
    .join('|') + `:${view.selectedId}:${Math.floor(now / 15)}`;
  if (sig === view._sig) return;
  view._sig = sig;

  view.el.innerHTML = '';
  for (const row of rows) {
    const li = document.createElement('li');
    li.dataset.unit = row.unitId;

    const heard = row.heard;
    const silentFor = row.silentFor;

    if (view.selectedId === row.unitId) li.classList.add('is-selected');
    if (!heard) li.classList.add('is-silent');
    else {
      if (silentFor > 420) li.classList.add('is-stale');
      if (heard.strengthRatio != null && heard.strengthRatio <= 0.55) li.classList.add('is-hurt');
      if (heard.strengthRatio != null && heard.strengthRatio <= 0.3) li.classList.add('is-critical');
    }

    const top = document.createElement('div');
    top.className = 'roster__top';
    top.innerHTML =
      `<span class="roster__cs">${row.callsign}</span>` +
      (heard
        ? `<button class="roster__grid" data-grid="${heard.grid}" title="この方眼へ跳ぶ">${heard.grid}</button>` +
          `<button class="roster__mark" data-mark-unit="${row.unitId}" ` +
          `title="${row.callsign}の駒を、この位置に置く／動かす">記号</button>`
        : '<span class="roster__grid roster__grid--none">──</span>') +
      `<span class="roster__age">${heard ? formatClock(heard.heardAt) : '交信なし'}</span>`;
    li.appendChild(top);

    // 与えてある交戦規定。届いたかどうかではなく「自分が何を許したか」の控え。
    if (!NO_ROE.has(row.unitId)) {
      const roe = ROE[getRoeOf(game, row.unitId)];
      const tag = document.createElement('span');
      tag.className = `roster__roe roster__roe--${roe.key}`;
      tag.textContent = roe.label;
      tag.title = roe.note;
      top.insertBefore(tag, top.lastElementChild); // 時刻は右端に残す
    }

    // 兵力の帯。数字だけより「あとどれだけ保つか」が掴みやすい。
    if (heard?.strengthRatio != null) {
      const bar = document.createElement('div');
      bar.className = 'roster__bar';
      if (heard.strengthRatio <= 0.3) bar.classList.add('is-critical');
      else if (heard.strengthRatio <= 0.55) bar.classList.add('is-hurt');
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, Math.min(1, heard.strengthRatio)) * 100}%`;
      bar.appendChild(fill);
      li.appendChild(bar);
    }

    const line = document.createElement('div');
    line.className = 'roster__line';
    if (!heard) {
      line.innerHTML = `<span class="roster__unknown">${row.typeLabel} ・${row.role}</span>`;
    } else {
      const parts = [heard.strength, heard.morale, heard.resting ? '休養中' : heard.state];
      if (heard.ammoRatio != null && heard.ammoRatio < 0.12) parts.push('弾薬ほぼ皆無');
      else if (heard.ammoRatio != null && heard.ammoRatio < 0.35) parts.push('弾薬僅少');
      if (heard.fatigue) parts.push(heard.fatigue);
      line.textContent = parts.join(' ／ ');
      if (silentFor > 300) {
        const q = document.createElement('span');
        q.className = 'roster__pending';
        q.textContent = ` ・${formatAgo(silentFor)}から音沙汰なし`;
        line.appendChild(q);
      }
    }
    li.appendChild(line);

    if (heard?.pendingOrder && now - heard.pendingOrder.at < 240) {
      const p = document.createElement('div');
      p.className = 'roster__pending';
      const label = VERBS[heard.pendingOrder.verb]?.label ?? heard.pendingOrder.verb;
      const needsGrid = VERBS[heard.pendingOrder.verb]?.needsTarget;
      p.textContent = `→ ${label}${needsGrid ? ` ${heard.pendingOrder.grid}` : ''}（送信済み）`;
      li.appendChild(p);
    }

    // 渡してある予令。発動していないうちは、ここに載り続ける。
    const held = getHeldOrder(game, row.unitId);
    if (held) {
      const h = document.createElement('div');
      h.className = 'roster__held';
      const when = held.trigger === 'at_time'
        ? formatClock(held.triggerAt)
        : TRIGGERS[held.trigger].label;
      const label = VERBS[held.verb]?.label ?? held.verb;
      const grid = VERBS[held.verb]?.needsTarget ? ` ${held.grid}` : '';
      h.textContent = `予令 ${when} → ${label}${grid}`;
      li.appendChild(h);
    }

    view.el.appendChild(li);
  }
}

export function selectInRoster(view, unitId) {
  view.selectedId = unitId;
  view._sig = '';
}
