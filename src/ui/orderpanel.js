// 命令パネル。呼出符号 → 分類 → 命令 → 目標グリッド → 送信。
// 送信した瞬間に届くわけではない。届くかどうかも保証されない。
//
// 命令の数が増えたので、実際の命令書と同じように分類で畳んである。
// 「機動」「火力」「交戦規定」「情報」── 指揮官の頭の中もこの順で動く。

import {
  VERBS, VERB_GROUPS, MODIFIERS, ROE,
  getRosterOrder, getSupport, getRoeOf, toGrid, issueOrder,
} from '../state.js';

// 部隊ごとに出せる命令は違う。砲兵に「突撃せよ」とは言えない。
const VERBS_BY_UNIT = {
  TH: ['fire_mission', 'smoke', 'register', 'sitrep', 'ammo_check'],
  EG: ['recon', 'move', 'observe', 'sitrep'],
  _default: [
    'move', 'advance', 'attack', 'defend', 'hold', 'recon', 'withdraw', 'rally',
    'observe', 'hold_fire', 'free_fire',
    'roe_hold_fast', 'roe_standard', 'roe_elastic',
    'sitrep', 'ammo_check',
  ],
};

const MOD_ORDER = ['normal', 'rapid', 'cautious', 'stealth'];
const GROUP_ORDER = ['maneuver', 'fires', 'roe', 'intel'];

export function createOrderPanel(dom, game, hooks) {
  const panel = {
    game,
    dom,
    hooks, // { onTargetingChange(active), onNotice(text), onLegsChange(legs) }
    unitId: null,
    group: 'maneuver',
    verb: null,
    modifier: 'normal',
    legs: [], // 経路点。最後の点が目標。
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

  dom.groups?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-group]');
    if (!b) return;
    panel.group = b.dataset.group;
    refresh(panel);
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

  dom.undoLeg?.addEventListener('click', () => {
    if (!panel.legs.length) return;
    panel.legs.pop();
    panel.legsDone = false;
    panel.hooks.onLegsChange?.(panel.legs.slice());
    syncTargeting(panel);
    refresh(panel);
  });

  dom.send.addEventListener('click', () => send(panel));

  refresh(panel);
  return panel;
}

export function selectUnit(panel, unitId) {
  if (panel.unitId !== unitId) {
    panel.verb = null;
    clearLegs(panel);
    // その部隊に出せる命令が無い分類を選んだままにしない
    const allowed = allowedVerbs(unitId);
    if (!allowed.some((v) => VERBS[v].group === panel.group)) {
      panel.group = VERBS[allowed[0]]?.group ?? 'maneuver';
    }
  }
  panel.unitId = unitId;
  refresh(panel);
}

function allowedVerbs(unitId) {
  if (!unitId) return [];
  return VERBS_BY_UNIT[unitId] ?? VERBS_BY_UNIT._default;
}

function selectVerb(panel, verb) {
  panel.verb = verb;
  clearLegs(panel);
  syncTargeting(panel);
  refresh(panel);
}

function clearLegs(panel) {
  panel.legs = [];
  panel.legsDone = false;
  panel.hooks.onLegsChange?.([]);
}

function syncTargeting(panel) {
  const spec = VERBS[panel.verb];
  panel.hooks.onTargetingChange(!!spec?.needsTarget && needsMorePoints(panel), panel.verb);
}

/** まだ点を打つ必要があるか（経路点つきの命令は打ち続けられる） */
function needsMorePoints(panel) {
  const spec = VERBS[panel.verb];
  if (!spec?.needsTarget) return false;
  if (!panel.legs.length) return true;
  if (panel.legsDone) return false;
  return !!spec.multi && panel.legs.length < 5;
}

/** 経路の指定を打ち切る（「決定」から呼ばれる） */
export function finishTargeting(panel) {
  panel.legsDone = true;
  panel.hooks.onTargetingChange(false);
  refresh(panel);
}

/** 地図がクリックされたときに呼ばれる */
export function setTarget(panel, x, y) {
  const spec = VERBS[panel.verb];
  if (!spec?.needsTarget) return false;
  if (spec.multi) {
    if (panel.legs.length >= 5) return false;
    panel.legs.push({ x, y });
  } else {
    panel.legs = [{ x, y }];
  }
  panel.hooks.onLegsChange?.(panel.legs.slice());
  // 経路点つきの命令は、打ち終わりを指揮官が決める（送信を押すまで狙いを外さない）。
  syncTargeting(panel);
  refresh(panel);
  return true;
}

/** まだ地図を叩かせている最中か */
export function isTargeting(panel) {
  return needsMorePoints(panel);
}

