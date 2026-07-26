// 無線報告の生成。観測の「質」に応じて位置をずらし、言い回しを濁す。
// 指揮官が受け取る情報は全てこのファイルを通って歪む。

import { clamp, toGrid, bearing, compassJa, dist } from '../util.js';
import { enqueue, PRI } from './comms.js';
import { moraleJa } from './units.js';

const TYPE_JA = {
  infantry: '敵歩兵',
  recon: '敵偵察部隊',
  at_team: '敵対戦車チーム',
  mech: '敵装甲車',
  tank: '敵戦車',
  mortar: '敵迫撃砲陣地',
  drone: '無人機',
  convoy: '車列',
};

const UNIT_JA = {
  infantry: '名',
  recon: '名',
  at_team: '名',
  mech: '両',
  tank: '両',
  mortar: '名',
  drone: '機',
  convoy: '両',
};

/* ------------------------------------------------------------------ */
/* 位置の歪み                                                           */
/* ------------------------------------------------------------------ */

/** 観測の質から、報告される位置を求める（ずれる） */
function reportedPosition(c, rng, skill) {
  // 質が低いほど大きくずれる。ドローンや練度の高い部隊はマシ。
  const sd = (1 - c.quality) * 420 * (1.25 - skill * 0.5) + 45;
  return {
    x: c.x + rng.gauss(0, sd),
    y: c.y + rng.gauss(0, sd),
  };
}

/** 確度の言い回し */
function confidencePhrase(quality, rng) {
  if (quality > 0.78) return rng.pick(['確認', '視認した', 'はっきり見えている']);
  if (quality > 0.5) return rng.pick(['と思われる', 'のようだ', 'と見られる']);
  if (quality > 0.3) return rng.pick(['らしきもの', 'かもしれない', 'の可能性あり']);
  return rng.pick(['何かいる、判別できない', '断定できない', 'はっきりしない']);
}

function countPhrase(c, rng) {
  const unit = UNIT_JA[c.classified] ?? '';
  const n = Math.max(1, Math.round(c.classifiedStrength));
  if (c.quality > 0.75) return `${n}${unit}`;
  if (c.quality > 0.45) return `約${n}${unit}`;
  if (n <= 2) return `少数`;
  if (n <= 6) return `分隊規模`;
  return `小隊規模`;
}

function movementPhrase(c, rng) {
  if (c.firstX == null) return null;
  const d = dist(c.firstX, c.firstY, c.x, c.y);
  if (d < 140) return rng.pick(['動きなし', '停止中', 'その場に留まっている']);
  const dir = compassJa(bearing(c.firstX, c.firstY, c.x, c.y));
  return `${dir}へ移動中`;
}

function ammoJa(u) {
  const r = u.ammo / (u.tpl.maxAmmo || 100);
  if (r > 0.6) return '十分';
  if (r > 0.3) return '半分を切った';
  if (r > 0.1) return '心細い';
  return 'ほぼ尽きた';
}

/* ------------------------------------------------------------------ */
/* 報告の合成                                                           */
/* ------------------------------------------------------------------ */

function contactText(u, c, world) {
  const rng = world.rng;
  const pos = reportedPosition(c, rng, u.skill);
  const grid = toGrid(pos.x, pos.y);
  const type = TYPE_JA[c.classified] ?? '正体不明';
  const count = countPhrase(c, rng);
  const conf = confidencePhrase(c.quality, rng);
  const move = movementPhrase(c, rng);

  const variants = [
    `こちら${u.callsign}。${grid}、${type}${count}、${conf}。${move ? move + '。' : ''}どうぞ`,
    `${u.callsign}より指揮所。接敵。${grid}に${type}、${count}。${conf}。`,
    `こちら${u.callsign}、${grid}方向。${type}${count}を確認、${conf}。${move ? move + '。' : ''}`,
  ];

  const drone = [
    `イーグルより。${grid}、${type}${count}。${move ?? '静止'}。映像は良好。`,
    `イーグル。目標エリア上空。${grid}に${type}、${count}を確認。`,
  ];

  const text = u.type === 'drone' ? rng.pick(drone) : rng.pick(variants);
  return { text, grid, pos };
}

/* ------------------------------------------------------------------ */
/* 報告の判断                                                           */
/* ------------------------------------------------------------------ */

const REPORT_COOLDOWN = 55;

/**
 * 各部隊が「今、何を報告するか」を決めて無線に流す。
 */
