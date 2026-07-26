// 地図の描画。
//
// 描かれるのは2枚だけである。
//   1枚目 ― 卓に広げた地形図（原図は basemap.js が刷る）
//   2枚目 ― その上に重ねたアセテートと、指揮官がチャイナグラフで書いた記号
//
// 部隊そのものは敵味方を問わず一切描かない。地図に載るのは、無線を聞いて
// 指揮官が自分の手で書き込んだものだけである。

import { WORLD, toGrid, gridLetter } from '../util.js';
import { riverCenterY } from '../sim/terrain.js';
import { createMapViewBase } from './basemap.js';
import { drawSymbol, drawObstacle, drawObjective } from './milsymbol.js';
import {
  MARKER_TYPES,
  CONFIDENCE,
  markerFreshness,
  sketchFreshness,
  getTerrain,
  getSimTime,
  getCommandPost,
  getOwnFireMissions,
  getRegistrations,
  getMarkers,
  getSketches,
  getVisibility as getVisibilityLabel,
} from '../state.js';

const INK = {
  road: '#c4622c',
  roadCasing: 'rgba(42, 34, 26, 0.75)',
  water: 'rgba(40, 104, 142, 0.9)',
  grid: 'rgba(52, 74, 96, 0.34)',
  gridLabel: 'rgba(38, 60, 82, 0.62)',
  sheetInk: 'rgba(36, 30, 22, 0.9)',
};

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;

