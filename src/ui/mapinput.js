// 地図の操作。マウス・タッチ・ペンを Pointer Events で1本にまとめる。
//
// 決め方は地図アプリの作法に合わせてある。
//   ・何もない所を掴んで動かす → 図面をずらす
//   ・何もない所を叩く         → 記号を置く
//   ・記号を掴んで動かす       → その記号を動かす
//   ・記号を長押し／右クリック → 消す
//   ・二本指                   → 拡大縮小と移動
//   ・作図の道具を選んでいる間は、掴んで動かすと線を引く
//
// これで PC と携帯で操作を覚え直さなくて済む。

import { zoomAt, panByScreen, toWorld, isInsideMap, markerAt, sketchAt } from './mapview.js';

const TAP_MS = 320;
const TAP_SLOP = 9; // CSS px
const LONG_PRESS_MS = 520;
const SKETCH_MIN_STEP = 5; // CSS px

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} api 呼び出し側が渡す入口
 *   getView()      現在のビュー
 *   getGame()
 *   getTool()      {mode:'symbol'|'sketch', sketchTool}
 *   isTargeting()  命令の目標を待っているか
 *   onTargetPick(x, y)
 *   onPlaceMarker(x, y)
 *   onSelectMark(mark|null)
 *   onMoveMarker(id, x, y, committed)
 *   onDeleteMark(mark)
 *   onSketchDone(tool, points)
 *   onViewChanged()
 *   onHover(mark|null)
 */