function send(panel) {
  if (!canSend(panel)) return;
  const spec = VERBS[panel.verb];
  const last = panel.legs[panel.legs.length - 1];
  const order = issueOrder(panel.game, {
    unitId: panel.unitId,
    verb: panel.verb,
    x: spec.needsTarget ? last.x : null,
    y: spec.needsTarget ? last.y : null,
    legs: spec.multi && panel.legs.length > 1 ? panel.legs.slice() : null,
    modifier: panel.modifier,
  });

  if (!order) {
    panel.hooks.onNotice('その命令は出せない。');
    refresh(panel, 'その命令は出せない（弾切れ、または枠が埋まっている）。');
    return;
  }

  panel.hooks.onSent?.(order);
  panel.verb = null;
  clearLegs(panel);
  panel.hooks.onTargetingChange(false);
  refresh(panel, '送信した。応答を待て。');
}

function canSend(panel) {
  if (!panel.unitId || !panel.verb) return false;
  const spec = VERBS[panel.verb];
  if (spec.needsTarget && !panel.legs.length) return false;
  return true;
}

export function refresh(panel, status) {
  const { dom, game } = panel;

  for (const b of dom.units.querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.unit === panel.unitId);
  }

  const allowed = allowedVerbs(panel.unitId);

  // --- 分類タブ ----------------------------------------------------
  if (dom.groups) {
    const groups = GROUP_ORDER.filter((g) => allowed.some((v) => VERBS[v].group === g));
    const key = `${panel.unitId}:${groups.join(',')}`;
    if (dom.groups.dataset.for !== key) {
      dom.groups.dataset.for = key;
      dom.groups.innerHTML = '';
      for (const g of groups) {
        const b = document.createElement('button');
        b.className = 'tool tool--group';
        b.dataset.group = g;
        b.textContent = VERB_GROUPS[g];
        dom.groups.appendChild(b);
      }
    }
    if (!groups.includes(panel.group) && groups.length) panel.group = groups[0];
    for (const b of dom.groups.querySelectorAll('button')) {
      b.classList.toggle('is-on', b.dataset.group === panel.group);
    }
  }

  // --- 命令ボタン ---------------------------------------------------
  const shown = allowed.filter((v) => !dom.groups || VERBS[v].group === panel.group);
  const wanted = shown.join(',');
  if (dom.verbs.dataset.for !== `${panel.unitId}:${wanted}`) {
    dom.verbs.dataset.for = `${panel.unitId}:${wanted}`;
    dom.verbs.innerHTML = '';
    for (const v of shown) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.verb = v;
      b.textContent = VERBS[v].label;
      if (VERBS[v].roe) b.title = ROE[VERBS[v].roe].note;
      dom.verbs.appendChild(b);
    }
  }
  for (const b of dom.verbs.querySelectorAll('button')) {
    const v = b.dataset.verb;
    const roe = VERBS[v].roe;
    b.classList.toggle('is-on', v === panel.verb);
    // 今その部隊に効いている交戦規定は、選んでいなくても分かるようにする
    b.classList.toggle('is-standing', !!roe && panel.unitId && getRoeOf(game, panel.unitId) === roe);
  }

  // --- 態勢 ---------------------------------------------------------
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
    !['sitrep', 'ammo_check', 'fire_mission', 'smoke', 'register', 'hold', 'hold_fire', 'free_fire',
      'roe_hold_fast', 'roe_standard', 'roe_elastic'].includes(panel.verb);
  dom.mods.classList.toggle('is-dim', !modsUseful);
  for (const b of dom.mods.querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.mod === panel.modifier && modsUseful);
    b.disabled = !modsUseful;
  }

  // --- 目標 / 経路 ---------------------------------------------------
  const legText = panel.legs.length
    ? panel.legs.map((p) => toGrid(p.x, p.y)).join('→')
    : '──';
  dom.grid.textContent = legText;
  if (dom.undoLeg) dom.undoLeg.hidden = panel.legs.length < 1;
  dom.send.disabled = !canSend(panel);

  dom.status.classList.remove('is-warn');
  if (status) {
    dom.status.textContent = status;
  } else if (!panel.unitId) {
    dom.status.textContent = '部隊を選べ。';
  } else if (!panel.verb) {
    const s = getSupport(game);
    dom.status.textContent =
      panel.unitId === 'TH'
        ? `ソーン：砲弾${s.artillery}発、発煙${s.smoke}発。命令を選べ。`
        : `${ROE[getRoeOf(game, panel.unitId)].label}下。命令を選べ。`;
  } else if (VERBS[panel.verb].needsTarget && !panel.legs.length) {
    dom.status.textContent = '地図を叩いて目標を指定せよ。';
    dom.status.classList.add('is-warn');
  } else if (VERBS[panel.verb].multi && panel.legs.length) {
    dom.status.textContent =
      panel.legs.length < 5
        ? '送信できる。続けて地図を叩けば経由地を足せる。'
        : '送信できる（経由地は上限）。';
  } else {
    dom.status.textContent = '送信できる。';
  }
}
