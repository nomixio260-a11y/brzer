// 命令パネル。呼出符号 → 分類 → 命令 → 目標グリッド → 送信。
// 送信した瞬間に届くわけではない。届くかどうかも保証されない。
//
// 命令の数が増えたので、実際の命令書と同じように分類で畳んである。
// 「機動」「火力」「交戦規定」「情報」── 指揮官の頭の中もこの順で動く。

import {
  VERBS, VERB_GROUPS, MODIFIERS, ROE, TRIGGERS, FIRE_MODES, FIRE_MODE_ORDER, REINFORCEMENTS,
  getRosterOrder, getSupport, getRoeOf, getHeldOrders, getSimTime, getTrains, isLongBattle,
  getControlLines, toGrid, formatClock, issueOrder, isCreative, getCreative, creativeAction,
} from '../state.js';

/**
 * 演習統裁の操作。
 * 命令ではないので無線には乗らない ─ 盤の外から手を入れる行為である。
 * それでも命令パネルに並べるのは、同じ手順で扱えたほうが迷わないからである。
 */
const CREATIVE_VERBS = Object.freeze({
  call_friend: { label: '増援要請', group: 'drill', needsTarget: true, creative: true,
    note: '呼べば来る。0コスト・即時。' },
  place_enemy: { label: '敵配置', group: 'drill', needsTarget: true, creative: true,
    note: '敵を置く。状況を自分で組み立てられる。' },
  replenish: { label: '全部隊補充', group: 'drill', needsTarget: false, creative: true,
    note: '兵力・弾薬・士気・疲労を戻す。' },
  clear_enemy: { label: '敵を除く', group: 'drill', needsTarget: false, creative: true,
    note: '盤上の敵をすべて消す。' },
  reveal: { label: '真実表示', group: 'drill', needsTarget: false, creative: true,
    note: '本当の敵味方の位置を地図に出す。本編では決して見られない。' },
});

const ALL_VERBS = Object.freeze({ ...VERBS, ...CREATIVE_VERBS });
const GROUP_LABEL = Object.freeze({ ...VERB_GROUPS, drill: '演習' });

// 部隊ごとに出せる命令は違う。砲兵に「突撃せよ」とは言えない。
const VERBS_BY_UNIT = {
  CRE: ['call_friend', 'place_enemy', 'replenish', 'clear_enemy', 'reveal'],
  TH: [
    'fire_mission', 'smoke', 'illum', 'register', 'cancel_fire', 'check_fire',
    'move', 'countermand', 'resupply', 'sitrep', 'ammo_check',
  ],
  EG: ['recon', 'move', 'observe', 'countermand', 'sitrep', 'report_on'],
  // 段列は運ぶのが仕事。補給先はその部隊を選んで「補給要請」を出す。
  LD: ['move', 'hold', 'withdraw', 'countermand', 'sitrep'],
  _default: [
    'move', 'advance', 'attack', 'defend', 'hold', 'recon', 'withdraw', 'rally',
    'breach', 'countermand',
    'observe', 'hold_fire', 'free_fire',
    'roe_hold_fast', 'roe_standard', 'roe_elastic',
    'resupply', 'rest', 'stand_to',
    'sitrep', 'ammo_check', 'report_on',
  ],
};

const MOD_ORDER = ['normal', 'rapid', 'cautious', 'stealth'];
const GROUP_ORDER = ['maneuver', 'fires', 'roe', 'sustain', 'intel', 'drill'];
const TRIGGER_ORDER = ['now', 'on_contact', 'on_pressure', 'on_line', 'at_time'];

// 予令を渡せない命令。今すぐ聞きたいことを「後で」と言っても仕方がない。
const NO_TRIGGER = new Set([
  'sitrep', 'ammo_check', 'roe_hold_fast', 'roe_standard', 'roe_elastic',
  // 前令取消と射撃中止は「今すぐ」でなければ意味がない。
  // 「圧されたら前令を取り消せ」と言われて分かる部下はいない。
  'countermand', 'cancel_fire', 'check_fire',
  ...Object.keys(CREATIVE_VERBS),
]);