export function stepReporting(world, dt) {
  const { now, rng } = world;

  for (const u of world.units) {
    if (u.side !== 'friend') continue;
    if (u.tpl.radio <= 0) continue;

    // 全滅した部隊は当然何も言わない（＝指揮官には沈黙として届く）
    if (!u.alive) continue;
    if (!u.commsOk) continue;

    // --- 被弾報告（最優先） ---------------------------------------
    if (now - u.lastHitAt < 4 && now - (u.lastUnderFireReportAt ?? -Infinity) > REPORT_COOLDOWN) {
      u.lastUnderFireReportAt = now;
      const grid = toGrid(u.x, u.y);
      const dire = u.strength / u.maxStrength < 0.55;
      const text = dire
        ? rng.pick([
            `こちら${u.callsign}！${grid}、激しい射撃を受けている、損害が出ている！支援を頼む！`,
            `${u.callsign}！……くっ……${grid}で交戦中、こちらの損害大！このままでは保たない！`,
          ])
        : rng.pick([
            `こちら${u.callsign}、${grid}にて射撃を受けている。応戦中。`,
            `${u.callsign}より、交戦開始。${grid}。現在応戦中、どうぞ。`,
          ]);
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'contact',
        text,
        priority: PRI.FLASH,
        meta: { unitId: u.id, grid, observedAt: now },
        composedAt: now,
      });
      continue;
    }

    // --- 統制喪失 --------------------------------------------------
    if (u.state === 'broken' && !u.reportedBroken) {
      u.reportedBroken = true;
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'broken',
        text: rng.pick([
          `こちら${u.callsign}……もう抑えられない、部隊が下がっている！すまない！`,
          `${u.callsign}、統制が取れない！後退する、繰り返す、後退する！`,
        ]),
        priority: PRI.FLASH,
        meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: now },
        composedAt: now,
      });
      continue;
    }
    if (u.state !== 'broken') u.reportedBroken = false;

    // --- 接敵報告 --------------------------------------------------
    let reported = false;
    for (const c of u.contacts.values()) {
      if (now - c.lastSeenAt > 30) continue;

      // 初報は「見てから報告するまで」に時間がかかる
      if (c.reportDueAt == null) {
        const base = c.side === 'civilian' ? 40 : 14;
        c.reportDueAt = now + base + (1 - u.skill) * 55 + rng.range(0, 30);
      }
      if (now < c.reportDueAt) continue;

      const isFirst = c.reportedAt === -Infinity;
      // 続報は状況が変わったときだけ（無線を無駄に埋めない）
      if (!isFirst) {
        const moved = dist(c.reportedX ?? c.x, c.reportedY ?? c.y, c.x, c.y) > 400;
        const stale = now - c.reportedAt > 210;
        if (!moved || !stale) continue;
      }

      const { text, grid, pos } = contactText(u, c, world);
      c.reportedAt = now;
      c.reportedX = c.x;
      c.reportedY = c.y;

      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'contact',
        text,
        priority: isFirst ? PRI.FLASH : PRI.PRIORITY,
        meta: {
          unitId: u.id,
          contactId: c.targetId,
          grid,
          reportedX: pos.x,
          reportedY: pos.y,
          classified: c.classified,
          quality: c.quality,
          observedAt: c.lastSeenAt,
        },
        composedAt: now,
      });
      reported = true;
      break; // 1回の送信につき1件
    }
    if (reported) continue;

    // --- 自発的な定時報告（何も起きていないと不安になるので稀に喋る） ---
    const quiet = now - Math.max(u.lastReportAt, u.lastHitAt) > 420;
    if (quiet && rng.chance(0.0016 * dt * 60)) {
      u.lastReportAt = now;
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'sitrep',
        text: rng.pick([
          `こちら${u.callsign}、${toGrid(u.x, u.y)}。異常なし。`,
          `${u.callsign}より指揮所。現在地に異常なし。監視を継続する。`,
        ]),
        priority: PRI.ROUTINE,
        meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: now },
        composedAt: now,
      });
    }
  }
}

/** 状況報告要求への回答を作る */
export function composeSitrep(u, world) {
  const rng = world.rng;
  const grid = toGrid(u.x, u.y);
  const contacts = [...u.contacts.values()].filter((c) => world.now - c.lastSeenAt < 90);

  let enemyPart = '接敵なし';
  if (contacts.length) {
    const c = contacts.sort((a, b) => b.quality - a.quality)[0];
    const pos = reportedPosition(c, rng, u.skill);
    enemyPart = `${toGrid(pos.x, pos.y)}に${TYPE_JA[c.classified] ?? '正体不明'}${countPhrase(c, rng)}`;
  }

  return (
    `こちら${u.callsign}。現在地${grid}、兵力${Math.round(u.strength)}/${u.maxStrength}${u.tpl.unitJa}、` +
    `弾薬${ammoJa(u)}、隊員の状態は${moraleJa(u.morale)}。${enemyPart}。以上。`
  );
}

/** 弾着観測 */
export function composeSpotReport(u, mission, world) {
  const rng = world.rng;
  const grid = toGrid(mission.x, mission.y);
  if (mission.friendlyCasualties > 0) {
    return rng.pick([
      `射撃中止！射撃中止！${grid}、味方に当たっている！繰り返す、こちらに落ちている！`,
      `やめてくれ！${grid}は味方の位置だ！こちらに弾着している！`,
    ]);
  }
  if (mission.civilianCasualties > 0) {
    return `こちら${u.callsign}……${grid}、弾着確認。民間車両が巻き込まれた。……確認した。`;
  }
  if (mission.casualtiesInflicted > 1.2) {
    return rng.pick([
      `こちら${u.callsign}、${grid}に弾着。効果大、敵が散っている。`,
      `${u.callsign}より。${grid}、命中。敵の動きが止まった。`,
    ]);
  }
  if (mission.casualtiesInflicted > 0.2) {
    return `こちら${u.callsign}、${grid}に弾着確認。多少の効果あり。`;
  }
  return rng.pick([
    `こちら${u.callsign}、${grid}に弾着。目標は見当たらない、効果不明。`,
    `${u.callsign}より。${grid}、着弾確認したが……そこには何もいない。`,
  ]);
}

export { TYPE_JA };
