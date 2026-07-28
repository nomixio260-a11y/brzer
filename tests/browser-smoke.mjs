// 実ブラウザでの通し検査。CI からも手元からも同じものを走らせる。
//
//   node tests/browser-smoke.mjs
//   BRZER_URL=http://127.0.0.1:8127/index.html node tests/browser-smoke.mjs
//   BRZER_CHROMIUM=/path/to/chrome node tests/browser-smoke.mjs
//
// 検査するのは「起動して、地図が描けて、マーカーが置けて、命令が通って、
// 講評まで到達し、その間コンソールに何も出ない」こと。

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.BRZER_URL ?? 'http://127.0.0.1:8127/index.html';
const SHOTS = '.artifacts';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let checks = 0;

function check(name, cond, detail = '') {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const browser = await chromium.launch({
  executablePath: process.env.BRZER_CHROMIUM || undefined,
  args: ['--no-sandbox', '--mute-audio'],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const problems = [];
page.on('pageerror', (e) => problems.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`CONSOLE ${m.text()}`);
});
page.on('requestfailed', (r) => problems.push(`REQUEST ${r.url()} ${r.failure()?.errorText}`));

function section(title) {
  console.log(`\n== ${title} ==`);
}

/**
 * 時計を回す。
 *
 * 戦闘は「H時前」から始まるので、H時を宣言しないと running を立てても時刻は動かない。
 * 検査の各所でこれを忘れると、交信が一度も起きないまま待ち続けることになる。
 */
async function runClock(p, speed = 30) {
  await p.evaluate((sp) => {
    const b = window.__brzer;
    if (b.game.world.planning) b.state.startClock(b.game);
    b.game.speed = sp;
    b.game.running = true;
  }, speed);
}

/**
 * 版面の検査。
 *
 * 「見にくくないように」を人の目で毎回確かめるのは続かないので、機械に見させる。
 * 検めるのは3つ ── 横に溢れていないか、押せるはずのものが他の要素に覆われていないか、
 * 文字が箱に入りきらず切れていないか。
 */
const VIEWPORTS = [
  { name: '広い机 1600×950', width: 1600, height: 950, touch: false },
  { name: '手狭な机 1280×800', width: 1280, height: 800, touch: false },
  { name: '小型機 1024×768', width: 1024, height: 768, touch: false },
  { name: '板 820×1180', width: 820, height: 1180, touch: true },
  { name: '携帯 390×844', width: 390, height: 844, touch: true },
  { name: '小型携帯 360×640', width: 360, height: 640, touch: true },
  { name: '携帯・横持ち 740×360', width: 740, height: 360, touch: true },
];

const AUDIT = () => {
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    problems.push(`横に溢れている (${doc.scrollWidth}>${doc.clientWidth})`);
  }

  const vw = doc.clientWidth;
  const vh = doc.clientHeight;
  // 見えているか。祖先が透明にしていたり、指を通さない設定なら「無い」ものとして扱う。
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      if (+s.opacity <= 0.05) return false;
      if (s.pointerEvents === 'none') return false;
    }
    return true;
  };

  // 巻ける箱の外へ出ているだけか（それは「覆われている」ではない）
  const scrolledOut = (el, r) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (!/auto|scroll/.test(s.overflowY + s.overflowX)) continue;
      const b = n.getBoundingClientRect();
      if (r.bottom > b.bottom + 1 || r.top < b.top - 1 || r.right > b.right + 1 || r.left < b.left - 1) {
        return true;
      }
    }
    return false;
  };

  // 押せるものが画面から出ていないか／他の要素に覆われていないか
  for (const el of document.querySelectorAll('button, input, .tabbar__btn')) {
    if (!visible(el)) continue;
    if (el.closest('.view:not(.is-active)')) continue;
    const r = el.getBoundingClientRect();
    const id = el.id || el.className || el.textContent.trim().slice(0, 8);
    // 縦は巻けるので見ない。横に出るのだけが本当の「はみ出し」である。
    if (r.right > vw + 1 || r.left < -1) {
      problems.push(`横にはみ出す: ${id} (${Math.round(r.left)}〜${Math.round(r.right)} / 幅${vw})`);
      continue;
    }
    if (r.top < 0 || r.bottom > vh) continue; // 画面外は覆い判定ができない
    if (scrolledOut(el, r)) continue; // 巻けば出てくるものは覆われていない
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      problems.push(`覆われている: ${id} ← ${hit.id || hit.className}`);
    }
  }

  // 文字が箱に入りきらず切れていないか（省略記号を明示している所は除く）
  for (const el of document.querySelectorAll('.panel button, .roster li, .radiolog li, .order__status, .topbar *')) {
    if (!visible(el)) continue;
    if (el.closest('.view:not(.is-active)')) continue;
    const s = getComputedStyle(el);
    if (s.textOverflow === 'ellipsis') continue;
    if (s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
    if (el.scrollWidth > el.clientWidth + 2 && s.overflowX === 'hidden') {
      problems.push(`文字が切れている: ${el.id || el.className} (${el.scrollWidth}>${el.clientWidth})`);
    }
  }
  return problems;
};

async function auditLayouts() {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
      deviceScaleFactor: vp.touch ? 3 : 1,
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });

    const found = [];
    found.push(...(await p.evaluate(AUDIT)).map((s) => `[ブリーフィング] ${s}`));

    await p.click('#btn-start');
    await p.waitForTimeout(700);

    // H時前の版面（作戦命令の帯が出ている状態）
    found.push(...(await p.evaluate(AUDIT)).map((s) => `[H時前] ${s}`));
    await p.click('#btn-hhour');
    await p.waitForTimeout(400);

    // 携帯・板ではタブごとに版面が変わるので、順に開いて見る。
    // 最後は命令タブで終える（続けて命令パネルの中身を検めるため）。
    const narrow = await p.evaluate(() => !!document.querySelector('.tabbar')?.offsetParent);
    const tabs = narrow ? ['map', 'roster', 'log', 'order'] : [null];
    for (const tab of tabs) {
      if (tab) {
        await p.click(`.tabbar__btn[data-tab="${tab}"]`);
        await p.waitForTimeout(360);
      }
      found.push(...(await p.evaluate(AUDIT)).map((s) => `[${tab ?? '全体'}] ${s}`));
    }

    // 命令パネルを実際に使ったときの版面（分類タブごと）
    await p.waitForSelector('#order-units button[data-unit="H1"]', { state: 'visible', timeout: 8000 });
    await p.click('#order-units button[data-unit="H1"]');
    for (const g of await p.$$eval('#order-groups button', (bs) => bs.map((b) => b.dataset.group))) {
      await p.click(`#order-groups button[data-group="${g}"]`);
      await p.waitForTimeout(140);
      found.push(...(await p.evaluate(AUDIT)).map((s) => `[命令/${g}] ${s}`));
    }

    check(`${vp.name} で溢れも重なりもない`, found.length === 0, found.slice(0, 4).join(' | '));
    check(`${vp.name} でエラーが出ない`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
}

/**
 * 長期戦。
 * 半日の戦闘には段列が付き、兵站の命令が増え、静穏を飛ばす x8 が出る。
 */
