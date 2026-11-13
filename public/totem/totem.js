/*
 * Pantalla del tótem: conecta con el servidor, corre el juego (game.js) y lo dibuja a mano
 * en un lienzo lógico de 1080 x 1920.
 *
 * Teclas: Enter empezar · Espacio tiro de prueba · P jugador de prueba · R reiniciar
 *         F pantalla completa · D depuración · M sonido.   URL: /?prueba=3 suma 3 jugadores de prueba.
 */
(function () {
  'use strict';

  const P = window.BowlingPhysics;
  const S = window.BowlingScoring;
  const BG = window.BowlingGame;
  const Sound = window.BowlingSound;
  const L = P.LANE;
  const W = 1080, H = 1920;
  const HEADER_H = 200;
  const BOARD_Y = 1520; // empieza la tabla de puntajes
  // Paleta "Institucional Nº4" (azul y celeste del logo de la escuela; la misma que public/shared/tema.css)
  const PAL = {
    noche: '#0B1D30', panel: '#13314F', panel2: '#1A3C5E', azul: '#6272B4', celeste: '#7AB6E6',
    blanco: '#F4F8FB', gris: '#90A7BC', naranja: '#F2A33A', rojo: '#F46C70', rojoFondo: '#C93A3F', linea: 'rgba(122,182,230,0.22)',
  };
  const FONT = '"Barlow", "Segoe UI", Arial, sans-serif';
  const FONT_TIT = '"Barlow Condensed", "Arial Narrow", "Segoe UI", sans-serif';

  // Dos lienzos apilados: #fondo tiene lo que casi no cambia (la pista y, en el lobby, el título
  // y el QR) y solo se redibuja al cambiar de pantalla; #pantalla se borra y redibuja en cada
  // cuadro con lo que se mueve. Redibujar todo en cada cuadro era lo que hacía lento al tótem
  // en compus sin aceleración por placa de video (ver npm run prueba:rendimiento).
  const escena = document.getElementById('escena');
  const canvas = document.getElementById('pantalla');
  const fondo = document.getElementById('fondo');
  let ctx = canvas.getContext('2d'); // se cambia un momento para dibujar en las capas en caché
  const params = new URLSearchParams(location.search);

  let config = { nombreEscuela: 'Bowling', frames: 3, segundosPorTurno: 25, maxJugadores: 6, urlJuego: '' };
  let game = null;
  let socket = null;
  let online = false;
  let debug = false;
  let laneLayer = null;
  let laneVersion = 0; // cambia cuando se vuelve a dibujar la pista (por ejemplo, al cargar el logo)
  const qr = new Image();
  let qrReady = false;
  const logo = new Image();
  let logoReady = false;
  const view = { roll: 0, lastBall: null, fps: 60, frameTimes: [] };
  // leaderboard: tablas del servidor y puestos de la última partida (para resultados)
  const ranking = { tablas: null, ultima: null, ultimaAt: 0 };
  const MEDAL = [PAL.naranja, '#C9D3DD', '#C98A5A']; // 1.º, 2.º y 3.º

  // ---------- Arranque ----------

  async function init() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) config = Object.assign(config, await res.json());
    } catch (e) { /* sin servidor: se usan los valores por defecto */ }

    game = BG.createGame({
      Matter: window.Matter, Physics: P, Scoring: S, config, emit: send, slowMotion: true,
    });
    window.bowlingGame = game; // para la consola y las pruebas con Playwright
    const n = Math.min(Number(params.get('prueba')) || 0, config.maxJugadores);
    for (let i = 0; i < n; i++) game.addTestPlayer();

    await loadFonts();
    laneLayer = renderLaneLayer();
    // logo oficial si la escuela lo puso en public/logo.png; si no, el emblema redibujado
    logo.onload = () => { logoReady = true; laneLayer = renderLaneLayer(); laneVersion++; };
    logo.onerror = () => { if (!/emblema\.svg$/.test(logo.src)) logo.src = '/shared/emblema.svg'; }; // logo.png dañado
    logo.src = config.logo ? '/logo.png' : '/shared/emblema.svg';
    qr.onload = () => { qrReady = true; };
    loadQr();
    connect();
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', onKey);
    let last = performance.now();
    // El próximo cuadro se pide primero: si algo falla en este, el tótem sigue andando
    // (antes un solo error congelaba la pantalla para siempre).
    let lastLoopError = -Infinity;
    requestAnimationFrame(function loop(t) {
      requestAnimationFrame(loop);
      const dt = t - last;
      last = t;
      try {
        measureFps(dt);
        if (!replaced) { // pestaña reemplazada por otro tótem: queda quieta (sin jugar ni sonar)
          game.update(dt);
          updateFx(dt);
          updateDemo(dt);
        }
        draw();
      } catch (err) {
        if (t - lastLoopError > 5000) { lastLoopError = t; console.error('Error en un cuadro del tótem (sigue andando):', err); }
      }
    });
  }

  /** Las capas en caché se dibujan una vez: hay que esperar a que estén las tipografías */
  async function loadFonts() {
    if (!document.fonts) return;
    const faces = ['800 100px "Barlow Condensed"', '700 100px "Barlow Condensed"', '600 100px "Barlow Condensed"',
      '400 40px Barlow', '600 40px Barlow', '700 40px Barlow'];
    try {
      await Promise.race([Promise.all(faces.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 2500))]);
    } catch (e) { /* sin las fuentes se usa la del sistema */ }
  }

  /** Al reconectar se vuelve a pedir la configuración (el servidor pudo reiniciarse con otra) */
  async function refreshConfig() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) return;
      const nueva = await res.json();
      if (nueva.frames !== config.frames || nueva.maxJugadores !== config.maxJugadores ||
          nueva.segundosPorTurno !== config.segundosPorTurno) {
        // cambian las reglas: se recarga la página, pero solo si no hay partida en curso
        if (game.state.phase === 'lobby') location.reload();
        return;
      }
      Object.assign(config, nueva); // nombre, créditos, URL: las capas se rehacen solas (van en sus claves)
    } catch (e) { /* sin servidor: queda la configuración anterior */ }
  }

  function loadQr() { qrReady = false; qr.src = '/qr.png?t=' + Date.now(); }

  // game:over pendiente: si la conexión se corta justo al terminar, se reenvía al reconectar
  // (el servidor guarda cada partidaId una sola vez)
  let pendingOver = null;
  let replaced = false; // otra pestaña tomó el lugar de tótem: esta deja de jugar

  function send(event, data) {
    if (replaced) return;
    if (event === 'game:over') pendingOver = data;
    if (event === 'game:state' && data && data.phase === 'countdown') pendingOver = null; // partida nueva
    if (socket && socket.connected) socket.emit(event, data);
  }

  function connect() {
    if (typeof window.io !== 'function') return;
    socket = window.io();
    socket.on('connect', () => {
      if (replaced) return;
      online = true;
      socket.emit('totem:hello', (r) => {
        // servidor recién reiniciado en medio de una partida: no conoce a nadie, se cancela con aviso
        const ph = game.state.phase;
        if (r && r.nuevo && (ph === 'countdown' || ph === 'playing')) {
          game.reset();
          toast('Se reinició el servidor: la partida se canceló', 4500);
        }
      });
      game.emitState(); // si el tótem se recargó, el servidor vuelve al lobby
      if (pendingOver) socket.emit('game:over', pendingOver);
      loadQr();
      refreshConfig();
    });
    socket.on('disconnect', () => { online = false; });
    socket.on('totem:replaced', () => {
      replaced = true;
      online = false;
      socket.disconnect();
    });
    socket.on('lobby:update', (d) => game.setLobby(d));
    socket.on('game:start', () => game.start());
    socket.on('player:aim', (d) => d && game.aim(d.playerId, d.position));
    socket.on('player:throw', (d) => d && game.throw(d.playerId, d));
    socket.on('leaderboard:update', (d) => {
      if (!d) return;
      ranking.tablas = d;
      if (Array.isArray(d.ultimaPartida) && game.state.phase === 'results') {
        ranking.ultima = d.ultimaPartida;
        ranking.ultimaAt = performance.now();
      }
    });
    socket.on('player:react', (d) => {
      if (!d || !d.emoji) return;
      if (reactions.length > 24) reactions.shift();
      reactions.push({ emoji: d.emoji, name: d.name, color: d.color || '#fff', born: performance.now(),
        x: 140 + Math.random() * (W - 280), sway: Math.random() * Math.PI * 2 });
    });
  }

  // ---------- Reacciones flotando ----------

  const reactions = [];
  const REACTION_MS = 2800;

  function drawReactions() {
    const now = performance.now();
    while (reactions.length && now - reactions[0].born > REACTION_MS) reactions.shift();
    reactions.forEach((r) => {
      const t = (now - r.born) / REACTION_MS;               // 0 → 1
      const y = 1450 - t * 900;
      const x = r.x + Math.sin(r.sway + t * 6) * 30;
      const alpha = t < 0.1 ? t / 0.1 : t > 0.75 ? (1 - t) / 0.25 : 1;
      const size = 110 * (t < 0.1 ? 0.5 + 5 * t : 1);
      text(r.emoji, x, y, { size, weight: '400', alpha });
      text(r.name, x, y + 78, { size: 30, weight: '700', color: r.color, alpha, stroke: PAL.noche, strokeWidth: 6, maxWidth: 260 });
    });
  }

  function resize() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    escena.style.width = Math.floor(W * s) + 'px';
    escena.style.height = Math.floor(H * s) + 'px';
    view.scale = Math.floor(H * s) / H;
  }

  /** Dibuja con `fn` sobre otro contexto (las funciones de dibujo usan la variable ctx) */
  function withCtx(g, fn) {
    const prev = ctx;
    ctx = g;
    try { fn(); } finally { ctx = prev; }
  }

  /**
   * Capa en caché: se vuelve a dibujar solo cuando cambia `key`; en cada cuadro se copia
   * (un drawImage de una franja, mucho más barato que redibujar textos, bordes y degradados).
   */
  function cachedLayer(store, y0, h, key, render) {
    if (!store.c) { store.c = document.createElement('canvas'); store.c.width = W; store.c.height = h; }
    if (store.key !== key) {
      const g = store.c.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, h);
      g.translate(0, -y0);
      withCtx(g, render);
      store.key = key;
    }
    ctx.drawImage(store.c, 0, y0);
  }

  /** El lienzo de fondo: la pista, y en el lobby además el velo, el título y el QR */
  const fondoState = { key: null };
  const lobbyStatic = { key: null, c: null };
  function updateFondo() {
    const phase = game.state.phase;
    const lobby = phase === 'lobby';
    const countdown = phase === 'countdown';
    const lobbyKey = [qrReady, logoReady, config.urlJuego, config.nombreEscuela].join('|');
    const key = (lobby ? 'lobby|' + lobbyKey + '|' : countdown ? 'cuenta|' : 'juego|') + laneVersion;
    if (fondoState.key === key) return;
    const g = fondo.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.drawImage(laneLayer, 0, 0);
    if (lobby) {
      // la parte fija del lobby tiene brillos caros (QR, título): se dibuja una vez y se guarda,
      // así volver al lobby después de cada partida son solo dos copias de imagen
      if (!lobbyStatic.c) { lobbyStatic.c = document.createElement('canvas'); lobbyStatic.c.width = W; lobbyStatic.c.height = H; }
      if (lobbyStatic.key !== lobbyKey) {
        const lg = lobbyStatic.c.getContext('2d');
        lg.clearRect(0, 0, W, H);
        withCtx(lg, drawLobbyStatic);
        lobbyStatic.key = lobbyKey;
      }
      g.drawImage(lobbyStatic.c, 0, 0);
    }
    if (countdown) { g.fillStyle = 'rgba(5,5,20,0.45)'; g.fillRect(0, HEADER_H, W, BOARD_Y - HEADER_H); }
    fondoState.key = key;
  }

  /** Sacudida: se mueve toda la escena con CSS, así no hay que redibujar nada */
  function applyShake() {
    if (!fx.shake) {
      if (view.shaking) { escena.style.transform = ''; view.shaking = false; }
      return;
    }
    const k = fx.shake * (view.scale || 1);
    escena.style.transform = 'translate(' + ((Math.random() * 2 - 1) * k).toFixed(1) + 'px,' + ((Math.random() * 2 - 1) * k).toFixed(1) + 'px)';
    view.shaking = true;
  }

  function onKey(e) {
    const k = e.key.toLowerCase();
    if (e.key === 'Enter') game.start();
    else if (e.key === ' ') { e.preventDefault(); game.testThrow(); }
    else if (k === 'p') game.addTestPlayer();
    else if (k === 'r') {
      if (game.state.phase === 'lobby') game.clearTestPlayers(); else game.reset();
    } else if (k === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    } else if (k === 'd') {
      debug = !debug;
      document.body.classList.toggle('debug', debug);
    } else if (k === 'm') {
      toast(Sound.toggleMute() ? 'Sonido apagado (M)' : 'Sonido prendido (M)');
    }
  }

  function measureFps(dt) {
    view.frameTimes.push(dt);
    if (view.frameTimes.length > 30) view.frameTimes.shift();
    const avg = view.frameTimes.reduce((a, b) => a + b, 0) / view.frameTimes.length;
    view.fps = avg > 0 ? 1000 / avg : 60;
  }

  // ---------- Utilidades de dibujo ----------

  function text(str, x, y, o) {
    o = o || {};
    ctx.save();
    ctx.font = (o.weight || '700') + ' ' + (o.size || 40) + 'px ' + (o.cond ? FONT_TIT : FONT);
    if (o.ls) ctx.letterSpacing = o.ls + 'px';
    ctx.textAlign = o.align || 'center';
    ctx.textBaseline = o.baseline || 'middle';
    ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
    if (o.stroke) {
      ctx.lineWidth = o.strokeWidth || 8;
      ctx.strokeStyle = o.stroke;
      ctx.lineJoin = 'round';
      ctx.strokeText(str, x, y, o.maxWidth);
    }
    ctx.fillStyle = o.color || '#fff';
    ctx.fillText(str, x, y, o.maxWidth);
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else c.rect(x, y, w, h);
  }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
    return 'rgb(' + ch(n >> 16) + ',' + ch((n >> 8) & 255) + ',' + ch(n & 255) + ')';
  }

  // ---------- Pista (se dibuja una sola vez en una capa aparte) ----------

  function renderLaneLayer() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');

    // fondo azul noche liso
    g.fillStyle = PAL.noche;
    g.fillRect(0, 0, W, H);
    // líneas finas a los costados de la pista
    g.fillStyle = 'rgba(143,211,234,0.45)';
    [L.left - L.gutter - 16, L.right + L.gutter + 14].forEach((x) => g.fillRect(x, L.top - 160, 2, BOARD_Y - 20 - (L.top - 160)));

    // foso
    const pitTop = L.top - 180;
    g.fillStyle = '#06111D';
    g.fillRect(L.left - L.gutter, pitTop, L.width + 2 * L.gutter, L.top - pitTop);

    // canaletas: dos tonos planos (el centro más claro da la forma de canal)
    [L.left - L.gutter, L.right].forEach((x) => {
      g.fillStyle = '#22374C';
      g.fillRect(x, L.top, L.gutter, BOARD_Y - L.top);
      g.fillStyle = '#2C4560';
      g.fillRect(x + L.gutter * 0.25, L.top, L.gutter * 0.5, BOARD_Y - L.top);
    });

    // madera con tablas
    const boards = 39;
    const bw = L.width / boards;
    for (let i = 0; i < boards; i++) {
      const tone = 0.9 + 0.1 * Math.sin(i * 2.7) + (i % 2 ? 0.03 : 0);
      g.fillStyle = 'rgb(' + Math.round(226 * tone) + ',' + Math.round(180 * tone) + ',' + Math.round(118 * tone) + ')';
      g.fillRect(L.left + i * bw, L.top, bw + 0.5, BOARD_Y - L.top);
    }
    // brillo del barniz y zona de pinos más clara
    const gloss = g.createLinearGradient(L.left, 0, L.right, 0);
    gloss.addColorStop(0, 'rgba(255,255,255,0)');
    gloss.addColorStop(0.5, 'rgba(255,255,255,0.14)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gloss;
    g.fillRect(L.left, L.top, L.width, BOARD_Y - L.top);
    g.fillStyle = 'rgba(255,240,210,0.18)';
    g.fillRect(L.left, L.top, L.width, L.headPinY + 60 - L.top);
    g.strokeStyle = 'rgba(90,50,20,0.25)';
    g.lineWidth = 1;
    for (let i = 1; i < boards; i++) {
      const x = Math.round(L.left + i * bw) + 0.5;
      g.beginPath(); g.moveTo(x, L.top); g.lineTo(x, BOARD_Y); g.stroke();
    }
    // sombra interna en los bordes de la madera
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(L.left, L.top, 4, BOARD_Y - L.top);
    g.fillRect(L.right - 4, L.top, 4, BOARD_Y - L.top);

    // flechas guía (forman una V hacia los pinos) en las tablas 5, 10, 15, 20, 25, 30 y 35
    g.fillStyle = '#5a2d12';
    [5, 10, 15, 20, 25, 30, 35].forEach((b, i) => {
      const x = L.left + (b - 0.5) * bw;
      const y = 1110 + Math.abs(i - 3) * 26;
      g.beginPath();
      g.moveTo(x, y - 26); g.lineTo(x + 9, y + 10); g.lineTo(x - 9, y + 10);
      g.closePath(); g.fill();
    });
    // puntos guía
    [3, 5, 8, 11, 14, 25, 28, 31, 34, 36].forEach((b) => {
      g.beginPath(); g.arc(L.left + (b - 0.5) * bw, 1330, 4.5, 0, Math.PI * 2); g.fill();
    });
    // puntos de los pinos (dónde va cada uno)
    g.fillStyle = 'rgba(90,50,20,0.35)';
    P.pinLayout().forEach((p) => { g.beginPath(); g.arc(p.x, p.y, 6, 0, Math.PI * 2); g.fill(); });

    // logo de la escuela semitransparente sobre la pista (public/logo.png) o, si no hay, el nombre
    g.save();
    if (logoReady) {
      const s = Math.min(340 / logo.naturalWidth, 300 / logo.naturalHeight);
      const w = logo.naturalWidth * s, h = logo.naturalHeight * s;
      g.globalAlpha = 0.14;
      g.drawImage(logo, L.centerX - w / 2, 930 - h / 2, w, h);
    } else {
      g.translate(L.centerX, 930);
      g.font = '800 46px ' + FONT;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(90,40,10,0.16)';
      g.fillText(config.nombreEscuela, 0, 0, L.width - 40);
    }
    g.restore();

    // línea de foul y zona de salida
    g.fillStyle = PAL.rojoFondo;
    g.fillRect(L.left - L.gutter, L.foul - 3, L.width + 2 * L.gutter, 6);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(L.left, L.foul + 3, L.width, BOARD_Y - L.foul - 3);
    return c;
  }

  // ---------- Pinos y bola ----------

  function drawPins(lane, alpha) {
    const A = alpha == null ? 1 : alpha;
    const knocked = new Set(P.knockedPins(lane));
    lane.pins.forEach((pin) => {
      const { x, y } = pin.position;
      const inPit = y < L.top - 10;
      if (knocked.has(pin)) {
        // pino acostado, mirando hacia donde lo empujaron
        const dx = x - pin.home.x, dy = y - pin.home.y;
        const ang = Math.atan2(dy, dx) + (pin.pinNum % 2 ? 0.3 : -0.3);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.globalAlpha = A * (inPit ? 0.35 : 0.95);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        roundRect(ctx, -24, -7, 54, 22, 11); ctx.fill();
        ctx.fillStyle = '#eceae4';
        roundRect(ctx, -28, -11, 54, 22, 11); ctx.fill();
        ctx.fillStyle = '#d0103a';
        ctx.fillRect(4, -11, 5, 22);
        ctx.fillRect(12, -11, 3, 22);
        ctx.restore();
        return;
      }
      ctx.save();
      ctx.globalAlpha = A;
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.beginPath(); ctx.ellipse(x + 5, y + 7, L.pinRadius + 2, L.pinRadius, 0, 0, Math.PI * 2); ctx.fill();
      const gr = ctx.createRadialGradient(x - 6, y - 7, 2, x, y, L.pinRadius);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.7, '#f1efea');
      gr.addColorStop(1, '#c9c5bc');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(x, y, L.pinRadius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#d0103a';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x - 1, y - 1, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
  }

  function drawBall(x, y, color, roll, alpha) {
    const r = L.ballRadius;
    const A = alpha == null ? 1 : alpha;
    ctx.save();
    ctx.globalAlpha = A;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(x + 7, y + 10, r + 2, r - 2, 0, 0, Math.PI * 2); ctx.fill();
    const gr = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    gr.addColorStop(0, shade(color, 0.55));
    gr.addColorStop(0.45, color);
    gr.addColorStop(1, shade(color, -0.55));
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    // agujeros para los dedos: giran con la distancia recorrida
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
    ctx.translate(x, y);
    ctx.rotate(roll * 0.15);
    const off = ((roll * 0.6) % (2 * r * 1.6)) - r * 1.6; // los agujeros pasan de abajo hacia arriba
    ctx.fillStyle = 'rgba(10,10,20,0.75)';
    [[-8, 0], [8, 0], [0, 17]].forEach(([hx, hy]) => {
      ctx.beginPath(); ctx.arc(hx, -off + hy, hy ? 6 : 5, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
    // brillo
    ctx.save();
    ctx.globalAlpha = A;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.38, y - r * 0.45, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function aimX(position) {
    return L.centerX + position * (L.width / 2 - L.ballRadius - 6);
  }

  function drawLaneContents() {
    const g = game.state;
    drawPins(g.lane);
    const p = game.currentPlayer();
    const ball = g.lane.ball;
    if (ball) {
      const pos = ball.position;
      if (view.lastBall) view.roll += Math.hypot(pos.x - view.lastBall.x, pos.y - view.lastBall.y);
      view.lastBall = { x: pos.x, y: pos.y };
      drawBall(pos.x, pos.y, p ? p.color : '#888', view.roll);
    } else {
      view.lastBall = null;
      if (p && g.turn && g.turn.state === 'aiming') {
        const x = aimX(g.turn.aim);
        const pulse = 0.5 + 0.5 * Math.sin(g.clock / 220);
        ctx.save();
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = 0.35 + 0.4 * pulse;
        ctx.lineWidth = 5;
        ctx.setLineDash([14, 14]);
        ctx.beginPath(); ctx.moveTo(x, L.ballStartY - 60); ctx.lineTo(x, L.headPinY + 120); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x, L.ballStartY, L.ballRadius + 10 + pulse * 6, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        drawBall(x, L.ballStartY, p.color, 0);
      }
    }
    if (debug) drawDebug(g);
  }

  function drawDebug(g) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,255,120,0.9)';
    ctx.lineWidth = 2;
    g.lane.pins.forEach((pin) => {
      ctx.beginPath(); ctx.arc(pin.position.x, pin.position.y, P.TUNING.pinHitRadius, 0, Math.PI * 2); ctx.stroke();
      text(String(pin.pinNum), pin.position.x, pin.position.y, { size: 18, color: '#063' });
    });
    const b = g.lane.ball;
    if (b) {
      ctx.beginPath(); ctx.arc(b.position.x, b.position.y, L.ballRadius, 0, Math.PI * 2); ctx.stroke();
      text('v=' + b.speed.toFixed(1), b.position.x + 60, b.position.y, { size: 22, color: '#0f8', align: 'left' });
    }
    ctx.strokeStyle = 'rgba(255,0,200,0.6)';
    ctx.beginPath(); ctx.moveTo(L.left, P.TUNING.spinStartY); ctx.lineTo(L.right, P.TUNING.spinStartY); ctx.stroke();
    ctx.restore();
    text(view.fps.toFixed(0) + ' FPS · ' + g.phase + (g.turn ? ' · ' + g.turn.state : ''), 20, HEADER_H + 30,
      { size: 26, align: 'left', color: '#0f8', stroke: '#000', strokeWidth: 5 });
  }

  // ---------- Encabezado y textos sobre la pista ----------

  /** Encabezado en caché: cambia con el jugador, el tiro, los segundos o la conexión */
  const headerCache = {};
  function drawHeaderCached() {
    const g = game.state;
    const p = game.currentPlayer();
    const t = g.turn;
    const secs = t && t.state === 'aiming' ? Math.max(0, Math.ceil((t.endsAt - g.clock) / 1000)) : -1;
    const key = [g.phase, logoReady, p && p.id, p && p.name, p && p.color, t && t.frameIdx, t && t.throwNo, t && t.state === 'aiming', secs].join('|');
    cachedLayer(headerCache, 0, HEADER_H, key, drawHeader);
  }

  function drawHeader() {
    const g = game.state;
    ctx.fillStyle = PAL.noche;
    ctx.fillRect(0, 0, W, HEADER_H);
    ctx.fillStyle = PAL.azul;
    ctx.fillRect(0, HEADER_H - 4, W, 4);

    // logo chico a la derecha
    const ls = 104, lx = W - 48 - ls, ly = (HEADER_H - 4 - ls) / 2;
    if (logoReady) ctx.drawImage(logo, lx, ly, ls, ls);

    const p = game.currentPlayer();
    if (g.phase === 'countdown') {
      text('LA PARTIDA EMPIEZA', 64, 100, { size: 76, weight: '800', cond: true, align: 'left', ls: 6, color: PAL.blanco });
    } else if (p && g.turn) {
      ctx.fillStyle = p.color;
      ctx.fillRect(48, 34, 14, 128);
      text(p.name, 88, 80, { size: 78, weight: '800', cond: true, align: 'left', maxWidth: lx - 220 - 88, color: PAL.blanco });
      const total = g.players.length > 0 ? config.frames : 0;
      text('FRAME ' + (g.turn.frameIdx + 1) + ' DE ' + total + '  ·  TIRO ' + g.turn.throwNo, 90, 150,
        { size: 32, weight: '700', cond: true, align: 'left', ls: 3, color: PAL.celeste });
      if (g.turn.state === 'aiming') {
        // reloj en recuadro: se pone naranja en los últimos 5 segundos
        const secs = Math.max(0, Math.ceil((g.turn.endsAt - g.clock) / 1000));
        const urgent = secs <= 5;
        const bw = 150, bx = lx - 28 - bw;
        ctx.fillStyle = urgent ? PAL.naranja : PAL.panel;
        roundRect(ctx, bx, 30, bw, 104, 4); ctx.fill();
        text(String(secs), bx + bw / 2, 84, { size: 88, weight: '800', cond: true, color: urgent ? PAL.noche : PAL.blanco });
        text(p.test ? 'ESPACIO PARA TIRAR' : 'DESLIZÁ EN TU CELULAR', bx + bw / 2, 160,
          { size: 22, weight: '700', cond: true, ls: 2, color: PAL.gris });
      }
    }
  }

  /** Cartel rojo arriba si se perdió el servidor (encima de todo, también en resultados) */
  function drawOffline() {
    if (online) return;
    ctx.fillStyle = PAL.rojoFondo;
    ctx.fillRect(W / 2 - 230, 0, 460, 44);
    text('SIN CONEXIÓN CON EL SERVIDOR', W / 2, 23, { size: 26, weight: '700', cond: true, ls: 2, color: PAL.blanco });
  }

  /** Esta pestaña fue reemplazada por otra como tótem */
  function drawReplaced() {
    ctx.fillStyle = PAL.noche;
    ctx.fillRect(0, 0, W, H);
    if (logoReady) ctx.drawImage(logo, W / 2 - 110, 560, 220, 220);
    text('ESTA PANTALLA SE DESCONECTÓ', W / 2, 900, { size: 64, weight: '800', cond: true, ls: 4, color: PAL.blanco, maxWidth: W - 120 });
    text('Otra pantalla se abrió como tótem.', W / 2, 990, { size: 38, weight: '600', color: PAL.gris });
    text('Recargá (F5) para volver a usar esta.', W / 2, 1050, { size: 38, weight: '600', color: PAL.gris });
  }

  function drawOverlays() {
    const g = game.state;
    if (g.phase === 'countdown') {
      const left = g.phaseEndsAt - g.clock;
      const n = Math.max(1, Math.ceil(left / 1000));
      const t = 1 - (left % 1000) / 1000; // 0 → 1 dentro de cada segundo
      // el velo oscuro va en #fondo (updateFondo); el número cae un poco y se desvanece.
      // Sin escalarlo: escalar una imagen tan grande en cada cuadro es caro sin placa de video.
      const drop = Math.round(-60 * (1 - easeOutCubic(Math.min(1, t * 4))));
      text(String(n), W / 2, 860 + drop, { size: 380, weight: '800', cond: true, color: PAL.blanco, alpha: 1 - t * 0.5 });
    }
    if (g.turn && g.turn.state === 'result') drawResultText(g.turn, RESULT_MS - (g.turn.endsAt - g.clock));
    if (g.notice) {
      ctx.fillStyle = PAL.panel;
      ctx.fillRect(140, 1190, W - 280, 90);
      ctx.fillStyle = PAL.naranja;
      ctx.fillRect(140, 1190, 10, 90);
      text(g.notice.text, W / 2 + 5, 1236, { size: 36, weight: '600', color: PAL.blanco, maxWidth: W - 330 });
    }
  }

  const RESULT_MS = 1400; // lo que dura el cartel (T.result en game.js)
  const easeOutBack = (t) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  /**
   * Cartel del resultado: una banda horizontal que se abre desde el centro y el texto entra con
   * un pequeño rebote. Pleno en naranja, semipleno en azul, el resto en el color de los paneles.
   */
  function drawResultText(turn, ms) {
    const styles = {
      pleno: { band: PAL.naranja, color: PAL.noche },
      semipleno: { band: PAL.azul, color: PAL.blanco },
      canaleta: { band: PAL.panel, color: PAL.gris },
      cero: { band: PAL.panel, color: PAL.gris },
      pinos: { band: PAL.panel, color: PAL.blanco },
    };
    const st = styles[turn.kind] || styles.pinos;
    const big = turn.kind === 'pleno' || turn.kind === 'semipleno';
    let label;
    if (turn.kind === 'pleno') label = 'PLENO';
    else if (turn.kind === 'semipleno') label = 'SEMIPLENO';
    else if (turn.kind === 'canaleta') label = 'CANALETA';
    else if (turn.kind === 'cero') label = 'NINGÚN PINO';
    else label = turn.knocked + (turn.knocked === 1 ? ' PINO' : ' PINOS');
    const t = Math.max(0, Math.min(1, ms / RESULT_MS));
    const alpha = t > 0.85 ? (1 - t) / 0.15 : 1;
    const open = easeOutCubic(Math.min(1, ms / 220));
    const pop = easeOutBack(Math.max(0, Math.min(1, (ms - 80) / 280)));
    const bh = big ? 210 : 170;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = st.band;
    const bw = W * open;
    ctx.fillRect((W - bw) / 2, 900 - bh / 2, bw, bh);
    ctx.restore();
    if (pop <= 0) return;
    ctx.save();
    ctx.translate(W / 2, 906);
    ctx.scale(pop, pop);
    text(label, 0, 0, { size: big ? 170 : 130, weight: '800', cond: true, ls: 10, color: st.color, alpha, maxWidth: W - 100 });
    ctx.restore();
  }

  // ---------- Efectos: partículas, sacudida y sonido ----------

  const fx = {
    particles: [],
    shake: 0,
    hitLane: null, hitIdx: 0,     // choques ya procesados de la pista actual
    phase: 'lobby', turnState: null, countN: 0,
    resultsAt: 0,
    toast: null,
  };
  const MAX_PARTICLES = 320;

  function toast(textStr, ms) { fx.toast = { text: textStr, until: performance.now() + (ms || 1800) }; }

  function spawn(n, make) {
    for (let i = 0; i < n && fx.particles.length < MAX_PARTICLES; i++) fx.particles.push(make(i));
  }

  function burstHit(h) {
    const n = Math.round(4 + h.strength * 14);
    spawn(n, () => {
      const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 7 * (0.4 + h.strength);
      const wood = Math.random() < 0.35;
      return {
        x: h.x, y: h.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 0.025 + Math.random() * 0.03,
        size: wood ? 4 + Math.random() * 4 : 2 + Math.random() * 3, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        color: wood ? '#e2b476' : (Math.random() < 0.5 ? PAL.blanco : PAL.naranja), kind: wood ? 'chip' : 'spark', drag: 0.9,
      };
    });
  }

  function confettiBurst(n) {
    const colors = [PAL.naranja, PAL.azul, PAL.celeste, PAL.blanco];
    spawn(n, (i) => ({
      x: W / 2 + (Math.random() - 0.5) * 300, y: 900, vx: (Math.random() - 0.5) * 26, vy: -8 - Math.random() * 18,
      life: 1, decay: 0.006 + Math.random() * 0.006, size: 8 + Math.random() * 8, rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.5, color: colors[i % colors.length], kind: 'confetti', drag: 0.985, gravity: 0.45,
    }));
  }

  function updateFx(dt) {
    const g = game.state;
    const k = dt / 16.67;

    // choques nuevos de la pista actual → chispas y sonido
    if (fx.hitLane !== g.lane) { fx.hitLane = g.lane; fx.hitIdx = g.lane.hits.length; }
    while (fx.hitIdx < g.lane.hits.length) {
      const h = g.lane.hits[fx.hitIdx++];
      if (h.kind === 'gutter') continue;
      burstHit(h);
      Sound.hit(h.strength);
      if (h.kind === 'ball-pin') fx.shake = Math.max(fx.shake, 4 + h.strength * 8);
    }
    const ball = g.lane.ball;
    Sound.roll(g.turn && g.turn.state === 'rolling' && ball && ball.position.y > P.LANE.top ? ball.speed * g.timeScale : 0);

    // cambios de fase y de turno
    if (g.phase === 'countdown') {
      const n = Math.max(1, Math.ceil((g.phaseEndsAt - g.clock) / 1000));
      if (n !== fx.countN) { fx.countN = n; Sound.beep(false); }
    } else fx.countN = 0;
    if (fx.phase === 'countdown' && g.phase === 'playing') Sound.beep(true);
    if (fx.phase !== 'results' && g.phase === 'results') { fx.resultsAt = performance.now(); Sound.fanfare(); }
    const ts = g.turn ? g.turn.state : null;
    if (fx.turnState === 'rolling' && ts === 'result') {
      Sound.result(g.turn.kind);
      if (g.turn.kind === 'pleno') { fx.shake = 26; confettiBurst(140); }
      else if (g.turn.kind === 'semipleno') { fx.shake = 12; confettiBurst(60); }
    }
    fx.phase = g.phase;
    fx.turnState = ts;

    // mover partículas
    fx.particles = fx.particles.filter((p) => {
      p.vx *= Math.pow(p.drag, k); p.vy *= Math.pow(p.drag, k);
      if (p.gravity) p.vy += p.gravity * k;
      p.x += p.vx * k; p.y += p.vy * k; p.rot += p.vr * k;
      p.life -= p.decay * k;
      return p.life > 0 && p.y < H + 40;
    });
    fx.shake = fx.shake < 0.3 ? 0 : fx.shake * Math.pow(0.88, k);
  }

  function drawParticles() {
    fx.particles.forEach((p) => {
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 1.5);
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.kind === 'spark') {
        ctx.fillRect(-p.size, -p.size / 3, p.size * 2.4, p.size / 1.5);
      } else if (p.kind === 'chip') {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      ctx.restore();
    });
  }

  function drawToast() {
    if (!fx.toast) return;
    const left = fx.toast.until - performance.now();
    if (left <= 0) { fx.toast = null; return; }
    const a = Math.min(1, left / 300);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = PAL.panel;
    ctx.fillRect(W / 2 - 260, 1380, 520, 80);
    ctx.fillStyle = PAL.azul;
    ctx.fillRect(W / 2 - 260, 1380, 8, 80);
    ctx.restore();
    text(fx.toast.text, W / 2 + 4, 1421, { size: 32, weight: '600', color: PAL.blanco, alpha: a });
  }

  // ---------- Demo en el lobby: si no hay nadie, se tiran bolas solas de fondo ----------

  const QR_SIZE = 520, QR_Y = 352;
  const QR_BOX = { x: (W - QR_SIZE) / 2 - 22, y: QR_Y - 22, s: QR_SIZE + 44 }; // tarjeta blanca del QR

  const demo = { lane: null, acc: 0, wait: 0, roll: 0, last: null };

  function newDemoThrow() {
    demo.lane = P.createLane(window.Matter);
    const pinsX = demo.lane.pins.map((p) => p.position.x);
    // tiro directo (sin aimTowards: sus 12 simulaciones trababan el lobby en compus lentas)
    const t = BG.randomThrow(Math.random, pinsX);
    if (t.aim == null) t.aim = (Math.random() - 0.5) * 0.3;
    P.throwBall(demo.lane, t);
    demo.acc = 0; demo.wait = 0; demo.roll = 0; demo.last = null;
  }

  function updateDemo(dt) {
    if (game.state.phase !== 'lobby' || game.roster().length) { demo.lane = null; return; }
    if (!demo.lane) newDemoThrow();
    if (demo.wait > 0) {
      demo.wait -= dt;
      if (demo.wait <= 0) newDemoThrow();
      return;
    }
    demo.acc += Math.min(dt, 100);
    while (demo.acc >= BG.STEP) {
      P.step(demo.lane, BG.STEP);
      demo.acc -= BG.STEP;
      if (P.isSettled(demo.lane)) { demo.wait = 1500; break; }
    }
  }

  /** La demo se dibuja tenue encima del velo del lobby, sin pasar por encima del QR */
  const DEMO_ALPHA = 0.22;
  function drawDemo() {
    if (!demo.lane) return;
    ctx.save();
    const q = QR_BOX;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(q.x - 8, q.y - 8, q.s + 16, q.s + 16);
    ctx.clip('evenodd');
    drawPins(demo.lane, DEMO_ALPHA);
    const b = demo.lane.ball;
    if (b && b.position.y > P.LANE.top - 60) {
      if (demo.last) demo.roll += Math.hypot(b.position.x - demo.last.x, b.position.y - demo.last.y);
      demo.last = { x: b.position.x, y: b.position.y };
      drawBall(b.position.x, b.position.y, PAL.azul, demo.roll, DEMO_ALPHA);
    }
    ctx.restore();
  }

  // ---------- Tabla de puntajes ----------

  /** Tablero en caché: solo cambia cuando alguien tira, se conecta o pasa el turno */
  const boardCache = {};
  function drawScoreboardCached() {
    const g = game.state;
    const cur = game.currentPlayer();
    const key = g.players.map((p) => [p.id, p.name, p.color, p.connected, p.card.rolls.join(',')].join(':')).join('|') +
      '|' + (cur ? cur.id : '') + '|' + config.frames;
    cachedLayer(boardCache, BOARD_Y, H - BOARD_Y, key, drawScoreboard);
  }

  function drawScoreboard() {
    const g = game.state;
    const players = g.players;
    const y0 = BOARD_Y;
    ctx.fillStyle = PAL.noche;
    ctx.fillRect(0, y0, W, H - y0);
    ctx.fillStyle = PAL.azul;
    ctx.fillRect(0, y0, W, 4);

    const pad = 20;
    const nameW = 270, totalW = 150;
    const frames = config.frames;
    const cellW = (W - 2 * pad - nameW - totalW) / frames;
    const headY = y0 + 34;
    const head = { size: 24, weight: '700', cond: true, ls: 3, color: PAL.gris };
    text('JUGADOR', pad + 26, headY, Object.assign({ align: 'left' }, head));
    for (let f = 0; f < frames; f++) text(frames > 5 ? String(f + 1) : 'FRAME ' + (f + 1), pad + nameW + cellW * (f + 0.5), headY, Object.assign({ maxWidth: cellW - 10 }, head));
    text('TOTAL', W - pad - totalW / 2, headY, head);

    const top = y0 + 60;
    const rowH = Math.min(110, (H - top - 14) / Math.max(1, players.length));
    const cur = game.currentPlayer();
    players.forEach((p, i) => {
      const y = top + i * rowH;
      const h = rowH - 8;
      const active = cur && cur.id === p.id;
      ctx.fillStyle = active ? PAL.panel2 : PAL.panel;
      ctx.fillRect(pad, y, W - 2 * pad, h);
      ctx.fillStyle = p.color;
      ctx.fillRect(pad, y, active ? 12 : 8, h);
      if (active) { ctx.strokeStyle = PAL.celeste; ctx.lineWidth = 2; ctx.strokeRect(pad + 1, y + 1, W - 2 * pad - 2, h - 2); }

      const cy = y + h / 2;
      // filas bajas (5 o 6 jugadores): letra mínima legible y el acumulado al costado de las casillas
      const compact = h < 80;
      const fs = Math.max(compact ? 24 : 20, Math.min(40, h * 0.42));
      text(p.name, pad + 30, cy - (p.connected ? 0 : fs * 0.3), {
        size: fs, weight: '700', align: 'left', maxWidth: nameW - 40, color: p.connected ? PAL.blanco : PAL.gris,
      });
      if (!p.connected) text('SIN CONEXIÓN', pad + 30, cy + fs * 0.55, { size: Math.max(15, fs * 0.5), weight: '700', cond: true, ls: 2, align: 'left', color: PAL.rojo });

      const disp = S.display(p.card);
      for (let f = 0; f < frames; f++) {
        const x = pad + nameW + f * cellW;
        ctx.strokeStyle = PAL.linea;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 4, y + 6, cellW - 8, h - 12);
        const d = disp[f];
        const isLastFrame = f === frames - 1;
        const slots = isLastFrame ? 3 : 2;
        const slotW = Math.min(46, (cellW - 16) / (compact ? slots + 1.4 : slots));
        const slotH = compact ? h - 12 : Math.min(44, h * 0.45);
        for (let k = 0; k < slots; k++) {
          const sx = x + cellW - 8 - (slots - k) * slotW;
          ctx.strokeRect(sx, y + 6, slotW, slotH);
          const m = d.marks[k];
          if (m) {
            const col = m === 'X' ? PAL.naranja : m === '/' ? PAL.celeste : PAL.blanco;
            text(m, sx + slotW / 2, y + 7 + slotH / 2, { size: Math.max(20, Math.min(32, slotH * 0.7)), weight: '800', cond: true, color: col });
          }
        }
        if (d.cumulative != null) {
          if (compact) {
            text(String(d.cumulative), x + 16, cy + 1, { size: Math.max(24, Math.min(36, h * 0.6)), weight: '800', cond: true, align: 'left', color: PAL.blanco });
          } else {
            text(String(d.cumulative), x + cellW / 2, y + h * 0.72, { size: Math.min(40, h * 0.4), weight: '800', cond: true, color: PAL.blanco });
          }
        }
      }
      text(String(S.total(p.card)), W - pad - totalW / 2, cy + 2, { size: Math.min(62, h * 0.6), weight: '800', cond: true, color: PAL.blanco });
    });
  }

  // ---------- Lobby ----------

  // La parte fija del lobby (velo, título con brillo y QR) se dibuja una sola vez en #fondo
  // (updateFondo); acá va solo lo que cambia.
  function drawLobby() {
    drawDemo();
    drawLobbyPlayers();
  }

  function drawLobbyStatic() {
    ctx.fillStyle = 'rgba(11,29,48,0.86)';
    ctx.fillRect(0, 0, W, H);

    // encabezado: emblema + nombre de la escuela + BOWLING (banda opaca, sin la pista detrás)
    const ex = 64, ey = 52, es = 168;
    ctx.fillStyle = PAL.noche;
    ctx.fillRect(0, 0, W, ey + es + 38);
    if (logoReady) {
      const k = Math.min(es / logo.naturalWidth, es / logo.naturalHeight);
      ctx.drawImage(logo, ex, ey + (es - logo.naturalHeight * k) / 2, logo.naturalWidth * k, logo.naturalHeight * k);
    }
    const tx = ex + es + 36;
    text(String(config.nombreEscuela || '').toUpperCase(), tx, ey + 34, { size: 32, weight: '600', align: 'left', color: PAL.celeste, ls: 3, maxWidth: W - tx - 60 });
    text('BOWLING', tx - 4, ey + 118, { size: 132, weight: '800', cond: true, align: 'left', color: PAL.blanco, ls: 10 });
    ctx.fillStyle = PAL.azul;
    ctx.fillRect(64, ey + es + 34, W - 128, 4);

    // QR en tarjeta blanca con marco azul
    const qs = QR_SIZE, qx = (W - qs) / 2, qy = QR_Y;
    const b = QR_BOX;
    ctx.fillStyle = PAL.azul;
    roundRect(ctx, b.x - 8, b.y - 8, b.s + 16, b.s + 16, 8); ctx.fill();
    ctx.fillStyle = '#fff';
    roundRect(ctx, b.x, b.y, b.s, b.s, 4); ctx.fill();
    if (qrReady) ctx.drawImage(qr, qx, qy, qs, qs);
    else text('Cargando QR…', W / 2, qy + qs / 2, { size: 36, color: PAL.noche });
    text('Escaneá el código con tu celular para jugar', W / 2, b.y + b.s + 62, { size: 40, weight: '600', color: PAL.blanco });
    if (config.urlJuego) text(config.urlJuego, W / 2, b.y + b.s + 112, { size: 32, weight: '600', color: PAL.celeste });
  }

  /** Título de sección: texto condensado en celeste con una línea a la derecha */
  function sectionTitle(label, x, y, right) {
    ctx.save();
    ctx.font = '700 32px ' + FONT_TIT;
    ctx.letterSpacing = '4px';
    const w = ctx.measureText(label).width;
    ctx.restore();
    text(label, x, y, { size: 32, weight: '700', cond: true, align: 'left', color: PAL.celeste, ls: 4 });
    ctx.fillStyle = PAL.linea;
    ctx.fillRect(x + w + 20, y, (right || W - 64) - (x + w + 20), 2);
  }

  function drawLobbyPlayers() {
    const list = game.roster();
    const spect = game.state.lobbyPlayers.filter((p) => p.spectator).length;
    const by = 1062;
    sectionTitle('JUGADORES ' + list.length + '/' + config.maxJugadores, 64, by);
    if (!list.length) {
      text('Todavía no hay nadie. Escaneá el QR para sumarte.', 64, by + 64, { size: 34, weight: '600', align: 'left', color: PAL.gris });
    }
    list.forEach((p, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const w = (W - 128 - 20) / 2;
      const x = 64 + col * (w + 20);
      const y = by + 34 + row * 80;
      ctx.fillStyle = PAL.panel;
      roundRect(ctx, x, y, w, 66, 4); ctx.fill();
      ctx.fillStyle = p.color;
      ctx.fillRect(x, y, 10, 66);
      const off = p.connected === false;
      const tag = p.host ? 'ANFITRIÓN' : p.test ? 'PRUEBA' : off ? 'SIN CONEXIÓN' : '';
      text(p.name, x + 30, y + 34, { size: 34, weight: '600', align: 'left', maxWidth: w - (tag ? 190 : 50), color: off ? PAL.gris : PAL.blanco });
      if (tag) text(tag, x + w - 18, y + 35, { size: 22, weight: '700', cond: true, align: 'right', ls: 2, color: p.host ? PAL.celeste : PAL.gris });
    });
    if (spect) text(spect + (spect === 1 ? ' espectador' : ' espectadores') + ' para la próxima partida', 64, by + 300, { size: 28, weight: '600', align: 'left', color: PAL.gris });

    // instrucción
    let msg;
    if (!online) msg = { t: 'Sin conexión con el servidor…', c: PAL.rojo };
    else if (!list.length) msg = { t: 'Escaneá el QR, poné tu nombre y a jugar', c: PAL.gris };
    else if (list.some((p) => p.host)) msg = { t: 'El anfitrión empieza la partida desde su celular', c: PAL.naranja };
    else msg = { t: 'Tocá Enter para empezar', c: PAL.naranja };
    text(msg.t, W / 2, 1418, { size: 36, weight: '600', color: msg.c, maxWidth: W - 128 });

    drawRanking();

    // pie: quién hizo el juego (config.json → creditos); los atajos solo en modo depuración (D)
    if (debug) text('Enter empezar · P jugador de prueba · F pantalla completa · M sonido · D depuración', W / 2, 1894, { size: 22, weight: '400', color: PAL.gris });
    else if (config.creditos) text(String(config.creditos).toUpperCase(), W / 2, 1893, { size: 24, weight: '700', cond: true, ls: 4, color: PAL.gris });
  }

  // ---------- Ranking en el lobby ----------

  const TABLAS = [['hoy', 'HOY'], ['semana', 'SEMANA'], ['siempre', 'SIEMPRE']];
  const RANK_BOX = { x: 64, y: 1470, w: W - 128, h: 390 };
  const SLIDE_MS = 600;

  /** Top 10 en dos columnas, rotando entre Hoy, Semana y Siempre con un deslizamiento */
  function drawRanking() {
    const b = RANK_BOX;
    const period = Math.max(2, Number(config.segundosRotacionRanking) || 8) * 1000;
    const now = performance.now();
    const idx = Math.floor(now / period) % TABLAS.length;
    const into = now % period;

    ctx.fillStyle = PAL.panel;
    roundRect(ctx, b.x, b.y, b.w, b.h, 4); ctx.fill();
    ctx.fillStyle = PAL.azul;
    ctx.fillRect(b.x, b.y, b.w, 4);

    // título y pestañas
    const tabY = b.y + 48;
    text('RANKING', b.x + 30, tabY, { size: 38, weight: '800', cond: true, align: 'left', color: PAL.blanco, ls: 4 });
    TABLAS.forEach(([, label], i) => {
      const x = b.x + b.w - 470 + i * 160;
      const on = i === idx;
      text(label, x, tabY, { size: 28, weight: '700', cond: true, ls: 3, color: on ? PAL.blanco : PAL.gris });
      if (on) {
        ctx.fillStyle = PAL.linea;
        ctx.fillRect(x - 60, tabY + 26, 120, 3);
        ctx.fillStyle = PAL.naranja; // barra que avanza hasta la próxima tabla
        ctx.fillRect(x - 60, tabY + 26, 120 * Math.min(1, into / period + 0.02), 3);
      }
    });

    // contenido: la tabla nueva entra desde la derecha y la anterior sale por la izquierda
    ctx.save();
    ctx.beginPath(); ctx.rect(b.x, b.y + 90, b.w, b.h - 94); ctx.clip();
    const t = Math.min(1, into / SLIDE_MS);
    const ease = 1 - Math.pow(1 - t, 3);
    if (t < 1) drawRankingTable(TABLAS[(idx + TABLAS.length - 1) % TABLAS.length][0], -ease * b.w);
    drawRankingTable(TABLAS[idx][0], (1 - ease) * b.w);
    ctx.restore();
  }

  function drawRankingTable(tabla, dx) {
    const b = RANK_BOX;
    const lista = (ranking.tablas && ranking.tablas[tabla]) || [];
    const top = b.y + 126;
    if (!lista.length) {
      const msg = tabla === 'hoy' ? 'Todavía no hay puntajes hoy. El primero queda arriba.' : 'Todavía no hay puntajes.';
      text(msg, W / 2 + dx, top + 110, { size: 32, weight: '600', color: PAL.gris });
      return;
    }
    const gap = 40, colW = (b.w - 60 - gap) / 2, rowH = 52;
    lista.slice(0, 10).forEach((r, i) => {
      const col = i < 5 ? 0 : 1;
      const x = b.x + 30 + col * (colW + gap) + dx;
      const y = top + (i % 5) * rowH;
      if (i % 5) { ctx.fillStyle = PAL.linea; ctx.fillRect(x, y - rowH / 2, colW, 1); }
      if (i < 3) {
        ctx.fillStyle = MEDAL[i];
        ctx.fillRect(x, y - 17, 34, 34);
        text(String(i + 1), x + 17, y + 1, { size: 26, weight: '800', cond: true, color: PAL.noche });
      } else {
        text(String(i + 1), x + 17, y + 1, { size: 26, weight: '700', cond: true, color: PAL.gris });
      }
      text(r.nombre, x + 54, y + 1, { size: 30, weight: '600', align: 'left', maxWidth: colW - 150, color: PAL.blanco });
      text(String(r.puntaje), x + colW, y + 1, { size: 36, weight: '800', cond: true, align: 'right', color: i === 0 ? PAL.naranja : PAL.blanco });
    });
  }

  // ---------- Resultados ----------

  const ordinal = (n) => n + '.º';

  function drawResults() {
    const g = game.state;
    ctx.fillStyle = 'rgba(11,29,48,0.94)';
    ctx.fillRect(0, HEADER_H, W, BOARD_Y - HEADER_H);
    ctx.fillStyle = PAL.noche;
    ctx.fillRect(0, 0, W - 180, HEADER_H - 4); // tapa el encabezado del último turno (queda el logo)
    text('RESULTADOS', 64, 100, { size: 96, weight: '800', cond: true, align: 'left', ls: 10, color: PAL.blanco });
    const list = g.results || [];
    const puestos = new Map((ranking.ultima || []).map((x) => [x.id, x]));
    const record = (ranking.ultima || []).find((x) => x.esRecordHistorico);
    // el lugar de la cinta de récord queda siempre reservado: así las filas no saltan si el
    // ranking llega un momento después de que empiezan a entrar
    const top0 = 340;
    if (!record) {
      text('PARTIDA TERMINADA · ' + list.length + (list.length === 1 ? ' JUGADOR' : ' JUGADORES'), W / 2, 270,
        { size: 30, weight: '700', cond: true, ls: 4, color: PAL.gris });
    } else {
      // cinta naranja de récord y papelitos
      const r = list.find((x) => x.id === record.id);
      drawConfetti(performance.now() - ranking.ultimaAt);
      ctx.fillStyle = PAL.naranja;
      ctx.fillRect(0, 230, W, 76);
      text('NUEVO RÉCORD DE LA ESCUELA' + (r ? '  ·  ' + r.name.toUpperCase() : ''), W / 2, 270,
        { size: 42, weight: '800', cond: true, ls: 4, color: PAL.noche, maxWidth: W - 100 });
    }
    const rowH = Math.min(190, (BOARD_Y - 110 - top0) / Math.max(1, list.length));
    const since = performance.now() - fx.resultsAt;
    list.forEach((r, i) => {
      const y = top0 + i * rowH;
      const big = i === 0;
      // podio: las filas entran de a una desde la derecha (el 1.º último, con más pausa)
      const delay = (list.length - 1 - i) * 220 + (i === 0 ? 200 : 0);
      const tIn = Math.max(0, Math.min(1, (since - delay) / 450));
      if (tIn <= 0) return;
      ctx.save();
      ctx.translate((1 - easeOutBack(tIn)) * W * 0.7, 0);
      const shown = Math.round(r.score * easeOutCubic(Math.max(0, Math.min(1, (since - delay) / 900))));
      const h = rowH - 18;
      ctx.fillStyle = big ? PAL.panel2 : PAL.panel;
      ctx.fillRect(64, y, W - 128, h);
      ctx.fillStyle = r.color;
      ctx.fillRect(64, y, 10, h);
      if (big) { ctx.strokeStyle = PAL.naranja; ctx.lineWidth = 3; ctx.strokeRect(65.5, y + 1.5, W - 131, h - 3); }
      const cy = y + h / 2;
      const bs = Math.min(92, h - 30);
      ctx.fillStyle = MEDAL[i] || PAL.noche;
      ctx.fillRect(104, cy - bs / 2, bs, bs);
      text(String(i + 1), 104 + bs / 2, cy + 3, { size: bs * 0.62, weight: '800', cond: true, color: i < 3 ? PAL.noche : PAL.blanco });
      const nx = 104 + bs + 32;
      text(r.name, nx, cy - h * 0.16, { size: big ? 60 : 50, weight: '800', cond: true, align: 'left', color: PAL.blanco, maxWidth: 480 });
      const extra = [];
      if (r.plenos) extra.push(r.plenos + (r.plenos === 1 ? ' pleno' : ' plenos'));
      if (r.semiplenos) extra.push(r.semiplenos + (r.semiplenos === 1 ? ' semipleno' : ' semiplenos'));
      text(extra.join(' · ') || 'Sin plenos esta vez', nx + 2, cy + h * 0.2, { size: 28, weight: '600', align: 'left', color: PAL.gris, maxWidth: 480 });
      const pos = puestos.get(r.id);
      if (pos) {
        const label = pos.esRecordHistorico ? 'RÉCORD DE LA ESCUELA' : pos.esRecordPersonal ? 'RÉCORD PERSONAL' : ordinal(pos.puestoHoy) + ' DE HOY';
        const top10 = pos.esRecordHistorico || pos.esRecordPersonal || pos.puestoHoy <= 10;
        text(label, W - 100, cy + h * 0.3, { size: 24, weight: '700', cond: true, ls: 2, align: 'right', color: top10 ? PAL.naranja : PAL.gris });
      }
      text(String(shown), W - 100, cy - h * 0.06, { size: big ? 104 : 84, weight: '800', cond: true, align: 'right', color: PAL.blanco });
      ctx.restore();
    });
    const secs = Math.max(0, Math.ceil((g.phaseEndsAt - g.clock) / 1000));
    text('Volviendo al lobby en ' + secs + ' s', W / 2, BOARD_Y - 50, { size: 30, weight: '600', color: PAL.gris });
  }

  /** Papelitos que caen (récord de la escuela) */
  function drawConfetti(ms) {
    const colors = [PAL.naranja, PAL.azul, PAL.celeste, PAL.blanco];
    for (let i = 0; i < 70; i++) {
      const seed = Math.sin(i * 12.9898) * 43758.5453;
      const rnd = seed - Math.floor(seed);
      const x = (rnd * W + Math.sin(ms / 600 + i) * 40 + W) % W;
      const y = ((ms * (0.18 + rnd * 0.22) + i * 97) % (BOARD_Y - HEADER_H)) + HEADER_H;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ms / 300 + i);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(-7, -3, 14, 6);
      ctx.restore();
    }
  }

  // ---------- Cuadro ----------

  function draw() {
    const g = game.state;
    if (replaced) { escena.style.transform = ''; drawReplaced(); return; }
    updateFondo();
    applyShake();
    ctx.clearRect(0, 0, W, H);
    if (g.phase !== 'results') ranking.ultima = null;
    if (g.phase === 'lobby') {
      drawLobby();
    } else {
      drawLaneContents();
      drawParticles();
      drawHeaderCached();
      if (g.phase === 'results') drawResults();
      drawOverlays();
      drawScoreboardCached();
      drawOffline();
    }
    drawReactions();
    drawToast();
    if (debug && g.phase === 'lobby') {
      text(view.fps.toFixed(0) + ' FPS', 20, 30, { size: 26, align: 'left', color: '#0f8' });
    }
  }

  init();
})();
