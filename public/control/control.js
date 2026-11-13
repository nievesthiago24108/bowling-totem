/*
 * Control del celular: unirse, esperar, apuntar/lanzar deslizando y mandar reacciones.
 * El tótem es la autoridad: acá solo se mandan gestos y se muestra lo que llega en game:state.
 */
(function () {
  'use strict';

  const KEY_NAME = 'bowling.nombre';
  const KEY_TOKEN = 'bowling.token';
  const KEY_TIME = 'bowling.tokenFecha';
  const REJOIN_MAX_MS = 3 * 60 * 60 * 1000; // al recargar, se recupera el lugar si pasaron menos de 3 h
  const AIM_EVERY_MS = 50;                  // máx. 20 mensajes de apuntado por segundo
  const REACT_EVERY_MS = 2000;
  const NAME_RE = /^[\p{L}\p{N} ]{2,14}$/u;

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* modo privado */ } },
  };

  let me = null;          // { id, token, name, color, host, spectator }
  let joined = false;     // ya se unió en esta pestaña → al reconectar vuelve a unirse
  let lobby = null;       // último lobby:update
  let state = null;       // último game:state (null en el lobby)
  let stateAt = 0;        // performance.now() cuando llegó
  let turnKey = null;     // "frame-tiro" del turno propio que se está jugando
  let thrown = false;     // ya tiré en este turno
  let position = 0;       // posición de salida elegida (-1..1)
  let lastAimSent = 0;
  let lastReact = 0;
  let puesto = null;      // leaderboard:position de la última partida
  let lastToken = null;   // el token también en memoria (si el navegador no deja usar localStorage)
  let lastName = null;    // último nombre con el que entró (para volver solo si arranca la partida)
  let wakeLock = null;    // pantalla siempre prendida mientras juega

  const socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 3000 });

  // ---------- Conexión ----------

  let pendingName = null; // nombre guardado para volver a entrar solo al recargar la página

  socket.on('connect', () => {
    showOffline(false);
    if (joined && me) join(me.name, true);
    else if (pendingName) { join(pendingName, true); pendingName = null; }
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') {
      // el servidor nos sacó: el mismo jugador se abrió en otra pestaña o celular
      showOffline(true, 'El juego se abrió en otra pestaña', 'Si querés seguir acá, tocá el botón.', true);
    } else {
      showOffline(true);
    }
  });

  function showOffline(on, title, sub, manual) {
    $('offline').classList.toggle('on', on);
    if (!on) return;
    $('offline-text').textContent = title || 'Sin conexión';
    $('offline-sub').textContent = sub || 'Reconectando… Revisá que sigas en la wifi del tótem.';
    $('reconnect').style.display = manual ? '' : 'none';
    $('offline-spin').style.display = manual ? 'none' : '';
  }
  $('reconnect').addEventListener('click', () => { showOffline(true); socket.connect(); });

  socket.on('lobby:update', (d) => {
    lobby = d;
    // si volvimos (pantalla bloqueada, reconexión) y el tótem ya está en el lobby, se olvida la
    // partida anterior: si no, el celu del anfitrión quedaba sin el botón «Empezar»
    if (d && d.phase === 'lobby' && state) { state = null; turnKey = null; thrown = false; }
    if (me) {
      const p = d.players.find((x) => x.id === me.id);
      if (p) Object.assign(me, { host: p.host, spectator: p.spectator, color: p.color, name: p.name });
      else if (joined && socket.connected && d.phase === 'lobby') join(me.name, true); // nos borraron: volver a entrar
    }
    render();
  });

  socket.on('leaderboard:position', (p) => {
    puesto = p || null;
    render();
  });

  socket.on('game:state', (s) => {
    state = s && s.phase !== 'lobby' ? s : null;
    if (!state || state.phase !== 'playing') { turnKey = null; thrown = false; } // nueva partida, turnos nuevos
    if (!state || state.phase !== 'results') puesto = null;
    stateAt = performance.now();
    if (state && me && state.currentPlayerId === me.id && state.turnState === 'aiming') {
      const key = state.frame + '-' + state.throw;
      if (key !== turnKey) {
        turnKey = key;
        thrown = false;
        if (state.throw === 1) { position = 0; sendAim(true); } // el tótem arranca cada turno con la bola al centro
        $('hint').textContent = 'Arrastrá la bola a los costados · Deslizá hacia arriba para tirar';
        vibrate([180, 80, 180]);
      }
    }
    // apretó «Cambiar» y la partida arrancó mientras escribía: vuelve con su nombre y su lugar
    if (!me && !joined && lastName && state && socket.connected) join(lastName, true);
    render();
  });

  // ---------- Unirse ----------

  function join(name, silent) {
    const token = (me && me.token) || lastToken || store.get(KEY_TOKEN) || undefined;
    socket.emit('player:join', { name, token }, (r) => {
      if (!r || !r.ok) {
        if (!silent) $('join-error').textContent = (r && r.error) || 'No se pudo entrar. Probá de nuevo.';
        joined = false;
        me = null;
        render();
        return;
      }
      me = { id: r.id, token: r.token, name, color: r.color, host: r.host, spectator: r.spectator };
      joined = true;
      lastToken = r.token;
      lastName = name;
      keepAwake();
      store.set(KEY_NAME, name);
      store.set(KEY_TOKEN, r.token);
      store.set(KEY_TIME, String(Date.now()));
      $('join-error').textContent = '';
      render();
    });
  }

  function submitJoin() {
    const name = $('name').value.replace(/\s+/g, ' ').trim();
    if (!NAME_RE.test(name)) {
      $('join-error').textContent = 'El nombre tiene que tener entre 2 y 14 letras o números.';
      return;
    }
    if (!socket.connected) { $('join-error').textContent = 'Todavía no hay conexión con el tótem…'; return; }
    $('name').blur();
    join(name);
  }
  $('join').addEventListener('click', submitJoin);
  $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitJoin(); });
  $('rename').addEventListener('click', () => {
    joined = false; // vuelve a la pantalla de nombre; el token conserva el lugar
    $('name').value = me ? me.name : '';
    me = null;
    render();
  });

  /** Pide que la pantalla no se apague mientras juega (si el navegador lo soporta) */
  async function keepAwake() {
    if (!joined || wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; /* sin permiso o sin soporte: sigue igual */ }
  }
  document.addEventListener('visibilitychange', keepAwake);

  $('start').addEventListener('click', () => {
    $('start-error').textContent = '';
    socket.emit('game:start', (r) => {
      if (r && !r.ok) $('start-error').textContent = r.error;
    });
  });

  // ---------- Pantallas ----------

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id));
  }

  function myScore() {
    return state && state.scores && me ? state.scores.find((s) => s.id === me.id) : null;
  }

  function isMyAimingTurn() {
    return state && me && state.phase === 'playing' && state.currentPlayerId === me.id &&
      state.turnState === 'aiming' && !thrown;
  }

  function render() {
    if (me) document.documentElement.style.setProperty('--me', me.color);
    document.querySelectorAll('[data-myname]').forEach((el) => { el.textContent = me ? me.name : ''; });
    if (!me) return show('s-join');
    if (!state) return renderLobby();
    if (isMyAimingTurn()) return renderPlay();
    renderWatch();
  }

  function renderLobby() {
    show('s-lobby');
    const list = $('lobby-players');
    list.textContent = '';
    const players = lobby ? lobby.players : [];
    players.forEach((p) => {
      const li = document.createElement('li');
      if (!p.connected) li.className = 'off';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      dot.style.color = p.color;
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === me.id ? ' (vos)' : '');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = p.host ? 'anfitrión' : p.spectator ? 'próxima partida' : !p.connected ? 'sin conexión' : '';
      li.append(dot, name, tag);
      list.append(li);
    });
    const host = players.find((p) => p.host);
    const totemOk = lobby && lobby.totemConnected;
    $('lobby-title').textContent = me.spectator ? 'Jugás en la próxima partida' : 'Ya estás adentro';
    $('start').style.display = me.host ? '' : 'none';
    $('start').disabled = !totemOk;
    let wait = '';
    if (!totemOk) wait = 'El tótem no está conectado.';
    else if (me.host) wait = 'Cuando estén todos, tocá «Empezar».';
    else if (host) wait = 'Esperando que ' + host.name + ' empiece la partida…';
    $('lobby-wait').textContent = wait;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function framesCard(score) {
    const box = el('div', 'frames');
    (score.display || []).forEach((f) => {
      const d = el('div');
      d.append(el('div', 'm', f.marks.join(' ') || ' '), el('div', 'c', f.cumulative == null ? ' ' : String(f.cumulative)));
      box.append(d);
    });
    return box;
  }

  function renderWatch() {
    show('s-watch');
    const score = myScore();
    $('my-total').textContent = score ? String(score.total) : '';
    const main = $('watch-main');
    main.textContent = '';
    const s = state;

    if (s.phase === 'countdown') {
      main.append(el('div', 'status', 'La partida empieza'), el('div', 'count', '3'));
      main.lastChild.id = 'count';
      tick();
    } else if (s.phase === 'playing') {
      const cur = (s.scores || []).find((x) => x.id === s.currentPlayerId);
      if (cur && cur.id === me.id) {
        main.append(el('div', 'status', s.turnState === 'result' && s.lastThrow ? resultText(s.lastThrow) : 'Lanzaste'));
        main.append(el('div', 'sub', 'Mirá el tótem'));
      } else if (cur) {
        const t = el('div', 'status', 'Juega ');
        const n = el('span', null, cur.name);
        n.style.color = cur.color;
        t.append(n);
        main.append(t, el('div', 'sub', 'Frame ' + s.frame + ' de ' + s.frames + ' · Tiro ' + s.throw));
        if (s.turnState === 'result' && s.lastThrow) main.append(el('div', 'status', resultText(s.lastThrow)));
      }
      if (!score) main.append(el('div', 'sub', 'Mirás esta partida. Jugás en la próxima.'));
      if (score) main.append(framesCard(score));
      main.append(el('div', 'sub', 'Mandá una reacción al tótem:'));
    } else if (s.phase === 'results') {
      const list = s.results || [];
      const pos = list.findIndex((r) => r.id === me.id);
      if (pos >= 0) {
        main.append(el('div', 'status', 'Hiciste ' + list[pos].score + ' puntos'));
        main.append(el('div', 'sub', list.length > 1 ? 'Quedaste ' + (pos + 1) + '.º de ' + list.length : 'Bien jugado'));
        if (puesto) main.append(puestoCard(puesto));
      } else {
        main.append(el('div', 'status', 'Terminó la partida'));
      }
      const ul = el('ul', 'results');
      list.forEach((r, i) => {
        const li = el('li', r.id === me.id ? 'mine' : null);
        li.append(el('span', null, (i + 1) + '.'), el('span', null, r.name), el('span', 'pts', String(r.score)));
        ul.append(li);
      });
      main.append(ul);
      if (score) main.append(framesCard(score));
      main.append(rankingLink());
    }
  }

  /** "Puesto 3 de hoy · Puesto 12 de siempre" y, si corresponde, "Récord personal" */
  function puestoCard(p) {
    const box = el('div', 'card puesto');
    box.append(el('div', null, 'Puesto ' + p.puestoHoy + ' de hoy · Puesto ' + p.puestoSiempre + ' de siempre'));
    if (p.esRecordHistorico) box.append(el('div', 'record', 'Récord de la escuela'));
    else if (p.esRecordPersonal) box.append(el('div', 'record', 'Récord personal'));
    else if (p.puestoHoy <= 10) box.append(el('div', 'record', 'Top 10 de hoy'));
    return box;
  }

  function rankingLink() {
    const a = el('a', 'link', 'Ver ranking');
    a.href = '/ranking/';
    a.target = '_blank'; // en otra pestaña, así el juego sigue conectado
    a.rel = 'noopener';
    return a;
  }

  function resultText(t) {
    if (t.kind === 'pleno') return 'Pleno';
    if (t.kind === 'semipleno') return 'Semipleno';
    if (t.kind === 'canaleta') return 'Canaleta…';
    return t.knocked === 1 ? '1 pino' : t.knocked + ' pinos';
  }

  // reloj de la cuenta regresiva y del turno
  function tick() {
    if (!state) return;
    const elapsed = performance.now() - stateAt;
    if (state.phase === 'countdown' && $('count')) {
      $('count').textContent = String(Math.max(1, Math.ceil(((state.startsInMs || 0) - elapsed) / 1000)));
    }
    if (isMyAimingTurn() && state.turnMsLeft != null) {
      const secs = Math.max(0, Math.ceil((state.turnMsLeft - elapsed) / 1000));
      $('timer').textContent = String(secs);
      $('timer').classList.toggle('urgent', secs <= 5);
    }
  }
  setInterval(tick, 200);

  // ---------- Reacciones ----------

  $('reactions').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-emoji]');
    if (!b) return;
    const now = Date.now();
    if (now - lastReact < REACT_EVERY_MS) return;
    lastReact = now;
    socket.emit('player:react', { emoji: b.dataset.emoji });
    vibrate(30);
    $('reactions').classList.add('wait');
    setTimeout(() => $('reactions').classList.remove('wait'), REACT_EVERY_MS);
  });

  function vibrate(p) {
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* no soportado */ }
  }

  // ---------- Mi turno: mini pista, apuntar y lanzar ----------

  const canvas = $('lane');
  const ctx = canvas.getContext('2d');
  let geo = null;      // medidas de la mini pista en píxeles CSS
  let gesture = null;  // { mode: null|'aim'|'swipe', points, startPos }
  let swipeFail = 0;   // para mostrar el aviso de "deslizá más largo"

  function renderPlay() {
    show('s-play');
    const s = state;
    $('play-info').textContent = 'Frame ' + s.frame + ' de ' + s.frames + ' · Tiro ' + s.throw +
      (s.pinsLeft < 10 ? ' · quedan ' + s.pinsLeft : '');
    tick();
    layout();
    startPlayLoop();
  }

  function layout() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const laneW = Math.min(r.width * 0.62, r.height * 0.4);
    const ballR = laneW * 0.075;
    geo = {
      w: r.width, h: r.height, laneW, ballR,
      left: (r.width - laneW) / 2, right: (r.width + laneW) / 2,
      ballY: r.height - Math.max(70, ballR * 3),
      travel: laneW / 2 - ballR * 1.15, // cuánto se puede correr la bola desde el centro
    };
  }
  window.addEventListener('resize', () => { if ($('s-play').classList.contains('on')) layout(); });

  const ballX = () => geo.w / 2 + position * geo.travel;

  /** Los 10 lugares de los pinos (mismo triángulo que el tótem), en separaciones entre pinos */
  const PIN_SPOTS = [];
  [[1], [2, 3], [4, 5, 6], [7, 8, 9, 10]].forEach((row, r) => {
    row.forEach((n, i) => PIN_SPOTS.push({ n, x: i - (row.length - 1) / 2, y: r * 0.866 }));
  });

  let playLoop = false;
  function startPlayLoop() {
    if (playLoop) return;
    playLoop = true;
    requestAnimationFrame(drawPlay);
  }
  function drawPlay() {
    // solo se anima en la pantalla de tiro (ahorra batería el resto del tiempo)
    if (!$('s-play').classList.contains('on') || !geo) { playLoop = false; return; }
    requestAnimationFrame(drawPlay);
    const { w, h, left, laneW, ballR } = geo;
    ctx.clearRect(0, 0, w, h);
    const gut = laneW * 0.085;
    ctx.fillStyle = '#22374C';
    ctx.fillRect(left - gut, 0, laneW + gut * 2, h);
    const wood = ctx.createLinearGradient(left, 0, left + laneW, 0);
    wood.addColorStop(0, '#d9a96c'); wood.addColorStop(0.5, '#f0cf9a'); wood.addColorStop(1, '#d9a96c');
    ctx.fillStyle = wood;
    ctx.fillRect(left, 0, laneW, h);
    ctx.strokeStyle = 'rgba(90,50,20,0.18)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 20; i++) {
      const x = left + (laneW * i) / 20;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    // flechas
    ctx.fillStyle = '#6b3818';
    for (let i = 0; i < 7; i++) {
      const x = left + laneW * (i + 0.5) / 7;
      const y = h * 0.55 + Math.abs(i - 3) * 12;
      ctx.beginPath(); ctx.moveTo(x, y - 14); ctx.lineTo(x + 6, y + 6); ctx.lineTo(x - 6, y + 6); ctx.closePath(); ctx.fill();
    }
    // pinos: marcas tenues en los 10 lugares y encima los que siguen en pie, donde quedaron
    // (llegan del tótem en state.pins, en "separaciones entre pinos" desde el pino 1)
    const sp = laneW * 0.16, pr = laneW * 0.035, headY = h * 0.2;
    ctx.fillStyle = 'rgba(90,50,20,0.35)';
    PIN_SPOTS.forEach((p) => {
      ctx.beginPath(); ctx.arc(w / 2 + p.x * sp, headY - p.y * sp, pr * 0.35, 0, Math.PI * 2); ctx.fill();
    });
    const pins = state && Array.isArray(state.pins) ? state.pins : PIN_SPOTS;
    pins.forEach((p) => {
      const x = w / 2 + p.x * sp, y = headY - p.y * sp;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.arc(x + 1.5, y + 2, pr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y, pr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#d0103a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, pr * 0.6, 0, Math.PI * 2); ctx.stroke();
    });
    // línea de foul
    ctx.fillStyle = '#E5484D';
    ctx.fillRect(left - gut, geo.ballY - ballR * 1.6, laneW + gut * 2, 3);

    const color = me ? me.color : '#6272B4';
    const bx = ballX(), by = geo.ballY;
    // trazo y flecha mientras desliza
    if (gesture && gesture.mode === 'swipe' && gesture.points.length > 1) {
      const pts = gesture.points;
      ctx.save();
      ctx.strokeStyle = color; ctx.globalAlpha = 0.85; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      pts.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      const r = window.BowlingGesture.analyze(pts, window.innerHeight);
      if (r) {
        const ang = r.aim * 0.4;
        const len = 80 + r.power * (h * 0.35);
        const ex = bx + Math.sin(ang) * len, ey = by - Math.cos(ang) * len;
        ctx.globalAlpha = 1; ctx.strokeStyle = '#fff'; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(bx, by - ballR); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(ex + Math.sin(ang) * 22, ey - Math.cos(ang) * 22);
        ctx.lineTo(ex + Math.cos(ang) * 16, ey + Math.sin(ang) * 16);
        ctx.lineTo(ex - Math.cos(ang) * 16, ey - Math.sin(ang) * 16);
        ctx.closePath(); ctx.fill();
        ctx.font = '700 18px Barlow, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Fuerza ' + Math.round(r.power * 100) + '%' + (Math.abs(r.spin) > 0.15 ? (r.spin > 0 ? ' · efecto →' : ' · ← efecto') : ''),
          w / 2, h * 0.36);
      }
      ctx.restore();
    }
    // bola
    const gr = ctx.createRadialGradient(bx - ballR * 0.35, by - ballR * 0.4, ballR * 0.1, bx, by, ballR);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.35, color); gr.addColorStop(1, '#0B1D30');
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(bx + 4, by + 6, ballR, ballR * 0.9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(bx, by, ballR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(10,10,20,0.7)';
    [[-0.22, -0.15], [0.22, -0.15], [0, 0.3]].forEach(([dx, dy]) => {
      ctx.beginPath(); ctx.arc(bx + dx * ballR, by + dy * ballR, ballR * 0.13, 0, Math.PI * 2); ctx.fill();
    });
    // flechitas de "arrastrar" a los costados
    if (!gesture) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.3 + 0.5 * pulse) + ')';
      ctx.font = '800 26px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('‹', bx - ballR * 1.7, by);
      ctx.fillText('›', bx + ballR * 1.7, by);
      const ay = by - ballR * 1.8 - pulse * 8; // flecha hacia arriba (el carácter ︿ falta en algunas fuentes)
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(bx - 11, ay + 6); ctx.lineTo(bx, ay - 5); ctx.lineTo(bx + 11, ay + 6); ctx.stroke();
    }
  }

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!isMyAimingTurn()) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* sin captura */ }
    gesture = { mode: null, points: [localPoint(e)], startPos: position, id: e.pointerId };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    e.preventDefault();
    const p = localPoint(e);
    gesture.points.push(p);
    const s = gesture.points[0];
    const dx = p.x - s.x, dy = p.y - s.y;
    if (!gesture.mode && Math.hypot(dx, dy) > 12) {
      gesture.mode = dy < 0 && Math.abs(dy) > Math.abs(dx) * 0.8 ? 'swipe' : 'aim';
    }
    if (gesture.mode === 'aim') {
      position = Math.max(-1, Math.min(1, gesture.startPos + dx / geo.travel));
      sendAim(false);
    }
  });

  function endGesture(e) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const g = gesture;
    gesture = null;
    if (g.mode === 'aim') sendAim(true);
    if (g.mode !== 'swipe' || !isMyAimingTurn()) return;
    g.points.push(localPoint(e));
    const r = window.BowlingGesture.analyze(g.points, window.innerHeight);
    if (!r) {
      swipeFail++;
      $('hint').textContent = 'Deslizá más largo y hacia arriba para tirar';
      return;
    }
    const sentKey = turnKey;
    // si el tiro no llega (wifi inestable, reconexión), el celu vuelve a dejar tirar en vez de
    // quedarse en «Lanzaste» hasta el tiro automático
    socket.timeout(2500).emit('player:throw', { power: r.power, aim: r.aim, spin: r.spin, position }, (err, res) => {
      if (!err && res && res.ok) return;
      if (turnKey === sentKey && state && state.turnState === 'aiming' && me && state.currentPlayerId === me.id) {
        thrown = false;
        render();
        $('hint').textContent = 'No llegó el tiro. Probá de nuevo.';
      }
    });
    thrown = true;
    vibrate(60);
    $('hint').textContent = 'Arrastrá la bola a los costados · Deslizá hacia arriba para tirar';
    render();
  }
  canvas.addEventListener('pointerup', endGesture);
  canvas.addEventListener('pointercancel', (e) => { if (gesture && e.pointerId === gesture.id) gesture = null; });

  function sendAim(force) {
    const now = performance.now();
    if (!force && now - lastAimSent < AIM_EVERY_MS) return;
    lastAimSent = now;
    socket.emit('player:aim', { position });
  }

  // evitar scroll, zoom y "tirar para recargar" (sobre todo en Safari)
  document.addEventListener('touchmove', (e) => {
    if (e.target.closest && e.target.closest('.players, #watch-main, #s-join')) return; // estas sí se desplazan
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());

  // ---------- Arranque ----------

  fetch('/api/config').then((r) => r.json()).then((c) => {
    document.querySelectorAll('[data-school]').forEach((el) => { el.textContent = c.nombreEscuela || ''; });
    document.querySelectorAll('[data-creditos]').forEach((el) => { el.textContent = c.creditos || ''; });
  }).catch(() => {});

  const savedName = store.get(KEY_NAME);
  if (savedName) $('name').value = savedName;
  const savedAt = Number(store.get(KEY_TIME)) || 0;
  if (savedName && store.get(KEY_TOKEN) && Date.now() - savedAt < REJOIN_MAX_MS) {
    // recargó la página o volvió hace poco: recupera su lugar sin escribir el nombre
    pendingName = savedName;
    if (socket.connected) { join(pendingName, true); pendingName = null; }
  }
  render();
})();
