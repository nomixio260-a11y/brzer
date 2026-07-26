// NATO APP-6 / MIL-STD-2525 準拠の部隊記号を Canvas に描く。
//
// 指揮官が地図に書き込むのは丸や三角ではなく、この記号である。
// 枠の形が「敵味方の別」、中の絵が「兵科」、上の点棒が「規模」を表す。
//
//   □ 長方形 = 友軍     ◇ 菱形 = 敵      □ 正方形 = 中立   ✿ 四つ葉 = 不明
//   ✕ 歩兵   ◯ 装甲    ● 砲兵          Λ 対戦車          ⌒ 無人機

export const AFFILIATION = Object.freeze({
  friend: { key: 'friend', color: '#1a4f9c', label: '友軍' },
  hostile: { key: 'hostile', color: '#b4302a', label: '敵' },
  neutral: { key: 'neutral', color: '#1d7a45', label: '中立' },
  unknown: { key: 'unknown', color: '#8a6a10', label: '不明' },
});

export const ECHELON = Object.freeze({
  none: null,
  team: 'Ø',
  squad: 1, // ●
  section: 2, // ●●
  platoon: 3, // ●●●
  company: 'I',
  battalion: 'II',
});

/* ------------------------------------------------------------------ */
/* 枠                                                                  */
/* ------------------------------------------------------------------ */

function framePath(ctx, affiliation, r) {
  ctx.beginPath();
  switch (affiliation) {
    case 'hostile':
      // 菱形。頂点が上下左右。
      ctx.moveTo(0, -r * 1.16);
      ctx.lineTo(r * 1.16, 0);
      ctx.lineTo(0, r * 1.16);
      ctx.lineTo(-r * 1.16, 0);
      ctx.closePath();
      break;

    case 'neutral':
      ctx.rect(-r * 0.95, -r * 0.95, r * 1.9, r * 1.9);
      break;

    case 'unknown': {
      // 四つ葉。4つの弧を重ねて描く。
      const c = r * 0.52;
      const rr = r * 0.66;
      for (let i = 0; i < 4; i++) {
        const a = (-90 + i * 90) * (Math.PI / 180);
        const cx = Math.cos(a) * c;
        const cy = Math.sin(a) * c;
        ctx.moveTo(cx + Math.cos(a - 2.1) * rr, cy + Math.sin(a - 2.1) * rr);
        ctx.arc(cx, cy, rr, a - 2.1, a + 2.1);
      }
      break;
    }

    default: // friend
      ctx.rect(-r * 1.15, -r * 0.78, r * 2.3, r * 1.56);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* 兵科記号（枠の内側 ±0.62r × ±0.5r に収める）                          */
/* ------------------------------------------------------------------ */

function iconPath(ctx, icon, r) {
  const w = r * 0.6;
  const h = r * 0.46;

  switch (icon) {
    case 'infantry': // ✕
      ctx.beginPath();
      ctx.moveTo(-w, -h);
      ctx.lineTo(w, h);
      ctx.moveTo(w, -h);
      ctx.lineTo(-w, h);
      break;

    case 'armor': // 装甲車輌 = 横長の楕円
      ctx.beginPath();
      ctx.ellipse(0, 0, w, h * 0.82, 0, 0, Math.PI * 2);
      break;

    case 'mech': // 機械化歩兵 = 楕円の中に✕
      ctx.beginPath();
      ctx.ellipse(0, 0, w, h * 0.82, 0, 0, Math.PI * 2);
      ctx.moveTo(-w * 0.72, -h * 0.6);
      ctx.lineTo(w * 0.72, h * 0.6);
      ctx.moveTo(w * 0.72, -h * 0.6);
      ctx.lineTo(-w * 0.72, h * 0.6);
      break;

    case 'recon': // 偵察 = 斜線1本
      ctx.beginPath();
      ctx.moveTo(-w, h);
      ctx.lineTo(w, -h);
      break;

    case 'antitank': // 対戦車 = 山形
      ctx.beginPath();
      ctx.moveTo(-w, h);
      ctx.lineTo(0, -h);
      ctx.lineTo(w, h);
      break;

    case 'mortar': // 迫撃砲 = 台座の上に砲身と円
      ctx.beginPath();
      ctx.moveTo(-w * 0.8, h);
      ctx.lineTo(w * 0.8, h);
      ctx.moveTo(0, h);
      ctx.lineTo(0, -h * 0.35);
      ctx.moveTo(w * 0.42, -h * 0.62);
      ctx.arc(0, -h * 0.62, w * 0.42, 0, Math.PI * 2);
      break;

    case 'uav': // 無人機 = 台座の上のアーチ
      ctx.beginPath();
      ctx.moveTo(-w, h);
      ctx.lineTo(w, h);
      ctx.moveTo(-w * 0.78, h);
      ctx.lineTo(-w * 0.78, 0);
      ctx.arc(0, 0, w * 0.78, Math.PI, 0);
      ctx.lineTo(w * 0.78, h);
      break;

    case 'civilian': // 民間 = 屋根形
      ctx.beginPath();
      ctx.moveTo(-w, h * 0.7);
      ctx.lineTo(-w, -h * 0.1);
      ctx.lineTo(0, -h);
      ctx.lineTo(w, -h * 0.1);
      ctx.lineTo(w, h * 0.7);
      break;

    default:
      ctx.beginPath();
      break;
  }
}

/** 砲兵は塗り潰した円（線ではなく面で描く） */
function iconIsFilled(icon) {
  return icon === 'artillery';
}

function fillIcon(ctx, icon, r) {
  if (icon !== 'artillery') return;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.26, 0, Math.PI * 2);
  ctx.fill();
}

/* ------------------------------------------------------------------ */
/* 規模標識                                                            */
/* ------------------------------------------------------------------ */

function drawEchelon(ctx, echelon, r, lw) {
  if (echelon == null) return;
  const y = -r * 1.42;

  ctx.beginPath();
  if (typeof echelon === 'number') {
    // ● の並び（分隊=1、班=2、小隊=3）
    const gap = r * 0.34;
    const start = -((echelon - 1) * gap) / 2;
    for (let i = 0; i < echelon; i++) {
      ctx.moveTo(start + i * gap + r * 0.11, y);
      ctx.arc(start + i * gap, y, r * 0.11, 0, Math.PI * 2);
    }
    ctx.fill();
    return;
  }

  if (echelon === 'Ø') {
    ctx.moveTo(r * 0.13, y);
    ctx.arc(0, y, r * 0.13, 0, Math.PI * 2);
    ctx.moveTo(-r * 0.16, y + r * 0.16);
    ctx.lineTo(r * 0.16, y - r * 0.16);
    ctx.lineWidth = lw * 0.8;
    ctx.stroke();
    return;
  }

  // 中隊 = |、大隊 = ||
  const bars = echelon.length;
  const gap = r * 0.26;
  const start = -((bars - 1) * gap) / 2;
  for (let i = 0; i < bars; i++) {
    ctx.moveTo(start + i * gap, y - r * 0.2);
    ctx.lineTo(start + i * gap, y + r * 0.2);
  }
  ctx.lineWidth = lw * 0.9;
  ctx.stroke();
}

/* ------------------------------------------------------------------ */
/* 本体                                                                */
/* ------------------------------------------------------------------ */

/**
 * 部隊記号を描く。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o
 *   x, y          中心
 *   r             枠の基準半径
 *   affiliation   'friend' | 'hostile' | 'neutral' | 'unknown'
 *   icon          'infantry' | 'armor' | 'mech' | 'recon' | 'antitank'
 *                 | 'artillery' | 'mortar' | 'uav' | 'civilian'
 *   echelon       ECHELON の値
 *   color         枠と記号の色（省略時は所属の標準色）
 *   lineWidth
 *   dash          破線パターン（推定・未確認の表現）
 *   alpha
 *   fillFrame     枠の内側を薄く塗るか
 *   hand          手描き風（チャイナグラフ）にするか
 *   seed          手描きの揺らぎを固定するための種
 */
export function drawSymbol(ctx, o) {
  const {
    x, y, r = 12,
    affiliation = 'unknown',
    icon = null,
    echelon = null,
    color = AFFILIATION[affiliation]?.color ?? '#cccccc',
    lineWidth = 2,
    dash = null,
    alpha = 1,
    fillFrame = false,
    hand = false,
    seed = 0,
  } = o;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);

  // 手で書いたものは、わずかに傾く
  if (hand) ctx.rotate(jitter(seed, 3) * 0.035);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  const strokeOnce = (offX, offY, width, a) => {
    ctx.save();
    ctx.translate(offX, offY);
    ctx.globalAlpha = alpha * a;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);

    framePath(ctx, affiliation, r);
    if (fillFrame) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.14;
      ctx.fill();
      ctx.restore();
    }
    ctx.stroke();

    ctx.setLineDash([]);
    if (iconIsFilled(icon)) {
      fillIcon(ctx, icon, r);
    } else if (icon) {
      iconPath(ctx, icon, r);
      ctx.stroke();
    }
    drawEchelon(ctx, echelon, r, width);
    ctx.restore();
  };

  if (hand) {
    // チャイナグラフは一発では引けない。二度なぞった跡が残る。
    strokeOnce(jitter(seed, 1) * lineWidth * 0.5, jitter(seed, 2) * lineWidth * 0.5, lineWidth * 1.25, 0.45);
    strokeOnce(0, 0, lineWidth, 0.95);
  } else {
    strokeOnce(0, 0, lineWidth, 1);
  }

  ctx.restore();
}

