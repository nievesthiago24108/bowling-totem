const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: connect } = require('socket.io-client');
const { createBowlingServer, cleanName, loadConfig } = require('../server.js');

const carpetas = [];
function carpetaTemporal() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-srv-'));
  carpetas.push(d);
  return d;
}

const CONFIG = {
  nombreEscuela: 'Escuela de prueba', frames: 3, maxJugadores: 3, puerto: 0,
  segundosPorTurno: 25, pinAdmin: '9999', segundosRotacionRanking: 8,
};

let bowling, base;
const sockets = [];

test.before(async () => {
  bowling = createBowlingServer(CONFIG, { silent: true, lobbyGraceMs: 200, dataDir: carpetaTemporal() });
  const port = await bowling.start(0);
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  sockets.forEach((s) => s.close());
  await bowling.close();
  carpetas.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

function client(url = base) {
  const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function next(socket, event, ms = 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`No llegó ${event}`)), ms);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

/** Espera que NO llegue un evento en ese tiempo */
function none(socket, event, ms = 150) {
  return new Promise((resolve, reject) => {
    const fn = (d) => reject(new Error(`Llegó ${event} y no debía: ${JSON.stringify(d)}`));
    socket.once(event, fn);
    setTimeout(() => { socket.off(event, fn); resolve(); }, ms);
  });
}

/** Espera un lobby:update que cumpla la condición */
function lobbyWhere(socket, pred, ms = 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off('lobby:update', fn); reject(new Error('lobby:update esperado no llegó')); }, ms);
    function fn(l) { if (pred(l)) { clearTimeout(t); socket.off('lobby:update', fn); resolve(l); } }
    socket.on('lobby:update', fn);
  });
}

const join = (s, name, token) => s.emitWithAck('player:join', { name, token });
const state = (phase, currentPlayerId) => ({ phase, currentPlayerId, frame: 1, throw: 1, scores: {} });

test('nombres: limpieza y validación', () => {
  assert.equal(cleanName('  Lucía   Pérez '), 'Lucía Pérez');
  assert.equal(cleanName('A'), null);
  assert.equal(cleanName('<b>hola</b>'), null);
  assert.equal(cleanName('Un nombre muy largo'), null);
  assert.equal(cleanName(undefined), null);
});

test('rutas HTTP: QR, config pública y matter-js', async () => {
  const qr = await fetch(base + '/qr.png');
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await qr.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');

  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.nombreEscuela, 'Escuela de prueba');
  assert.match(cfg.urlJuego, /^http:\/\/[\d.]+:\d+\/j$/);
  assert.equal(cfg.pinAdmin, undefined, 'el PIN no se expone');

  const matter = await fetch(base + '/vendor/matter.min.js');
  assert.equal(matter.status, 200);
  const shared = await fetch(base + '/shared/scoring.js');
  assert.equal(shared.status, 200);
  for (const page of ['/ranking/', '/admin/']) {
    const r = await fetch(base + page);
    assert.equal(r.status, 200, page);
    assert.match(r.headers.get('content-type'), /text\/html/);
  }
});

