// 地図の描画。
//
// 重要: ここに描かれるのは「指揮官の手元にある紙の地図」と「指揮官が自分で
// 書き込んだもの」だけである。ユニットは敵味方を問わず一切描かない。

import { WORLD, toGrid, gridLetter, formatClock } from '../util.js';
import { riverCenterY } from '../sim/terrain.js';
import { createMapViewBase } from './basemap.js';
import {
  MARKER_TYPES,
  CONFIDENCE,
  markerFreshness,
  getTerrain,
  getSimTime,
  getCommandPost,
  getOwnFireMissions,
  getMarkers,
} from '../state.js';

export function createMapView(canvas, game) {
  const ctx = canvas.getContext('2d');
  const view = {
    canvas,
    ctx,
    game,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    base: null,
    hoverMarkerId: null,
    selectedMarkerId: null,
    targeting: false,
    cursor: null,
  };

  view.base = createMapViewBase(getTerrain(game));
  resize(view);
  return view;
}

/* ------------------------------------------------------------------ */
/* 座標変換                                                             */
/* ------------------------------------------------------------------ */

export function resize(view) {
  const rect = view.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.canvas.width = Math.max(1, Math.round(rect.width * dpr));
  view.canvas.height = Math.max(1, Math.round(rect.height * dpr));

  // 地図全体が収まるように等倍で嵌める（レターボックス）
  const sx = view.canvas.width / WORLD.width;
  const sy = view.canvas.height / WORLD.height;
  view.scale = Math.min(sx, sy);
  view.offsetX = (view.canvas.width - WORLD.width * view.scale) / 2;
  view.offsetY = (view.canvas.height - WORLD.height * view.scale) / 2;
  view.dpr = dpr;
}

export function toScreen(view, x, y) {
  return { x: x * view.scale + view.offsetX, y: y * view.scale + view.offsetY };
}

/** マウスイベント → 世界座標 */
export function toWorld(view, clientX, clientY) {
  const rect = view.canvas.getBoundingClientRect();
  const px = (clientX - rect.left) * view.dpr;
  const py = (clientY - rect.top) * view.dpr;
  return {
    x: (px - view.offsetX) / view.scale,
    y: (py - view.offsetY) / view.scale,
  };
}

export function isInsideMap(p) {
  return p.x >= 0 && p.y >= 0 && p.x <= WORLD.width && p.y <= WORLD.height;
}

/* ------------------------------------------------------------------ */
/* 描画                                                                */
/* ------------------------------------------------------------------ */

export function draw(view) {
  const { ctx, canvas, game } = view;
  const terrain = getTerrain(game);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#090b0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);

  // --- 地形ラスタ ---
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(view.base, 0, 0, WORLD.width, WORLD.height);

  drawRiver(ctx, terrain);
  drawRoads(ctx, terrain);
  drawCrossings(ctx, terrain);
  drawGrid(ctx, view);
  drawCommandPost(ctx, game);
  drawFireMissions(ctx, game);
  drawMarkers(ctx, view, game);
  drawTargetingCursor(ctx, view);

  ctx.restore();
}

function drawRiver(ctx, terrain) {
  // 河心をなぞって輪郭を強調する（ラスタだけだと境界が眠い）
  ctx.save();
  ctx.strokeStyle = 'rgba(120, 170, 205, 0.30)';
  ctx.lineWidth = terrain.riverHalfWidth * 2 + 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let x = 0; x <= WORLD.width; x += 40) {
    const y = riverCenterY(x);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(150, 200, 235, 0.5)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

function drawRoads(ctx, terrain) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const road of terrain.roads ?? []) {
    ctx.beginPath();
    road.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = 'rgba(30, 28, 24, 0.55)';
    ctx.lineWidth = 30;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(196, 182, 158, 0.55)';
    ctx.lineWidth = 12;
    ctx.stroke();
  }
  ctx.restore();
}

function drawCrossings(ctx, terrain) {
  ctx.save();

  // 橋
  const b = terrain.bridge;
  ctx.strokeStyle = '#d8c9a4';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(b.x - 95, b.y - 78);
  ctx.lineTo(b.x - 95, b.y + 78);
  ctx.moveTo(b.x + 95, b.y - 78);
  ctx.lineTo(b.x + 95, b.y + 78);
  ctx.stroke();

  label(ctx, '橋 ' + toGrid(b.x, b.y), b.x, b.y - 108, '#e6d9b8', 52);

  // 浅瀬
  const f = terrain.ford;
  ctx.strokeStyle = 'rgba(180, 220, 245, 0.75)';
  ctx.lineWidth = 7;
  ctx.setLineDash([26, 20]);
  ctx.beginPath();
  ctx.moveTo(f.x - 120, f.y - 60);
  ctx.lineTo(f.x - 120, f.y + 60);
  ctx.moveTo(f.x + 120, f.y - 60);
  ctx.lineTo(f.x + 120, f.y + 60);
  ctx.stroke();
  ctx.setLineDash([]);
  label(ctx, '浅瀬 ' + toGrid(f.x, f.y), f.x, f.y - 92, 'rgba(190, 226, 248, 0.9)', 48);

  ctx.restore();
}

