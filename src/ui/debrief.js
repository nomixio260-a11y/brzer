// 戦闘後の答え合わせ。
// ここで初めて真実の地図を開く。「自分がどれだけ間違った絵を見ていたか」を突きつける。

import { WORLD, toGrid, gridLetter, formatClock } from '../util.js';
import {
  getReportGap,
  getOutcome,
  getMarkers,
  getTerrain,
  revealTruth,
  isCreative,
  MARKER_TYPES,
  CONFIDENCE,
} from '../state.js';
import { createMapViewBase } from './basemap.js';
import { drawSymbol, drawObstacle, drawObjective } from './milsymbol.js';

const VERDICT = {
  victory: { label: '任 務 達 成', cls: 'is-victory' },
  narrow: { label: '辛 勝', cls: 'is-narrow' },
  defeat: { label: '任 務 失 敗', cls: 'is-defeat' },
};

// 最後に描いた真実の地図。
// 図は一度きり clientWidth から起こしているので、端末を横にすると縦横比が崩れたまま
// 残っていた ─ 講評は読む画面であり、読む間に持ち替えるのは普通のことである。
let lastTruth = null;

export function showDebrief(dom, game) {
  const outcome = getOutcome(game);
  const truth = revealTruth(game);
  if (!outcome || !truth) return;
  const gap = getReportGap(game);

  const v = VERDICT[outcome.status] ?? VERDICT.defeat;
  dom.verdict.textContent = isCreative(game) ? `${v.label}（演習）` : v.label;
  dom.verdict.className = `debrief__verdict ${v.cls}`;
  dom.reason.textContent = isCreative(game)
    ? `${outcome.reason} ── 演習モードの盤である。弾は減らず、味方はほとんど倒れなかった。記録には残らない。`
    : outcome.reason;

  lastTruth = { canvas: dom.canvas, game, truth };
  drawTruthMap(dom.canvas, game, truth);
  renderStats(dom.stats, outcome.score, truth);
  renderUnitFates(dom.units, truth);
  renderReportGap(dom.gap, dom.gapBlock, gap);
  renderEnemyIntent(dom.enemy, truth);
}

/**
 * 敵指揮官の決心。
 * どこで予備を投じ、どこを諦めたか ─ 自分の守りが敵に何をさせたかが分かる。
 */
function renderEnemyIntent(el, truth) {
  if (!el) return;
  el.innerHTML = '';
  const log = truth.enemyIntent ?? [];
  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'is-quiet';
    li.textContent = '敵は当初計画のまま押し切ろうとした。決心を変える必要がなかったということである。';
    el.appendChild(li);
    return;
  }
  for (const e of log) {
    const li = document.createElement('li');
    const t = document.createElement('b');
    t.textContent = formatClock(e.at);
    const s = document.createElement('span');
    s.textContent = e.text;
    li.append(t, s);
    el.appendChild(li);
  }
}

// 画面の幅が変われば、図も引き直す。
// 描き直しは重いので、大きさが実際に変わったときだけにする。
let redrawTimer = null;
window.addEventListener('resize', () => {
  if (!lastTruth) return;
  if (!lastTruth.canvas.closest('.view')?.classList.contains('is-active')) return;
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    if (!lastTruth) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const want = Math.round((lastTruth.canvas.clientWidth || 720) * dpr);
    if (Math.abs(want - lastTruth.canvas.width) < 2) return;
    drawTruthMap(lastTruth.canvas, lastTruth.game, lastTruth.truth);
  }, 180);
});

/* ------------------------------------------------------------------ */