async function checkLongBattle() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p.click('#mission-pick button[data-mission="bridge_hold_long"]');
  await p.waitForTimeout(250);
  check('長期戦を選べる', (await p.textContent('#brief-title')).includes('持久'));
  check('時間帯が入れ替わる', (await p.textContent('#brief-sub')).includes('0430'));
  check('編成に段列が加わる', (await p.textContent('#brief-oob')).includes('ラーダー'));

  await p.click('#btn-start');
  await p.waitForTimeout(900);
  check('長期戦が始まる', (await p.textContent('#clock')).trim() === '0430');
  check('夜間と表示される', (await p.textContent('#visibility')).includes('夜間'));
  check('段列の残数が出る', await p.isVisible('#trains-item'));
  check('静穏を飛ばす8倍が出る', await p.isVisible('#speed-8'));
  // H時前は時計が止まっている。速さの話はH時を宣言してからになる。
  await p.click('#btn-hhour');
  await p.waitForTimeout(300);
  await p.click('#speed-8');
  check('8倍が効く', (await p.evaluate(() => window.__brzer.game.speed)) === 8);

  // 兵站の命令が出せる
  await p.click('#order-units button[data-unit="H1"]');
  const groups = await p.$$eval('#order-groups button', (bs) => bs.map((b) => b.textContent));
  check('兵站の分類が出る', groups.includes('兵站'), groups.join(','));
  await p.click('#order-groups button[data-group="sustain"]');
  const verbs = await p.$$eval('#order-verbs button', (bs) => bs.map((b) => b.dataset.verb));
  check('補給要請・休止が出せる',
    verbs.includes('resupply') && verbs.includes('rest') && verbs.includes('stand_to'),
    verbs.join(','));

  await p.click('#order-verbs button[data-verb="resupply"]');
  await p.click('#order-send');
  await p.waitForTimeout(600);
  check('補給要請が発令された',
    await p.evaluate(() => window.__brzer.game.world.orders.some((o) => o.verb === 'resupply')));

  // 段列は実際に動き出す
  let moved = false;
  try {
    await p.waitForFunction(() => window.__brzer.game.world.trains.task != null, null, { timeout: 25000 });
    moved = true;
  } catch { /* 下で落ちる */ }
  check('段列が運搬に出る', moved);

  // 短期戦には兵站の命令がない
  const short = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const sp = await short.newPage();
  await sp.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await sp.click('#btn-start');
  await sp.waitForTimeout(700);
  check('短期戦に段列は出ない', !(await sp.isVisible('#trains-item')));
  check('短期戦に8倍はない', !(await sp.isVisible('#speed-8')));
  await sp.click('#order-units button[data-unit="H1"]');
  const sGroups = await sp.$$eval('#order-groups button', (bs) => bs.map((b) => b.textContent));
  check('短期戦に兵站の分類はない', !sGroups.includes('兵站'), sGroups.join(','));
  await short.close();

  check('長期戦でエラーが出ない', errs.length === 0, errs.join(' | '));
  await p.screenshot({ path: `${SHOTS}/05-long.png` });
  await ctx.close();
}

/**
 * 図幅ごとの通し確認。
 * 4本のミッションが、それぞれの図幅で起動し、地図が刷れていること。
 */
async function checkMissions() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('#mission-pick button').length > 0,
    null, { timeout: 10000 });
  const ids = await p.$$eval('#mission-pick button', (bs) => bs.map((b) => b.dataset.mission));
  check('ミッションが4本選べる', ids.length === 4, ids.join(','));

  const seen = new Set();
  for (const id of ids) {
    await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
    await p.waitForFunction(() => document.querySelectorAll('#mission-pick button').length > 0,
      null, { timeout: 10000 });
    await p.click(`#mission-pick button[data-mission="${id}"]`);
    await p.waitForTimeout(300);
    const sub = await p.textContent('#brief-sub');
    await p.click('#btn-start');
    await p.waitForTimeout(1100);

    const info = await p.evaluate(() => ({
      map: window.__brzer.game.world.terrain.mapId,
      units: window.__brzer.game.world.units.length,
      clock: document.getElementById('clock').textContent.trim(),
      objective: document.getElementById('objective-line').textContent,
    }));
    seen.add(info.map);
    check(`${id}: 起動する`, info.units > 0 && info.clock.length === 4, JSON.stringify(info));
    check(`${id}: 任務が表示される`, info.objective.length > 5, info.objective);
    check(`${id}: 図幅名が出ている`, sub.length > 6, sub);

    // 地図が紙として刷れているか（真っ黒でないこと）
    const painted = await p.evaluate(() => {
      const c = document.getElementById('map');
      const g = c.getContext('2d');
      const d = g.getImageData(Math.floor(c.width * 0.5), Math.floor(c.height * 0.45), 1, 1).data;
      return d[0] > 60 && d[1] > 60;
    });
    check(`${id}: 地図が刷れている`, painted);
  }
  check('図幅が3面使われている', seen.size === 3, [...seen].join(','));
  check('図幅の切り替えでエラーが出ない', errs.length === 0, errs.slice(0, 3).join(' | '));

  await p.screenshot({ path: `${SHOTS}/06-mission.png` });
  await ctx.close();
}

/**
 * 記号を貼る手数。
 * 部隊一覧から一発で置けること、名前が見本から一発で入ること、
 * そして携帯で「頁を開き直さずに」命令を送り切れること。
 */
async function checkQuickMarking() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('#mission-pick button').length > 0,
    null, { timeout: 10000 });
  // ここで見るのは手で書く道具立てなので、書記には黙っていてもらう
  await p.uncheck('#opt-autoplot');
  await p.click('#btn-start');
  await p.waitForTimeout(900);

  // 交信が入るまで進める（聞いていない部隊は置けない）
  await runClock(p, 30);
  await p.waitForSelector('#roster button[data-mark-unit]', { timeout: 120000 });
  await p.evaluate(() => { window.__brzer.game.running = false; });

  const before = await p.evaluate(() => window.__brzer.game.belief.markers.length);
  const unit = await p.$eval('#roster button[data-mark-unit]', (b) => b.dataset.markUnit);
  await p.click(`#roster button[data-mark-unit="${unit}"]`);
  await p.waitForTimeout(200);

  const placed = await p.evaluate((id) => {
    const m = window.__brzer.game.belief.markers.find((x) => x.unitId === id);
    return m ? { type: m.type, label: m.label, x: m.x, y: m.y } : null;
  }, unit);
  check('部隊一覧から一発で駒が置ける', !!placed, JSON.stringify(placed));
  check('置かれた駒は自軍の記号である', placed?.type === 'friendly', placed?.type);
  check('名前は呼出符号がそのまま入る', (placed?.label ?? '').length > 0, placed?.label);
  check('記号がひとつ増えた',
    (await p.evaluate(() => window.__brzer.game.belief.markers.length)) === before + 1);

  // 二度目は増やさずに動かす（名前を打ち直させない）
  await runClock(p, 30);
  await p.waitForTimeout(1200);
  await p.evaluate(() => { window.__brzer.game.running = false; });
  await p.click(`#roster button[data-mark-unit="${unit}"]`);
  await p.waitForTimeout(200);
  const after = await p.evaluate((id) => ({
    count: window.__brzer.game.belief.markers.length,
    m: window.__brzer.game.belief.markers.find((x) => x.unitId === id),
  }), unit);
  check('二度目は増やさず同じ駒を動かす', after.count === before + 1, `${after.count}`);
  check('名前は保たれる', after.m?.label === placed.label, after.m?.label);

  // ラベルの見本 ─ 一つ叩けば名前が入る
  const box = await p.locator('#map').boundingBox();
  await p.click('#marker-tools button[data-marker="enemy_armor"]');
  await p.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.4);
  await p.waitForTimeout(200);
  check('置いた直後にラベル欄が出る', await p.isVisible('#marker-editor'));
  const chips = await p.$$eval('#marker-chips button', (bs) => bs.map((b) => b.textContent));
  check('敵戦車には両数の見本が出る', chips.some((c) => c.includes('戦車')), chips.join(','));
  await p.click('#marker-chips button >> nth=0');
  await p.waitForTimeout(150);
  check('見本を叩けば名前が入る', await p.evaluate(() => {
    const m = window.__brzer.game.belief.markers.at(-1);
    return typeof m.label === 'string' && m.label.length > 0;
  }));
  await p.click('#marker-close');
  check('閉じるで引っ込む', !(await p.isVisible('#marker-editor')));

  // 自軍の記号の見本は呼出符号
  await p.click('#marker-tools button[data-marker="friendly"]');
  await p.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.62);
  await p.waitForTimeout(200);
  const own = await p.$$eval('#marker-chips button', (bs) => bs.map((b) => b.textContent));
  check('自軍の見本は呼出符号', own.includes('ハンマー1'), own.join(','));
  await p.click('#marker-close');

  // 地図の上から命令を送り切れる（頁を開き直さない）
  await p.click('#order-units button[data-unit="H2"]');
  await p.click('#order-groups button[data-group="maneuver"]');
  await p.click('#order-verbs button[data-verb="defend"]');
  check('目標を促す帯が出る', await p.isVisible('#map-hint'));
  check('まだ送信は出ていない', !(await p.isVisible('#map-hint-send')));
  await p.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.66);
  await p.waitForTimeout(200);
  check('目標を打つと地図に送信が出る', await p.isVisible('#map-hint-send'));
  const ordersBefore = await p.evaluate(() => window.__brzer.game.world.orders.length);
  await p.click('#map-hint-send');
  await p.waitForTimeout(300);
  check('地図から送信できる',
    (await p.evaluate(() => window.__brzer.game.world.orders.length)) === ordersBefore + 1);
  check('送ったら帯が引っ込む', !(await p.isVisible('#map-hint')));

  // 取りやめ
  await p.click('#order-verbs button[data-verb="defend"]');
  check('取りやめが出る', await p.isVisible('#map-hint-cancel'));
  await p.click('#map-hint-cancel');
  await p.waitForTimeout(150);
  check('取りやめで帯が消える', !(await p.isVisible('#map-hint')));

  check('記号まわりでエラーが出ない', errs.length === 0, errs.slice(0, 3).join(' | '));
  await p.screenshot({ path: `${SHOTS}/08-marking.png` });
  await ctx.close();
}

