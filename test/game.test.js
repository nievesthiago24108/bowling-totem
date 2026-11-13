'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Matter = require('matter-js');
const Physics = require('../public/shared/physics.js');
const Scoring = require('../public/shared/scoring.js');
const { createGame, randomThrow, aimTowards, COLORS } = require('../public/totem/game.js');

const STEP = 1000 / 60;

// PRNG con semilla para que los tests se puedan repetir
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(opts) {
  opts = opts || {};
  const events = [];
  const game = createGame({
    Matter, Physics, Scoring,
    config: Object.assign({ frames: 3, segundosPorTurno: 25, maxJugadores: 6 }, opts.config),
    emit: (name, data) => events.push({ name, data }),
    random: seeded(opts.seed || 1),
    now: () => 0,
  });
  return { game, events, g: game.state };
}

const lobbyOf = (players) => ({
  phase: 'lobby', totemConnected: true, maxJugadores: 6,
  players: players.map((p, i) => Object.assign({ color: '#fff', host: i === 0, connected: true, spectator: false }, p)),
});

/** Avanza el reloj hasta que se cumpla `cond` (o falla después de `maxMs`) */
function runUntil(game, cond, maxMs) {
  let t = 0;
  while (!cond()) {
    game.update(STEP);
    t += STEP;
    if (t > (maxMs || 120000)) throw new Error('No se cumplió la condición a tiempo (fase ' + game.state.phase + ')');
  }
}

const aiming = (g) => g.phase === 'playing' && g.turn && g.turn.state === 'aiming';

/** Juega la partida entera con tiros de prueba; devuelve el orden de los turnos */
function playAll(game, g) {
  const order = [];
  runUntil(game, () => aiming(g) || g.phase === 'results');
  while (g.phase === 'playing') {
    order.push(g.turn.playerId + ':' + g.turn.frameIdx);
    assert.ok(game.testThrow());
    runUntil(game, () => aiming(g) || g.phase === 'results');
  }
  return order;
}

test('partida de 1 jugador de prueba hasta los resultados', () => {
  const { game, events, g } = setup();
  assert.ok(game.addTestPlayer());
  assert.equal(game.start().ok, true);
  assert.equal(g.phase, 'countdown');
  playAll(game, g);
  assert.equal(g.phase, 'results');
  const p = g.players[0];
  assert.ok(Scoring.isComplete(p.card));
  const over = events.filter((e) => e.name === 'game:over');
  assert.equal(over.length, 1);
  assert.equal(over[0].data.frames, 3);
  assert.equal(over[0].data.jugadores[0].score, Scoring.total(p.card));
  // a los 15 s vuelve al lobby y avisa con game:state
  runUntil(game, () => g.phase === 'lobby', 16000);
  assert.equal(events[events.length - 1].data.phase, 'lobby');
});

test('3 jugadores: cada uno juega su frame completo, en orden', () => {
  const { game, events, g } = setup({ seed: 7 });
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }]));
  game.addTestPlayer();
  assert.deepEqual(game.roster().map((p) => p.id), ['a', 'b', 'prueba-1']);
  game.start();
  const order = playAll(game, g);
  // se quitan los repetidos consecutivos (2.º tiro del mismo frame)
  const turns = order.filter((x, i) => x !== order[i - 1]);
  assert.deepEqual(turns, ['a:0', 'b:0', 'prueba-1:0', 'a:1', 'b:1', 'prueba-1:1', 'a:2', 'b:2', 'prueba-1:2']);
  const over = events.find((e) => e.name === 'game:over').data;
  assert.deepEqual(over.jugadores.map((j) => j.score), g.players.map((p) => Scoring.total(p.card)));
  // los game:state de la partida traen el jugador de turno y la tabla
  const st = events.filter((e) => e.name === 'game:state' && e.data.phase === 'playing');
  assert.ok(st.length > 10);
  assert.ok(st.every((e) => e.data.scores.length === 3 && e.data.currentPlayerId));
});

test('después del primer tiro solo quedan los pinos en pie, en su lugar', () => {
  const { game, g } = setup();
  game.addTestPlayer();
  game.start();
  runUntil(game, () => aiming(g));
  // tiro al medio suave: tira algunos pinos pero no todos (se prueba con varias semillas)
  for (let k = 0; k < 20; k++) {
    game.throw('prueba-1', { power: 0.2, aim: 0.035 * (k % 5), spin: 0, position: 0.5 });
    runUntil(game, () => g.turn.state === 'result');
    const knocked = g.turn.knocked;
    const after = g.turn.after;
    runUntil(game, () => aiming(g) || g.phase === 'results');
    if (knocked > 0 && knocked < 10) {
      assert.equal(g.turn.throwNo, 2);
      assert.equal(g.lane.pins.length, 10 - knocked);
      g.lane.pins.forEach((pin) => {
        assert.deepEqual(pin.home, after.prevPins[pin.pinNum]);
      });
      return;
    }
    if (g.phase === 'results') break;
  }
  assert.fail('ningún tiro dejó pinos en pie');
});

