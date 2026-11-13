/*
 * Servidor del Bowling Tótem: sirve las páginas, maneja el lobby y reenvía mensajes
 * entre el tótem (autoridad del juego) y los celulares. No simula nada.
 *
 *   npm start            → usa config.json
 *   IP_TOTEM=192.168.0.5 npm start   → fuerza la IP que va en el QR
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { createLeaderboard, fechaLocal, TABLAS } = require('./leaderboard.js');

const PUBLIC = path.join(__dirname, 'public');
const LOGO = path.join(PUBLIC, 'logo.png'); // lo pone la escuela; es opcional

const DEFAULTS = {
  nombreEscuela: 'Bowling',
  frames: 3,
  maxJugadores: 6,
  puerto: 3000,
  segundosPorTurno: 25,
  pinAdmin: '1234',
  segundosRotacionRanking: 8,
  creditos: 'Hecho por 5ºI Informática',
};
const COLORS = ['#3FB6E0', '#EE6A5B', '#F2C14E', '#5DBF7A', '#A98BE8', '#E98AB8']; // colores de jugador (paleta Institucional Nº4)
const SPECTATOR_COLOR = '#7F97AD';
const REACTIONS = ['👏', '🔥', '😂', '😱', '🎳'];
const PHASES = ['lobby', 'countdown', 'playing', 'results'];
const LOBBY_GRACE_MS = 20000; // en el lobby, un jugador desconectado se borra después de esto
const AIM_MIN_MS = 40;        // máx. ~25 mensajes de apuntado por segundo
const THROW_MIN_MS = 1000;
const REACT_MIN_MS = 2000;
const MAX_ESPECTADORES = 30;  // tope para que nadie pueda llenar el lobby con conexiones
const ADMIN_MAX_FALLOS = 5;     // PIN errados seguidos antes de bloquear
const ADMIN_BLOQUEO_MS = 60000; // bloqueo del panel de admin para esa IP
const ADMIN_OLVIDO_MS = 15 * 60000; // PIN errados de hace más de esto ya no cuentan

function loadConfig(file) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file || path.join(__dirname, 'config.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('No se pudo leer config.json, uso valores por defecto:', err.message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  const config = { ...DEFAULTS };
  // cada valor se valida: un config.json mal editado no tiene que romper el servidor ni el tótem
  const texto = (k) => {
    if (data[k] === undefined) return;
    if (typeof data[k] === 'string' || typeof data[k] === 'number') config[k] = String(data[k]);
    else console.warn(`config.json: "${k}" tiene que ser un texto; uso "${DEFAULTS[k]}".`);
  };
  const entero = (k, min, max) => {
    if (data[k] === undefined) return;
    const n = Number(data[k]);
    if (typeof data[k] === 'number' && Number.isInteger(n) && n >= min && n <= max) config[k] = n;
    else console.warn(`config.json: "${k}" tiene que ser un número entero entre ${min} y ${max}; uso ${DEFAULTS[k]}.`);
  };
  ['nombreEscuela', 'pinAdmin', 'creditos'].forEach(texto);
  entero('frames', 1, 10);
  entero('maxJugadores', 1, 6);
  entero('puerto', 1, 65535);
  entero('segundosPorTurno', 5, 300);
  entero('segundosRotacionRanking', 2, 120);
  if (!config.pinAdmin) config.pinAdmin = DEFAULTS.pinAdmin;
  if (process.env.PORT) {
    const n = Number(process.env.PORT);
    if (Number.isInteger(n) && n > 0 && n < 65536) config.puerto = n;
  }
  return config;
}

/** IPv4 de la red local, ignorando loopback e interfaces virtuales (Docker, VPN, VirtualBox…) */
function localIp() {
  const skip = /^(lo|docker|br-|veth|virbr|vboxnet|vmnet|tun|tap|wg|tailscale|zt|utun)/i;
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) found.push(a.address);
    }
  }
  const lan = found.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return lan || found[0] || '127.0.0.1';
}

