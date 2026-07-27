// 起動・ゲームループ・各パネルの結線。

import {
  createGame,
  advance,
  addMarker,
  moveMarker,
  updateMarker,
  removeMarker,
  removeSketch,
  addSketch,
  clearMarkings,
  undo,
  canUndo,
  getMission,
  getMissionList,
  getMapInfo,
  getRosterOrder,
  getMarkers,
  isLongBattle,
  issueOrder,
  MARKER_TYPES,
  CONFIDENCE,
  SKETCH_TOOLS,
  isCreative,
  getCreative,
  creativeAction,
  markUnit,
  getCallsigns,
} from './state.js';

import {
  createMapView,
  resize,
  draw,
  zoomAt,
  setZoom,
  centerOn,
  isWellVisible,
  flashGrid,
  ZOOM_MIN,
  ZOOM_MAX,
} from './ui/mapview.js';
import { attachMapInput } from './ui/mapinput.js';
import { symbolChip, symbolFor } from './ui/symbolchip.js';
import { createRoster, renderRoster, selectInRoster } from './ui/roster.js';
import { createRadioLog, appendEntries } from './ui/radiolog.js';
import {
  createOrderPanel,
  selectUnit,
  setTarget,
  isTargeting,
  finishTargeting,
  panelState,
  submit as submitOrder,
  cancel as cancelOrder,
  refresh as refreshOrders,
} from './ui/orderpanel.js';
import { createHud, renderHud } from './ui/hud.js';
import { showDebrief } from './ui/debrief.js';
import { fromGrid, formatClock, WORLD } from './util.js';
// 検査用の窓口。?debug=1 のときだけ window に出す（本番の遊びには一切関わらない）。
import * as stateApi from './state.js';
import * as audio from './audio.js';

const $ = (id) => document.getElementById(id);

let game = null;
let mapView = null;
let rosterView = null;
let logView = null;
let orderPanel = null;
let hud = null;
let rafId = null;
let lastFrame = 0;
let toastTimer = null;
let unread = 0;

// 今どの図式を書き込もうとしているか
const tool = {
  mode: 'symbol', // 'symbol' | 'sketch'
  markerType: 'enemy_inf',
  confidence: 'estimated',
  sketchTool: 'arrow_enemy',
};

const options = { variable: false, voice: true, creative: false };

const isNarrow = () =>
  window.matchMedia('(max-width: 900px), (pointer: coarse) and (max-width: 1100px)').matches;

/** 図面が画面を覆い尽くす倍率（縦長の端末で余白を作らないため） */
function coverZoom(view) {
  const cover = Math.max(view.canvas.width / WORLD.width, view.canvas.height / WORLD.height);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cover / view.fitScale));
}

/* ================================================================== */
/* ブリーフィング                                                       */
/* ================================================================== */

let previewGame = null;
let pickedMission = 'bridge_hold';

const KIND_JA = {
  hold_point: '防御 ─ 一点を保持する',
  delay_line: '遅滞 ─ 時間を稼ぐ',
  seize_point: '攻撃 ─ 奪回する',
};

/** 任務の一覧。図幅・時間帯・戦闘の型が一目で分かるようにする。 */
function buildMissionPicker() {
  const wrap = $('mission-pick');
  const list = getMissionList();
  const sig = list.map((m) => m.id).join(',') + ':' + pickedMission;
  if (wrap.dataset.sig === sig) return;
  wrap.dataset.sig = sig;
  wrap.innerHTML = '';

  for (const m of list) {
    const b = document.createElement('button');
    b.className = 'missionpick__opt';
    b.dataset.mission = m.id;
    b.classList.toggle('is-on', m.id === pickedMission);

    const title = document.createElement('b');
    title.textContent = m.title;
    const tag = document.createElement('i');
    tag.className = 'missionpick__tag';
    tag.textContent = KIND_JA[m.kind] ?? '';
    title.appendChild(tag);

    const line = document.createElement('em');
    const hours = Math.round(((m.endTime - m.startTime) / 3600) * 10) / 10;
    line.textContent =
      `${m.subtitle.split('/')[0].trim()} ／ ${formatClock(m.startTime)}〜${formatClock(m.endTime)}` +
      `（${hours}時間）`;

    const note = document.createElement('span');
    note.textContent = m.blurb ?? '';

    b.append(title, line, note);
    wrap.appendChild(b);
  }
}

