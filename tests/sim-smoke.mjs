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
import { shownSelf } from '../src/sim/comms.js';
import { findPath } from '../src/sim/pathfind.js';
import { HELD_LIMIT } from '../src/sim/orders.js';
import { composeAreaReport } from '../src/sim/reports.js';
import {
  createGame, advance, getMarkers, markUnit, updateMarker, removeMarker,
  setAutoPlot, isAutoPlot, plotContact, startClock, isPlanning,
  newCampaign, startCampaignBattle, finishCampaignBattle, getCampaignView, getCompany,
  assignReplacement, allotRounds, setNightPlan, campaignList,
  getNationView, getOfficerCorps, pickDecree, unpickDecree, stopStanding,
  purgeIn, decorateIn, getReportGap, answerPetition, purgeMinister,
} from '../src/state.js';
import {
  createNation, canDecree, checkCollapse, ruleSummary, START, stageOf, warnings,
  moraleCeiling, decree, applyDecrees, warFactors, DECREES, DECREE_IDS,
} from '../src/sim/nation.js';
import {
  createCouncil, councilFactors, blocEffect, ensurePetition,
  answerPetition as councilAnswer, purgeMinister as councilPurgeMinister,
  shiftSupport, hushOf, checkCouncil, supportStage, BLOC_IDS, BLOC_LINE, PETITION_LINE,
  PETITIONS, findPetition,
} from '../src/sim/council.js';
import { enqueue as commsEnqueue } from '../src/sim/comms.js';
import { endPlanning } from '../src/sim/world.js';
import {
  rollOfficers, createOfficer, officerFactors, debriefOfficer, TEMPERAMENTS, isWavering,
} from '../src/sim/officers.js';
import {
  attachmentMods, fits, canBreach, SLOTS_PER_UNIT,
} from '../src/sim/attachments.js';
import { isArmorDuel } from '../src/sim/armor.js';
import {
  replacementRoom, serializeCampaign, deserializeCampaign, recordBattle, settleNight,
} from '../src/sim/campaign.js';
import { Rng } from '../src/util.js';

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
  check('受領しても動き出さない', order.state === 'standby' && h2.heldOrders.includes(order));
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
  // 軸を二つと決め打っていたので、渡河点が三本ある図幅では
  // 三本目が誰の軸でもなくなっていた。図幅の通過点の数だけ軸がある。
  const cross = w.terrain.crossings ?? [];
  check('通過点の数だけ軸がある',
    cross.length > 0 && cross.every((c) => !!w.enemyCommand.axes[c.id ?? c.label]),
    `${cross.map((c) => c.id ?? c.label).join(',')} / ${Object.keys(w.enemyCommand.axes).join(',')}`);
  check('どの軸も進み具合を持っている',
    Object.values(w.enemyCommand.axes).every((a) => Number.isFinite(a.progress)));
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

section('自動記入');
{
  const runFor = (g, seconds) => {
    // H時を宣言しないと時計は動かない（作戦命令を渡す間は止まっている）。
    if (isPlanning(g)) startClock(g);
    g.running = true;
    // advance() は実秒を受ける。1回 0.5 実秒 = 3 秒ぶん進む。
    for (let i = 0; i < seconds / 3 && !g.finished; i++) advance(g, 0.5);
  };

  const g = createGame({ missionId: 'bridge' });
  check('開戦時の盤は白紙', getMarkers(g).length === 0);

  runFor(g, 300);
  const friends = getMarkers(g).filter((m) => m.unitId);
  check('交信した部隊の駒が立つ', friends.length >= 4, `${friends.length}`);
  check('駒に呼出符号が入る', friends.every((m) => m.label));
  check('駒に現況が添う', friends.some((m) => m.note));
  check('自動記入は取り消し履歴を汚さない', g.history.length === 0, `${g.history.length}`);

  // 同じ部隊の続報で駒が増えず、動く
  const before = getMarkers(g).filter((m) => m.unitId === friends[0].unitId).length;
  runFor(g, 3600); // 0800 ─ 敵が渡ってくるところまで進める
  const after = getMarkers(g).filter((m) => m.unitId === friends[0].unitId).length;
  check('続報で駒は増えない', before === 1 && after === 1, `${before}→${after}`);

  const foes = getMarkers(g).filter((m) => m.src?.startsWith('c:'));
  check('敵情も盤に写る', foes.length > 0, `${foes.length}`);
  check('敵の駒に報告者が添う', foes.every((m) => m.note));

  // 下ろした駒は、次の報告で勝手に立ち上がらない
  const victim = getMarkers(g).find((m) => m.unitId);
  removeMarker(g, victim.id);
  runFor(g, 600);
  check(
    '下ろした駒は戻らない',
    !getMarkers(g).some((m) => m.unitId === victim.unitId),
    `${victim.unitId}`
  );
  // 指揮官が自分で置き直せば、また書記の担当に戻る
  markUnit(g, victim.unitId);
  const back = getMarkers(g).find((m) => m.unitId === victim.unitId);
  check('置き直せば復帰する', !!back);
  runFor(g, 300);
  check('復帰後はまた追随する', getMarkers(g).some((m) => m.unitId === victim.unitId));

  // 名前を書き入れた駒は、書記が上書きしない
  const mine = getMarkers(g).find((m) => m.unitId);
  updateMarker(g, mine.id, { label: '左翼の要' });
  runFor(g, 600);
  check(
    '付けた名前は消されない',
    getMarkers(g).find((m) => m.id === mine.id)?.label === '左翼の要'
  );

  // 切れば止まる
  const g2 = createGame({ missionId: 'bridge', autoPlot: false });
  check('切って始められる', !isAutoPlot(g2));
  runFor(g2, 900);
  check('切れば何も写らない', getMarkers(g2).length === 0, `${getMarkers(g2).length}`);
  setAutoPlot(g2, true);
  runFor(g2, 300);
  check('入れ直せば写り始める', getMarkers(g2).length > 0);

  // 届かなかった送信は盤に何も残さない
  const g3 = createGame({ missionId: 'bridge' });
  const lost = {
    lost: true,
    from: 'ハンマー1',
    fromId: 'H1',
    kind: 'contact',
    at: g3.world.now,
    meta: { reportedX: 2000, reportedY: 2000, classified: 'tank', quality: 0.9, contactId: 'X1' },
  };
  plotContact(g3, lost);
  check('聞こえなかった報告は写らない', getMarkers(g3).length === 0);
}

/* ------------------------------------------------------------------ */

section('H時前の作戦命令');
{
  const w = createWorld({ missionId: 'bridge_hold', planning: true });
  check('既定で計画中', w.planning === true);

  const before = w.radio.queue.length;
  issueOrder(w, { unitId: 'H1', verb: 'defend', x: 2380, y: 1180 });
  issueOrder(w, { unitId: 'TH', verb: 'register', x: 2400, y: 900 });
  check('計画の命令は網に乗らない', w.radio.queue.length === before, `${w.radio.queue.length}`);
  check('計画の命令は即座に受領される', w.orders.every((o) => o.state === 'received'));

  tick(w, 1);
  check('概定射点は前夜のうちに諸元が出る',
    w.registrations.length === 1 && w.registrations[0].readyAt <= w.now,
    JSON.stringify(w.registrations));
  // 網に増えるのは大隊本部からの一報だけで、部下の復唱は乗らない
  check('復唱も網に乗らない',
    !w.radio.queue.some((t) => t.kind === 'ack') &&
    !w.radio.log.some((l) => l.kind === 'ack'),
    w.radio.queue.map((t) => t.kind).join(','));
  check('命令書は記録簿に残る',
    w.radio.log.some((l) => l.kind === 'system' && l.text.includes('作戦命令')));

  endPlanning(w);
  check('H時で計画は畳まれる', w.planning === false);
  const q = w.radio.queue.length;
  issueOrder(w, { unitId: 'H2', verb: 'defend', x: 2300, y: 1300 });
  check('H時以後の命令は網に乗る', w.radio.queue.length > q);

  // 単発の戦闘でも、標定に時間が要ることは変わらない
  const w2 = createWorld({ missionId: 'bridge_hold' });
  check('計画を渡さなければ最初から時計が動く', w2.planning === false);
  issueOrder(w2, { unitId: 'TH', verb: 'register', x: 2400, y: 900 });
  for (let i = 0; i < 30; i++) tick(w2, 1);
  check('戦闘中の標定には時間が要る',
    w2.registrations.length === 1 && w2.registrations[0].readyAt > w2.now,
    JSON.stringify(w2.registrations));
}