export function createMapView(canvas, game) {
  const ctx = canvas.getContext('2d');
  const view = {
    canvas,
    ctx,
    game,
    // 表示範囲。zoom=1 で図面全体が収まる。
    zoom: 1,
    centerX: WORLD.width / 2,
    centerY: WORLD.height / 2,
    fitScale: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    dpr: 1,
    base: null,
    hoverMarkId: null,
    selectedMarkId: null,
    targeting: false,
    cursor: null,
    userZoomed: false, // 自分で倍率を変えたか（変えていれば勝手に戻さない）
    flash: null, // 無線報告から呼び出された方眼の点滅
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
  view.dpr = dpr;

  view.fitScale = Math.min(view.canvas.width / WORLD.width, view.canvas.height / WORLD.height);
  applyView(view);
}

/** zoom と中心から実際の変換を組み立て、図面の外へ流れないよう抑える */
function applyView(view) {
  view.zoom = clamp(view.zoom, ZOOM_MIN, ZOOM_MAX);
  view.scale = view.fitScale * view.zoom;

  const halfW = view.canvas.width / 2 / view.scale;
  const halfH = view.canvas.height / 2 / view.scale;

  view.centerX = WORLD.width <= halfW * 2 ? WORLD.width / 2 : clamp(view.centerX, halfW, WORLD.width - halfW);
  view.centerY = WORLD.height <= halfH * 2 ? WORLD.height / 2 : clamp(view.centerY, halfH, WORLD.height - halfH);

  view.offsetX = view.canvas.width / 2 - view.centerX * view.scale;
  view.offsetY = view.canvas.height / 2 - view.centerY * view.scale;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 画面上の一点を掴んだまま拡大する */
export function zoomAt(view, factor, clientX, clientY) {
  view.userZoomed = true;
  const before = clientX == null ? null : toWorld(view, clientX, clientY);
  view.zoom = clamp(view.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  applyView(view);
  if (before) {
    const after = toWorld(view, clientX, clientY);
    view.centerX += before.x - after.x;
    view.centerY += before.y - after.y;
    applyView(view);
  }
}

export function setZoom(view, zoom, { byUser = false } = {}) {
  if (byUser) view.userZoomed = true;
  view.zoom = zoom;
  applyView(view);
}

/** 画面上の移動量ぶん図面をずらす（CSSピクセル） */
export function panByScreen(view, dxCss, dyCss) {
  view.centerX -= (dxCss * view.dpr) / view.scale;
  view.centerY -= (dyCss * view.dpr) / view.scale;
  applyView(view);
}

/** 指定した世界座標を画面の中央に置く */
export function centerOn(view, x, y, zoom) {
  if (zoom != null) view.zoom = zoom;
  view.centerX = x;
  view.centerY = y;
  applyView(view);
}

/** その方眼が今どれくらい見えているか（自動で寄るかの判断に使う） */
export function isWellVisible(view, x, y) {
  const s = toScreen(view, x, y);
  const m = 60 * view.dpr;
  return s.x > m && s.y > m && s.x < view.canvas.width - m && s.y < view.canvas.height - m;
}

export function toScreen(view, x, y) {
  return { x: x * view.scale + view.offsetX, y: y * view.scale + view.offsetY };
}

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
  // 世界座標系の中で「画面上の n CSSピクセル」を指定するための換算。
  // view.scale はデバイスピクセル基準なので、dpr を掛けないと
  // 高精細画面で記号だけが半分の大きさになる。
  const px = (n) => (n * view.dpr) / view.scale;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#15120f'; // 卓の天板
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 紙が卓に落とす影
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 22 * view.dpr;
  ctx.shadowOffsetY = 4 * view.dpr;
  ctx.fillStyle = '#d9dcc0';
  ctx.fillRect(view.offsetX, view.offsetY, WORLD.width * view.scale, WORLD.height * view.scale);
  ctx.restore();

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);
  ctx.beginPath();
  ctx.rect(0, 0, WORLD.width, WORLD.height);
  ctx.clip();

  // ---- 1枚目: 地形図 ----
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(view.base, 0, 0, WORLD.width, WORLD.height);

  drawHydrography(ctx, terrain, px);
  drawRoads(ctx, terrain, px);
  drawCrossings(ctx, terrain, px);
  drawPlaceNames(ctx, terrain, px);
  drawGrid(ctx, px);
  drawNeatline(ctx, px);

  // ---- 2枚目: アセテート ----
  drawAcetateSheen(ctx);
  drawCommandPost(ctx, game, px);
  drawFireMissions(ctx, game, px);
  drawRegistrations(ctx, game, px);
  drawSketches(ctx, view, game, px);
  drawLiveStroke(ctx, view, px);
  drawMarkers(ctx, view, game, px);
  drawOrderRoute(ctx, view, px);
  drawGridFlash(ctx, view, px);
  drawTargetingCursor(ctx, view, px);

  ctx.restore();

  drawMarginalia(ctx, view, game);
  drawLamp(ctx, view);
}

/* ------------------------------------------------------------------ */
/* 地図記号                                                             */
/* ------------------------------------------------------------------ */

function drawHydrography(ctx, terrain, px) {
  // 河心線。水部の面は原図側で刷ってあるので、ここは輪郭を締めるだけ。
  ctx.save();
  ctx.strokeStyle = INK.water;
  ctx.lineWidth = px(0.9);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let x = 0; x <= WORLD.width; x += 40) {
    const y = riverCenterY(x);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 流向の矢羽根
  ctx.fillStyle = INK.water;
  for (let x = 700; x < WORLD.width; x += 1300) {
    const y = riverCenterY(x);
    const y2 = riverCenterY(x + 60);
    const a = Math.atan2(y2 - y, 60);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(px(7), 0);
    ctx.lineTo(px(-3), px(-3.4));
    ctx.lineTo(px(-3), px(3.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawRoads(ctx, terrain, px) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const road of terrain.roads ?? []) {
    const major = road.cls === 'major';
    const w = major ? 3.4 : 2.2;

    ctx.beginPath();
    road.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));

    // 縁取り（黒）→ 路面（朱）の二度刷り。紙の地図の道路はこの構造をしている。
    ctx.strokeStyle = INK.roadCasing;
    ctx.lineWidth = px(w + 1.6);
    ctx.stroke();
    ctx.strokeStyle = INK.road;
    ctx.lineWidth = px(w);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCrossings(ctx, terrain, px) {
  ctx.save();
  ctx.lineCap = 'butt';

  // 橋 ― 両側の欄干を描く
  const b = terrain.bridge;
  ctx.strokeStyle = INK.sheetInk;
  ctx.lineWidth = px(2.2);
  ctx.beginPath();
  ctx.moveTo(b.x - px(13), b.y - px(15));
  ctx.lineTo(b.x - px(13), b.y + px(15));
  ctx.moveTo(b.x + px(13), b.y - px(15));
  ctx.lineTo(b.x + px(13), b.y + px(15));
  ctx.stroke();

  // 浅瀬 ― 破線で徒渉可を示す
  const f = terrain.ford;
  ctx.strokeStyle = INK.water;
  ctx.lineWidth = px(1.8);
  ctx.setLineDash([px(5), px(4)]);
  ctx.beginPath();
  ctx.moveTo(f.x - px(17), f.y - px(11));
  ctx.lineTo(f.x - px(17), f.y + px(11));
  ctx.moveTo(f.x + px(17), f.y - px(11));
  ctx.lineTo(f.x + px(17), f.y + px(11));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** 地名注記。地図には地名が要る。 */
function drawPlaceNames(ctx, terrain, px) {
  const names = [
    { x: terrain.bridge.x, y: terrain.bridge.y - 150, text: 'ヴォルネ橋', size: 11, style: 'ink' },
    { x: terrain.ford.x, y: terrain.ford.y - 140, text: '下ノ瀬（徒渉可）', size: 9.5, style: 'water' },
    { x: 2200, y: 2420, text: 'ザーレン', size: 12, style: 'ink' },
    { x: 2380, y: 1330, text: '北ザーレン', size: 9.5, style: 'ink' },
    { x: 1150, y: 2400, text: '第一高地 82', size: 9.5, style: 'ink' },
    { x: 3980, y: 560, text: 'コルプ稜線 92', size: 9.5, style: 'ink' },
    { x: 2950, y: 2700, text: '南丘 54', size: 9, style: 'ink' },
    { x: 3600, y: 1780, text: 'ヴォルネ川', size: 11, style: 'water', italic: true },
  ];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const n of names) {
    const size = px(n.size);
    ctx.font = `${n.italic ? 'italic ' : ''}600 ${size}px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
    ctx.lineWidth = size * 0.34;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(232, 233, 210, 0.85)'; // 紙色の縁取りで下地を抜く
    ctx.strokeText(n.text, n.x, n.y);
    ctx.fillStyle = n.style === 'water' ? INK.water : INK.sheetInk;
    ctx.fillText(n.text, n.x, n.y);
  }
  ctx.restore();
}

function drawGrid(ctx, px) {
  ctx.save();
  ctx.strokeStyle = INK.grid;
  ctx.lineWidth = px(0.8);
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

  // 方眼の呼称。無線で「F6」と言われて即座に指を置けることが最優先。
  ctx.fillStyle = INK.gridLabel;
  ctx.font = `600 ${px(8.5)}px ui-monospace, "SFMono-Regular", monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let c = 0; c < WORLD.gridCols; c++) {
    for (let r = 0; r < WORLD.gridRows; r++) {
      ctx.fillText(gridLetter(c) + (r + 1), c * WORLD.gridSize + px(3), r * WORLD.gridSize + px(2.5));
    }
  }
  ctx.restore();
}

/** 図郭線。細線と太線の二重で縁を締める。 */
function drawNeatline(ctx, px) {
  ctx.save();
  ctx.strokeStyle = 'rgba(32, 27, 20, 0.85)';
  ctx.lineWidth = px(2.4);
  ctx.strokeRect(px(1.2), px(1.2), WORLD.width - px(2.4), WORLD.height - px(2.4));
  ctx.lineWidth = px(0.8);
  ctx.strokeRect(px(6), px(6), WORLD.width - px(12), WORLD.height - px(12));
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* アセテート（指揮官の書き込み）                                         */
/* ------------------------------------------------------------------ */

/** 透明シートの映り込み。ごく薄く。 */
function drawAcetateSheen(ctx) {
  const g = ctx.createLinearGradient(0, 0, WORLD.width, WORLD.height);
  g.addColorStop(0, 'rgba(255, 255, 255, 0.07)');
  g.addColorStop(0.4, 'rgba(255, 255, 255, 0.015)');
  g.addColorStop(0.62, 'rgba(255, 255, 255, 0.05)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);
  ctx.restore();
}

function drawCommandPost(ctx, game, px) {
  const cp = getCommandPost(game);
  ctx.save();
  // 指揮所は APP-6 の指揮所記号（旗竿つきの枠）
  drawSymbol(ctx, {
    x: cp.x,
    y: cp.y,
    r: px(11),
    affiliation: 'friend',
    icon: 'infantry',
    lineWidth: px(1.9),
    hand: true,
    seed: 77,
  });
  ctx.strokeStyle = '#1a4f9c';
  ctx.lineWidth = px(1.9);
  ctx.beginPath();
  ctx.moveTo(cp.x - px(12.6), cp.y - px(8.6));
  ctx.lineTo(cp.x - px(12.6), cp.y + px(22));
  ctx.stroke();

  ctx.font = `600 ${px(9)}px "Hiragino Kaku Gothic ProN", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1a4f9c';
  ctx.fillText('指揮所', cp.x, cp.y + px(30));
  ctx.restore();
}

/** 自分が要請した射撃だけを描く（どこに撃てと言ったかは指揮官が知っている） */
function drawFireMissions(ctx, game, px) {
  const now = getSimTime(game);
  ctx.save();
  for (const fm of getOwnFireMissions(game)) {
    const pending = !fm.done;
    const recent = fm.done && now - (fm.completedAt ?? 0) < 90;
    if (!pending && !recent) continue;

    const smoke = fm.kind === 'smoke';
    const color = smoke ? '#4d5a63' : '#b4302a';

    ctx.strokeStyle = color;
    ctx.lineWidth = px(1.7);
    ctx.setLineDash([px(6), px(5)]);
    ctx.beginPath();
    ctx.arc(fm.x, fm.y, fm.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 射撃目標は十字で刺す
    ctx.beginPath();
    ctx.moveTo(fm.x - px(9), fm.y);
    ctx.lineTo(fm.x + px(9), fm.y);
    ctx.moveTo(fm.x, fm.y - px(9));
    ctx.lineTo(fm.x, fm.y + px(9));
    ctx.stroke();

    const eta = Math.max(0, Math.round(fm.nextImpactAt - now));
    const text = fm.done ? '射撃終了' : eta > 0 ? `弾着まで ${eta}秒` : '効力射中';
    penLabel(ctx, `${smoke ? '発煙' : 'AF1'} ${text}`, fm.x, fm.y - fm.radius - px(9), color, px(9));
  }
  ctx.restore();
}

/* --- 作図 --------------------------------------------------------- */

function drawSketches(ctx, view, game, px) {
  for (const sk of getSketches(game)) {
    const alpha = sketchFreshness(game, sk) * (view.selectedMarkId === sk.id ? 1 : 0.92);
    strokeSketch(ctx, sk, px, alpha, view.selectedMarkId === sk.id || view.hoverMarkId === sk.id);
  }
}

/** 引いている最中の線 */
function drawLiveStroke(ctx, view, px) {
  const live = view.liveStroke;
  if (!live || live.points.length < 2) return;
  strokeSketch(ctx, { ...live, id: '__live' }, px, 0.75, false);
}

function strokeSketch(ctx, sk, px, alpha, emphasised) {
  const pts = sk.points;
  if (!pts || pts.length < 2) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = sk.color;
  ctx.fillStyle = sk.color;
  ctx.lineWidth = px(emphasised ? 3 : 2.2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // チャイナグラフの厚み
  ctx.shadowColor = 'rgba(20, 16, 10, 0.3)';
  ctx.shadowBlur = px(1.4);
  ctx.shadowOffsetY = px(0.5);
  if (sk.dash) ctx.setLineDash(sk.dash.map((n) => px(n)));

  if (sk.kind === 'line') {
    // 統制線は引き始めと引き終わりを結ぶ直線
    const a = pts[0];
    const b = pts[pts.length - 1];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (sk.kind === 'area') {
    ctx.closePath();
    ctx.save();
    ctx.globalAlpha = alpha * 0.13;
    ctx.shadowColor = 'transparent';
    ctx.fill();
    ctx.restore();
  }
  ctx.stroke();
  ctx.setLineDash([]);

  if (sk.kind === 'arrow') {
    // 矢頭は最後の向きに合わせる
    const b = pts[pts.length - 1];
    let a = pts[pts.length - 2];
    for (let i = pts.length - 2; i >= 0; i--) {
      if (Math.hypot(b.x - pts[i].x, b.y - pts[i].y) > px(14)) {
        a = pts[i];
        break;
      }
    }
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = px(13);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - Math.cos(ang - 0.42) * len, b.y - Math.sin(ang - 0.42) * len);
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - Math.cos(ang + 0.42) * len, b.y - Math.sin(ang + 0.42) * len);
    ctx.stroke();
  }

  ctx.restore();
}

/** 無線報告から呼び出された方眼を点滅させる */
function drawGridFlash(ctx, view, px) {
  const f = view.flash;
  if (!f) return;
  const t = (performance.now() - f.at) / 2600;
  if (t >= 1) {
    view.flash = null;
    return;
  }
  const pulse = 0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * 4));
  ctx.save();
  ctx.globalAlpha = (1 - t) * pulse;
  ctx.strokeStyle = '#c8541c';
  ctx.lineWidth = px(3);
  ctx.strokeRect(f.col * WORLD.gridSize, f.row * WORLD.gridSize, WORLD.gridSize, WORLD.gridSize);
  ctx.restore();
}

function drawMarkers(ctx, view, game, px) {
  const now = getSimTime(game);
  ctx.save();
  for (const m of getMarkers(game)) {
    const spec = MARKER_TYPES[m.type] ?? MARKER_TYPES.note;
    const conf = CONFIDENCE[m.confidence] ?? CONFIDENCE.estimated;
    const fresh = markerFreshness(game, m);
    // 古い書き込みは薄れる ─ 「これはもう当てにならない」を目で分からせる
    const alpha = 0.34 + fresh * 0.66;
    const selected = view.selectedMarkId === m.id;
    const hovered = view.hoverMarkId === m.id;
    const r = px(13);
    const seed = numericSeed(m.id);

    ctx.save();
    // チャイナグラフは紙に食い込む。ごく薄い影がその厚みになる。
    ctx.shadowColor = 'rgba(20, 16, 10, 0.35)';
    ctx.shadowBlur = px(1.6);
    ctx.shadowOffsetY = px(0.6);

    if (spec.graphic === 'obstacle') {
      drawObstacle(ctx, m.x, m.y, r, spec.color, px(2), alpha);
    } else if (spec.graphic === 'objective') {
      drawObjective(ctx, m.x, m.y, r, spec.color, px(2), alpha);
    } else if (spec.graphic === 'note') {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = spec.color;
      ctx.lineWidth = px(2);
      ctx.beginPath();
      ctx.moveTo(m.x - r * 0.8, m.y - r * 0.6);
      ctx.lineTo(m.x + r * 0.8, m.y - r * 0.6);
      ctx.moveTo(m.x - r * 0.8, m.y);
      ctx.lineTo(m.x + r * 0.5, m.y);
      ctx.moveTo(m.x - r * 0.8, m.y + r * 0.6);
      ctx.lineTo(m.x + r * 0.7, m.y + r * 0.6);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      drawSymbol(ctx, {
        x: m.x,
        y: m.y,
        r,
        affiliation: spec.affiliation,
        icon: spec.icon,
        echelon: spec.echelon ?? null,
        color: spec.color,
        lineWidth: px(2),
        dash: conf.dash ? conf.dash.map((n) => px(n)) : null,
        alpha,
        hand: true,
        seed,
      });
    }
    ctx.restore();

    if (selected || hovered) {
      ctx.save();
      ctx.strokeStyle = 'rgba(20, 30, 45, 0.5)';
      ctx.lineWidth = px(1);
      ctx.setLineDash([px(3), px(3)]);
      ctx.strokeRect(m.x - r * 1.7, m.y - r * 1.7, r * 3.4, r * 3.4);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 注記: ラベル ／ 確度 ／ 書き込んでからの経過
    const age = Math.round((now - m.updatedAt) / 60);
    const bits = [m.label || spec.label];
    if (m.confidence !== 'confirmed') bits.push(conf.short);
    if (age >= 1) bits.push(`${age}分`);
    penLabel(ctx, bits.join(' / '), m.x, m.y + r * 1.85, spec.color, px(9), alpha);
  }
  ctx.restore();
}

/**
 * 概定射点。標定が済んだものは実線の三角、まだ諸元が出ていないものは破線。
 * 砲兵の作業図に載っている記号をそのまま紙に写す。
 */
function drawRegistrations(ctx, game, px) {
  const list = getRegistrations(game);
  if (!list.length) return;
  ctx.save();
  for (const rp of list) {
    const r = px(9);
    ctx.strokeStyle = rp.ready ? '#1f4f7a' : 'rgba(31, 79, 122, 0.55)';
    ctx.lineWidth = px(1.6);
    ctx.setLineDash(rp.ready ? [] : [px(4), px(3)]);
    ctx.beginPath();
    ctx.moveTo(rp.x, rp.y - r);
    ctx.lineTo(rp.x + r * 0.9, rp.y + r * 0.7);
    ctx.lineTo(rp.x - r * 0.9, rp.y + r * 0.7);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    penLabel(
      ctx,
      rp.ready ? rp.id : `${rp.id} 標定中`,
      rp.x,
      rp.y + r * 2.1,
      '#1f4f7a',
      px(9),
      rp.ready ? 1 : 0.75
    );
  }
  ctx.restore();
}

/**
 * 送信前の命令の経路。
 * まだ出していない命令なので、鉛筆で下書きした線として描く。
 */
function drawOrderRoute(ctx, view, px) {
  const legs = view.orderLegs;
  if (!legs?.length) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(138, 31, 24, 0.85)';
  ctx.lineWidth = px(1.8);
  ctx.setLineDash([px(7), px(5)]);
  if (legs.length > 1) {
    ctx.beginPath();
    ctx.moveTo(legs[0].x, legs[0].y);
    for (let i = 1; i < legs.length; i++) ctx.lineTo(legs[i].x, legs[i].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (let i = 0; i < legs.length; i++) {
    const p = legs[i];
    const last = i === legs.length - 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, px(last ? 8 : 5), 0, Math.PI * 2);
    ctx.stroke();
    if (!last) penLabel(ctx, String(i + 1), p.x, p.y - px(12), '#8a1f18', px(9));
  }
  penLabel(
    ctx,
    toGrid(legs[legs.length - 1].x, legs[legs.length - 1].y),
    legs[legs.length - 1].x,
    legs[legs.length - 1].y - px(16),
    '#8a1f18',
    px(10)
  );
  ctx.restore();
}

function drawTargetingCursor(ctx, view, px) {
  if (!view.targeting || !view.cursor) return;
  const { x, y } = view.cursor;
  ctx.save();
  ctx.strokeStyle = '#8a1f18';
  ctx.lineWidth = px(1.6);
  ctx.setLineDash([px(5), px(4)]);
  ctx.beginPath();
  ctx.arc(x, y, px(17), 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x - px(26), y);
  ctx.lineTo(x - px(7), y);
  ctx.moveTo(x + px(7), y);
  ctx.lineTo(x + px(26), y);
  ctx.moveTo(x, y - px(26));
  ctx.lineTo(x, y - px(7));
  ctx.moveTo(x, y + px(7));
  ctx.lineTo(x, y + px(26));
  ctx.stroke();
  penLabel(ctx, toGrid(x, y), x, y - px(32), '#8a1f18', px(11));
  ctx.restore();
}

/** 書き込みの注記。紙色で縁取って下の地図を抜く。 */
function penLabel(ctx, text, x, y, color, size, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 ${size}px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = size * 0.42;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(233, 234, 212, 0.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function numericSeed(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h % 9973);
}

/* ------------------------------------------------------------------ */
/* 図郭外表記（縮尺・方位・図歴）                                         */
/* ------------------------------------------------------------------ */

function drawMarginalia(ctx, view, game) {
  const d = view.dpr;
  // 縦長の画面では、右下は拡大ボタンに取られている。方位標を左に寄せる。
  const portrait = view.canvas.height > view.canvas.width;
  // 図郭ではなく画面の隅に固定する。図郭に貼ると、拡大した途端に
  // 縮尺も方位も画面の外へ出てしまい、一番要るときに読めない。
  const x0 = 14 * d;
  const y0 = view.canvas.height - 14 * d;

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // --- 棒縮尺 ---
  // 倍率に応じて「きりのよい距離」を選ぶ。1000m 固定だと拡大時に画面から溢れる。
  const maxBar = Math.min(220 * d, view.canvas.width * 0.34);
  const NICE = [2000, 1000, 500, 200, 100, 50];
  const barMeters = NICE.find((m) => m * view.scale <= maxBar) ?? 50;
  const barPx = barMeters * view.scale;
  const bx = x0;
  const by = y0 - 10 * d;

  ctx.fillStyle = 'rgba(238, 238, 220, 0.86)';
  ctx.fillRect(bx - 6 * d, by - 22 * d, barPx + 12 * d, 40 * d);
  ctx.strokeStyle = 'rgba(40, 34, 26, 0.45)';
  ctx.lineWidth = 1 * d;
  ctx.strokeRect(bx - 6 * d, by - 22 * d, barPx + 12 * d, 40 * d);

  const seg = barPx / 4;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#efeedd' : '#2a241c';
    ctx.fillRect(bx + i * seg, by - 6 * d, seg, 6 * d);
  }
  ctx.strokeStyle = '#2a241c';
  ctx.lineWidth = 1 * d;
  ctx.strokeRect(bx, by - 6 * d, barPx, 6 * d);

  ctx.fillStyle = '#2a241c';
  ctx.font = `600 ${9 * d}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('0', bx, by - 10 * d);
  ctx.fillText(String(barMeters / 2), bx + seg * 2, by - 10 * d);
  ctx.fillText(`${barMeters} m`, bx + barPx, by - 10 * d);
  ctx.textAlign = 'left';
  ctx.font = `500 ${8.5 * d}px "Hiragino Kaku Gothic ProN", sans-serif`;
  ctx.fillText('縮尺 1:50,000 ／ 等高線間隔 10m ／ 方眼 400m', bx, by + 11 * d);

  // --- 視程 ---
  // 霧はこの戦闘の主役なので、地図の欄外に常に出しておく。
  if (game) {
    const vis = getVisibilityLabel(game);
    const label = `視程 ${vis.label}${vis.note ? ` ─ ${vis.note}` : ''}`;
    ctx.font = `600 ${9.5 * d}px "Hiragino Kaku Gothic ProN", sans-serif`;
    const w = ctx.measureText(label).width;
    const vy = by - 34 * d;
    ctx.fillStyle = 'rgba(238, 238, 220, 0.86)';
    ctx.fillRect(bx - 6 * d, vy - 12 * d, w + 12 * d, 18 * d);
    ctx.strokeStyle = 'rgba(40, 34, 26, 0.45)';
    ctx.lineWidth = 1 * d;
    ctx.strokeRect(bx - 6 * d, vy - 12 * d, w + 12 * d, 18 * d);
    ctx.fillStyle = ['#8a1f18', '#8a5a10', '#2a4a2a', '#24401f'][vis.level] ?? '#2a241c';
    ctx.textAlign = 'left';
    ctx.fillText(label, bx, vy + 1 * d);
  }

  // --- 方位標 ---
  const nx = portrait ? x0 + 26 * d : view.canvas.width - 40 * d;
  const ny = portrait ? y0 - 96 * d : view.canvas.height - 46 * d;
  ctx.fillStyle = 'rgba(238, 238, 220, 0.86)';
  ctx.beginPath();
  ctx.arc(nx, ny, 26 * d, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(40, 34, 26, 0.45)';
  ctx.stroke();

  ctx.save();
  ctx.translate(nx, ny);
  ctx.fillStyle = '#2a241c';
  ctx.beginPath();
  ctx.moveTo(0, -18 * d);
  ctx.lineTo(5 * d, 6 * d);
  ctx.lineTo(0, 2 * d);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#8a8577';
  ctx.beginPath();
  ctx.moveTo(0, -18 * d);
  ctx.lineTo(-5 * d, 6 * d);
  ctx.lineTo(0, 2 * d);
  ctx.closePath();
  ctx.fill();

  // 磁針方位のずれ
  ctx.strokeStyle = '#8a1f18';
  ctx.lineWidth = 1.2 * d;
  ctx.beginPath();
  ctx.rotate(-0.12);
  ctx.moveTo(0, 4 * d);
  ctx.lineTo(0, -16 * d);
  ctx.stroke();
  ctx.rotate(0.12);

  ctx.fillStyle = '#2a241c';
  ctx.font = `700 ${9 * d}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, 17 * d);
  ctx.restore();

  ctx.restore();
}

/** 卓上灯。中央が明るく、隅が落ちる。 */
function drawLamp(ctx, view) {
  const w = view.canvas.width;
  const h = view.canvas.height;
  const g = ctx.createRadialGradient(w * 0.44, h * 0.36, h * 0.12, w * 0.5, h * 0.5, h * 0.92);
  g.addColorStop(0, 'rgba(255, 244, 214, 0.10)');
  g.addColorStop(0.45, 'rgba(255, 240, 205, 0.0)');
  g.addColorStop(1, 'rgba(8, 6, 4, 0.42)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** 指定した世界座標にある書き込みを探す（記号が優先、次に作図） */
export function markerAt(game, x, y, view) {
  const hit = view ? (24 * view.dpr) / view.scale : 80;
  const list = getMarkers(game);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (Math.hypot(m.x - x, m.y - y) <= hit) return m;
  }
  return null;
}

/** 線の上を掴んだか */
export function sketchAt(game, x, y, view) {
  const hit = view ? (14 * view.dpr) / view.scale : 60;
  const list = getSketches(game);
  for (let i = list.length - 1; i >= 0; i--) {
    const sk = list[i];
    const pts = sk.kind === 'line' ? [sk.points[0], sk.points[sk.points.length - 1]] : sk.points;
    for (let k = 0; k < pts.length - 1; k++) {
      if (distToSegment(x, y, pts[k], pts[k + 1]) <= hit) return sk;
    }
    if (sk.kind === 'area' && pts.length > 2) {
      if (distToSegment(x, y, pts[pts.length - 1], pts[0]) <= hit) return sk;
    }
  }
  return null;
}

function distToSegment(px_, py_, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(px_ - a.x, py_ - a.y);
  let t = ((px_ - a.x) * dx + (py_ - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px_ - (a.x + dx * t), py_ - (a.y + dy * t));
}

/** 無線報告の方眼を点滅させる */
export function flashGrid(view, x, y) {
  view.flash = {
    col: Math.floor(x / WORLD.gridSize),
    row: Math.floor(y / WORLD.gridSize),
    at: performance.now(),
  };
}