function preview() {
  if (!previewGame || previewGame.world.mission.id !== pickedMission) {
    previewGame = createGame({ missionId: pickedMission });
  }
  return previewGame;
}

function fillBriefing() {
  const mission = getMission(preview());
  $('brief-title').textContent = mission.title;
  const map = getMapInfo(preview());
  $('brief-sub').textContent =
    `${map.name} ／ ${formatClock(mission.startTime)} ─ ${formatClock(mission.endTime)}`;
  buildMissionPicker();
  $('brief-situation').textContent = mission.briefing.situation;
  $('brief-mission').textContent = mission.briefing.mission;
  $('brief-execution').textContent = mission.briefing.execution;

  const notes = $('brief-notes');
  notes.innerHTML = '';
  for (const n of mission.briefing.notes) {
    const li = document.createElement('li');
    li.textContent = n;
    notes.appendChild(li);
  }

  const oob = $('brief-oob');
  oob.innerHTML = '';
  for (const u of getRosterOrder(preview())) {
    const li = document.createElement('li');
    li.appendChild(symbolFor({ affiliation: 'friend', icon: u.icon, echelon: u.echelon }, 38));
    const b = document.createElement('b');
    b.textContent = u.callsign;
    const em = document.createElement('em');
    em.textContent = u.typeLabel;
    const sp = document.createElement('span');
    sp.textContent = u.role;
    li.append(b, em, sp);
    oob.appendChild(li);
  }

  // 記号の読み方。遊ぶ前にここで覚えてもらう。
  const legend = $('brief-legend');
  legend.innerHTML = '';
  for (const spec of Object.values(MARKER_TYPES)) {
    const li = document.createElement('li');
    li.appendChild(symbolChip(spec));
    const cap = document.createElement('span');
    cap.textContent = spec.label;
    li.appendChild(cap);
    legend.appendChild(li);
  }
}

function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.classList.remove('is-active');
  $(id).classList.add('is-active');
}

/* ================================================================== */
/* 開始                                                                */
/* ================================================================== */

function startMission() {
  options.variable = $('opt-variable').checked;
  options.voice = $('opt-voice').checked;
  options.creative = $('opt-creative').checked;

  // 敵の企図を変えるなら、下敷きに作った盤は捨てて作り直す
  game =
    options.variable || options.creative || !previewGame ||
    previewGame.world.mission.id !== pickedMission
      ? createGame({
          variable: options.variable,
          missionId: pickedMission,
          creative: options.creative,
        })
      : previewGame;
  previewGame = null;
  document.body.classList.toggle('is-drill', options.creative);

  showView('view-game');
  audio.initAudio();
  audio.setVoiceEnabled(options.voice);
  audio.resume();

  buildToolbox();

  mapView = createMapView($('map'), game);
  // 縦長の画面では、全体表示だと上下が大きく余る。最初から画面を満たしておく。
  if (isNarrow()) setZoom(mapView, coverZoom(mapView));

  rosterView = createRoster($('roster'), game, (unitId) => {
    selectUnit(orderPanel, unitId);
    selectInRoster(rosterView, unitId);
    if (isNarrow()) openTab('order');
    audio.click();
  }, (grid) => {
    // 「最後に聞いた位置」へ跳ぶ。今そこに居るとは限らない。
    const p = fromGrid(grid);
    if (!p) return;
    flashGrid(mapView, p.x, p.y);
    centerOn(mapView, p.x, p.y, Math.max(mapView.zoom, 1.8));
    if (isNarrow()) closeSheet();
    audio.click();
  }, markUnitOnMap);

  logView = createRadioLog($('radiolog'), {
    onCite: (entry) => citeReport(entry),
    onMark: (entry) => markFromReport(entry),
    onAdjustFire: (entry) => adjustFire(entry),
  });

  orderPanel = createOrderPanel(
    {
      units: $('order-units'),
      groups: $('order-groups'),
      verbs: $('order-verbs'),
      mods: $('order-mods'),
      triggers: $('order-triggers'),
      trigTime: $('order-trigtime'),
      trigLine: $('order-trigline'),
      grid: $('order-grid'),
      undoLeg: $('order-undoleg'),
      send: $('order-send'),
      status: $('order-status'),
    },
    game,
    {
      onTargetingChange: (active) => {
        mapView.targeting = active;
        // 目標を叩かせるあいだは頁を退ける。地図が見えなければ指定できない。
        if (active && isNarrow()) closeSheet();
        syncMapHint();
      },
      onLegsChange: (legs) => {
        mapView.orderLegs = legs;
        syncMapHint();
      },
      onNotice: (t) => {
        $('order-status').textContent = t;
      },
      onSent: (order) => {
        audio.squelch(1.2, 0.1);
        selectInRoster(rosterView, orderPanel.unitId);
        if (isNarrow()) closeSheet();
        showToast('指揮所 発', order.text ?? '命令を送信した。応答を待て。', false);
        syncMapHint();
      },
      // 演習統裁の操作は無線を通らない。押した瞬間に盤が変わる。
      onCreative: (verb, res) => {
        audio.click();
        $('btn-reveal').classList.toggle('is-on', !!getCreative(game)?.reveal);
        showToast('演習統裁', res.text, false);
      },
    }
  );

  hud = createHud(
    {
      clock: $('clock'),
      phase: $('clock-phase'),
      speed: document.querySelector('.speed'),
      net: $('radio-net'),
      queue: $('radio-queue'),
      jam: $('radio-jam'),
      he: $('ammo-he'),
      heItem: $('ammo-he-item'),
      smoke: $('ammo-smoke'),
      illum: $('ammo-illum'),
      trains: $('trains-loads'),
      trainsItem: $('trains-item'),
      vis: $('visibility'),
      objective: $('objective-line'),
    },
    game,
    { onSpeed: setSpeed }
  );

  // 演習の釦は演習の盤にしか出ない
  $('btn-reveal').hidden = !isCreative(game);
  $('btn-reveal').classList.toggle('is-on', !!getCreative(game)?.reveal);

  wireMap();
  wireTabs();
  wireSheet();
  wireZoom();

  if (new URLSearchParams(location.search).has('debug')) {
    window.__brzer = { game, get mapView() { return mapView; }, tool, state: stateApi };
  }

  // 半日の戦闘では、静穏を飛ばすための x8 を出す
  $('speed-8').hidden = !isLongBattle(game);

  game.running = true;
  game.speed = 1;
  lastFrame = performance.now();
  loop(lastFrame);
}

