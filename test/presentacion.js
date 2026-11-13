/*
 * Capturas de la presentación del tótem (etapa 7): demo del lobby, choque con chispas,
 * cartel de PLENO, podio de resultados y medición de cuadros por segundo.
 *
 *   npm run capturas:presentacion   → capturas en capturas/ (p* = presentación)
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
    await sleep(30);
  }
}

/** Promedio de cuadros por segundo durante `ms` medido con requestAnimationFrame */
const medirFps = (page, ms) => page.evaluate((ms) => new Promise((resolve) => {
  let n = 0;
  const t0 = performance.now();
  (function f(t) {
    n++;
    if (t - t0 < ms) requestAnimationFrame(f);
    else resolve(n / ((t - t0) / 1000));
  })(t0);
}), ms);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-presentacion-'));
  const bowling = createBowlingServer(loadConfig(), { silent: true, dataDir });
  const port = await bowling.start(0);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon/.test(m.location().url || '')) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/');
    await waitFor(() => bowling.lobby.totem, 5000, 'tótem conectado');

    // demo de fondo: esperar a que la bola de la demo esté rodando
    await page.waitForFunction(() => true);
    await sleep(1200);
    const fpsLobby = await medirFps(page, 3000);
    await page.screenshot({ path: path.join(OUT, 'p1-lobby-demo.png') });
    console.log(`✔ lobby con demo de fondo · ${fpsLobby.toFixed(1)} FPS`);

    // partida con 2 jugadores de prueba
    await page.keyboard.press('p');
    await page.keyboard.press('p');
    await page.keyboard.press('Enter');
    const state = () => page.evaluate(() => {
      const g = window.bowlingGame.state;
      return {
        phase: g.phase, turn: g.turn && g.turn.state, kind: g.turn && g.turn.kind, throwNo: g.turn && g.turn.throwNo,
        hit: !!g.lane.hitPin, scale: g.timeScale,
      };
    });
    await waitFor(async () => (await state()).turn === 'aiming', 8000, 'primer turno');

    let crashShot = false, strikeShot = false, minScale = 1, fpsPlay = null, tiros = 0;
    while ((await state()).phase === 'playing') {
      const s = await state();
      if (s.turn !== 'aiming') { await sleep(40); continue; }
      tiros++;
      if (s.throwNo === 1 && !strikeShot) {
        // tiro al bolsillo, con un poco de variación, para buscar un pleno
        await page.evaluate((j) => {
          const G = window.bowlingGame, M = window.Matter, P = window.BowlingPhysics;
          const t = { power: 0.82, position: 0.42, spin: -0.55, target: 'pocket', jitter: j };
          G.throw(G.currentPlayer().id, window.BowlingGame.aimTowards(M, P, t));
        }, (tiros % 5) * 4 - 8);
      } else {
        await page.keyboard.press('Space');
      }
      if (fpsPlay == null) fpsPlay = medirFps(page, 2500);
      // choque: apenas la bola toca los pinos (en cámara lenta)
      const hit = await waitFor(async () => { const x = await state(); return x.hit || x.turn !== 'rolling' ? x : null; }, 15000, 'choque');
      if (hit.hit && hit.turn === 'rolling') {
        await sleep(120);
        const x = await state();
        minScale = Math.min(minScale, x.scale);
        if (!crashShot) { await page.screenshot({ path: path.join(OUT, 'p2-choque.png') }); crashShot = true; console.log('✔ choque con chispas y cámara lenta (escala ' + x.scale.toFixed(2) + ')'); }
      }
      const r = await waitFor(async () => { const x = await state(); return x.turn === 'result' || x.phase !== 'playing' ? x : null; }, 20000, 'resultado');
      if (r.kind === 'pleno' && !strikeShot) {
        await sleep(330);
        await page.screenshot({ path: path.join(OUT, 'p3-pleno.png') });
        strikeShot = true;
        console.log('✔ cartel de PLENO con anillo, confeti y sacudida');
      }
      await waitFor(async () => { const x = await state(); return x.turn === 'aiming' || x.phase !== 'playing' ? x : null; }, 10000, 'siguiente tiro');
    }
    console.log(`✔ partida de ${tiros} tiros · ${(await fpsPlay).toFixed(1)} FPS jugando · cámara lenta mínima ${minScale.toFixed(2)}`);
    if (!strikeShot) console.log('  (no salió ningún pleno en esta partida: no hay captura p3)');

    await waitFor(async () => (await state()).phase === 'results', 5000, 'resultados');
    await sleep(450);
    await page.screenshot({ path: path.join(OUT, 'p4-podio-entrando.png') });
    await sleep(1600);
    await page.screenshot({ path: path.join(OUT, 'p5-podio.png') });
    console.log('✔ podio animado');

    if (errors.length) throw new Error('Errores en la consola del tótem:\n' + errors.join('\n'));
    console.log('✔ sin errores en la consola. Capturas en', OUT);
  } finally {
    await browser.close();
    await bowling.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('✘', err.message); process.exit(1); });
