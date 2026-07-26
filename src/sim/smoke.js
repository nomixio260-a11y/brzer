// 発煙による視界遮断。時間で膨張しながら薄れていく。

export function createSmoke(x, y, now, radius = 220, duration = 240) {
  return { x, y, bornAt: now, radius, duration };
}

/** 現在の濃度 0..1 */
export function smokeDensity(s, now) {
  const age = now - s.bornAt;
  if (age < 0 || age > s.duration) return 0;
  const rise = Math.min(1, age / 18); // 展張
  const fade = 1 - Math.max(0, (age - s.duration * 0.55) / (s.duration * 0.45));
  return Math.max(0, rise * fade);
}

export function currentRadius(s, now) {
  const age = Math.max(0, now - s.bornAt);
  return s.radius * (0.55 + 0.45 * Math.min(1, age / 45));
}

export function pruneSmoke(list, now) {
  return list.filter((s) => now - s.bornAt <= s.duration);
}

/**
 * 視線が煙を貫くときの減衰量（0 = 影響なし、1 = 完全遮断）。
 */
export function smokeAttenuation(smokes, now, ax, ay, bx, by) {
  if (!smokes || !smokes.length) return 0;
  let total = 0;
  for (const s of smokes) {
    const density = smokeDensity(s, now);
    if (density <= 0) continue;
    const r = currentRadius(s, now);
    const crossed = segmentCircleLength(ax, ay, bx, by, s.x, s.y, r);
    if (crossed <= 0) continue;
    total += density * Math.min(1, crossed / (r * 1.1));
  }
  return Math.min(1, total);
}

/** 線分が円を横切る長さ */
function segmentCircleLength(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) {
    return Math.hypot(ax - cx, ay - cy) <= r ? 0 : 0;
  }
  const fx = ax - cx;
  const fy = ay - cy;
  const a = len2;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return 0;
  const sq = Math.sqrt(disc);
  let t0 = (-b - sq) / (2 * a);
  let t1 = (-b + sq) / (2 * a);
  t0 = Math.max(0, Math.min(1, t0));
  t1 = Math.max(0, Math.min(1, t1));
  if (t1 <= t0) return 0;
  return (t1 - t0) * Math.sqrt(len2);
}