/* ================================================================== */
/* ループ                                                              */
/* ================================================================== */

function loop(t) {
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(0.25, (t - lastFrame) / 1000);
  lastFrame = t;

  const fresh = advance(game, dt);
  if (fresh.length) {
    appendEntries(logView, fresh);
    announce(fresh);
  }

  renderHud(hud);
  renderRoster(rosterView);
  refreshOrders(orderPanel);
  $('btn-undo').disabled = !canUndo(game);
  draw(mapView);

  if (game.finished) {
    hideMarkerEditor();
    $('map-hint').hidden = true;
    // 戦闘が終わっているのに、読みかけの無線が講評まで喋り続けるのはおかしい
    audio.stopSpeaking();
    cancelAnimationFrame(rafId);
    rafId = null;
    setTimeout(() => {
      showView('view-debrief');
      showDebrief(
        {
          verdict: $('debrief-verdict'),
          reason: $('debrief-reason'),
          canvas: $('truthmap'),
          stats: $('debrief-stats'),
          units: $('debrief-units'),
          enemy: $('debrief-enemy'),
        },
        game
      );
    }, 900);
  }
}

/** 届いた無線に音と、緊急なら画面上の掲示をつける */
function announce(entries) {
  const logOpen = !isNarrow() || ($('side').classList.contains('is-open') && currentTab === 'log');

  for (const e of entries) {
    if (e.lost) {
      audio.squelch(0.7, 0.2);
      continue;
    }
    if (e.outbound) continue;

    if (e.priority >= 2) {
      audio.alertTone();
      audio.speak(e.text, { priority: 2 });
      showToast(`${e.from} 発 ・至急`, e.text, true);
    } else {
      audio.squelch(1, 0.12);
      audio.speak(e.text, { priority: e.priority });
    }
    if (e.kind === 'spot') audio.distantBoom(0.25);

    if (!logOpen) unread++;
  }

  const badge = $('tab-unread');
  badge.hidden = unread === 0;
  badge.textContent = String(Math.min(99, unread));
}

function showToast(head, text, urgent) {
  const el = $('toast');
  el.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = head;
  el.append(b, document.createTextNode(text));
  el.hidden = false;
  el.style.borderColor = urgent ? '' : '#6d5a34';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, urgent ? 6000 : 3200);
}

function setSpeed(s) {
  if (!game) return;
  if (s > (game.maxSpeed ?? 4)) return; // 短期戦に x8 はない
  if (s === 0) {
    game.running = false;
    audio.stopSpeaking();
  } else {
    game.running = true;
    game.speed = s;
    audio.resume();
  }
  audio.click();
}

