// sound.jsx — procedural dice-roll SFX via Web Audio.
// playRollSound(n) lays down `n` short noise bursts over a span scaled
// to `n`, so a 20-die round-start sounds like a clatter and a 2-die
// reroll sounds like a click or two.

let _ctx = null;
const _pending = [];   // numDice values queued before audio is unlocked

function _ensureCtx() {
  if (_ctx) return _ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  _ctx = new Ctor();
  return _ctx;
}

async function _unlockOnGesture() {
  const ctx = _ensureCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
  // Drain any queued round-start / show-reroll clatter so the user hears
  // sounds that fired before they had a chance to interact.
  while (_pending.length) _doPlay(_pending.shift());
}

// iOS Safari requires the AudioContext to be created/resumed during a
// user gesture. Hook the first pointerdown anywhere on the page to do
// that — after one tap, sounds play freely.
document.addEventListener('pointerdown', _unlockOnGesture, { once: true });

function _scheduleClick(ctx, when, intensity = 1) {
  // Decaying noise burst, band-pass-filtered around 1.5–3 kHz so it
  // sounds like a small object skipping on a hard surface.
  const dur = 0.04 + Math.random() * 0.06;          // 40–100 ms
  const sampleCount = Math.max(1, Math.ceil(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleCount;
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 7);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1400 + Math.random() * 1800;
  filter.Q.value = 3 + Math.random() * 5;
  const gain = ctx.createGain();
  gain.gain.value = 0.22 * intensity;
  src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  src.start(when);
  src.stop(when + dur);
}

function _doPlay(numDice) {
  const ctx = _ctx;
  if (!ctx || ctx.state !== 'running') return;
  const n = Math.max(1, Math.floor(numDice));
  // Span scales with count, capped so even 20-die rounds finish quickly.
  const span = Math.min(0.25 + n * 0.04, 1.1);
  const now = ctx.currentTime;
  for (let i = 0; i < n; i++) {
    // Bias the schedule earlier: most clicks happen in the first half
    // of the span, then a few stragglers tail off.
    const r = Math.random();
    const t = now + Math.pow(r, 0.7) * span;
    _scheduleClick(ctx, t, 0.6 + Math.random() * 0.4);
  }
}

function playRollSound(numDice) {
  const ctx = _ensureCtx();
  if (!ctx) return;
  if (ctx.state !== 'running') {
    // Pre-gesture (iOS): queue this; the first pointerdown drains it.
    _pending.push(numDice);
    return;
  }
  _doPlay(numDice);
}

Object.assign(window, { playRollSound });
