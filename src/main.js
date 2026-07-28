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
  setAutoPlot,
  plotContact,
  startClock,
  isPlanning,
  newCampaign,
  loadCampaign,
  saveCampaign,
  clearCampaign,
  startCampaignBattle,
  finishCampaignBattle,
  getCampaignView,
  getCompany,
  getAttachState,
  assignReplacement,
  allotRounds,
  setNightPlan,
  attachTo,
  detachFrom,
  campaignList,
  getNationView,
  getOfficerCorps,
  pickDecree,
  unpickDecree,
  stopStanding,
  purgeIn,
  decorateIn,
  answerPetition,
  purgeMinister,
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
import { createRoster, renderRoster, selectInRoster, rebindRoster } from './ui/roster.js';
import { createRadioLog, appendEntries, clearLog } from './ui/radiolog.js';
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
  rebindOrderPanel,
} from './ui/orderpanel.js';
import { createHud, renderHud, rebindHud } from './ui/hud.js';
import { showDebrief } from './ui/debrief.js';
import { renderCampaign, unspentNotes } from './ui/campaign.js';
import { renderNation } from './ui/nation.js';
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

const options = { variable: false, voice: true, creative: false, autoPlot: loadAutoPlot() };

/* ------------------------------------------------------------------ */
/* 自動記入の入切                                                       */
/* ------------------------------------------------------------------ */
//
// 既定は入。無線を聞くたびに指で駒を置き直す作業は指揮ではない。
// 切れば全て手書きに戻る ─ 自分の手で盤を作りたい向きのために残してある。

const AUTOPLOT_KEY = 'brzer.autoplot';

