// 無線報告の生成。観測の「質」に応じて位置をずらし、言い回しを濁す。
// 指揮官が受け取る情報は全てこのファイルを通って歪む。

import { clamp, toGrid, bearing, compassJa, dist, formatClock } from '../util.js';
import { enqueue, PRI } from './comms.js';
import { moraleJa } from './units.js';
import { localVisibilityJa } from './weather.js';
import { landmarkAt } from './terrain.js';

/**
 * 位置の言い方。
 *
 * 前線の兵は方眼の数字だけで喋りはしない。地図に名前のある地形が近ければ、
 * 必ずそちらを先に言う ─ 「第一高地の北斜面、C4」。
 * 聞いた側が地図のどこを見ればよいか、その一言で決まるからである。
 */
function placePhrase(world, x, y, grid) {
  const l = landmarkAt(world.terrain, x, y);
  return l ? `${l.phrase}、${grid}` : grid;
}

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

const EQUIPMENT_JA = {
  infantry: '小火器',
  recon: '小火器、車輌なし',
  at_team: '対戦車火器',
  mech: '装甲車輌',
  tank: '戦車',
  mortar: '迫撃砲',
  drone: '無人機',
  convoy: '非武装車輌',
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

/**
 * 敵情報告。
 *
 * 前線が本当に送るのは感想ではなく様式である ―
 * 規模・行動・位置・装備・時刻。初報はこの形で上げ、続報は簡略にする。
 */
function contactText(u, c, world) {
  const rng = world.rng;
  const pos = reportedPosition(c, rng, u.skill);
  const grid = toGrid(pos.x, pos.y);
  const type = TYPE_JA[c.classified] ?? '正体不明';
  const count = countPhrase(c, rng);
  const conf = confidencePhrase(c.quality, rng);
  const move = movementPhrase(c, rng) ?? '行動不明';
  const equip = EQUIPMENT_JA[c.classified] ?? '装備不明';
  const time = formatClock(c.lastSeenAt);
  const poorVis = localVisibilityJa(world, u);

  if (u.type === 'drone') {
    return {
      text:
        `イーグルより指揮所、敵情報告。規模 ${count}、行動 ${move}、` +
        `位置 ${placePhrase(world, pos.x, pos.y, grid)}、装備 ${equip}、時刻 ${time}。映像は良好。以上。`,
      grid,
      pos,
    };
  }

  // 初報は様式どおり。ただし確度が低ければそれも添える。
  const head = poorVis ? `こちら${u.callsign}、${poorVis}が敵情報告。` : `こちら${u.callsign}、敵情報告。`;
  const tail = c.quality > 0.72 ? '以上、どうぞ' : `${conf}。以上、どうぞ`;

  return {
    text:
      `${head}規模 ${count}、行動 ${move}、位置 ${placePhrase(world, pos.x, pos.y, grid)}、` +
      `装備 ${equip}、時刻 ${time}。${tail}`,
    grid,
    pos,
  };
}

/** 続報。様式を繰り返すと無線が埋まるので、変わった所だけ言う。 */
function contactUpdateText(u, c, world) {
  const rng = world.rng;
  const pos = reportedPosition(c, rng, u.skill);
  const grid = toGrid(pos.x, pos.y);
  const type = TYPE_JA[c.classified] ?? '正体不明';
  const move = movementPhrase(c, rng);

  return {
    text: rng.pick([
      `こちら${u.callsign}、続報。先の${type}、現在 ${grid}。${move ?? ''}。どうぞ`,
      `${u.callsign}より。${type}、${grid}へ移動。${move ?? ''}。`,
      `こちら${u.callsign}、${grid}。${type}は依然として動いている。`,
    ]),
    grid,
    pos,
  };
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
      // 同じ文句を繰り返させない。撃たれ続けている部隊ほど言葉が短く、荒くなる。
      const text = dire
        ? pickFreshFor(u, 'dire', rng, [
            `こちら${u.callsign}！${grid}、激しい射撃を受けている、損害が出ている！支援を頼む！`,
            `${u.callsign}！……くっ……${grid}で交戦中、こちらの損害大！このままでは保たない！`,
            `${u.callsign}！${grid}、頭が上げられない！このままでは押し切られる！`,
            `こちら${u.callsign}！負傷者が出た！${grid}、増援か火力支援を！`,
            `${u.callsign}……${grid}、まだ持ちこたえている。だが長くはない。`,
          ])
        : pickFreshFor(u, 'hit', rng, [
            `こちら${u.callsign}、${grid}にて射撃を受けている。応戦中。`,
            `${u.callsign}より、交戦開始。${grid}。現在応戦中、どうぞ。`,
            `こちら${u.callsign}、${grid}で被弾。損害は軽微、戦闘を継続する。`,
            `${u.callsign}、${grid}に射撃を受けた。位置は保持している。`,
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

      const { text, grid, pos } = isFirst ? contactText(u, c, world) : contactUpdateText(u, c, world);
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

    // --- 自発的な定時報告 ---
    // 何も起きていない時間も無線は流れている。同じ文面が続くと
    // 「戦場が動いていない」ではなく「作り物」に見えてしまうので言い回しを散らす。
    const quiet = now - Math.max(u.lastReportAt, u.lastHitAt) > 420;
    if (quiet && rng.chance(0.0016 * dt * 60)) {
      u.lastReportAt = now;
      enqueue(world, {
        from: u.callsign,
        fromId: u.id,
        kind: 'sitrep',
        text: idleChatter(u, world),
        priority: PRI.ROUTINE,
        meta: { unitId: u.id, grid: toGrid(u.x, u.y), observedAt: now },
        composedAt: now,
      });
    }
  }
}

/**
 * 手が空いているときの定時連絡。
 * 部隊の消耗具合と時間帯で口ぶりが変わる。
 */
function idleChatter(u, world) {
  const rng = world.rng;
  const grid = toGrid(u.x, u.y);
  const hurt = u.strength < u.maxStrength * 0.7;
  const tired = u.fatigue > 140;

  if (hurt) {
    return pickFreshFor(u, 'hurt', rng, [
      `こちら${u.callsign}、${grid}。負傷者を後方に下げた。戦闘は継続できる。`,
      `${u.callsign}より指揮所。${grid}、損害はあるが陣地は保持している。`,
      `こちら${u.callsign}。${grid}にて再編中。もう少し時間が要る。`,
      `${u.callsign}。${grid}、人員は減ったが陣地は動かさない。`,
    ]);
  }
  if (tired) {
    return pickFreshFor(u, 'tired', rng, [
      `こちら${u.callsign}、${grid}到着。息を整えている。`,
      `${u.callsign}。${grid}、隊員に水を回している。異常なし。`,
      `こちら${u.callsign}。${grid}、装具を整えている。まだ動ける。`,
    ]);
  }

  // 分布は一様でも、たまたま同じ文面が続くと嘘くさく聞こえる。
  // 直前と同じものだけは引き直す。
  return pickFresh(world, rng, [
    `こちら${u.callsign}、${grid}。異常なし。`,
    `${u.callsign}より指揮所。現在地に異常なし。監視を継続する。`,
    `こちら${u.callsign}。${grid}、視界良好。動くものは見えない。`,
    `${u.callsign}。${grid}にて警戒中。今のところ静かだ。`,
    `こちら${u.callsign}、定時連絡。${grid}、特記事項なし。`,
    `${u.callsign}より。${grid}、川向こうに動きはない。以上。`,
    `こちら${u.callsign}。陣地の構築を続けている。${grid}、異常なし。`,
    `${u.callsign}。${grid}、静穏。……少し静かすぎる気もするが。`,
  ]);
}

/** 直前に使った言い回しを避けて引く */
/**
 * 部隊ごとに「直前と同じ文句」を避けて選ぶ。
 * 同じ台詞が2回続けて流れると、それだけで作り物に見える。
 */
function pickFreshFor(u, key, rng, variants) {
  u._lastSaid ??= {};
  let i = Math.floor(rng.next() * variants.length);
  if (i === u._lastSaid[key] && variants.length > 1) {
    i = (i + 1 + Math.floor(rng.next() * (variants.length - 1))) % variants.length;
  }
  u._lastSaid[key] = i;
  return variants[i];
}

function pickFresh(world, rng, variants) {
  let i = Math.floor(rng.next() * variants.length);
  if (i === world._lastChatter && variants.length > 1) {
    i = (i + 1 + Math.floor(rng.next() * (variants.length - 1))) % variants.length;
  }
  world._lastChatter = i;
  return variants[i];
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
    `こちら${u.callsign}。現在地${placePhrase(world, u.x, u.y, grid)}、` +
    `兵力${Math.round(u.strength)}/${u.maxStrength}${u.tpl.unitJa}、` +
    `弾薬${ammoJa(u)}、隊員の状態は${moraleJa(u.morale)}。${enemyPart}。以上。`
  );
}

/**
 * 弾薬照会への回答。
 *
 * 「あと何分撃てるか」は指揮官が本当に知りたいことである。
 * 数値ではなく、前線が口にする言い方で返す。
 */
export function composeAmmoReport(u, world) {
  const ratio = u.ammo / (u.tpl.maxAmmo || 100);
  const holdout =
    ratio > 0.6 ? '当分は保つ' : ratio > 0.3 ? '激しい撃ち合いなら20分といったところだ' :
    ratio > 0.1 ? '長くは撃てない。補給が要る' : '次の攻撃は凌げない';
  return (
    `こちら${u.callsign}、弾薬照会に回答する。残弾${ammoJa(u)}。${holdout}。` +
    `兵力${Math.round(u.strength)}/${u.maxStrength}${u.tpl.unitJa}。以上。`
  );
}

/**
 * 弾着観測。
 *
 * 実際の火力要請は一発で終わらない。観測者が「どちらへどれだけ」を返し、
 * 指揮官がそれを容れて修正射を撃つ ― そこまでが手順である。
 * @returns {{text:string, correction?:{x:number,y:number,grid:string,phrase:string}}}
 */
export function composeSpotReport(u, mission, world) {
  const rng = world.rng;
  const grid = toGrid(mission.x, mission.y);

  if (mission.friendlyCasualties > 0) {
    return {
      text: rng.pick([
        `射撃中止！射撃中止！${grid}、味方に当たっている！繰り返す、こちらに落ちている！`,
        `やめてくれ！${grid}は味方の位置だ！こちらに弾着している！`,
      ]),
    };
  }
  if (mission.civilianCasualties > 0) {
    return {
      text: `こちら${u.callsign}……${grid}、弾着確認。民間車両が巻き込まれた。……確認した。`,
    };
  }
  if (mission.casualtiesInflicted > 1.2) {
    return {
      text: rng.pick([
        `こちら${u.callsign}、${grid}に効力射。効果大、敵が散っている。射撃終わり。`,
        `${u.callsign}より。${grid}、命中。敵の動きが止まった。射撃終わり。`,
      ]),
    };
  }

  // 外れたら「どちらへどれだけ」を返す。観測者が見ている敵を基準にする。
  const correction = findCorrection(u, mission, world);
  if (mission.casualtiesInflicted > 0.2) {
    return {
      text:
        `こちら${u.callsign}、${grid}に弾着。多少の効果あり。` +
        (correction ? `修正 ${correction.phrase}、効力射を要請する。` : ''),
      correction,
    };
  }
  if (correction) {
    return {
      text:
        `こちら${u.callsign}、${grid}に弾着。目標を外している。` +
        `修正 ${correction.phrase}。繰り返す、修正 ${correction.phrase}。どうぞ`,
      correction,
    };
  }
  return {
    text: rng.pick([
      `こちら${u.callsign}、${grid}に弾着。目標は見当たらない、効果不明。`,
      `${u.callsign}より。${grid}、着弾確認したが……そこには何もいない。`,
    ]),
  };
}

/** 観測者が見ている敵と弾着点の差から、修正量を作る */
function findCorrection(u, mission, world) {
  let best = null;
  for (const c of u.contacts.values()) {
    if (world.now - c.lastSeenAt > 120) continue;
    if (c.side !== 'enemy') continue;
    const d = dist(mission.x, mission.y, c.x, c.y);
    if (d > 900 || d < 90) continue;
    if (!best || d < best.d) best = { c, d };
  }
  if (!best) return null;

  // 観測にも誤差はある。修正しても一発では当たらない。
  const pos = reportedPosition(best.c, world.rng, u.skill);
  const dx = pos.x - mission.x;
  const dy = pos.y - mission.y;

  const parts = [];
  if (Math.abs(dy) > 80) parts.push(`${dy < 0 ? '北' : '南'}へ${Math.round(Math.abs(dy) / 50) * 50}`);
  if (Math.abs(dx) > 80) parts.push(`${dx < 0 ? '西' : '東'}へ${Math.round(Math.abs(dx) / 50) * 50}`);
  if (!parts.length) return null;

  return {
    x: pos.x,
    y: pos.y,
    grid: toGrid(pos.x, pos.y),
    phrase: parts.join('、'),
  };
}

export { TYPE_JA };
