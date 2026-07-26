// シミュレーションの健全性テスト。ブラウザ無しで node から走らせる。
//   node tests/sim-smoke.mjs

import { createWorld, tick } from '../src/sim/world.js';
import { issueOrder } from '../src/sim/orders.js';
import { evaluate } from '../src/sim/scenario.js';
import { WORLD, toGrid, fromGrid, formatClock, parseClock } from '../src/util.js';
import { generateTerrain, lineOfSight, terrainAt, T } from '../src/sim/terrain.js';
import { mistDensity, mistAttenuation, lightLevel, lightSpotFactor } from '../src/sim/weather.js';
import { fatigueFactor, fatigueJa } from '../src/sim/logistics.js';
import { applyDamage } from '../src/sim/units.js';
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

section('交戦規定');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const h1 = w.unitsById.get('H1');
  check('初期は陣地防御', (h1.roe ?? 'standard') === 'standard');

  issueOrder(w, { unitId: 'H1', verb: 'roe_hold_fast' });
  for (let i = 0; i < 400; i++) tick(w, 1);
  check('死守が部隊に届く', h1.roe === 'hold_fast');

  // 死守下では士気に下限が効き、統制喪失に落ちない
  h1.morale = 4;
  tick(w, 1);
  for (let i = 0; i < 40; i++) tick(w, 1);
  check('死守下では崩れにくい', h1.morale >= 12, `morale=${h1.morale.toFixed(1)}`);

  // 崩れた部隊は命令を受け付けないので、立て直してから切り替える
  h1.morale = 80;
  h1.state = 'defending';
  issueOrder(w, { unitId: 'H1', verb: 'roe_elastic' });
  for (let i = 0; i < 400; i++) tick(w, 1);
  check('弾力防御に切り替わる', h1.roe === 'elastic');
}

section('部下の独断');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const h3 = w.unitsById.get('H3');
  issueOrder(w, { unitId: 'H3', verb: 'roe_elastic' });
  for (let i = 0; i < 400; i++) tick(w, 1);

  // 追い詰められた状態を作る
  const before = { x: h3.x, y: h3.y };
  h3.morale = 30;
  h3.suppression = 90;
  h3.lastHitAt = w.now;
  h3.contacts.set('X', {
    targetId: 'X', x: h3.x, y: h3.y - 300, lastSeenAt: w.now,
    quality: 1, classified: 'infantry', trueType: 'infantry', count: 1,
  });
  h3._initNextAt = -Infinity;
  for (let i = 0; i < 200; i++) tick(w, 1);
  const moved = Math.hypot(h3.x - before.x, h3.y - before.y);
  check('弾力防御なら独断で下がる', !h3.alive || moved > 60 || h3._lastSelfWithdrawAt != null,
    `moved=${moved.toFixed(0)}`);
}

section('経路点つきの命令');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const legs = [{ x: 1500, y: 2400 }, { x: 1500, y: 3000 }, { x: 2400, y: 3000 }];
  const order = issueOrder(w, { unitId: 'H2', verb: 'move', x: 0, y: 0, legs });
  check('経路点つきの命令が通る', order != null && order.legs?.length === 3);
  check('最終目標は最後の点', order.x === 2400 && order.y === 3000);

  const h2 = w.unitsById.get('H2');
  let sawFirstLeg = false;
  for (let i = 0; i < 2200 && !sawFirstLeg; i++) {
    tick(w, 1);
    if (Math.hypot(h2.x - legs[0].x, h2.y - legs[0].y) < 220) sawFirstLeg = true;
  }
  check('第1脚を経由する', sawFirstLeg, `at ${h2.x.toFixed(0)},${h2.y.toFixed(0)}`);
}