/** 種から -1..1 の決定的な揺らぎを作る（毎フレーム動かないように） */
function jitter(seed, salt) {
  const n = Math.sin((seed * 127.1 + salt * 311.7) * 0.017) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
}

/* ------------------------------------------------------------------ */
/* 戦術要図（部隊記号ではない図式）                                       */
/* ------------------------------------------------------------------ */

/** 障害（対戦車壕・鉄条網）: 折れ線に×を並べた線 */
export function drawObstacle(ctx, x, y, r, color, lineWidth, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - r * 1.3, y);
  ctx.lineTo(x + r * 1.3, y);
  for (let i = -1; i <= 1; i++) {
    const cx = x + i * r * 0.9;
    ctx.moveTo(cx - r * 0.32, y - r * 0.42);
    ctx.lineTo(cx + r * 0.32, y + r * 0.42);
    ctx.moveTo(cx + r * 0.32, y - r * 0.42);
    ctx.lineTo(cx - r * 0.32, y + r * 0.42);
  }
  ctx.stroke();
  ctx.restore();
}

/** 目標地域: 角の丸い枠に OBJ */
export function drawObjective(ctx, x, y, r, color, lineWidth, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.25, r * 0.95, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = `700 ${r * 0.72}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('OBJ', x, y + r * 0.02);
  ctx.restore();
}

/** 記号の凡例用の短い説明 */
export const ICON_LABEL_JA = Object.freeze({
  infantry: '歩兵',
  armor: '装甲',
  mech: '機械化歩兵',
  recon: '偵察',
  antitank: '対戦車',
  artillery: '砲兵',
  mortar: '迫撃砲',
  uav: '無人機',
  civilian: '民間',
});
