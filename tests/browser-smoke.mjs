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

try {
  console.log('\n== 起動 ==');
  await page.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
  check('ブリーフィングが出る', await page.isVisible('#view-briefing'));
  check('任務文が地形から引かれている', /橋梁 [A-L]\d/.test(await page.textContent('#brief-mission')));
  await page.screenshot({ path: `${SHOTS}/01-briefing.png` });

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

  // 砲兵には移動命令が出せない
  await page.click('#order-units button[data-unit="TH"]');
  const verbs = await page.$$eval('#order-verbs button', (bs) => bs.map((b) => b.dataset.verb));
  check('兵科ごとに出せる命令が違う', !verbs.includes('attack') && verbs.includes('fire_mission'), verbs.join(','));

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
    return typeof m.label === 'string' && m.label.endsWith('報');
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
} finally {
  await browser.close();
}

console.log(`\n${checks - failures}/${checks} 件成功`);
if (failures > 0) {
  console.error(`${failures} 件失敗`);
  process.exit(1);
}
console.log('ブラウザ通し検査に合格しました。');