function drawTruthMap(canvas, game, truth) {
  const terrain = getTerrain(game);
  const base = createMapViewBase(terrain);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = canvas.clientWidth || 720;
  const cssHeight = Math.round((cssWidth * WORLD.height) / WORLD.width);
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);

  const ctx = canvas.getContext('2d');
  const scale = canvas.width / WORLD.width;
  // 記号は画面上で一定の大きさにしたい。scale はデバイスピクセル基準なので
  // dpr を掛けてから割る（掛けないと高精細画面で半分になる）。
  const px = (n) => (n * dpr) / scale;

  ctx.fillStyle = '#15120f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, 0, 0, WORLD.width, WORLD.height);

  // 方眼
  ctx.strokeStyle = 'rgba(52, 74, 96, 0.3)';
  ctx.lineWidth = px(0.7);
  ctx.beginPath();
  for (let c = 0; c <= WORLD.gridCols; c++) {
    ctx.moveTo(c * WORLD.gridSize, 0);
    ctx.lineTo(c * WORLD.gridSize, WORLD.height);
  }
  for (let r = 0; r <= WORLD.gridRows; r++) {
    ctx.moveTo(0, r * WORLD.gridSize);
    ctx.lineTo(WORLD.width, r * WORLD.gridSize);
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(38, 60, 82, 0.55)';
  ctx.font = `600 ${px(7.5)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let c = 0; c < WORLD.gridCols; c++) {
    for (let r = 0; r < WORLD.gridRows; r++) {
      ctx.fillText(gridLetter(c) + (r + 1), c * WORLD.gridSize + px(2.5), r * WORLD.gridSize + px(2));
    }
  }

  // --- 貴官が書き込んだ記号（点線・薄い） ---
  for (const m of getMarkers(game)) {
    const spec = MARKER_TYPES[m.type] ?? MARKER_TYPES.note;
    const conf = CONFIDENCE[m.confidence] ?? CONFIDENCE.estimated;
    if (spec.graphic === 'obstacle') {
      drawObstacle(ctx, m.x, m.y, px(9), spec.color, px(1.4), 0.55);
    } else if (spec.graphic === 'objective') {
      drawObjective(ctx, m.x, m.y, px(9), spec.color, px(1.4), 0.55);
    } else if (!spec.graphic) {
      drawSymbol(ctx, {
        x: m.x, y: m.y, r: px(9),
        affiliation: spec.affiliation, icon: spec.icon, color: spec.color,
        lineWidth: px(1.4),
        dash: conf.dash ? conf.dash.map((n) => px(n)) : [px(5), px(3)],
        alpha: 0.55, hand: true, seed: m.x | 0,
      });
    }
  }

  // --- 実際にいた部隊（実線・濃い） ---
  for (const u of truth.units) {
    if (u.evacuated) continue;
    const dead = !u.alive;
    const spec = TRUTH_SYMBOL[u.typeLabel] ?? { affiliation: 'unknown', icon: null };
    const affiliation = u.side === 'enemy' ? 'hostile' : u.side === 'civilian' ? 'neutral' : 'friend';
    const color = dead ? '#5f574c' : undefined;

    drawSymbol(ctx, {
      x: u.x, y: u.y, r: px(10),
      affiliation, icon: spec.icon, color,
      lineWidth: px(1.8), alpha: dead ? 0.75 : 1, fillFrame: !dead,
    });

    if (dead) {
      ctx.save();
      ctx.strokeStyle = '#8a2f26';
      ctx.lineWidth = px(1.8);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(u.x - px(11), u.y - px(9));
      ctx.lineTo(u.x + px(11), u.y + px(9));
      ctx.moveTo(u.x + px(11), u.y - px(9));
      ctx.lineTo(u.x - px(11), u.y + px(9));
      ctx.stroke();
      ctx.restore();
    }

    outlined(ctx, u.callsign, u.x, u.y + px(19), dead ? '#7a6f62' : affiliation === 'hostile' ? '#8f231d' : '#123a75', px(8.5));
  }

  ctx.restore();
}

// 真実の部隊を、兵科どおりの記号で描くための対応表
const TRUTH_SYMBOL = {
  '歩兵分隊': { icon: 'infantry' },
  '対戦車班': { icon: 'antitank' },
  '偵察班': { icon: 'recon' },
  '機械化歩兵': { icon: 'mech' },
  '戦車': { icon: 'armor' },
  '迫撃砲班': { icon: 'mortar' },
  '偵察ドローン': { icon: 'uav' },
  '車列': { icon: 'civilian' },
};

/** 縁取りつきの文字（背景が何色でも読める） */
function outlined(ctx, text, x, y, color, size) {
  ctx.save();
  ctx.font = `500 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = size * 0.42;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(233, 234, 212, 0.92)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/* ------------------------------------------------------------------ */

/**
 * 装甲戦闘の戦果を、抜いた面ごとに出す。
 *
 * 側面と背面の数が多いほど、対戦車部隊の置き方が上手かったということである。
 * 「命中したが効果なし」の回数も並べる ─ 正面から撃たせていた回数だから。
 */
function armorRow(a) {
  if (!a) return [];
  const k = a.kills ?? { front: 0, side: 0, rear: 0 };
  const total = k.front + k.side + k.rear;
  if (!total && !a.mobility && !a.bounces) return [];

  const parts = [];
  if (total) {
    const flank = k.side + k.rear;
    parts.push(
      `${total} 両撃破（正面 ${k.front}・側面 ${k.side}・背面 ${k.rear}）` +
      (flank > k.front ? ' ─ 横腹を取れていた' : k.front ? ' ─ 正面から押し切った' : '')
    );
  }
  if (a.mobility) parts.push(`${a.mobility} 両を行動不能に`);
  if (a.bounces) parts.push(`弾かれた射撃 ${a.bounces} 回`);

  return [['装甲戦闘', parts.join('／'), total ? 'is-good' : a.bounces > 4 ? 'is-bad' : '']];
}

/**
 * 聞いていたことと、起きていたこと。
 *
 * 二列を並べるだけにしてある。矢印も、「だから」も、評価も置かない ─
 * 因果は指揮官が結ぶ。結ばせることが講評の仕事である。
 */
function renderReportGap(el, block, rows) {
  if (!el || !block) return;
  const shown = rows.filter((r) => r.gap);
  block.hidden = shown.length === 0;
  if (!shown.length) return;

  el.innerHTML = '';
  for (const r of shown) {
    const li = document.createElement('li');
    const name = document.createElement('b');
    name.textContent = r.callsign;

    const said = document.createElement('span');
    said.className = 'reportgap__said';
    said.textContent = `${formatClock(r.at)}「${r.said}・${r.saidMorale}」`;

    const real = document.createElement('span');
    real.className = 'reportgap__real';
    real.textContent = r.alive
      ? `${r.truth}・${r.truthMorale}`
      : `戦闘不能（${formatClock(r.deathAt)}）`;
    if (!r.alive) real.classList.add('is-dead');

    li.append(name, said, real);
    el.appendChild(li);
  }
}

/** 報告がどれだけ甘かったか。数字ではなく、何が起きていたかで言う。 */
function fearJa(f) {
  if (f < 0.2) return 'おおむね正直だった';
  if (f < 0.4) return '損害がやや小さく上がっていた';
  if (f < 0.62) return '損害は実際の半分ほどで報告されていた';
  return '誰も本当のことを言っていなかった';
}

function renderStats(el, score, truth) {
  el.innerHTML = '';
  if (!score) return;

  const civ = truth.units.filter((u) => u.side === 'civilian');
  const civSafe = civ.length ? civ.every((u) => u.evacuated || u.losses < 1) : null;

  const rows = [
    ['自軍の損害', `${score.losses} 名／両`, score.losses > 18 ? 'is-bad' : ''],
    ['敵に与えた損害', `${score.enemyLosses} 名／両`, score.enemyLosses > 6 ? 'is-good' : ''],
    ['民間人の被害', civSafe === null ? '─' : civSafe ? 'なし' : `${score.civilianLosses} 両`,
      civSafe === false ? 'is-bad' : civSafe ? 'is-good' : ''],
    ['同士討ち', score.friendlyFireUnits > 0 ? `${score.friendlyFireUnits} 個部隊` : 'なし',
      score.friendlyFireUnits > 0 ? 'is-bad' : 'is-good'],
    ['発令した命令', `${score.ordersIssued} 件`, ''],
    ['拒否された命令', `${score.ordersRefused} 件`, score.ordersRefused > 2 ? 'is-bad' : ''],
    ['渡した予令', score.heldOrders
      ? `${score.heldOrders} 件（うち ${score.heldOrdersFired} 件が発動）`
      : 'なし', score.heldOrdersFired > 0 ? 'is-good' : ''],
    ['部下の独断後退', score.selfWithdrawals ? `${score.selfWithdrawals} 個部隊` : 'なし', ''],
    // 恐怖の下では、この盤に届いていた数字が甘かった。
    // それを知るのは、真実が開いたこの画面だけである。
    ...(score.fear > 0.08
      ? [['貴官が受けていた報告', fearJa(score.fear), score.fear > 0.4 ? 'is-bad' : '']]
      : []),
    ['平均応答時間', score.avgResponse ? `${Math.round(score.avgResponse)} 秒` : '─',
      score.avgResponse > 60 ? 'is-bad' : ''],
    ['砲撃要請', score.registeredMissions
      ? `${score.fireMissions} 回（うち概定射点 ${score.registeredMissions} 回・残弾 ${score.artilleryLeft}）`
      : `${score.fireMissions} 回（残弾 ${score.artilleryLeft}）`, ''],
    ...(score.dangerClose
      ? [['危近弾', `${score.dangerClose} 回 ─ 味方の至近に落とすと告げられた上で撃った`, 'is-bad']]
      : []),
    ...(score.checkFires ? [['射撃中止', `${score.checkFires} 回`, '']] : []),
    ...(score.illumUsed ? [['照明弾', `${score.illumUsed} 発（残 ${score.illumLeft}）`, 'is-good']] : []),
    ...armorRow(score.armor),
    ['無線の占有率', `${Math.round(score.airtimeRatio * 100)} %`,
      score.airtimeRatio > 0.55 ? 'is-bad' : ''],
    ['届かなかった交信', `${score.droppedTransmissions} 回`,
      score.droppedTransmissions > 6 ? 'is-bad' : ''],
  ];

  for (const [k, v, cls] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (cls) dd.className = cls;
    el.append(dt, dd);
  }
}

function renderUnitFates(el, truth) {
  el.innerHTML = '';
  for (const u of truth.units) {
    if (u.side !== 'friend') continue;
    const li = document.createElement('li');

    const name = document.createElement('b');
    name.textContent = u.callsign;

    const fate = document.createElement('span');
    // 戦役では、誰が率いていて何を付けていたかまで残す。
    // 呼出符号だけでは、明日その分隊を立て直すかどうかの判断ができない。
    const tag = [u.officer, u.attach].filter(Boolean).join(' ／ ');
    if (!u.alive) {
      fate.className = 'is-dead';
      fate.textContent =
        `${toGrid(u.x, u.y)}で全滅（${formatClock(u.deathAt)}）` +
        (u.killedByFriendly ? ' ─ 味方の砲撃を受けた' : '');
    } else {
      fate.textContent =
        `${toGrid(u.x, u.y)} ・${Math.round(u.strength)}/${u.maxStrength}${u.unitJa} 健在` +
        (u.killedByFriendly ? ' ─ 味方の砲撃を受けた' : '');
    }

    if (tag) {
      const who = document.createElement('i');
      who.className = 'unitfate__who';
      who.textContent = tag;
      fate.appendChild(who);
    }

    li.append(name, fate);
    el.appendChild(li);
  }
}
