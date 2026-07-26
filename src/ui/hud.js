// 上部のステータス帯。時計・速度・無線の混み具合・支援弾数。

import {
  getClock, getSimTime, getRadioStatus, getSupport, getMission, getVisibility, getTrains,
} from '../state.js';
import { parseClock } from '../util.js';

// 時間帯ごとの一言。指揮官の「今どういう局面か」の感覚を補う。
const PHASES = {
  bridge_hold: [
    { at: '0700', label: '静穏' },
    { at: '0712', label: '警戒' },
    { at: '0738', label: '接敵' },
    { at: '0800', label: '交戦中' },
    { at: '0845', label: '最終局面' },
  ],
  // 長期戦は「波」で数える。静穏は次の攻撃の準備時間である。
  bridge_hold_long: [
    { at: '0430', label: '夜間・警戒' },
    { at: '0505', label: '斥候接触' },
    { at: '0540', label: '第一波' },
    { at: '0645', label: '静穏 ─ 再編' },
    { at: '0800', label: '第二波' },
    { at: '0905', label: '静穏 ─ 再編' },
    { at: '0950', label: '第三波' },
    { at: '1020', label: '最終局面' },
  ],
};

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

  const phases = PHASES[getMission(game).id] ?? PHASES.bridge_hold;
  let phase = phases[0].label;
  for (const p of phases) if (now >= parseClock(p.at)) phase = p.label;
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

  // 段列。長期戦では、これが尽きた時点で「あとは撃つだけ」になる。
  const trains = getTrains(game);
  if (dom.trains && dom.trainsItem) {
    dom.trainsItem.hidden = !trains;
    if (trains) {
      const label = trains.alive ? `${trains.loadsLeft}` : '✕';
      if (dom.trains.textContent !== label) dom.trains.textContent = label;
      dom.trains.classList.toggle('is-low', trains.alive && trains.loadsLeft <= 1);
      dom.trains.classList.toggle('is-gone', !trains.alive);
      dom.trainsItem.title = trains.alive
        ? `弾薬 ${trains.loadsLeft}/${trains.loads} 基数${trains.busyWith ? ` ・${trains.busyWith}へ運搬中` : ''}`
        : '補給班は失われた';
    }
  }

  // 視程。霧が晴れるまでは、見えていないことを前提に考えねばならない。
  const vis = getVisibility(game);
  if (dom.vis && hud._visLevel !== vis.level) {
    hud._visLevel = vis.level;
    dom.vis.textContent = vis.label;
    dom.vis.className = `vis vis--${vis.level}`;
    dom.vis.title = vis.note || `視程 ${vis.label}`;
  }

  if (!dom.objective.textContent) {
    dom.objective.textContent = getMission(game).objectives.find((o) => o.primary).text;
  }
}