/**
 * 自動記入。
 * 無線が入れば書記が盤に写す ─ 指揮官が地図を叩き続けなくてよいこと。
 */
async function checkAutoPlot() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('#mission-pick button').length > 0,
    null, { timeout: 10000 });
  check('自動記入は既定で入っている', await p.isChecked('#opt-autoplot'));
  await p.click('#btn-start');
  await p.waitForTimeout(500);
  check('入切の釦が出ている', await p.isVisible('#btn-autoplot'));

  // 一度も地図を叩かないまま進める
  await runClock(p, 30);
  await p.waitForFunction(
    () => window.__brzer.game.belief.markers.filter((m) => m.unitId).length >= 3,
    null, { timeout: 120000 }
  );
  await p.evaluate(() => { window.__brzer.game.running = false; });

  const state = await p.evaluate(() => {
    const ms = window.__brzer.game.belief.markers;
    return {
      total: ms.length,
      friends: ms.filter((m) => m.unitId).length,
      labelled: ms.filter((m) => m.unitId && m.label).length,
      noted: ms.filter((m) => m.note).length,
      history: window.__brzer.game.history.length,
    };
  });
  check('地図を叩かずに駒が並ぶ', state.friends >= 3, `${state.friends}`);
  check('駒には呼出符号が入っている', state.labelled === state.friends, `${state.labelled}`);
  check('駒には現況が添っている', state.noted > 0, `${state.noted}`);
  check('取り消し履歴は汚れない', state.history === 0, `${state.history}`);

  // 切れば止まる（釦でも鍵でも）
  await p.click('#btn-autoplot');
  await p.waitForTimeout(150);
  check('釦を押すと消灯する',
    !(await p.$eval('#btn-autoplot', (b) => b.classList.contains('is-on'))));
  const frozen = await p.evaluate(() => window.__brzer.game.belief.markers.length);
  await runClock(p, 30);
  await p.waitForTimeout(2500);
  await p.evaluate(() => { window.__brzer.game.running = false; });
  check('切れば駒は増えない',
    (await p.evaluate(() => window.__brzer.game.belief.markers.length)) === frozen,
    `${frozen}`);

  await p.keyboard.press('a');
  await p.waitForTimeout(150);
  check('A で入れ直せる',
    await p.$eval('#btn-autoplot', (b) => b.classList.contains('is-on')));

  check('自動記入でエラーが出ない', errs.length === 0, errs.slice(0, 3).join(' | '));
  await p.screenshot({ path: `${SHOTS}/12-autoplot.png` });
  await ctx.close();
}

/**
 * H時前の作戦命令。
 * 時計が止まっていること、渡した命令が網に乗らないこと、H時で回り始めること。
 */
