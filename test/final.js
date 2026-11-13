/*
 * Prueba final de punta a punta (etapa 8) con Playwright:
 *   - tótem (1080x1920) + 3 celulares emulados que se unen desde /j y tiran deslizando el dedo,
 *   - partida entera hasta los resultados,
 *   - uno se desconecta en su turno, pierde ese frame y vuelve con su lugar,
 *   - un cuarto celular entra con la partida empezada (espectador) y manda reacciones,
 *   - los 3 puntajes quedan en puntajes.jsonl, aparecen en /ranking y siguen ahí después de
 *     reiniciar el servidor,
 *   - ninguna página tiene errores en la consola.
 *
 *   npm run prueba:final   → capturas en capturas/ (f* = final). Usa una carpeta de datos temporal.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright');
const { createBowlingServer, loadConfig } = require('../server.js');

const OUT = path.join(__dirname, '..', 'capturas');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = ['Lucía', 'Mateo', 'Sofía'];

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('Tiempo agotado esperando: ' + what);
    await sleep(60);
  }
}

/** Desliza hacia arriba sobre la mini pista del celular (mismas cuentas que control.js) */
async function swipe(phone, curve) {
  const b = await phone.locator('#lane').boundingBox();
  const laneW = Math.min(b.width * 0.62, b.height * 0.4);
  const ballR = laneW * 0.075;
  const x0 = b.x + b.width / 2 + 30, y0 = b.y + b.height - Math.max(70, ballR * 3);
  const len = b.height * 0.5, steps = 14;
  await phone.mouse.move(x0, y0);
  await phone.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await phone.mouse.move(x0 + curve * Math.sin(Math.PI * f), y0 - len * f);
    await sleep(14);
  }
  await phone.mouse.up();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const config = loadConfig();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-final-'));
  const archivo = path.join(dataDir, 'puntajes.jsonl');
  let bowling = createBowlingServer(config, { silent: true, dataDir });
  const port = await bowling.start(0);
  const base = `http://127.0.0.1:${port}`;
  const reacciones = [];
  const espiar = (srv) => srv.io.on('connection', (s) => s.on('player:react', (d) => reacciones.push(d)));
  espiar(bowling);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  let reiniciando = false; // mientras el servidor está apagado, los pedidos fallidos son esperables
  const watchConsole = (page, who) => {
    page.on('console', (m) => {
      if (m.type() !== 'error' || /favicon/.test(m.location().url || '')) return;
      if (reiniciando && /ERR_CONNECTION_REFUSED|WebSocket|Failed to load resource/.test(m.text())) return;
      if (/Error en un cuadro del tótem \(sigue andando\)/.test(m.text()) && who === 'tótem') return; // el que forzamos
      errors.push(who + ': ' + m.text());
    });
    page.on('pageerror', (e) => errors.push(who + ': ' + e.message));
  };
  const nuevoCelu = async (who) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    watchConsole(page, who);
    return page;
  };

  try {
    // ---------- Tótem y 3 celulares ----------
    const totem = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    watchConsole(totem, 'tótem');
    await totem.goto(base + '/');
    await waitFor(() => bowling.lobby.totem, 5000, 'tótem conectado');

    // un error en un cuadro no puede congelar el tótem (antes el bucle se cortaba para siempre)
    const sigue = await totem.evaluate(() => new Promise((resolve) => {
      const G = window.bowlingGame;
      const orig = G.update;
      let una = true;
      G.update = function (dt) { if (una) { una = false; throw new Error('error forzado'); } return orig.call(this, dt); };
      const c0 = G.state.clock;
      setTimeout(() => { G.update = orig; resolve(G.state.clock - c0); }, 600);
    }));
    if (!(sigue > 200)) throw new Error('El tótem se congeló después de un error en un cuadro');
    console.log('✔ un error en un cuadro no congela el tótem');

    const phones = [];
    for (const name of NAMES) {
      const p = await nuevoCelu(name);
      await p.goto(base + '/j');
      await p.fill('#name', name);
      await p.tap('#join');
      await p.waitForSelector('#s-lobby.on');
      phones.push(p);
    }
    const ids = await Promise.all(NAMES.map((n) => waitFor(() => (bowling.lobby.players.find((x) => x.name === n) || {}).id, 3000, n)));
    await phones[0].waitForSelector('#start:not([disabled])');
    await sleep(400);
    await totem.screenshot({ path: path.join(OUT, 'f1-lobby-3-jugadores.png') });
    console.log('✔ 3 celulares unidos:', NAMES.join(', '));

    await phones[0].tap('#start');
    await waitFor(() => bowling.lobby.phase === 'playing', 8000, 'que empiece la partida');

    // ---------- Espectador con reacciones ----------
    const espectador = await nuevoCelu('espectador');
    await espectador.goto(base + '/j');
    await espectador.fill('#name', 'Juana');
    await espectador.tap('#join');
    await espectador.waitForSelector('#s-watch.on');
    const juana = bowling.lobby.players.find((x) => x.name === 'Juana');
    if (!juana || !juana.spectator) throw new Error('Juana debería entrar como espectadora');
    for (const emoji of ['👏', '🔥']) {
      await espectador.tap(`button[data-emoji="${emoji}"]`);
      await sleep(2100); // máx. 1 reacción cada 2 s
    }
    await sleep(300);
    await totem.screenshot({ path: path.join(OUT, 'f2-reacciones.png') });
    await espectador.screenshot({ path: path.join(OUT, 'f3-espectador.png') });
    if (reacciones.filter((r) => r.emoji).length < 2) throw new Error('No llegaron las reacciones del espectador');
    console.log('✔ espectadora Juana mandó', reacciones.map((r) => r.emoji).join(' '));

    // ---------- Partida entera tirando desde los celulares ----------
    const estado = () => totem.evaluate(() => {
      const g = window.bowlingGame;
      const p = g.currentPlayer();
      return {
        phase: g.state.phase, turn: g.state.turn && g.state.turn.state, who: p && p.id,
        frame: g.state.turn && g.state.turn.frameIdx + 1, notice: g.state.notice && g.state.notice.text,
      };
    });
    let desconectado = false, gestos = 0, espacios = 0;
    const t0 = Date.now();
    while (bowling.lobby.phase !== 'results') {
      if (Date.now() - t0 > 300000) throw new Error('La partida no terminó en 5 minutos');
      const st = await estado();
      if (st.phase !== 'playing' || st.turn !== 'aiming') { await sleep(80); continue; }
      const i = ids.indexOf(st.who);

      if (!desconectado && i === 1 && st.frame === 2) {
        // Mateo se va en su turno: a los 5 s pierde el frame; después vuelve con el mismo token
        await phones[1].goto('about:blank');
        await waitFor(async () => (await estado()).who !== ids[1], 9000, 'que se saltee el turno de Mateo');
        const aviso = (await estado()).notice;
        await totem.screenshot({ path: path.join(OUT, 'f4-turno-salteado.png') });
        await phones[1].goto(base + '/j');
        await phones[1].waitForSelector('#s-watch.on, #s-play.on', { timeout: 5000 });
        const nombre = await phones[1].textContent('[data-myname]');
        if (nombre !== 'Mateo') throw new Error('Mateo no recuperó su lugar: ' + nombre);
        const mismo = bowling.lobby.players.find((x) => x.id === ids[1]);
        if (!mismo || !mismo.connected) throw new Error('Mateo no volvió con el mismo jugador');
        desconectado = true;
        console.log(`✔ Mateo se desconectó, perdió el frame 2 (${aviso || 'turno salteado'}) y volvió con su lugar`);
        continue;
      }

      const phone = phones[i];
      let salio = false;
      if (phone && await phone.isVisible('#s-play.on')) {
        await swipe(phone, -25);
        salio = await waitFor(async () => (await estado()).turn !== 'aiming', 2500, 'tiro').catch(() => false);
        if (salio) gestos++;
      }
      if (!salio) { await totem.keyboard.press('Space'); espacios++; }
      await waitFor(async () => (await estado()).turn !== 'aiming', 4000, 'que salga el tiro');
    }
    if (!desconectado) throw new Error('No se probó la desconexión');
    console.log(`✔ partida terminada: ${gestos} tiros deslizando en el celu, ${espacios} con Espacio (respaldo)`);

    // ---------- Resultados y puestos ----------
    await waitFor(() => fs.existsSync(archivo) && fs.readFileSync(archivo, 'utf8').trim().split('\n').length >= 3, 5000, 'puntajes guardados');
    await Promise.all(phones.map((p) => p.waitForSelector('.puesto', { timeout: 5000 })));
    await sleep(1800);
    await totem.screenshot({ path: path.join(OUT, 'f5-resultados.png') });
    await phones[0].screenshot({ path: path.join(OUT, 'f6-celu-resultados.png') });
    const guardados = fs.readFileSync(archivo, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    if (guardados.length !== 3) throw new Error(`Se esperaban 3 puntajes y hay ${guardados.length}`);
    if (guardados.some((r) => r.nombre === 'Juana')) throw new Error('La espectadora no debería tener puntaje');
    for (const n of NAMES) if (!guardados.some((r) => r.nombre === n)) throw new Error('Falta el puntaje de ' + n);
    const mateo = guardados.find((r) => r.nombre === 'Mateo');
    console.log('✔ 3 puntajes en puntajes.jsonl:', guardados.map((r) => `${r.nombre} ${r.puntaje}`).join(', '));

    // ---------- /ranking ----------
    const rk = await nuevoCelu('ranking');
    await rk.goto(base + '/ranking/');
    await rk.waitForSelector('#lista .row');
    const enRanking = await rk.locator('#lista .row button.name').allTextContents();
    for (const n of NAMES) if (!enRanking.some((t) => t.startsWith(n))) throw new Error(n + ' no aparece en /ranking');
    await rk.screenshot({ path: path.join(OUT, 'f7-ranking.png') });
    console.log('✔ los 3 aparecen en /ranking');

    // ---------- Un celu pierde la conexión en los resultados y vuelve con el tótem en el lobby ----------
    // (sin recargar la página: antes quedaba trabado en los resultados viejos)
    await phones[0].waitForSelector('#s-watch.on');
    const lucia = bowling.lobby.players.find((x) => x.name === 'Lucía');
    bowling.io.sockets.sockets.get(lucia.socketId).conn.close(); // se corta como con la pantalla bloqueada
    await totem.keyboard.press('r'); // el tótem vuelve al lobby mientras ella está desconectada
    await waitFor(() => bowling.lobby.phase === 'lobby', 5000, 'lobby');
    await phones[0].waitForSelector('#s-lobby.on', { timeout: 8000 });
    // el anfitrión (quien haya quedado) puede arrancar otra partida
    await waitFor(() => bowling.lobby.players.some((x) => x.host && x.connected), 5000, 'que haya anfitrión');
    const anfitrion = bowling.lobby.players.find((x) => x.host);
    const celuAnfitrion = phones[NAMES.indexOf(anfitrion.name)];
    await celuAnfitrion.waitForSelector('#s-lobby.on', { timeout: 5000 });
    await celuAnfitrion.waitForSelector('#start:not([disabled])', { timeout: 5000 });
    await celuAnfitrion.tap('#start');
    await waitFor(() => bowling.lobby.phase === 'countdown' || bowling.lobby.phase === 'playing', 5000, 'que arranque la segunda partida');
    await totem.keyboard.press('r');
    await waitFor(() => bowling.lobby.phase === 'lobby', 5000, 'lobby otra vez');
    console.log(`✔ Lucía se reconectó con el tótem ya en el lobby y ve el lobby (no los resultados viejos); ${anfitrion.name} arrancó otra partida`);

    // ---------- Reiniciar el servidor: los puntajes siguen ----------
    reiniciando = true;
    await bowling.close();
    bowling = createBowlingServer(config, { silent: true, dataDir });
    await bowling.start(port);
    espiar(bowling);
    await waitFor(() => bowling.lobby.totem, 15000, 'que el tótem se reconecte al servidor nuevo');
    await sleep(500);
    reiniciando = false;
    const hoy = await (await fetch(base + '/api/leaderboard?tabla=hoy')).json();
    for (const n of NAMES) if (!hoy.lista.some((r) => r.nombre === n)) throw new Error(n + ' se perdió al reiniciar');
    if (hoy.lista.find((r) => r.nombre === 'Mateo').puntaje !== mateo.puntaje) throw new Error('Cambió el puntaje de Mateo');
    await rk.reload();
    await rk.waitForSelector('#lista .row');
    if ((await rk.locator('#lista .row').count()) !== 3) throw new Error('/ranking no muestra los 3 después de reiniciar');
    await waitFor(() => totem.evaluate(() => window.bowlingGame.state.phase === 'lobby'), 20000, 'tótem en el lobby');
    await sleep(1200);
    await totem.screenshot({ path: path.join(OUT, 'f8-lobby-despues-de-reiniciar.png') });
    console.log('✔ después de reiniciar el servidor los puntajes siguen y el tótem se reconectó solo');

    if (errors.length) throw new Error('Errores en la consola:\n' + errors.join('\n'));
    console.log('✔ sin errores en la consola de ninguna página. Capturas en', OUT);
  } finally {
    await browser.close();
    await bowling.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('✘', err.message); process.exit(1); });