/* ================================================================== */
/* 無線報告から地図へ                                                   */
/* ================================================================== */

/** 報告が指している方眼へ跳んで点滅させる */
function citeReport(entry) {
  const grid = entry.meta?.grid;
  const p = entry.meta?.reportedX != null
    ? { x: entry.meta.reportedX, y: entry.meta.reportedY }
    : grid ? fromGrid(grid) : null;
  if (!p) return;

  flashGrid(mapView, p.x, p.y);
  if (!isWellVisible(mapView, p.x, p.y)) {
    centerOn(mapView, p.x, p.y, Math.max(mapView.zoom, 1.8));
  }
  if (isNarrow()) closeSheet();
  audio.click();
}

// 報告された兵種を、地図に置く記号に対応させる
const CLASSIFIED_TO_MARKER = {
  infantry: 'enemy_inf',
  recon: 'enemy_inf',
  at_team: 'enemy_at',
  mech: 'enemy_mech',
  tank: 'enemy_armor',
  mortar: 'enemy_arty',
  obstacle: 'obstacle',
  convoy: 'unknown',
  drone: 'unknown',
};

/**
 * 「聞いたとおりに」記号を置く。
 * 置かれるのは報告された位置であって、実際の位置ではない ─ そこが肝である。
 */
function markFromReport(entry) {
  const meta = entry.meta ?? {};
  const p = meta.reportedX != null ? { x: meta.reportedX, y: meta.reportedY } : fromGrid(meta.grid);
  if (!p) return;

  const type = CLASSIFIED_TO_MARKER[meta.classified] ?? 'unknown';
  const q = meta.quality ?? 0.4;
  const confidence = q > 0.75 ? 'confirmed' : q > 0.45 ? 'estimated' : 'unconfirmed';

  const m = addMarker(game, { x: p.x, y: p.y, type, confidence, label: `${entry.from}報` });
  mapView.selectedMarkId = m.id;
  flashGrid(mapView, p.x, p.y);
  if (!isWellVisible(mapView, p.x, p.y)) centerOn(mapView, p.x, p.y, Math.max(mapView.zoom, 1.8));
  if (isNarrow()) closeSheet();
  audio.click();
}

/**
 * 観測者の修正を容れて効力射を撃つ。
 * 容れるかどうかは指揮官の判断 ― 観測者も間違えるし、砲弾は有限である。
 */
function adjustFire(entry) {
  const meta = entry.meta ?? {};
  if (meta.correctionX == null) return;
  const order = issueOrder(game, {
    unitId: 'TH',
    verb: 'fire_mission',
    x: meta.correctionX,
    y: meta.correctionY,
  });
  if (!order) {
    showToast('ソーン 発', '砲弾が残っていない。射撃要請には応じられない。', true);
    return;
  }
  flashGrid(mapView, meta.correctionX, meta.correctionY);
  if (!isWellVisible(mapView, meta.correctionX, meta.correctionY)) {
    centerOn(mapView, meta.correctionX, meta.correctionY, Math.max(mapView.zoom, 1.8));
  }
  if (isNarrow()) closeSheet();
  audio.click();
}

/* ================================================================== */
/* 道具箱                                                              */
/* ================================================================== */