async function checkPlanning() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('#mission-pick button').length > 0,
    null, { timeout: 10000 });
  await p.click('#btn-start');
  await p.waitForTimeout(800);

  check('H時前の帯が出る', await p.isVisible('#planbar'));
  check('時計は止まっている',
    await p.evaluate(() => window.__brzer.state.isPlanning(window.__brzer.game)));
  const t0 = await p.evaluate(() => window.__brzer.game.world.now);
  await p.waitForTimeout(1200);
  check('待っても時刻が進まない',
    (await p.evaluate(() => window.__brzer.game.world.now)) === t0);

  // 計画で命令を渡す ─ 網には乗らない
  const box = await p.locator('#map').boundingBox();
  await p.click('#order-units button[data-unit="H1"]');
  await p.click('#order-groups button[data-group="maneuver"]');
  await p.click('#order-verbs button[data-verb="defend"]');
  await p.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await p.waitForTimeout(200);
  check('計画中でも地図から送信できる', await p.isVisible('#map-hint-send'));
  await p.click('#map-hint-send');
  await p.waitForTimeout(400);

  const st = await p.evaluate(() => ({
    plan: window.__brzer.game.world.stats.planningOrders ?? 0,
    queue: window.__brzer.game.world.radio.queue.length,
    acks: window.__brzer.game.world.radio.log.filter((l) => l.kind === 'ack').length,
    sys: window.__brzer.game.belief.log.filter((l) => l.text.includes('作戦命令')).length,
  }));
  check('口頭で渡した扱いになる', st.plan === 1, `${st.plan}`);
  check('網は空いたまま', st.queue === 0 && st.acks === 0, JSON.stringify(st));
  check('命令書が記録簿に残る', st.sys >= 1, `${st.sys}`);

  await p.screenshot({ path: `${SHOTS}/13-planning.png` });

  await p.click('#btn-hhour');
  await p.waitForTimeout(600);
  check('H時で帯が引っ込む', !(await p.isVisible('#planbar')));
  check('H時で時計が回り始める',
    await p.evaluate(() => window.__brzer.game.running && !window.__brzer.game.world.planning));
  await p.waitForTimeout(1000);
  check('時刻が進む', (await p.evaluate(() => window.__brzer.game.world.now)) > t0);

  check('H時前後でエラーが出ない', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

/**
 * 戦役。
 * 三日を続けて戦い、損害と経歴が翌日へ持ち越されること。
 */
async function checkCampaign() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('#campaign-pick button').length > 0,
    null, { timeout: 10000 });
  check('戦役の入口がある', await p.isVisible('#campaign-pick button[data-campaign]'));
  check('更新内容への入口がある', await p.isVisible('#btn-notes'));

  await p.click('#btn-notes');
  await p.waitForTimeout(300);
  check('更新内容が開く', await p.isVisible('#view-notes'));
  await p.click('#btn-notes-back');
  await p.waitForTimeout(200);

  await p.click('#campaign-pick button[data-campaign]');
  await p.waitForTimeout(500);
  check('戦役の画面が開く', await p.isVisible('#view-campaign'));
  check('初日は峠', (await p.textContent('#camp-day')).includes('コルプ峠'));

  const cards = await p.$$('#camp-company .unitcard');
  check('中隊の顔ぶれが並ぶ', cards.length >= 6, `${cards.length}`);
  const officers = await p.$$eval('.unitcard__officer b', (e) => e.map((x) => x.textContent));
  check('全員に名前がある', officers.length >= 6, officers.join(','));
  check('気質が出ている', (await p.$$('.tempchip')).length >= 6);
  check('今夜の使い方は三択', (await p.$$('#camp-night .nightopt')).length === 3);

  // 分派を付ける
  const chip = await p.$('#camp-company .attachchip:not(:disabled)');
  check('分派が付けられる', !!chip);
  if (chip) {
    await chip.click();
    await p.waitForTimeout(200);
    check('付けた分派が点く', (await p.$$('.attachchip.is-on')).length === 1);
  }
  await p.click('#camp-night .nightopt >> nth=1');
  await p.waitForTimeout(150);
  check('今夜の使い方が選べる',
    await p.$eval('#camp-night .nightopt:nth-child(2)', (b) => b.classList.contains('is-on')));

  await p.screenshot({ path: `${SHOTS}/14-campaign.png`, fullPage: true });

  // 一日戦う
  await p.click('#btn-sortie');
  await p.waitForTimeout(1200);
  check('戦役の戦闘もH時前から始まる', await p.isVisible('#planbar'));
  check('付けた分派が盤に載る', await p.evaluate(() =>
    [...window.__brzer.game.world.unitsById.values()].some((u) => (u.attach ?? []).length > 0)));
  check('部隊に将校が付いている', await p.evaluate(() =>
    [...window.__brzer.game.world.unitsById.values()].some((u) => u.side === 'friend' && !!u.officer)));

  await p.click('#btn-hhour');
  await runClock(p, 60);
  await p.waitForSelector('#view-debrief.is-active', { timeout: 240000 });
  await p.waitForTimeout(900);
  check('講評に到達する', ['任務達成', '辛勝', '任務失敗']
    .includes((await p.textContent('#debrief-verdict')).replace(/\s/g, '')));
  check('戦役では「次の日へ」が出る', await p.isVisible('#btn-nextday'));
  check('戦役では「もう一度戦う」は出ない', !(await p.isVisible('#btn-again')));

  await p.click('#btn-nextday');
  await p.waitForTimeout(600);
  check('二日目の画面に戻る', await p.isVisible('#view-campaign'));
  check('二日目は橋', (await p.textContent('#camp-day')).includes('橋梁'));
  check('これまでが残る', (await p.$$('#camp-history .camphistory__item')).length === 1);

  const carried = await p.evaluate(() => {
    const st = window.__brzer.state;
    return st.getCompany(window.__brzer.game.campaign).map((r) => ({
      id: r.id, s: r.strength, max: r.maxStrength, ammo: r.ammoRatio,
    }));
  });
  check('損害が持ち越される', carried.some((r) => r.s < r.max), JSON.stringify(carried.slice(0, 3)));
  check('弾薬も持ち越される', carried.some((r) => r.ammo < 1));

  // 二日目に、聞き手が二重になっていないこと。
  // 画面を読み込み直さずに次の戦闘へ入るので、ここを見落とすと
  // 二日目は駒が2つ置かれ、取消が2手戻り、拡大が2段飛ぶ。
  await p.click('#btn-sortie');
  await p.waitForTimeout(1200);
  const box2 = await p.locator('#map').boundingBox();
  const m0 = await p.evaluate(() => window.__brzer.game.belief.markers.length);
  await p.mouse.click(box2.x + box2.width * 0.3, box2.y + box2.height * 0.3);
  await p.waitForTimeout(250);
  check('二日目でも一叩きで駒は一つ',
    (await p.evaluate(() => window.__brzer.game.belief.markers.length)) === m0 + 1,
    `${m0} → ${await p.evaluate(() => window.__brzer.game.belief.markers.length)}`);
  await p.keyboard.press('Escape');

  const z0 = await p.evaluate(() => window.__brzer.mapView.zoom);
  await p.click('#zoom-in');
  const z1 = await p.evaluate(() => window.__brzer.mapView.zoom);
  check('二日目でも拡大は一段', Math.abs(z1 / z0 - 1.5) < 0.02, `${z0} → ${z1}`);
  await p.click('#zoom-fit');

  await p.click('#order-units button[data-unit="H1"]');
  await p.click('#order-groups button[data-group="roe"]');
  const o0 = await p.evaluate(() => window.__brzer.game.world.orders.length);
  await p.click('#order-verbs button[data-verb="roe_elastic"]');
  await p.click('#order-send');
  await p.waitForTimeout(300);
  check('二日目でも命令は一通',
    (await p.evaluate(() => window.__brzer.game.world.orders.length)) === o0 + 1);
  check('二日目の記録簿は白紙から始まる',
    (await p.$$('#radiolog li')).length <= 3,
    `${(await p.$$('#radiolog li')).length}`);

  // 戦役をやめてブリーフィングへ戻る
  await p.click('#btn-hhour');
  await runClock(p, 60);
  await p.waitForSelector('#view-debrief.is-active', { timeout: 240000 });
  await p.waitForTimeout(700);
  await p.click('#btn-nextday');
  await p.waitForTimeout(500);

  // 閉じても続きから戦える
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('#campaign-pick button').length > 0,
    null, { timeout: 10000 });
  check('途中の戦役が残っている',
    (await p.textContent('#campaign-pick button[data-campaign]')).includes('途中まで'));
  await p.click('#campaign-pick button[data-campaign]');
  await p.waitForTimeout(400);
  check('続きから開く', (await p.textContent('#camp-day')).includes('ザーレン'),
    await p.textContent('#camp-day'));

  // やめれば消える
  await p.click('#btn-abandon');
  await p.waitForTimeout(300);
  check('やめればブリーフィングへ戻る', await p.isVisible('#view-briefing'));
  check('やめれば記録も消える',
    !(await p.textContent('#campaign-pick button[data-campaign]')).includes('途中まで'));

  check('戦役でエラーが出ない', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

/**
 * 国政。
 * 政令が出せ、粛清には一手が挟まり、統治が前線に返ってくること。
 */
async function checkNation() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('#campaign-pick button').length > 0,
    null, { timeout: 10000 });
  await p.click('#campaign-pick button[data-campaign]');
  await p.waitForTimeout(400);

  check('前線の画面に国の帯が出る', await p.isVisible('#camp-nation'));
  check('国政への入口がある', await p.isVisible('#btn-govern'));
  await p.click('#btn-govern');
  await p.waitForTimeout(350);

  check('国政の画面が開く', await p.isVisible('#view-nation'));
  check('架空国家である', (await p.textContent('#nat-name')).includes('ヴォルネ'));
  check('指標が三つ出る', (await p.$$('#nat-meters .natmeter')).length === 3);
  check('政令が並ぶ', (await p.$$('#nat-decrees .decree')).length >= 10);
  check('士官団が並ぶ', (await p.$$('#nat-corps .corps')).length >= 6);
  check('恐怖は言葉で出る', (await p.textContent('#nat-fear')).length > 3);

  // 評議会 ─ 反対する者がいる画面
  check('評議会に四つの塊が並ぶ', (await p.$$('#nat-council .bloc')).length === 4);
  check('席に名前が出る',
    (await p.textContent('#nat-council [data-bloc="army"]')).includes('参謀総長'));
  check('支持は言葉で出る',
    (await p.$$eval('#nat-council .bloc__word', (e) => e.map((x) => x.textContent)))
      .every((t) => t.length > 0));
  check('初日から上奏が出ている', await p.isVisible('#nat-petition .petition'));
  check('上奏に台詞がある', (await p.textContent('.petition__text')).length > 12);
  check('容れる側と退ける側が並ぶ', (await p.$$('.petition .petbtn')).length === 2);
  check('札に相手の名が出る',
    (await p.$$eval('.petbtn .dtag', (e) => e.map((x) => x.textContent)))
      .some((t) => /軍部|民政|保安|産業/.test(t)));

  const petBloc = await p.evaluate(() => window.__brzer.campaign.nation.council.petition.bloc);
  const sup0 = await p.evaluate((b) => window.__brzer.campaign.nation.council.blocs[b].support, petBloc);
  await p.click('.petbtn[data-answer="accept"]');
  await p.waitForTimeout(250);
  check('容れれば持ってきた側が付く',
    (await p.evaluate((b) => window.__brzer.campaign.nation.council.blocs[b].support, petBloc)) > sup0);
  check('答えたことが画面に残る', await p.isVisible('.petition__done'));
  check('二度は答えられない', (await p.$$('.petition .petbtn')).length === 0);

  // 一晩に二つまで
  await p.click('#nat-decrees button[data-decree="conscript"]');
  await p.waitForTimeout(150);
  check('政令が選べる',
    await p.$eval('[data-decree="conscript"]', (b) => b.classList.contains('is-on')));
  await p.click('#nat-decrees button[data-decree="martial_law"]');
  await p.waitForTimeout(150);
  check('二つ目も選べる',
    await p.$eval('[data-decree="martial_law"]', (b) => b.classList.contains('is-on')));
  check('三つ目は押せない',
    await p.$eval('[data-decree="relief"]', (b) => b.disabled));
  check('残り件数が出る', (await p.textContent('#nat-left')).includes('0'));
  await p.click('#nat-decrees button[data-decree="conscript"]');
  await p.waitForTimeout(150);
  check('取り消せば押せるようになる',
    !(await p.$eval('[data-decree="relief"]', (b) => b.disabled)));

  await p.screenshot({ path: `${SHOTS}/15-nation.png`, fullPage: true });

  // 政令の札に、遅れと維持費が出ること
  const volunteer = await p.$$eval('[data-decree="volunteer"] .dtag', (e) => e.map((x) => x.textContent));
  check('善政の札に「明晩から」が出る', volunteer.some((t) => t.includes('明晩')), volunteer.join(','));
  const martial = await p.$$eval('[data-decree="martial_law"] .dtag', (e) => e.map((x) => x.textContent));
  check('継続の令に維持費が出る', martial.some((t) => t.includes('維持')), martial.join(','));

  // 通告 ─ 見えない賽ではなく、期限であること
  check('通告は出ていない', await p.$eval('#nat-warnings', (e) => e.hidden));
  await p.evaluate(() => {
    window.__brzer.campaign.nation.loyalty = 8;
    window.__brzer.campaign.nation.warned = { coup: true, uprising: false };
  });
  await p.click('#btn-nat-back');
  await p.click('#btn-govern');
  await p.waitForTimeout(300);
  check('線を割れば通告が出る', !(await p.$eval('#nat-warnings', (e) => e.hidden)));
  check('通告に期限が書いてある', (await p.textContent('#nat-warnings')).includes('翌朝'));
  await p.evaluate(() => {
    window.__brzer.campaign.nation.loyalty = 70;
    window.__brzer.campaign.nation.warned = { coup: false, uprising: false };
  });

  // 粛清には一手が挟まる
  const purged0 = await p.evaluate(() => window.__brzer.campaign.nation.purged.length);
  await p.click('#nat-corps button[data-purge]');
  await p.waitForTimeout(250);
  check('粛清には確認が挟まる', await p.isVisible('#confirm'));
  check('確認に代価が書いてある', (await p.textContent('#confirm-text')).includes('忠誠'));
  await p.click('#confirm-no');
  await p.waitForTimeout(200);
  check('やめれば何も起きない',
    !(await p.isVisible('#confirm')) &&
    (await p.evaluate(() => window.__brzer.campaign.nation.purged.length)) === purged0);

  const loyal0 = await p.evaluate(() => window.__brzer.campaign.nation.loyalty);
  await p.click('#nat-corps button[data-purge]');
  await p.waitForTimeout(200);
  await p.click('#confirm-yes');
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({
    purged: window.__brzer.campaign.nation.purged.length,
    loyalty: window.__brzer.campaign.nation.loyalty,
    control: window.__brzer.campaign.nation.control,
  }));
  check('実行すれば除かれる', after.purged === purged0 + 1);
  check('忠誠が下がる', after.loyalty < loyal0, `${loyal0} → ${after.loyalty}`);
  check('除かれた者が記録に残る', (await p.$$('#nat-rule .purgelist li')).length >= 1);

  // 叙勲
  await p.click('#nat-corps button[data-decorate]');
  await p.waitForTimeout(250);
  check('叙勲でエラーが出ない', errs.length === 0, errs.slice(0, 2).join(' | '));

  // 更迭 ─ 通告は止まるが、その省庁は二度と働かない
  await p.click('#nat-council [data-purge-minister="industry"]');
  await p.waitForTimeout(250);
  check('更迭にも確認が挟まる', await p.isVisible('#confirm'));
  check('確認に代価が書いてある（更迭）',
    (await p.textContent('#confirm-text')).includes('二度と働かない'));
  await p.click('#confirm-yes');
  await p.waitForTimeout(300);
  check('席が空く',
    await p.evaluate(() => window.__brzer.campaign.nation.council.blocs.industry.puppet === true));
  check('傀儡の省庁には更迭の釦が無い',
    (await p.$$('#nat-council [data-purge-minister="industry"]')).length === 0);
  check('空にした席が記録に残る', (await p.textContent('#nat-rule')).includes('空にした席'));

  await p.click('#btn-nat-back');
  await p.waitForTimeout(300);
  check('前線へ戻れる', await p.isVisible('#view-campaign'));

  // 政令は出撃の直前に効く
  const pool0 = await p.evaluate(() => window.__brzer.campaign.pool.replacements);
  await p.click('#btn-sortie');
  await p.waitForTimeout(1200);
  const st = await p.evaluate(() => ({
    pool: window.__brzer.campaign.pool.replacements,
    fear: window.__brzer.campaign.nation.fear,
    standing: window.__brzer.campaign.nation.standing,
    distortion: window.__brzer.game.world.distortion,
    war: !!window.__brzer.game.world.setup.war,
  }));
  check('政令で補充が増える', st.pool > pool0, `${pool0} → ${st.pool}`);
  check('継続の令が施行中になる', st.standing.includes('martial_law'), JSON.stringify(st.standing));
  check('戒厳令は恐怖を生む', st.fear > 0, `${st.fear}`);
  check('国の係数が盤に渡る', st.war && st.distortion.fear === st.fear);

  // 恐怖の下で一日戦い、講評で突き合わせが出ること
  await p.evaluate(() => { window.__brzer.campaign.nation.fear = 0.85; });
  await p.click('#btn-hhour');
  await runClock(p, 60);
  await p.waitForSelector('#view-debrief.is-active', { timeout: 240000 });
  await p.waitForTimeout(900);
  check('講評に「聞いていたこと」の節が出る', await p.isVisible('#debrief-gap-block'));
  check('二列が並ぶ', (await p.$$('#debrief-gap li')).length > 0);
  check('報告の甘さが講評に出る',
    (await p.textContent('#debrief-stats')).includes('貴官が受けていた報告'));

  check('国政でエラーが出ない', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
}

