// 上部のステータス帯。時計・速度・無線の混み具合・支援弾数。

import { getClock, getSimTime, getRadioStatus, getSupport, getMission } from '../state.js';
import { parseClock } from '../util.js';

// 時間帯ごとの一言。指揮官の「今どういう局面か」の感覚を補う。
const PHASES = [
  { at: '0700', label: '静穏' },
  { at: '0712', label: '警戒' },
  { at: '0738', label: '接敵' },
  { at: '0800', label: '交戦中' },
  { at: '0845', label: '最終局面' },
];

export function createHud(dom, game, hooks) {
  const hud = { dom, game, hooks, _sig: '' };

  dom.speed.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (!b) return;
    hooks.onSpeed(Number(b.dataset.speed));
  });

  return hud;
}

export function renderHud(hud) {
  const { dom, game } = hud;
  const now = getSimTime(game);
  const radio = getRadioStatus(game);
  const support = getSupport(game);

  dom.clock.textContent = getClock(game);

  let phase = PHASES[0].label;
  for (const p of PHASES) if (now >= parseClock(p.at)) phase = p.label;
  dom.phase.textContent = phase;

  // 速度ボタン
  const active = game.running ? game.speed : 0;
  for (const b of dom.speed.querySelectorAll('button')) {
    b.classList.toggle('is-on', Number(b.dataset.speed) === active);
  }

  // 無線
  dom.net.textContent = radio.speaking ? `${radio.speaking} 送信中` : '空き';
  dom.net.classList.toggle('is-busy', !!radio.speaking);
  dom.queue.textContent = radio.queued > 0 ? `待ち ${radio.queued}` : '';
  dom.jam.hidden = radio.jamming < 0.15;

  dom.he.textContent = support.artillery;
  dom.smoke.textContent = support.smoke;

  if (!dom.objective.textContent) {
    dom.objective.textContent = getMission(game).objectives.find((o) => o.primary).text;
  }
}