/* ------------------------------------------------------------------ */

section('将校');
{
  const rng = new Rng(4242);
  const roster = [
    { id: 'H1', callsign: 'ハンマー1', unitType: 'infantry' },
    { id: 'H2', callsign: 'ハンマー2', unitType: 'infantry' },
    { id: 'TH', callsign: 'ソーン', unitType: 'mortar' },
  ];
  const officers = rollOfficers(rng, roster);
  check('全員に将校が付く', officers.size === 3);
  check('同姓が並ばない', new Set([...officers.values()].map((o) => o.name)).size === 3);
  check('階級が兵科に見合う', ['准尉', '少尉'].includes(officers.get('TH').rank), officers.get('TH').rank);

  // 気質は係数に出る。ただし極端には振れない。
  for (const id of Object.keys(TEMPERAMENTS)) {
    const f = officerFactors(createOfficer({ unitId: 'X', temperament: id }));
    const bad = Object.entries(f).filter(([, v]) => !(v >= 0.6 && v <= 1.6));
    check(`${TEMPERAMENTS[id].label}の係数が範囲内`, bad.length === 0, JSON.stringify(bad));
  }
  check('将校が居なければ全て並', Object.values(officerFactors(null)).every((v) => v === 1));

  // 特性は与えるものではなく生えるもの
  const o = createOfficer({ unitId: 'H1', callsign: 'ハンマー1', temperament: 'steady' });
  check('最初は特性を持たない', o.traits.length === 0);
  const gained = debriefOfficer(o, {
    survived: true, strengthRatio: 0.6, lossRatio: 0.3, inflicted: 2,
    heldUnderFire: true, selfWithdrew: false, refusedOrders: 0, transmissions: 9, avgResponse: 40,
  });
  check('砲撃下で線を動かさなければ不動が付く',
    o.traits.includes('ironhearted'), o.traits.join(','));
  check('生えた特性が返る', gained.some((t) => t.label === '不動'));
  check('生き延びた戦闘が経験になる', o.xp === 1 && o.battles === 1);
  check('特性は係数を動かす', officerFactors(o).nerve > officerFactors(
    createOfficer({ unitId: 'H1', temperament: 'steady' })).nerve);

  const o2 = createOfficer({ unitId: 'H2', temperament: 'steady' });
  debriefOfficer(o2, { survived: true, strengthRatio: 0.3, lossRatio: 0.7, inflicted: 0 });
  check('半分に削られた者には手負いが付く', o2.traits.includes('scarred'), o2.traits.join(','));
  check('三つを超えて札は提げない', (() => {
    const o3 = createOfficer({ unitId: 'H3', temperament: 'steady' });
    for (let i = 0; i < 6; i++) {
      debriefOfficer(o3, {
        survived: true, strengthRatio: 0.3, lossRatio: 0.5, inflicted: 9,
        heldUnderFire: true, selfWithdrew: false, refusedOrders: 3,
        transmissions: 1, avgResponse: 10, woundedRecovered: 4,
      });
    }
    return o3.traits.length <= 3;
  })());

  // 気質は実際の戦闘に効く
  const w = createWorld({ missionId: 'bridge_hold' });
  const h1 = w.unitsById.get('H1');
  check('単発の戦闘に将校は居ない', !h1.officer);
  const w2 = createWorld({
    missionId: 'bridge_hold',
    setup: { units: {}, officers: new Map([['H1', createOfficer({ unitId: 'H1', temperament: 'meticulous' })]]) },
  });
  check('戦役では部隊に将校が付く', !!w2.unitsById.get('H1').officer);
  check('熟練は腕に出る', w2.unitsById.get('H1').skill !== h1.skill);
}

/* ------------------------------------------------------------------ */

section('任務編成');
{
  check('分派は兵科を選ぶ', fits('mg', 'infantry') && !fits('mg', 'mortar'));
  const m = attachmentMods(['mg', 'eng']);
  check('分派は掛け算で効く', m.firepower > 1 && m.speed < 1 && m.cover > 1, JSON.stringify(m));
  check('何も付けなければ全て並',
    Object.values(attachmentMods([])).every((v) => v === 1));

  const mk = (attach) => createWorld({
    missionId: 'bridge_hold',
    setup: { units: {}, officers: new Map(), attach },
  }).unitsById.get('H1');

  const plain = mk({});
  const mg = mk({ H1: ['mg'] });
  check('機関銃班で火力が上がる', mg.mods.firepower > plain.mods.firepower);
  check('機関銃班で足が鈍る', mg.mods.speed < plain.mods.speed);

  const wEng = createWorld({
    missionId: 'bridge_hold', setup: { units: {}, officers: new Map(), attach: { H1: ['eng'] } },
  });
  const wPlain = createWorld({ missionId: 'bridge_hold' });
  check('工兵で掩体が深くなる',
    effectiveCover(wEng.unitsById.get('H1'), wEng.terrain) >
    effectiveCover(wPlain.unitsById.get('H1'), wPlain.terrain));
  check('工兵は障害を処理できる', canBreach(wEng.unitsById.get('H1')));
  check('素の分隊は障害を処理できない', !canBreach(wPlain.unitsById.get('H1')));

  const at = mk({ H1: ['at'] });
  const tank = { tpl: { armor: 0.88 } };
  const apOf = (u) => u.tpl.ap * u.mods.ap;
  check('対戦車小隊で対装甲火力が上がる', apOf(at) > apOf(plain) * 2, `${apOf(plain)}→${apOf(at)}`);
  check('付けた部隊は装甲と撃ち合える', isArmorDuel(at, tank));
  check('一個の部隊に3つは付かない', SLOTS_PER_UNIT === 2);
}

/* ------------------------------------------------------------------ */

