// 音。すべて WebAudio で合成する（音声ファイルを持たない＝リポジトリが自己完結する）。
// 無線のスキュルチ、接敵の警報、遠くの着弾音。それに日本語の読み上げ。

let ctx = null;
let master = null;
let enabled = true;
let voiceEnabled = true;
let voiceWanted = true;
let jaVoice = null;

export function initAudio() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    enabled = false;
    return;
  }
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  pickVoice();
  if (window.speechSynthesis) {
    window.speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
  }
}

function pickVoice() {
  if (!window.speechSynthesis) {
    voiceEnabled = false;
    return;
  }
  const voices = window.speechSynthesis.getVoices();
  jaVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ja')) ?? null;
  // 日本語の音声が無い環境では読み上げは黙らせる（英語で読まれると台無しなので）
  voiceEnabled = !!jaVoice;
}

export function setEnabled(v) {
  enabled = v;
  if (!v && window.speechSynthesis) window.speechSynthesis.cancel();
  if (ctx && v && ctx.state === 'suspended') ctx.resume();
}

export function isEnabled() {
  return enabled;
}

/** 読み上げだけを切る（効果音は残す） */
export function setVoiceEnabled(v) {
  voiceWanted = v;
  if (!v && window.speechSynthesis) window.speechSynthesis.cancel();
}

export function resume() {
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

/* ------------------------------------------------------------------ */
/* 基本の音づくり                                                       */
/* ------------------------------------------------------------------ */

function noiseBuffer(duration) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** 無線のスキュルチ（送信開始・終了のノイズ） */
export function squelch(pitch = 1, level = 0.16) {
  if (!enabled || !ctx) return;
  const dur = 0.09;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur);

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1400 * pitch;
  bp.Q.value = 1.1;

  const g = ctx.createGain();
  g.gain.setValueAtTime(level, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);

  src.connect(bp).connect(g).connect(master);
  src.start();
  src.stop(ctx.currentTime + dur);
}

/** 接敵報告の警報音 */
export function alertTone() {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime;
  for (const [i, f] of [880, 1180].entries()) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.1);
    g.gain.linearRampToValueAtTime(0.06, t + i * 0.1 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, t + i * 0.1 + 0.09);
    o.connect(g).connect(master);
    o.start(t + i * 0.1);
    o.stop(t + i * 0.1 + 0.1);
  }
}

/** 遠くの着弾／砲声 */
export function distantBoom(level = 0.3) {
  if (!enabled || !ctx) return;
  const dur = 0.85;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(320, ctx.currentTime);
  lp.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + dur);

  const g = ctx.createGain();
  g.gain.setValueAtTime(level, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);

  src.connect(lp).connect(g).connect(master);
  src.start();
  src.stop(ctx.currentTime + dur);
}

/** ボタンのクリック */
export function click() {
  if (!enabled || !ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'triangle';
  o.frequency.value = 620;
  g.gain.setValueAtTime(0.05, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.05);
  o.connect(g).connect(master);
  o.start();
  o.stop(ctx.currentTime + 0.06);
}

/* ------------------------------------------------------------------ */
/* 読み上げ                                                            */
/* ------------------------------------------------------------------ */

/**
 * 無線の声。読み上げ待ちが溜まると邪魔なので、重要なものだけに絞る。
 */
export function speak(text, { priority = 0 } = {}) {
  if (!enabled || !voiceWanted || !voiceEnabled || !window.speechSynthesis) return;
  if (priority < 2 && window.speechSynthesis.pending) return;
  if (window.speechSynthesis.speaking && priority >= 2) window.speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text.replace(/……/g, '、'));
  u.voice = jaVoice;
  u.lang = 'ja-JP';
  u.rate = 1.25;
  u.pitch = 0.85;
  u.volume = 0.85;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}