section('概定射点');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  issueOrder(w, { unitId: 'TH', verb: 'register', x: 2200, y: 1400 });
  for (let i = 0; i < 400; i++) tick(w, 1);
  check('概定射点が登録される', w.registrations.length === 1, `${w.registrations.length}`);

  // 諸元が出るまで待ってから撃つと早く落ちる
  for (let i = 0; i < 200; i++) tick(w, 1);
  const before = w.fireMissions.length;
  issueOrder(w, { unitId: 'TH', verb: 'fire_mission', x: 2210, y: 1420 });
  for (let i = 0; i < 400 && w.fireMissions.length === before; i++) tick(w, 1);
  const fm = w.fireMissions[w.fireMissions.length - 1];
  check('概定射点への射撃は諸元が出ている', fm?.registered === true);
  check('散布界が締まる', (fm?.spread ?? 1) < 1);

  // 遠い点への射撃は通常どおり
  const b2 = w.fireMissions.length;
  issueOrder(w, { unitId: 'TH', verb: 'fire_mission', x: 3900, y: 900 });
  for (let i = 0; i < 400 && w.fireMissions.length === b2; i++) tick(w, 1);
  const fm2 = w.fireMissions[w.fireMissions.length - 1];
  check('離れた点は通常の射撃', fm2?.registered === false);
}

section('予令（発動条件つきの命令）');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const h2 = w.unitsById.get('H2');
  const start = { x: h2.x, y: h2.y };

  const order = issueOrder(w, {
    unitId: 'H2', verb: 'move', x: 1400, y: 2600,
    trigger: 'at_time', triggerAt: w.now + 900,
  });
  check('予令が発令できる', order?.trigger === 'at_time');

  for (let i = 0; i < 300; i++) tick(w, 1);
  check('受領しても動き出さない', order.state === 'standby' && h2.heldOrder === order);
  check('条件前は動かない', Math.hypot(h2.x - start.x, h2.y - start.y) < 60);

  for (let i = 0; i < 900; i++) tick(w, 1);
  check('時刻が来たら発動する', order.state !== 'standby', order.state);
  check('発動時刻が記録される', order.firedAt != null && order.firedAt >= order.triggerAt);
  check('予令の控えが外れる', h2.heldOrder == null);

  // 発動を無線で報告している
  const said = w.radio.log.some(
    (e) => e.kind === 'initiative' && e.meta?.orderId === order.id
  );
  check('発動を報告する', said);
}

{
  // 過ぎた時刻を条件にしても、ただの即時命令になる
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const o = issueOrder(w, {
    unitId: 'H2', verb: 'hold', trigger: 'at_time', triggerAt: w.now - 100,
  });
  check('過ぎた時刻の予令は即時命令になる', o.trigger === 'now');
}

{
  // 接敵条件。敵を認めるまで待つ。
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const h3 = w.unitsById.get('H3');
  const o = issueOrder(w, {
    unitId: 'H3', verb: 'withdraw', x: 2250, y: 2400, trigger: 'on_contact',
  });
  for (let i = 0; i < 200; i++) tick(w, 1);
  const heldEarly = o.state === 'standby';
  // 敵を見せる
  h3.contacts.set('Z', {
    targetId: 'Z', x: h3.x + 200, y: h3.y - 300, lastSeenAt: w.now,
    quality: 1, classified: 'infantry', trueType: 'infantry', count: 1,
  });
  for (let i = 0; i < 30; i++) {
    h3.contacts.get('Z').lastSeenAt = w.now;
    tick(w, 1);
  }
  check('接敵条件は敵を認めるまで待つ', heldEarly);
  check('接敵で予令が発動する', o.state !== 'standby', o.state);
}

section('敵の指揮官');
{
  const w = createWorld();
  for (let i = 0; i < 7500 && !w.outcome; i++) tick(w, 1);
  check('敵指揮官が存在する', !!w.enemyCommand);
  check('両軸を評価している',
    Number.isFinite(w.enemyCommand.axes.bridge.progress) &&
    Number.isFinite(w.enemyCommand.axes.ford.progress));
  check('敵が予備を投入する', w.enemyCommand.reserveCommitted === true);
  check('決心が記録されている', w.enemyCommand.log.length > 0, `${w.enemyCommand.log.length}件`);
}

/* ------------------------------------------------------------------ */

section('長期戦 ─ 昼夜');
{
  const w = createWorld({ missionId: 'bridge_hold_long' });
  check('長期戦は夜明け前に始まる', w.mission.startTime === parseClock('0430'));
  check('夜は暗い', lightLevel(w) < 0.12, String(lightLevel(w)));

  const nightSpot = lightSpotFactor(w);
  for (let i = 0; i < 8000; i++) tick(w, 1); // 0643 ごろ
  check('日が昇ると明るくなる', lightLevel(w) > 0.9, String(lightLevel(w)));
  check('夜は索敵距離が縮む', nightSpot < lightSpotFactor(w) * 0.5, `${nightSpot} vs ${lightSpotFactor(w)}`);
}