/**
 * 演習モード。
 * 増援が呼べ、真実の地図が開き、そして本編ではそれが一切できないこと。
 */
async function checkCreative() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('#mission-pick button').length > 0,
    null, { timeout: 10000 });

  check('演習の選択肢がある', await p.isVisible('#opt-creative'));
  await p.check('#opt-creative');
  await p.click('#btn-start');
  await p.waitForTimeout(1000);

  check('真実の釦が出る', await p.isVisible('#btn-reveal'));
  check('統裁が命令パネルに並ぶ', await p.isVisible('#order-units button[data-unit="CRE"]'));

  // 統裁 → 増援要請 → 兵種 → 地図 → 送信
  await p.click('#order-units button[data-unit="CRE"]');
  check('演習の分類が出る', await p.isVisible('#order-groups button[data-group="drill"]'));
  await p.click('#order-verbs button[data-verb="call_friend"]');
  check('兵種を選ばせる', await p.isVisible('#order-mods button[data-mod="tank"]'));
  await p.click('#order-mods button[data-mod="tank"]');

  const box = await p.locator('#map').boundingBox();
  await p.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.75);
  const unitsBefore = await p.evaluate(() => window.__brzer.game.world.units.length);
  await p.click('#order-send');
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({
    units: window.__brzer.game.world.units.length,
    tanks: window.__brzer.game.world.units.filter((u) => u.side === 'friend' && u.type === 'tank').length,
    buttons: [...document.querySelectorAll('#order-units button')].length,
  }));
  check('増援が盤に出る', after.units === unitsBefore + 1 && after.tanks === 1, JSON.stringify(after));
  check('増援が命令パネルに増える', after.buttons > 7, `${after.buttons}`);

  // 真実の地図
  check('既定では伏せてある',
    await p.evaluate(() => window.__brzer.state.getRevealed(window.__brzer.game) === null));
  await p.click('#btn-reveal');
  await p.waitForTimeout(200);
  check('開くと真実が返る',
    await p.evaluate(() => (window.__brzer.state.getRevealed(window.__brzer.game) ?? []).length > 3));
  check('釦が点く', await p.$eval('#btn-reveal', (b) => b.classList.contains('is-on')));
  await p.screenshot({ path: `${SHOTS}/07-creative.png` });

  // 弾が減らない
  const he = await p.textContent('#ammo-he');
  check('弾数が無限表示になる', he.trim() === '∞', he);

  check('演習でエラーが出ない', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();

  // 本編には演習の入口が無い
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => document.querySelectorAll('#mission-pick button').length > 0,
    null, { timeout: 10000 });
  await p2.click('#btn-start');
  await p2.waitForTimeout(900);
  check('本編に真実の釦は出ない', !(await p2.isVisible('#btn-reveal')));
  check('本編に統裁はいない', !(await p2.isVisible('#order-units button[data-unit="CRE"]')));
  check('本編では真実が取れない',
    await p2.evaluate(() => window.__brzer.state.getRevealed(window.__brzer.game) === null));
  await ctx2.close();
}

