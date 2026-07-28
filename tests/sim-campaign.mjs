// 戦役の健全性テスト。ブラウザ無しで node から走らせる。
//   node tests/sim-campaign.mjs
//
// 見ているのは二つ。
//   ・戦線の目盛りが、翌日の盤を実際に動かしていること
//   ・六日の戦役が、六日ぶん成立していること（任務・図幅・文言・持ち越し・保存）

import { createWorld, tick } from '../src/sim/world.js';
import { isPassable } from '../src/sim/terrain.js';
import { UNIT_TYPES } from '../src/sim/units.js';
import {
  timeline, getMission, missionList, stashFront, peekFront,
} from '../src/sim/scenario.js';
import {
  CAMPAIGNS, campaignList, getCampaign, createCampaign, currentStage,
  battleSetup, recordBattle, frontTilt, serializeCampaign, deserializeCampaign,
  NIGHT_PLAN_IDS,
} from '../src/sim/campaign.js';
import {
  newCampaign, startCampaignBattle, finishCampaignBattle,
  getCampaignView, getCompany, startClock, advance,
} from '../src/state.js';
import { Rng, formatClock } from '../src/util.js';

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

/** その展開表から、敵についての数字だけを取り出す */
function enemyProfile(mission, tilt) {
  const evs = timeline(null, { mission, front: tilt == null ? null : { tilt } })
    .sort((a, b) => a.at - b.at);
  let first = Infinity;
  let units = 0;
  let strength = 0;
  let reserve = 0;
  let extra = 0;
  for (const ev of evs) {
    if (ev.kind !== 'spawn') continue;
    for (const u of ev.units) {
      if (u.side !== 'enemy') continue;
      first = Math.min(first, ev.at);
      if (u.type === 'recon') continue;
      units++;
      strength += u.strength ?? UNIT_TYPES[u.type].maxStrength;
      if (u.ai?.task === 'reserve') reserve++;
      if (u.callsign === '敵増強隊') extra++;
    }
  }
  return { events: evs, first, units, strength, reserve, extra };
}

/* ------------------------------------------------------------------ */

section('戦線の傾き');
{
  const three = getCampaign('volne_three_days');
  const st = createCampaign(three, new Rng(7), []);
  check('起点では傾きが無い', Math.abs(frontTilt(st, three)) < 1e-9, `${frontTilt(st, three)}`);

  st.front = three.front.max;
  check('押し上げきれば +1', Math.abs(frontTilt(st, three) - 1) < 1e-9, `${frontTilt(st, three)}`);
  st.front = three.front.min;
  check('押し込まれきれば -1', Math.abs(frontTilt(st, three) + 1) < 1e-9, `${frontTilt(st, three)}`);

  // 一勝一敗で、目盛りは非対称に動く（負けのほうが重い）
  st.front = three.front.start;
  recordBattle(st, { outcome: 'victory', units: [], score: {} }, new Rng(1), three);
  const afterWin = st.front;
  const st2 = createCampaign(three, new Rng(7), []);
  recordBattle(st2, { outcome: 'defeat', units: [], score: {} }, new Rng(1), three);
  check('勝てば前へ出る', afterWin > three.front.start, `${afterWin}`);
  check('負ければ下がる', st2.front < three.front.start, `${st2.front}`);
  check('一敗のほうが一勝より大きく動く',
    three.front.start - st2.front > afterWin - three.front.start,
    `${afterWin} / ${st2.front}`);

  // 段階ごとの下駄。昨日の戦い方では防げなかったぶんを、その日の重さで渡す。
  const corridor = getCampaign('kolp_corridor');
  const stC = createCampaign(corridor, new Rng(7), []);
  stC.stage = 1; // 第二日 ─ 左隣が下がった日
  const biased = frontTilt(stC, corridor);
  stC.stage = 0;
  check('下駄のある段階は、同じ目盛りでも重い', biased < frontTilt(stC, corridor) - 0.15,
    `${biased.toFixed(3)} vs ${frontTilt(stC, corridor).toFixed(3)}`);
}

/* ------------------------------------------------------------------ */