section('長期戦 ─ 兵站');
{
  const w = createWorld({ missionId: 'bridge_hold_long' });
  check('段列が編成にいる', !!w.trains && !!w.unitsById.get('LD'));
  check('弾薬を10基数持つ', w.trains.loadsLeft === 10);
  check('短期戦に段列はいない', createWorld().trains === null);

  for (let i = 0; i < 200; i++) tick(w, 1);
  const h1 = w.unitsById.get('H1');
  h1.ammo = 20;
  const order = issueOrder(w, { unitId: 'H1', verb: 'resupply' });
  check('補給要請が出せる', order != null);

  let delivered = false;
  for (let i = 0; i < 4000 && !delivered; i++) {
    tick(w, 1);
    if (w.trains.loadsLeft < 10) delivered = true;
  }
  check('段列が弾薬を届ける', delivered);
  check('届いた部隊の弾薬が回復する', h1.ammo > 80, String(Math.round(h1.ammo)));
  check('集積所の在庫が減る', w.trains.loadsLeft === 9);

  // 空になれば要請そのものが通らない
  w.trains.loadsLeft = 0;
  w.trains.task = null;
  check('在庫がなければ要請は通らない',
    issueOrder(w, { unitId: 'H2', verb: 'resupply' }) === null);
}

section('長期戦 ─ 疲労と休養');
{
  const w = createWorld({ missionId: 'bridge_hold_long' });
  const h2 = w.unitsById.get('H2');
  check('夜通し起きている部隊は疲れている', h2.fatigue > 0);

  h2.fatigue = 330;
  check('疲労は射撃を鈍らせる', fatigueFactor(h2) < 0.8, String(fatigueFactor(h2)));
  check('疲労が言語化される', fatigueJa(h2) === '消耗が激しい');

  for (let i = 0; i < 60; i++) tick(w, 1);
  issueOrder(w, { unitId: 'H2', verb: 'rest' });
  for (let i = 0; i < 400; i++) tick(w, 1);
  check('休止命令が届く', h2.resting === true);
  const before = h2.fatigue;
  for (let i = 0; i < 600; i++) tick(w, 1);
  check('休めば疲労が抜ける', h2.fatigue < before - 40, `${before}→${h2.fatigue}`);

  issueOrder(w, { unitId: 'H2', verb: 'stand_to' });
  for (let i = 0; i < 400; i++) tick(w, 1);
  check('警戒配置で休養を打ち切れる', h2.resting === false);

  // 短期戦に兵站の命令はない
  const short = createWorld();
  check('短期戦では休止を出せない', issueOrder(short, { unitId: 'H2', verb: 'rest' }) === null);
}

section('長期戦 ─ 軽傷者の復帰');
{
  const w = createWorld({ missionId: 'bridge_hold_long' });
  const h2 = w.unitsById.get('H2');
  applyDamage(h2, 3, w.now, {});
  check('損害の一部は軽傷である', h2.walkingWounded > 0);
  const hurt = h2.strength;
  h2.lastHitAt = -Infinity;
  for (let i = 0; i < 1500; i++) tick(w, 1);
  check('静かにしていれば戦列に戻る', h2.strength > hurt, `${hurt}→${h2.strength}`);
}

section('長期戦 ─ 波状攻撃');
{
  const w = createWorld({ missionId: 'bridge_hold_long' });
  for (let i = 0; i < 30000 && !w.outcome; i++) tick(w, 1);
  const waves = w.enemyCommand.waves;
  check('波が管理されている', waves.size >= 2, `${waves.size}波`);
  check('攻撃は永久には続かない',
    [...waves.values()].some((v) => v.state === 'spent' || v.state === 'destroyed'));
  check('敵の決心が記録される', w.enemyCommand.log.length > 0);
}

section('長期戦 ─ 完走');
for (const seed of [1, 7, 4242]) {
  const w = createWorld({ seed, missionId: 'bridge_hold_long' });
  let ok = true;
  let err = '';
  try {
    for (let i = 0; i < 30000 && !w.outcome; i++) tick(w, 1);
  } catch (e) {
    ok = false;
    err = e.stack ?? String(e);
  }
  check(`長期戦 seed=${seed} が完走する`, ok && w.outcome != null, `${w.outcome ?? ''} ${err}`);
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