/** Nombre: espacios colapsados, 2 a 14 letras, números o espacios (sin HTML posible) */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N} ]{2,14}$/u.test(name) ? name : null;
}

function clampNum(v, min, max, def) {
  if (typeof v !== 'number' && typeof v !== 'string') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

function createBowlingServer(config, opts) {
  config = config || loadConfig();
  opts = opts || {};
  const log = opts.silent ? () => {} : (...a) => console.log(...a);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const ip = process.env.IP_TOTEM || localIp();
  let port = config.puerto;
  const joinUrl = () => `http://${ip}:${port}/j`;
  const lb = createLeaderboard({ dir: opts.dataDir || path.join(__dirname, 'data'), frames: config.frames });

  // ---------- Rutas HTTP ----------
  let qrCache = { url: null, png: null };
  app.get('/qr.png', async (req, res, next) => {
    try {
      const url = joinUrl();
      if (qrCache.url !== url) {
        qrCache = { url, png: await QRCode.toBuffer(url, { width: 640, margin: 2 }) };
      }
      res.type('png').set('Cache-Control', 'no-cache').send(qrCache.png);
    } catch (err) { next(err); }
  });
  app.get('/api/config', (req, res) => {
    res.json({
      nombreEscuela: config.nombreEscuela,
      frames: config.frames,
      maxJugadores: config.maxJugadores,
      segundosPorTurno: config.segundosPorTurno,
      segundosRotacionRanking: config.segundosRotacionRanking,
      urlJuego: joinUrl(),
      creditos: config.creditos,
      logo: fs.existsSync(LOGO), // así el tótem no pide /logo.png si no está (evita un 404 en la consola)
    });
  });
  app.get('/logo.png', (req, res) => {
    if (!fs.existsSync(LOGO)) return res.status(404).end();
    res.set('Cache-Control', 'no-cache').sendFile(LOGO);
  });
  app.get('/vendor/matter.min.js', (req, res) => {
    res.sendFile(require.resolve('matter-js/build/matter.min.js'));
  });
  app.get('/api/leaderboard', (req, res) => {
    const tabla = req.query.tabla;
    const n = clampNum(req.query.n, 1, 100, 10);
    if (tabla == null) return res.json(lb.tablas());
    if (tabla === 'jugadores') return res.json({ tabla, frames: config.frames, lista: lb.jugadores(n) });
    if (!TABLAS.includes(tabla)) return res.status(400).json({ error: 'Tabla desconocida.' });
    res.json({ tabla, frames: config.frames, lista: lb.top(tabla, n) });
  });
  app.get('/api/jugador/:nombre', (req, res) => {
    const h = lb.historial(req.params.nombre);
    if (!h) return res.status(404).json({ error: 'No hay partidas con ese nombre.' });
    res.json(h);
  });

  // ---------- Admin (protegido con el PIN de config.json) ----------
  const fallos = new Map(); // ip → { n, hasta }
  function pinCorrecto(pin) {
    const a = Buffer.from(String(pin || ''));
    const b = Buffer.from(String(config.pinAdmin));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  app.use('/api/admin', (req, res, next) => {
    const now = Date.now();
    let f = fallos.get(req.ip);
    if (!f || (f.hasta <= now && now - f.ultimo > ADMIN_OLVIDO_MS)) f = { n: 0, hasta: 0, ultimo: 0 }; // los errores viejos se olvidan
    if (f.hasta > now) return res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto.' });
    if (!pinCorrecto(req.get('x-pin'))) {
      f.n += 1;
      f.ultimo = now;
      if (f.n >= ADMIN_MAX_FALLOS) { f.n = 0; f.hasta = now + ADMIN_BLOQUEO_MS; }
      fallos.set(req.ip, f);
      return res.status(401).json({ error: 'PIN incorrecto.' });
    }
    fallos.delete(req.ip);
    next();
  });
  app.get('/api/admin/puntajes', (req, res) => res.json({ frames: config.frames, lista: lb.listar() }));
  app.delete('/api/admin/puntajes/:id', (req, res) => {
    if (!lb.borrar(req.params.id)) return res.status(404).json({ error: 'No existe ese puntaje.' });
    log(`Admin: se borró el puntaje ${req.params.id}.`);
    broadcastLeaderboard();
    res.json({ ok: true });
  });
  app.get('/api/admin/export.csv', (req, res) => {
    const dia = fechaLocal(Date.now()).slice(0, 10);
    res.type('text/csv; charset=utf-8')
      .attachment(`puntajes-bowling-${dia}.csv`)
      .send(lb.csv());
  });
  app.post('/api/admin/reiniciar', express.json(), (req, res) => {
    if (!req.body || req.body.confirmar !== 'REINICIAR') {
      return res.status(400).json({ error: 'Falta la confirmación.' });
    }
    const archivado = lb.reiniciar();
    log(`Admin: leaderboard reiniciado${archivado ? ' (archivado en data/' + archivado + ')' : ''}.`);
    broadcastLeaderboard();
    res.json({ ok: true, archivado });
  });

  // tipografías Barlow empaquetadas (andan sin internet)
  app.use('/fonts/barlow', express.static(path.join(path.dirname(require.resolve('@fontsource/barlow/package.json')), 'files')));
  app.use('/fonts/barlow-condensed', express.static(path.join(path.dirname(require.resolve('@fontsource/barlow-condensed/package.json')), 'files')));
  app.use('/shared', express.static(path.join(PUBLIC, 'shared')));
  app.use('/j', express.static(path.join(PUBLIC, 'control')));
  app.use('/ranking', express.static(path.join(PUBLIC, 'ranking')));
  app.use('/admin', express.static(path.join(PUBLIC, 'admin')));
  app.use('/', express.static(path.join(PUBLIC, 'totem')));
  // errores (por ejemplo, un JSON mal formado): respuesta corta, sin mostrar trazas
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('Error en', req.method, req.path, err);
    res.status(status).json({ error: status >= 500 ? 'Error interno del servidor.' : 'Pedido inválido.' });
  });

  // ---------- Lobby ----------
  const lobby = { phase: 'lobby', players: [], totem: null, lastState: null };

  const publicPlayer = (p) => ({
    id: p.id, name: p.name, color: p.color, host: p.host, connected: p.connected, spectator: p.spectator,
  });
  const lobbyPayload = () => ({
    phase: lobby.phase,
    totemConnected: !!lobby.totem,
    maxJugadores: config.maxJugadores,
    players: lobby.players.map(publicPlayer),
  });
  const broadcastLobby = () => io.emit('lobby:update', lobbyPayload());
  const broadcastLeaderboard = (extra) => io.emit('leaderboard:update', Object.assign(lb.tablas(), extra));
  const activePlayers = () => lobby.players.filter((p) => !p.spectator);
  const playerOf = (socket) => lobby.players.find((p) => p.id === socket.data.playerId && p.socketId === socket.id);
  const isTotem = (socket) => socket.id === lobby.totem;
  const toTotem = (event, data) => { if (lobby.totem) io.to(lobby.totem).emit(event, data); };
  const isTurnOf = (p) => lobby.phase === 'playing' && lobby.lastState && lobby.lastState.currentPlayerId === p.id;

  function freeColor() {
    const used = new Set(activePlayers().map((p) => p.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[activePlayers().length % COLORS.length];
  }

  /** El anfitrión es el primer jugador conectado (se conserva mientras siga conectado) */
  function assignHost() {
    const act = activePlayers();
    const keep = act.find((p) => p.host && p.connected);
    lobby.players.forEach((p) => { p.host = false; });
    const host = keep || act.find((p) => p.connected);
    if (host) host.host = true;
  }

  function removePlayer(p) {
    clearTimeout(p.removeTimer);
    lobby.players = lobby.players.filter((x) => x !== p);
  }

  /** Al volver al lobby: se van los desconectados y los espectadores pasan a jugar */
  /** Los espectadores pasan a jugar mientras haya lugar */
  function promoteSpectators() {
    lobby.players.forEach((p) => {
      if (p.spectator && activePlayers().length < config.maxJugadores) {
        p.spectator = false;
        p.color = freeColor();
      }
    });
  }

  function backToLobby() {
    lobby.players.filter((p) => !p.connected).forEach(removePlayer);
    promoteSpectators();
    lobby.lastState = null;
    assignHost();
  }

  io.on('connection', (socket) => {
    // Socket.io no atrapa errores en los handlers: uno solo tiraba abajo todo el servidor.
    const on = (event, fn) => socket.on(event, (...args) => {
      try { fn(...args); } catch (err) { console.error(`Error atendiendo "${event}":`, err && err.stack ? err.stack : err); }
    });
    on('totem:hello', (ack) => {
      if (playerOf(socket)) return; // un socket que ya es jugador no puede ser el tótem
      if (lobby.totem && lobby.totem !== socket.id) {
        log('Se conectó otro tótem; reemplaza al anterior.');
        io.to(lobby.totem).emit('totem:replaced'); // la pestaña vieja deja de jugar sola
      }
      // "nuevo": el servidor no tiene jugadores ni partida (recién arrancado o reiniciado)
      const nuevo = lobby.players.length === 0 && !lobby.lastState;
      lobby.totem = socket.id;
      socket.data.role = 'totem';
      log('Tótem conectado.');
      broadcastLobby();
      socket.emit('leaderboard:update', lb.tablas());
      if (typeof ack === 'function') ack({ nuevo });
    });

    on('player:join', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      data = data || {};
      if (isTotem(socket)) return reply({ ok: false, error: 'Esta pantalla es el tótem.' });
      const name = cleanName(data.name);
      if (!name) return reply({ ok: false, error: 'El nombre tiene que tener entre 2 y 14 letras o números.' });
      const token = typeof data.token === 'string' && /^[\w-]{8,64}$/.test(data.token) ? data.token : null;

      const current = playerOf(socket);
      let p = token && lobby.players.find((x) => x.token === token);
      if (current && current !== p) return reply({ ok: false, error: 'Ya estás en la partida.' });
      if (!lb.nombrePermitido(name)) return reply({ ok: false, error: 'Ese nombre no está permitido. Elegí otro.' });
      if (!p && lobby.players.filter((x) => x.spectator).length >= MAX_ESPECTADORES &&
          (lobby.phase !== 'lobby' || activePlayers().length >= config.maxJugadores)) {
        return reply({ ok: false, error: 'Hay demasiada gente esperando. Probá en un rato.' });
      }

      if (p) {
        // reconexión: recupera su lugar; si tenía otra pestaña abierta, la desconecta
        if (p.socketId && p.socketId !== socket.id) {
          const old = io.sockets.sockets.get(p.socketId);
          p.socketId = null;
          if (old) old.disconnect(true);
        }
        clearTimeout(p.removeTimer);
        p.connected = true;
        p.socketId = socket.id;
        if (lobby.phase === 'lobby') p.name = name;
        log(`Volvió ${p.name}.`);
      } else {
        const spectator = lobby.phase !== 'lobby' || activePlayers().length >= config.maxJugadores;
        p = {
          id: crypto.randomBytes(4).toString('hex'),
          token: token || crypto.randomUUID(),
          name,
          color: spectator ? SPECTATOR_COLOR : freeColor(),
          host: false,
          connected: true,
          spectator,
          socketId: socket.id,
          lastAim: 0,
          lastThrow: 0,
          lastReact: 0,
        };
        lobby.players.push(p);
        log(`Entró ${p.name}${spectator ? ' (espectador)' : ''}.`);
      }
      socket.data.playerId = p.id;
      socket.join('players');
      assignHost();
      reply({ ok: true, id: p.id, token: p.token, color: p.color, spectator: p.spectator, host: p.host });
      broadcastLobby();
      if (lobby.lastState) socket.emit('game:state', lobby.lastState);
    });

    on('game:start', (...args) => {
      // se puede mandar con o sin datos: el callback es el último argumento
      const last = args[args.length - 1];
      const reply = typeof last === 'function' ? last : () => {};
      const p = playerOf(socket);
      if (!p || !p.host) return reply({ ok: false, error: 'Solo el anfitrión puede empezar.' });
      if (lobby.phase !== 'lobby') return reply({ ok: false, error: 'Ya hay una partida en curso.' });
      if (!lobby.totem) return reply({ ok: false, error: 'El tótem no está conectado.' });
      toTotem('game:start', { by: p.id });
      reply({ ok: true });
    });

    on('game:state', (state) => {
      if (!isTotem(socket) || !state || !PHASES.includes(state.phase)) return;
      const prev = lobby.phase;
      lobby.phase = state.phase;
      lobby.lastState = state.phase === 'lobby' ? null : state;
      if (state.phase === 'lobby' && prev !== 'lobby') backToLobby();
      io.to('players').emit('game:state', state);
      if (state.phase !== prev) broadcastLobby();
    });

    on('player:aim', (data) => {
      const p = playerOf(socket);
      const now = Date.now();
      if (!p || !isTurnOf(p) || now - p.lastAim < AIM_MIN_MS) return;
      p.lastAim = now;
      toTotem('player:aim', { playerId: p.id, position: clampNum(data && data.position, -1, 1, 0) });
    });

    on('player:throw', (data, ack) => {
      // el celu espera esta confirmación: si no llega u ok es false, vuelve a dejar tirar
      const reply = typeof ack === 'function' ? ack : () => {};
      const p = playerOf(socket);
      const now = Date.now();
      if (!p || !isTurnOf(p) || now - p.lastThrow < THROW_MIN_MS || !lobby.totem) return reply({ ok: false });
      p.lastThrow = now;
      data = data && typeof data === 'object' ? data : {};
      reply({ ok: true });
      toTotem('player:throw', {
        playerId: p.id,
        power: clampNum(data.power, 0, 1, 0.6),
        aim: clampNum(data.aim, -1, 1, 0),
        spin: clampNum(data.spin, -1, 1, 0),
        position: clampNum(data.position, -1, 1, 0),
      });
    });

    on('player:react', (data) => {
      const p = playerOf(socket);
      const now = Date.now();
      const emoji = data && data.emoji;
      if (!p || !REACTIONS.includes(emoji) || now - p.lastReact < REACT_MIN_MS) return;
      p.lastReact = now;
      toTotem('player:react', { playerId: p.id, name: p.name, color: p.color, emoji });
    });

    on('game:over', (results) => {
      if (!isTotem(socket)) return;
      const recibidos = results && Array.isArray(results.jugadores) ? results.jugadores.slice(0, config.maxJugadores) : [];
      // El tótem reenvía game:over si se cortó la conexión: cada partida se guarda una sola vez.
      const partidaId = results && typeof results.partidaId === 'string' ? results.partidaId.slice(0, 64) : null;
      if (partidaId && lb.tienePartida(partidaId)) return; // se busca en el archivo: vale aunque el servidor se haya reiniciado
      // Se guardan los jugadores que el servidor conoce, con el nombre que validó él. Si no conoce
      // el id (se reinició en medio), se acepta el nombre que manda el tótem pasándolo por el mismo
      // filtro que al unirse. Los de prueba del tótem nunca se guardan.
      const jugadores = [];
      recibidos.forEach((j) => {
        if (!j || typeof j.id !== 'string' || j.id.startsWith('prueba-')) return;
        const p = lobby.players.find((x) => x.id === j.id && !x.spectator);
        if (p) {
          if (!jugadores.some((x) => x.p === p)) jugadores.push({ p, nombre: p.name, puntaje: j.score, plenos: j.plenos, semiplenos: j.semiplenos });
          return;
        }
        const nombre = cleanName(j.name);
        if (!nombre || !lb.nombrePermitido(nombre) || jugadores.some((x) => !x.p && x.id === j.id)) return;
        jugadores.push({ p: null, id: j.id, nombre, puntaje: j.score, plenos: j.plenos, semiplenos: j.semiplenos });
      });
      const list = recibidos.map((j) => `${j && j.name}: ${j && j.score}`).join(', ');
      log(`Partida terminada → ${list || 'sin jugadores'}${jugadores.length ? '' : ' (no se guarda)'}`);
      if (!jugadores.length) return;

      let guardados;
      try {
        guardados = lb.guardarPartida(jugadores, partidaId);
      } catch (err) {
        console.error('No se pudieron guardar los puntajes (¿disco lleno o sin permiso en data/?):', err.message);
        return;
      }
      const posiciones = guardados.map((g, i) => ({
        id: jugadores[i].p ? jugadores[i].p.id : jugadores[i].id,
        puntaje: g.puntaje,
        puestoHoy: g.puestoHoy,
        puestoSiempre: g.puestoSiempre,
        esRecordPersonal: g.esRecordPersonal,
        esRecordHistorico: g.esRecordHistorico,
      }));
      broadcastLeaderboard({ ultimaPartida: posiciones });
      posiciones.forEach((pos, i) => {
        const p = jugadores[i].p;
        if (p && p.socketId) io.to(p.socketId).emit('leaderboard:position', pos);
      });
    });

    on('disconnect', () => {
      if (isTotem(socket)) {
        lobby.totem = null;
        log('Tótem desconectado.');
        broadcastLobby();
        return;
      }
      const p = playerOf(socket);
      if (!p) return;
      p.connected = false;
      p.socketId = null;
      log(`Se desconectó ${p.name}.`);
      if (lobby.phase === 'lobby') {
        p.removeTimer = setTimeout(() => {
          // si la partida ya empezó, no se borra: sigue en su lugar y backToLobby lo limpia después
          if (p.connected || !lobby.players.includes(p) || lobby.phase !== 'lobby') return;
          removePlayer(p);
          promoteSpectators();
          assignHost();
          broadcastLobby();
        }, opts.lobbyGraceMs != null ? opts.lobbyGraceMs : LOBBY_GRACE_MS);
      }
      assignHost();
      broadcastLobby();
    });
  });

  function start(listenPort) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort != null ? listenPort : config.puerto, () => {
        port = server.address().port;
        resolve(port);
      });
    });
  }

  function close() {
    lobby.players.forEach((p) => clearTimeout(p.removeTimer));
    return new Promise((resolve) => { io.close(() => resolve()); });
  }

  return { app, server, io, lobby, leaderboard: lb, start, close, joinUrl };
}

if (require.main === module) {
  const config = loadConfig();
  const bowling = createBowlingServer(config);
  bowling.start().then((port) => {
    console.log('');
    console.log(`  🎳 Bowling Tótem — ${config.nombreEscuela}`);
    console.log(`  Tótem (abrir en esta compu):  http://localhost:${port}`);
    console.log(`  Celulares (QR):               ${bowling.joinUrl()}`);
    console.log(`  Ranking:                      http://localhost:${port}/ranking`);
    console.log(`  Admin (PIN de config.json):   http://localhost:${port}/admin`);
    console.log('  Los celulares tienen que estar en la misma red wifi.');
    console.log('');
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`El puerto ${config.puerto} está ocupado. Cerrá el otro programa o cambiá "puerto" en config.json.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

module.exports = { createBowlingServer, loadConfig, localIp, cleanName };
