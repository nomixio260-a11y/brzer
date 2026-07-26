// 起動・ゲームループ・各パネルの結線。地図上の操作（マーカーと目標指定）もここ。

import {
  createGame,
  advance,
  addMarker,
  moveMarker,
  updateMarker,
  removeMarker,
  getMission,
  getRosterOrder,
  getMarkers,
  MARKER_TYPES,
  CONFIDENCE,
} from './state.js';

import { createMapView, resize, draw, toWorld, isInsideMap, markerAt } from './ui/mapview.js';
import { symbolChip } from './ui/symbolchip.js';
import { createRoster, renderRoster, selectInRoster } from './ui/roster.js';
import { createRadioLog, appendEntries } from './ui/radiolog.js';
import { createOrderPanel, selectUnit, setTarget, isTargeting, refresh as refreshOrders } from './ui/orderpanel.js';
import { createHud, renderHud } from './ui/hud.js';
import { showDebrief } from './ui/debrief.js';
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

const markerTool = { type: 'enemy_inf', confidence: 'estimated' };
let dragging = null;

/* ================================================================== */
/* 起動                                                                */
/* ================================================================== */

function fillBriefing() {
  const mission = getMission(createGamePreview());
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
  for (const u of getRosterOrder()) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${u.callsign}</b><em>${u.typeLabel}</em><span>${u.role}</span>`;
    oob.appendChild(li);
  }
}

// ブリーフィング表示のためだけに一度だけ作る（そのまま本編にも使う）
let previewGame = null;
function createGamePreview() {
  if (!previewGame) previewGame = createGame();
  return previewGame;
}

function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.classList.remove('is-active');
  $(id).classList.add('is-active');
}

function startMission() {
  game = previewGame ?? createGame();
  previewGame = null;

  showView('view-game');
  audio.initAudio();
  audio.resume();

  buildMarkerTools();

  mapView = createMapView($('map'), game);
  rosterView = createRoster($('roster'), game, (unitId) => {
    selectUnit(orderPanel, unitId);
    selectInRoster(rosterView, unitId);
    audio.click();
  });
  logView = createRadioLog($('radiolog'));

  orderPanel = createOrderPanel(
    {
      units: $('order-units'),
      verbs: $('order-verbs'),
      mods: $('order-mods'),
      grid: $('order-grid'),
      send: $('order-send'),
      status: $('order-status'),
    },
    game,
    {
      onTargetingChange: (active, verb) => {
        mapView.targeting = active;
        const hint = $('map-hint');
        hint.hidden = !active;
        if (active) hint.textContent = `目標にする地点を地図でクリック（${verb === 'fire_mission' ? '砲弾はそこに落ちる' : '目標地点'}）`;
      },
      onNotice: (t) => {
        $('order-status').textContent = t;
      },
      onSent: () => {
        audio.squelch(1.2, 0.1);
        selectInRoster(rosterView, orderPanel.unitId);
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
      smoke: $('ammo-smoke'),
      objective: $('objective-line'),
    },
    game,
    { onSpeed: setSpeed }
  );

  wireMap();

  // ?debug=1 のときだけ、外から早送りできるようにしておく（自動テスト用）
  if (new URLSearchParams(location.search).has('debug')) {
    window.__brzer = { game, get mapView() { return mapView; } };
  }

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
  draw(mapView);

  if (game.finished) {
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
        },
        game
      );
    }, 900);
  }
}

/** 届いた無線に音をつける */
function announce(entries) {
  for (const e of entries) {
    if (e.lost) {
      audio.squelch(0.7, 0.2);
      continue;
    }
    if (e.outbound) continue;

    if (e.priority >= 2) {
      audio.alertTone();
      audio.speak(e.text, { priority: 2 });
    } else {
      audio.squelch(1, 0.12);
      audio.speak(e.text, { priority: e.priority });
    }
    if (e.kind === 'spot') audio.distantBoom(0.25);
  }
}

function setSpeed(s) {
  if (!game) return;
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
/* 地図の操作                                                          */
/* ================================================================== */

function buildMarkerTools() {
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
    markerTool.type = b.dataset.marker;
    syncMarkerTools();
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
    markerTool.confidence = b.dataset.conf;
    syncMarkerTools();
    audio.click();
  });

  $('btn-clear-markers').addEventListener('click', () => {
    for (const m of [...getMarkers(game)]) removeMarker(game, m.id);
    hideMarkerEditor();
    audio.click();
  });

  syncMarkerTools();
}

function syncMarkerTools() {
  for (const b of $('marker-tools').querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.marker === markerTool.type);
  }
  for (const b of $('confidence-tools').querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.conf === markerTool.confidence);
  }
}

function wireMap() {
  const canvas = $('map');

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const p = toWorld(mapView, e.clientX, e.clientY);
    if (!isInsideMap(p)) return;
    hideMarkerEditor();

    // 命令の目標指定中なら、そちらが最優先
    if (isTargeting(orderPanel)) {
      setTarget(orderPanel, p.x, p.y);
      mapView.targeting = false;
      $('map-hint').hidden = true;
      audio.click();
      return;
    }

    const hit = markerAt(game, p.x, p.y, mapView);
    if (hit) {
      mapView.selectedMarkerId = hit.id;
      dragging = { id: hit.id, moved: false };
      showMarkerEditor(hit, e);
      return;
    }

    const m = addMarker(game, {
      x: p.x,
      y: p.y,
      type: markerTool.type,
      confidence: markerTool.confidence,
    });
    mapView.selectedMarkerId = m.id;
    dragging = { id: m.id, moved: false };
    showMarkerEditor(m, e);
    audio.click();
  });

  window.addEventListener('mousemove', (e) => {
    if (!mapView) return;
    const p = toWorld(mapView, e.clientX, e.clientY);
    mapView.cursor = p;

    if (dragging) {
      moveMarker(game, dragging.id, p.x, p.y);
      dragging.moved = true;
      hideMarkerEditor();
      return;
    }
    mapView.hoverMarkerId = isInsideMap(p) ? markerAt(game, p.x, p.y, mapView)?.id ?? null : null;
  });

  window.addEventListener('mouseup', () => {
    dragging = null;
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = toWorld(mapView, e.clientX, e.clientY);
    const hit = markerAt(game, p.x, p.y, mapView);
    if (hit) {
      removeMarker(game, hit.id);
      hideMarkerEditor();
      audio.click();
    }
  });

  window.addEventListener('resize', () => resize(mapView));
}

function showMarkerEditor(marker, ev) {
  const ed = $('marker-editor');
  const input = $('marker-label');
  ed.hidden = false;

  const wrapRect = $('map').getBoundingClientRect();
  ed.style.left = `${Math.min(ev.clientX - wrapRect.left + 12, wrapRect.width - 210)}px`;
  ed.style.top = `${Math.min(ev.clientY - wrapRect.top + 12, wrapRect.height - 48)}px`;

  input.value = marker.label ?? '';
  input.oninput = () => updateMarker(game, marker.id, { label: input.value });
  input.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.stopPropagation();
      hideMarkerEditor();
    }
  };
  $('marker-delete').onclick = () => {
    removeMarker(game, marker.id);
    hideMarkerEditor();
  };
}

function hideMarkerEditor() {
  $('marker-editor').hidden = true;
}

/* ================================================================== */
/* キーボード                                                          */
/* ================================================================== */

const MARKER_KEYS = Object.keys(MARKER_TYPES);

window.addEventListener('keydown', (e) => {
  // Escape だけは入力欄の中からでも効かせる（ラベル入力から抜けられなくなるため）
  if (e.key === 'Escape') {
    hideMarkerEditor();
    if (mapView) mapView.selectedMarkerId = null;
    if (e.target instanceof HTMLInputElement) e.target.blur();
    return;
  }

  if (e.target instanceof HTMLInputElement) return;
  if (!game || game.finished) return;

  if (e.code === 'Space') {
    e.preventDefault();
    setSpeed(game.running ? 0 : game.speed || 1);
  } else if (e.key === '1') setSpeed(1);
  else if (e.key === '2') setSpeed(2);
  else if (e.key === '3') setSpeed(4);
  else if (e.key === 'm' || e.key === 'M') {
    const i = MARKER_KEYS.indexOf(markerTool.type);
    markerTool.type = MARKER_KEYS[(i + 1) % MARKER_KEYS.length];
    syncMarkerTools();
  }
});

/* ================================================================== */

$('btn-start').addEventListener('click', startMission);
$('btn-again').addEventListener('click', () => window.location.reload());
$('btn-sound').addEventListener('click', () => {
  const on = !audio.isEnabled();
  audio.setEnabled(on);
  $('btn-sound').classList.toggle('is-on', on);
  audio.resume();
});

$('btn-sound').classList.add('is-on');
fillBriefing();