function drawGrid(ctx, view) {
  ctx.save();
  ctx.strokeStyle = 'rgba(210, 220, 215, 0.13)';
  ctx.lineWidth = 1.5 / view.scale;
  ctx.beginPath();
  for (let c = 0; c <= WORLD.gridCols; c++) {
    const x = c * WORLD.gridSize;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD.height);
  }
  for (let r = 0; r <= WORLD.gridRows; r++) {
    const y = r * WORLD.gridSize;
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD.width, y);
  }
  ctx.stroke();

  // マス目の名前。無線で「F5」と言われて即座に指を置けることが最優先。
  ctx.fillStyle = 'rgba(205, 214, 210, 0.34)';
  ctx.font = `500 ${46}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let c = 0; c < WORLD.gridCols; c++) {
    for (let r = 0; r < WORLD.gridRows; r++) {
      ctx.fillText(gridLetter(c) + (r + 1), c * WORLD.gridSize + 10, r * WORLD.gridSize + 8);
    }
  }
  ctx.restore();
}

function drawCommandPost(ctx, game) {
  const cp = getCommandPost(game);
  ctx.save();
  ctx.strokeStyle = '#63c08a';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.rect(cp.x - 48, cp.y - 34, 96, 68);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cp.x - 48, cp.y - 34);
  ctx.lineTo(cp.x + 48, cp.y + 34);
  ctx.moveTo(cp.x + 48, cp.y - 34);
  ctx.lineTo(cp.x - 48, cp.y + 34);
  ctx.stroke();
  label(ctx, '指揮所', cp.x, cp.y + 82, '#63c08a', 46);
  ctx.restore();
}

/** 自分が要請した射撃だけを描く（どこに撃てと言ったかは指揮官が知っている） */
function drawFireMissions(ctx, game) {
  const now = getSimTime(game);
  ctx.save();
  for (const fm of getOwnFireMissions(game)) {
    const pending = now < fm.nextImpactAt && !fm.done;
    const recent = fm.done && now - (fm.completedAt ?? 0) < 90;
    if (!pending && !recent && !(!fm.done && fm.roundsLeft > 0)) continue;

    const color = fm.kind === 'smoke' ? 'rgba(200, 205, 210, 0.85)' : '#e2504a';
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.setLineDash([18, 14]);
    ctx.beginPath();
    ctx.arc(fm.x, fm.y, fm.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const eta = Math.max(0, Math.round(fm.nextImpactAt - now));
    const text = fm.done ? '射撃終了' : eta > 0 ? `弾着まで ${eta}秒` : '射撃中';
    label(ctx, `${fm.kind === 'smoke' ? '発煙' : '効力射'} ${text}`, fm.x, fm.y - fm.radius - 24, color, 44);
  }
  ctx.restore();
}

function drawMarkers(ctx, view, game) {
  const markers = getMarkers(game);
  ctx.save();
  for (const m of markers) {
    const spec = MARKER_TYPES[m.type] ?? MARKER_TYPES.note;
    const conf = CONFIDENCE[m.confidence] ?? CONFIDENCE.estimated;
    const fresh = markerFreshness(game, m);
    // 古い情報は薄れる ─ 「これはもう当てにならない」を目で分からせる
    const alpha = 0.32 + fresh * 0.68;
    const selected = view.selectedMarkerId === m.id;
    const hovered = view.hoverMarkerId === m.id;
    const R = 62;

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = selected ? 8 : 5;
    if (conf.dash) ctx.setLineDash(conf.dash.map((v) => v * 6));
    ctx.beginPath();
    ctx.arc(m.x, m.y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = spec.color;
    ctx.font = '600 62px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.glyph, m.x, m.y + 3);

    if (selected || hovered) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y, R + 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    const caption = m.label || spec.label;
    const age = Math.round((getSimTime(game) - m.updatedAt) / 60);
    const sub = age >= 1 ? `${caption} ・${age}分前` : caption;
    ctx.globalAlpha = alpha;
    label(ctx, sub, m.x, m.y + R + 34, spec.color, 42);
  }
  ctx.restore();
}

function drawTargetingCursor(ctx, view) {
  if (!view.targeting || !view.cursor) return;
  const { x, y } = view.cursor;
  ctx.save();
  ctx.strokeStyle = '#e0a33c';
  ctx.lineWidth = 4;
  ctx.setLineDash([14, 12]);
  ctx.beginPath();
  ctx.arc(x, y, 84, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x - 120, y);
  ctx.lineTo(x + 120, y);
  ctx.moveTo(x, y - 120);
  ctx.lineTo(x, y + 120);
  ctx.stroke();
  label(ctx, toGrid(x, y), x, y - 108, '#e0a33c', 58);
  ctx.restore();
}

function label(ctx, text, x, y, color, size) {
  ctx.save();
  ctx.font = `500 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = size * 0.18;
  ctx.strokeStyle = 'rgba(6, 8, 9, 0.85)';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** 指定した世界座標にあるマーカーを探す（当たり判定） */
export function markerAt(game, x, y) {
  const list = getMarkers(game);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (Math.hypot(m.x - x, m.y - y) <= 78) return m;
  }
  return null;
}

export { formatClock };
