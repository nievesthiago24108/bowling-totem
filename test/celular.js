/*
 * Prueba del control del celular con Playwright: un celular emulado (390x844, táctil) contra
 * el tótem abierto en otra página, con 1 jugador de prueba en el tótem.
 * Se une, empieza, apunta, desliza, manda una reacción, recarga la página a mitad de partida
 * (tiene que recuperar su lugar) y juega hasta los resultados.
 *
 *   npm run capturas:celu   → capturas en capturas/ (c* = celular, t* = tótem)
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright');
const { createBowlingServer, loadConfig } = require('../server.js');

const OUT = path.join(__dirname, '..', 'capturas');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('Tiempo agotado esperando: ' + what);
    await sleep(60);
  }
}

/** Medidas de la mini pista (las mismas cuentas que control.js) */
async function laneGeo(phone) {
  const b = await phone.locator('#lane').boundingBox();
  const laneW = Math.min(b.width * 0.62, b.height * 0.4);
  const ballR = laneW * 0.075;
  return { b, ballR, cx: b.x + b.width / 2, ballY: b.y + b.height - Math.max(70, ballR * 3), travel: laneW / 2 - ballR * 1.15 };
}

/** Desliza hacia arriba con una curva (curve < 0 = panza a la izquierda). onMiddle se llama a mitad del trazo */
async function swipe(phone, opts) {
  const g = await laneGeo(phone);
  const x0 = g.cx + (opts.fromX || 0), y0 = g.ballY;
  const len = g.b.height * (opts.len || 0.5);
  const steps = 16;
  await phone.mouse.move(x0, y0);
  await phone.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await phone.mouse.move(x0 + (opts.dx || 0) * f + (opts.curve || 0) * Math.sin(Math.PI * f), y0 - len * f);
    await sleep((opts.ms || 220) / steps);
    if (i === Math.round(steps * 0.7) && opts.onMiddle) await opts.onMiddle();
  }
  await phone.mouse.up();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // puntajes en una carpeta temporal: las pruebas no ensucian el ranking real (data/)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-capturas-'));
  const bowling = createBowlingServer(loadConfig(), { silent: true, dataDir });
  const port = await bowling.start(0);
  if (process.env.DEBUG) {
    bowling.io.on('connection', (s) => s.onAny((ev, d) => {
      if (typeof d !== 'function') console.log('  servidor ←', ev, JSON.stringify(d));
    }));
  }
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const errors = [];
  const watchConsole = (page, who) => {
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon/.test(m.location().url || '')) errors.push(who + ': ' + m.text());
    });
    page.on('pageerror', (e) => errors.push(who + ': ' + e.message));
  };
  try {
    const totem = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    watchConsole(totem, 'tótem');
    await totem.goto(`${base}/?prueba=1`);
    await waitFor(() => bowling.lobby.totem, 5000, 'tótem conectado');

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const phone = await ctx.newPage();
    watchConsole(phone, 'celu');
    await phone.goto(`${base}/j`);
    await phone.fill('#name', 'Lucía');
    await phone.screenshot({ path: path.join(OUT, 'c1-unirse.png') });

    // nombre inválido → mensaje de error
    await phone.fill('#name', 'L');
    await phone.click('#join');
    const err = await phone.textContent('#join-error');
    if (!/entre 2 y 14/.test(err)) throw new Error('No avisó del nombre inválido');
    await phone.fill('#name', 'Lucía');
    await phone.click('#join');
    await phone.waitForSelector('#s-lobby.on');
    await phone.waitForSelector('#start:not([disabled])');
    await sleep(300);
    await phone.screenshot({ path: path.join(OUT, 'c2-espera.png') });
    console.log('✔ se unió y es anfitrión');

    await phone.click('#start');
    await phone.waitForSelector('#s-watch.on');
    await phone.screenshot({ path: path.join(OUT, 'c3-cuenta.png') });
    await phone.waitForSelector('#s-play.on', { timeout: 8000 });
    await sleep(400);
    await phone.screenshot({ path: path.join(OUT, 'c4-turno.png') });
    console.log('✔ cuenta regresiva y "¡Tu turno!"');

    // arrastrar la bola a la derecha → el tótem la mueve
    const g = await laneGeo(phone);
    await phone.mouse.move(g.cx, g.ballY);
    await phone.mouse.down();
    for (let i = 1; i <= 10; i++) { await phone.mouse.move(g.cx + i * 5, g.ballY + 2); await sleep(30); }
    await phone.mouse.up();
    const aim = await waitFor(() => totem.evaluate(() => {
      const t = window.bowlingGame.state.turn;
      return t && t.aimTarget > 0.2 ? t.aimTarget : 0;
    }), 2000, 'que el tótem reciba la posición');
    console.log('✔ apuntado en vivo en el tótem: posición', aim.toFixed(2));

    // deslizar con curva → la bola sale en el tótem
    await swipe(phone, { curve: -35, dx: -10, ms: 200, fromX: 50, onMiddle: () => phone.screenshot({ path: path.join(OUT, 'c5-deslizando.png') }) });
    const params = await waitFor(() => totem.evaluate(() => {
      const t = window.bowlingGame.state.turn;
      return t && t.state === 'rolling' && t.params;
    }), 8000, 'que salga la bola en el tótem');
    console.log('✔ tiro desde el celu:', JSON.stringify(params));
    if (!(params.spin > 0)) throw new Error('La curva hacia la izquierda debería dar efecto positivo');
    await sleep(800);
    await totem.screenshot({ path: path.join(OUT, 't1-tiro-del-celu.png') });
    await phone.screenshot({ path: path.join(OUT, 'c6-lanzaste.png') });

    // jugar hasta que le toque al jugador de prueba; ahí reacción y recarga
    let reacted = false, reloaded = false, segundoTiro = false;
    const t0 = Date.now();
    while (bowling.lobby.phase !== 'results') {
      if (Date.now() - t0 > 240000) throw new Error('La partida no terminó en 4 minutos');
      const st = await totem.evaluate(() => {
        const g = window.bowlingGame;
        const p = g.currentPlayer();
        return { phase: g.state.phase, turn: g.state.turn && g.state.turn.state, who: p && p.id };
      });
      if (st.phase === 'playing' && st.turn === 'aiming') {
        if (st.who === 'prueba-1') {
          if (!reacted) {
            await phone.waitForSelector('#s-watch.on');
            await phone.click('button[data-emoji="🔥"]');
            await sleep(500);
            await totem.screenshot({ path: path.join(OUT, 't2-reaccion.png') });
            await phone.screenshot({ path: path.join(OUT, 'c7-mirando.png') });
            reacted = true;
            console.log('✔ reacción en el tótem');
          } else if (!reloaded) {
            // recarga a mitad de partida: tiene que volver solo con su nombre y su lugar
            await phone.reload();
            await phone.waitForSelector('#s-watch.on', { timeout: 5000 });
            const name = await phone.textContent('#s-watch [data-myname]');
            if (name !== 'Lucía') throw new Error('Al recargar no recuperó el nombre: ' + name);
            reloaded = true;
            console.log('✔ recargó la página y recuperó su lugar');
          }
          await totem.keyboard.press('Space');
        } else {
          await phone.waitForSelector('#s-play.on', { timeout: 5000 });
          const turno = await totem.evaluate(() => {
            const g = window.bowlingGame.state;
            return { tiro: g.turn.throwNo, enPie: g.lane.pins.length };
          });
          if (!segundoTiro && turno.tiro === 2 && turno.enPie < 10) {
            // la mini pista del celu tiene que mostrar solo los pinos que quedaron en el tótem
            await sleep(400);
            await phone.screenshot({ path: path.join(OUT, 'c4b-segundo-tiro.png') });
            await totem.screenshot({ path: path.join(OUT, 't3-segundo-tiro.png') });
            segundoTiro = true;
            console.log(`✔ segundo tiro: el celu muestra los ${turno.enPie} pinos en pie (capturas c4b y t3)`);
          }
          await swipe(phone, { curve: -25, ms: 220, fromX: 40 });
        }
        await waitFor(() => totem.evaluate(() => {
          const t = window.bowlingGame.state.turn;
          return !t || t.state !== 'aiming';
        }), 4000, 'que salga el tiro');
      }
      await sleep(100);
    }
    await phone.waitForSelector('#s-watch.on');
    await sleep(800);
    await phone.screenshot({ path: path.join(OUT, 'c8-resultados.png') });
    const summary = await phone.textContent('#watch-main .status');
    console.log('✔ resultados en el celu:', summary);

    if (errors.length) throw new Error('Errores en la consola:\n' + errors.join('\n'));
    console.log('✔ sin errores en la consola. Capturas en', OUT);
  } finally {
    await browser.close();
    await bowling.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('✘', err.message); process.exit(1); });