section('戦役');
{
  const st = newCampaign('volne_three_days', 20260727);
  check('三日である', getCampaignView(st).stageCount === 3);
  check('初日は峠', getCampaignView(st).stage.missionId === 'kolp_delay');
  check('全段階の任務が実在する', (() => {
    const ids = new Set(missionList().map((m) => m.id));
    return campaignList()[0].stages.every((s) => ids.has(s.missionId));
  })());
  check('全員に名前が配られる', getCompany(st).every((r) => !!r.officer), '');
  check('三日目に初めて出る部隊にも名前がある', (() => {
    const st2 = newCampaign('volne_three_days', 11);
    return !!st2.officers.get('SH');
  })());

  // 補充は定員まで、かつ一晩ぶんまで
  st.carry.H1.strength = 2;
  check('壊滅した分隊は一晩では戻らない', replacementRoom(st, 'H1') === 4, `${replacementRoom(st, 'H1')}`);
  assignReplacement(st, 'H1', 99);
  check('手持ちを超えて配れない', st.assign.H1 <= st.pool.replacements, `${st.assign.H1}`);

  // 弾薬の割り当ては次の戦闘に上乗せされる
  st.assign = {};
  allotRounds(st, 'rounds', 3);
  const g = startCampaignBattle(st);
  check('戦役の一戦が起こせる', !!g);
  check('割り当てた砲弾が上乗せされる',
    g.world.support.artillery.rounds === g.world.mission.support.artillery.rounds + 3,
    `${g.world.support.artillery.rounds}`);
  check('戦役の戦闘もH時前から始まる', isPlanning(g));

  // 夜の使い方
  setNightPlan(st, 'fortify');
  const gF = startCampaignBattle(st);
  check('陣地構築で防御の部隊が構築陣地から始まる',
    [...gF.world.unitsById.values()].some((u) => u.side === 'friend' && u.posture === 'fortified'));
  setNightPlan(st, 'recon');
  const gR = startCampaignBattle(st);
  check('夜間偵察は夜明けに一報が入る',
    gR.world.radio.log.some((l) => l.from === '夜間斥候'));
  check('その一報は指揮官に届いている',
    gR.belief.log.some((l) => l.from === '夜間斥候'));

  // 一戦を回して持ち越す
  setNightPlan(st, 'rest');
  const g2 = startCampaignBattle(st);
  startClock(g2);
  let guard = 0;
  while (!g2.finished && guard++ < 6000) advance(g2, 0.5);
  check('戦役の一戦が決着する', g2.finished && !!g2.world.outcome, `${g2.world.outcome}`);

  const before = st.stage;
  const res = finishCampaignBattle(g2);
  check('結果が帳簿に入る', st.stage === before + 1 && st.history.length === 1, `${st.stage}`);
  check('二度取り込まない', finishCampaignBattle(g2) === res);
  check('戦線が動く', st.front !== 50, `${st.front}`);
  check('残兵が持ち越される', Object.keys(st.carry).length > 0);
  check('将校が一戦ぶん歳を取る',
    [...st.officers.values()].some((o) => o.battles === 1 || o.fallen));

  const rows = getCompany(st);
  check('中隊の現況が読める', rows.length >= 6 && rows.every((r) => r.maxStrength > 0));
  check('弾は減っている', rows.some((r) => r.ammoRatio < 1));

  // 保存と読み出し
  const raw = serializeCampaign(st);
  const back = deserializeCampaign(JSON.parse(JSON.stringify(raw)));
  check('戦役を書き出して読み戻せる',
    back.stage === st.stage && back.front === st.front &&
    back.officers.size === st.officers.size &&
    back.history.length === st.history.length);
  check('読み戻した将校も特性を持つ',
    [...back.officers.values()].every((o) => Array.isArray(o.traits)));

  // 三日走り切る
  const st3 = newCampaign('volne_three_days', 991);
  let days = 0;
  while (!st3.finished && days++ < 6) {
    const gg = startCampaignBattle(st3);
    startClock(gg);
    let k = 0;
    while (!gg.finished && k++ < 6000) advance(gg, 0.5);
    finishCampaignBattle(gg);
  }
  check('戦役が決着する', st3.finished && !!st3.result, `${st3.result}`);
  check('戦役の結果に理由がある', (st3.resultReason ?? '').length > 5);
  check('日数は三日を超えない', st3.history.length <= 3, `${st3.history.length}`);
}

/* ------------------------------------------------------------------ */

section('国政');
{
  const st = newCampaign('volne_three_days', 31337);
  const v0 = getNationView(st);
  check('国が起きている', !!v0 && v0.meters.length === 3, `${v0?.meters.length}`);
  check('架空国家である', v0.name.includes('ヴォルネ'));
  check('最初は恐怖がない', v0.fear === 0);

  // 一晩に出せるのは二つまで
  check('政令が出せる', pickDecree(st, 'conscript').ok);
  check('二つ目も出せる', pickDecree(st, 'martial_law').ok);
  check('三つ目は出せない', !pickDecree(st, 'relief').ok, pickDecree(st, 'relief').why);
  check('取り消せる', unpickDecree(st, 'martial_law'));
  check('取り消せば出せる', pickDecree(st, 'relief').ok);

  // 国庫が足りなければ出せない
  st.nation.treasury = 0;
  check('国庫が空なら出せない', !canDecree(st.nation, 'honors').ok);
  st.nation.treasury = 60;

  // 出撃の直前に実施される
  const beforePool = st.pool.replacements;
  const g = startCampaignBattle(st);
  check('政令で補充が増える', st.pool.replacements > beforePool,
    `${beforePool} → ${st.pool.replacements}`);
  check('政令は帳簿に残る', st.nation.ledger.length === 2, `${st.nation.ledger.length}`);
  check('出したものは白紙に戻る', st.nation.decrees.length === 0);
  check('国の係数が盤に渡る', !!g.world.setup.war && !!g.world.distortion);

  // 徴兵は数を揃えるが、民心を削る
  const stC = newCampaign('volne_three_days', 5);
  pickDecree(stC, 'conscript');
  startCampaignBattle(stC);
  check('徴兵は民心を下げる', stC.nation.morale < START.morale, `${stC.nation.morale}`);
  const stV = newCampaign('volne_three_days', 5);
  pickDecree(stV, 'volunteer');
  startCampaignBattle(stV);
  check('志願は数が少ない代わりに民心を削らない',
    stV.nation.morale > stC.nation.morale &&
    stV.pool.replacements < stC.pool.replacements,
    `志願 民${Math.round(stV.nation.morale)}/兵${stV.pool.replacements} ` +
    `徴兵 民${Math.round(stC.nation.morale)}/兵${stC.pool.replacements}`);

  // 一晩は一度しか明けない
  const stN = newCampaign('volne_three_days', 6);
  pickDecree(stN, 'tax');
  startCampaignBattle(stN);
  const once = { pool: stN.pool.replacements, treasury: stN.nation.treasury };
  startCampaignBattle(stN);
  startCampaignBattle(stN);
  check('出撃し直しても決算は一度きり',
    stN.pool.replacements === once.pool && stN.nation.treasury === once.treasury,
    `補充 ${once.pool}→${stN.pool.replacements} 国庫 ${once.treasury}→${stN.nation.treasury}`);

  // 継続の令
  const st2 = newCampaign('volne_three_days', 4);
  pickDecree(st2, 'censorship');
  startCampaignBattle(st2);
  check('継続の令は施行中に残る', st2.nation.standing.includes('censorship'));
  check('情報統制は恐怖を生む', st2.nation.fear > 0.1, `${st2.nation.fear}`);
  const fearAt = st2.nation.fear;
  stopStanding(st2, 'censorship');
  check('解けば施行中から消える', !st2.nation.standing.includes('censorship'));

  // 底で詰まっている目盛りを、令の出し入れで増やせてはいけない
  const stX = newCampaign('volne_three_days', 9);
  stX.nation.morale = 2;
  pickDecree(stX, 'martial_law');
  startCampaignBattle(stX);
  const bottomed = stX.nation.morale;
  stopStanding(stX, 'martial_law');
  check('令の出し入れで民心は湧かない', stX.nation.morale <= 2.01,
    `2 → ${bottomed} → ${stX.nation.morale}`);
  check('恐怖は半分しか戻らない',
    st2.nation.fear > 0 && st2.nation.fear < fearAt, `${fearAt} → ${st2.nation.fear}`);
}

section('恐怖と報告');
{
  // 恐怖で統治された軍では、部下は自分の損害を小さく言う。
  const mk = (fear) => {
    const w = createWorld({
      missionId: 'bridge_hold',
      setup: { units: {}, officers: new Map(), war: { fear, honesty: 1 - fear } },
    });
    const u = w.unitsById.get('H1');
    u.strength = 3;
    u.morale = 30;
    u.ammo = 10;
    u.walkingWounded = 2;
    commsEnqueue(w, { from: u.callsign, fromId: 'H1', kind: 'sitrep', text: 'x', composedAt: w.now });
    return w.radio.queue.at(-1).meta.self;
  };
  const honest = mk(0);
  const afraid = mk(0.8);
  check('恐怖がなければ見たとおりを言う', honest.strength === '3/9名', honest.strength);
  check('恐怖の下では損害を小さく言う',
    afraid.strengthRatio > honest.strengthRatio, `${honest.strength} → ${afraid.strength}`);
  check('士気も良く言う', afraid.morale !== honest.morale, `${honest.morale} → ${afraid.morale}`);
  check('弾も多めに言う', afraid.ammoRatio > honest.ammoRatio);
  check('負傷者は言わなくなる', honest.wounded && !afraid.wounded);
  check('位置は歪まない', afraid.grid === honest.grid);

  // 講評は真実を出す。ここは歪ませない。
  const w = createWorld({
    missionId: 'bridge_hold',
    setup: { units: {}, officers: new Map(), war: { fear: 0.9, honesty: 0.1 } },
  });
  const u = w.unitsById.get('H1');
  u.strength = 2;
  check('真実の兵力は歪まない', u.strength === 2);
}