function loadAutoPlot() {
  try {
    return window.localStorage.getItem(AUTOPLOT_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveAutoPlot(on) {
  try {
    window.localStorage.setItem(AUTOPLOT_KEY, on ? 'on' : 'off');
  } catch {
    /* 保存できない環境でも動作そのものは変わらない */
  }
}

function syncAutoPlotButton() {
  $('btn-autoplot').classList.toggle('is-on', options.autoPlot);
  $('opt-autoplot').checked = options.autoPlot;
}

function toggleAutoPlot() {
  options.autoPlot = !options.autoPlot;
  saveAutoPlot(options.autoPlot);
  syncAutoPlotButton();
  if (game) setAutoPlot(game, options.autoPlot);
  showToast(
    '指揮所',
    options.autoPlot
      ? '自動記入 入。無線で入った位置は、聞いたとおりに盤へ写す。'
      : '自動記入 切。以後は自分の手で書き込むこと。',
    false
  );
  audio.click();
}

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
/* 戦役                                                                */
/* ================================================================== */
//
// 戦闘そのものは今までどおり。戦役は、その前後に画面を一枚ずつ足しただけである。
//   ブリーフィング → 戦役の画面 → 戦闘（H時前 → 戦闘）→ 講評 → 戦役の画面 → …

let campaign = null;

const campDom = () => ({
  title: $('camp-title'),
  sub: $('camp-sub'),
  day: $('camp-day'),
  prologue: $('camp-prologue'),
  frontFill: $('camp-frontfill'),
  frontValue: $('camp-frontvalue'),
  company: $('camp-company'),
  allot: $('camp-allot'),
  night: $('camp-night'),
  history: $('camp-history'),
  historyBlock: $('camp-history-block'),
  nation: $('camp-nation'),
  unspent: $('camp-unspent'),
});

function drawCampaign() {
  if (!campaign) return;
  const view = getCampaignView(campaign);
  const att = getAttachState(campaign);

  renderCampaign(campDom(), view, getCompany(campaign), {
    ...att,
    onAssign: (id, n) => { assignReplacement(campaign, id, n); saveCampaign(campaign); drawCampaign(); },
    onAllot: (kind, n) => { allotRounds(campaign, kind, n); saveCampaign(campaign); drawCampaign(); },
    onNight: (id) => { setNightPlan(campaign, id); saveCampaign(campaign); drawCampaign(); audio.click(); },
    onAttach: (id, a, t) => { attachTo(campaign, id, a, t); saveCampaign(campaign); drawCampaign(); audio.click(); },
    onDetach: (id, a) => { detachFrom(campaign, id, a); saveCampaign(campaign); drawCampaign(); audio.click(); },
  });

  // 終わった戦役では出撃できない。残るのは結果と、やり直しだけである。
  const done = view.finished;
  $('btn-sortie').hidden = done;
  $('btn-abandon').textContent = done ? '新しい戦役を始める' : '戦役をやめる';
  const res = $('camp-result');
  res.hidden = !done;
  if (done) {
    res.innerHTML = '';
    const b = document.createElement('b');
    b.className = `is-${view.result}`;
    b.textContent = {
      victory: '戦役 ─ 勝利', narrow: '戦役 ─ 辛勝', defeat: '戦役 ─ 敗北',
      collapse: view.collapseLabel ? `${view.collapseLabel} ─ 失脚`
        : view.collapse === 'coup' ? '造反 ─ 失脚' : '内乱 ─ 失脚',
    }[view.result] ?? '終わり';
    res.append(b, document.createTextNode(view.resultReason ?? ''));
  }
  document.title = `BRZER ─ ${view.title}`;
}

/* --- 国政 --------------------------------------------------------- */

const natDom = () => ({
  meters: $('nat-meters'),
  treasury: $('nat-treasury'),
  fear: $('nat-fear'),
  output: $('nat-output'),
  left: $('nat-left'),
  warnings: $('nat-warnings'),
  decrees: $('nat-decrees'),
  standing: $('nat-standing'),
  corps: $('nat-corps'),
  rule: $('nat-rule'),
  council: $('nat-council'),
  petition: $('nat-petition'),
  tabs: $('nat-tabs'),
});

// 国政の頁。六節を縦に積むと、携帯では上奏に辿り着くまでが遠すぎた。
let natPage = 'council';

function showNatPage(id) {
  natPage = id;
  for (const b of document.querySelectorAll('#nat-tabs .nattab')) {
    b.classList.toggle('is-on', b.dataset.nattab === id);
  }
  for (const sec of document.querySelectorAll('#nat-body [data-natpage]')) {
    sec.hidden = sec.dataset.natpage !== id;
  }
  const body = $('nat-body');
  if (body) body.scrollTop = 0;
}

/**
 * 国政の頁に貼り付ける要点。
 *
 * 政令の札には「国庫 −7」としか書いていない。その −7 が何から引かれるのかは
 * 頁の頭にしかなく、札を押す頃には巻き上がって見えていない ─
 * 値段だけ見せて残高を隠すのは、賭場の作法である。
 */
function drawNatSticky(view) {
  const el = $('nat-sticky');
  if (!el) return;
  const num = (label, value, low) =>
    `<span>${label}<b class="${low ? 'is-low' : ''}">${value}</b></span>`;
  const m = Object.fromEntries(view.meters.map((x) => [x.id, x]));
  el.innerHTML =
    num('国庫', view.treasury, view.treasury <= 8) +
    num('民心', m.morale?.value ?? '─', m.morale?.value <= 25) +
    num('統制', m.control?.value ?? '─', m.control?.value <= 25) +
    num('忠誠', m.loyalty?.value ?? '─', m.loyalty?.value <= 25) +
    `<span class="natsticky__left${view.left > 0 ? '' : ' is-done'}">今夜あと ${view.left} 件</span>` +
    (view.petition && !view.petition.answered
      ? '<span class="natsticky__todo">上奏 未決</span>' : '');
}

function drawNation() {
  if (!campaign?.nation) return;
  const view = getNationView(campaign);
  $('nat-name').textContent = view.name;
  $('nat-eyebrow').textContent = view.eyebrow;
  $('nat-blurb').textContent = view.blurb;

  drawNatSticky(view);

  renderNation(natDom(), view, getOfficerCorps(campaign), {
    onPick: (id) => { pickDecree(campaign, id); saveCampaign(campaign); drawNation(); audio.click(); },
    onUnpick: (id) => { unpickDecree(campaign, id); saveCampaign(campaign); drawNation(); audio.click(); },
    onLift: (id) => { stopStanding(campaign, id); saveCampaign(campaign); drawNation(); audio.click(); },
    onDecorate: (id) => { decorateIn(campaign, id); saveCampaign(campaign); drawNation(); audio.click(); },
    onPurge: (id, o) => askPurge(id, o),
    onPetition: (accept) => {
      answerPetition(campaign, accept);
      saveCampaign(campaign);
      drawNation();
      drawCampaign();
      audio.click();
    },
    onPurgeMinister: (blocId, b) => askMinisterPurge(blocId, b),
  });
  showNatPage(natPage);
}

function openNation() {
  if (!campaign) return;
  // 開いたときに見せる頁は、まだ決めていないことがある所にする ─
  // 未決の上奏や通告を、遊び手が探しに行かなくてよいように。
  const view = getNationView(campaign);
  natPage =
    view.warnings.length || (view.petition && !view.petition.answered) ? 'council'
      : view.left > 0 ? 'decree' : natPage;
  drawNation();
  showView('view-nation');
}

$('nat-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.nattab');
  if (!b) return;
  showNatPage(b.dataset.nattab);
  audio.click();
});

/**
 * 粛清には一手を挟む。
 * 取り返しがつかないものを、指が滑って実行できてはいけない。
 */
function askPurge(unitId, o) {
  confirmAction(
    '粛清',
    `${o.name} ${o.rank}（${o.callsign}）を除く。
` +
      `${o.battles}戦を戦い、${o.traits.length ? `「${o.traits.join('・')}」を持つ` : '特性は無い'}。
` +
      `統制 +${o.cost.control} ／ 忠誠 ${o.cost.loyalty} ／ 民心 ${o.cost.morale}。
` +
      '経歴も特性も戻らない。代わりに来るのは、忠誠だけは高い者である。',
    () => {
      purgeIn(campaign, unitId);
      saveCampaign(campaign);
      drawNation();
      drawCampaign();
    }
  );
}

/**
 * 更迭にも一手を挟む。
 * 省庁を空にするのは、将校を一人除くより後で効いてくる決定である。
 */
function askMinisterPurge(blocId, b) {
  confirmAction(
    '更迭',
    `${b.post} ${b.minister} を除き、逆らわない者を座らせる。
` +
      `${b.label}の離反通告は止まる。かわりにこの省庁は二度と働かない ─
` +
      `${b.gives}
` +
      `統制 +${b.cost.control} ／ 忠誠 ${b.cost.loyalty} ／ 民心 ${b.cost.morale} ／ 恐怖 増。
` +
      '残る三つの省庁は、次は自分だと考えはじめる。',
    () => {
      purgeMinister(campaign, blocId);
      saveCampaign(campaign);
      drawNation();
      drawCampaign();
    }
  );
}

let confirmFn = null;

function confirmAction(title, text, fn) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  confirmFn = fn;
  $('confirm').hidden = false;
  // 開いた瞬間に指が乗っているのは「やめる」側にしておく。
  // 取り返しのつかない側を既定にすれば、確認は儀式でしかない。
  $('confirm-no').focus();
}

