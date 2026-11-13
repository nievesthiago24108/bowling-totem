/*
 * Prueba del leaderboard con Playwright: 3 partidas de prueba (los tiros salen con la tecla
 * Espacio del tótem) con jugadores reales conectados por socket y un celular emulado.
 * Revisa que se guarden los puntajes, que lleguen los puestos y saca capturas del lobby con
 * el ranking, de los resultados, de /ranking en tamaño celular y de /admin.
 *
 *   npm run capturas:ranking   → capturas en capturas/ (r* = ranking)
 *
 * Usa una carpeta de datos temporal, con algunos puntajes viejos para que Semana y Siempre
 * no queden iguales a Hoy. No toca data/.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright');
const { io } = require('socket.io-client');
const { createBowlingServer, loadConfig } = require('../server.js');
const { fechaLocal, nombreClave } = require('../leaderboard.js');

const OUT = path.join(__dirname, '..', 'capturas');
const DIA = 24 * 60 * 60 * 1000;
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

/** Puntajes viejos (hace 3 y 20 días) para que las tablas se diferencien */
function sembrar(dir, frames) {
  const viejos = [
    ['Valentina', 74, 2, 1, 3], ['Bruno', 61, 1, 2, 3], ['Martina', 55, 1, 1, 3],
    ['Joaquín', 88, 3, 0, 20], ['Camila', 69, 2, 0, 20], ['Lucía', 47, 0, 2, 20], ['Thiago', 39, 0, 1, 20],
  ];
  const lineas = viejos.map(([nombre, puntaje, plenos, semiplenos, dias], i) => JSON.stringify({
    id: 'viejo' + i, nombre, nombreClave: nombreClave(nombre), puntaje, frames, plenos, semiplenos,
    fecha: fechaLocal(Date.now() - dias * DIA - i * 3600000), partidaId: 'p-viejo' + i, jugadores: 2,
  }));
  fs.writeFileSync(path.join(dir, 'puntajes.jsonl'), lineas.join('\n') + '\n');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const config = loadConfig();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-ranking-'));
  sembrar(dataDir, config.frames);
  const bowling = createBowlingServer(config, { silent: true, dataDir });
  const port = await bowling.start(0);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const errors = [];
  const sockets = [];
  const watchConsole = (page, who) => {
    page.on('console', (m) => {
      if (m.type() !== 'error' || /favicon/.test(m.location().url || '')) return;
      if (who === 'admin' && /status of 401/.test(m.text())) return; // el PIN errado a propósito
      errors.push(who + ': ' + m.text());
    });
    page.on('pageerror', (e) => errors.push(who + ': ' + e.message));
  };

  /** Jugador conectado por socket que guarda lo que recibe */
  async function jugador(name) {
    const s = io(base, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.states = [];
    s.positions = [];
    s.on('game:state', (st) => s.states.push(st));
    s.on('leaderboard:position', (p) => s.positions.push(p));
    const r = await new Promise((res) => s.emit('player:join', { name }, res));
    if (!r.ok) throw new Error(`No se pudo unir ${name}: ${r.error}`);
    s.player = r;
    return s;
  }

  try {
    const totem = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    watchConsole(totem, 'tótem');
    await totem.goto(base + '/');
    await waitFor(() => bowling.lobby.totem, 5000, 'tótem conectado');

    // nombre prohibido rechazado
    const malo = io(base, { transports: ['websocket'], forceNew: true });
    sockets.push(malo);
    const rMalo = await new Promise((res) => malo.emit('player:join', { name: 'B0lud0' }, res));
    if (rMalo.ok) throw new Error('El filtro dejó pasar un nombre prohibido');
    malo.close();
    console.log('✔ nombre prohibido rechazado:', rMalo.error);

    const lucia = await jugador('Lucía');

    // celular emulado
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const phone = await ctx.newPage();
    watchConsole(phone, 'celu');
    await phone.goto(base + '/j');
    await phone.fill('#name', 'Mateo');
    await phone.tap('#join');
    await phone.waitForSelector('#s-lobby.on');
    let sofia = await jugador('Sofía');

    async function partida(n) {
      const before = lucia.states.length;
      const started = await new Promise((r) => lucia.emit('game:start', r));
      if (!started.ok) throw new Error('game:start rechazado: ' + started.error);
      let handled = before;
      const t0 = Date.now();
      while (bowling.lobby.phase !== 'results') {
        if (Date.now() - t0 > 240000) throw new Error('La partida no terminó en 4 minutos');
        if (lucia.states.length > handled) {
          const s = lucia.states[lucia.states.length - 1];
          handled = lucia.states.length;
          if (s.phase === 'playing' && s.turnState === 'aiming') {
            await sleep(200);
            await totem.keyboard.press('Space');
          }
        }
        await sleep(40);
      }
      const pos = await waitFor(() => lucia.positions[n - 1], 3000, 'leaderboard:position de Lucía');
      const final = lucia.states.filter((s) => s.phase === 'results').pop();
      console.log(`✔ partida ${n}:`, final.results.map((r) => `${r.name} ${r.score}`).join(', '),
        `· Lucía: puesto ${pos.puestoHoy} de hoy, ${pos.puestoSiempre} de siempre${pos.esRecordPersonal ? ', récord personal' : ''}`);
      return final;
    }

    async function volverAlLobby() {
      await totem.keyboard.press('r');
      await waitFor(() => bowling.lobby.phase === 'lobby', 3000, 'volver al lobby');
    }

    await partida(1);
    await sleep(1600);
    await totem.screenshot({ path: path.join(OUT, 'r1-resultados.png') });
    await phone.waitForSelector('.puesto', { timeout: 3000 });
    await phone.screenshot({ path: path.join(OUT, 'r2-celu-resultados.png') });
    await volverAlLobby();

    await partida(2);
    // Sofía se va durante los resultados y entra Tomás
    sofia.close();
    await volverAlLobby();
    await jugador('Tomás');
    await sleep(300);

    await partida(3);
    await volverAlLobby();

    // el archivo tiene 7 viejos + 3 + 3 + 3
    const lineas = fs.readFileSync(path.join(dataDir, 'puntajes.jsonl'), 'utf8').trim().split('\n');
    if (lineas.length !== 16) throw new Error(`Se esperaban 16 renglones en puntajes.jsonl y hay ${lineas.length}`);
    const nombres = new Set(lineas.map((l) => JSON.parse(l).nombre));
    for (const n of ['Lucía', 'Mateo', 'Sofía', 'Tomás']) if (!nombres.has(n)) throw new Error('Falta ' + n + ' en puntajes.jsonl');
    console.log('✔ 9 puntajes nuevos guardados en puntajes.jsonl');

    // lobby con el ranking: Hoy y después Siempre (rota cada segundosRotacionRanking)
    const period = config.segundosRotacionRanking * 1000;
    const shotAt = async (idx, file) => {
      await totem.evaluate(({ idx, period }) => new Promise((resolve) => {
        (function wait() {
          const now = performance.now();
          if (Math.floor(now / period) % 3 === idx && now % period > 900) resolve();
          else requestAnimationFrame(wait);
        })();
      }), { idx, period });
      await totem.screenshot({ path: path.join(OUT, file) });
    };
    await shotAt(0, 'r3-lobby-hoy.png');
    await shotAt(2, 'r4-lobby-siempre.png');
    console.log('✔ lobby con el ranking rotando');

    // /ranking en tamaño celular
    const rk = await ctx.newPage();
    watchConsole(rk, 'ranking');
    await rk.goto(base + '/ranking/');
    await rk.waitForSelector('#lista .row');
    await rk.screenshot({ path: path.join(OUT, 'r5-ranking-hoy.png') });
    await rk.tap('[data-tabla="jugadores"]');
    await rk.waitForFunction(() => document.querySelector('#head').textContent.includes('Prom'));
    await rk.waitForSelector('#lista .row');
    const filasJug = await rk.locator('#lista .row').count();
    await rk.screenshot({ path: path.join(OUT, 'r6-ranking-jugadores.png') });
    await rk.fill('#buscar', 'lucia');
    const filtradas = await rk.locator('#lista .row').count();
    if (filtradas !== 1) throw new Error('El buscador debería dejar solo a Lucía y dejó ' + filtradas);
    await rk.tap('#lista .row button.name');
    await rk.waitForSelector('#h-lista .game');
    const partidasLucia = await rk.locator('#h-lista .game').count();
    if (partidasLucia !== 4) throw new Error('Lucía debería tener 4 partidas y tiene ' + partidasLucia);
    await rk.screenshot({ path: path.join(OUT, 'r7-ranking-historial.png') });
    console.log(`✔ /ranking: ${filasJug} jugadores, buscador y historial (Lucía: ${partidasLucia} partidas)`);

    // /admin en compu
    const adm = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    watchConsole(adm, 'admin');
    await adm.goto(base + '/admin/');
    await adm.fill('#pin', 'mal');
    await adm.click('#login button');
    await adm.waitForFunction(() => document.querySelector('#login-msg').textContent.includes('PIN'));
    await adm.fill('#pin', String(config.pinAdmin));
    await adm.click('#login button');
    await adm.waitForSelector('#filas tr td.name');
    await adm.screenshot({ path: path.join(OUT, 'r8-admin.png') });
    // borrar uno con la confirmación
    const antes = await adm.locator('#filas tr').count();
    await adm.locator('#filas tr').first().locator('button').click();
    await adm.waitForSelector('#dlg-borrar[open]');
    await adm.click('#borrar-si');
    await adm.waitForFunction((n) => document.querySelectorAll('#filas tr').length === n - 1, antes);
    // exportar
    const [descarga] = await Promise.all([adm.waitForEvent('download'), adm.click('#exportar')]);
    const csvPath = path.join(dataDir, 'export.csv');
    await descarga.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath);
    if (csv.subarray(0, 3).toString('hex') !== 'efbbbf') throw new Error('El CSV no tiene BOM');
    if (!csv.toString().includes('Lucía')) throw new Error('El CSV no tiene las tildes bien');
    console.log(`✔ /admin: login, borrar (${antes} → ${antes - 1}) y CSV (${descarga.suggestedFilename()})`);
    // reiniciar con doble confirmación
    await adm.click('#reiniciar');
    await adm.waitForSelector('#dlg-reiniciar[open]');
    if (!(await adm.locator('#reiniciar-si').isDisabled())) throw new Error('Reiniciar debería pedir escribir REINICIAR');
    await adm.fill('#reiniciar-txt', 'REINICIAR');
    await adm.click('#reiniciar-si');
    await adm.waitForFunction(() => document.querySelector('#count').textContent.startsWith('0 de 0'));
    if (fs.existsSync(path.join(dataDir, 'puntajes.jsonl'))) throw new Error('Reiniciar no archivó el archivo');
    console.log('✔ /admin: reinicio archivado en', fs.readdirSync(path.join(dataDir, 'archivo')).join(', '));

    if (errors.length) throw new Error('Errores en la consola:\n' + errors.join('\n'));
    console.log('✔ sin errores en la consola. Capturas en', OUT);
  } finally {
    sockets.forEach((s) => s.close());
    await browser.close();
    await bowling.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('✘', err.message); process.exit(1); });