export function attachMapInput(canvas, api) {
  const pointers = new Map();
  let gesture = null; // 'pan' | 'mark' | 'sketch' | 'pinch'
  let longPressTimer = null;
  let pinch = null;
  let suppressClick = false;
  let grabbed = false; // 掴んだ記号を実際に動かし始めたか

  const view = () => api.getView();

  const cssPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function endGesture() {
    cancelLongPress();
    gesture = null;
    pinch = null;
    view().liveStroke = null;
  }

  /* ---------------- 押した ---------------- */

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button === 2) return; // 右は contextmenu 側で扱う
    canvas.setPointerCapture?.(e.pointerId);

    const p = cssPos(e);
    const world = toWorld(view(), e.clientX, e.clientY);
    pointers.set(e.pointerId, { ...p, startX: p.x, startY: p.y, at: performance.now(), world, moved: false });

    if (pointers.size === 2) {
      // 二本指に切り替わったら、それまでの操作は無かったことにする
      if (gesture === 'sketch') view().liveStroke = null;
      cancelLongPress();
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      gesture = 'pinch';
      suppressClick = true;
      return;
    }
    if (pointers.size > 2) return;

    if (!isInsideMap(world)) {
      gesture = 'pan';
      return;
    }

    // 命令の目標指定中は、他の何よりそれが優先
    if (api.isTargeting()) {
      gesture = 'target';
      return;
    }

    const game = api.getGame();
    const tool = api.getTool();
    const hit =
      markerAt(game, world.x, world.y, view()) ?? sketchAt(game, world.x, world.y, view());

    // 長押しで消すのは、何を書いている最中でも効かせる（携帯に右クリックは無い）
    if (hit) {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        suppressClick = true;
        gesture = null;
        view().liveStroke = null;
        api.onDeleteMark(hit);
      }, LONG_PRESS_MS);
    }

    // 作図の道具を持っている間は、線を引くことが最優先。
    // ここで既存の記号を掴んでしまうと、線を引こうとするたび記号が動く。
    if (tool.mode === 'sketch') {
      gesture = 'sketch';
      view().liveStroke = {
        tool: tool.sketchTool,
        kind: tool.sketchKind,
        color: tool.sketchColor,
        dash: tool.sketchDash,
        points: [world],
      };
      return;
    }

    if (hit) {
      gesture = 'mark';
      grabbed = false;
      view().selectedMarkId = hit.id;
      api.onSelectMark(hit, e);
      return;
    }

    gesture = 'pan';
  });

  /* ---------------- 動かした ---------------- */

  canvas.addEventListener('pointermove', (e) => {
    const rec = pointers.get(e.pointerId);
    if (!rec) {
      // 押していないときはホバー表示だけ更新する
      if (e.pointerType === 'mouse') {
        const w = toWorld(view(), e.clientX, e.clientY);
        view().cursor = w;
        const game = api.getGame();
        const hit = isInsideMap(w)
          ? markerAt(game, w.x, w.y, view()) ?? sketchAt(game, w.x, w.y, view())
          : null;
        view().hoverMarkId = hit?.id ?? null;
        api.onHover?.(hit);
      }
      return;
    }

    const p = cssPos(e);
    const dx = p.x - rec.x;
    const dy = p.y - rec.y;
    rec.x = p.x;
    rec.y = p.y;
    if (Math.hypot(p.x - rec.startX, p.y - rec.startY) > TAP_SLOP) {
      rec.moved = true;
      cancelLongPress();
    }

    const w = toWorld(view(), e.clientX, e.clientY);
    view().cursor = w;

    if (gesture === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (pinch && pinch.dist > 0) {
        const r = canvas.getBoundingClientRect();
        zoomAt(view(), dist / pinch.dist, r.left + cx, r.top + cy);
        panByScreen(view(), cx - pinch.cx, cy - pinch.cy);
      }
      pinch = { dist, cx, cy };
      api.onViewChanged?.();
      return;
    }

    if (gesture === 'pan') {
      if (!rec.moved) return;
      panByScreen(view(), dx, dy);
      api.onViewChanged?.();
      return;
    }

    if (gesture === 'mark' && rec.moved) {
      const id = view().selectedMarkId;
      if (id) {
        // 動かし始めた瞬間を知らせる。ここで控えを取らないと
        // 「動かす前」に戻せなくなる（動かし終えてから控えても手遅れ）。
        api.onMoveMarker(id, w.x, w.y, grabbed ? 'move' : 'start');
        grabbed = true;
      }
      return;
    }

    if (gesture === 'sketch') {
      const live = view().liveStroke;
      if (!live) return;
      const last = live.points[live.points.length - 1];
      const step = (SKETCH_MIN_STEP * view().dpr) / view().scale;
      if (Math.hypot(w.x - last.x, w.y - last.y) >= step) live.points.push(w);
    }
  });

  /* ---------------- 離した ---------------- */

  function finish(e) {
    const rec = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);

    if (gesture === 'pinch') {
      if (pointers.size < 2) {
        pinch = null;
        gesture = pointers.size === 1 ? 'pan' : null;
        // 残った指を新しい起点にする
        for (const r of pointers.values()) {
          r.startX = r.x;
          r.startY = r.y;
          r.moved = false;
        }
      }
      return;
    }

    if (!rec) return;
    cancelLongPress();

    const tapped =
      !rec.moved && performance.now() - rec.at < TAP_MS && !suppressClick;
    const world = rec.world;

    if (gesture === 'sketch') {
      const live = view().liveStroke;
      view().liveStroke = null;
      if (live && live.points.length >= 2) api.onSketchDone(live.tool, live.points);
      gesture = null;
      suppressClick = false;
      return;
    }

    if (gesture === 'mark') {
      if (rec.moved) {
        const w = toWorld(view(), e.clientX, e.clientY);
        api.onMoveMarker(view().selectedMarkId, w.x, w.y, 'end');
      }
      gesture = null;
      grabbed = false;
      suppressClick = false;
      return;
    }

    if (gesture === 'target' && tapped && isInsideMap(world)) {
      api.onTargetPick(world.x, world.y);
      gesture = null;
      suppressClick = false;
      return;
    }

    if (gesture === 'pan' && tapped && isInsideMap(world)) {
      const tool = api.getTool();
      if (tool.mode === 'symbol') {
        api.onSelectMark(null);
        api.onPlaceMarker(world.x, world.y, e);
      } else {
        api.onSelectMark(null);
      }
    }

    gesture = null;
    if (pointers.size === 0) suppressClick = false;
  }

  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    endGesture();
  });

  /* ---------------- 車輪・右クリック ---------------- */

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = Math.pow(0.9985, e.deltaY);
      zoomAt(view(), factor, e.clientX, e.clientY);
      api.onViewChanged?.();
    },
    { passive: false }
  );

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const w = toWorld(view(), e.clientX, e.clientY);
    if (!isInsideMap(w)) return;
    const game = api.getGame();
    const hit = markerAt(game, w.x, w.y, view()) ?? sketchAt(game, w.x, w.y, view());
    if (hit) api.onDeleteMark(hit);
  });

  // ブラウザ側の既定の拡大・スクロールを止める
  canvas.style.touchAction = 'none';

  return {
    destroy() {
      endGesture();
      pointers.clear();
    },
  };
}