function buildToolbox() {
  const box = $('marker-tools');
  box.innerHTML = '';
  for (const [key, spec] of Object.entries(MARKER_TYPES)) {
    const b = document.createElement('button');
    b.className = 'tool tool--sym';
    b.dataset.marker = key;
    b.title = spec.label;
    b.appendChild(symbolChip(spec));
    const cap = document.createElement('span');
    cap.textContent = spec.label;
    b.appendChild(cap);
    box.appendChild(b);
  }
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-marker]');
    if (!b) return;
    tool.mode = 'symbol';
    tool.markerType = b.dataset.marker;
    syncToolbox();
    audio.click();
  });

  const cbox = $('confidence-tools');
  cbox.innerHTML = '';
  for (const [key, spec] of Object.entries(CONFIDENCE)) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.conf = key;
    b.textContent = spec.label;
    cbox.appendChild(b);
  }
  cbox.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-conf]');
    if (!b) return;
    tool.confidence = b.dataset.conf;
    syncToolbox();
    audio.click();
  });

  const sbox = $('sketch-tools');
  sbox.innerHTML = '';
  for (const [key, spec] of Object.entries(SKETCH_TOOLS)) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.sketch = key;
    b.textContent = spec.label;
    b.style.borderLeft = `3px solid ${spec.color}`;
    sbox.appendChild(b);
  }
  sbox.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sketch]');
    if (!b) return;
    // 同じものをもう一度押したら記号置きに戻る
    if (tool.mode === 'sketch' && tool.sketchTool === b.dataset.sketch) tool.mode = 'symbol';
    else {
      tool.mode = 'sketch';
      tool.sketchTool = b.dataset.sketch;
    }
    syncToolbox();
    audio.click();
  });

  // 記号が消えたり戻ったりしたあとで、ラベル欄が居なくなった記号を掴んだままにしない
  $('btn-undo').addEventListener('click', () => {
    // 取り消すと記号が入れ替わる。開いたままのラベル欄は、もう無い記号を掴んでいる。
    hideMarkerEditor();
    if (mapView) mapView.selectedMarkId = null;
    if (undo(game)) audio.click();
  });
  $('btn-clear-markers').addEventListener('click', () => {
    clearMarkings(game);
    hideMarkerEditor();
    if (mapView) mapView.selectedMarkId = null;
    audio.click();
  });

  $('tools-toggle').addEventListener('click', () => {
    setToolsCollapsed(!$('maptools').classList.contains('is-collapsed'));
    audio.click();
  });
  // 携帯では場所を食うので最初は畳んでおく
  setToolsCollapsed(isNarrow());
  syncToolbox();
}

function setToolsCollapsed(collapsed) {
  $('maptools').classList.toggle('is-collapsed', collapsed);
  $('tools-toggle').setAttribute('aria-expanded', String(!collapsed));
  syncToolbox();
}

function syncToolbox() {
  // 畳んでいる間も「今なにを書き込む設定か」は見えていないと困る
  const collapsed = $('maptools').classList.contains('is-collapsed');
  const label =
    tool.mode === 'sketch'
      ? SKETCH_TOOLS[tool.sketchTool].label
      : `${MARKER_TYPES[tool.markerType].label}／${CONFIDENCE[tool.confidence].label}`;
  $('tools-toggle').textContent = collapsed ? `図式 ▸ ${label}` : '図式 ▾';

  for (const b of $('marker-tools').querySelectorAll('button')) {
    b.classList.toggle('is-on', tool.mode === 'symbol' && b.dataset.marker === tool.markerType);
  }
  for (const b of $('confidence-tools').querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.conf === tool.confidence);
  }
  for (const b of $('sketch-tools').querySelectorAll('button')) {
    b.classList.toggle('is-on', tool.mode === 'sketch' && b.dataset.sketch === tool.sketchTool);
  }
}

/* ================================================================== */
/* 地図の操作                                                          */
/* ================================================================== */

function wireMap() {
  attachMapInput($('map'), {
    getView: () => mapView,
    getGame: () => game,
    getTool: () => {
      if (tool.mode !== 'sketch') return { mode: 'symbol' };
      const spec = SKETCH_TOOLS[tool.sketchTool];
      return {
        mode: 'sketch',
        sketchTool: tool.sketchTool,
        sketchKind: spec.kind,
        sketchColor: spec.color,
        sketchDash: spec.dash,
      };
    },
    isTargeting: () => isTargeting(orderPanel),

    onTargetPick: (x, y) => {
      setTarget(orderPanel, x, y);
      audio.click();
      // 頁を開き直させない。指定した所に「送信」が出るので、
      // 地図を見たまま最後まで済ませられる。
      syncMapHint();
    },

    onPlaceMarker: (x, y, ev) => {
      const m = addMarker(game, { x, y, type: tool.markerType, confidence: tool.confidence });
      mapView.selectedMarkId = m.id;
      // 置いたらすぐ名前を付けられるようにする。携帯では画面下に貼り付くので、
      // 置いた記号そのものは隠れない ─ 見本を一つ叩けば名前が入る。
      showMarkerEditor(m, ev);
      audio.click();
    },

    onSelectMark: (mark, ev) => {
      if (!mark) {
        hideMarkerEditor();
        mapView.selectedMarkId = null;
        return;
      }
      if (mark.tool) hideMarkerEditor(); // 作図にはラベル欄を出さない
      else showMarkerEditor(mark, ev);
    },

    onMoveMarker: (id, x, y, phase) => {
      if (!getMarkers(game).some((m) => m.id === id)) return;
      // 控えを取るのは動かし「始める」とき。終わってからでは元の位置が残らない。
      moveMarker(game, id, x, y, { record: phase === 'start' });
      hideMarkerEditor();
    },

    onDeleteMark: (mark) => {
      if (mark.tool) removeSketch(game, mark.id);
      else removeMarker(game, mark.id);
      hideMarkerEditor();
      mapView.selectedMarkId = null;
      audio.click();
    },

    onSketchDone: (toolKey, points) => {
      const sk = addSketch(game, { tool: toolKey, points });
      // 統制線は名前を付けて呼べるようにしてある。付いた名前をその場で伝える。
      if (sk?.name) {
        showToast('指揮所', `統制線${sk.name}を設定した。予令の発動条件に使える。`, false);
      }
      audio.click();
    },

    onViewChanged: () => hideMarkerEditor(),
  });

  window.addEventListener('resize', () => {
    resize(mapView);
    // 画面の向きや大きさが変わったら、まだ自分で拡大していない人には
    // 図面が画面を満たす倍率を出し直す
    if (!mapView.userZoomed && isNarrow()) setZoom(mapView, coverZoom(mapView));
    hideMarkerEditor();
  });
  window.addEventListener('orientationchange', () => setTimeout(() => resize(mapView), 250));
}