try {
  console.log('\n== 起動 ==');
  await page.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  check('ブリーフィングが出る', await page.isVisible('#view-briefing'));
  // ブリーフィングの中身は起動時に組み立てられる。描き終わるまで待つ。
  await page.waitForFunction(() => document.getElementById('brief-mission').textContent.length > 10,
    null, { timeout: 10000 });
  check('任務文が地形から引かれている', /橋梁 [A-L]\d/.test(await page.textContent('#brief-mission')));
  await page.screenshot({ path: `${SHOTS}/01-briefing.png` });

  // この通しでは手で書く道具立てを見る。書記が横から駒を並べると数が合わない。
  // 自動記入そのものは checkAutoPlot と各ミッションの通しで見ている。
  await page.uncheck('#opt-autoplot');
  await page.click('#btn-start');
  await page.waitForTimeout(900);
  check('戦闘画面へ移る', await page.isVisible('#view-game'));
  check('目標行が入る', (await page.textContent('#objective-line')).length > 0);

  // この通しでは戦闘そのものを見る。H時前の検査は checkPlanning に分けてある。
  check('H時前から始まる', await page.isVisible('#planbar'));
  await page.click('#btn-hhour');
  await page.waitForTimeout(300);
  check('H時で時計が回り始める', await page.evaluate(() => window.__brzer.game.running));

  // 地図が「紙」として描けているか（真っ黒でないこと）
  const painted = await page.evaluate(() => {
    const c = document.getElementById('map');
    const g = c.getContext('2d');
    const d = g.getImageData(Math.floor(c.width * 0.5), Math.floor(c.height * 0.5), 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  });
  check('地図が描画されている', painted.r > 60 && painted.g > 60, JSON.stringify(painted));

  console.log('\n== 書き込み ==');
  const box = await (await page.$('#map')).boundingBox();
  await page.click('#marker-tools button[data-marker="enemy_inf"]');
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.32);
  await page.fill('#marker-label', '約9名');
  await page.keyboard.press('Escape');
  check('記号が置ける', (await page.evaluate(() => window.__brzer.game.belief.markers.length)) === 1);
  check('編集欄が閉じる', await page.$eval('#marker-editor', (e) => e.hidden));

  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.32);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.46, box.y + box.height * 0.37, { steps: 6 });
  await page.mouse.up();
  const moved = await page.evaluate(() => {
    const m = window.__brzer.game.belief.markers[0];
    return { x: Math.round(m.x), y: Math.round(m.y), label: m.label };
  });
  check('記号を動かせる', moved.label === '約9名' && moved.x > 0, JSON.stringify(moved));

  await page.mouse.click(box.x + box.width * 0.46, box.y + box.height * 0.37, { button: 'right' });
  await page.waitForTimeout(150);
  check('記号を消せる', (await page.evaluate(() => window.__brzer.game.belief.markers.length)) === 0);

  console.log('\n== 作図 ==');
  const drag = async (pts) => {
    await page.mouse.move(box.x + box.width * pts[0][0], box.y + box.height * pts[0][1]);
    await page.mouse.down();
    for (const [fx, fy] of pts.slice(1)) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 6 });
    }
    await page.mouse.up();
    await page.waitForTimeout(80);
  };

  await page.click('#sketch-tools button[data-sketch="arrow_enemy"]');
  await drag([[0.30, 0.28], [0.32, 0.36], [0.34, 0.44]]);
  check('矢印が引ける', (await page.evaluate(() => window.__brzer.game.belief.sketches.length)) === 1);

  // 記号の上から線を引いても、記号が動いてしまわないこと
  await page.click('#marker-tools button[data-marker="enemy_inf"]');
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.3);
  await page.keyboard.press('Escape');
  const before = await page.evaluate(() => {
    const m = window.__brzer.game.belief.markers[0];
    return { x: Math.round(m.x), y: Math.round(m.y) };
  });
  await page.click('#sketch-tools button[data-sketch="line_control"]');
  await drag([[0.55, 0.3], [0.68, 0.34]]);
  const after = await page.evaluate(() => {
    const m = window.__brzer.game.belief.markers[0];
    return { x: Math.round(m.x), y: Math.round(m.y) };
  });
  check('作図中に記号が動かない', before.x === after.x && before.y === after.y,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check('統制線が引ける', (await page.evaluate(() => window.__brzer.game.belief.sketches.length)) === 2);

  // 取り消し
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  check('Ctrl+Z で作図を取り消せる',
    (await page.evaluate(() => window.__brzer.game.belief.sketches.length)) === 1);

  await page.click('#btn-clear-markers');
  check('全消去で書き込みが消える', await page.evaluate(() =>
    window.__brzer.game.belief.markers.length === 0 && window.__brzer.game.belief.sketches.length === 0));
  await page.click('#marker-tools button[data-marker="enemy_inf"]');

  console.log('\n== 縮尺 ==');
  const z0 = await page.evaluate(() => window.__brzer.mapView.zoom);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(80);
  const z1 = await page.evaluate(() => window.__brzer.mapView.zoom);
  check('車輪で拡大できる', z1 > z0, `${z0} → ${z1}`);
  await page.keyboard.press('0');
  check('0キーで全体表示', (await page.evaluate(() => window.__brzer.mapView.zoom)) === 1);

  console.log('\n== 命令 ==');
  await page.click('#order-units button[data-unit="H3"]');
  await page.click('#order-verbs button[data-verb="withdraw"]');
  check('目標未指定では送信できない', await page.$eval('#order-send', (b) => b.disabled));
  await page.mouse.click(box.x + box.width * 0.44, box.y + box.height * 0.56);
  check('目標を指定すると送信できる', !(await page.$eval('#order-send', (b) => b.disabled)));
  await page.click('#order-send');
  await page.waitForTimeout(600);
  check('命令が発令された', (await page.evaluate(() => window.__brzer.game.world.stats.ordersIssued)) === 1);

  // 経路点つきの命令。地図を続けて叩くと経由地が積まれる。
  await page.click('#order-units button[data-unit="H2"]');
  await page.click('#order-verbs button[data-verb="move"]');
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.click(box.x + box.width * 0.34, box.y + box.height * 0.72);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.74);
  check('経路が3点になる',
    (await page.evaluate(() => window.__brzer.mapView.orderLegs.length)) === 3);
  check('目標欄に経路が並ぶ', /→.*→/.test(await page.textContent('#order-grid')));
  await page.click('#order-undoleg');
  check('取消で1点戻る',
    (await page.evaluate(() => window.__brzer.mapView.orderLegs.length)) === 2);
  await page.click('#map-hint-done');
  // 帯は消えない。指定が終わったので、そのまま地図の上で送信できる。
  check('決定で経由地の指定が終わる',
    (await page.isHidden('#map-hint-done')) && (await page.isVisible('#map-hint-send')));
  check('地図を叩いても点が増えない',
    (await page.evaluate(() => window.__brzer.mapView.orderLegs.length)) === 2);
  await page.click('#order-send');
  await page.waitForTimeout(500);
  check('経路つきの命令が発令された',
    (await page.evaluate(() =>
      window.__brzer.game.world.orders.some((o) => o.verb === 'move' && o.legs?.length === 2))));

  // 交戦規定。分類を切り替えて出す。
  await page.click('#order-units button[data-unit="H1"]');
  await page.click('#order-groups button[data-group="roe"]');
  const roeVerbs = await page.$$eval('#order-verbs button', (bs) => bs.map((b) => b.dataset.verb));
  check('交戦規定の分類が出る', roeVerbs.includes('roe_hold_fast') && roeVerbs.includes('roe_elastic'),
    roeVerbs.join(','));
  await page.click('#order-verbs button[data-verb="roe_hold_fast"]');
  check('交戦規定は目標を要らない', !(await page.$eval('#order-send', (b) => b.disabled)));
  await page.click('#order-send');
  await page.waitForTimeout(400);
  check('部隊一覧に死守が出る', (await page.textContent('#roster')).includes('死守'));

  // 予令。条件を付けて渡すと、部下が条件の成立を待って動く。
  await page.click('#order-units button[data-unit="H2"]');
  await page.click('#order-groups button[data-group="maneuver"]');
  await page.click('#order-verbs button[data-verb="defend"]');
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.66);
  await page.click('#order-triggers button[data-trig="at_time"]');
  check('時刻を選ばせる欄が出る', await page.isVisible('#order-trigtime'));
  check('予令の説明が出る', (await page.textContent('#order-status')).includes('予令'));
  await page.click('#order-send');
  await page.waitForTimeout(400);
  check('予令が発令された',
    await page.evaluate(() =>
      window.__brzer.game.world.orders.some((o) => o.trigger === 'at_time')));
  check('部隊一覧に予令が載る', (await page.textContent('#roster')).includes('予令'));

  // 統制線を引いて、それを予令の条件にする
  await page.click('#sketch-tools button[data-sketch="line_control"]');
  await page.mouse.move(box.x + box.width * 0.24, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.4, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  check('統制線が引ける',
    await page.evaluate(() =>
      window.__brzer.game.belief.sketches.some((s) => s.tool === 'line_control')));
  check('統制線に名前が付く',
    await page.evaluate(() =>
      !!window.__brzer.game.belief.sketches.find((s) => s.tool === 'line_control')?.name));

  await page.click('#marker-tools button[data-marker="enemy_inf"]'); // 記号へ戻す
  await page.click('#order-units button[data-unit="H2"]');
  await page.click('#order-groups button[data-group="maneuver"]');
  await page.click('#order-verbs button[data-verb="withdraw"]');
  await page.mouse.click(box.x + box.width * 0.36, box.y + box.height * 0.74);
  await page.click('#map-hint-done');
  await page.click('#order-triggers button[data-trig="on_line"]');
  check('統制線を条件に選べる', await page.isVisible('#order-trigline'));
  check('統制線の説明が出る', (await page.textContent('#order-status')).includes('統制線'));
  await page.click('#order-send');
  await page.waitForTimeout(400);
  check('統制線つきの予令が発令された',
    await page.evaluate(() =>
      window.__brzer.game.world.orders.some((o) => o.trigger === 'on_line' && o.line?.length >= 2)));

  // 交戦規定には条件を付けられない（枠は今から効くもの）
  await page.click('#order-groups button[data-group="roe"]');
  await page.click('#order-verbs button[data-verb="roe_elastic"]');
  check('交戦規定に条件は付かない',
    await page.$eval('#order-triggers button[data-trig="at_time"]', (b) => b.disabled));
  await page.click('#order-groups button[data-group="maneuver"]');

  // 砲兵には移動命令が出せない
  await page.click('#order-units button[data-unit="TH"]');
  const verbs = await page.$$eval('#order-verbs button', (bs) => bs.map((b) => b.dataset.verb));
  check('兵科ごとに出せる命令が違う',
    !verbs.includes('attack') && verbs.includes('fire_mission') && verbs.includes('register'),
    verbs.join(','));

  // 概定射点。標定しておくと地図に残る。無線で届いてからなので少し待つ。
  await page.click('#order-verbs button[data-verb="register"]');
  await page.mouse.click(box.x + box.width * 0.46, box.y + box.height * 0.38);
  await page.click('#order-send');
  await page.keyboard.press('3'); // 届くまで早送りする
  let registered = false;
  try {
    await page.waitForFunction(() => window.__brzer.game.world.registrations.length > 0, null,
      { timeout: 20000 });
    registered = true;
  } catch { /* 下の check で落ちる */ }
  check('概定射点が登録される', registered);

  // 射撃要領。砲撃要請のときだけ「態勢」の行が化ける。
  await page.evaluate(() => { window.__brzer.game.running = false; });
  await page.click('#order-verbs button[data-verb="fire_mission"]');
  const modes = await page.$$eval('#order-mods button', (bs) => bs.map((b) => b.dataset.mod));
  check('射撃要領が選べる',
    ['impact', 'airburst', 'sustained', 'salvo'].every((m) => modes.includes(m)), modes.join(','));
  await page.click('#order-mods button[data-mod="airburst"]');
  check('先に目標を促す', (await page.textContent('#order-status')).includes('目標'),
    await page.textContent('#order-status'));
  await page.mouse.click(box.x + box.width * 0.46, box.y + box.height * 0.36);
  check('要領の説明が出る', (await page.textContent('#order-status')).includes('掩体'),
    await page.textContent('#order-status'));
  await page.click('#order-send');
  await page.waitForTimeout(300);
  check('曳火で射撃要請が出る', await page.evaluate(() =>
    window.__brzer.game.world.orders.some((o) => o.verb === 'fire_mission' && o.modifier === 'airburst')));

  // 態勢の行は、機動の命令に戻ると態勢に戻る
  await page.click('#order-units button[data-unit="H1"]');
  await page.click('#order-groups button[data-group="maneuver"]');
  await page.click('#order-verbs button[data-verb="move"]');
  const posts = await page.$$eval('#order-mods button', (bs) => bs.map((b) => b.dataset.mod));
  check('機動では態勢に戻る', posts.includes('rapid') && !posts.includes('airburst'), posts.join(','));
  // 止めたまま次へ渡さない（この先で一時停止そのものを検査するため）
  await page.evaluate(() => { window.__brzer.game.running = true; });

  console.log('\n== 操作 ==');
  await page.keyboard.press('Space');
  check('スペースで止まる', (await page.evaluate(() => window.__brzer.game.running)) === false);
  await page.keyboard.press('3');
  const spd = await page.evaluate(() => ({ r: window.__brzer.game.running, s: window.__brzer.game.speed }));
  check('数字キーで速度が変わる', spd.r === true && spd.s === 4, JSON.stringify(spd));

  await page.screenshot({ path: `${SHOTS}/02-game.png` });

  console.log('\n== 無線から地図へ ==');
  // 接敵報告が出るまで進めてから、その一行を叩く
  await runClock(page, 30);
  await page.waitForSelector('#radiolog li[data-grid] [data-act="mark"]', { timeout: 120000 });
  await page.evaluate(() => { window.__brzer.game.running = false; });
  const marksBefore = await page.evaluate(() => window.__brzer.game.belief.markers.length);
  await page.click('#radiolog li[data-grid] [data-act="mark"]');
  await page.waitForTimeout(200);
  check('報告から記号を置ける',
    (await page.evaluate(() => window.__brzer.game.belief.markers.length)) === marksBefore + 1);
  check('置かれた記号に発信元が記される', await page.evaluate(() => {
    const m = window.__brzer.game.belief.markers.at(-1);
    return typeof m.note === 'string' && m.note.length > 0;
  }));

  console.log('\n== 決着まで ==');
  await runClock(page, 45);
  await page.waitForSelector('#view-debrief.is-active', { timeout: 240000 });
  await page.waitForTimeout(1200);

  const verdict = (await page.textContent('#debrief-verdict')).replace(/\s/g, '');
  check('講評に到達する', ['任務達成', '辛勝', '任務失敗'].includes(verdict), verdict);
  check('講評に理由がある', (await page.textContent('#debrief-reason')).length > 5);
  check('統計が出ている', (await page.$$('#debrief-stats dt')).length >= 8);
  check('各部隊の最期が出ている', (await page.$$('#debrief-units li')).length === 6);
  check('敵の決心が開示される', (await page.$$('#debrief-enemy li')).length >= 1);

  const truthPainted = await page.evaluate(() => {
    const c = document.getElementById('truthmap');
    const g = c.getContext('2d');
    const d = g.getImageData(Math.floor(c.width * 0.5), Math.floor(c.height * 0.4), 1, 1).data;
    return d[0] > 60 && d[1] > 60;
  });
  check('真実の地図が描かれている', truthPainted);

  await page.screenshot({ path: `${SHOTS}/03-debrief.png`, fullPage: true });

  console.log('\n== コンソール ==');
  check('エラーが1件も出ていない', problems.length === 0, problems.join(' | '));

  /* ---------------- 携帯 ---------------- */

  console.log('\n== 携帯（縦持ち・指で操作） ==');
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const mp = await phone.newPage();
  const mobileProblems = [];
  mp.on('pageerror', (e) => mobileProblems.push(`PAGEERROR ${e.message}`));
  mp.on('console', (m) => {
    if (m.type() === 'error') mobileProblems.push(`CONSOLE ${m.text()}`);
  });

  await mp.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  await mp.uncheck('#opt-autoplot'); // 指で置く手応えを見る回なので書記は下がらせる
  await mp.click('#btn-start');
  await mp.waitForTimeout(900);

  check('下部タブが出る', await mp.isVisible('#tabbar'));
  check('横に溢れていない', await mp.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1));

  const mapBox = await (await mp.$('#map')).boundingBox();
  check('地図が画面の大半を占める', mapBox.height > 400, JSON.stringify(mapBox));

  // 指で叩いて記号を置く
  await mp.touchscreen.tap(mapBox.x + mapBox.width * 0.5, mapBox.y + mapBox.height * 0.42);
  await mp.waitForTimeout(250);
  check('指で叩くと記号が置ける',
    (await mp.evaluate(() => window.__brzer.game.belief.markers.length)) === 1);

  // 指で払って図面をずらす
  const beforeCenter = await mp.evaluate(() => window.__brzer.mapView.centerX);
  await mp.touchscreen.tap(mapBox.x + 20, mapBox.y + 20); // 端を叩いて選択解除
  await mp.evaluate(() => window.__brzer.mapView.zoom);
  await mp.click('#zoom-in');
  const zoomed = await mp.evaluate(() => window.__brzer.mapView.zoom);
  check('拡大ボタンが効く', zoomed > 1, `zoom=${zoomed}`);
  await mp.click('#zoom-fit');
  check('全体表示に戻る', (await mp.evaluate(() => window.__brzer.mapView.zoom)) === 1);
  check('中心が図面内に収まっている',
    Math.abs((await mp.evaluate(() => window.__brzer.mapView.centerX)) - beforeCenter) < 4000);

  // タブでパネルを呼び出す
  await mp.click('.tabbar__btn[data-tab="log"]');
  await mp.waitForTimeout(300);
  check('無線タブでシートが開く', await mp.$eval('#side', (e) => e.classList.contains('is-open')));
  check('無線パネルが選ばれている',
    await mp.$eval('.panel--log', (e) => e.classList.contains('is-active')));

  await mp.click('.tabbar__btn[data-tab="order"]');
  await mp.waitForTimeout(250);
  check('命令タブに切り替わる',
    await mp.$eval('.panel--order', (e) => e.classList.contains('is-active')));

  await mp.click('.tabbar__btn[data-tab="map"]');
  await mp.waitForTimeout(300);
  check('地図タブでシートが閉じる', !(await mp.$eval('#side', (e) => e.classList.contains('is-open'))));

  // 部隊の方眼を叩くと、その位置へ跳ぶ。
  // 方眼は「無線で聞いた位置」なので、H時を宣言して交信が始まるまでは出ない。
  await mp.click('#btn-hhour');
  await runClock(mp, 30);
  // 部隊タブを開くまでは見えない場所にあるので、あることだけ確かめる
  await mp.waitForSelector('#roster button.roster__grid', { state: 'attached', timeout: 60000 });
  await mp.evaluate(() => { window.__brzer.game.running = false; });
  await mp.click('.tabbar__btn[data-tab="roster"]');
  await mp.waitForTimeout(300);
  // 部隊一覧は毎フレーム描き直されるので、要素を掴まずセレクタで押す
  const hasGrid = (await mp.$$('#roster button.roster__grid')).length > 0;
  if (hasGrid) {
    const beforeZoom = await mp.evaluate(() => window.__brzer.mapView.zoom);
    await mp.click('#roster button.roster__grid', { timeout: 5000 });
    await mp.waitForTimeout(300);
    check('部隊の方眼を叩くとその位置へ跳ぶ',
      !(await mp.$eval('#side', (e) => e.classList.contains('is-open'))) &&
      (await mp.evaluate(() => window.__brzer.mapView.zoom)) >= beforeZoom);
  } else {
    check('部隊の方眼を叩くとその位置へ跳ぶ', false, '方眼の札が出ていない');
  }

  // つまみを下へ払うとシートが閉じる
  await mp.click('.tabbar__btn[data-tab="log"]');
  await mp.waitForSelector('#side.is-open', { timeout: 5000 });
  await mp.waitForTimeout(450); // 上がりきるまで待つ
  const handle = await mp.$eval('#sheet-handle', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await mp.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await mp.mouse.down();
  await mp.mouse.move(handle.x + handle.width / 2, handle.y + 260, { steps: 10 });
  await mp.mouse.up();
  await mp.waitForTimeout(350);
  check('つまみを下へ払うと閉じる', !(await mp.$eval('#side', (e) => e.classList.contains('is-open'))));

  check('視程が表示されている', (await mp.textContent('#visibility')).length > 0);
  // 砲弾と発煙は残弾管理の要。携帯でも必ず見えていること。
  check('砲弾の残数が見えている', await mp.isVisible('#ammo-he'));
  check('発煙の残数が見えている', await mp.isVisible('#ammo-smoke'));
  const topbarFits = await mp.evaluate(() => {
    const bar = document.querySelector('.topbar');
    return [...bar.children].every((c) => c.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1);
  });
  check('上部帯が見切れていない', topbarFits);

  await mp.screenshot({ path: `${SHOTS}/04-phone.png` });
  check('携帯でもエラーが出ていない', mobileProblems.length === 0, mobileProblems.join(' | '));

  await phone.close();

  /* ---------------------------------------------------------------- */
  /* 画面寸法を変えても、はみ出しと重なりが起きないこと                    */
  /* ---------------------------------------------------------------- */
  section('版面の検査（各画面寸法）');
  await auditLayouts();

  section('長期戦');
  await checkLongBattle();

  section('図幅とミッション');
  await checkMissions();

  section('記号を貼る手数');
  await checkQuickMarking();

  section('自動記入');
  await checkAutoPlot();

  section('H時前の作戦命令');
  await checkPlanning();

  section('戦役');
  await checkCampaign();

  section('国政');
  await checkNation();

  section('演習モード');
  await checkCreative();
} finally {
  await browser.close();
}

console.log(`\n${checks - failures}/${checks} 件成功`);
if (failures > 0) {
  console.error(`${failures} 件失敗`);
  process.exit(1);
}
console.log('ブラウザ通し検査に合格しました。');
