/*
 * Sonidos del tótem sintetizados con WebAudio (sin archivos de audio).
 *
 *   BowlingSound.roll(velocidad)   ruido de la bola rodando (llamar en cada cuadro; 0 = silencio)
 *   BowlingSound.hit(fuerza)       choque de pinos (0..1)
 *   BowlingSound.result(kind)      'pleno' | 'semipleno' | 'canaleta' | 'cero' | 'pinos'
 *   BowlingSound.beep(final)       pitido de la cuenta regresiva (final = el último, más agudo)
 *   BowlingSound.fanfare()         festejo de los resultados
 *   BowlingSound.toggleMute()      tecla M
 *
 * El navegador solo deja sonar después de un toque o tecla, salvo que Chromium arranque con
 * --autoplay-policy=no-user-gesture-required (así lo abre iniciar.sh / iniciar.bat).
 */
(function (root) {
  'use strict';

  const KEY_MUTE = 'bowling.silencio';
  let ctx = null, master = null, rollGain = null, rollFilter = null, noiseBuf = null;
  let muted = false;
  let lastHit = 0, hitsInWindow = 0, lastRoll = -1;

  try { muted = localStorage.getItem(KEY_MUTE) === '1'; } catch (e) { /* sin storage */ }

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx.state === 'running';
    }
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    master.connect(comp);

    // ruido blanco reutilizable
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // rodar: ruido grave en loop con volumen según la velocidad
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    rollFilter = ctx.createBiquadFilter();
    rollFilter.type = 'lowpass';
    rollFilter.frequency.value = 220;
    rollFilter.Q.value = 0.7;
    rollGain = ctx.createGain();
    rollGain.gain.value = 0;
    src.connect(rollFilter).connect(rollGain).connect(master);
    src.start();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx.state === 'running';
  }

  // el primer toque o tecla habilita el audio si el navegador lo bloqueó
  ['keydown', 'pointerdown'].forEach((ev) => root.addEventListener(ev, () => ensure(), { passive: true }));

  function noise(t, dur, freq, q, vol, type) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type || 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  function tone(t, freq, dur, vol, type, slideTo) {
    const o = ctx.createOscillator();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  const api = {
    get muted() { return muted; },

    toggleMute() {
      muted = !muted;
      try { localStorage.setItem(KEY_MUTE, muted ? '1' : '0'); } catch (e) { /* sin storage */ }
      ensure();
      // aunque el audio esté suspendido (sin gesto todavía), el volumen queda en lo que se eligió
      if (master) { master.gain.cancelScheduledValues(0); master.gain.value = muted ? 0 : 0.8; }
      return muted;
    },

    /** velocidad de la bola en px por paso (0 = quieta o sin bola) */
    roll(speed) {
      if (!ctx || ctx.state !== 'running') return;
      const v = Math.max(0, Math.min(1, (Number(speed) || 0) / 18));
      // se llama en cada cuadro: solo se programa un cambio si el valor se movió de verdad
      if (Math.abs(v - lastRoll) < 0.01) return;
      lastRoll = v;
      rollGain.gain.setTargetAtTime(v * 0.55, ctx.currentTime, 0.06);
      rollFilter.frequency.setTargetAtTime(140 + v * 260, ctx.currentTime, 0.1);
    },

    hit(strength) {
      if (!ensure()) return;
      const now = ctx.currentTime;
      // como mucho ~10 choques cada 100 ms, si no satura
      if (now - lastHit > 0.1) { lastHit = now; hitsInWindow = 0; }
      if (++hitsInWindow > 10) return;
      const s = Math.max(0.1, Math.min(1, Number(strength) || 0));
      noise(now, 0.08 + s * 0.1, 1800 + Math.random() * 1600, 1.2, 0.25 + s * 0.6);
      tone(now, 700 + Math.random() * 500, 0.09, 0.12 + s * 0.25, 'triangle', 300);
      if (s > 0.6) noise(now, 0.25, 180, 0.8, s * 0.5, 'lowpass'); // golpe grave
    },

    result(kind) {
      if (!ensure()) return;
      const t = ctx.currentTime + 0.05;
      if (kind === 'pleno') {
        [523, 659, 784, 1047, 1319].forEach((f, i) => tone(t + i * 0.09, f, 0.35, 0.22, 'square'));
        tone(t + 0.45, 1568, 0.6, 0.18, 'triangle');
        noise(t + 0.1, 1.2, 2500, 0.4, 0.12); // "aplausos"
      } else if (kind === 'semipleno') {
        [587, 740, 880].forEach((f, i) => tone(t + i * 0.1, f, 0.3, 0.2, 'square'));
      } else if (kind === 'canaleta') {
        tone(t, 330, 0.6, 0.18, 'sawtooth', 110);
      } else if (kind === 'cero') {
        tone(t, 220, 0.35, 0.15, 'triangle', 160);
      } else {
        tone(t, 660, 0.12, 0.12, 'triangle');
      }
    },

    beep(final) {
      if (!ensure()) return;
      tone(ctx.currentTime, final ? 1320 : 880, final ? 0.35 : 0.15, 0.2, 'square');
    },

    fanfare() {
      if (!ensure()) return;
      const t = ctx.currentTime + 0.05;
      [[523, 0], [523, 0.12], [523, 0.24], [659, 0.36], [784, 0.6], [659, 0.78], [784, 0.9], [1047, 1.1]]
        .forEach(([f, dt]) => tone(t + dt, f, dt === 1.1 ? 0.7 : 0.18, 0.18, 'square'));
    },
  };

  root.BowlingSound = api;
})(typeof self !== 'undefined' ? self : this);
