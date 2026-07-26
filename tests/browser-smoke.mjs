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
} finally {
  await browser.close();
}

console.log(`\n${checks - failures}/${checks} 件成功`);
if (failures > 0) {
  console.error(`${failures} 件失敗`);
  process.exit(1);
}
console.log('ブラウザ通し検査に合格しました。');