test('partida completa por mensajes', async (t) => {
  const totem = await client();
  const first = next(totem, 'lobby:update');
  totem.emit('totem:hello');
  assert.equal((await first).totemConnected, true);

  const a = await client();
  let b = await client();

  await t.test('nombre inválido rechazado', async () => {
    const r = await join(a, 'x');
    assert.equal(r.ok, false);
    assert.match(r.error, /2 y 14/);
  });

  let A, B;
  await t.test('jugadores entran; el primero es anfitrión y cada uno tiene su color', async () => {
    A = await join(a, 'Lucía');
    assert.equal(A.ok, true);
    assert.equal(A.host, true);
    assert.equal(A.spectator, false);
    assert.ok(A.token.length >= 8);
    const lob = lobbyWhere(totem, (l) => l.players.length === 2);
    B = await join(b, 'Mateo');
    assert.equal(B.host, false);
    assert.notEqual(B.color, A.color);
    const l = await lob;
    assert.deepEqual(l.players.map((p) => p.name), ['Lucía', 'Mateo']);
    assert.ok(l.players.every((p) => !('token' in p)), 'los tokens no se reenvían');
  });

  await t.test('solo el anfitrión empieza, y el tótem recibe game:start', async () => {
    const rb = await b.emitWithAck('game:start');
    assert.equal(rb.ok, false);
    const got = next(totem, 'game:start');
    const ra = await a.emitWithAck('game:start');
    assert.equal(ra.ok, true);
    assert.equal((await got).by, A.id);
  });

  await t.test('game:state del tótem llega a los celulares', async () => {
    const sa = next(a, 'game:state');
    const sb = next(b, 'game:state');
    totem.emit('game:state', state('playing', A.id));
    assert.equal((await sa).currentPlayerId, A.id);
    assert.equal((await sb).phase, 'playing');
  });

  await t.test('solo el jugador de turno apunta y tira; valores acotados', async () => {
    const notB = none(totem, 'player:throw');
    b.emit('player:throw', { power: 1 });
    await notB;
    const aim = next(totem, 'player:aim');
    a.emit('player:aim', { position: 5 });
    assert.deepEqual(await aim, { playerId: A.id, position: 1 });
    const thr = next(totem, 'player:throw');
    a.emit('player:throw', { power: 3, aim: -2, spin: 'x', position: 0.5 });
    assert.deepEqual(await thr, { playerId: A.id, power: 1, aim: -1, spin: 0, position: 0.5 });
    const dbl = none(totem, 'player:throw');
    a.emit('player:throw', { power: 0.5 }); // doble tiro inmediato: se ignora
    await dbl;
  });

  let C, c;
  await t.test('quien entra con partida en curso queda de espectador y reacciona', async () => {
    c = await client();
    C = await join(c, 'Sofi');
    assert.equal(C.spectator, true);
    const rx = next(totem, 'player:react');
    c.emit('player:react', { emoji: '🔥' });
    assert.deepEqual(await rx, { playerId: C.id, name: 'Sofi', color: C.color, emoji: '🔥' });
    const again = none(totem, 'player:react');
    c.emit('player:react', { emoji: '👏' }); // antes de 2 s: se ignora
    await again;
    const bad = none(totem, 'player:react');
    b.emit('player:react', { emoji: '<script>' });
    await bad;
  });

  await t.test('desconexión y vuelta con el mismo token recupera el lugar', async () => {
    const gone = lobbyWhere(totem, (l) => l.players.some((p) => p.id === B.id && !p.connected));
    b.close();
    await gone;
    const b2 = await client();
    const back = next(b2, 'game:state');
    const R = await join(b2, 'Mateo', B.token);
    assert.equal(R.id, B.id);
    assert.equal(R.color, B.color);
    assert.equal((await back).phase, 'playing', 'recibe el estado actual de la partida');
    b = b2;
  });

  let t2;
  await t.test('el tótem que se reconecta recibe el lobby', async () => {
    totem.close();
    await lobbyWhere(a, (l) => !l.totemConnected);
    t2 = await client();
    const lob = next(t2, 'lobby:update');
    t2.emit('totem:hello');
    const l = await lob;
    assert.equal(l.totemConnected, true);
    assert.equal(l.phase, 'playing');
    assert.equal(l.players.length, 3);
    // sigue reenviando al tótem nuevo
    await new Promise((r) => setTimeout(r, 1000)); // pasa el límite de 1 tiro por segundo
    const thr = next(t2, 'player:throw');
    a.emit('player:throw', { power: 0.7 });
    assert.equal((await thr).playerId, A.id);
  });

  await t.test('al volver al lobby el espectador pasa a jugar', async () => {
    const lob2 = lobbyWhere(a, (x) => x.phase === 'lobby');
    t2.emit('game:state', state('lobby', null));
    const x = await lob2;
    const sofi = x.players.find((p) => p.id === C.id);
    assert.equal(sofi.spectator, false);
    assert.ok(!x.players.some((p) => p.id !== sofi.id && p.color === sofi.color), 'color propio');
  });

  await t.test('lobby lleno: el cuarto queda de espectador', async () => {
    const d = await client();
    const D = await join(d, 'Juan');
    assert.equal(D.spectator, true);
  });

  await t.test('si el anfitrión se va del lobby, pasa al siguiente y se borra tras la espera', async () => {
    const passed = lobbyWhere(t2, (l) => l.players.find((p) => p.id === B.id)?.host);
    a.close();
    await passed;
    const removed = await lobbyWhere(t2, (l) => !l.players.some((p) => p.id === A.id));
    assert.ok(removed);
  });
});