// 態勢を選んでも意味がない命令
const NO_MODS = new Set([
  'countermand', 'cancel_fire', 'report_on',
  'sitrep', 'ammo_check', 'smoke', 'illum', 'register', 'check_fire',
  'hold', 'hold_fire', 'free_fire', 'roe_hold_fast', 'roe_standard', 'roe_elastic',
  'rest', 'stand_to', 'resupply',
  'replenish', 'clear_enemy', 'reveal',
]);

/**
 * 「態勢」の行は、曲射の要請のときだけ「射撃要領」に化ける。
 * 行を増やさないのは、画面を狭くしないためである ―
 * 指揮官が一度に見るべきものは、そう多くない。
 */
function modSetFor(panel) {
  if (panel.verb === 'fire_mission') {
    return {
      key: 'fire',
      items: FIRE_MODE_ORDER.map((k) => ({ key: k, label: FIRE_MODES[k].label, title: FIRE_MODES[k].note })),
    };
  }
  // 演習で部隊を呼ぶときは、同じ行で兵種を選ぶ。
  if (panel.verb === 'call_friend' || panel.verb === 'place_enemy') {
    return {
      key: 'unittype',
      items: REINFORCEMENTS.map((r) => ({ key: r.key, label: r.label, title: '' })),
    };
  }
  return {
    key: 'posture',
    items: MOD_ORDER.map((k) => ({ key: k, label: MODIFIERS[k], title: '' })),
  };
}

/** 盤を差し替える（聞き手は付け直さない） */
// いま指揮官が何を指定させられているか。
//
// 地図の側がこれを読んで、砲の届く範囲を描く ─
// 「そこには届かない」を、要請して断られてから知るのでは遅い。
// 盤に一つしか無い機構なので、素直に持っておく。
let targetingVerbId = null;

export function currentTargetingVerb() {
  return targetingVerbId;
}

export function rebindOrderPanel(panel, game) {
  panel.game = game;
  panel.unitId = null;
  panel.group = 'maneuver';
  panel.verb = null;
  targetingVerbId = null;
  panel.modifier = 'normal';
  panel.fireMode = 'impact';
  panel.unitType = 'infantry';
  panel.trigger = 'now';
  panel.triggerAt = null;
  panel.lineId = null;
  panel.legs = [];
  panel._sig = '';
}

export function createOrderPanel(dom, game, hooks) {
  const panel = {
    game,
    dom,
    hooks, // { onTargetingChange(active), onNotice(text), onLegsChange(legs) }
    unitId: null,
    group: 'maneuver',
    verb: null,
    modifier: 'normal',
    fireMode: 'impact',
    unitType: 'infantry', // 演習で呼ぶ部隊の兵種
    trigger: 'now',
    triggerAt: null,
    lineId: null,
    legs: [], // 経路点。最後の点が目標。
  };

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
    if (!b || b.disabled) return;
    if (dom.mods.dataset.set === 'fire') panel.fireMode = b.dataset.mod;
    else if (dom.mods.dataset.set === 'unittype') panel.unitType = b.dataset.mod;
    else panel.modifier = b.dataset.mod;
    refresh(panel);
  });

  dom.triggers?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-trig]');
    if (!b || b.disabled) return;
    panel.trigger = b.dataset.trig;
    if (panel.trigger === 'at_time') panel.triggerAt = nextTimeChoice(panel);
    if (panel.trigger === 'on_line') {
      const lines = getControlLines(panel.game);
      panel.lineId = lines[lines.length - 1]?.id ?? null;
    }
    refresh(panel);
  });

  dom.trigTime?.addEventListener('change', () => {
    panel.triggerAt = Number(dom.trigTime.value);
    refresh(panel);
  });

  dom.trigLine?.addEventListener('change', () => {
    panel.lineId = dom.trigLine.value || null;
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
    targetingVerbId = null;
    clearLegs(panel);
    // その部隊にとって薄い分類を選んだままにしない。
    // 砲兵を選んで「機動」に移動しか出ていない、という画面は役に立たない ─
    // その部隊が本来やることの分類へ寄せる。
    const allowed = allowedVerbs(panel, unitId);
    if (allowed.filter((v) => ALL_VERBS[v].group === panel.group).length < 2) {
      panel.group = ALL_VERBS[allowed[0]]?.group ?? 'maneuver';
    }
  }
  panel.unitId = unitId;
  refresh(panel);
}