section('忠誠と粛清');
{
  const st = newCampaign('volne_three_days', 909);
  const corps0 = getOfficerCorps(st);
  check('士官団が読める', corps0.length >= 6, `${corps0.length}`);
  check('忠誠が一人ずつ出る', corps0.every((o) => typeof o.loyalty === 'number'));
  check('粛清の代価が先に分かる', corps0.every((o) => o.cost && o.cost.loyalty < 0));

  const target = corps0[0];
  const before = { loyalty: st.nation.loyalty, control: st.nation.control };
  const res = purgeIn(st, target.unitId);
  check('粛清できる', !!res && res.removed.name === target.name);
  check('統制は上がる', st.nation.control > before.control, `${before.control} → ${st.nation.control}`);
  check('忠誠は下がる', st.nation.loyalty < before.loyalty, `${before.loyalty} → ${st.nation.loyalty}`);
  check('恐怖が増える', st.nation.fear > 0);
  check('代わりが立つ', st.officers.get(target.unitId).name !== target.name);
  check('経歴は戻らない', st.officers.get(target.unitId).xp === 0);
  check('数えられている', st.nation.purged.length === 1);
  const rec = getNationView(st).purged[0];
  check('除かれた者が記録に残る', rec.name === target.name);
  check('何日目かも残る', rec.day === 1, `${rec.day}`);
  check('呼出符号と戦数も残る', !!rec.callsign && typeof rec.battles === 'number');

  // 指標には段階の語が付く
  const meters = getNationView(st).meters;
  check('指標に段階の語が付く', meters.every((m) => (m.stage ?? '').length > 0),
    meters.map((m) => `${m.label}:${m.stage}`).join(' '));
  check('崖の手前に名前がある', stageOf('loyalty', 20) === '造反' || stageOf('loyalty', 35) === '離心',
    `${stageOf('loyalty', 35)}`);

  // 離れかけている者を除くほうが、士官団は揺れない
  const a = newCampaign('volne_three_days', 11);
  const b = newCampaign('volne_three_days', 11);
  const id = getOfficerCorps(a)[0].unitId;
  a.officers.get(id).loyalty = 10;
  b.officers.get(id).loyalty = 95;
  purgeIn(a, id);
  purgeIn(b, id);
  check('離反者を除くほうが安く済む', a.nation.loyalty > b.nation.loyalty,
    `離反者 ${a.nation.loyalty} / 忠臣 ${b.nation.loyalty}`);

  // 忠誠は命令の呑み込みに効く
  const loyal = officerFactors(createOfficer({ unitId: 'X', temperament: 'steady', loyalty: 92 }));
  const sullen = officerFactors(createOfficer({ unitId: 'Y', temperament: 'steady', loyalty: 8 }));
  check('心服している者は呑み込みが早い', loyal.obey > sullen.obey,
    `${loyal.obey.toFixed(2)} / ${sullen.obey.toFixed(2)}`);
  check('離反寸前は動揺として出る', isWavering(createOfficer({ unitId: 'Z', loyalty: 10 })));

  // 叙勲
  const st3 = newCampaign('volne_three_days', 77);
  const who = getOfficerCorps(st3)[0].unitId;
  const l0 = st3.officers.get(who).loyalty;
  decorateIn(st3, who);
  check('叙勲で忠誠が上がる', st3.officers.get(who).loyalty > l0,
    `${l0} → ${st3.officers.get(who).loyalty}`);
}

section('国が保たなくなるとき');
{
  // 見えない賽ではなく、期限である。線を割った晩に通告が出て、
  // 次の朝までに戻せなければ終わる ─ だから一手番ぶんの猶予がある。
  const n = createNation();
  n.loyalty = 5;
  check('線を割ると通告が出る', checkCollapse(n) === null && n.warned.coup === true);
  check('通告に文言がある', (n.notices ?? []).some((t) => t.includes('命令を受けない')),
    (n.notices ?? []).join('/'));
  check('戻せていなければ次の朝に造反', checkCollapse(n)?.id === 'coup');

  // 猶予のうちに戻せば、何も起きない
  const n1 = createNation();
  n1.loyalty = 5;
  checkCollapse(n1);
  n1.loyalty = 55;
  check('戻せば踏みとどまる', checkCollapse(n1) === null && !n1.warned.coup);
  check('踏みとどまったことも伝わる',
    (n1.notices ?? []).some((t) => t.includes('踏みとどまった')), (n1.notices ?? []).join('/'));

  const n2 = createNation();
  n2.morale = 3;
  check('民心でも同じ手順', checkCollapse(n2) === null && n2.warned.uprising);
  check('戻せなければ内乱', checkCollapse(n2)?.id === 'uprising');
  check('健全なら何も起きない', checkCollapse(createNation()) === null);
  check('通告は画面に出せる', warnings(n2).some((w) => w.id === 'uprising'));

  // 戦役の決着として出る。
  // 一戦を回して確かめると勝敗次第で忠誠が戻ってしまうので、
  // 帳簿への取り込みそのものを直接叩く。
  const st = newCampaign('volne_three_days', 616);
  st.nation.loyalty = 5;
  st.nation.morale = 40;
  st.nation.warned = { coup: true, uprising: false }; // 前の晩に通告が出ている
  recordBattle(st, {
    outcome: 'defeat',
    units: [],
    score: { losses: 0, enemyLosses: 0, civilianLosses: 0, friendlyFireUnits: 0 },
  }, new Rng(3));
  check('造反は戦役の決着になる', st.finished && st.result === 'collapse', `${st.result}`);
  check('決着の理由が出る', (st.resultReason ?? '').length > 5);
  check('画面にも造反として出る', getCampaignView(st).collapse === 'coup');

  // 民心が尽きれば内乱として決着する
  const st2 = newCampaign('volne_three_days', 617);
  st2.nation.morale = 3;
  st2.nation.loyalty = 60;
  st2.nation.warned = { coup: false, uprising: true };
  recordBattle(st2, {
    outcome: 'defeat',
    units: [],
    score: { losses: 0, enemyLosses: 0, civilianLosses: 0, friendlyFireUnits: 0 },
  }, new Rng(3));
  check('内乱も戦役の決着になる', st2.result === 'collapse' && st2.collapse === 'uprising',
    `${st2.result}/${st2.collapse}`);
}

section('統治の評価');
{
  const harsh = createNation();
  for (const id of ['martial_law', 'censorship', 'secret_police', 'conscript', 'requisition']) {
    harsh.ledger.push({ day: 1, id, label: id });
  }
  check('苛政と評される', ruleSummary(harsh).label === '苛政', ruleSummary(harsh).label);

  const mild = createNation();
  for (const id of ['relief', 'amnesty', 'honors', 'free_press', 'volunteer']) {
    mild.ledger.push({ day: 1, id, label: id });
  }
  check('寛政と評される', ruleSummary(mild).label === '寛政', ruleSummary(mild).label);
  check('何もしなければ中庸', ruleSummary(createNation()).label === '中庸');
  check('評価に説教が付かない', ruleSummary(harsh).note.length > 5);

  // 保存
  const st = newCampaign('volne_three_days', 8);
  pickDecree(st, 'censorship');
  startCampaignBattle(st);
  purgeIn(st, getOfficerCorps(st)[0].unitId);
  const back = deserializeCampaign(JSON.parse(JSON.stringify(serializeCampaign(st))));
  check('国も書き出して読み戻せる',
    back.nation.fear === st.nation.fear &&
    back.nation.purged.length === 1 &&
    back.nation.standing.includes('censorship'));
  check('忠誠も読み戻せる',
    [...back.officers.values()].every((o) => typeof o.loyalty === 'number'));
  // v2.0 の保存（国が無い）も読める
  const oldSave = JSON.parse(JSON.stringify(serializeCampaign(st)));
  delete oldSave.nation;
  check('国の無い古い保存も読める', !!deserializeCampaign(oldSave)?.nation);
}

