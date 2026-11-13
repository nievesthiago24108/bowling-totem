/*
 * Prueba de rendimiento del tótem con Playwright: simula una compu modesta (CPU 3 veces más
 * lenta) sin placa de video, juega tiros fijos al bolsillo (choques, plenos, sacudida) y mide
 * la duración de cada cuadro en el lobby y jugando.
 *
 *   npm run prueba:rendimiento            → falla si baja de 55 FPS o hay muchos cuadros largos
 *   LENTITUD=1 npm run prueba:rendimiento → sin simular una compu lenta
 *
 * Usa una carpeta de datos temporal. Los números dependen de la compu donde se corre.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright');
const { createBowlingServer, loadConfig } = require('../server.js');

const LENTITUD = Number(process.env.LENTITUD) || 3;
const MIN_FPS = 55;
const MAX_LARGOS = 0.05; // como mucho 5 % de cuadros de más de 25 ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resumen(d) {
  const s = d.slice().sort((a, b) => a - b), n = d.length || 1;
  const avg = d.reduce((a, b) => a + b, 0) / n;
  return { cuadros: d.length, fps: +(1000 / avg).toFixed(1), p95: +(s[Math.floor(n * 0.95)] || 0).toFixed(1), largos: d.filter((x) => x > 25).length };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-rendimiento-'));
  const bowling = createBowlingServer(loadConfig(), { silent: true, dataDir });
  const port = await bowling.start(0);
  const browser = await chromium.launch();
  const fallas = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await page.context().newCDPSession(page);
    if (LENTITUD > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: LENTITUD });
    await page.goto(`http://127.0.0.1:${port}/`);
    while (!bowling.lobby.totem) await sleep(50);
    await sleep(800);

    // registra cada cuadro: [duración, escena]
    await page.evaluate(() => {
      window.__cuadros = [];
      let last = performance.now();
      (function f(t) {
        const g = window.bowlingGame.state;
        const escena = g.phase === 'lobby' ? 'lobby' : g.phase === 'playing' ? 'jugando' : 'otro';
        window.__cuadros.push([t - last, escena]);
        last = t;
        requestAnimationFrame(f);
      })(last);
    });
    await sleep(4000); // lobby con la demo de fondo

    await page.keyboard.press('p');
    await page.keyboard.press('Enter');
    for (let k = 0; k < 5; k++) {
      await page.waitForFunction(() => {
        const g = window.bowlingGame.state;
        return g.phase !== 'playing' && g.phase !== 'countdown' ? true : g.turn && g.turn.state === 'aiming';
      }, null, { timeout: 60000 });
      if (await page.evaluate(() => window.bowlingGame.state.phase !== 'playing')) break;
      await page.evaluate(() => {
        const G = window.bowlingGame;
        const t = { power: 0.82, position: 0.42, spin: -0.55, target: 'pocket', jitter: 0 };
        G.throw(G.currentPlayer().id, window.BowlingGame.aimTowards(window.Matter, window.BowlingPhysics, t));
      });
      await sleep(300);
    }
    await sleep(2000);
    const cuadros = (await page.evaluate(() => window.__cuadros)).slice(1);

    console.log(`CPU ${LENTITUD}x más lenta, sin placa de video:`);
    for (const escena of ['lobby', 'jugando']) {
      const r = resumen(cuadros.filter((c) => c[1] === escena).map((c) => c[0]));
      const ok = r.fps >= MIN_FPS && r.largos <= r.cuadros * MAX_LARGOS;
      console.log(`${ok ? '✔' : '✘'} ${escena.padEnd(8)} ${r.fps} FPS · p95 ${r.p95} ms · ${r.largos} de ${r.cuadros} cuadros de más de 25 ms`);
      if (!ok) fallas.push(escena);
    }
    if (errors.length) fallas.push('errores: ' + errors.join('; '));
  } finally {
    await browser.close();
    await bowling.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (fallas.length) {
    console.error(`✘ rendimiento insuficiente en: ${fallas.join(', ')} (mínimo ${MIN_FPS} FPS)`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('✘', err.message); process.exit(1); });