function allowedVerbs(panel, unitId) {
  if (!unitId) return [];
  const list = VERBS_BY_UNIT[unitId] ?? VERBS_BY_UNIT._default;
  // 兵站の命令は、段列が付いている戦闘にしか存在しない
  const long = isLongBattle(panel.game);
  return list.filter((v) => long || !ALL_VERBS[v].longOnly);
}

function selectVerb(panel, verb) {
  panel.verb = verb;
  targetingVerbId = verb;
  clearLegs(panel);
  if (NO_TRIGGER.has(verb)) panel.trigger = 'now';
  syncTargeting(panel);
  refresh(panel);
}

/** 発動時刻の候補。今から5分後以降を5分刻みで。 */
function timeChoices(panel) {
  const now = getSimTime(panel.game);
  const start = Math.ceil((now + 300) / 300) * 300;
  return Array.from({ length: 8 }, (_, i) => start + i * 300);
}

function nextTimeChoice(panel) {
  return timeChoices(panel)[0];
}

function clearLegs(panel) {
  panel.legs = [];
  panel.legsDone = false;
  panel.hooks.onLegsChange?.([]);
}

function syncTargeting(panel) {
  const spec = ALL_VERBS[panel.verb];
  panel.hooks.onTargetingChange(!!spec?.needsTarget && needsMorePoints(panel), panel.verb);
}

