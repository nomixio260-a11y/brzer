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
  await p.evaluate(() => { window.__brzer.game.speed = 30; window.__brzer.game.running = true; });
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
  await p.evaluate(() => { window.__brzer.game.speed = 30; window.__brzer.game.running = true; });
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
  await p.evaluate(() => { window.__brzer.game.speed = 30; window.__brzer.game.running = true; });
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
  await p.evaluate(() => { window.__brzer.game.speed = 30; window.__brzer.game.running = true; });
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
  await page.evaluate(() => {
    window.__brzer.game.speed = 30;
    window.__brzer.game.running = true;
  });
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
  await page.evaluate(() => {
    window.__brzer.game.speed = 45;
    window.__brzer.game.running = true;
  });
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

  // 部隊の方眼を叩くと、その位置へ跳ぶ
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
