/*
 * Prueba de punta a punta con Playwright: levanta el servidor, abre el tótem a 1080x1920 con
 * 2 jugadores de prueba, conecta un "celular" real con socket.io-client y juega una partida
 * entera (el celu tira por socket, los de prueba con la tecla Espacio).
 *
 *   npm run capturas      → guarda las capturas en capturas/
 *
 * Falla si hay errores en la consola del navegador o si la partida no termina.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright');
const { io } = require('socket.io-client');
const { createBowlingServer, loadConfig } = require('../server.js');

const OUT = path.join(__dirname, '..', 'capturas');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(cond, ms, what) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const v = cond();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('Tiempo agotado esperando: ' + what));
      setTimeout(poll, 50);
    })();
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // puntajes en una carpeta temporal: las pruebas no ensucian el ranking real (data/)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-capturas-'));
  const bowling = createBowlingServer(loadConfig(), { silent: true, dataDir });
  const port = await bowling.start(0);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const errors = [];
  let phone;
  try {
    // "celular" real
    phone = io(base, { transports: ['websocket'] });
    const states = [];
    let lastLobby = null;
    phone.on('game:state', (s) => states.push(s));
    phone.on('lobby:update', (l) => { lastLobby = l; });
    const joined = await new Promise((r) => phone.emit('player:join', { name: 'Celu Real' }, r));
    if (!joined.ok) throw new Error('No se pudo unir el celu: ' + joined.error);

    // tótem
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon/.test(m.location().url || '')) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/?prueba=2`);
    await waitFor(() => lastLobby && lastLobby.totemConnected, 5000, 'que se conecte el tótem');
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, '1-lobby.png') });
    console.log('✔ lobby');

    // el anfitrión (el celu) empieza
    const started = await new Promise((r) => phone.emit('game:start', r));
    if (!started.ok) throw new Error('game:start rechazado: ' + started.error);
    await waitFor(() => states.some((s) => s.phase === 'countdown'), 3000, 'cuenta regresiva');
    const first = await waitFor(() => states.find((s) => s.phase === 'playing' && s.turnState === 'aiming'), 6000, 'primer turno');
    if (first.currentPlayerId !== joined.id) throw new Error('El primer turno debería ser del celu');
    if (first.scores.length !== 3) throw new Error('La tabla debería tener 3 jugadores');

    // el celu apunta y tira
    phone.emit('player:aim', { position: 0.4 });
    await sleep(300);
    phone.emit('player:throw', { power: 0.85, aim: -0.05, spin: -0.5, position: 0.4 });
    await waitFor(() => states.some((s) => s.turnState === 'rolling' && s.currentPlayerId === joined.id), 3000, 'que salga la bola del celu');
    await sleep(700);
    await page.screenshot({ path: path.join(OUT, '2-tiro-en-curso.png') });
    console.log('✔ tiro en curso (tirado desde el celu)');

    // resto de la partida
    let handled = states.length;
    let tableShot = false;
    const t0 = Date.now();
    while (bowling.lobby.phase !== 'results') {
      if (Date.now() - t0 > 240000) throw new Error('La partida no terminó en 4 minutos');
      if (states.length > handled) {
        const s = states[states.length - 1];
        handled = states.length;
        if (s.phase === 'playing' && s.turnState === 'aiming') {
          if (!tableShot && s.frame === 2) {
            await sleep(400);
            await page.screenshot({ path: path.join(OUT, '3-tabla.png') });
            tableShot = true;
            console.log('✔ tabla a mitad de partida');
          }
          await sleep(250);
          if (s.currentPlayerId === joined.id) {
            phone.emit('player:throw', { power: 0.8, aim: 0, spin: -0.4, position: 0.3 });
          } else {
            await page.keyboard.press('Space');
          }
        }
      }
      await sleep(50);
    }
    await sleep(1500);
    await page.screenshot({ path: path.join(OUT, '4-resultados.png') });
    const final = states.filter((s) => s.phase === 'results').pop();
    console.log('✔ resultados:', final.results.map((r) => `${r.name} ${r.score}`).join(', '));
    if (final.results.length !== 3) throw new Error('Faltan jugadores en los resultados');

    if (errors.length) throw new Error('Errores en la consola del tótem:\n' + errors.join('\n'));
    console.log('✔ sin errores en la consola. Capturas en', OUT);
  } finally {
    if (phone) phone.close();
    await browser.close();
    await bowling.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('✘', err.message); process.exit(1); });