function closeConfirm() {
  $('confirm').hidden = true;
  confirmFn = null;
}

const confirmOpen = () => !$('confirm').hidden;

// 幕を叩いても引き下がれる。逃げ道が「やめる」の一点しかない小窓は、
// 押し間違えた者を追い詰めるだけである。
$('confirm').addEventListener('click', (e) => {
  if (e.target !== $('confirm')) return;
  closeConfirm();
  audio.click();
});

/* --- 操作の早見 --------------------------------------------------- */
//
// ブリーフィングには読み込み直すまで戻れない。
// 覚え違いの一つで盤を捨てさせないために、戦闘中から開ける表を置いてある。

const helpOpen = () => !$('keyhelp').hidden;

function openHelp() {
  $('keyhelp').hidden = false;
  $('keyhelp-close').focus();
  audio.click();
}

function closeHelp() {
  $('keyhelp').hidden = true;
}

$('btn-help').addEventListener('click', () => (helpOpen() ? closeHelp() : openHelp()));
$('keyhelp-close').addEventListener('click', () => {
  closeHelp();
  audio.click();
});
$('keyhelp').addEventListener('click', (e) => {
  if (e.target === $('keyhelp')) closeHelp();
});

function openCampaign() {
  if (!campaign) campaign = loadCampaign() ?? newCampaign();
  drawCampaign();
  showView('view-campaign');
}