/* ------------------------------------------------------------------ */

section('統治に支配戦略が無いこと');
{
  // 増税して救済すれば毎晩ただで国が富む、という穴があった。
  const n = createNation();
  const start = n.morale;
  let peak = start;
  for (let i = 0; i < 6; i++) {
    decree(n, 'tax');
    decree(n, 'relief');
    applyDecrees(n, i + 1);
    peak = Math.max(peak, n.morale);
  }
  check('増税と救済を繰り返しても民心は伸び続けない', n.morale <= peak - 5,
    `頂 ${peak.toFixed(0)} → ${n.morale.toFixed(0)}`);
  check('取られた側は覚えている（天井が下がる）', moraleCeiling(n) < 100, `${moraleCeiling(n)}`);

  // 情報統制を敷いて報道を解禁すれば恐怖だけ洗い流せる、という穴があった。
  const m = createNation();
  decree(m, 'censorship');
  applyDecrees(m, 1);
  const got = { control: m.control, morale: m.morale };
  decree(m, 'free_press');
  applyDecrees(m, 2);
  check('恐怖の洗浄で統制は残らない', m.control < got.control, `${got.control} → ${m.control}`);
  check('民心も返る', m.morale < got.morale, `${got.morale} → ${m.morale}`);

  // 継続の令は毎晩の費用がかかる（敷きっぱなしがただではない）
  const k = createNation();
  decree(k, 'martial_law');
  applyDecrees(k, 1);
  const t1 = k.treasury;
  applyDecrees(k, 2);
  const gain = k.treasury - t1;
  const bare = createNation();
  const t0 = bare.treasury;
  applyDecrees(bare, 1);
  check('継続の令には毎晩の維持費がかかる', gain < bare.treasury - t0,
    `戒厳あり +${gain} / なし +${bare.treasury - t0}`);
  // 恐怖を生むのは保安部であって、戒厳令ではない ─ 秩序と恐怖は別の道具である。
  check('戒厳令は秩序を買う令であって、恐怖の令ではない', k.fear < 0.05, `${k.fear.toFixed(2)}`);
  const sp = createNation();
  decree(sp, 'secret_police');
  applyDecrees(sp, 1);
  const f1 = sp.fear;
  applyDecrees(sp, 2);
  applyDecrees(sp, 3);
  check('保安部は敷いている限り恐怖を積む', sp.fear >= f1, `${f1.toFixed(2)} → ${sp.fear.toFixed(2)}`);
  check('二つは別の軸である', sp.control < k.control && sp.fear > k.fear,
    `戒厳 統制${k.control.toFixed(0)}/恐怖${k.fear.toFixed(2)} ` +
    `保安 統制${sp.control.toFixed(0)}/恐怖${sp.fear.toFixed(2)}`);

  // 遅れ ─ 善政は翌晩に届く
  const slow = createNation();
  decree(slow, 'volunteer');
  const r1 = applyDecrees(slow, 1);
  check('志願兵は今夜には来ない', (r1.pending?.replacements ?? 0) > 0);
  const r2 = applyDecrees(slow, 2);
  check('翌晩に届く', r2.output.replacements > 0);
}

section('恐怖の見返り');
{
  // 罰しかない機構は選ばれない。恐怖には見返りがある ─ 命令が通る。
  const calm = warFactors({ morale: 60, control: 50, loyalty: 60, fear: 0 });
  const afraid = warFactors({ morale: 60, control: 50, loyalty: 60, fear: 0.8 });
  const beloved = warFactors({ morale: 60, control: 50, loyalty: 98, fear: 0 });
  check('恐怖で命令は通りやすくなる', afraid.obey > calm.obey,
    `${calm.obey.toFixed(2)} → ${afraid.obey.toFixed(2)}`);
  check('心服でも命令は通る', beloved.obey > calm.obey,
    `${calm.obey.toFixed(2)} → ${beloved.obey.toFixed(2)}`);
  check('どちらも極端には振れない',
    afraid.obey <= 1.45 && beloved.obey <= 1.45 && calm.obey >= 0.6);

  // 嘘をつくのは全員ではない
  const w = createWorld({
    missionId: 'bridge_hold',
    setup: { units: {}, officers: new Map(), war: { fear: 0.55, obey: 1 } },
  });
  const mk = (id, temperament, loyalty) => {
    const u = w.unitsById.get(id);
    u.officer = createOfficer({ unitId: id, temperament, loyalty });
    u.strength = 3;
    return shownSelf(w, u).strength;
  };
  const bold = mk('H1', 'headstrong', 85);
  const meek = mk('H2', 'meticulous', 20);
  check('心服した一徹な者は、恐怖の下でも見たとおりを言う', bold === '3/9名', bold);
  check('付いていない几帳面な者は甘く言う', meek !== '3/9名', meek);
}

/* ------------------------------------------------------------------ */

section('恐怖は盤を動かさない');
{
  // ここが v3.0 でいちばん壊しやすい所である。
  // 報告の文面が盤と同じ乱数列を引いていたので、「言い回しが一語変わる」だけで
  // 以後の弾着点も敵の判断もずれていた ─ 情報統制を敷くと敵砲兵の落ちる場所が
  // 変わる、という形で world/belief の分離が破れていた。
  const sig = (w) =>
    w.units.map((u) => `${u.id}:${u.x.toFixed(2)}:${u.y.toFixed(2)}:${u.strength.toFixed(3)}`).join('|');
  const run = (fear) => {
    const w = createWorld({
      missionId: 'bridge_hold',
      setup: {
        units: {}, officers: new Map(),
        // 恐怖以外は一切変えない（士気の下駄も練度も統制も並のまま）
        war: { fear, honesty: 1 - fear, recruit: 1, startMorale: 0, hold: 1 },
      },
    });
    for (let i = 0; i < 6500 && !w.outcome; i++) tick(w, 1);
    return { sig: sig(w), outcome: w.outcome, now: w.now };
  };
  const plain = run(0);
  const afraid = run(0.9);
  check('恐怖を上げても盤は一致する', plain.sig === afraid.sig);
  check('決着も一致する', plain.outcome === afraid.outcome && plain.now === afraid.now,
    `${plain.outcome}@${plain.now} / ${afraid.outcome}@${afraid.now}`);

  // 同じ電文の本文と、部隊一覧に流れる数字は一致していなければならない
  const w = createWorld({
    missionId: 'bridge_hold',
    setup: { units: {}, officers: new Map(), war: { fear: 0.8, honesty: 0.2 } },
  });
  const u = w.unitsById.get('H1');
  u.strength = 3;
  u.morale = 30;
  u.ammo = 10;
  const said = shownSelf(w, u);
  const body = composeSitrep(u, w);
  check('状況報告の本文と一覧の数字が食い違わない', body.includes(said.strength),
    `本文に「${said.strength}」が無い: ${body}`);
  check('弾薬も食い違わない', !body.includes('ほぼ尽きた'), body);
}

/* ------------------------------------------------------------------ */

