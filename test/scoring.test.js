const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/shared/scoring.js');

function play(frames, rolls) {
  const card = S.createCard(frames);
  rolls.forEach((p) => S.addRoll(card, p));
  return card;
}

test('juego perfecto: 30 por frame', () => {
  const c3 = play(3, [10, 10, 10, 10, 10]);
  assert.ok(S.isComplete(c3));
  assert.deepEqual(S.frameScores(c3), [30, 60, 90]);
  assert.equal(S.total(c3), 90);
  const c10 = play(10, Array(12).fill(10));
  assert.equal(S.total(c10), 300);
  assert.ok(S.isComplete(c10));
});

test('todos 9-0', () => {
  const c = play(10, Array(10).fill([9, 0]).flat());
  assert.ok(S.isComplete(c));
  assert.equal(S.total(c), 90);
  assert.deepEqual(S.display(c)[0].marks, ['9', '-']);
});

test('todos semi-plenos 5/5 con bonus final', () => {
  const c = play(10, Array(21).fill(5));
  assert.ok(S.isComplete(c));
  assert.equal(S.total(c), 150);
  assert.deepEqual(S.display(c)[9].marks, ['5', '/', '5']);
});

test('todas canaletas', () => {
  const c = play(3, [0, 0, 0, 0, 0, 0]);
  assert.ok(S.isComplete(c));
  assert.equal(S.total(c), 0);
  assert.deepEqual(S.display(c).map((f) => f.marks), [['-', '-'], ['-', '-'], ['-', '-']]);
});

test('último frame: X X X, X 5 /, 7 / 4 y 6 2 sin tercer tiro', () => {
  const xxx = play(1, [10, 10, 10]);
  assert.equal(S.total(xxx), 30);
  assert.deepEqual(S.display(xxx)[0].marks, ['X', 'X', 'X']);

  const x5s = play(1, [10, 5, 5]);
  assert.equal(S.total(x5s), 20);
  assert.deepEqual(S.display(x5s)[0].marks, ['X', '5', '/']);

  const s4 = play(1, [7, 3, 4]);
  assert.equal(S.total(s4), 14);
  assert.deepEqual(S.display(s4)[0].marks, ['7', '/', '4']);

  const open = play(1, [6, 2]);
  assert.ok(S.isComplete(open));
  assert.equal(S.total(open), 8);
  assert.throws(() => S.addRoll(open, 1), /completa/);
});

test('bonus pendiente: el acumulado queda en null hasta tener los tiros', () => {
  const c = play(3, [10, 7]);
  assert.deepEqual(S.frameScores(c), [null, null, null]);
  assert.equal(S.total(c), 24); // 10 + 7 (bonus parcial) + 7
  S.addRoll(c, 2);
  assert.deepEqual(S.frameScores(c), [19, 28, null]);
  const spare = play(3, [4, 6, 0, 10]);
  assert.deepEqual(S.display(spare).slice(0, 2).map((f) => f.marks), [['4', '/'], ['-', '/']]);
});

test('pinsLeft, currentFrame y throwInFrame', () => {
  const c = S.createCard(3);
  assert.equal(S.pinsLeft(c), 10);
  assert.equal(S.currentFrame(c), 0);
  assert.equal(S.throwInFrame(c), 1);
  S.addRoll(c, 7);
  assert.equal(S.pinsLeft(c), 3);
  assert.equal(S.throwInFrame(c), 2);
  assert.equal(S.frameDone(c, 0), false);
  S.addRoll(c, 2);
  assert.ok(S.frameDone(c, 0));
  assert.equal(S.currentFrame(c), 1);
  S.addRoll(c, 10);
  assert.equal(S.currentFrame(c), 2);
  // último frame: después del pleno vuelven a ser 10, después de 10+4 quedan 6
  S.addRoll(c, 10);
  assert.equal(S.pinsLeft(c), 10);
  S.addRoll(c, 4);
  assert.equal(S.pinsLeft(c), 6);
  assert.equal(S.throwInFrame(c), 3);
  S.addRoll(c, 6);
  assert.ok(S.isComplete(c));
  assert.equal(S.pinsLeft(c), 0);
  assert.equal(S.currentFrame(c), -1);
  assert.equal(S.throwInFrame(c), 0);
  // 7+2 = 9 · pleno 10+10+4 = 24 → 33 · último 10+4+6 = 20 → 53
  assert.deepEqual(S.frameScores(c), [9, 33, 53]);
});

test('después de un semi-pleno en el último frame vuelven a ser 10', () => {
  const c = play(1, [3, 7]);
  assert.equal(S.pinsLeft(c), 10);
});

test('tiros inválidos', () => {
  const c = S.createCard(3);
  assert.throws(() => S.addRoll(c, 11), /inválido/);
  assert.throws(() => S.addRoll(c, -1), /inválido/);
  assert.throws(() => S.addRoll(c, 2.5), /inválido/);
  assert.throws(() => S.addRoll(c, '5'), /inválido/);
  S.addRoll(c, 8);
  assert.throws(() => S.addRoll(c, 3), /quedan 2/);
  assert.throws(() => S.createCard(0), /frames/);
});

test('la tarjeta sobrevive a JSON (se manda por Socket.io)', () => {
  const c = JSON.parse(JSON.stringify(play(3, [10, 5])));
  S.addRoll(c, 5);
  assert.deepEqual(S.frameScores(c), [20, null, null]); // el semi-pleno espera su bonus
  S.addRoll(c, 3);
  assert.deepEqual(S.frameScores(c), [20, 33, null]);
});
