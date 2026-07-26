// 上部のステータス帯。時計・速度・無線の混み具合・支援弾数。

import {
  getClock, getSimTime, getRadioStatus, getSupport, getMission, getVisibility, getTrains,
} from '../state.js';
import { parseClock } from '../util.js';

// 時間帯ごとの一言。指揮官の「今どういう局面か」の感覚を補う。
// 局面の名は各ミッションが持つ。持っていなければ時間で機械的に割る。
function phasesOf(mission) {
  if (mission.phases) return mission.phases;
  const span = mission.endTime - mission.startTime;
  return [
    { at: mission.startTime, label: '静穏' },
    { at: mission.startTime + span * 0.15, label: '警戒' },
    { at: mission.startTime + span * 0.4, label: '交戦中' },
    { at: mission.startTime + span * 0.85, label: '最終局面' },
  ];
}

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

  const phases = phasesOf(getMission(game));
  let phase = phases[0].label;
  for (const p of phases) {
    const at = typeof p.at === 'string' ? parseClock(p.at) : p.at;
    if (now >= at) phase = p.label;
  }
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

  // 弾数。演習では数えても意味がないので、そう表示する。
  dom.he.textContent = support.unlimited ? '∞' : support.artillery;
  dom.smoke.textContent = support.unlimited ? '∞' : support.smoke;
  if (dom.illum) dom.illum.textContent = support.unlimited ? '∞' : support.illum;
  if (dom.heItem) {
    // 砲が陣地変換中なら、要請しても通らない。先に分かっていたほうがよい。
    const note = !support.gunAlive
      ? '砲兵は沈黙している'
      : support.layingIn > 0
        ? `陣地変換中 ─ あと約${support.layingIn}秒で撃てる`
        : `射程 ${Math.round(support.gunRange / 100) * 100}m`;
    dom.heItem.classList.toggle('is-cold', !support.gunAlive || support.layingIn > 0);
    dom.heItem.title = note;
  }

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
