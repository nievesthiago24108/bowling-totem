/*
 * Lógica del juego en el tótem: fases, turnos, tiros y puntaje.
 * No toca el DOM ni el socket, así se puede probar en Node (test/game.test.js).
 * Funciona en el navegador (window.BowlingGame) y en Node (require).
 *
 *   const game = BowlingGame.createGame({ Matter, Physics, Scoring, config, emit });
 *   game.update(msTranscurridos);   // en cada cuadro
 *
 * El tiempo del juego avanza solo con update(), así los tests pueden adelantarlo a mano.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BowlingGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEP = 1000 / 60;
  const COLORS = ['#3FB6E0', '#EE6A5B', '#F2C14E', '#5DBF7A', '#A98BE8', '#E98AB8']; // colores de jugador (paleta Institucional Nº4)
  const AUTO_THROW = { power: 0.35, aim: 0, spin: 0, position: 0 }; // tiro suave si no tira a tiempo

  function createGame(opts) {
    const { Matter, Physics, Scoring } = opts;
    const config = Object.assign({ frames: 3, segundosPorTurno: 25, maxJugadores: 6 }, opts.config);
    const emit = opts.emit || function () {};
    const now = opts.now || Date.now;
    const random = opts.random || Math.random;
    const T = Object.assign({
      countdown: 3000,  // cuenta regresiva
      result: 1400,     // cartel del resultado de cada tiro
      results: 15000,   // pantalla de resultados
      disconnect: 5000, // desconectado por más de esto → se saltea su turno
      maxStepsPerUpdate: 5,
      slowAfterHit: 700, // cámara lenta: cuánto dura después del primer choque (ms del tótem)
    }, opts.times);
    // Cámara lenta cuando la bola llega a los pinos (solo presentación; el tótem la activa,
    // los tests no, así los tiempos de la lógica no cambian)
    const SLOW = opts.slowMotion ? { scale: 0.35, fromY: Physics.LANE.headPinY + 170 } : null;

    const g = {
      phase: 'lobby',
      clock: 0,
      lobbyPlayers: [],   // del último lobby:update
      totemConnected: false,
      testPlayers: [],    // jugadores de prueba (solo existen en el tótem)
      players: [],        // plantel de la partida en curso
      current: 0,         // índice del jugador de turno
      turn: null,         // { state: 'aiming'|'rolling'|'result', ... }
      lane: Physics.createLane(Matter),
      phaseEndsAt: 0,
      throwsMade: 0,
      results: null,      // posiciones al terminar
      notice: null,       // { text, until } aviso corto (ej. turno salteado)
      timeScale: 1,       // para cámara lenta (etapa 7)
      acc: 0,
    };

    // ---------- Plantel ----------

    /**
     * Jugadores que entrarían a la partida si empieza ahora. Los de prueba toman los colores
     * que no usan los reales (el servidor no los conoce y puede repetir el color).
     */
    function roster() {
      const real = g.lobbyPlayers.filter((p) => !p.spectator);
      const used = new Set(real.map((p) => p.color));
      const tests = g.testPlayers.map((p) => {
        const color = COLORS.find((c) => !used.has(c)) || p.color;
        used.add(color);
        return Object.assign({}, p, { color });
      });
      return real.concat(tests).slice(0, config.maxJugadores);
    }

    function addTestPlayer() {
      if (g.phase !== 'lobby' || roster().length >= config.maxJugadores) return null;
      let n = 1;
      while (g.testPlayers.some((p) => p.id === 'prueba-' + n)) n++;
      const p = { id: 'prueba-' + n, name: 'Prueba ' + n, color: COLORS[0], host: false, connected: true, test: true };
      g.testPlayers.push(p);
      return p;
    }

    function clearTestPlayers() {
      if (g.phase === 'lobby') g.testPlayers = [];
    }

    function setLobby(payload) {
      if (!payload) return;
      g.lobbyPlayers = Array.isArray(payload.players) ? payload.players : [];
      g.totemConnected = !!payload.totemConnected;
      g.players.forEach((p) => {
        if (p.test) return;
        const found = g.lobbyPlayers.find((x) => x.id === p.id);
        const connected = !!(found && found.connected);
        if (!connected && p.connected) p.goneSince = g.clock;
        p.connected = connected;
      });
    }

    const goneTooLong = (p) => !p.connected && g.clock - p.goneSince >= T.disconnect;

    // ---------- Fases ----------

    function start() {
      if (g.phase !== 'lobby') return { ok: false, error: 'Ya hay una partida en curso.' };
      const list = roster();
      if (!list.length) return { ok: false, error: 'No hay jugadores.' };
      g.players = list.map((p) => ({
        id: p.id, name: p.name, color: p.color, test: !!p.test,
        connected: p.connected !== false, goneSince: g.clock, // la gracia de 5 s cuenta desde que empieza
        card: Scoring.createCard(config.frames),
      }));
      g.current = 0;
      g.turn = null;
      g.throwsMade = 0;
      // identifica la partida: el servidor la guarda una sola vez aunque el tótem reenvíe game:over
      g.partidaId = 'p-' + now().toString(36) + '-' + Math.floor(random() * 1e9).toString(36);
      g.results = null;
      g.lane = Physics.createLane(Matter);
      g.phase = 'countdown';
      g.phaseEndsAt = g.clock + T.countdown;
      emitState();
      return { ok: true };
    }

    function backToLobby() {
      g.phase = 'lobby';
      g.players = [];
      g.turn = null;
      g.results = null;
      g.notice = null;
      g.lane = Physics.createLane(Matter);
      emitState();
    }

    function finishGame() {
      g.turn = null;
      g.phase = 'results';
      g.phaseEndsAt = g.clock + T.results;
      const list = g.players.map((p) => {
        const marks = Scoring.display(p.card).flatMap((f) => f.marks);
        return {
          id: p.id, name: p.name, color: p.color, test: p.test,
          score: Scoring.total(p.card),
          plenos: marks.filter((m) => m === 'X').length,
          semiplenos: marks.filter((m) => m === '/').length,
        };
      });
      // empate: más plenos y después el orden de juego
      g.results = list.slice().sort((a, b) => b.score - a.score || b.plenos - a.plenos);
      g.notice = null; // el aviso de "se saltea a…" no tiene que tapar el podio
      emitState();
      if (g.throwsMade > 0) {
        emit('game:over', {
          partidaId: g.partidaId,
          frames: config.frames,
          jugadores: list.map(({ id, name, score, plenos, semiplenos }) => ({ id, name, score, plenos, semiplenos })),
        });
      }
    }

    // ---------- Turnos ----------

    const currentPlayer = () => (g.phase === 'playing' ? g.players[g.current] : null);

    /** Prepara el próximo tiro del jugador de turno (o lo saltea si no está) */
    function nextThrow() {
      for (;;) {
        if (g.players.every((p) => goneTooLong(p))) return backToLobby(); // partida abandonada
        const p = g.players[g.current];
        if (!goneTooLong(p)) break;
        skipFrame(p);
        if (!moveToNextPlayer()) return finishGame();
        g.lane = Physics.createLane(Matter);
      }
      const p = g.players[g.current];
      const samePlayer = g.turn && g.turn.playerId === p.id;
      const keepAim = samePlayer ? g.turn.aimTarget : 0;
      g.turn = {
        state: 'aiming',
        playerId: p.id,
        frameIdx: Scoring.currentFrame(p.card),
        throwNo: Scoring.throwInFrame(p.card),
        aim: keepAim,
        aimTarget: keepAim,
        endsAt: g.clock + config.segundosPorTurno * 1000,
      };
      emitState();
    }

    /** Completa con ceros el frame de un jugador desconectado */
    function skipFrame(p) {
      const i = Scoring.currentFrame(p.card);
      while (!Scoring.isComplete(p.card) && Scoring.currentFrame(p.card) === i) Scoring.addRoll(p.card, 0);
      g.notice = { text: 'Se saltea a ' + p.name + ' (desconectado)', until: g.clock + 2500 };
    }

    /** Pasa al siguiente jugador con la tarjeta incompleta; false si todos terminaron */
    function moveToNextPlayer() {
      const n = g.players.length;
      for (let k = 1; k <= n; k++) {
        const i = (g.current + k) % n;
        if (!Scoring.isComplete(g.players[i].card)) { g.current = i; return true; }
      }
      return false;
    }

    function doThrow(params) {
      Physics.throwBall(g.lane, Object.assign({}, params, { position: g.turn.aim }));
      g.turn.state = 'rolling';
      g.turn.params = g.lane.params;
      g.turn.hitAt = null;
      g.acc = 0;
      g.timeScale = 1;
      emitState();
    }

    function finishRoll() {
      const p = currentPlayer();
      const after = Physics.standingAfter(g.lane);
      const left = Scoring.pinsLeft(p.card);
      const knocked = Math.min(after.knocked, left);
      Scoring.addRoll(p.card, knocked);
      g.throwsMade++;
      const marks = Scoring.display(p.card)[g.turn.frameIdx].marks;
      const mark = marks[marks.length - 1];
      let kind, label;
      if (mark === 'X') { kind = 'pleno'; label = '¡PLENO!'; }
      else if (mark === '/') { kind = 'semipleno'; label = '¡SEMI-PLENO!'; }
      else if (knocked === 0 && g.lane.inGutter) { kind = 'canaleta'; label = 'CANALETA'; }
      else if (knocked === 0) { kind = 'cero'; label = 'Ningún pino'; }
      else { kind = 'pinos'; label = knocked === 1 ? '1 pino' : knocked + ' pinos'; }
      g.timeScale = 1;
      Object.assign(g.turn, { state: 'result', endsAt: g.clock + T.result, knocked, kind, label, after });
      emitState();
    }

    function afterResult() {
      const p = currentPlayer();
      const after = g.turn.after;
      if (Scoring.frameDone(p.card, g.turn.frameIdx)) {
        if (!moveToNextPlayer()) return finishGame();
        g.lane = Physics.createLane(Matter);
      } else if (Scoring.pinsLeft(p.card) === Scoring.PINS) {
        g.lane = Physics.createLane(Matter); // pleno o semi-pleno en el último frame: 10 pinos nuevos
      } else {
        g.lane = Physics.createLane(Matter, { standing: after.standing, prevPins: after.prevPins });
      }
      nextThrow();
    }

    // ---------- Entradas ----------

    function aim(playerId, position) {
      const p = currentPlayer();
      if (!p || p.id !== playerId || !g.turn || g.turn.state !== 'aiming') return false;
      const v = Number(position);
      g.turn.aimTarget = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
      return true;
    }

    function throwFor(playerId, params) {
      const p = currentPlayer();
      if (!p || p.id !== playerId || !g.turn || g.turn.state !== 'aiming') return false;
      if (params && params.position !== undefined) {
        const v = Number(params.position);
        if (Number.isFinite(v)) g.turn.aim = g.turn.aimTarget = Math.max(-1, Math.min(1, v));
      }
      doThrow(params || {});
      return true;
    }

    /** Tiro de prueba al azar para el jugador de turno (tecla Espacio) */
    function testThrow() {
      const p = currentPlayer();
      if (!p || !g.turn || g.turn.state !== 'aiming') return false;
      const pinsX = g.lane.pins.map((pin) => pin.position.x);
      return throwFor(p.id, aimTowards(Matter, Physics, randomThrow(random, pinsX)));
    }

    // ---------- Tiempo ----------

    function update(dtMs) {
      const dt = Math.max(0, Math.min(250, Number(dtMs) || 0));
      g.clock += dt;
      if (g.notice && g.clock >= g.notice.until) g.notice = null;

      if (g.phase === 'countdown') {
        if (g.clock >= g.phaseEndsAt) {
          g.phase = 'playing';
          g.current = 0;
          nextThrow();
        }
      } else if (g.phase === 'results') {
        if (g.clock >= g.phaseEndsAt) backToLobby();
      } else if (g.phase === 'playing' && g.turn) {
        const t = g.turn;
        if (t.state === 'aiming') {
          t.aim += (t.aimTarget - t.aim) * Math.min(1, dt / 90);
          if (goneTooLong(currentPlayer())) nextThrow();
          else if (g.clock >= t.endsAt) doThrow(AUTO_THROW);
        } else if (t.state === 'rolling') {
          if (SLOW) slowMotion(t, dt);
          g.acc += dt * g.timeScale;
          let steps = 0;
          while (g.acc >= STEP && steps < T.maxStepsPerUpdate) {
            Physics.step(g.lane, STEP);
            g.acc -= STEP;
            steps++;
            if (Physics.isSettled(g.lane)) { finishRoll(); break; }
          }
          if (steps >= T.maxStepsPerUpdate) g.acc = Math.min(g.acc, STEP);
        } else if (t.state === 'result') {
          if (g.clock >= t.endsAt) afterResult();
        }
      }
    }

    /** Va frenando el tiempo cerca de los pinos y lo vuelve a soltar después del choque */
    function slowMotion(t, dt) {
      const lane = g.lane, ball = lane.ball;
      let target = 1;
      if (ball && !lane.inGutter) {
        if (lane.hitPin) {
          if (t.hitAt == null) t.hitAt = g.clock;
          if (g.clock - t.hitAt < T.slowAfterHit) target = SLOW.scale;
        } else if (ball.position.y < SLOW.fromY) {
          target = SLOW.scale;
        }
      }
      g.timeScale += (target - g.timeScale) * Math.min(1, dt / 120);
    }

    // ---------- Estado para los celulares ----------

    function snapshot() {
      const p = currentPlayer();
      const state = { phase: g.phase, frames: config.frames };
      if (g.phase === 'lobby') return state;
      state.scores = g.players.map((x) => ({
        id: x.id, name: x.name, color: x.color, connected: x.connected,
        total: Scoring.total(x.card), display: Scoring.display(x.card),
      }));
      if (g.phase === 'countdown') state.startsInMs = Math.max(0, Math.round(g.phaseEndsAt - g.clock));
      if (p && g.turn) {
        state.currentPlayerId = p.id;
        state.frame = g.turn.frameIdx + 1;
        state.throw = g.turn.throwNo;
        state.turnState = g.turn.state;
        state.pinsLeft = Scoring.pinsLeft(p.card);
        state.pins = pinsForPhones();
        if (g.turn.state === 'aiming') state.turnMsLeft = Math.max(0, Math.round(g.turn.endsAt - g.clock));
        if (g.turn.state === 'result') state.lastThrow = { playerId: p.id, knocked: g.turn.knocked, kind: g.turn.kind };
      }
      if (g.phase === 'results') {
        state.results = g.results.map(({ id, name, score, plenos, semiplenos }) => ({ id, name, score, plenos, semiplenos }));
        state.lobbyInMs = Math.max(0, Math.round(g.phaseEndsAt - g.clock));
      }
      return state;
    }

    /**
     * Pinos de la pista actual para la mini pista del celular (después del primer tiro, solo los
     * que siguen en pie y donde quedaron). Coordenadas en "separaciones entre pinos": x desde el
     * centro, y hacia atrás desde la fila del pino 1. El celular no depende de los píxeles del tótem.
     */
    function pinsForPhones() {
      const L = Physics.LANE;
      const r1 = (v) => Math.round(v * 10) / 10;
      return g.lane.pins.map((pin) => ({
        n: pin.pinNum,
        x: r1((pin.position.x - L.centerX) / L.pinSpacing),
        y: r1((L.headPinY - pin.position.y) / L.pinSpacing),
      }));
    }

    function emitState() { emit('game:state', snapshot()); }

    return {
      state: g,
      roster, addTestPlayer, clearTestPlayers, setLobby,
      start, reset: backToLobby, aim, throw: throwFor, testThrow,
      update, snapshot, emitState, currentPlayer,
    };
  }

  // ---------- Tiros de prueba ----------

  /** x donde la bola cruza el pino 1 en una pista vacía */
  function arrivalX(Matter, Physics, params) {
    const st = Physics.createLane(Matter, { standing: [] });
    const ball = Physics.throwBall(st, params);
    let n = 0;
    while (ball.position.y > Physics.LANE.headPinY && n++ < 600) Physics.step(st);
    return ball.position.x;
  }

  /** aim necesario para que la bola llegue a targetX (búsqueda binaria) */
  function aimFor(Matter, Physics, targetX, params) {
    let lo = -1, hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (arrivalX(Matter, Physics, Object.assign({}, params, { aim: mid })) < targetX) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * Mezcla de tiros: la mitad al bolsillo, algunos al medio y otros al azar.
   * Con `pinsX` (x de los pinos en pie, para el 2.º tiro) apunta casi siempre a uno de ellos.
   */
  function randomThrow(random, pinsX) {
    const uni = (a, b) => a + (b - a) * random();
    const r = random();
    if (pinsX && pinsX.length && pinsX.length < 10 && r < 0.85) {
      const x = pinsX[Math.floor(random() * pinsX.length)];
      return { power: uni(0.5, 0.95), position: uni(-0.3, 0.3), spin: uni(-0.1, 0.1), targetX: x + uni(-18, 18) };
    }
    if (r < 0.5) {
      // al bolsillo: desde la derecha con efecto hacia adentro (el aim lo calcula aimTowards)
      return { power: uni(0.6, 0.95), position: uni(0.2, 0.6), spin: uni(-0.8, -0.3), target: 'pocket', jitter: uni(-14, 14) };
    }
    if (r < 0.8) return { power: uni(0.5, 0.95), position: uni(-0.2, 0.2), spin: uni(-0.1, 0.1), target: 'center', jitter: uni(-20, 20) };
    return { power: random(), aim: uni(-0.7, 0.7), spin: uni(-1, 1), position: uni(-0.8, 0.8) };
  }

  /** Completa el aim de un tiro de randomThrow que apunta a un lugar */
  function aimTowards(Matter, Physics, t) {
    if (!t.target && t.targetX === undefined) return t;
    const L = Physics.LANE;
    const x = t.targetX !== undefined ? t.targetX
      : (t.target === 'pocket' ? L.centerX + L.pinSpacing / 4 : L.centerX) + (t.jitter || 0);
    return { power: t.power, position: t.position, spin: t.spin, aim: aimFor(Matter, Physics, x, t) };
  }

  return { createGame, randomThrow, aimTowards, aimFor, COLORS, STEP };
});