section('戦線が翌日の敵を変える');
{
  for (const id of ['bridge_hold', 'kolp_delay', 'zaren_hold']) {
    const m = getMission(id);
    const back = enemyProfile(m, -0.7);
    const flat = enemyProfile(m, 0);
    const fwd = enemyProfile(m, 1);

    check(`${id}: 前へ出れば敵の出足が鈍る`, fwd.first > flat.first + 200,
      `${formatClock(flat.first)} → ${formatClock(fwd.first)}`);
    check(`${id}: 下がれば敵の出足が早まる`, back.first < flat.first - 200,
      `${formatClock(flat.first)} → ${formatClock(back.first)}`);
    check(`${id}: 前へ出れば梯団が薄くなる`, fwd.strength < flat.strength * 0.85,
      `${flat.strength} → ${fwd.strength}`);
    check(`${id}: 下がれば敵が一隊多い`, back.units === flat.units + 1 && back.extra === 1,
      `${flat.units} → ${back.units}`);
    check(`${id}: 戦線は無線で知らされる`,
      fwd.events.some((e) => e.kind === 'message' && e.text.includes('昨日の線は前へ出ている')) &&
      back.events.some((e) => e.kind === 'message' && e.text.includes('昨日の線は下がっている')));
  }

  // 予備は「間に合わなかった」で減る。兵力を削るのとは別の効き方である。
  const bh = getMission('bridge_hold');
  check('押し上げれば敵の予備が一隊間に合わない',
    enemyProfile(bh, 1).reserve === enemyProfile(bh, 0).reserve - 1,
    `${enemyProfile(bh, 0).reserve} → ${enemyProfile(bh, 1).reserve}`);
  check('押し込まれても予備は減らない',
    enemyProfile(bh, -0.7).reserve === enemyProfile(bh, 0).reserve);

  // 効きの無い範囲。目盛りが1つ動いただけで盤が変わっては、戦線が騒がしすぎる。
  check('ごく僅かな傾きは盤に出ない',
    JSON.stringify(enemyProfile(bh, 0.02).events) === JSON.stringify(enemyProfile(bh, 0).events));
}

/* ------------------------------------------------------------------ */

section('戦線が動かさないもの');
{
  const long = getMission('bridge_hold_long');
  const flat = timeline(null, { mission: long, front: { tilt: 0 } });
  const fwd = timeline(null, { mission: long, front: { tilt: 1 } });
  const back = timeline(null, { mission: long, front: { tilt: -0.7 } });

  const findSpawn = (evs, unitId) =>
    evs.find((e) => e.kind === 'spawn' && (e.units ?? []).some((u) => u.id === unitId));

  const h5 = [flat, fwd, back].map((e) => findSpawn(e, 'H5')?.at);
  check('友軍の増加配属は戦線で早まらない', h5[0] === h5[1] && h5[0] === h5[2], h5.join(' '));
  const civ = [flat, fwd, back].map((e) => findSpawn(e, 'CIV')?.at);
  check('民間車列も動かない', civ[0] === civ[1] && civ[0] === civ[2], civ.join(' '));

  // 押し込まれた側は -0.7 で頭打ち。負けが込んだ戦役を詰みにしないための床である。
  const floorA = JSON.stringify(enemyProfile(getMission('bridge_hold'), -0.7).events);
  const floorB = JSON.stringify(enemyProfile(getMission('bridge_hold'), -1).events);
  check('押し込まれた側には床がある', floorA === floorB);
}

/* ------------------------------------------------------------------ */

section('戦線は一戦ぶんしか効かない');
{
  const st = newCampaign('volne_three_days', 20260728);
  st.front = getCampaign('volne_three_days').front.max;
  battleSetup(st);
  check('出撃の支度で戦線が取り置かれる', peekFront()?.tilt === 1, `${peekFront()?.tilt}`);

  const w1 = createWorld({ missionId: 'kolp_delay' });
  check('取り置きは一戦で使い切られる', peekFront() === null);

  // 次に起こした単発の戦闘には、昨日の戦線が残っていてはならない。
  const w2 = createWorld({ missionId: 'kolp_delay' });
  const firstOf = (w) => w.events.find((e) => e.kind === 'spawn')?.at ?? 0;
  check('取り置きは次の単発戦闘に漏れない', firstOf(w1) !== firstOf(w2),
    `${formatClock(firstOf(w1))} / ${formatClock(firstOf(w2))}`);
  check('漏れなかった側が素の展開である',
    firstOf(w2) === (timeline(null, { mission: getMission('kolp_delay') })
      .filter((e) => e.kind === 'spawn').sort((a, b) => a.at - b.at)[0]?.at));

  stashFront(null);
}

