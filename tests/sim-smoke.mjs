// シミュレーションの健全性テスト。ブラウザ無しで node から走らせる。
//   node tests/sim-smoke.mjs

import { createWorld, tick, addUnit, spawnReinforcement } from '../src/sim/world.js';
import { replenish } from '../src/sim/creative.js';
import { issueOrder, crossedLine } from '../src/sim/orders.js';
import { createFireMission, stepFireMissions } from '../src/sim/combat.js';
import { supportGun, layingLeft, createFlare, stepFires } from '../src/sim/fires.js';
import { aspectOf, penetrationRatio, canDefeat } from '../src/sim/armor.js';
import { createUnit, currentSpeed, UNIT_TYPES, effectiveCover } from '../src/sim/units.js';
import { missionList, friendlyOrderOfBattle, timeline } from '../src/sim/scenario.js';
import { WORLD, toGrid, fromGrid, formatClock, parseClock } from '../src/util.js';
import {
  generateTerrain, lineOfSight, terrainAt, isPassable, landmarkAt, obstacleAt,
  T, TERRAIN_NAME_JA,
} from '../src/sim/terrain.js';
import { mapList } from '../src/sim/maps.js';
import {
  mistDensity, mistAttenuation, lightLevel, lightSpotFactor, localSpotFactor,
} from '../src/sim/weather.js';
import { fatigueFactor, fatigueJa } from '../src/sim/logistics.js';
import { applyDamage } from '../src/sim/units.js';
import { composeSitrep } from '../src/sim/reports.js';
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