function wireZoom() {
  $('zoom-in').addEventListener('click', () => {
    zoomAt(mapView, 1.5);
    audio.click();
  });
  $('zoom-out').addEventListener('click', () => {
    zoomAt(mapView, 1 / 1.5);
    audio.click();
  });
  $('zoom-fit').addEventListener('click', () => {
    setZoom(mapView, ZOOM_MIN, { byUser: true });
    audio.click();
  });

  // 経路点の指定を打ち切る（指定を終えても頁は開かない ─ 隣に送信が出る）
  $('map-hint-done').addEventListener('click', () => {
    finishTargeting(orderPanel);
    audio.click();
    syncMapHint();
  });

  // 地図の上から送信する。命令の頁を開き直す必要はない。
  $('map-hint-send').addEventListener('click', () => {
    submitOrder(orderPanel);
    syncMapHint();
  });

  $('map-hint-cancel').addEventListener('click', () => {
    cancelOrder(orderPanel);
    audio.click();
    syncMapHint();
  });
}

/**
 * 地図の下の帯。
 *
 * 携帯では、目標を指定するために命令の頁を閉じねばならない。
 * 閉じたぶんの続きをここで済ませる ─ 経由地の決定も、送信も、取りやめも。
 * 「選ぶ → 閉じる → 叩く → 開き直す → 送る」の開き直しを無くすためにある。
 */
function syncMapHint() {
  if (!orderPanel) return;
  const st = panelState(orderPanel);
  const hint = $('map-hint');
  const text = $('map-hint-text');
  const done = $('map-hint-done');
  const send = $('map-hint-send');
  const cancel = $('map-hint-cancel');

  // 目標の要らない命令は地図と関係がない
  if (!st.verb || !st.needsTarget) {
    hint.hidden = true;
    return;
  }

  hint.hidden = false;
  cancel.hidden = false;
  done.hidden = !(st.targeting && st.legs >= 1 && st.multi);
  send.hidden = !st.canSend;
  send.textContent = `送信 ─ ${st.label}${st.grid ? ` ${st.grid}` : ''}`;
  // 送信釦に命令も方眼も書いてある。同じことを二度並べると帯が潰れる。
  text.hidden = st.canSend && !st.targeting;

  if (!st.legs) {
    text.textContent =
      st.verb === 'fire_mission'
        ? `${st.label}：落とす地点を叩け ─ そこに味方がいれば味方に落ちる`
        : st.verb === 'register'
          ? `${st.label}：標定する地点を叩け`
          : st.verb === 'call_friend' || st.verb === 'place_enemy'
            ? `${st.label}：置く地点を叩け`
            : `${st.label}：目標を叩け`;
  } else if (st.targeting) {
    text.textContent = `${st.grid} ─ 続けて叩けば経由地を足せる`;
  } else {
    text.textContent = `${st.label} ${st.grid}`;
  }
}