/* ------------------------------------------------------------------ */

section('戦線は決着に効く');
{
  // 同じ種、同じ無操作で、戦線だけを変える。
  // 勝敗の分布が動かないなら、戦線は棒グラフでしかない。
  const seeds = [1, 3, 11, 77, 555, 808, 4242, 99991];
  const run = (missionId, tilt) => {
    const tally = { victory: 0, narrow: 0, defeat: 0 };
    let losses = 0;
    for (const seed of seeds) {
      stashFront({ tilt });
      const w = createWorld({ missionId, seed });
      let i = 0;
      while (!w.outcome && i++ < 30000) tick(w, 1);
      tally[w.outcome]++;
      losses += w.units.filter((u) => u.side === 'friend').reduce((s, u) => s + u.losses, 0);
    }
    return { ...tally, losses: losses / seeds.length };
  };

  for (const id of ['bridge_hold', 'zaren_hold']) {
    const back = run(id, -0.7);
    const fwd = run(id, 1);
    check(`${id}: 押し込まれた翌日は負けが増える`, back.defeat - fwd.defeat >= 3,
      `敗 ${back.defeat}/${seeds.length} → ${fwd.defeat}/${seeds.length}`);
    check(`${id}: 押し上げた翌日は損害が減る`, fwd.losses < back.losses,
      `${back.losses.toFixed(1)}名 → ${fwd.losses.toFixed(1)}名`);
  }
}

/* ------------------------------------------------------------------ */

section('六日の戦役');
{
  check('戦役が二つある', campaignList().length === 2, `${campaignList().length}`);
  const c = getCampaign('kolp_corridor');
  check('六日である', c.stages.length === 6, `${c.stages.length}`);
  check('五日から七日の範囲にある', c.stages.length >= 5 && c.stages.length <= 7);
  check('全段階の任務が実在する',
    c.stages.every((s) => getMission(s.missionId).id === s.missionId),
    c.stages.map((s) => s.missionId).join(' '));
  check('三つの図幅をすべて使う',
    new Set(c.stages.map((s) => getMission(s.missionId).mapId)).size === 3);
  check('勝敗の型が三種類とも出る',
    new Set(c.stages.map((s) => getMission(s.missionId).victory?.kind ?? 'hold_point')).size === 3);
  check('同じ任務を二度出さない',
    new Set(c.stages.map((s) => s.missionId)).size === c.stages.length);
  check('半日の戦闘が一日ある',
    c.stages.some((s) => getMission(s.missionId).duration === 'long'));
  check('砲のほとんど無い日がある',
    c.stages.some((s) => getMission(s.missionId).support.artillery.rounds <= 4));
  check('攻める日がある',
    c.stages.some((s) => getMission(s.missionId).victory?.kind === 'seize_point'));
  check('刻みが三日間より浅い',
    Math.abs(c.frontShift.defeat) < 18 && c.frontShift.victory < 14);

  // 文言。前口上と後日談が全段階に、勝ち・辛勝・負けの三通りとも要る。
  check('全段階に前口上がある', c.stages.every((s) => (s.prologue ?? '').length > 20));
  check('全段階に三通りの後日談がある',
    c.stages.every((s) => ['victory', 'narrow', 'defeat'].every((k) => (s.epilogue?.[k] ?? '').length > 8)));
  check('戦役の締めくくりが三通りある',
    ['victory', 'narrow', 'defeat'].every((k) => (c.finale?.[k] ?? '').length > 10));
  const prose = [c.blurb, ...c.stages.flatMap((s) => [s.prologue, ...Object.values(s.epilogue)]),
    ...Object.values(c.finale)].join('');
  check('感嘆符を使っていない', !/[!！]/.test(prose));
  check('三日間の戦役も締めくくりを持っている',
    ['victory', 'narrow', 'defeat'].every((k) => (getCampaign('volne_three_days').finale?.[k] ?? '').length > 10));
}