function beginCampaignStage() {
  const g = startCampaignBattle(campaign, { autoPlot: options.autoPlot });
  if (!g) return;
  saveCampaign(campaign);
  enterBattle(g, { creative: false });
}

/* ================================================================== */
/* 開始                                                                */
/* ================================================================== */

function readOptions() {
  options.variable = $('opt-variable').checked;
  options.voice = $('opt-voice').checked;
  options.creative = $('opt-creative').checked;
  options.autoPlot = $('opt-autoplot').checked;
  saveAutoPlot(options.autoPlot);
}

function startMission() {
  readOptions();
  campaign = null;

  // 敵の企図を変えるなら、下敷きに作った盤は捨てて作り直す
  const g =
    options.variable || options.creative || !previewGame ||
    previewGame.world.mission.id !== pickedMission
      ? createGame({
          variable: options.variable,
          missionId: pickedMission,
          creative: options.creative,
        })
      : previewGame;
  previewGame = null;
  enterBattle(g, { creative: options.creative });
}

/**
 * 盤を戦闘画面に載せる。
 * 単発の戦闘も戦役の一日も、ここから先は同じ道を通る。
 */
// 画面の部品と、その聞き手。
//
// createRoster / createRadioLog / createOrderPanel / createHud / attachMapInput は
// いずれも「戦闘が終わっても残る要素」に委譲で聞き手を結ぶ。
// 戦役では画面を読み込み直さずに二日目へ入るので、作り直せば聞き手が積み上がる ─
// 二日目は駒が2つ置かれ、取消が2手戻り、拡大が2段飛ぶ。
// だから部品を作るのは一度きりにして、以後は盤だけを差し替える。
let panelsBuilt = false;

function enterBattle(g, { creative = false } = {}) {
  game = g;
  setAutoPlot(game, options.autoPlot);
  syncAutoPlotButton();

  showView('view-game');
  audio.initAudio();
  audio.setVoiceEnabled(options.voice);
  audio.resume();

  mapView = createMapView($('map'), game);
  // 縦長の画面では、全体表示だと上下が大きく余る。最初から画面を満たしておく。
  if (isNarrow()) setZoom(mapView, coverZoom(mapView));

  if (panelsBuilt) {
    rebindRoster(rosterView, game);
    rebindOrderPanel(orderPanel, game);
    rebindHud(hud, game);
    clearLog(logView);
    unread = 0;
    $('tab-unread').hidden = true;
    hideMarkerEditor();
    $('map-hint').hidden = true;
    finishBattleWiring(creative);
    return;
  }
  panelsBuilt = true;

  buildToolbox();

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

  wireMap();
  wireTabs();
  wireSheet();
  wireZoom();

  finishBattleWiring(creative);
}

/** 盤ごとに毎回やること（聞き手を結ばない部分） */
function finishBattleWiring(creative) {
  // 演習の釦は演習の盤にしか出ない
  $('btn-reveal').hidden = !isCreative(game);
  $('btn-reveal').classList.toggle('is-on', !!getCreative(game)?.reveal);
  document.body.classList.toggle('is-drill', creative);

  // 半日の戦闘では、静穏を飛ばすための x8 を出す
  $('speed-8').hidden = !isLongBattle(game);

  // H時前。時計は止まっており、部下はまだ目の前にいる。
  syncPlanBar();
  game.running = !isPlanning(game);
  game.speed = 1;
  lastFrame = performance.now();
  if (rafId) cancelAnimationFrame(rafId);
  loop(lastFrame);
}

/** H時前の帯の出し入れ */
function syncPlanBar() {
  const on = isPlanning(game);
  $('planbar').hidden = !on;
  // 帯を畳んだまま次の戦闘へ持ち越さない。二日目もまず読ませる。
  if (on) $('planbar').classList.remove('is-folded');
  document.body.classList.toggle('is-planning', on);
  $('clock').classList.toggle('is-planning', on);
  document.querySelector('.speed').classList.toggle('is-off', on);
  // H時前の速さの釦は本当に効かない。薄く見えているものを押しただけで、
  // 命令が自由で歪まない唯一の時間が終わるようでは、道具として裏切っている。
  for (const b of document.querySelectorAll('.speed .speed__btn')) b.disabled = on;
}