// ラベルの見本。打つより選ぶほうが速い ─ 特に片手で持っている時は。
// 敵の記号には「何が何両いたか」を、味方の記号には呼出符号を出す。
const LABEL_CHIPS = {
  enemy_inf: ['一個分隊', '一個小隊', '斥候', '徒歩'],
  enemy_mech: ['装甲車2両', '装甲車3両', '随伴歩兵あり'],
  enemy_armor: ['戦車2両', '戦車3両', '縦隊', '停止中'],
  enemy_at: ['対戦車班', '待ち伏せ'],
  enemy_arty: ['迫撃砲', '砲声より', '陣地'],
  unknown: ['正体不明', '音のみ', '要確認'],
  obstacle: ['鉄条網', '地雷原', '倒木'],
  objective: ['確保', '奪回', '集結地'],
  note: ['要注意', '死角', '観測点', '退路'],
};

function showMarkerEditor(marker, ev) {
  const ed = $('marker-editor');
  const input = $('marker-label');
  ed.hidden = false;
  ed.dataset.mark = marker.id;

  // 携帯では画面下に貼り付ける（指の下に出すと、その記号が見えなくなる）。
  // 広い画面では、これまでどおり叩いた場所の脇に出す。
  if (isNarrow() || !ev || ev.clientX == null) {
    ed.classList.add('is-docked');
    ed.style.left = '';
    ed.style.top = '';
  } else {
    ed.classList.remove('is-docked');
    const wrap = $('map').getBoundingClientRect();
    const w = ed.offsetWidth || 240;
    const h = ed.offsetHeight || 64;
    ed.style.left = `${Math.max(6, Math.min(ev.clientX - wrap.left + 12, wrap.width - w - 6))}px`;
    ed.style.top = `${Math.max(6, Math.min(ev.clientY - wrap.top + 12, wrap.height - h - 6))}px`;
  }

  input.value = marker.label ?? '';
  input.oninput = () => updateMarker(game, marker.id, { label: input.value });
  input.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.stopPropagation();
      hideMarkerEditor();
      input.blur();
    }
  };

  // 一発で貼れる見本
  const chips = $('marker-chips');
  chips.innerHTML = '';
  const list =
    marker.type === 'friendly' ? getCallsigns(game) : (LABEL_CHIPS[marker.type] ?? []);
  for (const label of list) {
    const b = document.createElement('button');
    b.className = 'tool tool--chip';
    b.textContent = label;
    if (marker.label === label) b.classList.add('is-on');
    b.onclick = () => {
      updateMarker(game, marker.id, { label });
      input.value = label;
      for (const other of chips.querySelectorAll('button')) other.classList.remove('is-on');
      b.classList.add('is-on');
      audio.click();
      // 携帯では、名前が入ったらすぐ退く。地図の前に居座らせない。
      if (isNarrow()) hideMarkerEditor();
    };
    chips.appendChild(b);
  }
  chips.hidden = !list.length;

  $('marker-delete').onclick = () => {
    removeMarker(game, marker.id);
    hideMarkerEditor();
  };
  $('marker-close').onclick = () => hideMarkerEditor();
}

function hideMarkerEditor() {
  const ed = $('marker-editor');
  ed.hidden = true;
  ed.dataset.mark = '';
}

/**
 * 部隊の駒を、最後に聞いた位置へ置く／動かす。
 *
 * 部隊一覧の「記号」を叩くだけでよい。二度目からは同じ駒が動くので、
 * 名前を打ち直す必要はない ─ 報告を聞くたびに駒を進める、それだけになる。
 */
function markUnitOnMap(unitId) {
  const m = markUnit(game, unitId);
  if (!m) {
    showToast('指揮所', 'その部隊からはまだ何も届いていない。置く位置が無い。', false);
    return;
  }
  mapView.selectedMarkId = m.id;
  flashGrid(mapView, m.x, m.y);
  if (!isWellVisible(mapView, m.x, m.y)) centerOn(mapView, m.x, m.y, Math.max(mapView.zoom, 1.8));
  if (isNarrow()) closeSheet();
  audio.click();
}

/* ================================================================== */
/* 携帯の下部タブ                                                       */
/* ================================================================== */

let currentTab = 'map';

function wireSheet() {
  const handle = $('sheet-handle');
  const side = $('side');
  let start = null;

  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture?.(e.pointerId);
    start = { y: e.clientY, h: side.offsetHeight };
    side.style.transition = 'none';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dy = Math.max(0, e.clientY - start.y);
    side.style.transform = `translateY(${dy}px)`;
  });
  const release = (e) => {
    if (!start) return;
    const dy = Math.max(0, e.clientY - start.y);
    side.style.transition = '';
    side.style.transform = '';
    // 高さの1/4以上を払ったら閉じる
    if (dy > start.h * 0.25) closeSheet();
    start = null;
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', () => {
    side.style.transition = '';
    side.style.transform = '';
    start = null;
  });
}

