// 敵指揮官の検査。ブラウザ無しで node から走らせる。
//   node tests/sim-enemy.mjs
//
// 見ているのは二つ。
//  ① 軸を図幅から採っているか ── 橋が三本ある図幅で、三本目を数えているか。
//  ② 守勢に回っても指揮官として振る舞うか ── 予備を残し、圧された所へ出し、
//     取られた所を取り返すか。そしてそれを「部下が見たもの」だけで決めているか。

import { createWorld, tick, addUnit } from '../src/sim/world.js';
import { issueOrder } from '../src/sim/orders.js';
import { applyDamage } from '../src/sim/units.js';
import { enemyIntentLog } from '../src/sim/enemyCommand.js';
import { getMap } from '../src/sim/maps.js';
import { dist } from '../src/util.js';

let failures = 0;
let checks = 0;

function check(name, cond, detail = '') {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

/* ------------------------------------------------------------------ */
/* 逆襲ミッションを実際に攻めさせる                                       */
/* ------------------------------------------------------------------ */

/** 中央橋から交差点へ押す（README の言う「無策の正面攻撃」） */
const PUSH_CENTRE = [
  ['H1', 2300, 2350], ['H2', 2350, 2300], ['H4', 2300, 2400],
  ['SH', 2350, 2300], ['SW', 2300, 2500],
];
/** 鉄道橋から入る */
const PUSH_RAIL = [
  ['H1', 3450, 2100], ['H2', 3450, 2000], ['H4', 3450, 2200],
  ['SH', 3450, 2050], ['SW', 3400, 2400],
];

function assault(w, plan) {
  for (const [id, x, y] of plan) {
    const u = w.unitsById.get(id);
    if (u?.alive) issueOrder(w, { unitId: id, verb: 'attack', x, y });
  }
}

/**
 * 逆襲ミッションを steps 秒ぶん走らせる。
 * plan が無ければ、こちらは一歩も出ない（敵から見れば何も起きていない）。
 */
function runTown(seed, steps, plan, hook = null) {
  const w = createWorld({ seed, missionId: 'zaren_counter' });
  for (let i = 0; i < steps && !w.outcome; i++) {
    if (hook) hook(w, i);
    tick(w, 1);
    if (plan && i % 500 === 40) assault(w, plan);
  }
  return w;
}

/* ------------------------------------------------------------------ */

section('軸は図幅から採る');
{
  const river = createWorld();
  const town = createWorld({ missionId: 'zaren_counter' });
  const pass = createWorld({ missionId: 'kolp_delay' });

  check('河川は二軸', Object.keys(river.enemyCommand.axes).join(',') === 'bridge,ford',
    Object.keys(river.enemyCommand.axes).join(','));
  check('峠は二軸', Object.keys(pass.enemyCommand.axes).join(',') === 'defile,track',
    Object.keys(pass.enemyCommand.axes).join(','));
  check('市街は三軸', Object.keys(town.enemyCommand.axes).length === 3,
    Object.keys(town.enemyCommand.axes).join(','));
  check('三本目の橋にも軸がある', !!town.enemyCommand.axes.rail_bridge);
  check('軸の名は図幅の名である',
    town.enemyCommand.axes.rail_bridge.label === '鉄道橋' &&
    town.enemyCommand.axes.west_bridge.label === '西橋' &&
    pass.enemyCommand.axes.track.label === '東の間道');

  // 図幅が通過点を増やせば、敵が数える軸も増える ─ 決め打ちが残っていれば、ここで落ちる。
  const ZAREN = getMap('zaren_town');
  check('軸の数は図幅の通過点の数と一致する',
    Object.keys(town.enemyCommand.axes).length === ZAREN.crossings.length);
  check('軸の位置は図幅の通過点と一致する',
    ZAREN.crossings.every((cr) => town.enemyCommand.axes[cr.id]?.x === cr.x));
}

section('部隊はいちばん近い軸に属する');
{
  // 三本の橋それぞれの北に一個ずつ置く。中間点で二分していた頃は、
  // 真ん中の一本が両端のどちらかに吸われて、必ず一軸が空だった。
  const w = createWorld({ missionId: 'zaren_counter' });
  const front = w.terrain.front;
  for (const [id, x] of [['X-W', 1250], ['X-C', 2350], ['X-R', 3450]]) {
    addUnit(w, {
      id, side: 'enemy', callsign: id, type: 'infantry', x, y: 900,
      ai: { task: 'assault', objective: { x, y: 3000 }, crossing: { x, y: front(x) } },
    });
  }
  for (let i = 0; i < 320; i++) tick(w, 1);

  const ax = w.enemyCommand.axes;
  check('西橋の軸に部隊が数えられる', ax.west_bridge.strength >= 1, String(ax.west_bridge.strength));
  check('中央橋の軸に部隊が数えられる', ax.main_bridge.strength >= 1, String(ax.main_bridge.strength));
  check('鉄道橋の軸に部隊が数えられる', ax.rail_bridge.strength >= 1, String(ax.rail_bridge.strength));
  check('三軸とも評価されている',
    Object.values(ax).every((a) => Number.isFinite(a.progress) && Number.isFinite(a.stalledFor)));
}

{
  // 通過点を割り当てられていない部隊は、居る場所でいちばん近い軸に付く。
  const w = createWorld({ missionId: 'zaren_counter' });
  addUnit(w, {
    id: 'X-N', side: 'enemy', callsign: 'X-N', type: 'infantry', x: 3400, y: 900,
    ai: { task: 'assault', objective: { x: 3400, y: 3000 } },
  });
  for (let i = 0; i < 320; i++) tick(w, 1);
  const ax = w.enemyCommand.axes;
  check('鉄道橋の側にいる部隊は鉄道橋の軸に付く',
    ax.rail_bridge.strength === 1 && ax.main_bridge.strength === 0,
    `鉄道橋${ax.rail_bridge.strength} 中央橋${ax.main_bridge.strength}`);
}

section('攻勢の指揮官は今までどおり');
{
  const w = createWorld();
  for (let i = 0; i < 7500 && !w.outcome; i++) tick(w, 1);
  check('河川では予備を投入する', w.enemyCommand.reserveCommitted === true);
  check('投入先は図幅の軸のどれかである',
    !!w.enemyCommand.axes[w.enemyCommand.committedAxis], String(w.enemyCommand.committedAxis));
  check('決心が記録されている', enemyIntentLog(w).length > 0, `${enemyIntentLog(w).length}件`);
  check('攻勢では守勢の手札を使わない', w.enemyCommand.defense.active === false);
}

section('守勢 ─ 予備を手元に残す');
{
  const quiet = runTown(7, 3000, null);
  const d = quiet.enemyCommand.defense;
  check('守勢と分かれば予備を指定する', !!d.reserveId, String(d.reserveId));
  check('予備は線のいちばん後ろから採る',
    quiet.unitsById.get(d.reserveId).y <= Math.min(
      ...quiet.units
        .filter((u) => u.side === 'enemy' && u.alive && u.ai?.task === 'hold_ground')
        .map((u) => u.ai.anchor?.y ?? u.y)
    ) + 1);
  // 攻めてこない相手に予備を出す指揮官はいない。
  check('こちらが動かなければ予備は出ない', d.committedTo === null, String(d.committedTo));
  check('こちらが動かなければ逆襲もない', d.counterattacks === 0);
}

section('守勢 ─ 圧された所へ予備を出す');
{
  let commits = 0;
  const seeds = [1, 7, 42, 99, 4242, 990117, 31337, 5, 12, 777];
  for (const s of seeds) if (runTown(s, 4000, PUSH_CENTRE).enemyCommand.defense.committedTo) commits++;
  check('押し込めば予備は必ず出る', commits === seeds.length, `${commits}/${seeds.length}`);

  const w = runTown(7, 4000, PUSH_CENTRE);
  const d = w.enemyCommand.defense;
  const res = w.unitsById.get(d.reserveId);
  check('予備は投入先に寄せられている',
    res.ai.committed === true && dist(res.ai.anchor.x, res.ai.anchor.y, ...(() => {
      const a = d.anchors.reduce((b, s) => (s.grid === d.committedTo ? s : b), d.anchors[0]);
      return [a.x, a.y];
    })()) < 260);
  check('投入は講評に出る',
    enemyIntentLog(w).some((l) => l.text.includes('予備をそこへ寄せる')),
    JSON.stringify(enemyIntentLog(w).map((l) => l.text)));
}

section('守勢 ─ 取られた地点は取り返しにくる');
{
  // 一個を消してやる。隣が寄れない距離にある持ち場なので、そこは空く。
  const w = createWorld({ seed: 7, missionId: 'zaren_counter' });
  for (let i = 0; i < 400; i++) tick(w, 1);
  const holders = w.units.filter(
    (u) => u.side === 'enemy' && u.alive && !u.tpl.indirect && u.ai?.anchor
  );
  // 隣が寄れば穴は塞がる。塞がらない持ち場を選ばないと、逆襲は要らない。
  const lost = holders.find((u) =>
    holders.every((o) => o === u || dist(o.ai.anchor.x, o.ai.anchor.y, u.ai.anchor.x, u.ai.anchor.y) > 200)
  );
  check('隣が寄れない持ち場がある', !!lost);
  const anchor = { ...lost.ai.anchor };
  applyDamage(lost, lost.maxStrength * 2, w.now, {});
  check('持ち場の主が消えた', lost.alive === false);

  for (let i = 0; i < 900 && !w.outcome; i++) tick(w, 1);
  const d = w.enemyCommand.defense;
  check('敵は逆襲を出す', d.counterattacks >= 1, `${d.counterattacks}回`);
  const back = w.units.find(
    (u) => u.side === 'enemy' && u.alive && u.ai?.counterattack &&
      dist(u.ai.anchor.x, u.ai.anchor.y, anchor.x, anchor.y) < 60
  );
  check('取り返しに向かう部隊がいる', !!back, back ? back.id : 'なし');
  check('逆襲は講評に出る', enemyIntentLog(w).some((l) => l.text.includes('取り返す')));

  // 三度目は出さない ─ 出せば線に誰もいなくなる。
  for (let i = 0; i < 4000 && !w.outcome; i++) tick(w, 1);
  check('逆襲は二度までしか出さない', w.enemyCommand.defense.counterattacks <= 2,
    `${w.enemyCommand.defense.counterattacks}回`);
}

section('守勢 ─ 敵が読むのは「部下が見たもの」だけ');
{
  // こちらは中央橋の南に集まったままだが、敵の耳目には西橋しか映っていない。
  // 盤の真実を覗いていれば、敵は中央橋と答える。
  const w = createWorld({ seed: 7, missionId: 'zaren_counter' });
  const ghost = { x: 1250, y: w.terrain.front(1250) + 120 };
  for (let i = 0; i < 900 && !w.outcome; i++) {
    w.enemyIntel.clear();
    for (let k = 0; k < 3; k++) {
      w.enemyIntel.set(`GHOST${k}`, { x: ghost.x + k * 40, y: ghost.y, at: w.now, type: 'infantry' });
    }
    tick(w, 1);
  }
  check('聞かされたとおりの軸を主攻と読む',
    w.enemyCommand.defense.readAxis === 'west_bridge', String(w.enemyCommand.defense.readAxis));
  check('読みは講評に出る',
    enemyIntentLog(w).some((l) => l.text.includes('西橋から入ってくる')),
    JSON.stringify(enemyIntentLog(w).map((l) => l.text)));

  // 実際に鉄道橋から入れば、そちらを読む。
  const rail = runTown(7, 6000, PUSH_RAIL);
  check('鉄道橋から入れば鉄道橋を読む',
    rail.enemyCommand.defense.readAxis === 'rail_bridge',
    String(rail.enemyCommand.defense.readAxis));
  // 三本目が判断に入らなかったのが、そもそもの不具合である。
  check('三本目の橋にも圧力が測られている',
    rail.enemyCommand.axes.rail_bridge.pressure > rail.enemyCommand.axes.main_bridge.pressure,
    `鉄道橋${rail.enemyCommand.axes.rail_bridge.pressure?.toFixed(2)} ` +
      `中央橋${rail.enemyCommand.axes.main_bridge.pressure?.toFixed(2)}`);
}

section('守勢 ─ 見えていない敵には反応しない');
{
  // 接触を全部消してやると、敵指揮官は圧力を読めない。
  // 煙で視界を切られた敵が「どこが圧されているか」を取り違えるのは、これと同じ理屈である。
  const w = createWorld({ seed: 7, missionId: 'zaren_counter' });
  for (let i = 0; i < 2500 && !w.outcome; i++) {
    w.enemyIntel.clear();
    tick(w, 1);
    if (i % 500 === 40) assault(w, PUSH_CENTRE);
    w.enemyIntel.clear();
  }
  check('接触が無ければ軸は読めない', w.enemyCommand.defense.readAxis == null,
    String(w.enemyCommand.defense.readAxis));
}

section('決定性');
{
  const a = runTown(4242, 2500, PUSH_CENTRE);
  const b = runTown(4242, 2500, PUSH_CENTRE);
  check('同じシードなら同じ決心になる',
    JSON.stringify(enemyIntentLog(a)) === JSON.stringify(enemyIntentLog(b)),
    JSON.stringify(enemyIntentLog(a).map((l) => l.text)));
  check('同じシードなら盤も同じになる',
    JSON.stringify(a.units.map((u) => [u.id, Math.round(u.x), Math.round(u.y), Math.round(u.strength)])) ===
    JSON.stringify(b.units.map((u) => [u.id, Math.round(u.x), Math.round(u.y), Math.round(u.strength)])));
}

section('全図幅で完走する');
for (const missionId of ['bridge_hold', 'kolp_delay', 'zaren_counter']) {
  for (const seed of [3, 77]) {
    const w = createWorld({ seed, missionId });
    let ok = true;
    let err = '';
    try {
      for (let i = 0; i < 9000 && !w.outcome; i++) {
        tick(w, 1);
        if (missionId === 'zaren_counter' && i % 500 === 40) assault(w, PUSH_CENTRE);
      }
    } catch (e) {
      ok = false;
      err = e.stack ?? String(e);
    }
    check(`${missionId} seed=${seed} が完走する`, ok && w.outcome != null, `${w.outcome ?? ''} ${err}`);
  }
}

/* ------------------------------------------------------------------ */

console.log(`\n${checks - failures}/${checks} 件成功`);
if (failures > 0) {
  console.error(`${failures} 件失敗`);
  process.exit(1);
}
console.log('敵の指揮官は健全です。');
