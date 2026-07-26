// シミュレーションの健全性テスト。ブラウザ無しで node から走らせる。
//   node tests/sim-smoke.mjs

import { createWorld, tick } from '../src/sim/world.js';
import { issueOrder } from '../src/sim/orders.js';
import { evaluate } from '../src/sim/scenario.js';
import { WORLD, toGrid, fromGrid, formatClock, parseClock } from '../src/util.js';
import { generateTerrain, lineOfSight, terrainAt, T } from '../src/sim/terrain.js';
import { mistDensity, mistAttenuation } from '../src/sim/weather.js';
import { findPath } from '../src/sim/pathfind.js';

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

section('ユーティリティ');
check('グリッド往復', (() => {
  const p = fromGrid('F5');
  return p && toGrid(p.x, p.y) === 'F5';
})());
check('不正グリッドは null', fromGrid('Z9') === null && fromGrid('') === null);
check('時刻整形', formatClock(parseClock('0740')) === '0740');

/* ------------------------------------------------------------------ */

section('地形');
const terrain = generateTerrain(20260726);
check('地形配列の長さ', terrain.type.length === WORLD.cols * WORLD.rows);
check('橋が存在する', terrainAt(terrain, terrain.bridge.x, terrain.bridge.y) === T.BRIDGE);
check('浅瀬が存在する', terrainAt(terrain, terrain.ford.x, terrain.ford.y) === T.FORD);
check('標高に NaN がない', terrain.elev.every((v) => Number.isFinite(v)));

const losSelf = lineOfSight(terrain, 1000, 1000, 1000, 1000);
check('同一地点の視線', losSelf.visible === true);

/* ------------------------------------------------------------------ */

section('経路探索');
// 北岸から南岸へ渡るには橋か浅瀬を通らねばならない
const path = findPath(terrain, 2380, 900, 2200, 2300);
check('北岸→南岸の経路が見つかる', path.length > 0, `len=${path.length}`);
if (path.length) {
  const crossesWater = path.some((p) => terrainAt(terrain, p.x, p.y) === T.WATER);
  check('経路が水上を通らない', !crossesWater);
}
const noPath = findPath(terrain, 2380, 900, 2380, 900);
check('同一地点の経路は空でない', noPath.length >= 1);

/* ------------------------------------------------------------------ */

section('シミュレーション本走');

const world = createWorld();
check('友軍の初期配置', world.units.filter((u) => u.side === 'friend').length === 6);
check('開始時刻', formatClock(world.now) === '0700');

// 開幕でいくつか命令を出す（無線・命令経路の疎通確認）
issueOrder(world, { unitId: 'EG', verb: 'recon', x: 2400, y: 900, modifier: 'normal' });
issueOrder(world, { unitId: 'H3', verb: 'defend', x: 2380, y: 1180, modifier: 'cautious' });

const seenKinds = new Set();
let maxQueue = 0;
let sawFireMission = false;
let outcomeAt = null;

const TOTAL = parseClock('0905') - parseClock('0700');
for (let i = 0; i < TOTAL; i++) {
  const delivered = tick(world, 1);
  for (const d of delivered) seenKinds.add(d.kind);
  maxQueue = Math.max(maxQueue, world.radio.queue.length);

  // 0810 に砲撃を要請してみる（火力支援経路の確認）
  if (!sawFireMission && world.now >= parseClock('0810')) {
    const o = issueOrder(world, { unitId: 'TH', verb: 'fire_mission', x: 2380, y: 1100 });
    if (o) sawFireMission = true;
  }

  // 不変条件
  for (const u of world.units) {
    if (!Number.isFinite(u.x) || !Number.isFinite(u.y)) {
      check(`座標が有限 (${u.callsign})`, false, `x=${u.x} y=${u.y}`);
      break;
    }
    if (u.x < -200 || u.x > WORLD.width + 200 || u.y < -200 || u.y > WORLD.height + 200) {
      check(`ユニットが地図内 (${u.callsign})`, false, `x=${u.x} y=${u.y}`);
      break;
    }
    if (u.strength < 0 || u.strength > u.maxStrength + 0.001) {
      check(`兵力が範囲内 (${u.callsign})`, false, `s=${u.strength}`);
      break;
    }
    if (!Number.isFinite(u.morale) || u.morale < 0 || u.morale > 100.001) {
      check(`士気が範囲内 (${u.callsign})`, false, `m=${u.morale}`);
      break;
    }
  }

  if (world.outcome && outcomeAt == null) outcomeAt = world.now;
}