function wireTabs() {
  $('tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    openTab(b.dataset.tab);
    audio.click();
  });
  applyTab();
}

function openTab(tab) {
  currentTab = currentTab === tab && tab !== 'map' ? 'map' : tab;
  applyTab();
}

function closeSheet() {
  currentTab = 'map';
  applyTab();
}

function applyTab() {
  for (const b of $('tabbar').querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.tab === currentTab);
  }
  const side = $('side');
  side.classList.toggle('is-open', currentTab !== 'map');
  // パネルを上げている間、その下に隠れる地図の操作具は引っ込める
  document.body.classList.toggle('is-sheet-open', currentTab !== 'map');
  // 命令パネルは段が多い。開いている間だけシートを深くする。
  document.body.classList.toggle('is-tab-order', currentTab === 'order');
  for (const p of side.querySelectorAll('.panel')) {
    p.classList.toggle('is-active', p.dataset.panel === currentTab);
  }
  if (currentTab === 'log') {
    unread = 0;
    $('tab-unread').hidden = true;
    if (logView) logView.el.scrollTop = logView.el.scrollHeight;
  }
}

/* ================================================================== */
/* キーボード                                                          */
/* ================================================================== */

const MARKER_KEYS = Object.keys(MARKER_TYPES);
const SKETCH_KEYS = Object.keys(SKETCH_TOOLS);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideMarkerEditor();
    if (mapView) mapView.selectedMarkId = null;
    // 組みかけの命令も取りやめる。地図の「✕」と同じことをする。
    if (orderPanel?.verb) {
      cancelOrder(orderPanel);
      syncMapHint();
    }
    if (e.target instanceof HTMLInputElement) e.target.blur();
    return;
  }
  if (e.target instanceof HTMLInputElement) return;
  if (!game || game.finished) return;

  // 取り消し
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    hideMarkerEditor();
    if (mapView) mapView.selectedMarkId = null;
    undo(game);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      setSpeed(game.running ? 0 : game.speed || 1);
      break;
    case '1': setSpeed(1); break;
    case '2': setSpeed(2); break;
    case '3': setSpeed(4); break;
    case '4': setSpeed(8); break;
    case '+': case '=': zoomAt(mapView, 1.5); break;
    case '-': case '_': zoomAt(mapView, 1 / 1.5); break;
    case '0': setZoom(mapView, ZOOM_MIN, { byUser: true }); break;
    case 'm': case 'M': {
      tool.mode = 'symbol';
      const i = MARKER_KEYS.indexOf(tool.markerType);
      tool.markerType = MARKER_KEYS[(i + 1) % MARKER_KEYS.length];
      syncToolbox();
      break;
    }
    case 'q': case 'Q':
      tool.mode = 'symbol';
      syncToolbox();
      break;
    case 'w': case 'W': {
      tool.mode = 'sketch';
      const i = SKETCH_KEYS.indexOf(tool.sketchTool);
      tool.sketchTool = SKETCH_KEYS[(i + 1) % SKETCH_KEYS.length];
      syncToolbox();
      break;
    }
    case 'e': case 'E': {
      const keys = Object.keys(CONFIDENCE);
      const i = keys.indexOf(tool.confidence);
      tool.confidence = keys[(i + 1) % keys.length];
      syncToolbox();
      break;
    }
    default:
      break;
  }
});

/* ================================================================== */

$('btn-start').addEventListener('click', startMission);
$('mission-pick').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mission]');
  if (!b || b.dataset.mission === pickedMission) return;
  pickedMission = b.dataset.mission;
  previewGame = null;
  fillBriefing();
});
$('btn-again').addEventListener('click', () => window.location.reload());
$('btn-sound').addEventListener('click', () => {
  const on = !audio.isEnabled();
  audio.setEnabled(on);
  $('btn-sound').classList.toggle('is-on', on);
  audio.resume();
});

// 演習の「真実の地図」。押した瞬間に霧が晴れる ─ 本編には無い釦である。
$('btn-reveal').addEventListener('click', () => {
  if (!game || !isCreative(game)) return;
  const res = creativeAction(game, { action: 'reveal' });
  $('btn-reveal').classList.toggle('is-on', !!getCreative(game)?.reveal);
  showToast('演習統裁', res.text, false);
  audio.click();
});

fillBriefing();