test('leaderboard: guardado, posiciones, rutas y admin', async (t) => {
  const srv = createBowlingServer(CONFIG, { silent: true, dataDir: carpetaTemporal() });
  const url = `http://127.0.0.1:${await srv.start(0)}`;
  const admin = (ruta, init = {}, pin = '9999') => fetch(url + '/api/admin' + ruta,
    Object.assign({}, init, { headers: Object.assign({ 'x-pin': pin }, init.headers) }));
  t.after(() => srv.close());

  const totem = await client(url);
  const primero = next(totem, 'leaderboard:update');
  totem.emit('totem:hello');
  const vacio = await primero;
  assert.deepEqual([vacio.hoy, vacio.semana, vacio.siempre], [[], [], []]);
  assert.equal(vacio.frames, 3);

  const a = await client(url);
  const b = await client(url);
  const malo = await join(a, 'P0rong4');
  assert.equal(malo.ok, false);
  assert.match(malo.error, /no está permitido/);
  const A = await join(a, 'Lucía');
  const B = await join(b, 'Mateo');

  await t.test('game:over guarda solo jugadores reales, con el nombre del servidor', async () => {
    totem.emit('game:state', state('playing', A.id));
    totem.emit('game:state', Object.assign(state('results', null), { results: [] }));
    const posA = next(a, 'leaderboard:position');
    const posB = next(b, 'leaderboard:position');
    const upd = next(totem, 'leaderboard:update');
    totem.emit('game:over', {
      frames: 3,
      jugadores: [
        { id: A.id, name: 'Otro', score: 50, plenos: 1, semiplenos: 2 },
        { id: B.id, name: 'Mateo', score: 999, plenos: 3, semiplenos: 0 },
        { id: 'prueba-1', name: 'Prueba 1', score: 80, plenos: 0, semiplenos: 0 },
      ],
    });
    const pa = await posA;
    const pb = await posB;
    assert.deepEqual(pa, { id: A.id, puntaje: 50, puestoHoy: 2, puestoSiempre: 2, esRecordPersonal: false, esRecordHistorico: false });
    assert.equal(pb.puntaje, 90); // acotado al máximo de 3 frames
    assert.equal(pb.esRecordHistorico, true);
    const u = await upd;
    assert.deepEqual(u.siempre.map((r) => r.nombre), ['Mateo', 'Lucía']);
    assert.deepEqual(u.ultimaPartida.map((x) => x.id), [A.id, B.id]);
  });

  await t.test('un game:over que no viene del tótem se ignora', async () => {
    a.emit('game:over', { jugadores: [{ id: A.id, score: 90 }] });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.leaderboard.listar().length, 2);
  });

  await t.test('rutas públicas del ranking', async () => {
    const todas = await (await fetch(url + '/api/leaderboard')).json();
    assert.equal(todas.hoy.length, 2);
    const hoy = await (await fetch(url + '/api/leaderboard?tabla=hoy')).json();
    assert.deepEqual(hoy.lista.map((r) => r.puesto), [1, 2]);
    const jug = await (await fetch(url + '/api/leaderboard?tabla=jugadores')).json();
    assert.equal(jug.lista[0].partidas, 1);
    assert.equal((await fetch(url + '/api/leaderboard?tabla=nada')).status, 400);
    const h = await (await fetch(url + '/api/jugador/LUCIA')).json();
    assert.equal(h.partidas, 1);
    assert.equal(h.lista[0].puntaje, 50);
    assert.equal((await fetch(url + '/api/jugador/nadie')).status, 404);
  });

  await t.test('admin: PIN, listar, exportar, borrar y reiniciar', async () => {
    assert.equal((await fetch(url + '/api/admin/puntajes')).status, 401);
    assert.equal((await admin('/puntajes', {}, '0000')).status, 401);
    const lista = (await (await admin('/puntajes')).json()).lista;
    assert.equal(lista.length, 2);

    const csv = await admin('/export.csv');
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="?puntajes-bowling-\d{4}-\d\d-\d\d\.csv/);
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf', 'BOM para Excel');
    assert.ok(bytes.subarray(3).toString().startsWith('Fecha;'));

    const upd = next(totem, 'leaderboard:update');
    const lucia = lista.find((r) => r.nombre === 'Lucía');
    assert.equal((await admin('/puntajes/' + lucia.id, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await upd).siempre.map((r) => r.nombre), ['Mateo']);
    assert.equal((await admin('/puntajes/' + lucia.id, { method: 'DELETE' })).status, 404);

    const json = { method: 'POST', headers: { 'content-type': 'application/json' } };
    assert.equal((await admin('/reiniciar', Object.assign({ body: '{}' }, json))).status, 400);
    const r = await (await admin('/reiniciar', Object.assign({ body: '{"confirmar":"REINICIAR"}' }, json))).json();
    assert.equal(r.ok, true);
    assert.match(r.archivado, /^archivo/);
    assert.equal((await (await admin('/puntajes')).json()).lista.length, 0);
  });

  await t.test('admin: 5 PIN errados bloquean un minuto', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await admin('/puntajes', {}, 'mal')).status, 401);
    assert.equal((await admin('/puntajes')).status, 429);
  });

  a.close(); b.close(); totem.close();
});