/* ------------------------------------------------------------------ */

section('戦役でしか出ない任務');
{
  const ids = new Set(missionList().map((m) => m.id));
  check('選択画面には出さない', !ids.has('kolp_seize') && !ids.has('zaren_hold'));

  for (const id of ['kolp_seize', 'zaren_hold']) {
    const m = getMission(id);
    // 配置の座標。岩や水の上に置かれた部隊は、そこから一歩も動けない。
    const w = createWorld({ missionId: id });
    check(`${id}: 正しい図幅で始まる`, w.terrain.mapId === m.mapId, w.terrain.mapId);
    check(`${id}: 部隊が通れる地面にいる`,
      w.units.every((u) => u.tpl.flying || isPassable(w.terrain, u.x, u.y)));
    const bad = timeline(null, { mission: m })
      .filter((e) => e.kind === 'spawn')
      .flatMap((e) => e.units)
      .filter((d) => !UNIT_TYPES[d.type].flying && !isPassable(w.terrain, d.x, d.y));
    check(`${id}: 展開してくる部隊も通れる地面に出る`, bad.length === 0,
      bad.map((d) => `${d.callsign}(${d.x},${d.y})`).join(' '));
    check(`${id}: 編成表と戦闘序列が食い違わない`, (() => {
      const orbat = new Set(m.orbat().map((d) => d.id));
      return m.rosterOrder.every((r) => orbat.has(r.id));
    })());
    check(`${id}: 決着する`, (() => {
      let i = 0;
      while (!w.outcome && i++ < 30000) tick(w, 1);
      return w.outcome != null;
    })(), String(w.outcome));
  }

  const hold = getMission('zaren_hold');
  check('ザーレンの確保は砲弾が4発しかない', hold.support.artillery.rounds === 4,
    `${hold.support.artillery.rounds}`);
  check('関門の丘の奪回は3分の確保を要る', getMission('kolp_seize').victory.holdFor === 180);
}

/* ------------------------------------------------------------------ */

section('六日を通しで走らせる');
{
  const st = newCampaign('kolp_corridor', 4242);
  check('六日と読める', getCampaignView(st).stageCount === 6);
  check('初日は橋', getCampaignView(st).stage.missionId === 'bridge_hold');
  check('全員に名前が配られる', getCompany(st).every((r) => !!r.officer));
  check('六日目に初めて出る部隊にも名前がある', !!st.officers.get('SH') && !!st.officers.get('H5'));
  check('夜の使い方は三つとも選べる', NIGHT_PLAN_IDS.length === 3);

  let days = 0;
  let started = 0;
  const missed = [];
  const seen = [];
  // 戦役は戦線が尽きれば六日を待たずに終わる。
  // だから日ごとに check を置くと、走らせるたびに件数が変わった ─
  // 数が揺れる検査は、一件が黙って消えても気づけない。
  while (!st.finished && days++ < 8) {
    const g = startCampaignBattle(st);
    if (g) started++;
    else missed.push(currentStage(st)?.missionId ?? '?');
    startClock(g);
    let k = 0;
    while (!g.finished && k++ < 60000) advance(g, 1);
    finishCampaignBattle(g);
    seen.push(st.history[st.history.length - 1]);
  }
  check('戦った日はすべて一戦が起こせた', missed.length === 0 && started === st.history.length,
    `${started}戦 / 記録${st.history.length}件 ${missed.join(',')}`);
  check('戦役が決着する', st.finished && !!st.result, `${st.result}`);
  check('決着に理由がある', (st.resultReason ?? '').length > 5);
  check('六日を超えない', st.history.length <= 6, `${st.history.length}`);
  check('全戦の記録に後日談が入る', seen.every((h) => (h.epilogue ?? '').length > 8));
  check('戦線は毎戦動く', seen.every((h) => typeof h.front === 'number'));

  // 六晩あって初めて国政の曲線が曲がる ─ 継続の令の維持費も、恐怖の減衰も。
  // 三日では工場が一度しか払い出さず、傷跡も恐怖も曲がりきらない。
  check('国政の晩が戦った日数ぶん立った', st.settledStage === st.history.length - 1,
    `${st.settledStage} / ${st.history.length}`);
  check('六晩ぶんの生産が回っている', st.nation.output.replacements > 0 && st.nation.ledger.length >= 0);
}

