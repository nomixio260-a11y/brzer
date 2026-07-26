// 命令パネル。呼出符号 → 命令 → 目標グリッド → 送信。
// 送信した瞬間に届くわけではない。届くかどうかも保証されない。

import { VERBS, MODIFIERS, getRosterOrder, getSupport, toGrid, issueOrder } from '../state.js';

// 部隊ごとに出せる命令は違う。砲兵に「突撃せよ」とは言えない。
const VERBS_BY_UNIT = {
  TH: ['fire_mission', 'smoke', 'sitrep'],
  EG: ['recon', 'move', 'observe', 'sitrep'],
  _default: [
    'move', 'advance', 'attack', 'defend', 'hold', 'observe',
    'recon', 'withdraw', 'rally', 'hold_fire', 'free_fire', 'sitrep',
  ],
};

const MOD_ORDER = ['normal', 'rapid', 'cautious', 'stealth'];

export function createOrderPanel(dom, game, hooks) {
  const panel = {
    game,
    dom,
    hooks, // { onTargetingChange(active), onNotice(text) }
    unitId: null,
    verb: null,
    modifier: 'normal',
    target: null,
  };

  // 部隊ボタン
  for (const u of getRosterOrder()) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.unit = u.id;
    b.textContent = u.callsign;
    b.title = `${u.typeLabel} ─ ${u.role}`;
    dom.units.appendChild(b);
  }

  dom.units.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-unit]');
    if (!b) return;
    selectUnit(panel, b.dataset.unit);
  });

  dom.verbs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-verb]');
    if (!b) return;
    selectVerb(panel, b.dataset.verb);
  });

  dom.mods.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mod]');
    if (!b) return;
    panel.modifier = b.dataset.mod;
    refresh(panel);
  });

  dom.send.addEventListener('click', () => send(panel));

  refresh(panel);
  return panel;
}

export function selectUnit(panel, unitId) {
  if (panel.unitId !== unitId) {
    panel.verb = null;
    panel.target = null;
  }
  panel.unitId = unitId;
  refresh(panel);
}

function selectVerb(panel, verb) {
  panel.verb = verb;
  const spec = VERBS[verb];
  if (spec?.needsTarget) {
    panel.target = null;
    panel.hooks.onTargetingChange(true, verb);
  } else {
    panel.target = null;
    panel.hooks.onTargetingChange(false);
  }
  refresh(panel);
}

/** 地図がクリックされたときに呼ばれる */
export function setTarget(panel, x, y) {
  if (!panel.verb || !VERBS[panel.verb]?.needsTarget) return false;
  panel.target = { x, y };
  panel.hooks.onTargetingChange(false);
  refresh(panel);
  return true;
}

export function isTargeting(panel) {
  return !!panel.verb && !!VERBS[panel.verb]?.needsTarget && !panel.target;
}

function send(panel) {
  if (!canSend(panel)) return;
  const spec = VERBS[panel.verb];
  const order = issueOrder(panel.game, {
    unitId: panel.unitId,
    verb: panel.verb,
    x: spec.needsTarget ? panel.target.x : null,
    y: spec.needsTarget ? panel.target.y : null,
    modifier: panel.modifier,
  });

  if (!order) {
    panel.hooks.onNotice('その命令は出せない。');
    refresh(panel, 'その命令は出せない（弾切れの可能性）。');
    return;
  }

  panel.hooks.onSent?.(order);
  panel.verb = null;
  panel.target = null;
  panel.hooks.onTargetingChange(false);
  refresh(panel, '送信した。応答を待て。');
}

function canSend(panel) {
  if (!panel.unitId || !panel.verb) return false;
  const spec = VERBS[panel.verb];
  if (spec.needsTarget && !panel.target) return false;
  return true;
}

export function refresh(panel, status) {
  const { dom, game } = panel;

  for (const b of dom.units.querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.unit === panel.unitId);
    b.style.background = b.dataset.unit === panel.unitId ? '#4d9de0' : '';
  }

  // 命令ボタン
  const allowed = panel.unitId
    ? VERBS_BY_UNIT[panel.unitId] ?? VERBS_BY_UNIT._default
    : [];
  const wanted = allowed.join(',');
  if (dom.verbs.dataset.for !== `${panel.unitId}:${wanted}`) {
    dom.verbs.dataset.for = `${panel.unitId}:${wanted}`;
    dom.verbs.innerHTML = '';
    for (const v of allowed) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.verb = v;
      b.textContent = VERBS[v].label;
      dom.verbs.appendChild(b);
    }
  }
  for (const b of dom.verbs.querySelectorAll('button')) {
    const on = b.dataset.verb === panel.verb;
    b.classList.toggle('is-on', on);
    b.style.background = on ? '#e0a33c' : '';
  }

  // 態勢
  if (!dom.mods.childElementCount) {
    for (const m of MOD_ORDER) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.mod = m;
      b.textContent = MODIFIERS[m];
      dom.mods.appendChild(b);
    }
  }
  const modsUseful =
    panel.verb &&
    !['sitrep', 'fire_mission', 'smoke', 'hold', 'hold_fire', 'free_fire'].includes(panel.verb);
  dom.mods.style.opacity = modsUseful ? '1' : '0.35';
  for (const b of dom.mods.querySelectorAll('button')) {
    const on = b.dataset.mod === panel.modifier;
    b.classList.toggle('is-on', on);
    b.style.background = on && modsUseful ? '#63c08a' : '';
    b.disabled = !modsUseful;
  }

  dom.grid.textContent = panel.target ? toGrid(panel.target.x, panel.target.y) : '──';
  dom.send.disabled = !canSend(panel);

  dom.status.classList.remove('is-warn');
  if (status) {
    dom.status.textContent = status;
  } else if (!panel.unitId) {
    dom.status.textContent = '部隊を選べ。';
  } else if (!panel.verb) {
    const s = getSupport(game);
    dom.status.textContent =
      panel.unitId === 'TH' ? `ソーン：砲弾${s.artillery}発、発煙${s.smoke}発。命令を選べ。` : '命令を選べ。';
  } else if (VERBS[panel.verb].needsTarget && !panel.target) {
    dom.status.textContent = '地図をクリックして目標を指定せよ。';
    dom.status.classList.add('is-warn');
  } else {
    dom.status.textContent = '送信できる。';
  }
}