test('último frame: después de un pleno vuelven los 10 pinos y hay 3.er tiro', () => {
  const { game, g } = setup({ config: { frames: 1 } });
  game.addTestPlayer();
  game.start();
  runUntil(game, () => aiming(g));
  // forzamos el resultado: simulamos que todos los pinos cayeron
  game.throw('prueba-1', { power: 0.9, aim: 0, spin: 0 });
  g.lane.pins.forEach((p) => { p.inGutter = true; });
  runUntil(game, () => g.turn.state === 'result');
  assert.equal(g.turn.kind, 'pleno');
  runUntil(game, () => aiming(g));
  assert.equal(g.turn.throwNo, 2);
  assert.equal(g.lane.pins.length, 10);
  game.throw('prueba-1', { power: 0.9, aim: 0, spin: 0 });
  g.lane.pins.forEach((p) => { p.inGutter = true; });
  runUntil(game, () => aiming(g));
  assert.equal(g.turn.throwNo, 3);
  assert.equal(g.lane.pins.length, 10);
  game.testThrow();
  runUntil(game, () => g.phase === 'results');
  assert.equal(g.players[0].card.rolls[0].length, 3);
});

test('si no tira a tiempo, se lanza un tiro automático', () => {
  const { game, g } = setup({ config: { segundosPorTurno: 2 } });
  game.addTestPlayer();
  game.start();
  runUntil(game, () => aiming(g));
  runUntil(game, () => g.turn.state === 'rolling', 2200);
  assert.equal(g.turn.params.power, 0.35);
});

test('jugador desconectado: se completa su frame con 0 y sigue el siguiente', () => {
  const { game, g } = setup();
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }]));
  game.start();
  runUntil(game, () => aiming(g));
  assert.equal(g.turn.playerId, 'a');
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana', connected: false }, { id: 'b', name: 'Beto' }]));
  runUntil(game, () => g.turn.playerId === 'b', 6000);
  assert.deepEqual(g.players[0].card.rolls[0], [0, 0]);
  assert.ok(g.notice && /Ana/.test(g.notice.text));
  // vuelve antes de su próximo turno y lo juega
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }]));
  game.testThrow();
  runUntil(game, () => aiming(g) && g.turn.playerId === 'a');
  assert.equal(g.turn.frameIdx, 1);
});

test('si se desconectan todos, la partida se abandona sin game:over', () => {
  const { game, events, g } = setup();
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }]));
  game.start();
  runUntil(game, () => aiming(g));
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana', connected: false }]));
  runUntil(game, () => g.phase === 'lobby', 6000);
  assert.equal(events.filter((e) => e.name === 'game:over').length, 0);
});

test('se ignoran los tiros y el apuntado de quien no está de turno', () => {
  const { game, g } = setup();
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }]));
  game.start();
  assert.equal(game.throw('a', { power: 1 }), false); // todavía en cuenta regresiva
  runUntil(game, () => aiming(g));
  assert.equal(game.throw('b', { power: 1 }), false);
  assert.equal(game.aim('b', 1), false);
  assert.equal(g.turn.state, 'aiming');
  assert.equal(game.aim('a', 0.8), true);
  assert.equal(g.turn.aimTarget, 0.8);
  assert.equal(game.throw('a', { power: 1 }), true);
  assert.equal(game.throw('a', { power: 1 }), false); // ya está rodando
});

test('no empieza sin jugadores ni dos veces', () => {
  const { game } = setup();
  assert.equal(game.start().ok, false);
  game.addTestPlayer();
  assert.equal(game.start().ok, true);
  assert.equal(game.start().ok, false);
  assert.equal(game.addTestPlayer(), null); // no se suman jugadores con la partida empezada
});

test('los espectadores no juegan y el plantel respeta maxJugadores', () => {
  const { game } = setup({ config: { maxJugadores: 2 } });
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }, { id: 'c', name: 'Ceci', spectator: true }]));
  assert.ok(game.addTestPlayer());
  assert.equal(game.addTestPlayer(), null);
  assert.deepEqual(game.roster().map((p) => p.id), ['a', 'prueba-1']);
});

test('los jugadores de prueba no repiten el color de los reales', () => {
  const { game } = setup();
  game.addTestPlayer();
  game.addTestPlayer(); // se crean antes de que llegue el celu (como con /?prueba=2)
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana', color: COLORS[0] }]));
  const colors = game.roster().map((p) => p.color);
  assert.equal(new Set(colors).size, colors.length);
  assert.equal(colors[0], COLORS[0]);
});

test('los tiros de prueba "al bolsillo" calculan un aim válido', () => {
  const rand = seeded(3);
  for (let i = 0; i < 20; i++) {
    const t = aimTowards(Matter, Physics, randomThrow(rand));
    for (const k of ['power', 'aim', 'spin', 'position']) assert.ok(Number.isFinite(t[k]), k);
    assert.ok(t.aim >= -1 && t.aim <= 1);
  }
});