/** まだ点を打つ必要があるか（経路点つきの命令は打ち続けられる） */
function needsMorePoints(panel) {
  const spec = ALL_VERBS[panel.verb];
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
  const spec = ALL_VERBS[panel.verb];
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

/**
 * 今の命令書の状態。
 *
 * 携帯では、目標を指定するために命令の頁を閉じねばならない ―
 * そのまま地図の上で送信まで済ませられるように、地図側へ状態を渡す。
 * 閉じた頁を開き直させるのは、指揮の手順として無駄である。
 */
export function panelState(panel) {
  const spec = ALL_VERBS[panel.verb];
  const last = panel.legs[panel.legs.length - 1];
  return {
    unitId: panel.unitId,
    verb: panel.verb,
    label: spec?.label ?? null,
    needsTarget: !!spec?.needsTarget,
    multi: !!spec?.multi,
    legs: panel.legs.length,
    targeting: needsMorePoints(panel),
    canSend: canSend(panel),
    grid: last ? toGrid(last.x, last.y) : null,
  };
}

/** 地図の上から送信する（送信釦と同じ経路を通る） */
export function submit(panel) {
  send(panel);
}

/** 命令を組むのをやめる。打った点も捨てる。 */
export function cancel(panel) {
  panel.verb = null;
  targetingVerbId = null;
  panel.trigger = 'now';
  panel.triggerAt = null;
  clearLegs(panel);
  panel.hooks.onTargetingChange(false);
  refresh(panel, '取りやめた。');
}

function send(panel) {
  if (!canSend(panel)) return;
  const spec = ALL_VERBS[panel.verb];
  const last = panel.legs[panel.legs.length - 1];

  // 演習統裁の操作。命令ではないので、無線を通らずその場で効く。
  if (spec.creative) {
    const res = creativeAction(panel.game, {
      action: panel.verb,
      unitType: panel.unitType,
      x: last?.x,
      y: last?.y,
    });
    if (res.ok) {
      panel.hooks.onCreative?.(panel.verb, res);
      const keep = panel.verb === 'call_friend' || panel.verb === 'place_enemy';
      if (!keep) panel.verb = null;
      if (!keep) targetingVerbId = null;
      clearLegs(panel);
      panel.hooks.onTargetingChange(false);
      if (keep) syncTargeting(panel);
    }
    refresh(panel, res.text);
    return;
  }

  const order = issueOrder(panel.game, {
    unitId: panel.unitId,
    verb: panel.verb,
    x: spec.needsTarget ? last.x : null,
    y: spec.needsTarget ? last.y : null,
    legs: spec.multi && panel.legs.length > 1 ? panel.legs.slice() : null,
    // 曲射の要請では、この枠が運ぶのは態勢ではなく射撃要領である
    modifier: panel.verb === 'fire_mission' ? panel.fireMode : panel.modifier,
    trigger: NO_TRIGGER.has(panel.verb) ? 'now' : panel.trigger,
    triggerAt: panel.triggerAt,
    lineId: panel.trigger === 'on_line' ? panel.lineId : null,
  });

  if (!order) {
    panel.hooks.onNotice('その命令は出せない。');
    refresh(panel, 'その命令は出せない（弾切れ、または枠が埋まっている）。');
    return;
  }

  panel.hooks.onSent?.(order);
  const wasHeld = order.trigger && order.trigger !== 'now';
  panel.verb = null;
  targetingVerbId = null;
  panel.trigger = 'now';
  panel.triggerAt = null;
  clearLegs(panel);
  panel.hooks.onTargetingChange(false);
  refresh(panel, wasHeld ? '予令を送信した。条件が満ちれば部下が動く。' : '送信した。応答を待て。');
}

function canSend(panel) {
  if (!panel.unitId || !panel.verb) return false;
  const spec = ALL_VERBS[panel.verb];
  if (spec.needsTarget && !panel.legs.length) return false;
  return true;
}

export function refresh(panel, status) {
  const { dom, game } = panel;

  // --- 部隊ボタン ----------------------------------------------------
  // 演習では増援が増えるので、顔ぶれが変わったら並べ直す。
  const roster = getRosterOrder(game);
  const rosterKey = roster.map((u) => u.id).join(',');
  if (dom.units.dataset.for !== rosterKey) {
    dom.units.dataset.for = rosterKey;
    dom.units.innerHTML = '';
    for (const u of roster) {
      const b = document.createElement('button');
      b.className = u.virtual ? 'tool tool--drill' : 'tool';
      b.dataset.unit = u.id;
      b.textContent = u.callsign;
      b.title = `${u.typeLabel} ─ ${u.role}`;
      dom.units.appendChild(b);
    }
  }
  for (const b of dom.units.querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.unit === panel.unitId);
  }

  const allowed = allowedVerbs(panel, panel.unitId);

  // --- 分類タブ ----------------------------------------------------
  if (dom.groups) {
    const groups = GROUP_ORDER.filter((g) => allowed.some((v) => ALL_VERBS[v].group === g));
    const key = `${panel.unitId}:${groups.join(',')}`;
    if (dom.groups.dataset.for !== key) {
      dom.groups.dataset.for = key;
      dom.groups.innerHTML = '';
      for (const g of groups) {
        const b = document.createElement('button');
        b.className = 'tool tool--group';
        b.dataset.group = g;
        b.textContent = GROUP_LABEL[g];
        dom.groups.appendChild(b);
      }
    }
    if (!groups.includes(panel.group) && groups.length) panel.group = groups[0];
    for (const b of dom.groups.querySelectorAll('button')) {
      b.classList.toggle('is-on', b.dataset.group === panel.group);
    }
  }

  // --- 命令ボタン ---------------------------------------------------
  const shown = allowed.filter((v) => !dom.groups || ALL_VERBS[v].group === panel.group);
  const wanted = shown.join(',');
  if (dom.verbs.dataset.for !== `${panel.unitId}:${wanted}`) {
    dom.verbs.dataset.for = `${panel.unitId}:${wanted}`;
    dom.verbs.innerHTML = '';
    for (const v of shown) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.verb = v;
      b.textContent = ALL_VERBS[v].label;
      if (ALL_VERBS[v].roe) b.title = ROE[ALL_VERBS[v].roe].note;
      else if (ALL_VERBS[v].note) b.title = ALL_VERBS[v].note;
      dom.verbs.appendChild(b);
    }
  }
  for (const b of dom.verbs.querySelectorAll('button')) {
    const v = b.dataset.verb;
    const roe = ALL_VERBS[v].roe;
    b.classList.toggle('is-on', v === panel.verb);
    // 今その部隊に効いている交戦規定は、選んでいなくても分かるようにする
    b.classList.toggle('is-standing', !!roe && panel.unitId && getRoeOf(game, panel.unitId) === roe);
  }

  // --- 態勢／射撃要領 -------------------------------------------------
  const modSet = modSetFor(panel);
  if (dom.mods.dataset.set !== modSet.key) {
    dom.mods.dataset.set = modSet.key;
    dom.mods.innerHTML = '';
    for (const it of modSet.items) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.mod = it.key;
      b.textContent = it.label;
      if (it.title) b.title = it.title;
      dom.mods.appendChild(b);
    }
  }
  const isFireSet = modSet.key === 'fire';
  const modsUseful = !!panel.verb && (isFireSet || !NO_MODS.has(panel.verb));
  const currentMod =
    modSet.key === 'fire' ? panel.fireMode
      : modSet.key === 'unittype' ? panel.unitType
        : panel.modifier;
  dom.mods.classList.toggle('is-dim', !modsUseful);
  for (const b of dom.mods.querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.mod === currentMod && modsUseful);
    b.disabled = !modsUseful;
  }

  // --- 発動条件（予令） ----------------------------------------------
  if (dom.triggers) {
    if (!dom.triggers.childElementCount) {
      for (const t of TRIGGER_ORDER) {
        const b = document.createElement('button');
        b.className = 'tool tool--cond';
        b.dataset.trig = t;
        b.textContent = TRIGGERS[t].label;
        if (TRIGGERS[t].hint) b.title = TRIGGERS[t].hint;
        dom.triggers.appendChild(b);
      }
    }
    const canHold = !!panel.verb && !NO_TRIGGER.has(panel.verb);
    if (!canHold && panel.trigger !== 'now') panel.trigger = 'now';

    // 統制線は、引いてなければ条件にできない
    const lines = getControlLines(game);
    if (panel.trigger === 'on_line' && !lines.length) panel.trigger = 'now';

    dom.triggers.parentElement.classList.toggle('is-dim', !canHold);
    for (const b of dom.triggers.querySelectorAll('button')) {
      const usable = canHold && (b.dataset.trig !== 'on_line' || lines.length > 0);
      b.classList.toggle('is-on', b.dataset.trig === panel.trigger && canHold);
      b.disabled = !usable;
      if (b.dataset.trig === 'on_line') {
        b.title = lines.length
          ? TRIGGERS.on_line.hint
          : '統制線を引いてからでないと選べない（図式 → 統制線）';
      }
    }

    // どの統制線を条件にするか
    const showLine = canHold && panel.trigger === 'on_line' && lines.length > 0;
    if (dom.trigLine) {
      dom.trigLine.hidden = !showLine;
      if (showLine) {
        const key = lines.map((l) => l.id + l.name).join(',');
        if (dom.trigLine.dataset.for !== key) {
          dom.trigLine.dataset.for = key;
          dom.trigLine.innerHTML = '';
          for (const l of lines) {
            const o = document.createElement('option');
            o.value = l.id;
            o.textContent = `統制線${l.name}`;
            dom.trigLine.appendChild(o);
          }
        }
        if (!lines.some((l) => l.id === panel.lineId)) panel.lineId = lines[lines.length - 1].id;
        dom.trigLine.value = panel.lineId;
      }
    }

    // 時刻の候補は進行につれて動く
    const showTime = canHold && panel.trigger === 'at_time';
    dom.trigTime.hidden = !showTime;
    if (showTime) {
      const choices = timeChoices(panel);
      const key = choices.join(',');
      if (dom.trigTime.dataset.for !== key) {
        dom.trigTime.dataset.for = key;
        dom.trigTime.innerHTML = '';
        for (const t of choices) {
          const o = document.createElement('option');
          o.value = String(t);
          o.textContent = formatClock(t);
          dom.trigTime.appendChild(o);
        }
      }
      if (!choices.includes(panel.triggerAt)) panel.triggerAt = choices[0];
      dom.trigTime.value = String(panel.triggerAt);
    }
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
  } else if (panel.unitId === 'CRE') {
    const c = getCreative(game);
    const spec = ALL_VERBS[panel.verb];
    if (!spec) {
      dom.status.textContent =
        `演習統裁。増援${c?.called ?? 0}個・敵${c?.enemiesPlaced ?? 0}個を投入済み。` +
        `真実の地図は${c?.reveal ? '開いている' : '伏せてある'}。`;
    } else if (spec.needsTarget && !panel.legs.length) {
      const label = REINFORCEMENTS.find((r) => r.key === panel.unitType)?.label ?? '';
      dom.status.textContent = `${label}を置く地点を地図で叩け。`;
      dom.status.classList.add('is-warn');
    } else {
      dom.status.textContent = spec.note ?? '送信できる。';
    }
  } else if (!panel.verb) {
    const s = getSupport(game);
    // 渡してある予令は一覧で出す。三つまで抱えられるので、
    // 「何を渡したか」を覚えていろというのは指揮所の仕事の押しつけである。
    const held = getHeldOrders(game, panel.unitId);
    const heldNote = held.length
      ? ` 予令：${held
        .map((h) => `${TRIGGERS[h.trigger].label}に${ALL_VERBS[h.verb].label}${h.grid ? ` ${h.grid}` : ''}`)
        .join('／')}。`
      : '';
    const trains = getTrains(game);
    const trainsNote = trains
      ? ` 段列：${trains.alive ? `${trains.loadsLeft}/${trains.loads}基数` : '失われた'}${
          trains.busyWith ? `・${trains.busyWith}へ運搬中` : ''
        }。`
      : '';
    const rounds = (n) => (s.unlimited ? '∞' : n);
    dom.status.textContent =
      (panel.unitId === 'TH'
        ? `ソーン：砲弾${rounds(s.artillery)}・発煙${rounds(s.smoke)}・照明${rounds(s.illum)}。` +
          (!s.gunAlive
            ? '砲は沈黙している。'
            : s.layingIn > 0
              ? `陣地変換中 ─ あと約${s.layingIn}秒で撃てる。`
              : '命令を選べ。')
        : panel.unitId === 'LD'
          ? '段列。運ぶのが仕事である。補給は受け取る側の部隊に「補給要請」を出す。'
          : `${ROE[getRoeOf(game, panel.unitId)].label}下。命令を選べ。`) + heldNote + trainsNote;
  } else if (panel.trigger !== 'now' && !NO_TRIGGER.has(panel.verb) &&
             !(ALL_VERBS[panel.verb].needsTarget && !panel.legs.length)) {
    const t = TRIGGERS[panel.trigger];
    const when =
      panel.trigger === 'at_time'
        ? formatClock(panel.triggerAt)
        : panel.trigger === 'on_line'
          ? `統制線${getControlLines(game).find((l) => l.id === panel.lineId)?.name ?? ''}を敵が越えた時`
          : t.label;
    dom.status.textContent = `予令として渡す ─ ${when}に発動する。`;
  } else if (ALL_VERBS[panel.verb].needsTarget && !panel.legs.length) {
    dom.status.textContent = '地図を叩いて目標を指定せよ。';
    dom.status.classList.add('is-warn');
  } else if (panel.verb === 'fire_mission') {
    dom.status.textContent = `${FIRE_MODES[panel.fireMode].label} ─ ${FIRE_MODES[panel.fireMode].note}`;
  } else if (ALL_VERBS[panel.verb].multi && panel.legs.length) {
    dom.status.textContent =
      panel.legs.length < 5
        ? '送信できる。続けて地図を叩けば経由地を足せる。'
        : '送信できる（経由地は上限）。';
  } else {
    dom.status.textContent = '送信できる。';
  }
}