section('聞いていたこと と 起きていたこと');
{
  // 恐怖の下で戦えば、講評で二列が食い違う。
  const st = newCampaign('volne_three_days', 2024);
  st.nation.fear = 0.85;
  const g = startCampaignBattle(st);
  startClock(g);
  let t = 0;
  while (!g.finished && t++ < 8000) advance(g, 0.5);
  const gap = getReportGap(g);
  check('講評で突き合わせが取れる', gap.length > 0, `${gap.length}`);
  check('恐怖の下では食い違う', gap.some((r) => r.gap),
    gap.map((r) => `${r.callsign} 言:${r.said} 実:${r.truth}`).join(' / '));
  check('真実の側は truth に出る', gap.every((r) => typeof r.truth === 'string'));

  // 戦闘中は返さない。真実を開くのは講評だけである。
  const st2 = newCampaign('volne_three_days', 2025);
  const g2 = startCampaignBattle(st2);
  check('戦闘中は突き合わせを返さない', getReportGap(g2).length === 0);
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

section('評議会 ─ 反対する者');
{
  const n = createNation();
  check('四つの塊が立っている', BLOC_IDS.length === 4, BLOC_IDS.join(','));
  check('席には名前がある',
    BLOC_IDS.every((id) => (n.council.blocs[id].minister.name ?? '').length > 0));
  check('開幕はどれも容認か支持',
    BLOC_IDS.every((id) => n.council.blocs[id].support >= 45), 
    BLOC_IDS.map((id) => `${id}:${n.council.blocs[id].support}`).join(' '));

  // どの政令にも必ず怒る者がいる。誰の顔も立てない晩というものが無い。
  for (const id of DECREE_IDS) {
    const d = DECREES[id];
    const vals = Object.values(d.blocs ?? {});
    check(`「${d.label}」には怒る者がいる`, vals.some((v) => v < 0),
      JSON.stringify(d.blocs ?? {}));
  }
}

section('評議会は国の運営に効く');
{
  // 段列は軍部のものである。付いていなければ、帳簿の数は前線に着かない。
  const rich = createNation();
  rich.council.blocs.army.support = 100;
  const poor = createNation();
  poor.council.blocs.army.support = 0;
  const a = applyDecrees(rich, 1);
  const b = applyDecrees(poor, 1);
  check('軍部が付いていれば補充が前線まで届く', a.output.replacements > b.output.replacements,
    `${a.output.replacements} vs ${b.output.replacements}`);
  check('砲弾も同じ', a.output.rounds > b.output.rounds,
    `${a.output.rounds} vs ${b.output.rounds}`);
  check('命令の通りにも効く',
    warFactors(rich).obey > warFactors(poor).obey,
    `${warFactors(rich).obey.toFixed(3)} vs ${warFactors(poor).obey.toFixed(3)}`);

  // 救済は役所が配る。配る者がいなければ、金だけが消える。
  const admin = createNation();
  admin.council.blocs.civil.support = 100;
  const noAdmin = createNation();
  noAdmin.council.blocs.civil.support = 0;
  decree(admin, 'relief');
  decree(noAdmin, 'relief');
  const m0 = admin.morale;
  applyDecrees(admin, 1);
  applyDecrees(noAdmin, 1);
  check('役所が動いていれば救済が届く', admin.morale > noAdmin.morale,
    `${admin.morale.toFixed(1)} vs ${noAdmin.morale.toFixed(1)}`);
  check('届かなくても国庫は出ていく', noAdmin.treasury < START.treasury, `${noAdmin.treasury}`);
  check('民心そのものは上がっている', admin.morale > m0);

  // 統制は放っておけば緩む。緩ませないのが保安部の仕事である。
  const grip = createNation();
  grip.council.blocs.security.support = 0;
  const before = grip.control;
  applyDecrees(grip, 1);
  check('保安が離れれば統制はこぼれる', grip.control < before,
    `${before} → ${grip.control.toFixed(1)}`);

  // 税は取り立てる役所の側の話でもある。
  const money = createNation();
  money.council.blocs.industry.support = 100;
  const broke = createNation();
  broke.council.blocs.industry.support = 0;
  applyDecrees(money, 1);
  applyDecrees(broke, 1);
  check('産業が離れれば税収が落ちる', money.treasury > broke.treasury,
    `${money.treasury} vs ${broke.treasury}`);
}

section('上奏');
{
  const n = createNation();
  // 開幕から一番低い省庁が持ってくる。賽は振らない。
  const p = ensurePetition(n, 1);
  check('一晩に一件だけ上奏が来る', !!p && !!p.bloc, JSON.stringify(p));
  check('同じ晩に二度呼んでも同じ一件', ensurePetition(n, 1)?.id === p.id);
  check('持ってくるのは一番不満な省庁',
    BLOC_IDS.every((id) => n.council.blocs[id].support >= n.council.blocs[p.bloc].support),
    p.bloc);

  const def = findPetition(p.bloc, p.id);
  check('上奏には台詞がある', (def?.text ?? '').length > 10);
  check('容れる側と退ける側の両方に代価がある',
    Object.keys(def.accept.support ?? {}).length > 0 &&
    Object.keys(def.refuse.support ?? {}).length > 0);

  // 容れれば彼らは付き、他が離れる。
  const yes = createNation();
  ensurePetition(yes, 1);
  const bloc = yes.council.petition.bloc;
  const other = Object.keys(findPetition(bloc, yes.council.petition.id).accept.support)
    .find((k) => k !== bloc);
  const b0 = yes.council.blocs[bloc].support;
  const o0 = other ? yes.council.blocs[other].support : 0;
  councilAnswer(yes, true);
  check('容れれば持ってきた側は付く', yes.council.blocs[bloc].support > b0,
    `${b0} → ${yes.council.blocs[bloc].support}`);
  if (other) {
    check('容れれば別の誰かが離れる', yes.council.blocs[other].support < o0,
      `${other} ${o0} → ${yes.council.blocs[other].support}`);
  }
  check('答えは一度きり', councilAnswer(yes, true) === null);

  // 退ければその逆。
  const no = createNation();
  ensurePetition(no, 1);
  const nb = no.council.petition.bloc;
  const nb0 = no.council.blocs[nb].support;
  councilAnswer(no, false);
  check('退ければ持ってきた側が離れる', no.council.blocs[nb].support < nb0);

  // 答えないまま出撃すれば、退けたものとして数えられる ─ ただし半分。
  const mute = createNation();
  ensurePetition(mute, 1);
  const mb = mute.council.petition.bloc;
  const mb0 = mute.council.blocs[mb].support;
  applyDecrees(mute, 1);
  check('黙っていても数えられる', mute.council.blocs[mb].support < mb0,
    `${mb0} → ${mute.council.blocs[mb].support}`);
  check('握り潰しは面と向かって断るより軽い',
    (mb0 - mute.council.blocs[mb].support) < (nb0 - no.council.blocs[nb].support),
    `黙 ${(mb0 - mute.council.blocs[mb].support).toFixed(2)} / 断 ${(nb0 - no.council.blocs[nb].support).toFixed(2)}`);

  // 同じ省庁は連夜では来ない。
  const twice = createNation();
  const p1 = ensurePetition(twice, 1);
  applyDecrees(twice, 1);
  const p2 = ensurePetition(twice, 2);
  check('同じ省庁が連夜では来ない', !p2 || p2.bloc !== p1.bloc, `${p1.bloc} → ${p2?.bloc}`);
  // 一晩空ければ、また持ってくる。
  applyDecrees(twice, 2);
  const p3 = ensurePetition(twice, 3);
  check('一晩空ければまた持ってくる', p3?.bloc === p1.bloc, `${p3?.bloc}`);
}

section('黙殺は自滅にならない');
{
  // 一番低い者が毎晩来る作りにしていたとき、握り潰し続けるだけで
  // 同じ一つが必ず 0 まで落ちた ─ 何もしないことが、選べない自滅になっていた。
  const n = createNation();
  let raised = 0;
  for (let d = 1; d <= 12; d++) {
    if (ensurePetition(n, d)) raised++;
    applyDecrees(n, d);
  }
  // 「昨夜の省庁は来ない」の札が外れないと、戦役を通して上奏が一件しか立たなかった。
  check('上奏は一件で打ち止めにならない', raised >= 4, `十二晩で ${raised} 件`);
  const low = Math.min(...BLOC_IDS.map((id) => n.council.blocs[id].support));
  check('十二晩黙っていても誰も離反しない', low > BLOC_LINE, `最低 ${low.toFixed(1)}`);
  check('それでも支持は下がっている', low < 48, `最低 ${low.toFixed(1)}`);
}

section('恐怖は反対も黙らせる');
{
  const quiet = createNation();
  const loud = createNation();
  quiet.fear = 0.8;
  const q0 = quiet.council.blocs.civil.support;
  const l0 = loud.council.blocs.civil.support;
  shiftSupport(quiet, { civil: -20 });
  shiftSupport(loud, { civil: -20 });
  check('恐怖の下では反対が半分しか出ない',
    (q0 - quiet.council.blocs.civil.support) < (l0 - loud.council.blocs.civil.support),
    `${(q0 - quiet.council.blocs.civil.support).toFixed(1)} vs ${(l0 - loud.council.blocs.civil.support).toFixed(1)}`);

  // 恐怖で買えるのは沈黙であって、支持ではない。
  const up = createNation();
  up.fear = 0.9;
  const u0 = up.council.blocs.army.support;
  shiftSupport(up, { army: +10 });
  check('恐怖で支持そのものは増えない',
    Math.abs((up.council.blocs.army.support - u0) - 10) < 0.001,
    `${(up.council.blocs.army.support - u0).toFixed(2)}`);
  check('恐怖ゼロなら目減りしない', hushOf(createNation()) === 1);
}

section('評議会を離れるとき');
{
  const n = createNation();
  n.council.blocs.industry.support = 5;
  const first = checkCouncil(n);
  check('線を割れば通告が出る', first.collapse === null && first.notices.length > 0,
    JSON.stringify(first.notices));
  check('通告は賽ではなく期限である', n.council.warned.industry === true);

  // 戻せば助かる。
  const saved = JSON.parse(JSON.stringify(n));
  saved.council.blocs.industry.support = 40;
  const back = checkCouncil(saved);
  check('翌朝までに戻せば助かる', back.collapse === null && !saved.council.warned.industry,
    JSON.stringify(back.notices));

  // 戻せなければ終わる。
  const doomed = checkCouncil(n);
  check('戻せなければ国は貴官の手を離れる', doomed.collapse?.id === 'bloc_industry',
    JSON.stringify(doomed.collapse));
  check('終わり方に理由が書いてある', (doomed.collapse?.reason ?? '').length > 10);

  // 指標の側の通告と同じ窓口に出る。
  const w = createNation();
  w.council.blocs.security.support = 3;
  checkCollapse(w);
  check('評議会の通告も同じ窓口に出る',
    warnings(w).some((x) => x.id === 'bloc_security'),
    warnings(w).map((x) => x.id).join(','));
}

section('長官を除く');
{
  const n = createNation();
  n.council.blocs.civil.support = 8;
  checkCouncil(n);
  check('除く前は通告が出ている', n.council.warned.civil === true);

  const fear0 = n.fear;
  const loyal0 = n.loyalty;
  const army0 = n.council.blocs.army.support;
  const res = councilPurgeMinister(n, 'civil', 2);
  check('除いた者の名が残る', res?.removed?.name?.length > 0, JSON.stringify(res?.removed));
  check('後任が座る', n.council.blocs.civil.minister.name !== res.removed.name);
  check('通告は止まる', n.council.warned.civil === false);
  check('恐怖が増える', n.fear > fear0, `${fear0} → ${n.fear}`);
  check('士官団に伝わる', n.loyalty < loyal0, `${loyal0} → ${n.loyalty}`);
  check('残る省庁は次は自分だと考える',
    n.council.blocs.army.support < army0, `${army0} → ${n.council.blocs.army.support}`);

  // 傀儡は逆らわない ─ 働きもしない。
  n.council.blocs.civil.support = 100;
  check('傀儡は上が詰まっている', blocEffect(n.council.blocs.civil) < 0.7,
    `${blocEffect(n.council.blocs.civil).toFixed(2)}`);
  n.council.blocs.civil.support = 0;
  check('傀儡は下も詰まっている', blocEffect(n.council.blocs.civil) > 0.3,
    `${blocEffect(n.council.blocs.civil).toFixed(2)}`);
  n.council.blocs.civil.support = 2;
  check('傀儡は二度と離反しない', checkCouncil(n).collapse === null);
  check('傀儡は上奏しない', ensurePetition(n, 9)?.bloc !== 'civil');
  check('二度は除けない', councilPurgeMinister(n, 'civil', 3) === null);
  check('空にした席が記録に残る', n.council.purgedMinisters.length === 1);
}

section('評議会に支配戦略が無いこと');
{
  // 保安に寄り切れば民政が死ぬ。
  const sec = createNation();
  for (let d = 1; d <= 5; d++) {
    if (canDecree(sec, 'martial_law').ok) decree(sec, 'martial_law');
    if (canDecree(sec, 'censorship').ok) decree(sec, 'censorship');
    if (canDecree(sec, 'secret_police').ok) decree(sec, 'secret_police');
    applyDecrees(sec, d);
  }
  check('秩序に寄れば民政が離れる', sec.council.blocs.civil.support < 30,
    `${sec.council.blocs.civil.support.toFixed(0)}`);

  // 軍に寄り切れば産業が死ぬ。
  const arm = createNation();
  for (let d = 1; d <= 6; d++) {
    if (canDecree(arm, 'requisition').ok) decree(arm, 'requisition');
    if (canDecree(arm, 'conscript').ok) decree(arm, 'conscript');
    applyDecrees(arm, d);
  }
  check('軍に寄れば産業が離れる', arm.council.blocs.industry.support < 30,
    `${arm.council.blocs.industry.support.toFixed(0)}`);
  check('そのかわり軍部は付いてくる', arm.council.blocs.army.support > 70,
    `${arm.council.blocs.army.support.toFixed(0)}`);

  // 恩恤に寄り切れば保安が離れる。
  const soft = createNation();
  soft.treasury = 120;
  for (let d = 1; d <= 6; d++) {
    soft.treasury = Math.max(soft.treasury, 40);
    if (canDecree(soft, 'amnesty').ok) decree(soft, 'amnesty');
    if (canDecree(soft, 'relief').ok) decree(soft, 'relief');
    applyDecrees(soft, d);
  }
  check('恩恤に寄れば保安が離れる', soft.council.blocs.security.support < 45,
    `${soft.council.blocs.security.support.toFixed(0)}`);
}

section('評議会は戦役に載る');
{
  const st = newCampaign('volne_three_days', 31);
  const view = getNationView(st);
  check('画面に四つの塊が出る', view.council.length === 4);
  check('席の名前が出る', view.council.every((b) => b.minister.length > 0));
  check('支持は言葉で出る', view.council.every((b) => b.stage.length > 0));
  check('初日から上奏が出ている', !!view.petition, JSON.stringify(view.petition));
  check('上奏には容れる側と退ける側の札がある',
    view.petition.accept.tags.length > 0 && view.petition.refuse.tags.length > 0);

  answerPetition(st, true);
  check('答えれば画面に残る', getNationView(st).petition.answered === 'accept');

  purgeMinister(st, 'security');
  const after = getNationView(st);
  check('更迭は画面に出る', after.council.find((b) => b.id === 'security').puppet === true);
  check('更迭は統治の記録に残る', after.rule.ministers.length === 1);

  // 書き出して読み戻せる。
  const back = deserializeCampaign(JSON.parse(JSON.stringify(serializeCampaign(st))));
  check('評議会も読み戻せる',
    back.nation.council.blocs.security.puppet === true &&
    back.nation.council.purgedMinisters.length === 1);
  // v3.0 の保存（評議会が無い）も読める
  const old = JSON.parse(JSON.stringify(serializeCampaign(st)));
  delete old.nation.council;
  check('評議会の無い古い保存も読める',
    BLOC_IDS.every((id) => !!deserializeCampaign(old)?.nation?.council?.blocs?.[id]));
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

section('予令は三つまで抱えられる');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const u = w.unitsById.get('H1');

  const a = issueOrder(w, { unitId: 'H1', verb: 'sitrep', trigger: 'on_contact' });
  for (let i = 0; i < 120; i++) tick(w, 1);
  const b = issueOrder(w, { unitId: 'H1', verb: 'withdraw', x: 1200, y: 2600, trigger: 'on_pressure' });
  for (let i = 0; i < 120; i++) tick(w, 1);

  // 一つしか持てなかったので、二つ目を渡すと一つ目が黙って消えていた。
  check('条件の違う予令は両方とも残る',
    u.heldOrders.length === 2 && a.state === 'standby' && b.state === 'standby',
    `${u.heldOrders.length} / ${a.state} / ${b.state}`);

  // 同じ条件のものは差し替わる ─ どちらに従うかを部下に選ばせないため。
  const c = issueOrder(w, { unitId: 'H1', verb: 'rally', x: 1300, y: 2700, trigger: 'on_pressure' });
  for (let i = 0; i < 120; i++) tick(w, 1);
  check('同じ条件の予令は差し替わる',
    b.state === 'superseded' && c.state === 'standby' && u.heldOrders.length === 2,
    `${b.state} / ${c.state} / ${u.heldOrders.length}`);

  // 溢れれば古いものから落ちる。
  const d = issueOrder(w, { unitId: 'H1', verb: 'hold', trigger: 'at_time', triggerAt: w.now + 4000 });
  for (let i = 0; i < 120; i++) tick(w, 1);
  const e = issueOrder(w, { unitId: 'H1', verb: 'observe', x: 2000, y: 1500, trigger: 'on_line' });
  for (let i = 0; i < 160; i++) tick(w, 1);
  check('抱えられるのは三つまで', u.heldOrders.length <= HELD_LIMIT, `${u.heldOrders.length}`);
}

section('予令が一つ発動しても、残りは懐に残る');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const u = w.unitsById.get('H1');
  issueOrder(w, { unitId: 'H1', verb: 'hold', trigger: 'at_time', triggerAt: w.now + 200 });
  for (let i = 0; i < 60; i++) tick(w, 1);
  issueOrder(w, { unitId: 'H1', verb: 'withdraw', x: 1200, y: 2600, trigger: 'on_pressure' });
  for (let i = 0; i < 90; i++) tick(w, 1);
  const before = u.heldOrders.length;
  for (let i = 0; i < 400; i++) tick(w, 1);
  check('時刻の予令は発動する', w.orders.some((o) => o.trigger === 'at_time' && o.firedAt != null));
  check('残りの予令は反故にならない',
    u.heldOrders.some((o) => o.trigger === 'on_pressure' && o.state === 'standby'),
    `前 ${before} → ${u.heldOrders.length}`);
}