test('cámara lenta (opcional): mismo resultado, tarda más y vuelve a velocidad normal', () => {
  function oneThrow(slowMotion) {
    const events = [];
    const game = createGame({
      Matter, Physics, Scoring, config: { frames: 3, segundosPorTurno: 25, maxJugadores: 6 },
      emit: (name, data) => events.push({ name, data }), random: seeded(3), now: () => 0, slowMotion,
    });
    const g = game.state;
    game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }]));
    game.start();
    runUntil(game, () => aiming(g));
    game.throw('a', { power: 0.8, aim: 0, spin: -0.5, position: 0.3 });
    let ms = 0, minScale = 1;
    while (g.turn.state === 'rolling') {
      game.update(STEP);
      ms += STEP;
      minScale = Math.min(minScale, g.timeScale);
      assert.ok(ms < 30000, 'el tiro no terminó');
    }
    return { ms, minScale, knocked: g.turn.knocked, scale: g.timeScale };
  }
  const normal = oneThrow(false);
  const lenta = oneThrow(true);
  assert.equal(normal.minScale, 1);
  assert.ok(lenta.minScale < 0.5, 'llega a cámara lenta');
  assert.equal(lenta.knocked, normal.knocked, 'la física da lo mismo');
  assert.ok(lenta.ms > normal.ms + 300, `tarda más (${Math.round(normal.ms)} → ${Math.round(lenta.ms)} ms)`);
  assert.equal(lenta.scale, 1, 'al terminar vuelve a velocidad normal');
});

test('game:state manda los pinos en pie (para la mini pista del celular)', () => {
  const tiros = [
    { power: 0.5, aim: 0, spin: 0, position: 0.6 },
    { power: 0.6, aim: -0.2, spin: 0, position: -0.7 },
    { power: 0.4, aim: 0.1, spin: 0, position: 0.9 },
  ];
  let probado = false;
  for (const tiro of tiros) {
    const { game, events, g } = setup();
    game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }]));
    game.start();
    runUntil(game, () => aiming(g));
    const primero = game.snapshot();
    assert.equal(primero.pins.length, 10);
    assert.deepEqual(primero.pins.map((p) => p.n).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const uno = primero.pins.find((p) => p.n === 1);
    assert.deepEqual([uno.x, uno.y], [0, 0], 'el pino 1 es el origen');
    const siete = primero.pins.find((p) => p.n === 7);
    assert.deepEqual([siete.x, siete.y], [-1.5, 2.6], 'fila de atrás: 1,5 separaciones al costado y 3 × 0,866 hacia atrás');

    game.throw('a', tiro);
    runUntil(game, () => aiming(g) || g.phase !== 'playing');
    if (g.phase !== 'playing' || g.turn.throwNo !== 2) continue; // fue pleno: probar otro tiro
    const segundo = events.filter((e) => e.name === 'game:state' && e.data.turnState === 'aiming').pop().data;
    assert.equal(segundo.throw, 2);
    assert.ok(segundo.pins.length > 0 && segundo.pins.length < 10, 'quedan algunos pinos');
    assert.equal(segundo.pins.length, segundo.pinsLeft);
    assert.deepEqual(segundo.pins.map((p) => p.n).sort(), g.lane.pins.map((p) => p.pinNum).sort());
    probado = true;
    break;
  }
  assert.ok(probado, 'ningún tiro de prueba dejó pinos para el segundo tiro');
});

test('quien empieza desconectado tiene sus 5 s de gracia (aunque el tótem lleve rato prendido)', () => {
  const { game, g } = setup();
  for (let i = 0; i < 40; i++) game.update(250); // el tótem lleva 10 s en el lobby
  game.setLobby(lobbyOf([{ id: 'b', name: 'Beto', connected: false }, { id: 'a', name: 'Ana' }]));
  game.start();
  runUntil(game, () => aiming(g));
  assert.equal(game.currentPlayer().id, 'b', 'no se saltea apenas le toca');
  game.update(STEP);
  assert.equal(game.currentPlayer().id, 'b');
  runUntil(game, () => game.currentPlayer() && game.currentPlayer().id === 'a', 8000);
});

test('game:over lleva partidaId y el aviso de salteado no queda tapando los resultados', () => {
  const { game, events, g } = setup({ config: { frames: 1 } });
  game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }]));
  game.start();
  runUntil(game, () => aiming(g));
  game.testThrow();
  runUntil(game, () => (aiming(g) && game.currentPlayer().id === 'b') || g.phase === 'results', 60000);
  if (g.phase !== 'results') {
    game.setLobby(lobbyOf([{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto', connected: false }]));
    runUntil(game, () => g.phase === 'results', 60000);
  }
  assert.equal(g.notice, null);
  const over = events.find((e) => e.name === 'game:over').data;
  assert.match(over.partidaId, /^p-/);
  assert.deepEqual(over.jugadores.map((j) => j.name), ['Ana', 'Beto']);
});