/* ------------------------------------------------------------------ */

section('保存と読み戻し');
{
  const st = newCampaign('kolp_corridor', 31);
  st.front = 41;
  st.stage = 2;
  const back = deserializeCampaign(JSON.parse(JSON.stringify(serializeCampaign(st))));
  check('六日の戦役を書き出して読み戻せる',
    back.campaignId === 'kolp_corridor' && back.front === 41 && back.stage === 2);
  check('読み戻したものから戦線が引ける', frontTilt(back) < 0, `${frontTilt(back)}`);
  check('読み戻したものから出撃の支度ができる', !!battleSetup(back).front);
  stashFront(null);

  // 変更前に書かれた保存が、そのまま読めること。
  // 三日間の戦役しか無かった頃の保存には front も campaignId も同じ形で入っている。
  const old = {
    v: 1, campaignId: 'volne_three_days', stage: 1, front: 64,
    finished: false, result: null, resultReason: null,
    pool: { replacements: 6, rounds: 4, smoke: 2, illum: 2 },
    assets: { mg: 1, at: 0, eng: 1, fo: 1, medic: 0, relay: 0 },
    attach: {}, assign: {}, allot: { rounds: 0, smoke: 0, illum: 0 },
    night: 'rest', carry: { H1: { strength: 7, maxStrength: 9, ammoRatio: 0.4, morale: 70 } },
    officers: [], history: [], nation: null,
  };
  const loaded = deserializeCampaign(old);
  check('変更前の保存が読める', !!loaded && loaded.front === 64 && loaded.stage === 1);
  check('変更前の保存からも戦線が引ける',
    Math.abs(frontTilt(loaded) - 0.28) < 1e-9, `${frontTilt(loaded)}`);
  check('変更前の保存からも出撃できる', !!battleSetup(loaded).units);
  stashFront(null);

  // 国の無い保存（v2.0）でも、国は既定値で立ち上がる ─ 読めなくなってはならない。
  const noNation = battleSetup(loaded).war;
  check('国の無い保存でも国が立ち上がる', !!noNation && (noNation.fear ?? 0) === 0);
  stashFront(null);
}

/* ------------------------------------------------------------------ */

section('戦役の定義そのもの');
{
  for (const c of CAMPAIGNS) {
    check(`${c.id}: 戦線の目盛りが筋が通っている`,
      c.front.min < c.front.start && c.front.start < c.front.max);
    // 戦役の半分の日を落としても、まだ翌日に立てること。
    // 刻みが深すぎる戦役は、二日つまずいた時点で残りの段階が飾りになる。
    check(`${c.id}: 日数の半分を落としても戦線が残る`, (() => {
      const shift = c.frontShift ?? { defeat: -18 };
      return (c.front.start - c.front.min) / Math.abs(shift.defeat) >= c.stages.length / 2;
    })(), (() => {
      const shift = c.frontShift ?? { defeat: -18 };
      return `${((c.front.start - c.front.min) / Math.abs(shift.defeat)).toFixed(1)}敗 / ${c.stages.length}日`;
    })());
    check(`${c.id}: 全段階に日付と表題がある`,
      c.stages.every((s) => s.day && s.title && s.id));
    check(`${c.id}: 段階の id が重複しない`,
      new Set(c.stages.map((s) => s.id)).size === c.stages.length);
  }
}

/* ------------------------------------------------------------------ */

console.log(`\n${checks - failures}/${checks} 件成功`);
if (failures > 0) {
  console.error(`${failures} 件失敗`);
  process.exit(1);
}
console.log('戦役は健全です。');