/** その距離で撃たれたときに、目標の遮蔽が実際どれだけ効くか（検査用） */
function coverOf(terrain, target, d) {
  const base = effectiveCover(target, terrain);
  return base * Math.min(1, Math.max(0.55, d / 160));
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

  // 遠い点への射撃は通常どおり（ただし射程内であること）
  const b2 = w.fireMissions.length;
  issueOrder(w, { unitId: 'TH', verb: 'fire_mission', x: 3200, y: 1500 });
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

section('統制線を条件にする予令');
{
  // 東西に引いた線。北から南へ来る敵が越えたら発動する。
  const line = [{ x: 1200, y: 1500 }, { x: 3600, y: 1500 }];
  check('線より南は「越えた」', crossedLine(line, 2400, 1700) === true);
  check('線より北は「越えていない」', crossedLine(line, 2400, 1300) === false);
  check('線の外側でも端で判定する', crossedLine(line, 4600, 1700) === true);
  // 斜めに引いた線でも高さを補間する
  const slant = [{ x: 1000, y: 1000 }, { x: 3000, y: 2000 }];
  check('斜めの線を補間する',
    crossedLine(slant, 2000, 1600) === true && crossedLine(slant, 2000, 1400) === false);

  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const h1 = w.unitsById.get('H1');

  const order = issueOrder(w, {
    unitId: 'H1', verb: 'withdraw', x: 2100, y: 2600,
    trigger: 'on_line', line, lineName: '甲',
  });
  check('統制線つきの予令が出せる', order?.trigger === 'on_line');
  check('線が命令に添えられる', order.line?.length === 2 && order.lineName === '甲');

  for (let i = 0; i < 400; i++) tick(w, 1);
  check('越えるまでは発動しない', order.state === 'standby', order.state);

  // 線を越えた敵を H1 に見せる
  for (let i = 0; i < 60 && order.state === 'standby'; i++) {
    h1.contacts.set('LX', {
      targetId: 'LX', x: 2300, y: 1900, lastSeenAt: w.now,
      quality: 1, classified: 'infantry', trueType: 'infantry', count: 1,
    });
    tick(w, 1);
  }
  check('越えられたら発動する', order.state !== 'standby', order.state);

  // 線を渡さなければ即時命令に落ちる
  const o2 = issueOrder(w, { unitId: 'H2', verb: 'hold', trigger: 'on_line' });
  check('線がなければ即時命令になる', o2.trigger === 'now');
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

section('図幅');
{
  const maps = mapList();
  check('図幅が3面ある', maps.length === 3, `${maps.length}面`);

  const river = generateTerrain(undefined, 'volne_river');
  const pass = generateTerrain(undefined, 'kolp_pass');
  const town = generateTerrain(undefined, 'zaren_town');

  check('河川の図幅には水がある', river.hasWater === true);
  check('峠の図幅に水はない', pass.hasWater === false);
  check('市街の図幅には運河がある', town.hasWater === true);

  const count = (t, kind) => t.type.reduce((n, v) => n + (v === kind ? 1 : 0), 0);
  check('峠には岩稜がある', count(pass, T.ROCK) > 500, `${count(pass, T.ROCK)}セル`);
  check('河川の図幅に岩稜はない', count(river, T.ROCK) === 0);
  check('市街は建物が多い', count(town, T.TOWN) > count(river, T.TOWN) * 3,
    `市街${count(town, T.TOWN)} / 河川${count(river, T.TOWN)}`);

  // 隘路が隘路として機能しているか
  check('峠の谷筋は通れる', isPassable(pass, 2420, 1400));
  check('峠の西稜は通れない', !isPassable(pass, 500, 1000));
  check('峠の東稜は通れない', !isPassable(pass, 4350, 900));

  // 図幅ごとに通過点が違う
  check('河川の通過点は橋と浅瀬', river.crossings.map((c) => c.kind).join(',') === 'bridge,ford');
  check('市街の橋は3本', town.crossings.length === 3, `${town.crossings.length}本`);
  check('前縁が図幅ごとに違う',
    Math.abs(river.front(2400) - pass.front(2400)) > 100);
}

section('ミッション');
{
  const list = missionList();
  check('ミッションが4本ある', list.length === 4, `${list.length}本`);
  check('勝敗の型が3種類ある',
    new Set(list.map((m) => m.victory?.kind ?? 'hold_point')).size === 3);

  for (const m of list) {
    const w = createWorld({ missionId: m.id });
    check(`${m.title}: 正しい図幅で始まる`, w.terrain.mapId === m.mapId,
      `${w.terrain.mapId} != ${m.mapId}`);
    check(`${m.title}: 部隊が通行可能地形にいる`,
      w.units.every((u) => u.tpl.flying || isPassable(w.terrain, u.x, u.y)));
    check(`${m.title}: 開始時刻が合っている`, w.now === m.startTime);
  }
}

section('遅滞戦');
{
  const w = createWorld({ missionId: 'kolp_delay' });
  check('遅滞の勝敗判定である', w.mission.victory.kind === 'delay_line');
  for (let i = 0; i < 20000 && !w.outcome; i++) tick(w, 1);
  check('決着する', w.outcome != null, String(w.outcome));

  // 線を越えられたら負けになる
  const w2 = createWorld({ missionId: 'kolp_delay' });
  // 第一梯団が出てくるまで進める
  for (let i = 0; i < 3000 && !w2.units.some((u) => u.side === 'enemy' && u.type !== 'recon'); i++) {
    tick(w2, 1);
  }
  const foe = w2.units.find((u) => u.side === 'enemy' && u.alive && u.type !== 'recon');
  if (foe) {
    foe.y = w2.mission.victory.lineY + 200;
    for (let i = 0; i < 260 && !w2.outcome; i++) {
      foe.y = w2.mission.victory.lineY + 200;
      tick(w2, 1);
    }
    check('南口を越えられたら敗北', w2.outcome === 'defeat', String(w2.outcome));
  } else {
    check('南口を越えられたら敗北', false, '敵がいない');
  }
}

section('逆襲');
{
  const w = createWorld({ missionId: 'zaren_counter' });
  check('奪回の勝敗判定である', w.mission.victory.kind === 'seize_point');
  for (let i = 0; i < 200; i++) tick(w, 1);
  check('守勢の敵が市街にいる',
    w.units.some((u) => u.side === 'enemy' && u.ai?.task === 'hold_ground'));

  // 目標を占めれば勝てる
  const p = w.mission.victory.point;
  for (const u of w.units) {
    if (u.side === 'enemy') { u.alive = false; u.strength = 0; }
  }
  const h1 = w.unitsById.get('H1');
  for (let i = 0; i < 400 && !w.outcome; i++) {
    h1.x = p.x;
    h1.y = p.y;
    tick(w, 1);
  }
  check('目標を保持し続ければ勝てる', w.outcome === 'victory', String(w.outcome));
}

section('通行不能地形');
{
  // 経路がどう引かれても、部隊は水上・岩稜に立たない
  let bad = null;
  for (const id of ['bridge_hold_long', 'kolp_delay', 'zaren_counter']) {
    const w = createWorld({ seed: 1, missionId: id });
    for (let i = 0; i < 20000 && !w.outcome && !bad; i++) {
      tick(w, 1);
      for (const u of w.units) {
        if (!u.alive || u.tpl.flying) continue;
        const t = terrainAt(w.terrain, u.x, u.y);
        if (t === T.WATER || t === T.ROCK) {
          bad = `${id}: ${u.id} が${TERRAIN_NAME_JA[t]}にいる`;
          break;
        }
      }
    }
  }
  check('誰も水上・岩稜に立たない', bad === null, bad ?? '');
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

section('射撃要領');
{
  // 同じ的・同じ距離で、要領だけを変えて比べる
  function trial(mode, posture) {
    const w = createWorld();
    w.units = [];
    w.unitsById.clear();
    const t = addUnit(w, {
      id: 'X', side: 'enemy', callsign: '的', type: 'infantry', x: 2200, y: 1500, posture,
    });
    w.fireMissions.push(createFireMission('he', t.x, t.y, w.now, { side: 'friend', mode, delay: 1 }));
    let held = 0;
    for (let i = 0; i < 400; i++) {
      w.now += 1;
      stepFireMissions(w, 1);
      if (t.suppression >= 60) held++;
      if (w.now - t.lastHitAt > 12) t.suppression = Math.max(0, t.suppression - 2.4);
    }
    return { loss: t.maxStrength - t.strength, held };
  }

  const openImpact = trial('impact', 'normal');
  const openAir = trial('airburst', 'normal');
  const digImpact = trial('impact', 'fortified');
  const digAir = trial('airburst', 'fortified');
  const sustained = trial('sustained', 'normal');
  const salvo = trial('salvo', 'normal');

  check('開豁地では着発が効く', openImpact.loss > openAir.loss,
    `${openImpact.loss.toFixed(2)} vs ${openAir.loss.toFixed(2)}`);
  check('陣地の敵には曳火が効く', digAir.loss > digImpact.loss * 2,
    `${digAir.loss.toFixed(2)} vs ${digImpact.loss.toFixed(2)}`);
  check('一斉射は最も削る', salvo.loss > openImpact.loss, `${salvo.loss.toFixed(2)}`);
  check('制圧射は長く押さえる', sustained.held > salvo.held * 2,
    `${sustained.held}秒 vs ${salvo.held}秒`);
  check('制圧射は撃破を狙わない', sustained.loss < openImpact.loss,
    `${sustained.loss.toFixed(2)}`);
}

section('曲射の射程と陣地変換');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const gun = supportGun(w);
  check('曲射部隊がいる', !!gun);

  const far = issueOrder(w, { unitId: 'TH', verb: 'fire_mission', x: 4900, y: 150 });
  check('射程外は断られる', far === null);
  check('断りの理由が無線に残る',
    w.radio.log.some((e) => e.text?.includes('射程外')));

  const near = issueOrder(w, { unitId: 'TH', verb: 'fire_mission', x: 2200, y: 1800 });
  check('射程内は通る', near !== null);

  // 砲を動かせば、動いているあいだは撃てない
  const w2 = createWorld();
  for (let i = 0; i < 60; i++) tick(w2, 1);
  issueOrder(w2, { unitId: 'TH', verb: 'move', x: 1600, y: 3000 });
  for (let i = 0; i < 120; i++) tick(w2, 1);
  const g2 = supportGun(w2);
  check('陣地変換中は諸元が出ていない', layingLeft(w2, g2) > 0, `${layingLeft(w2, g2)}`);
  check('陣地変換中の要請は断られる',
    issueOrder(w2, { unitId: 'TH', verb: 'fire_mission', x: 2200, y: 1800 }) === null);
}

section('照明弾');
{
  const w = createWorld({ missionId: 'kolp_delay' });
  const x = 2400;
  const y = 1500;
  const dark = localSpotFactor(w, x, y);
  w.flares.push(createFlare(x, y, w.now));
  w.now += 20;
  check('照明の下は明るくなる', localSpotFactor(w, x, y) > dark + 0.3,
    `${dark.toFixed(2)} → ${localSpotFactor(w, x, y).toFixed(2)}`);
  check('離れれば効かない', localSpotFactor(w, x + 1400, y) <= dark + 0.01);
  w.now += 240;
  stepFires(w);
  check('照明は燃え尽きる', w.flares.length === 0);

  // 弾数を食い、要請として通る
  const w2 = createWorld({ missionId: 'kolp_delay' });
  for (let i = 0; i < 60; i++) tick(w2, 1);
  const before = w2.support.illum.rounds;
  check('照明弾を持っている', before > 0);
  issueOrder(w2, { unitId: 'TH', verb: 'illum', x: 2400, y: 1500 });
  for (let i = 0; i < 300; i++) tick(w2, 1);
  check('照明弾を消費する', w2.support.illum.rounds < before,
    `${before} → ${w2.support.illum.rounds}`);
}

section('射撃中止');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  issueOrder(w, { unitId: 'TH', verb: 'fire_mission', x: 2200, y: 1700 });
  for (let i = 0; i < 60; i++) tick(w, 1);
  const flying = w.fireMissions.filter((fm) => !fm.done).length;
  const left = w.support.artillery.rounds;
  check('射撃任務が飛んでいる', flying > 0);
  issueOrder(w, { unitId: 'TH', verb: 'check_fire' });
  for (let i = 0; i < 60; i++) tick(w, 1);
  check('射撃が止まる', w.fireMissions.every((fm) => fm.done));
  check('撃っていない弾は戻る', w.support.artillery.rounds > left,
    `${left} → ${w.support.artillery.rounds}`);
}

section('音源標定と対砲兵');
{
  const w = createWorld({ missionId: 'bridge_hold_long' });
  const reports = [];
  let seen = 0;
  let guard = 0;
  while (reports.length < 3 && guard++ < 20000 && !w.outcome) {
    tick(w, 1);
    for (const e of w.radio.log.slice(seen)) {
      if (e.text?.includes('砲声') && e.meta?.reportedX != null) reports.push(e);
    }
    seen = w.radio.log.length;
  }
  check('敵が撃てば砲声が報告される', reports.length > 0, `${reports.length}件`);

  const gun = w.units.find((u) => u.side === 'enemy' && u.tpl.indirect);
  const errs = reports.map((e) => Math.hypot(e.meta.reportedX - gun.x, e.meta.reportedY - gun.y));
  const worst = Math.max(...errs);
  check('音源標定はずれるが、撃てる程度には当たる', worst > 5 && worst < 700,
    `最大誤差 ${Math.round(worst)}m`);
  check('報告が敵の迫として分類される', reports.every((e) => e.meta.classified === 'mortar'));

  // 交会がとれた報告のほうが確度が高い
  const crossed = reports.filter((e) => e.text.includes('交会'));
  if (crossed.length) {
    check('交会がとれれば確度が上がる', crossed.every((e) => e.meta.quality > 0.5));
  } else {
    check('交会がとれれば確度が上がる', true, '（この盤では交会が成立しなかった）');
  }

  // 報告された地点は自軍の砲の射程内にある（つまり潰しにいける）
  const th = w.unitsById.get('TH');
  check('報告地点は味方の砲で届く',
    Math.hypot(th.x - gun.x, th.y - gun.y) < th.tpl.indirect,
    `${Math.round(Math.hypot(th.x - gun.x, th.y - gun.y))}m`);
}

section('装甲の面と貫徹');
{
  const tank = createUnit({ id: 'T', side: 'enemy', type: 'tank', x: 0, y: 0 });
  tank.heading = 0; // 東を向いている
  const from = (x, y) => createUnit({ id: 'A', side: 'friend', type: 'at_team', x, y });
  const inf = (x, y) => createUnit({ id: 'I', side: 'friend', type: 'infantry', x, y });

  check('正面を判別する', aspectOf(from(500, 0), tank) === 'front');
  check('側面を判別する', aspectOf(from(0, 500), tank) === 'side');
  check('背面を判別する', aspectOf(from(-500, 0), tank) === 'rear');

  const pf = penetrationRatio(from(500, 0), tank, 500);
  const ps = penetrationRatio(from(0, 500), tank, 500);
  const pr = penetrationRatio(from(-500, 0), tank, 500);
  check('横腹ほど抜けやすい', ps > pf && pr > ps, `${pf.toFixed(2)}/${ps.toFixed(2)}/${pr.toFixed(2)}`);

  check('歩兵は戦車の正面を抜けない', !canDefeat(inf(500, 0), tank, 500));
  check('歩兵でも背面なら抜ける', canDefeat(inf(-500, 0), tank, 500));
  check('対戦車班は正面からでも抜ける', canDefeat(from(500, 0), tank, 500));

  // 成形炸薬は距離で威力を落とさない
  const heat = penetrationRatio(from(1400, 0), tank, 1400);
  check('対戦車ミサイルは遠くても威力が落ちない', Math.abs(heat - pf) < 0.01);
}

section('装甲戦闘');
{
  // 対戦車班と戦車を向かい合わせ、一発ずつ決着がつくことを見る
  const w = createWorld();
  w.units = [];
  w.unitsById.clear();
  const at = addUnit(w, {
    id: 'AT', side: 'friend', callsign: 'ソード', type: 'at_team',
    x: 2200, y: 2400, posture: 'dug_in',
  });
  const tk = addUnit(w, {
    id: 'TK', side: 'enemy', callsign: '敵戦車', type: 'tank', x: 2200, y: 1600,
  });
  const results = {};
  for (let i = 0; i < 900 && tk.alive; i++) {
    tick(w, 1);
    for (const ev of w.armorEvents) results[ev.result] = (results[ev.result] ?? 0) + 1;
  }
  const shots = Object.values(results).reduce((a, b) => a + b, 0);
  check('一発ずつ解決している', shots > 0, JSON.stringify(results));
  check('外れることもある', (results.miss ?? 0) > 0, JSON.stringify(results));
  check('対戦車班は戦車を仕留められる', !tk.alive || tk.strength < tk.maxStrength,
    `${tk.strength}/${tk.maxStrength}`);
  check('射撃のたびに弾が減る', at.ammo < at.tpl.maxAmmo, `${at.ammo.toFixed(0)}`);
}

/* ------------------------------------------------------------------ */

section('市街の攻撃が成立するか');
{
  // 「攻撃」は接敵しても止まらない。止まっていたので、
  // 市街に籠る敵には永久に届かず、奪回の任務は誰にも達成できなかった。
  const w = createWorld({ missionId: 'zaren_counter' });
  const obj = w.mission.victory.point;
  for (let i = 0; i < 60; i++) tick(w, 1);
  const h1 = w.unitsById.get('H1');
  const startD = Math.hypot(h1.x - obj.x, h1.y - obj.y);
  issueOrder(w, { unitId: 'H1', verb: 'attack', x: obj.x, y: obj.y });
  for (let i = 0; i < 1800 && h1.alive; i++) tick(w, 1);
  const endD = Math.hypot(h1.x - obj.x, h1.y - obj.y);
  check('攻撃は接敵しても目標へ寄せ続ける', !h1.alive || endD < startD * 0.35,
    `${Math.round(startD)}m → ${Math.round(endD)}m`);

  // 近接では掩体の値打ちが落ちる（寄られた穴は、もう掩体ではない）
  const t = generateTerrain(990117, 'zaren_town');
  const dug = createUnit({ id: 'D', side: 'enemy', type: 'infantry', x: 2300, y: 2350, posture: 'dug_in' });
  const far = coverOf(t, dug, 400);
  const near = coverOf(t, dug, 50);
  check('近接すると遮蔽が効かなくなる', near < far * 0.7, `${far.toFixed(2)} → ${near.toFixed(2)}`);

  // 勝利判定は「まだ戦える敵」だけを見る
  const w2 = createWorld({ missionId: 'zaren_counter' });
  for (let i = 0; i < 120; i++) tick(w2, 1);
  const holder = w2.units.find((u) => u.side === 'enemy' && u.type === 'infantry');
  check('目標の円は市街の見通しより内側', obj.radius < 200, `${obj.radius}m`);
  check('守備隊は目標の円の中にいる',
    Math.hypot(holder.x - obj.x, holder.y - obj.y) < obj.radius + 260);
}

section('配置の座標');
{
  // 岩や水の上に置かれた部隊は、そこから一歩も動けない ─
  // 座標がわずかにずれているだけで、その部隊は戦闘にまるごと参加しなくなる。
  // 実際、コルプ峠の迂回部隊2個が東コルプ山の岩稜に立ったまま毎回終わっていた。
  for (const m of missionList()) {
    const t = generateTerrain(m.seed, m.mapId);
    const defs = [...friendlyOrderOfBattle(m)];
    for (const ev of timeline(null, { mission: m })) {
      if (ev.kind === 'spawn') defs.push(...ev.units);
    }
    const bad = defs.filter((d) => !UNIT_TYPES[d.type].flying && !isPassable(t, d.x, d.y));
    check(`${m.id}: 全部隊が通れる地面に配置されている`, bad.length === 0,
      bad.map((d) => `${d.callsign}(${d.x},${d.y})`).join(' '));
  }

  // 万一ずれても、盤に置く時点で寄せる
  const w = createWorld({ missionId: 'kolp_delay' });
  const rock = { x: 4350, y: 800 }; // 東コルプ山の頂
  check('岩稜は通れない', !isPassable(w.terrain, rock.x, rock.y));
  const u = addUnit(w, {
    id: 'ROCKTEST', side: 'enemy', callsign: '試験', type: 'infantry', x: rock.x, y: rock.y,
  });
  check('通れない場所に置いても、通れる場所へ寄る', isPassable(w.terrain, u.x, u.y),
    `${Math.round(u.x)},${Math.round(u.y)}`);
  check('寄せる距離は程々である', Math.hypot(u.x - rock.x, u.y - rock.y) < 1300);

  // 迂回部隊がちゃんと南下する
  const w2 = createWorld({ missionId: 'kolp_delay' });
  let guard = 0;
  const startY = new Map();
  while (!w2.outcome && guard++ < 20000) {
    tick(w2, 1);
    for (const x of w2.units) {
      if (x.ai?.task === 'flank' && !startY.has(x.id)) startY.set(x.id, x.y);
    }
  }
  const flankers = w2.units.filter((x) => x.ai?.task === 'flank' || startY.has(x.id));
  const moved = flankers.filter((x) => x.y - (startY.get(x.id) ?? x.y) > 400 || !x.alive);
  check('迂回部隊は前進する（立ち往生しない）', flankers.length > 0 && moved.length > 0,
    `${moved.length}/${flankers.length}`);
}

section('地名');
{
  const t = generateTerrain(20260726, 'volne_river');
  const hill = landmarkAt(t, t.hills[0].x, t.hills[0].y);
  check('高地の頂を言い当てる', hill?.phrase === `${t.hills[0].name}の頂`, hill?.phrase);

  const slope = landmarkAt(t, t.hills[0].x, t.hills[0].y - t.hills[0].r * 0.6);
  check('斜面の向きを言う', /北.*斜面/.test(slope?.phrase ?? ''), slope?.phrase);

  const br = t.crossings[0];
  check('橋の北詰・南詰を言い分ける',
    landmarkAt(t, br.x, br.y - 200)?.phrase.includes('北詰') &&
    landmarkAt(t, br.x, br.y + 200)?.phrase.includes('南詰'),
    `${landmarkAt(t, br.x, br.y - 200)?.phrase} / ${landmarkAt(t, br.x, br.y + 200)?.phrase}`);

  check('名の無い場所は名乗らない', landmarkAt(t, 900, 3850) === null,
    landmarkAt(t, 900, 3850)?.phrase);

  // 図に刷ってある名前しか使わない（無線で言われた名前は地図で探せねばならない）
  const names = new Set([
    ...t.hills.map((h) => h.name), ...t.towns.map((x) => x.name),
    ...t.forests.filter((f) => f.name).map((f) => f.name),
    ...(t.orchards ?? []).filter((o) => o.name).map((o) => o.name),
    ...t.crossings.map((c) => c.label),
  ]);
  let allOnMap = true;
  for (let x = 200; x < WORLD.width; x += 380) {
    for (let y = 200; y < WORLD.height; y += 380) {
      const l = landmarkAt(t, x, y);
      if (l && !names.has(l.name)) allOnMap = false;
    }
  }
  check('地図に無い名前は出てこない', allOnMap);

  // 報告にも地名が乗る
  const w = createWorld();
  const h1 = w.unitsById.get('H1');
  const sit = composeSitrep(h1, w);
  check('状況報告が地名で位置を言う', /の(頂|中|上|北詰|南詰|[東西南北]+(斜面|はずれ|縁))/.test(sit), sit);
}

section('障害');
{
  const t = generateTerrain(20260726, 'volne_river');
  check('障害が敷いてある', (t.obstacles ?? []).length >= 1);
  const wire = t.obstacles.find((o) => o.kind === 'wire');
  check('鉄条網の位置が前縁から引かれている', wire && Math.abs(wire.y - t.front(wire.x) + 190) < 1,
    `${wire?.y} vs ${t.front(wire?.x ?? 0)}`);
  check('障害の中と外を判別する',
    !!obstacleAt(t, wire.x, wire.y) && !obstacleAt(t, wire.x + 900, wire.y));

  // 鉄条網の中では歩みが遅くなる
  // 前縁からの位置関係を揃えて比べる（地形そのものの差を混ぜないため）
  const outX = wire.x + 900;
  const outside = createUnit({
    id: 'A', side: 'friend', type: 'infantry', x: outX, y: t.front(outX) - 190,
  });
  const inside = createUnit({ id: 'B', side: 'friend', type: 'infantry', x: wire.x, y: wire.y });
  check('鉄条網は歩みを鈍らせる', currentSpeed(inside, t) < currentSpeed(outside, t) * 0.8,
    `${currentSpeed(inside, t).toFixed(2)} vs ${currentSpeed(outside, t).toFixed(2)}`);

  // 地雷原は動いている部隊にだけ効く（市街の図幅に敵が敷いている）
  const w = createWorld({ missionId: 'zaren_counter' });
  const mines = w.terrain.obstacles.find((o) => o.kind === 'mines');
  check('市街には地雷原がある', !!mines);
  const mover = addUnit(w, {
    id: 'MV', side: 'friend', callsign: '踏む者', type: 'infantry', x: mines.x, y: mines.y,
  });
  mover.path = [{ x: mines.x + 30, y: mines.y + 30 }];
  let hit = false;
  for (let i = 0; i < 600 && !hit; i++) {
    mover.path = [{ x: mines.x + 30, y: mines.y + 30 }];
    mover.x = mines.x;
    mover.y = mines.y;
    tick(w, 1);
    if (mover.strength < mover.maxStrength) hit = true;
  }
  check('地雷原を踏み進めば当たる', hit, `${mover.strength}/${mover.maxStrength}`);

  // 自軍が敷いた障害は既知、敵のものは伏せてある
  const zaren = generateTerrain(990117, 'zaren_town');
  check('敵の障害は地図に載っていない', zaren.obstacles.every((o) => !o.known));
  check('自軍の障害は地図に載っている', t.obstacles.every((o) => o.known));
}

section('徒歩の道と車輌の道');
{
  const t = generateTerrain(71104, 'kolp_pass');
  const track = t.crossings.find((c) => c.kind === 'track');
  const defile = t.crossings.find((c) => c.kind === 'defile');

  check('東の間道は間道として敷かれている', terrainAt(t, track.x, track.y) === T.TRACK,
    TERRAIN_NAME_JA[terrainAt(t, track.x, track.y)]);
  check('間道は徒歩なら越えられる', isPassable(t, track.x, track.y, false));
  check('間道は車輌が越えられない', !isPassable(t, track.x, track.y, true));
  check('隘路は車輌が通れる', isPassable(t, defile.x, defile.y, true));

  // 経路探索も同じ判断をする。徒歩は真っ直ぐ抜け、車輌は大回りになる。
  const from = { x: track.x, y: track.y - 500 };
  const to = { x: track.x - 200, y: track.y + 700 };
  const walked = (pts) => {
    let d = 0;
    let prev = from;
    for (const p of pts) { d += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
    return d;
  };
  const straight = Math.hypot(to.x - from.x, to.y - from.y);
  const foot = walked(findPath(t, from.x, from.y, to.x, to.y, false));
  const heavy = walked(findPath(t, from.x, from.y, to.x, to.y, true));
  check('徒歩は間道をそのまま抜ける', foot < straight * 1.4, `${Math.round(foot)}m / 直線${Math.round(straight)}m`);
  // 車輌は間道の上を通らない。周りが開けていれば脇を回るので、
  // 遠回りになるとは限らない ─ 保証するのは「間道を踏まない」ことである。
  const heavyPts = findPath(t, from.x, from.y, to.x, to.y, true);
  check('車輌の経路は間道を踏まない',
    heavyPts.every((p) => terrainAt(t, p.x, p.y) !== T.TRACK),
    `${Math.round(heavy)}m`);

  // 車輌の判定は兵種で決まる
  check('戦車・装甲車・車列・補給は車輌',
    ['tank', 'mech', 'convoy', 'supply'].every((k) => UNIT_TYPES[k].vehicle));
  check('歩兵・対戦車・偵察・迫は徒歩',
    ['infantry', 'at_team', 'recon', 'mortar'].every((k) => !UNIT_TYPES[k].vehicle));

  // 車輌に間道を割り当てても、通れる道へ回る
  const w = createWorld({ missionId: 'kolp_delay' });
  const tank = addUnit(w, {
    id: 'TKTEST', side: 'enemy', callsign: '試験戦車', type: 'tank',
    x: track.x, y: track.y - 700,
    ai: { task: 'flank', crossing: { x: track.x, y: track.y }, objective: { x: 2300, y: 3300 } },
  });
  for (let i = 0; i < 3000 && tank.alive; i++) tick(w, 1);
  check('車輌は間道の上に乗り上げない',
    !tank.alive || terrainAt(w.terrain, tank.x, tank.y) !== T.TRACK,
    `${Math.round(tank.x)},${Math.round(tank.y)}`);
}

section('鉄道');
{
  const t = generateTerrain(20260726, 'volne_river');
  check('鉄道が敷いてある', (t.rails ?? []).length > 0);
  let railCells = 0;
  for (let i = 0; i < t.type.length; i++) if (t.type[i] === T.RAIL) railCells++;
  check('線路が盤に出ている', railCells > 20, `${railCells}`);
  check('線路は通れる', isPassable(t, t.rails[0].points[1].x, t.rails[0].points[1].y));

  const kolp = generateTerrain(71104, 'kolp_pass');
  check('峠には鉄道がない', (kolp.rails ?? []).length === 0);
}

/* ------------------------------------------------------------------ */

section('演習モード');
{
  // 本編の盤には演習の仕掛けが一切無いこと（ここが緩んだらゲームが壊れる）
  const plain = createWorld();
  check('本編に演習の仕掛けは無い', plain.creative === null);
  check('本編の部隊は不死ではない',
    plain.units.every((u) => !u.invulnerable));

  const w = createWorld({ creative: { enabled: true } });
  check('演習の盤が立つ', !!w.creative);
  check('味方は倒れにくい',
    w.units.filter((u) => u.side === 'friend').every((u) => u.invulnerable));

  const h = w.unitsById.get('H1');
  const before = h.strength;
  applyDamage(h, 5, w.now, {});
  check('損害は入るが桁が違う', h.strength > before - 1 && h.strength < before,
    `${before} → ${h.strength.toFixed(2)}`);

  // 増援。0コスト・即時。
  const tank = spawnReinforcement(w, { type: 'tank', x: 2000, y: 3000, side: 'friend' });
  check('増援が呼べる', !!tank && tank.side === 'friend' && tank.type === 'tank');
  check('増援は指揮下に入る', w.unitsById.has(tank.id));
  check('増援も倒れにくい', tank.invulnerable === true);
  check('増援が編成表に載る', w.creative.roster.some((r) => r.id === tank.id));

  const foe = spawnReinforcement(w, { type: 'mech', x: 2200, y: 1200, side: 'enemy' });
  check('敵も置ける', !!foe && foe.side === 'enemy');
  check('置いた敵は不死ではない', !foe.invulnerable);

  // 弾は減らない
  const rounds = w.support.artillery.rounds;
  issueOrder(w, { unitId: 'TH', verb: 'fire_mission', x: 2200, y: 1700 });
  for (let i = 0; i < 200; i++) tick(w, 1);
  check('砲弾が減らない', w.support.artillery.rounds === rounds);
  check('それでも弾は飛ぶ', w.fireMissions.length > 0);

  // 部隊の補充
  const g = w.unitsById.get('H2');
  g.strength = 2;
  g.morale = 10;
  g.ammo = 3;
  replenish(g);
  check('補充で立て直る', g.strength === g.maxStrength && g.ammo === g.tpl.maxAmmo && g.morale > 80);

  // 演習でも決着はつく
  const w2 = createWorld({ missionId: 'kolp_delay', creative: { enabled: true } });
  let guard = 0;
  while (!w2.outcome && guard++ < 20000) tick(w2, 1);
  check('演習の盤も決着する', !!w2.outcome, `${w2.outcome}`);
}

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