test('robustez: mensajes malformados no tiran abajo el servidor', async () => {
  const srv = createBowlingServer(CONFIG, { silent: true, dataDir: carpetaTemporal() });
  const url = `http://127.0.0.1:${await srv.start(0)}`;
  try {
    const totem = await client(url);
    totem.emit('totem:hello');
    const a = await client(url);
    // nombre que no se puede convertir a texto
    const r = await a.emitWithAck('player:join', { name: { toString: 1 } });
    assert.equal(r.ok, false);
    const A = await join(a, 'Ana');
    assert.equal(A.ok, true);
    totem.emit('game:state', state('playing', A.id));
    await new Promise((res) => setTimeout(res, 80));
    // números que no se pueden convertir, en su turno
    a.emit('player:aim', { position: { valueOf: 1, toString: 1 } });
    a.emit('player:throw', { power: { valueOf: 1, toString: 1 }, aim: [], spin: 'x' });
    totem.emit('game:state', 42);
    totem.emit('game:over', { jugadores: [{ id: { toString: 1 }, score: { valueOf: 1 } }] });
    await new Promise((res) => setTimeout(res, 150));
    assert.equal((await fetch(url + '/api/config')).status, 200, 'el servidor sigue vivo');
    const b = await client(url);
    assert.equal((await join(b, 'Beto')).ok, true, 'y sigue atendiendo sockets');
    a.close(); b.close(); totem.close();
  } finally {
    await srv.close();
  }
});

test('loadConfig: tipos inválidos vuelven al valor por defecto', () => {
  const dir = carpetaTemporal();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ nombreEscuela: null, creditos: 123, frames: 99, maxJugadores: 'seis', puerto: -1, segundosPorTurno: 0, pinAdmin: 1234 }));
  const c = loadConfig(file);
  assert.equal(typeof c.nombreEscuela, 'string');
  assert.equal(typeof c.creditos, 'string');
  assert.equal(c.frames, 3);
  assert.equal(c.maxJugadores, 6);
  assert.equal(c.puerto, 3000);
  assert.equal(c.segundosPorTurno, 25);
  assert.equal(c.pinAdmin, '1234', 'un PIN numérico se acepta como texto');
});

test('robustez: si no se puede escribir el archivo de puntajes, el servidor sigue vivo', async () => {
  const dir = carpetaTemporal();
  const srv = createBowlingServer(CONFIG, { silent: true, dataDir: dir });
  const url = `http://127.0.0.1:${await srv.start(0)}`;
  try {
    fs.writeFileSync(path.join(dir, 'puntajes.jsonl'), '');
    fs.chmodSync(path.join(dir, 'puntajes.jsonl'), 0o444);
    const totem = await client(url);
    totem.emit('totem:hello');
    const a = await client(url);
    const A = await join(a, 'Ana');
    totem.emit('game:state', state('playing', A.id));
    totem.emit('game:state', Object.assign(state('results', null), { results: [] }));
    totem.emit('game:over', { frames: 3, jugadores: [{ id: A.id, name: 'Ana', score: 40, plenos: 1, semiplenos: 0 }] });
    await new Promise((res) => setTimeout(res, 150));
    assert.equal((await fetch(url + '/api/config')).status, 200);
    a.close(); totem.close();
  } finally {
    fs.chmodSync(path.join(dir, 'puntajes.jsonl'), 0o644);
    await srv.close();
  }
});

