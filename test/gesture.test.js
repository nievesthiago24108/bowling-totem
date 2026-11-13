'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../public/control/gesture.js');

const H = 800;

/** Trazo de (x0,y0) a (x1,y1) en `ms`, con una panza lateral `bulge` px en el medio */
function stroke(x0, y0, x1, y1, ms, bulge, n) {
  n = n || 20;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push({ x: x0 + (x1 - x0) * f + (bulge || 0) * Math.sin(Math.PI * f), y: y0 + (y1 - y0) * f, t: ms * f });
  }
  return pts;
}

test('trazo recto hacia arriba: sin dirección ni efecto', () => {
  const r = analyze(stroke(200, 700, 200, 300, 200), H);
  assert.equal(r.aim, 0);
  assert.equal(r.spin, 0);
  assert.ok(r.power > 0.5);
});

test('más rápido = más fuerza', () => {
  const slow = analyze(stroke(200, 700, 200, 300, 900), H);
  const fast = analyze(stroke(200, 700, 200, 300, 150), H);
  assert.ok(fast.power > slow.power);
  assert.ok(slow.power < 0.3);
  assert.equal(fast.power, 1);
});

test('la dirección sigue el ángulo del trazo', () => {
  const right = analyze(stroke(200, 700, 300, 300, 250), H);
  const left = analyze(stroke(200, 700, 100, 300, 250), H);
  assert.ok(right.aim > 0.5);
  assert.ok(left.aim < -0.5);
  assert.ok(Math.abs(right.aim + left.aim) < 0.01);
});

test('panza a la izquierda engancha a la derecha (efecto +) y viceversa', () => {
  const hookRight = analyze(stroke(200, 700, 200, 300, 250, -40), H);
  const hookLeft = analyze(stroke(200, 700, 200, 300, 250, 40), H);
  assert.ok(hookRight.spin > 0.5, 'spin ' + hookRight.spin);
  assert.ok(hookLeft.spin < -0.5, 'spin ' + hookLeft.spin);
  // una curva chiquita da poco efecto
  const small = analyze(stroke(200, 700, 200, 300, 250, -8), H);
  assert.ok(small.spin > 0 && small.spin < 0.3);
});

test('trazos que no son tiros: muy cortos, hacia abajo o de costado', () => {
  assert.equal(analyze(stroke(200, 700, 200, 680, 100), H), null);
  assert.equal(analyze(stroke(200, 300, 200, 700, 200), H), null);
  assert.equal(analyze(stroke(100, 700, 400, 620, 200), H), null);
  assert.equal(analyze([{ x: 0, y: 0, t: 0 }], H), null);
});

test('los valores quedan dentro de los rangos del servidor', () => {
  const r = analyze(stroke(200, 790, 390, 10, 30, -300), H);
  assert.ok(r.power >= 0 && r.power <= 1);
  assert.ok(r.aim >= -1 && r.aim <= 1);
  assert.ok(r.spin >= -1 && r.spin <= 1);
});