/** H時を宣言する。ここから先は無線だけになる。 */
function declareHHour() {
  if (!game || !isPlanning(game)) return;
  startClock(game);
  syncPlanBar();
  audio.click();
  showToast(
    'H時',
    '時計が回り始めた。ここから先、部下と貴官を繋ぐのは無線だけである。',
    false
  );
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
  // 使えない釦には、使えない理由を持たせておく（押されたときに読み上げるため）
  const nothingToUndo = !canUndo(game);
  const undoTitle = nothingToUndo ? '取り消せる書き込みが無い' : '取り消し (Ctrl+Z)';
  $('btn-undo').disabled = nothingToUndo;
  $('btn-undo').title = undoTitle;
  $('btn-undo-map').disabled = nothingToUndo;
  $('btn-undo-map').title = nothingToUndo ? undoTitle : '最後の書き込みを取り消す';
  draw(mapView);

  if (game.finished) {
    hideMarkerEditor();
    $('map-hint').hidden = true;
    // 戦闘が終わっているのに、読みかけの無線が講評まで喋り続けるのはおかしい
    audio.stopSpeaking();
    cancelAnimationFrame(rafId);
    rafId = null;
    // 戦役なら、この一戦を帳簿に取り込む（損害も経歴も、ここで確定する）
    if (game.campaign) finishCampaignBattle(game);

    setTimeout(() => {
      showView('view-debrief');
      $('btn-nextday').hidden = !game.campaign;
      $('btn-again').hidden = !!game.campaign;
      showDebrief(
        {
          verdict: $('debrief-verdict'),
          reason: $('debrief-reason'),
          canvas: $('truthmap'),
          stats: $('debrief-stats'),
          units: $('debrief-units'),
          gap: $('debrief-gap'),
          gapBlock: $('debrief-gap-block'),
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
  // H時前に速さを触っても、時計は回らない。
  // H時の宣言は「H時」の釦だけが行う ─ 命令が無線に乗らず歪まない唯一の時間を、
  // 押した覚えのない釦で終わらせてはならない。
  if (isPlanning(game)) {
    showToast(
      '指揮所',
      'H時前は時計が止まっている。渡し終えたら「H時」を宣言せよ。',
      false
    );
    return;
  }
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
  // 記録簿は閉じない。行を叩くのは「読みながら位置を確かめる」動作であって、
  // 読むのをやめる動作ではない ─ 釦を外した指で頁ごと消えるのが一番こたえる。
  audio.click();
}

/**
 * 「聞いたとおりに」記号を置く。
 * 置かれるのは報告された位置であって、実際の位置ではない ─ そこが肝である。
 */
function markFromReport(entry) {
  // 自動記入と同じ道を通す。同じ敵の続報なら駒が増えず、その駒が動く。
  const m = plotContact(game, entry, { manual: true });
  if (!m) return;

  mapView.selectedMarkId = m.id;
  flashGrid(mapView, m.x, m.y);
  if (!isWellVisible(mapView, m.x, m.y)) centerOn(mapView, m.x, m.y, Math.max(mapView.zoom, 1.8));
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
  const undoOnce = () => {
    // 取り消すと記号が入れ替わる。開いたままのラベル欄は、もう無い記号を掴んでいる。
    hideMarkerEditor();
    if (mapView) mapView.selectedMarkId = null;
    if (undo(game)) audio.click();
  };
  $('btn-undo').addEventListener('click', undoOnce);
  // 地図の脇にも同じ釦を出してある。道具箱は携帯では畳まれているので、
  // 指で置き間違えた記号を消すのに三手かかっていた。
  $('btn-undo-map').addEventListener('click', undoOnce);
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

  // 画面の高さだけが変わるのは、たいてい画面の向きの話ではない ─
  // ソフトキーボードが上がったか、住所欄が引っ込んだかである。
  // それでラベル欄を閉じていたので、Android では記号に自分で名前を付けられなかった
  // （見本の札しか使えない）。ついでに図面まで動いていた。
  let lastViewW = window.visualViewport?.width ?? window.innerWidth;
  window.addEventListener('resize', () => {
    const w = window.visualViewport?.width ?? window.innerWidth;
    const heightOnly = Math.abs(w - lastViewW) < 2;
    lastViewW = w;

    resize(mapView);
    if (heightOnly) return;
    // 向きや大きさが変わったら、まだ自分で拡大していない人には
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
    const before = panelState(orderPanel).verb;
    submitOrder(orderPanel);
    // 断られた命令はそのまま手元に残る。理由は命令の頁に書かれるが、
    // 携帯ではその頁が地図の裏に退いている ─ 押した指の前に出さないと、
    // 「押しても何も起きない」としか映らない。
    if (!isCreative(game) && before && panelState(orderPanel).verb === before) {
      showToast('指揮所', $('order-status').textContent, true);
    }
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
  // 小窓が開いている間は、その小窓が鍵盤を握る。
  // Esc で消したいのは目の前の確認であって、組みかけの命令ではない。
  if (confirmOpen()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeConfirm();
    }
    return;
  }
  if (helpOpen()) {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      closeHelp();
    }
    return;
  }
  // 早見表。どの画面からでも開く ─ 忘れた時に開けなければ表の意味がない。
  if ((e.key === '?' || (e.key === '/' && e.shiftKey)) && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    openHelp();
    return;
  }

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
      // H時前の空白は「一時停止の解除」ではない。宣言は釦だけが行う。
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
    case 'a': case 'A':
      toggleAutoPlot();
      break;
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

$('btn-autoplot').addEventListener('click', toggleAutoPlot);

// 演習の「真実の地図」。押した瞬間に霧が晴れる ─ 本編には無い釦である。
$('btn-reveal').addEventListener('click', () => {
  if (!game || !isCreative(game)) return;
  const res = creativeAction(game, { action: 'reveal' });
  $('btn-reveal').classList.toggle('is-on', !!getCreative(game)?.reveal);
  showToast('演習統裁', res.text, false);
  audio.click();
});

/* --- 戦役の結線 ---------------------------------------------------- */

function buildCampaignPicker() {
  const wrap = $('campaign-pick');
  wrap.innerHTML = '';
  const saved = loadCampaign();

  for (const c of campaignList()) {
    const b = document.createElement('button');
    b.className = 'missionpick__opt';
    b.dataset.campaign = c.id;
    const t = document.createElement('b');
    t.textContent = c.title;
    const tag = document.createElement('i');
    tag.className = 'missionpick__tag';
    tag.textContent = `${c.stages.length}日間 ─ 連続作戦`;
    t.appendChild(tag);
    const line = document.createElement('em');
    line.textContent = saved && saved.campaignId === c.id && !saved.finished
      ? `途中まで進んでいる（${saved.stage + 1}日目から／戦線 ${Math.round(saved.front)}）`
      : c.stages.map((st) => st.title).join(' → ');
    const note = document.createElement('span');
    note.textContent = c.blurb;
    b.append(t, line, note);
    wrap.appendChild(b);
  }

  // 更新内容への入口。ここに置くのが一番目に入る。
  const nb = document.createElement('button');
  nb.className = 'btn notesbtn';
  nb.id = 'btn-notes';
  // 入口の札は、開いた先の見出しと同じものにする ─
  // 違う番号が書いてあると、押した先が古い頁だと思われる。
  nb.textContent = '更新内容 v4.0「評議会」';
  wrap.appendChild(nb);
}

$('campaign-pick').addEventListener('click', (e) => {
  if (e.target.closest('#btn-notes')) {
    showView('view-notes');
    audio.click();
    return;
  }
  const b = e.target.closest('button[data-campaign]');
  if (!b) return;
  readOptions();
  const saved = loadCampaign();
  campaign = saved && saved.campaignId === b.dataset.campaign && !saved.finished
    ? saved
    : newCampaign(b.dataset.campaign);
  saveCampaign(campaign);
  openCampaign();
  audio.click();
});

$('btn-notes-back').addEventListener('click', () => {
  showView('view-briefing');
  audio.click();
});

$('btn-sortie').addEventListener('click', () => {
  audio.initAudio();
  audio.setVoiceEnabled(options.voice);

  // 夜の権限を残したまま出るのは、それ自体が一つの決定である ─
  // 特に上奏は、答えなければ退けたことになる。黙って持って行かせない。
  const notes = unspentNotes(getCampaignView(campaign));
  if (notes.length) {
    confirmAction(
      'このまま配置につく',
      `${notes.join('\n')}\nここを出れば、今夜はもう戻れない。`,
      beginCampaignStage
    );
    audio.click();
    return;
  }
  beginCampaignStage();
});

$('btn-abandon').addEventListener('click', () => {
  const view = getCampaignView(campaign);
  if (view?.finished) {
    campaign = newCampaign(campaign.campaignId);
    saveCampaign(campaign);
    buildCampaignPicker();
    drawCampaign();
    audio.click();
    return;
  }
  // 三日ぶんの損害・経歴・国の状態が、この一押しで消える。
  // 将校一人を除くのに一手を挟むなら、戦役ごと捨てるのにも挟まねばならない。
  confirmAction(
    '戦役をやめる',
    `${view?.title ?? '戦役'} ─ ${(view?.stageIndex ?? 0) + 1}日目までの記録を消す。\n` +
      '倒れた者も、生き延びた者の経歴も、国の状態も戻らない。\n' +
      '続きから戦うことはできなくなる。',
    () => {
      clearCampaign();
      campaign = null;
      buildCampaignPicker();
      showView('view-briefing');
    }
  );
  audio.click();
});

$('btn-govern').addEventListener('click', () => {
  openNation();
  audio.click();
});

$('btn-nat-back').addEventListener('click', () => {
  drawCampaign();
  showView('view-campaign');
  audio.click();
});

$('confirm-no').addEventListener('click', () => {
  closeConfirm();
  audio.click();
});

$('confirm-yes').addEventListener('click', () => {
  const fn = confirmFn;
  closeConfirm();
  fn?.();
  audio.click();
});

$('btn-nextday').addEventListener('click', () => {
  audio.stopSpeaking();
  openCampaign();
  audio.click();
});

$('btn-hhour').addEventListener('click', declareHHour);

// H時前の帯を畳む。読み終えた文章のために、図面の下端を取り上げ続けない。
$('planbar-fold').addEventListener('click', () => {
  const bar = $('planbar');
  const folded = bar.classList.toggle('is-folded');
  $('planbar-fold').textContent = folded ? '▸' : '▾';
  $('planbar-fold').title = folded ? '説明を出す' : 'この帯を畳む';
  document.body.classList.toggle('is-planbar-folded', folded);
  audio.click();
});

/**
 * 押せない釦を押したときに、なぜ押せないのかを言う。
 *
 * 理由は title に書いてあるが、指には吹き出しが出ない ─
 * 触屏では「反応しない釦」と「壊れた釦」の区別が付かない。
 * 使えない釦は click を出さないので、指の下にある要素から拾う。
 */
document.addEventListener('pointerdown', (e) => {
  if (!$('view-game').classList.contains('is-active')) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const btn = el?.closest?.('button:disabled');
  if (!btn) return;
  // 速さの釦は、押せない理由が釦の説明ではなく局面のほうにある。
  const why = btn.closest('.speed')
    ? 'H時前は時計が止まっている。渡し終えたら「H時」を宣言せよ。'
    : btn.title?.trim();
  if (!why) return;
  // 命令の頁にも書くが、携帯ではその頁が地図の裏にいる。
  // 目に入るのは地図の上の掲示のほうである。
  $('order-status').textContent = why;
  showToast('指揮所', why, false);
}, true);

// 検査用の窓口。?debug=1 のときだけ出す（本番の遊びには一切関わらない）。
// 盤も戦役も getter で覗く ─ 戦闘に入る前の画面でも見えている必要がある。
if (new URLSearchParams(location.search).has('debug')) {
  window.__brzer = {
    get game() { return game; },
    get mapView() { return mapView; },
    get campaign() { return campaign; },
    tool,
    state: stateApi,
  };
}

syncAutoPlotButton();
buildCampaignPicker();
fillBriefing();