section('前令取消');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  const u = w.unitsById.get('H3');
  const start = { x: u.x, y: u.y };

  // まだ網に乗っていない命令は、送信そのものを取りやめられる。
  const bad = issueOrder(w, { unitId: 'H3', verb: 'attack', x: 3200, y: 600 });
  check('誤った命令が出せてしまう', bad?.state === 'transmitting');
  const back = issueOrder(w, { unitId: 'H3', verb: 'countermand' });
  check('取り消しは通る', !!back);
  check('送信前なら命令ごと消える', bad.state === 'void', bad.state);
  check('取り消し自体は網に乗らない',
    !w.radio.queue.some((tx) => tx.meta?.orderId === back.id));
  for (let i = 0; i < 300; i++) tick(w, 1);
  check('部隊は動き出さない', Math.hypot(u.x - start.x, u.y - start.y) < 260,
    `${Math.round(Math.hypot(u.x - start.x, u.y - start.y))}m`);

  // 届いてしまったものは止めるしかない。
  const w2 = createWorld();
  for (let i = 0; i < 60; i++) tick(w2, 1);
  const v = w2.unitsById.get('H3');
  const gone = issueOrder(w2, { unitId: 'H3', verb: 'move', x: 3000, y: 900 });
  for (let i = 0; i < 400 && gone.state !== 'executing'; i++) tick(w2, 1);
  check('届いてしまえば実行に移る', gone.state === 'executing', gone.state);
  const stop = issueOrder(w2, { unitId: 'H3', verb: 'countermand' });
  check('届いたあとの取消は網に乗る', stop?.state === 'transmitting', stop?.state);
  for (let i = 0; i < 600 && stop.state !== 'complete'; i++) tick(w2, 1);
  check('取消が届けば足が止まる', v.state === 'holding' && !v.path.length, v.state);

  // 取り消すものが無ければ、取り消しは出せない。
  const w3 = createWorld();
  for (let i = 0; i < 60; i++) tick(w3, 1);
  check('取り消すものが無ければ出せない',
    issueOrder(w3, { unitId: 'H4', verb: 'countermand' }) === null);
}