check('全ティックで例外なし', true);
check('砲撃要請が受理された', sawFireMission);
check('敵が出現した', world.units.some((u) => u.side === 'enemy'), `units=${world.units.length}`);
check('無線ログが蓄積された', world.radio.log.length > 12, `log=${world.radio.log.length}`);
check('接敵報告が届いた', seenKinds.has('contact'), `kinds=${[...seenKinds].join(',')}`);
check('命令受領応答が届いた', seenKinds.has('ack'));
check('無線キューが暴走していない', maxQueue < 40, `max=${maxQueue}`);
check('戦闘が発生した', world.units.some((u) => u.losses > 0));
check('勝敗が決着した', world.outcome != null, `outcome=${world.outcome}`);
check(
  '結果が既知の値',
  ['victory', 'narrow', 'defeat'].includes(world.outcome),
  `outcome=${world.outcome}`
);
check('決着に理由がある', typeof world.outcomeReason === 'string' && world.outcomeReason.length > 0);

// 決着後は時間が進まない
const frozen = world.now;
tick(world, 1);
check('決着後はティックが止まる', world.now === frozen);

// 砲弾の残数が正しく減っている
check('砲弾が消費された', world.support.artillery.rounds < 12, `left=${world.support.artillery.rounds}`);

/* ------------------------------------------------------------------ */

section('視程（川霧）');
{
  const w = createWorld();
  const b = w.terrain.bridge;
  const early = mistDensity(w, b.x, b.y);
  const hill = mistDensity(w, 1150, 2560);
  check('開戦時、谷は霧で埋まっている', early > 0.8, `${early.toFixed(2)}`);
  check('高地は霧が薄い', hill < early * 0.4, `谷${early.toFixed(2)} / 高地${hill.toFixed(2)}`);

  for (let i = 0; i < parseClock('0850') - parseClock('0700'); i++) tick(w, 1);
  const late = mistDensity(w, b.x, b.y);
  check('0850には霧が晴れている', late < 0.02, `${late.toFixed(2)}`);

  const w2 = createWorld();
  for (let i = 0; i < 600; i++) tick(w2, 1);
  const cut = mistAttenuation(w2, b.x - 300, b.y, b.x + 300, b.y);
  check('霧の中では600mの視線が大きく削られる', cut > 0.4 && cut < 0.95, `${cut.toFixed(2)}`);
}

section('射撃指揮の手順');
{
  const w = createWorld();
  let fired = false;
  for (let i = 0; i < 7500 && !w.outcome; i++) {
    tick(w, 1);
    if (!fired && w.now >= parseClock('0805')) {
      fired = true;
      issueOrder(w, { unitId: 'TH', verb: 'fire_mission', x: 2330, y: 1290 });
    }
  }
  const fc = w.radio.log.filter((l) => l.kind === 'firecontrol');
  check('「撃った」が返る', fc.some((l) => l.text.includes('撃った')), `${fc.length}件`);
  check('「弾着5秒前」が返る', fc.some((l) => l.text.includes('弾着5秒前')));
  check('弾着観測が返る', w.radio.log.some((l) => l.kind === 'spot'));
}

section('射撃統制');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  issueOrder(w, { unitId: 'H3', verb: 'hold_fire' });
  for (let i = 0; i < 400; i++) tick(w, 1);
  const h3 = w.unitsById.get('H3');
  check('射撃統制が部隊に届く', h3.weaponsHold === true);
  issueOrder(w, { unitId: 'H3', verb: 'free_fire' });
  for (let i = 0; i < 200; i++) tick(w, 1);
  check('射撃自由で解除される', h3.weaponsHold === false);
}

/* ------------------------------------------------------------------ */

section('決定性');
const a = createWorld();
const b = createWorld();
for (let i = 0; i < 900; i++) {
  tick(a, 1);
  tick(b, 1);
}
const sig = (w) =>
  w.units.map((u) => `${u.id}:${u.x.toFixed(2)}:${u.y.toFixed(2)}:${u.strength.toFixed(3)}`).join('|');
check('同シードなら同じ展開になる', sig(a) === sig(b));

/* ------------------------------------------------------------------ */

section('複数シードでの安定性');
for (const seed of [1, 7, 4242, 99991]) {
  const w = createWorld({ seed });
  let ok = true;
  let err = '';
  try {
    for (let i = 0; i < 7500 && !w.outcome; i++) tick(w, 1);
  } catch (e) {
    ok = false;
    err = e.stack ?? String(e);
  }
  check(`seed=${seed} が完走する`, ok && w.outcome != null, `${w.outcome ?? ''} ${err}`);
}

/* ------------------------------------------------------------------ */

console.log(`\n${checks - failures}/${checks} 件成功`);
if (failures > 0) {
  console.error(`${failures} 件失敗`);
  process.exit(1);
}
console.log('シミュレーションは健全です。');
