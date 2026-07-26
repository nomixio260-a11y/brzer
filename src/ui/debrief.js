// 戦闘後の答え合わせ。
// ここで初めて真実の地図を開く。「自分がどれだけ間違った絵を見ていたか」を突きつける。

import { WORLD, toGrid, gridLetter, formatClock } from '../util.js';
import {
  getOutcome,
  getMarkers,
  getTerrain,
  revealTruth,
  MARKER_TYPES,
  CONFIDENCE,
} from '../state.js';
import { createMapViewBase } from './basemap.js';

const VERDICT = {
  victory: { label: '任 務 達 成', cls: 'is-victory' },
  narrow: { label: '辛 勝', cls: 'is-narrow' },
  defeat: { label: '任 務 失 敗', cls: 'is-defeat' },
};

export function showDebrief(dom, game) {
  const outcome = getOutcome(game);
  const truth = revealTruth(game);
  if (!outcome || !truth) return;

  const v = VERDICT[outcome.status] ?? VERDICT.defeat;
  dom.verdict.textContent = v.label;
  dom.verdict.className = `debrief__verdict ${v.cls}`;
  dom.reason.textContent = outcome.reason;

  drawTruthMap(dom.canvas, game, truth);
  renderStats(dom.stats, outcome.score, truth);
  renderUnitFates(dom.units, truth);
}

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
  // 記号は画面上で一定の大きさにしたい。世界座標系の中で px 指定するための換算。
  const px = (n) => n / scale;

  ctx.fillStyle = '#090b0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, WORLD.width, WORLD.height);

  // 地図を暗く沈めて、その上に載る情報を読みやすくする
  ctx.fillStyle = 'rgba(9, 11, 12, 0.42)';
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);

  // グリッド
  ctx.strokeStyle = 'rgba(210, 220, 215, 0.14)';
  ctx.lineWidth = px(1);
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

  ctx.fillStyle = 'rgba(205, 214, 210, 0.3)';
  ctx.font = `500 ${px(9)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let c = 0; c < WORLD.gridCols; c++) {
    for (let r = 0; r < WORLD.gridRows; r++) {
      ctx.fillText(gridLetter(c) + (r + 1), c * WORLD.gridSize + px(3), r * WORLD.gridSize + px(3));
    }
  }

  // --- 指揮官が描いたマーカー（点線・琥珀色） ---
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const m of getMarkers(game)) {
    const spec = MARKER_TYPES[m.type] ?? MARKER_TYPES.note;
    const conf = CONFIDENCE[m.confidence] ?? CONFIDENCE.estimated;
    ctx.strokeStyle = 'rgba(224, 163, 60, 0.95)';
    ctx.lineWidth = px(1.6);
    ctx.setLineDash(conf.dash ? conf.dash.map((n) => px(n)) : [px(4), px(3)]);
    ctx.beginPath();
    ctx.arc(m.x, m.y, px(13), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    outlined(ctx, m.label || spec.label, m.x, m.y - px(19), '#e0a33c', px(9));
  }

  // --- 実際にいた部隊 ---
  for (const u of truth.units) {
    if (u.evacuated) continue;
    const dead = !u.alive;
    let color = '#4d9de0';
    if (u.side === 'enemy') color = '#e2504a';
    if (u.side === 'civilian') color = '#c9c2b5';
    if (dead) color = '#6c7573';

    ctx.save();
    ctx.translate(u.x, u.y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    if (dead) {
      ctx.lineWidth = px(2);
      ctx.beginPath();
      ctx.moveTo(-px(7), -px(7));
      ctx.lineTo(px(7), px(7));
      ctx.moveTo(px(7), -px(7));
      ctx.lineTo(-px(7), px(7));
      ctx.stroke();
    } else {
      ctx.lineWidth = px(1.8);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(-px(9), -px(6), px(18), px(12));
      ctx.globalAlpha = 1;
      ctx.strokeRect(-px(9), -px(6), px(18), px(12));
    }

    outlined(ctx, u.callsign, 0, px(15), color, px(9.5));
    ctx.restore();
  }

  ctx.restore();
}

/** 縁取りつきの文字（背景が何色でも読める） */
function outlined(ctx, text, x, y, color, size) {
  ctx.save();
  ctx.font = `500 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = size * 0.34;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6, 8, 9, 0.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/* ------------------------------------------------------------------ */

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
    ['平均応答時間', score.avgResponse ? `${Math.round(score.avgResponse)} 秒` : '─',
      score.avgResponse > 60 ? 'is-bad' : ''],
    ['砲撃要請', `${score.fireMissions} 回（残弾 ${score.artilleryLeft}）`, ''],
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

    li.append(name, fate);
    el.appendChild(li);
  }
}