test('lobby y partida: desconexiones, espectadores, tótems y tiros confirmados', async (t) => {
  const srv = createBowlingServer(Object.assign({}, CONFIG, { maxJugadores: 2 }), { silent: true, dataDir: carpetaTemporal(), lobbyGraceMs: 100 });
  const url = `http://127.0.0.1:${await srv.start(0)}`;
  t.after(() => srv.close());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const totem = await client(url);
  const hola = await totem.emitWithAck('totem:hello');
  assert.equal(hola.nuevo, true, 'servidor recién arrancado: sin jugadores ni partida');

  await t.test('el tótem no puede unirse como jugador', async () => {
    const r = await totem.emitWithAck('player:join', { name: 'Intruso' });
    assert.equal(r.ok, false);
  });

  const a = await client(url);
  const b = await client(url);
  const c = await client(url);
  const A = await join(a, 'Ana');
  const B = await join(b, 'Beto');
  const C = await join(c, 'Caro');
  assert.equal(C.spectator, true);

  await t.test('si alguien se va del lobby, el espectador pasa a jugar', async () => {
    b.close();
    await sleep(250);
    const caro = srv.lobby.players.find((p) => p.id === C.id);
    assert.equal(caro.spectator, false);
    assert.ok(!srv.lobby.players.some((p) => p.id === B.id));
  });

  await t.test('un jugador que se desconecta en el lobby no se borra si la partida empieza', async () => {
    c.close();
    totem.emit('game:state', state('playing', A.id));
    await sleep(250);
    assert.ok(srv.lobby.players.some((p) => p.id === C.id), 'Caro sigue en la partida');
  });

  await t.test('player:throw confirma si el tiro llegó al tótem', async () => {
    const ok = await a.emitWithAck('player:throw', { power: 0.5 });
    assert.equal(ok.ok, true);
    const repetido = await a.emitWithAck('player:throw', { power: 0.5 });
    assert.equal(repetido.ok, false, 'el límite de 1 por segundo también se avisa');
  });

  let t2;
  await t.test('un segundo tótem reemplaza al primero y le avisa', async () => {
    t2 = await client(url);
    const aviso = next(totem, 'totem:replaced');
    const r = await t2.emitWithAck('totem:hello');
    assert.equal(r.nuevo, false);
    await aviso;
    totem.emit('game:over', { partidaId: 'x', jugadores: [{ id: A.id, score: 90 }] });
    await sleep(100);
    assert.equal(srv.leaderboard.listar().length, 0, 'el tótem viejo ya no guarda');
  });

  await t.test('game:over: una sola vez por partidaId, por nombre si el id no se conoce', async () => {
    const over = { partidaId: 'p-123', frames: 3, jugadores: [
      { id: A.id, name: 'Ana', score: 40, plenos: 1, semiplenos: 0 },
      { id: 'id-de-otro-servidor', name: 'Zoe', score: 30, plenos: 0, semiplenos: 1 },
      { id: 'id-viejo-2', name: 'P0rong4', score: 50, plenos: 0, semiplenos: 0 },
      { id: 'prueba-1', name: 'Prueba 1', score: 70, plenos: 0, semiplenos: 0 },
    ] };
    t2.emit('game:over', over);
    t2.emit('game:over', over);
    await sleep(150);
    const nombres = srv.leaderboard.listar().map((r) => r.nombre).sort();
    assert.deepEqual(nombres, ['Ana', 'Zoe']);
  });
  t2.close();
  a.close(); totem.close();
});

test('game:over reenviado después de reiniciar el servidor no duplica puntajes', async () => {
  const dir = carpetaTemporal();
  const over = { partidaId: 'p-reenvio-1', frames: 3, jugadores: [{ id: 'x1', name: 'Lola', score: 40, plenos: 1, semiplenos: 0 }] };
  for (let vez = 0; vez < 2; vez++) {
    const srv = createBowlingServer(CONFIG, { silent: true, dataDir: dir });
    const url = `http://127.0.0.1:${await srv.start(0)}`;
    const totem = await client(url);
    await totem.emitWithAck('totem:hello');
    totem.emit('game:over', over);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(srv.leaderboard.listar().length, 1, 'vez ' + (vez + 1));
    totem.close();
    await srv.close();
  }
});
