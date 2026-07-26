// README 用のスクリーンショットを撮り直す。
//
//   node scripts/screenshots.mjs
//   BRZER_CHROMIUM=/path/to/chrome node scripts/screenshots.mjs
//
// 事前に静的サーバを立てておくこと（npm start）。

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.BRZER_URL ?? 'http://127.0.0.1:8127/index.html';
const OUT = 'docs';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.BRZER_CHROMIUM || undefined,
  args: ['--no-sandbox', '--mute-audio'],
});

// README に載せるだけなので等倍で撮る（2倍で撮ると数MBになる）
const page = await browser.newPage({ viewport: { width: 1500, height: 880 }, deviceScaleFactor: 1 });
await page.goto(`${URL}?debug=1`, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/briefing.png` });

await page.click('#btn-start');
await page.waitForTimeout(500);

// 0808 まで飛ばす ― 陽動が北岸に貼りつき、迂回部隊が動き出している頃
await page.evaluate(() => {
  window.__brzer.game.speed = 40;
});
await page.waitForFunction(() => window.__brzer.game.world.now >= 8 * 3600 + 8 * 60, { timeout: 120000 });
await page.evaluate(() => {
  window.__brzer.game.running = false;
});

// 無線を聞いた指揮官が書き込んだ、という体で記号を置く
const box = await (await page.$('#map')).boundingBox();
const put = async (fx, fy, tool, conf, label) => {
  await page.click(`#marker-tools button[data-marker="${tool}"]`);
  await page.click(`#confidence-tools button[data-conf="${conf}"]`);
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  if (label) await page.fill('#marker-label', label);
  await page.keyboard.press('Escape');
};
await put(0.335, 0.335, 'enemy_inf', 'confirmed', '約9名');
await put(0.378, 0.305, 'enemy_mech', 'estimated', '2両?');
await put(0.63, 0.42, 'unknown', 'unconfirmed', '浅瀬に何か');
await put(0.36, 0.53, 'objective', 'confirmed', '');
await put(0.30, 0.60, 'friendly', 'confirmed', 'ハンマー2');

await page.evaluate(() => {
  window.__brzer.game.running = true;
  window.__brzer.game.speed = 1;
});
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/screenshot.png` });

// 講評まで飛ばす
await page.evaluate(() => {
  window.__brzer.game.speed = 45;
});
await page.waitForSelector('#view-debrief.is-active', { timeout: 240000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/debrief.png`, fullPage: true });

await browser.close();
console.log('docs/briefing.png, docs/screenshot.png, docs/debrief.png を更新しました');