section('射撃中止は一つだけ止められる');
{
  const w = createWorld();
  for (let i = 0; i < 60; i++) tick(w, 1);
  endPlanning(w);
  issueOrder(w, { unitId: 'H1', verb: 'fire_mission', x: 2400, y: 1400 });
  issueOrder(w, { unitId: 'H1', verb: 'smoke', x: 1500, y: 1900 });
  for (let i = 0; i < 900 && w.fireMissions.filter((f) => !f.done).length < 2; i++) tick(w, 1);
  const live = w.fireMissions.filter((f) => !f.done && f.side === 'friend');
  check('二つの射撃が同時に走る', live.length >= 2, `${live.length}`);

  const he = live.find((f) => f.kind === 'he');
  issueOrder(w, { unitId: 'H1', verb: 'cancel_fire', x: he.x, y: he.y });
  for (let i = 0; i < 600 && !he.done; i++) tick(w, 1);
  check('狙った一つは止まる', he.done && he.cancelled === true, `${he.done}/${he.cancelled}`);
  // 掩護の煙まで一緒に落とされては、止めた側が損をする。
  check('もう一つは残る',
    w.fireMissions.some((f) => f.side === 'friend' && f.kind === 'smoke' && !f.cancelled));

  // 何も無い所を叩いても止まらない。
  check('止めるものが無ければ出せない',
    issueOrder(w, { unitId: 'H1', verb: 'cancel_fire', x: 200, y: 200 }) === null);
}

section('地点の観測要求');
{
  const w = createWorld();
  endPlanning(w);
  for (let i = 0; i < 900; i++) tick(w, 1);
  const u = w.unitsById.get('H1');
  const o = issueOrder(w, { unitId: 'H1', verb: 'report_on', x: u.x + 400, y: u.y - 300 });
  check('観測要求が出せる', !!o);
  for (let i = 0; i < 900 && o.state !== 'complete'; i++) tick(w, 1);
  check('答えが返る', o.state === 'complete', o.state);
  const txt = composeAreaReport(u, w, u.x + 400, u.y - 300, toGrid(u.x + 400, u.y - 300));
  check('答えは方眼を名指しする', txt.includes(toGrid(u.x + 400, u.y - 300)), txt);

  // 見えていないことも情報である。
  const far = composeAreaReport(u, w, 100, WORLD.height - 100, 'A1');
  check('遠すぎれば「見えない」と答える', /見えない|視認できるもの/.test(far), far);
}

section('工兵は障害を処理できる');
{
  const w = createWorld({ mapId: 'zaren_town' });
  const obs = w.terrain.obstacles?.[0];
  check('この図幅には障害がある', !!obs, `${w.terrain.obstacles?.length ?? 0}`);
  endPlanning(w);
  for (let i = 0; i < 60; i++) tick(w, 1);

  // 道具の無い分隊には処理できない。
  const bare = w.units.find((u) => u.side === 'friend' && !u.tpl.flying && !(u.attach ?? []).length);
  if (bare) {
    check('工兵の無い分隊には出せない',
      issueOrder(w, { unitId: bare.id, verb: 'breach', x: obs.x, y: obs.y }) === null);
  }

  const eng = w.units.find((u) => u.side === 'friend' && !u.tpl.flying);
  eng.attach = ['eng'];
  eng.mods = { ...(eng.mods ?? {}), obstacle: 1.7 };
  eng.x = obs.x;
  eng.y = obs.y;
  const o = issueOrder(w, { unitId: eng.id, verb: 'breach', x: obs.x, y: obs.y });
  check('工兵を付ければ出せる', !!o);
  for (let i = 0; i < 3000 && !obs.cleared; i++) tick(w, 1);
  check('通路が開く', obs.cleared === true);
  // 開いた通路は中隊ぜんぶが使える ─ そうでなければ処理ではなく個人技である。
  check('開いた通路は誰でも通れる', obstacleAt(w.terrain, obs.x, obs.y) === null);
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
