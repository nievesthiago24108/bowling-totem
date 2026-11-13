/*
 * Simulación de tiros en Node para ajustar la física.
 *   node test/sim.js [--n 500] [--seed 1]
 * Muestra, por grupo de tiros: % de plenos, promedio de pinos, % de canaletas y duración.
 */
'use strict';
const Matter = require('matter-js');
const P = require('../public/shared/physics.js');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? Number(args[i + 1]) : def;
}
const N = arg('n', 500);
const SEED = arg('seed', 1);

// PRNG con semilla (mulberry32) para que los resultados se puedan repetir
let s = SEED >>> 0;
function rand() {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const uni = (a, b) => a + (b - a) * rand();
function gauss(sd) {
  const u = 1 - rand(), v = rand();
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const LIMIT = 60 * 9;

function playThrow(params) {
  const st = P.createLane(Matter);
  P.throwBall(st, params);
  while (!P.isSettled(st)) P.step(st);
  return {
    pins: P.knockedPins(st).length,
    gutter: st.inGutter,
    seconds: st.stepsSinceRelease / 60,
    timeout: st.stepsSinceRelease > LIMIT,
  };
}

/** x donde la bola cruza la altura del pino 1, en una pista sin pinos */
function arrivalX(params) {
  const st = P.createLane(Matter, { standing: [] });
  const ball = P.throwBall(st, params);
  let n = 0;
  while (ball.position.y > P.LANE.headPinY && n++ < LIMIT) P.step(st);
  return ball.position.x;
}

/** aim necesario para llegar a targetX (búsqueda binaria; arrivalX crece con aim) */
function aimFor(targetX, position, spin, power) {
  let lo = -1, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (arrivalX({ power, aim: mid, spin, position }) < targetX) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const cx = P.LANE.centerX;
const POCKET = cx + P.LANE.pinSpacing / 4; // entre el pino 1 y el 3

const groups = {
  'Al azar': () => ({ power: rand(), aim: uni(-1, 1), spin: uni(-1, 1), position: uni(-1, 1) }),
  'Bolsillo': () => {
    const position = uni(0.2, 0.6), spin = uni(-0.8, -0.3), power = uni(0.6, 0.95);
    return { power, position, spin, aim: aimFor(POCKET + gauss(12), position, spin, power) };
  },
  'Al medio': () => {
    const position = uni(-0.15, 0.15), spin = gauss(0.05), power = uni(0.6, 0.95);
    return { power, position, spin, aim: aimFor(cx + gauss(12), position, spin, power) };
  },
  'Torcidos': () => {
    const side = rand() < 0.5 ? -1 : 1;
    return { power: rand(), position: side * uni(0.6, 1), aim: side * uni(0.6, 1), spin: side * uni(0, 1) };
  },
};

/** Corre N tiros por grupo y devuelve las estadísticas */
function simulate(n, seed) {
  s = seed >>> 0;
  const out = {};
  for (const [name, gen] of Object.entries(groups)) {
    const g = { strikes: 0, pins: 0, gutters: 0, secs: 0, min: Infinity, max: 0, timeouts: 0, long: 0 };
    for (let i = 0; i < n; i++) {
      const r = playThrow(gen());
      if (r.pins === 10) g.strikes++;
      g.pins += r.pins;
      if (r.gutter) g.gutters++;
      if (r.timeout) g.timeouts++;
      if (r.seconds > 5) g.long++;
      g.secs += r.seconds;
      g.min = Math.min(g.min, r.seconds);
      g.max = Math.max(g.max, r.seconds);
    }
    out[name] = {
      strikes: g.strikes / n, pins: g.pins / n, gutters: g.gutters / n,
      secs: g.secs / n, min: g.min, max: g.max, timeouts: g.timeouts / n, long: g.long / n,
    };
  }
  return out;
}

function printTable(stats) {
  const pct = (x) => (100 * x).toFixed(1).padStart(5) + ' %';
  console.log('Grupo      | Plenos  | Pinos prom. | Canaletas | Duración prom. (mín–máx) | Más de 5 s | Cortes 9 s');
  console.log('-----------|---------|-------------|-----------|--------------------------|------------|-----------');
  for (const [name, g] of Object.entries(stats)) {
    console.log(
      `${name.padEnd(10)} | ${pct(g.strikes)} | ${g.pins.toFixed(2).padStart(11)} | ${pct(g.gutters).padStart(9)} | ` +
      `${g.secs.toFixed(2)} s (${g.min.toFixed(1)}–${g.max.toFixed(1)})`.padEnd(24) + ' | ' + pct(g.long).padStart(10) + ' | ' + pct(g.timeouts)
    );
  }
}

if (require.main === module) {
  console.log(`Simulación: ${N} tiros por grupo, semilla ${SEED}\n`);
  printTable(simulate(N, SEED));
}

module.exports = { simulate, printTable, playThrow, aimFor };
