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
  getTerrain,
  getSimTime,
  getCommandPost,
  getOwnFireMissions,
  getMarkers,
} from '../state.js';

const INK = {
  road: '#c4622c',
  roadCasing: 'rgba(42, 34, 26, 0.75)',
  water: 'rgba(40, 104, 142, 0.9)',
  grid: 'rgba(52, 74, 96, 0.34)',
  gridLabel: 'rgba(38, 60, 82, 0.62)',
  sheetInk: 'rgba(36, 30, 22, 0.9)',
  pencil: '#2b3d55',
};

export function createMapView(canvas, game) {
  const ctx = canvas.getContext('2d');
  const view = {
    canvas,
    ctx,
    game,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    dpr: 1,
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
  drawMarkers(ctx, view, game, px);
  drawTargetingCursor(ctx, view, px);

  ctx.restore();

  drawMarginalia(ctx, view);
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

function drawMarkers(ctx, view, game, px) {
  const now = getSimTime(game);
  ctx.save();
  for (const m of getMarkers(game)) {
    const spec = MARKER_TYPES[m.type] ?? MARKER_TYPES.note;
    const conf = CONFIDENCE[m.confidence] ?? CONFIDENCE.estimated;
    const fresh = markerFreshness(game, m);
    // 古い書き込みは薄れる ─ 「これはもう当てにならない」を目で分からせる
    const alpha = 0.34 + fresh * 0.66;
    const selected = view.selectedMarkerId === m.id;
    const hovered = view.hoverMarkerId === m.id;
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

function drawMarginalia(ctx, view) {
  const d = view.dpr;
  const x0 = view.offsetX + 14 * d;
  const y0 = view.offsetY + WORLD.height * view.scale - 14 * d;

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  // --- 棒縮尺 ---
  const barMeters = 1000;
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
  ctx.fillText('500', bx + seg * 2, by - 10 * d);
  ctx.fillText('1000 m', bx + barPx, by - 10 * d);
  ctx.textAlign = 'left';
  ctx.font = `500 ${8.5 * d}px "Hiragino Kaku Gothic ProN", sans-serif`;
  ctx.fillText('縮尺 1:50,000 ／ 等高線間隔 10m ／ 方眼 400m', bx, by + 11 * d);

  // --- 方位標 ---
  const nx = view.offsetX + WORLD.width * view.scale - 40 * d;
  const ny = view.offsetY + WORLD.height * view.scale - 46 * d;
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

/** 指定した世界座標にあるマーカーを探す（当たり判定） */
export function markerAt(game, x, y, view) {
  const hit = view ? (24 * view.dpr) / view.scale : 80;
  const list = getMarkers(game);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (Math.hypot(m.x - x, m.y - y) <= hit) return m;
  }
  return null;
}
